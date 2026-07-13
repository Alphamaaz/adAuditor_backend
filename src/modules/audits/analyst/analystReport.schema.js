/**
 * AI Analyst — output contract. (spec: docs/AI_ANALYST_SPEC.md §3.3)
 *
 * The load-bearing idea: the model never states a bare number. Every figure
 * carries a `compute` spec — which table, which rows, which operation — so
 * analystVerification.service.js can recompute it from the dataset with plain
 * arithmetic. A figure that can't be recomputed never reaches the report.
 *
 * `kind` labels feed the money discipline:
 *   recoverable — waste that stopping/fixing recovers (enters money math)
 *   risk        — exposure if something changes (advisory only)
 *   target      — a goal/benchmark value (advisory only)
 *   observation — a measured fact (advisory only)
 */

export const ANALYST_SCHEMA_VERSION = 2;

const figureSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "kind", "value", "compute"],
  properties: {
    label: { type: "string", description: "What this number is, e.g. 'Wasted spend on Display placements'." },
    kind: { type: "string", enum: ["recoverable", "risk", "target", "observation"] },
    value: { type: "number", description: "The figure. Money values in the account currency, rates in percent." },
    compute: {
      type: "object",
      additionalProperties: false,
      required: [
        "op",
        "platform",
        "table",
        "rows",
        "metric",
        "numerator",
        "denominator",
        "scale",
        "referenceCpa",
        "formula",
      ],
      properties: {
        op: {
          type: "string",
          enum: ["raw", "sum", "ratio", "share", "excess_spend", "estimate"],
          description:
            "raw: one row's field. sum: metric over rows. ratio: numerator/denominator over rows × scale (CPA=spend/conversions scale 1; CTR=clicks/impressions scale 100; CPM=spend/impressions scale 1000; CVR=conversions/clicks scale 100). share: sum(metric,rows)/sum(metric,ALL) × 100. excess_spend: sum(spend,rows) − sum(conversions,rows) × referenceCpa. estimate: projection — NEVER for kind=recoverable.",
        },
        platform: {
          type: "string",
          enum: ["GOOGLE", "META", "TIKTOK", "NONE"],
          description: "Platform for the source table; use NONE only for estimate operations.",
        },
        table: {
          type: "string",
          description: "Table key exactly as printed; use an empty string only for estimate operations.",
        },
        rows: {
          type: "array",
          items: { type: "string" },
          description: "Stable rowRef values exactly as printed in the table, or [\"ALL\"] for every row. Do not use display names when a rowRef is available.",
        },
        metric: { type: "string", description: "Field name for raw/sum/share; otherwise an empty string." },
        numerator: { type: "string", description: "Ratio numerator field; otherwise an empty string." },
        denominator: { type: "string", description: "Ratio denominator field; otherwise an empty string." },
        scale: { type: "number", description: "Ratio multiplier (1, 100, or 1000); otherwise 0." },
        referenceCpa: { type: "number", description: "excess_spend reference CPA; otherwise 0." },
        formula: { type: "string", description: "Estimate formula; otherwise an empty string." },
      },
    },
  },
};

export const analystReportJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "executiveSummary",
    "executiveFigures",
    "rootCause",
    "rootCauseFigures",
    "findings",
    "campaignDeepDives",
    "ruleFindingDispositions",
    "recommendations",
  ],
  properties: {
    executiveSummary: {
      type: "string",
      description: "4–8 sentences. The account's real story: what is working, what is broken, the single biggest lever, in plain confident language.",
    },
    executiveFigures: {
      type: "array",
      items: figureSchema,
      description: "Compute specs supporting every number used in executiveSummary.",
    },
    rootCause: {
      type: "string",
      description: "2–5 sentences naming the structural root cause behind the biggest problems (not a symptom list).",
    },
    rootCauseFigures: {
      type: "array",
      items: figureSchema,
      description: "Compute specs supporting every number used in rootCause.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "severity",
          "category",
          "campaignRefs",
          "entityRefs",
          "claim",
          "figures",
          "recommendation",
          "confidence",
        ],
        properties: {
          id: { type: "string", description: "Stable slug, e.g. 'AN-BUDGET-CONCENTRATION'." },
          title: { type: "string" },
          severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
          category: { type: "string", description: "One of: tracking, structure, budget, bidding, creative, audience, keywords, placement, measurement, opportunity." },
          campaignRefs: {
            type: "array",
            items: { type: "string" },
            description: "Campaign names this finding is about, exactly as printed in the data.",
          },
          entityRefs: {
            type: "array",
            items: { type: "string" },
            description: "Stable rowRef values for the rows this finding concerns.",
          },
          claim: { type: "string", description: "The finding itself — specific, quantified, tied to named campaigns/rows." },
          figures: { type: "array", items: figureSchema },
          recommendation: { type: "string", description: "The concrete fix: exact setting, budget amount, or structural change." },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
    campaignDeepDives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["campaignName", "campaignRef", "verdict", "diagnosis", "actions", "figures"],
        properties: {
          campaignName: { type: "string", description: "Exactly as printed in the campaign table." },
          campaignRef: { type: "string", description: "Campaign rowRef exactly as printed, or an empty string when unavailable." },
          verdict: { type: "string", enum: ["scale", "keep", "fix", "pause", "verify-tracking"] },
          diagnosis: { type: "string", description: "2–5 sentences: what the numbers say about THIS campaign and why." },
          actions: { type: "array", items: { type: "string" } },
          figures: { type: "array", items: figureSchema },
        },
      },
    },
    ruleFindingDispositions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ruleId", "disposition", "note", "mergedIntoFindingId", "figures"],
        properties: {
          ruleId: { type: "string" },
          disposition: { type: "string", enum: ["confirmed", "refuted", "merged"] },
          note: { type: "string", description: "Data-backed reason when refuted; otherwise an empty string." },
          mergedIntoFindingId: { type: "string", description: "Analyst finding id when merged; otherwise an empty string." },
          figures: { type: "array", items: figureSchema },
        },
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "action", "expectedImpact", "figures"],
        properties: {
          priority: { type: "integer" },
          action: { type: "string", description: "Imperative, concrete, with exact values." },
          expectedImpact: { type: "string" },
          figures: { type: "array", items: figureSchema },
        },
      },
    },
  },
};

const factIdList = {
  type: "array",
  items: { type: "string" },
  description: "IDs from the top-level facts array that support every number in this object.",
};

const providerFactSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "label", "kind", "value", "op", "platform", "table", "rows",
    "metric", "numerator", "denominator", "scale", "referenceCpa", "formula",
  ],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    kind: { type: "string", enum: ["recoverable", "risk", "target", "observation"] },
    value: { type: "number" },
    op: {
      type: "string",
      enum: ["raw", "sum", "ratio", "share", "excess_spend", "estimate"],
      description: "raw=one row field; sum=metric total; ratio=numerator/denominator times scale; share=sum(rows)/sum(ALL) times 100 and therefore returns 0-100, never 0-1; excess_spend=spend minus conversions times referenceCpa; estimate is never recoverable.",
    },
    platform: { type: "string", enum: ["GOOGLE", "META", "TIKTOK", "NONE"] },
    table: { type: "string" },
    rows: { type: "array", items: { type: "string" }, description: "FULL rowRef values copied exactly, or ALL." },
    metric: { type: "string" },
    numerator: { type: "string" },
    denominator: { type: "string" },
    scale: { type: "number" },
    referenceCpa: { type: "number" },
    formula: { type: "string" },
  },
};

/** Repair-turn contract: ONLY additional facts, nothing else. */
export const analystFactsPatchJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: { type: "array", items: providerFactSchema },
  },
};

/** Provider fact → internal figure shape (single source for both expansion paths). */
export const expandProviderFact = (fact) => ({
  label: fact.label,
  kind: fact.kind,
  value: fact.value,
  compute: {
    op: fact.op,
    platform: fact.platform === "NONE" ? undefined : fact.platform,
    table: fact.table || undefined,
    rows: fact.rows,
    metric: fact.metric || undefined,
    numerator: fact.numerator || undefined,
    denominator: fact.denominator || undefined,
    scale: fact.scale || undefined,
    referenceCpa: fact.referenceCpa || undefined,
    formula: fact.formula || undefined,
  },
});

/**
 * Compact provider contract. The full compute object appears once in `facts`
 * and report sections reference facts by ID. This avoids an exponentially
 * large constrained-decoding grammar while expanding to the existing internal
 * report shape before verification.
 */
export const analystProviderJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "executiveSummary",
    "executiveFactIds",
    "rootCause",
    "rootCauseFactIds",
    "facts",
    "findings",
    "campaignDeepDives",
    "ruleFindingDispositions",
    "recommendations",
  ],
  properties: {
    executiveSummary: { type: "string" },
    executiveFactIds: factIdList,
    rootCause: { type: "string" },
    rootCauseFactIds: factIdList,
    facts: {
      type: "array",
      items: providerFactSchema,
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id", "title", "severity", "category", "campaignRefs", "entityRefs",
          "claim", "factIds", "recommendation", "confidence",
        ],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
          category: { type: "string" },
          campaignRefs: { type: "array", items: { type: "string" } },
          entityRefs: { type: "array", items: { type: "string" } },
          claim: { type: "string" },
          factIds: factIdList,
          recommendation: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
    campaignDeepDives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["campaignName", "campaignRef", "verdict", "diagnosis", "actions", "factIds"],
        properties: {
          campaignName: { type: "string" },
          campaignRef: { type: "string" },
          verdict: { type: "string", enum: ["scale", "keep", "fix", "pause", "verify-tracking"] },
          diagnosis: { type: "string" },
          actions: { type: "array", items: { type: "string" } },
          factIds: factIdList,
        },
      },
    },
    ruleFindingDispositions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ruleId", "disposition", "note", "mergedIntoFindingId", "factIds"],
        properties: {
          ruleId: { type: "string" },
          disposition: { type: "string", enum: ["confirmed", "refuted", "merged"] },
          note: { type: "string" },
          mergedIntoFindingId: { type: "string" },
          factIds: factIdList,
        },
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "action", "expectedImpact", "factIds"],
        properties: {
          priority: { type: "integer" },
          action: { type: "string" },
          expectedImpact: { type: "string" },
          factIds: factIdList,
        },
      },
    },
  },
};

export const expandAnalystProviderReport = (providerReport) => {
  // Injectable tests and offline scripts may still provide the internal shape.
  if (!Array.isArray(providerReport?.facts) && Array.isArray(providerReport?.executiveFigures)) {
    return providerReport;
  }
  const facts = new Map();
  for (const fact of providerReport?.facts || []) {
    if (!fact?.id || facts.has(fact.id)) {
      throw new Error(`invalid or duplicate analyst fact id: ${fact?.id || "(empty)"}`);
    }
    facts.set(fact.id, expandProviderFact(fact));
  }
  const resolveFacts = (ids, path) =>
    (ids || []).map((id) => {
      const fact = facts.get(id);
      if (!fact) throw new Error(`${path} references unknown fact id: ${id}`);
      return structuredClone(fact);
    });
  const withFigures = (items, path) =>
    (items || []).map(({ factIds, ...item }, index) => ({
      ...item,
      figures: resolveFacts(factIds, `${path}[${index}]`),
    }));

  return {
    executiveSummary: providerReport.executiveSummary,
    executiveFigures: resolveFacts(providerReport.executiveFactIds, "executiveFactIds"),
    rootCause: providerReport.rootCause,
    rootCauseFigures: resolveFacts(providerReport.rootCauseFactIds, "rootCauseFactIds"),
    findings: withFigures(providerReport.findings, "findings"),
    campaignDeepDives: withFigures(providerReport.campaignDeepDives, "campaignDeepDives"),
    ruleFindingDispositions: withFigures(
      providerReport.ruleFindingDispositions,
      "ruleFindingDispositions"
    ),
    recommendations: withFigures(providerReport.recommendations, "recommendations"),
  };
};

/** Count object properties omitted from `required` across a provider schema. */
export const countOptionalProperties = (schema) => {
  if (!schema || typeof schema !== "object") return 0;
  let count = 0;
  if (schema.properties && typeof schema.properties === "object") {
    const required = new Set(schema.required || []);
    count += Object.keys(schema.properties).filter((key) => !required.has(key)).length;
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      count += value.reduce((sum, item) => sum + countOptionalProperties(item), 0);
    } else if (value && typeof value === "object") {
      count += countOptionalProperties(value);
    }
  }
  return count;
};

/** Count `type: [...]` and composition unions that increase grammar complexity. */
export const countUnionTypes = (schema) => {
  if (!schema || typeof schema !== "object") return 0;
  let count = Array.isArray(schema.type) && schema.type.length > 1 ? 1 : 0;
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key]) && schema[key].length > 1) count += 1;
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      count += value.reduce((sum, item) => sum + countUnionTypes(item), 0);
    } else if (value && typeof value === "object") {
      count += countUnionTypes(value);
    }
  }
  return count;
};

/**
 * Light structural validation on top of the API's schema enforcement —
 * defense in depth for provider quirks and for unit tests that bypass the API.
 * Returns { valid, errors } and never throws.
 */
export const validateAnalystReport = (report) => {
  const errors = [];
  const push = (msg) => errors.push(msg);
  const validateFigures = (figures, path) => {
    if (!Array.isArray(figures)) {
      push(`${path} missing`);
      return;
    }
    figures.forEach((fig, index) => {
      if (typeof fig?.value !== "number" || !Number.isFinite(fig.value)) {
        push(`${path}[${index}] non-numeric value`);
      }
      if (!fig?.compute?.op) push(`${path}[${index}] missing compute.op`);
      if (!["recoverable", "risk", "target", "observation"].includes(fig?.kind)) {
        push(`${path}[${index}] invalid kind`);
      }
    });
  };
  if (!report || typeof report !== "object") {
    return { valid: false, errors: ["report is not an object"] };
  }
  if (typeof report.executiveSummary !== "string" || report.executiveSummary.length < 40) {
    push("executiveSummary missing or too short");
  }
  if (typeof report.rootCause !== "string" || report.rootCause.length < 20) {
    push("rootCause missing or too short");
  }
  validateFigures(report.executiveFigures, "executiveFigures");
  validateFigures(report.rootCauseFigures, "rootCauseFigures");
  if (!Array.isArray(report.findings) || report.findings.length === 0) {
    push("findings missing or empty");
  } else {
    report.findings.forEach((f, i) => {
      if (!f?.title || !f?.claim) push(`findings[${i}] missing title/claim`);
      if (!["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(f?.severity)) {
        push(`findings[${i}] invalid severity`);
      }
      validateFigures(f?.figures, `findings[${i}].figures`);
    });
  }
  if (!Array.isArray(report.campaignDeepDives)) push("campaignDeepDives missing");
  else report.campaignDeepDives.forEach((d, i) => validateFigures(d?.figures, `campaignDeepDives[${i}].figures`));
  if (!Array.isArray(report.ruleFindingDispositions)) push("ruleFindingDispositions missing");
  else report.ruleFindingDispositions.forEach((d, i) => validateFigures(d?.figures, `ruleFindingDispositions[${i}].figures`));
  if (!Array.isArray(report.recommendations) || report.recommendations.length === 0) {
    push("recommendations missing or empty");
  } else report.recommendations.forEach((r, i) => validateFigures(r?.figures, `recommendations[${i}].figures`));
  return { valid: errors.length === 0, errors };
};
