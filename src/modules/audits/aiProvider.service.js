import { serviceUnavailable } from "../../utils/appError.js";
import { aiReportJsonSchema } from "./aiReport.schema.js";
import { recordAiUsage } from "./aiUsage.service.js";
import { redactContext } from "./piiRedaction.service.js";

const extractTokens = ({ provider, responseBody }) => {
  if (!responseBody) return { inputTokens: 0, outputTokens: 0 };
  if (provider === "openai") {
    const u = responseBody.usage || {};
    return {
      inputTokens: Number(u.input_tokens || u.prompt_tokens || 0),
      outputTokens: Number(u.output_tokens || u.completion_tokens || 0),
    };
  }
  if (provider === "deepseek") {
    const u = responseBody.usage || {};
    return {
      inputTokens: Number(u.prompt_tokens || 0),
      outputTokens: Number(u.completion_tokens || 0),
    };
  }
  if (provider === "gemini") {
    const u = responseBody.usageMetadata || {};
    return {
      inputTokens: Number(u.promptTokenCount || 0),
      outputTokens: Number(u.candidatesTokenCount || 0),
    };
  }
  if (provider === "anthropic") {
    const u = responseBody.usage || {};
    return {
      inputTokens: Number(u.input_tokens || 0),
      outputTokens: Number(u.output_tokens || 0),
    };
  }
  return { inputTokens: 0, outputTokens: 0 };
};

const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const GEMINI_GENERATE_CONTENT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";

const getAiConfig = () => ({
  provider: (process.env.AI_PROVIDER || "anthropic").toLowerCase(),
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

const getAnthropicConfig = () => ({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
  timeoutMs: Number(process.env.ANTHROPIC_TIMEOUT_MS || 60000),
  maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 9000),
  temperature: Number(process.env.ANTHROPIC_TEMPERATURE || 0.2),
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

const extractJsonObjectText = (text) => {
  const cleaned = String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (!cleaned) return null;

  const firstBrace = cleaned.indexOf("{");
  if (firstBrace === -1) return cleaned;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = firstBrace; index < cleaned.length; index += 1) {
    const char = cleaned[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return cleaned.slice(firstBrace, index + 1);
    }
  }

  return cleaned;
};

const parseJsonObject = (text) => JSON.parse(extractJsonObjectText(text));

const confidenceFromFinding = (finding = {}) => {
  const e = finding.evidence || {};
  if (typeof e.confidence === "string") {
    const value = e.confidence.toLowerCase();
    if (["high", "medium", "low"].includes(value)) return value;
  }
  if (String(e.sampleNote || "").toLowerCase().includes("low sample")) return "medium";
  if (finding.severity === "CRITICAL" || finding.severity === "HIGH") return "high";
  return "medium";
};

const easeFromFinding = (finding = {}) => {
  const steps = Array.isArray(finding.fixSteps) ? finding.fixSteps.length : 0;
  const text = `${finding.title || ""} ${finding.detail || ""}`.toLowerCase();
  if (text.includes("tracking") || text.includes("capi") || text.includes("pixel")) return "hard";
  if (steps > 3 || finding.severity === "CRITICAL") return "medium";
  return "easy";
};

const evidenceBulletsFromFinding = (finding = {}) => {
  const evidence = finding.evidence && typeof finding.evidence === "object"
    ? finding.evidence
    : {};
  const bullets = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (value === null || value === undefined || Array.isArray(value) || typeof value === "object") {
      continue;
    }
    bullets.push(`${key}: ${String(value)}`);
    if (bullets.length >= 4) break;
  }
  if (finding.estimatedImpact) bullets.unshift(`Impact: ${finding.estimatedImpact}`);
  if (finding.detail) bullets.push(finding.detail);
  return bullets.slice(0, 6);
};

const normalizeReportOutput = (output, context) => {
  const report = output && typeof output === "object" ? { ...output } : {};
  const topFindings = context?.evidencePacket?.topFindings || [];
  const ruleFindings = context?.ruleFindings || [];
  const focus = context?.audit?.businessProfileSnapshot?.sectionA?.auditFocus || null;
  const deep = context?.deepAudit || null;
  const primary = topFindings[0] || ruleFindings[0] || null;

  report.opportunitySummary ||= {
    biggestMoneyLeak: primary?.title || null,
    estimatedWaste: primary?.estimatedImpact || null,
    estimatedUpside: primary?.estimatedImpact || null,
    auditFocus: focus,
    rankingBasis:
      "Findings are ranked by estimated recoverable spend or revenue, then confidence, then ease of implementation.",
  };

  if (!Array.isArray(report.topPriorities) || report.topPriorities.length === 0) {
    report.topPriorities = topFindings.slice(0, 5).map((finding) => ({
      ruleId: finding.ruleId,
      platform: finding.platform ?? null,
      severity: finding.severity,
      title: finding.title,
      estimatedImpact: finding.estimatedImpact || "Impact not quantified from available data.",
      recommendedAction: Array.isArray(finding.fixSteps) && finding.fixSteps.length
        ? finding.fixSteps[0]
        : "Address this finding first because it is among the highest-impact verified issues.",
    }));
  }

  if (!Array.isArray(report.quickWins) || report.quickWins.length === 0) {
    report.quickWins = topFindings.slice(0, 5).map((finding) => ({
      ruleId: finding.ruleId,
      platform: finding.platform ?? null,
      title: finding.title,
      fixSteps: Array.isArray(finding.fixSteps) && finding.fixSteps.length
        ? finding.fixSteps.slice(0, 3)
        : ["Review the affected setting in the platform UI and apply the recommended fix."],
    }));
  }

  if (
    !Array.isArray(report.clientReadyRecommendations) ||
    report.clientReadyRecommendations.length === 0
  ) {
    report.clientReadyRecommendations = topFindings.slice(0, 5).map((finding) => ({
      headline: finding.title,
      explanation: finding.detail || finding.estimatedImpact || "This finding should be prioritized based on the verified audit evidence.",
      nextSteps: Array.isArray(finding.fixSteps) && finding.fixSteps.length
        ? finding.fixSteps.slice(0, 4)
        : ["Assign this item to the media buyer and verify the change in the next audit."],
      sourceRuleIds: [finding.ruleId],
    }));
  }

  if (!Array.isArray(report.findingAnalyses) || report.findingAnalyses.length === 0) {
    report.findingAnalyses = topFindings.slice(0, 6).map((finding) => ({
      ruleId: finding.ruleId,
      platform: finding.platform ?? null,
      title: finding.title,
      whatIsHappening: finding.detail || finding.title,
      whyItIsHappening: finding.evidence?.reason
        ? `The deterministic evidence flags the driver as ${String(finding.evidence.reason).replace(/_/g, " ")}.`
        : deep?.report?.rootCause || "The rule evidence points to an efficiency or tracking constraint in this part of the account.",
      evidence: evidenceBulletsFromFinding(finding),
      estimatedBusinessImpact: finding.estimatedImpact || "Impact not quantified from available data.",
      confidence: confidenceFromFinding(finding),
      easeOfImplementation: easeFromFinding(finding),
      recommendedActions: Array.isArray(finding.fixSteps) && finding.fixSteps.length
        ? finding.fixSteps.slice(0, 5)
        : ["Review the affected platform area and apply the recommended fix."],
      expectedOutcome:
        "After fixing, wasted spend should decline and the affected KPI should move closer to the account benchmark or declared target.",
    }));
  }

  if (!Array.isArray(report.hypothesisAnalyses) || report.hypothesisAnalyses.length === 0) {
    report.hypothesisAnalyses = [
      {
        hypothesis: deep?.report?.headline || primary?.title || "The largest verified finding is the primary performance bottleneck.",
        testsRun: deep?.reasoningTrace?.length
          ? deep.reasoningTrace.map((step) => `Ran ${step.tool}${step.phase ? ` (${step.phase})` : ""}`).slice(0, 6)
          : ["Ranked deterministic findings by impact", "Checked data confidence", "Reviewed benchmark, peer, and historical evidence where available"],
        conclusion: deep?.report?.rootCause || primary?.detail || "The evidence supports prioritizing the largest verified finding first.",
        confidence: deep?.report?.confidence || (primary ? confidenceFromFinding(primary) : "medium"),
        sourceRuleIds: primary ? [primary.ruleId] : [],
      },
    ];
  }

  if (!Array.isArray(report.benchmarkComparisons) || report.benchmarkComparisons.length === 0) {
    const comparisons = [];
    for (const item of report.comparisonInsights || []) {
      comparisons.push({ label: "Peer comparison", comparisonType: "peer", finding: item, confidence: "high" });
    }
    for (const item of report.memoryInsights || []) {
      comparisons.push({ label: "Historical performance", comparisonType: "historical", finding: item, confidence: "medium" });
    }
    const benchmarkRules = topFindings.filter((finding) =>
      String(finding.ruleId || "").includes("BENCH") ||
      String(finding.category || "").toLowerCase().includes("benchmark")
    );
    for (const finding of benchmarkRules) {
      comparisons.push({
        label: finding.title,
        comparisonType: "industry",
        finding: finding.detail || finding.estimatedImpact || finding.title,
        confidence: confidenceFromFinding(finding),
      });
    }
    report.benchmarkComparisons = comparisons.slice(0, 6);
  }

  // Sanitize sub-arrays within each item — the AI can return valid top-level
  // arrays but with individual items missing required sub-fields, which causes
  // .map() crashes in the frontend.
  if (Array.isArray(report.clientReadyRecommendations)) {
    report.clientReadyRecommendations = report.clientReadyRecommendations.map((r) => ({
      ...r,
      nextSteps: Array.isArray(r?.nextSteps) ? r.nextSteps : [],
      sourceRuleIds: Array.isArray(r?.sourceRuleIds) ? r.sourceRuleIds : [],
    }));
  }
  if (Array.isArray(report.findingAnalyses)) {
    report.findingAnalyses = report.findingAnalyses.map((r) => ({
      ...r,
      evidence: Array.isArray(r?.evidence) ? r.evidence : [],
      recommendedActions: Array.isArray(r?.recommendedActions) ? r.recommendedActions : [],
    }));
  }
  if (Array.isArray(report.hypothesisAnalyses)) {
    report.hypothesisAnalyses = report.hypothesisAnalyses.map((r) => ({
      ...r,
      testsRun: Array.isArray(r?.testsRun) ? r.testsRun : [],
      sourceRuleIds: Array.isArray(r?.sourceRuleIds) ? r.sourceRuleIds : [],
    }));
  }

  report.auditNarrativeVersion ||= "v3-deep-default";
  report.segmentInsights ||= [];
  report.comparisonInsights ||= [];
  report.memoryInsights ||= [];
  report.risksAndAssumptions ||= [];
  if (!Array.isArray(report.confidenceNotes) || report.confidenceNotes.length === 0) {
    report.confidenceNotes = [
      "Data confidence depends on uploaded/API coverage and tracking findings shown in the audit.",
    ];
  }
  if (!Array.isArray(report.executiveSummary) || report.executiveSummary.length < 2) {
    report.executiveSummary = primary
      ? [
          `Health score is ${context?.audit?.healthScore ?? "not available"}/100. The largest verified issue is ${primary.title}.`,
          primary.estimatedImpact || primary.detail || "Prioritize the highest-impact findings first.",
        ]
      : ["No major issues were found in the available data.", "Review data coverage before making large budget decisions."];
  }

  return report;
};

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

9. PRIOR AUDIT CONTEXT: If priorAudits contains data, reference it explicitly using only the exact prior/current values already present in evidencePacket.comparison.selfOverTime. If those exact values are absent, describe the change without dollar amounts. Trend context is highly valuable to the client.

10. EVIDENCE PACKET IS THE SOURCE OF TRUTH: The supplied context contains an "evidencePacket" object built by deterministic code. It is the authoritative source. Every dollar figure you cite MUST already appear in evidencePacket (in a finding's evidence/estimatedImpact, in evidencePacket.verifiedNumbers, or in evidencePacket.comparison). You must NOT compute, derive, sum, or estimate any new dollar amount, percentage, CPA, ROAS, or count. If a number is not in the packet, do not state it. The deterministic code has already done all arithmetic — your job is to explain and prioritize, never to calculate.

11. PRIORITY ORDER: Rank and lead with findings in this order: (a) highest verified dollar impact (evidencePacket.topFindings are pre-sorted by estimatedImpactDollars — respect that order), (b) tracking/data-reliability issues (evidencePacket.dataConfidence), (c) segment-waste findings (SEG-WASTE-*), (d) peer-comparison gaps (evidencePacket.comparison.peer), (e) memory regression/improvement (evidencePacket.comparison.selfOverTime).`;

const DEEP_REPORTING_RULES = `DEFAULT DEEP AUDIT REQUIREMENTS:
- Treat this as the main client-facing audit, not a short rule summary.
- Produce a substantially deeper strategist report: executive diagnosis, hypothesis tests, detailed finding analysis, benchmarks, and expected outcomes.
- For major performance findings, investigate root causes. If high CPA is present, discuss the diagnostic path using only supplied facts: CPM, CTR, conversion rate, peers, benchmarks, segment waste, campaign type, and tracking reliability.
- Every major finding must include what is happening, why it is happening, evidence, estimated business impact, confidence, recommended actions, and expected outcome after fixing.
- If auditFocus is supplied, use it only to guide prioritization and wording. Still audit the whole account and surface hidden issues outside that focus.
- Rank findings by estimated recoverable spend/revenue first, confidence second, and ease of implementation third.`;

const buildUserPrompt = (context) => {
  const bp = context?.audit?.businessProfileSnapshot?.sectionA || {};
  const totals = context?.normalizedSummary?.totals || {};
  const healthScore = context?.audit?.healthScore ?? "N/A";
  const platforms = (context?.audit?.selectedPlatforms || []).join(", ");
  const hasPriorAudits = (context?.priorAudits || []).length > 0;
  const auditFocus = bp.auditFocus || null;
  const auditFocusOther = bp.auditFocusOther || null;
  const deepAudit = context?.deepAudit || null;
  const promptEvidencePacket = context?.evidencePacket
    ? {
        ...context.evidencePacket,
        // Keep raw aggregate rows out of the model prompt. They are useful to
        // backend code, but they invite the model to calculate CPA/CPC/etc.
        normalizedSummary: undefined,
        priorAudits: undefined,
        intakeResponses: undefined,
      }
    : null;
  const allowedDollarAmounts = (context?.evidencePacket?.verifiedNumbers || [])
    .map((n) => `$${Number(n).toLocaleString()}`)
    .join(", ");

  const contextHints = [
    bp.targetCpa ? `• Declared target CPA: $${bp.targetCpa}` : "• Target CPA: not declared (use industry benchmarks)",
    bp.targetRoas ? `• Declared target ROAS: ${bp.targetRoas}×` : "• Target ROAS: not declared",
    bp.monthlyBudget ? `• Declared monthly budget: $${bp.monthlyBudget.toLocaleString()}` : "• Monthly budget: not declared",
    bp.businessType ? `• Business type: ${bp.businessType}` : "• Business type: not declared",
    bp.avgOrderValue ? `• Avg order value: $${bp.avgOrderValue}` : null,
    bp.blendedCac ? `• Blended CAC: $${bp.blendedCac}` : null,
    totals.spend ? `• Total spend in audit data: $${Math.round(totals.spend).toLocaleString()}` : null,
    `• Overall health score: ${healthScore}/100`,
    `• Platforms audited: ${platforms}`,
    hasPriorAudits ? `• Prior audit data available: YES — reference trends explicitly` : "• Prior audit data: none",
  ].filter(Boolean).join("\n");
  const focusHint = auditFocus
    ? `${auditFocus}${auditFocus === "other" && auditFocusOther ? ` (${auditFocusOther})` : ""}`
    : "diagnose_performance";
  const deepAuditContext = deepAudit?.report
    ? JSON.stringify({
        mode: deepAudit.mode,
        headline: deepAudit.report.headline,
        rootCause: deepAudit.report.rootCause,
        confidence: deepAudit.report.confidence,
        drivers: deepAudit.report.drivers,
        recommendations: deepAudit.report.recommendations,
        toolsRun: (deepAudit.reasoningTrace || []).map((step) => step.tool),
      })
    : "No separate Deep Audit loop result was available; use the evidence packet and deterministic findings.";

  return `Write the AI narrative for this paid advertising audit. Return ONLY valid JSON — no markdown, no preamble, no explanation outside the JSON.

KEY ACCOUNT FACTS (extracted for quick reference — all values also in the full context below):
${contextHints}

AUDIT FOCUS:
${focusHint}

${DEEP_REPORTING_RULES}

DEEP AUDIT HYPOTHESIS RESULT:
${deepAuditContext}

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
  ],
  "auditNarrativeVersion": "v3-deep-default",
  "dataConfidenceSummary": "one sentence on data reliability from evidencePacket.dataConfidence (or null)",
  "segmentInsights": ["segment-level facts from SEG-WASTE-* findings, with the exact segment + dollar from evidence"],
  "comparisonInsights": ["facts from evidencePacket.comparison.peer — name the peer account + the exact metric gap"],
  "memoryInsights": ["facts from evidencePacket.comparison.selfOverTime — quote the exact delta vs the prior audit date"],
  "risksAndAssumptions": ["any caveat: limited sample, missing targets, tracking unreliability — drawn from evidence sampleNote/confidence fields"]
}

ADDITIONAL REQUIRED DEEP FIELDS:
- opportunitySummary: summarize the biggest money leak, estimated waste, estimated upside, audit focus, and ranking basis.
- findingAnalyses: write 4 to 8 detailed finding analyses. Each must include what is happening, why it is happening, evidence, estimated business impact, confidence, ease, recommended actions, and expected outcome.
- hypothesisAnalyses: explain the root-cause hypotheses tested. For CPA/ROAS/CTR issues, reference the diagnostic checks available in the evidence/deepAudit context.
- benchmarkComparisons: include industry, historical, and peer comparisons when available. Empty array only when no benchmark/comparison facts exist.

SECTION-BY-SECTION INSTRUCTIONS:

STRICT FACT CHECK BEFORE YOU RETURN:
• Allowed dollar amounts for this response are ONLY: ${allowedDollarAmounts || "none"}.
• Before returning JSON, scan every field you wrote. If any "$" amount is not exactly in that allowed list, remove it or replace it with a non-dollar phrase.
• Do not write illustrative examples with dollar amounts.
• Do not write "recovery", "savings", "overage", "per conversion", or "budget at risk" dollar estimates unless that exact dollar amount appears in the allowed list.
• Do not calculate CPA, CPC, CPM, ROAS, budget, recovery, or percentage deltas from spend/click/conversion totals. Only repeat values already present in the evidence packet.

executiveSummary (2 required, 3rd optional):
• Para 1: Lead with the health score and what it signals. Quote the total spend reviewed ($${Math.round(totals.spend || 0).toLocaleString()}). Name the single most expensive problem with its exact dollar waste from the findings — do not bury the lead.
• Para 2: Connect performance to declared goals only when those exact goal values appear in the evidence packet. If BP-PERF-001 exists in ruleFindings, state the CPA gap only using evidence values. If BP-PERF-002 exists, state the ROAS shortfall only using evidence values. If any BP-TRK findings exist, warn that data reliability is compromised and CPA/ROAS figures cannot be fully trusted until tracking is fixed.${hasPriorAudits ? "\n• Para 3: Reference prior audit data to show whether performance is improving or deteriorating. Quote only the exact metric change already present in evidencePacket.comparison.selfOverTime." : "\n• Para 3 (optional): Prognosis — describe the expected operational improvement without adding any new dollar amount."}

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
• explanation: 2-3 sentences with exact evidence numbers only. Do not include made-up examples or newly calculated dollar amounts.
• nextSteps: specific enough that a media buyer receiving this brief knows exactly what to do without needing to run their own analysis
• sourceRuleIds: only rule IDs from ruleFindings

segmentInsights (0 to 5 — only from SEG-WASTE-* findings if present):
• Quote the exact segment + dimension + dollar from evidence: "The 45-54 age segment wasted $206 with zero conversions." Empty array if no segment findings.

comparisonInsights (0 to 3 — only from evidencePacket.comparison.peer if present):
• Name the peer account and the exact gap: "This account's CTR (1.0%) is 75% below your Best Account (4.0%) at the same spend band." Empty array if no peer.

memoryInsights (0 to 3 — only from evidencePacket.comparison.selfOverTime if present):
• Quote the exact delta vs the prior audit: "CPA worsened 100% (from $50 to $100) since your May 1 audit." Or improvement. Empty array if no prior audit.

dataConfidenceSummary:
• One sentence reflecting evidencePacket.dataConfidence. Null if unknown.

risksAndAssumptions (1 to 4):
• Surface any sampleNote/confidence caveats from the evidence so the client knows what is solid vs directional.

EVIDENCE PACKET (authoritative source of truth — use ONLY numbers present here):
${JSON.stringify(promptEvidencePacket)}

SUPPORTING CONTEXT (audit metadata only — the evidencePacket above is canonical):
${JSON.stringify({
    audit: context?.audit,
  })}`;
};

export const __test__ = { buildSystemPrompt, buildUserPrompt };

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
        max_tokens: Number(process.env.DEEPSEEK_MAX_TOKENS || 9000),
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
      output: parseJsonObject(content),
      usage: extractTokens({ provider: "deepseek", responseBody }),
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
            maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 9000),
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
      output: parseJsonObject(text),
      usage: extractTokens({ provider: "gemini", responseBody }),
    };
  } finally {
    timeout.clear();
  }
};

const generateAnthropicAuditReport = async ({ context }) => {
  const config = getAnthropicConfig();

  if (!config.apiKey) {
    throw serviceUnavailable("Anthropic is not configured.", {
      missingEnv: "ANTHROPIC_API_KEY",
    });
  }

  const timeout = withTimeout(config.timeoutMs);

  try {
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      signal: timeout.signal,
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        // Opus 4.7/4.8 reject sampling params (400); only send temperature to
        // models that accept it (Sonnet / Haiku / older).
        ...(/opus-4-(7|8)/.test(config.model) ? {} : { temperature: config.temperature }),
        system: buildSystemPrompt(),
        messages: [
          {
            role: "user",
            // Ask for a strict JSON object so we can parse the report shape.
            content: `${buildUserPrompt(context)}\n\nRespond with ONLY a single valid JSON object matching the audit report schema. No markdown, no code fences, no prose outside the JSON.`,
          },
        ],
      }),
    });

    const responseBody = await response.json().catch(() => null);

    if (!response.ok) {
      throw serviceUnavailable("Anthropic report generation failed.", {
        status: response.status,
        response: responseBody,
      });
    }

    // Messages API returns content as an array of blocks; concatenate text.
    const text = Array.isArray(responseBody?.content)
      ? responseBody.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
          .trim()
      : null;

    if (!text) {
      throw serviceUnavailable("Anthropic response did not include text content.", {
        responseId: responseBody?.id,
      });
    }

    return {
      provider: "anthropic",
      model: config.model,
      responseId: responseBody.id,
      output: parseJsonObject(text),
      usage: extractTokens({ provider: "anthropic", responseBody }),
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
      output: parseJsonObject(text),
      usage: extractTokens({ provider: "openai", responseBody }),
    };
  } finally {
    timeout.clear();
  }
};

export const generateAiAuditReport = async ({
  context,
  auditId = null,
  organizationId = null,
  purpose = "audit_report",
} = {}) => {
  const config = getAiConfig();
  let providerCall;
  if (config.provider === "gemini") providerCall = generateGeminiAuditReport;
  else if (config.provider === "openai") providerCall = generateOpenAiAuditReport;
  else if (config.provider === "deepseek") providerCall = generateDeepSeekAuditReport;
  else if (config.provider === "anthropic") providerCall = generateAnthropicAuditReport;
  else
    throw serviceUnavailable("Unsupported AI provider.", {
      provider: config.provider,
    });

  const safeContext = redactContext(context);

  try {
    const result = await providerCall({ context: safeContext });
    result.output = normalizeReportOutput(result.output, safeContext);
    // Best-effort cost tracking. Never blocks the audit.
    await recordAiUsage({
      organizationId,
      auditId: auditId ?? context?.audit?.id ?? null,
      provider: result.provider,
      model: result.model,
      purpose,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      status: "SUCCESS",
    });
    return result;
  } catch (err) {
    await recordAiUsage({
      organizationId,
      auditId: auditId ?? context?.audit?.id ?? null,
      provider: config.provider,
      model: "unknown",
      purpose,
      inputTokens: 0,
      outputTokens: 0,
      status: "ERROR",
      errorMessage: err?.message?.slice(0, 500) ?? null,
    });
    throw err;
  }
};
