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

const buildAiReportJsonInstructions = () => `
Return only valid JSON matching this exact shape:
{
  "executiveSummary": ["paragraph 1", "paragraph 2"],
  "topPriorities": [
    {
      "ruleId": "RULE-ID-FROM-CONTEXT",
      "platform": "META",
      "severity": "HIGH",
      "title": "Short title",
      "estimatedImpact": "Impact using only supplied facts",
      "recommendedAction": "Specific action"
    }
  ],
  "quickWins": [
    {
      "ruleId": "RULE-ID-FROM-CONTEXT",
      "platform": "META",
      "title": "Short title",
      "fixSteps": ["Step 1"]
    }
  ],
  "confidenceNotes": ["State if upload readiness is limited."],
  "clientReadyRecommendations": [
    {
      "headline": "Client-ready headline",
      "explanation": "Explanation based only on supplied rule findings.",
      "nextSteps": ["Step 1"],
      "sourceRuleIds": ["RULE-ID-FROM-CONTEXT"]
    }
  ]
}
Rules:
- Use only rule IDs present in ruleFindings.
- Do not invent metrics, dates, spend, CPA, ROAS, CTR, conversion counts, or platform facts.
- If uploadReadiness.mode is LIMITED, include that limitation in confidenceNotes.
- Keep executiveSummary to 2-3 paragraphs.
- Keep topPriorities and quickWins to at most 5 items each.
`;

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
            content:
              "You are AdAuditor Pro's report writer. You must output json only. Use only the supplied deterministic audit context. Do not invent metrics, dates, spend, CPA, ROAS, or platform facts.",
          },
          {
            role: "user",
            content: `${buildAiReportJsonInstructions()}\n\nAudit context JSON:\n${JSON.stringify(context)}`,
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
            parts: [
              {
                text: "You are AdAuditor Pro's report writer. Use only the supplied deterministic audit context. Do not invent metrics, dates, spend, CPA, ROAS, or platform facts. If data is limited, disclose reduced confidence. Keep recommendations specific, practical, and client-ready.",
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `${buildAiReportJsonInstructions()}\n\nAudit context JSON:\n${JSON.stringify(context)}`,
                },
              ],
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
            content:
              "You are AdAuditor Pro's report writer. Use only the supplied deterministic audit context. Do not invent metrics, dates, spend, CPA, ROAS, or platform facts. If data is limited, disclose reduced confidence. Keep recommendations specific, practical, and client-ready.",
          },
          {
            role: "user",
            content: JSON.stringify(context),
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
