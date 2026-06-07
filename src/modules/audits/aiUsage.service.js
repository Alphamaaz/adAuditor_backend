/**
 * AiUsage recording — fire-and-forget cost tracking for LLM calls.
 *
 * Pricing table (USD per 1M tokens). Keep up to date as providers change.
 * Conservative defaults — if the provider isn't listed, we fall back to
 * a configurable per-call cost via env so production isn't blocked.
 */

import { prisma } from "../../lib/prisma.js";

// USD per 1,000,000 tokens. Numbers reflect public list pricing at time of
// authoring; update when providers change pricing.
const PRICING = {
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  // Gemini
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-flash-latest": { input: 0.075, output: 0.3 },
  "gemini-1.5-pro": { input: 1.25, output: 5.0 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  // DeepSeek
  "deepseek-chat": { input: 0.27, output: 1.1 },
  // Anthropic Claude (per 1M tokens, list pricing)
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-1": { input: 15.0, output: 75.0 },
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-3-5-sonnet-latest": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-latest": { input: 0.8, output: 4.0 },
};

const FALLBACK_INPUT_PER_M = Number(
  process.env.AI_FALLBACK_INPUT_USD_PER_M || 1.0
);
const FALLBACK_OUTPUT_PER_M = Number(
  process.env.AI_FALLBACK_OUTPUT_USD_PER_M || 3.0
);

export const computeCostUsd = ({ model, inputTokens, outputTokens }) => {
  const rates = PRICING[model] ?? {
    input: FALLBACK_INPUT_PER_M,
    output: FALLBACK_OUTPUT_PER_M,
  };
  const cost =
    (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
  // Round to micro-dollars to fit Decimal(10,6).
  return Math.round(cost * 1_000_000) / 1_000_000;
};

/**
 * Record one AI call. Never throws — failures here must not break the audit.
 */
/**
 * Sum AiUsage cost for an organization within a window.
 * Used by the cost-cap middleware. Returns USD as a JS number.
 */
export const sumOrgAiCostUsd = async ({ organizationId, since, until = new Date() }) => {
  if (!organizationId) return 0;
  const rows = await prisma.aiUsage.aggregate({
    where: {
      organizationId,
      status: "SUCCESS",
      createdAt: { gte: since, lte: until },
    },
    _sum: { costUsd: true },
  });
  const sum = rows._sum?.costUsd;
  if (sum == null) return 0;
  return Number(sum.toString());
};

/**
 * Sum AiUsage cost globally within a window. Used for the global daily cap
 * (safety net against abuse spikes that affect every customer).
 */
export const sumGlobalAiCostUsd = async ({ since, until = new Date() }) => {
  const rows = await prisma.aiUsage.aggregate({
    where: {
      status: "SUCCESS",
      createdAt: { gte: since, lte: until },
    },
    _sum: { costUsd: true },
  });
  const sum = rows._sum?.costUsd;
  if (sum == null) return 0;
  return Number(sum.toString());
};

export const recordAiUsage = async ({
  organizationId = null,
  auditId = null,
  provider,
  model,
  purpose = null,
  inputTokens = 0,
  outputTokens = 0,
  status = "SUCCESS",
  errorMessage = null,
}) => {
  try {
    const totalTokens = inputTokens + outputTokens;
    const costUsd = computeCostUsd({ model, inputTokens, outputTokens });
    await prisma.aiUsage.create({
      data: {
        organizationId,
        auditId,
        provider,
        model,
        purpose,
        inputTokens,
        outputTokens,
        totalTokens,
        costUsd,
        status,
        errorMessage,
      },
    });
  } catch (err) {
    // Fire-and-forget. Cost tracking must never fail an audit.
    console.error("[aiUsage] failed to record:", err.message);
  }
};
