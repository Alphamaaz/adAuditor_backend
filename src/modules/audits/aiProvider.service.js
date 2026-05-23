import { serviceUnavailable } from "../../utils/appError.js";
import { aiReportJsonSchema } from "./aiReport.schema.js";

const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const GEMINI_GENERATE_CONTENT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

const getAiConfig = () => ({
  provider: (process.env.AI_PROVIDER || "gemini").toLowerCase(),
});

const getDeepSeekConfig = () => ({
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  timeoutMs: Number(process.env.DEEPSEEK_TIMEOUT_MS || 45000),
});

const getOpenAiConfig = () => ({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 45000),
});

const getGeminiConfig = () => ({
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL || "gemini-flash-latest",
  timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 45000),
});

const withTimeout = (timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
};

const parseResponseText = (responseBody) => {
  if (responseBody.output_text) return responseBody.output_text;

  const message = responseBody.output?.find((item) => item.type === "message");
  const outputText = message?.content?.find((item) => item.type === "output_text");
  return outputText?.text;
};

const parseGeminiResponseText = (responseBody) =>
  responseBody?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text)
    .filter(Boolean)
    .join("\n");

// ── Prompt builders ───────────────────────────────────────────────────────────

const buildSystemPrompt = () =>
  `You are a senior paid media strategist and audit writer at Ad Adviser, a professional advertising account audit service. You have personally audited hundreds of ad accounts spending $5,000 to $10,000,000 per month across Meta, Google Ads, and TikTok for over a decade.

Clients pay for your audit reports because you tell them exactly what is costing them money — with specific dollar amounts — and exactly what to do about it, ranked by financial impact. Your reports are never generic. Every sentence is grounded in the client's actual data.

WRITING RULES — follow these without exception:

1. DOLLAR SPECIFICITY: Every problem you describe MUST include the specific dollar amount, percentage, or metric from ruleFindings evidence or normalizedSummary. Never write about a performance issue without its dollar cost. "Your campaigns wasted $4,280" beats "spend efficiency is suboptimal" every time.

2. GOAL-REFERENCED FRAMING: Always compare performance against the client's declared goals in businessProfileSnapshot.sectionA. If targetCpa is $50 and actual CPA is $148, write "$148 actual CPA — 3× your $50 target." If targetRoas is 4.0 and estimated ROAS is 1.2, write "1.2× estimated ROAS against your 4.0× target — you are getting back $0.30 for every $1 spent." Never describe underperformance without anchoring it to their declared goal.

3. IMPACT RANKING: Rank all priorities strictly by estimated dollar waste or revenue impact, not by severity label alone. A $12,000/month waste issue at MEDIUM severity must be ranked above a $150/month issue at CRITICAL. Always explain why a finding is the top priority in dollar terms.

4. EXPERT TONE: Write for a sophisticated advertiser who manages their own agency or in-house media team. Skip beginner-level explanations. Go straight to the diagnosis, the mechanism, and the action. Use the language of paid media professionals: "ad set learning phase", "broad match bleed", "pixel event mismatch", "CAPI signal loss", "search term irrelevance waste" — not "your ads may not be optimized."

5. DIRECTNESS: Never use "it appears", "it seems", "you may want to consider", "it might be worth", "could potentially", or "seems like". State conclusions directly. "Your pixel is not firing on the checkout page" — not "it appears there may be a tracking issue."

6. BUSINESS MODEL MATCHING: Match language to the declared business type in businessProfileSnapshot.sectionA.businessType. eCommerce accounts → frame everything in ROAS, revenue, and purchase CPA. Lead Gen → CPA per lead and lead volume. App Install → CPI and install rate. B2B SaaS → cost per qualified lead and pipeline value. Local → cost per contact and geographic efficiency.

7. TRACKING AWARENESS: If tracking issues exist (findings BP-TRK-001, BP-TRK-002, BP-TRK-003, or BP-TRK-004), state immediately that all CPA and ROAS figures in this audit are unreliable until these are resolved. Don't analyze ROAS data as if it's trustworthy when the underlying tracking is broken.

8. NO INVENTION: Never invent campaign names, dollar figures, CPAs, ROASes, CTRs, conversion counts, dates, or any metrics. Use ONLY what appears in the supplied audit context JSON. If a metric is not in the context, do not mention it.

9. PRIOR AUDIT CONTEXT: If priorAudits contains data, reference it explicitly: "Your CPA has worsened from $X in your [date] audit to $Y now — a Z% deterioration." If it shows improvement, say so. Trend context is highly valuable to the client.`;

const buildUserPrompt = (context) => {
  const bp = context?.audit?.businessProfileSnapshot?.sectionA || {};
  const totals = context?.normalizedSummary?.totals || {};
  const healthScore = context?.audit?.healthScore ?? "N/A";
  const platforms = (context?.audit?.selectedPlatforms || []).join(", ");
  const hasPriorAudits = (context?.priorAudits || []).length > 0;

  const contextHints = [
    bp.targetCpa ? `• Declared target CPA: $${bp.targetCpa}` : "• Target CPA: not declared (use industry benchmarks)",
    bp.targetRoas ? `• Declared target ROAS: ${bp.targetRoas}×` : "• Target ROAS: not declared",
    bp.monthlyBudget ? `• Declared monthly budget: $${bp.monthlyBudget.toLocaleString()}` : "• Monthly budget: not declared",
    bp.businessType ? `• Business type: ${bp.businessType}` : "• Business type: not declared",
    bp.avgOrderValue ? `• Avg order value: $${bp.avgOrderValue}` : null,
    bp.blendedCac ? `• Blended CAC: $${bp.blendedCac}` : null,
    totals.spend ? `• Total spend in audit data: $${Math.round(totals.spend).toLocaleString()}` : null,
    totals.conversions ? `• Total conversions in audit data: ${totals.conversions}` : null,
    `• Overall health score: ${healthScore}/100`,
    `• Platforms audited: ${platforms}`,
    hasPriorAudits ? `• Prior audit data available: YES — reference trends explicitly` : "• Prior audit data: none",
  ].filter(Boolean).join("\n");

  return `Write the AI narrative for this paid advertising audit. Return ONLY valid JSON — no markdown, no preamble, no explanation outside the JSON.

KEY ACCOUNT FACTS (extracted for quick reference — all values also in the full context below):
${contextHints}

REQUIRED JSON OUTPUT:

{
  "executiveSummary": ["paragraph 1", "paragraph 2", "optional paragraph 3"],
  "topPriorities": [
    {
      "ruleId": "only IDs from ruleFindings",
      "platform": "META|GOOGLE|TIKTOK",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "title": "concise title",
      "estimatedImpact": "must quote the specific dollar figure from that finding's evidence",
      "recommendedAction": "one specific instruction, starts with a verb"
    }
  ],
  "quickWins": [
    {
      "ruleId": "only IDs from ruleFindings",
      "platform": "META|GOOGLE|TIKTOK",
      "title": "concise title",
      "fixSteps": ["step 1", "step 2"]
    }
  ],
  "confidenceNotes": ["note 1", "note 2"],
  "clientReadyRecommendations": [
    {
      "headline": "punchy, action-oriented headline",
      "explanation": "2-3 sentences with specific numbers from the findings",
      "nextSteps": ["specific step 1", "specific step 2"],
      "sourceRuleIds": ["RULE-ID-FROM-CONTEXT"]
    }
  ]
}

SECTION-BY-SECTION INSTRUCTIONS:

executiveSummary (2 required, 3rd optional):
• Para 1: Lead with the health score and what it signals. Quote the total spend reviewed ($${Math.round(totals.spend || 0).toLocaleString()}). Name the single most expensive problem with its exact dollar waste from the findings — do not bury the lead.
• Para 2: Connect performance to declared goals. If BP-PERF-001 exists in ruleFindings, state the CPA gap in dollar and multiple terms using the evidence numbers. If BP-PERF-002 exists, state the ROAS shortfall. If any BP-TRK findings exist, warn that data reliability is compromised and CPA/ROAS figures cannot be fully trusted until tracking is fixed.${hasPriorAudits ? "\n• Para 3: Reference prior audit data to show whether performance is improving or deteriorating. Quote the specific metric change." : "\n• Para 3 (optional): Prognosis — what fixing the top 3 findings would recover mechanically (e.g. 'eliminating the $X in zero-conversion spend and fixing UTM tracking would improve attributable ROAS within 2-4 weeks')."}

topPriorities (max 5, ranked by dollar impact, not severity label):
• Only ruleIds that appear in ruleFindings
• estimatedImpact: copy the dollar figure directly from that finding's estimatedImpact field or evidence.wastedSpend / evidence.lossMakingSpend — do not rephrase without numbers
• recommendedAction: one specific action starting with a verb — "Pause the 3 zero-conversion campaigns identified in STR-009", not "Review campaign performance"

quickWins (max 5, prefer MEDIUM/LOW severity findings):
• Actions a media buyer can complete in under 1 hour with no budget risk
• fixSteps: make them account-specific — reference the platform and what specifically needs to be done

confidenceNotes:
• If uploadReadiness.mode is "LIMITED": start with "This audit ran with partial data. Missing: [list from uploadReadiness]. Treat findings as directional."
• If BP-TRK-001 or BP-TRK-002 exists in ruleFindings: "Conversion tracking issues detected. CPA and ROAS figures in this report are unreliable until pixel and conversion event configuration is corrected."
• If businessProfileSnapshot lacks targetCpa AND targetRoas: "No performance targets declared. CPA and ROAS analysis uses industry benchmarks rather than client-specific goals. Audit accuracy improves when targets are set in profile settings."
• If all data is complete and tracking looks clean: "Data coverage and tracking configuration are sufficient for a high-confidence audit."

clientReadyRecommendations (3 to 5 items — written for the client to hand to their agency):
• headline: short, direct, action-oriented — a sentence the client can put in a Slack message to their agency
• explanation: 2-3 sentences with specific numbers — "Your Google account has 4 campaigns that spent $6,200 in the audit period with zero recorded conversions. This is direct, recoverable waste."
• nextSteps: specific enough that a media buyer receiving this brief knows exactly what to do without needing to run their own analysis
• sourceRuleIds: only rule IDs from ruleFindings

FULL AUDIT CONTEXT JSON:
${JSON.stringify(context)}`;
};

// ── Provider implementations ──────────────────────────────────────────────────

const generateDeepSeekAuditReport = async ({ context }) => {
  const config = getDeepSeekConfig();

  if (!config.apiKey) {
    throw serviceUnavailable("DeepSeek is not configured.", {
      missingEnv: "DEEPSEEK_API_KEY",
    });
  }

  const timeout = withTimeout(config.timeoutMs);

  try {
    const response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      signal: timeout.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(),
          },
          {
            role: "user",
            content: buildUserPrompt(context),
          },
        ],
        response_format: {
          type: "json_object",
        },
        max_tokens: Number(process.env.DEEPSEEK_MAX_TOKENS || 4000),
        temperature: Number(process.env.DEEPSEEK_TEMPERATURE || 0.2),
      }),
    });

    const responseBody = await response.json().catch(() => null);

    if (!response.ok) {
      throw serviceUnavailable("DeepSeek report generation failed.", {
        status: response.status,
        response: responseBody,
      });
    }

    const content = responseBody?.choices?.[0]?.message?.content;

    if (!content) {
      throw serviceUnavailable("DeepSeek response did not include message content.", {
        responseId: responseBody?.id,
      });
    }

    return {
      provider: "deepseek",
      model: config.model,
      responseId: responseBody.id,
      output: JSON.parse(content),
    };
  } finally {
    timeout.clear();
  }
};

const generateGeminiAuditReport = async ({ context }) => {
  const config = getGeminiConfig();

  if (!config.apiKey) {
    throw serviceUnavailable("Gemini is not configured.", {
      missingEnv: "GEMINI_API_KEY",
    });
  }

  const timeout = withTimeout(config.timeoutMs);

  try {
    const response = await fetch(
      `${GEMINI_GENERATE_CONTENT_BASE_URL}/${config.model}:generateContent`,
      {
        method: "POST",
        signal: timeout.signal,
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": config.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: buildSystemPrompt() }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: buildUserPrompt(context) }],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 4000),
            temperature: Number(process.env.GEMINI_TEMPERATURE || 0.2),
          },
        }),
      }
    );

    const responseBody = await response.json().catch(() => null);

    if (!response.ok) {
      throw serviceUnavailable("Gemini report generation failed.", {
        status: response.status,
        response: responseBody,
      });
    }

    const text = parseGeminiResponseText(responseBody);

    if (!text) {
      throw serviceUnavailable("Gemini response did not include output text.", {
        responseId: responseBody?.responseId,
      });
    }

    return {
      provider: "gemini",
      model: config.model,
      responseId: responseBody.responseId,
      output: JSON.parse(text),
    };
  } finally {
    timeout.clear();
  }
};

const generateOpenAiAuditReport = async ({ context }) => {
  const config = getOpenAiConfig();

  if (!config.apiKey) {
    throw serviceUnavailable("OpenAI is not configured.", {
      missingEnv: "OPENAI_API_KEY",
    });
  }

  const timeout = withTimeout(config.timeoutMs);

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      signal: timeout.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        input: [
          {
            role: "system",
            content: buildSystemPrompt(),
          },
          {
            role: "user",
            content: buildUserPrompt(context),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "ad_audit_ai_report",
            strict: true,
            schema: aiReportJsonSchema,
          },
        },
      }),
    });

    const responseBody = await response.json().catch(() => null);

    if (!response.ok) {
      throw serviceUnavailable("OpenAI report generation failed.", {
        status: response.status,
        response: responseBody,
      });
    }

    const text = parseResponseText(responseBody);

    if (!text) {
      throw serviceUnavailable("OpenAI response did not include output text.", {
        responseId: responseBody?.id,
      });
    }

    return {
      provider: "openai",
      model: config.model,
      responseId: responseBody.id,
      output: JSON.parse(text),
    };
  } finally {
    timeout.clear();
  }
};

export const generateAiAuditReport = async ({ context }) => {
  const config = getAiConfig();

  if (config.provider === "gemini") {
    return generateGeminiAuditReport({ context });
  }

  if (config.provider === "openai") {
    return generateOpenAiAuditReport({ context });
  }

  if (config.provider === "deepseek") {
    return generateDeepSeekAuditReport({ context });
  }

  throw serviceUnavailable("Unsupported AI provider.", {
    provider: config.provider,
  });
};
