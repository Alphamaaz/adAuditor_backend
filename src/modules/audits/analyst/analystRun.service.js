/**
 * AI Analyst — model run. (spec: docs/AI_ANALYST_SPEC.md §3.3)
 *
 * Serializes the full dataset, sends it to Claude with a structured-output
 * schema, and returns the parsed report + usage. Throws on failure — the
 * caller (pipeline) catches and continues with the deterministic report, so
 * the analyst can only ever ADD quality, never block an audit.
 *
 * The Anthropic SDK is imported lazily (same pattern as agent/llmClient.js) so
 * the module loads in environments without the SDK installed.
 */

import { detectConversionAnomalies } from "../../../lib/findings/conversionAnomaly.js";
import { serializeDatasetForAnalyst, serializeSlice } from "./datasetSerializer.js";
import { ANALYST_SYSTEM_PROMPT, buildAnalystUserPrompt } from "./analystPrompt.js";
import {
  analystProviderJsonSchema,
  analystFactsPatchJsonSchema,
  countOptionalProperties,
  countUnionTypes,
  expandAnalystProviderReport,
  expandProviderFact,
  validateAnalystReport,
  ANALYST_SCHEMA_VERSION,
} from "./analystReport.schema.js";
import {
  collectAnalystEntityLabels,
  collectDatasetNumericPool,
  findUnsupportedProse,
} from "./analystProseVerification.js";
import {
  ANALYST_MODEL,
  ANALYST_EFFORT,
  ANALYST_MAX_DATASET_TOKENS,
  ANALYST_MAX_OUTPUT_TOKENS,
  isAnalystProseRepairEnabled,
} from "./analystConfig.js";

let _client = null;
const getClient = async () => {
  if (_client) return _client;
  const mod = await import("@anthropic-ai/sdk");
  const Anthropic = mod.default;
  _client = new Anthropic(); // ANTHROPIC_API_KEY from env
  return _client;
};

/** Same quarantine derivation the report itself uses (reportDocument.accountBaseline). */
export const quarantinedCampaignNames = (audit) => {
  const platforms = audit?.normalizedDataset?.data?.platforms || {};
  const campaigns = [];
  for (const platform of Object.values(platforms)) {
    for (const c of platform?.byLevel?.campaign || []) {
      if (Number(c?.spend) > 0) {
        campaigns.push({
          name: c.name,
          spend: Number(c.spend),
          conversions: Number(c.results ?? c.conversions) || 0,
        });
      }
    }
  }
  const result = detectConversionAnomalies(campaigns);
  if (!result) return [];
  return result.anomalies.map((a) => a.name || a.normName).filter(Boolean);
};

const firstTextBlock = (content = []) => {
  for (const block of content) {
    if (block?.type === "text" && block.text) return block.text;
  }
  return null;
};

/**
 * Phase B drill-down: when the serializer had to truncate tables, the model
 * may fetch the omitted rows on demand instead of analyzing blind. Offered
 * ONLY when truncations occurred — an untruncated prompt already contains
 * everything, and an idle tool invites pointless calls.
 */
const GET_SLICE_TOOL = {
  name: "get_slice",
  strict: true,
  description:
    "Fetch full rows from a dataset table that the main prompt truncated (see the '(…truncated)' notes in table headers). Returns the table slice in the same pipe-separated format. Use sparingly — only for rows you actually need for a finding.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["table"],
    properties: {
      table: { type: "string", description: "Table key exactly as in the section headers, e.g. 'keyword', 'ad', 'byDay'." },
      platform: { type: "string", enum: ["GOOGLE", "META", "TIKTOK"] },
      match: { type: "string", description: "Optional case-insensitive substring filter on row names." },
      limit: { type: "integer", description: "Max rows (default 150, cap 300)." },
    },
  },
};

const MAX_SLICE_CALLS = 4;
const MAX_TURNS = 8;
const PROVIDER_OPTIONAL_PROPERTY_LIMIT = 24;
const PROVIDER_UNION_TYPE_LIMIT = 16;

/**
 * Run the analyst for one audit bundle.
 *
 * @param {object} args
 * @param {object} args.audit    audit with normalizedDataset, ruleFindings,
 *                               intakeResponses, businessProfileSnapshot, selectedPlatforms
 * @param {string} [args.model]  model override (per-plan gating — see analystConfig)
 * @param {object} [deps]        injectable for tests: { createMessage }
 * @returns {Promise<{report, usage, model, schemaVersion, serialization, quarantinedCampaigns}>}
 */
export const runAnalyst = async (
  {
    audit,
    model,
    effort = ANALYST_EFFORT,
    maxOutputTokens = ANALYST_MAX_OUTPUT_TOKENS,
    captureTrace = false,
  },
  deps = {}
) => {
  const analystModel = model || ANALYST_MODEL;
  if (!audit?.normalizedDataset?.data) {
    throw new Error("analyst: audit has no normalized dataset");
  }

  const quarantined = quarantinedCampaignNames(audit);
  const serialization = serializeDatasetForAnalyst(audit, {
    maxTokens: ANALYST_MAX_DATASET_TOKENS,
    quarantinedCampaigns: quarantined,
  });

  const userPrompt = buildAnalystUserPrompt({
    audit,
    datasetText: serialization.text,
    currency: serialization.currency,
  });

  // Drill-down tool only when the prompt is missing rows (Phase B).
  const offerSliceTool = serialization.truncations.length > 0;
  const optionalPropertyCount =
    countOptionalProperties(analystProviderJsonSchema) +
    (offerSliceTool ? countOptionalProperties(GET_SLICE_TOOL.input_schema) : 0);
  if (optionalPropertyCount > PROVIDER_OPTIONAL_PROPERTY_LIMIT) {
    throw new Error(
      `analyst: provider schema has ${optionalPropertyCount} optional properties ` +
        `(limit ${PROVIDER_OPTIONAL_PROPERTY_LIMIT})`
    );
  }
  const unionTypeCount =
    countUnionTypes(analystProviderJsonSchema) +
    (offerSliceTool ? countUnionTypes(GET_SLICE_TOOL.input_schema) : 0);
  if (unionTypeCount > PROVIDER_UNION_TYPE_LIMIT) {
    throw new Error(
      `analyst: provider schema has ${unionTypeCount} union-typed properties ` +
        `(limit ${PROVIDER_UNION_TYPE_LIMIT})`
    );
  }

  const baseRequest = {
    model: analystModel,
    max_tokens: maxOutputTokens,
    thinking: { type: "adaptive" },
    output_config: {
      effort,
      format: { type: "json_schema", schema: analystProviderJsonSchema },
    },
    system: [
      {
        type: "text",
        text: ANALYST_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    ...(offerSliceTool ? { tools: [GET_SLICE_TOOL] } : {}),
  };

  const createMessage =
    deps.createMessage ||
    (async (request) => {
      const client = await getClient();
      // Streaming: the input is large and the output ceiling is high — a
      // non-streaming request would trip the SDK's timeout guard.
      const stream = client.messages.stream(request);
      return stream.finalMessage();
    });

  // Cache the big dataset prompt so drill-down turns re-read it at ~0.1×
  // instead of re-paying the full input price per turn.
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: userPrompt, cache_control: { type: "ephemeral" } },
      ],
    },
  ];
  const trace = captureTrace
    ? {
        system: baseRequest.system,
        initialUserMessage: structuredClone(messages[0]),
        turns: [],
      }
    : null;

  const usageTotals = { inputTokens: 0, outputTokens: 0 };
  const addUsage = (usage = {}) => {
    usageTotals.inputTokens +=
      (Number(usage.input_tokens) || 0) +
      (Number(usage.cache_creation_input_tokens) || 0) +
      (Number(usage.cache_read_input_tokens) || 0);
    usageTotals.outputTokens += Number(usage.output_tokens) || 0;
  };

  let message = null;
  let sliceCalls = 0;
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    message = await createMessage({ ...baseRequest, messages });
    addUsage(message.usage);

    const traceTurn = trace
      ? {
          turn: turn + 1,
          response: structuredClone(message.content || []),
          stopReason: message.stop_reason || null,
          usage: structuredClone(message.usage || {}),
          toolResults: [],
        }
      : null;
    if (traceTurn) trace.turns.push(traceTurn);

    if (message.stop_reason !== "tool_use") break;

    // Resolve every requested slice deterministically from the dataset.
    const toolUses = (message.content || []).filter((b) => b?.type === "tool_use");
    if (toolUses.length === 0) break;
    messages.push({ role: "assistant", content: message.content });
    messages.push({
      role: "user",
      content: toolUses.map((tu) => {
        sliceCalls += 1;
        const out =
          sliceCalls > MAX_SLICE_CALLS
            ? { text: "Slice budget exhausted — produce the final report from what you already have." }
            : serializeSlice(audit, tu.input || {});
        return { type: "tool_result", tool_use_id: tu.id, content: out.text };
      }),
    });
    if (traceTurn) {
      traceTurn.toolResults = structuredClone(messages.at(-1).content);
    }
  }

  if (!message) throw new Error("analyst: no model response");
  const responseError = (messageText) => {
    const error = new Error(messageText);
    error.usage = structuredClone(usageTotals);
    error.trace = trace ? structuredClone(trace) : null;
    error.stopReason = message?.stop_reason || null;
    error.partialResponse = structuredClone(message?.content || []);
    return error;
  };
  if (message.stop_reason === "refusal") {
    throw responseError("analyst: model refused the request");
  }
  if (message.stop_reason === "max_tokens") {
    throw responseError("analyst: output truncated at max_tokens");
  }
  if (message.stop_reason === "tool_use") {
    throw responseError("analyst: model never concluded (tool loop exhausted)");
  }

  const text = firstTextBlock(message.content);
  if (!text) throw new Error("analyst: no text block in response");

  let providerReport;
  try {
    providerReport = JSON.parse(text);
  } catch (err) {
    throw new Error(`analyst: response is not valid JSON (${err.message})`);
  }

  let report;
  try {
    report = expandAnalystProviderReport(providerReport);
  } catch (err) {
    throw new Error(`analyst: fact reference validation failed (${err.message})`);
  }

  const validation = validateAnalystReport(report);
  if (!validation.valid) {
    throw new Error(`analyst: schema validation failed — ${validation.errors.join("; ")}`);
  }

  // ── Prose repair turn ───────────────────────────────────────────────────
  // Verification deletes any strict-prose sentence whose numbers no fact or
  // dataset value supports. Deleting a TRUE sentence the model simply failed
  // to cite mutilates the report, so before verification we give the model
  // ONE cheap chance to attach the missing facts. Facts it returns are
  // verified like any others; numbers still unsupported after repair are
  // dropped by verification as before.
  const repair = { unsupportedSentences: 0, attempted: false, factsAdded: 0 };
  if (isAnalystProseRepairEnabled()) {
    const entityLabels = collectAnalystEntityLabels(audit);
    const datasetPool = collectDatasetNumericPool(audit);
    const unsupported = findUnsupportedProse(report, { datasetPool, entityLabels });
    repair.unsupportedSentences = unsupported.length;
    if (unsupported.length > 0) {
      repair.attempted = true;
      const listed = unsupported.slice(0, 30);
      const repairPrompt = [
        "Your report states numbers that have no supporting fact and cannot be derived directly from the tables. Each sentence below will be REMOVED from the report unless you supply a fact (compute spec) deriving each listed number from the dataset tables, using exact rowRef values.",
        "Return ONLY the facts array. For a number that cannot honestly be derived, return no fact — its sentence will be removed.",
        "",
        ...listed.map(
          (item) =>
            `- [${item.path}] "${item.sentence}" — unsupported numbers: ${item.unsupported
              .map((claim) => claim.raw.trim())
              .join(", ")}`
        ),
      ].join("\n");

      try {
        const repairMessage = await createMessage({
          model: analystModel,
          max_tokens: Math.min(maxOutputTokens, 8000),
          thinking: { type: "adaptive" },
          output_config: {
            effort: "medium",
            format: { type: "json_schema", schema: analystFactsPatchJsonSchema },
          },
          system: baseRequest.system,
          messages: [
            ...messages,
            { role: "assistant", content: [{ type: "text", text }] },
            { role: "user", content: [{ type: "text", text: repairPrompt }] },
          ],
        });
        addUsage(repairMessage.usage);
        const patchText = firstTextBlock(repairMessage.content);
        const patch = patchText ? JSON.parse(patchText) : { facts: [] };
        const patchFacts = Array.isArray(patch?.facts) ? patch.facts : [];
        if (patchFacts.length > 0) {
          report.supplementalFigures = [
            ...(report.supplementalFigures || []),
            ...patchFacts.map(expandProviderFact),
          ];
          repair.factsAdded = patchFacts.length;
        }
        if (trace) {
          trace.turns.push({
            turn: "prose-repair",
            request: repairPrompt,
            response: structuredClone(repairMessage.content || []),
            usage: structuredClone(repairMessage.usage || {}),
          });
        }
      } catch (repairError) {
        // Repair is best-effort: a failed patch call must never sink a good
        // report — verification simply drops what stayed unsupported.
        console.warn(`[analyst] prose repair failed (non-fatal): ${repairError.message}`);
      }
    }
  }

  return {
    repair,
    report,
    providerReport,
    model: analystModel,
    schemaVersion: ANALYST_SCHEMA_VERSION,
    quarantinedCampaigns: quarantined,
    serialization: {
      tokenEstimate: serialization.tokenEstimate,
      tableCount: serialization.tableCount,
      truncations: serialization.truncations,
      currency: serialization.currency,
      sliceCalls,
    },
    usage: usageTotals,
    ...(trace ? { trace } : {}),
  };
};
