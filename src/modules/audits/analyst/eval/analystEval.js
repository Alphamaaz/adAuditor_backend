const CURRENCY_CODES = [
  "USD", "PKR", "EUR", "GBP", "CAD", "AUD", "AED", "INR", "SAR",
  "QAR", "KWD", "SGD", "MYR", "THB", "PHP", "IDR", "BDT", "LKR",
  "NPR", "ZAR",
];

const STOP_WORDS = new Set([
  "about", "account", "after", "again", "against", "also", "because",
  "before", "being", "campaign", "campaigns", "could", "from", "have",
  "into", "more", "most", "should", "that", "their", "there", "these",
  "they", "this", "those", "through", "under", "using", "with", "would",
]);

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const clamp = (value) => Math.max(0, Math.min(1, value));
const ratio = (part, total, whenEmpty = 1) =>
  total > 0 ? clamp(part / total) : whenEmpty;

const words = (value) =>
  new Set(
    String(value || "")
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{2,}/g)
      ?.filter((word) => !STOP_WORDS.has(word)) || []
  );

const jaccard = (a, b) => {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter((item) => b.has(item)).length;
  return intersection / (a.size + b.size - intersection || 1);
};

const average = (values, fallback = 1) =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;

const pairs = (items) => {
  const result = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) result.push([items[i], items[j]]);
  }
  return result;
};

const figureLists = (report = {}) => [
  report.executiveFigures,
  report.rootCauseFigures,
  ...(report.findings || []).map((item) => item.figures),
  ...(report.campaignDeepDives || []).map((item) => item.figures),
  ...(report.recommendations || []).map((item) => item.figures),
  ...(report.ruleFindingDispositions || []).map((item) => item.figures),
];

const allFigures = (report) => figureLists(report).flatMap((list) => list || []);

const reportText = (report = {}) => {
  const strings = [];
  const visit = (value, key = "") => {
    if (typeof value === "string" && key !== "id" && key !== "ruleId") strings.push(value);
    else if (Array.isArray(value)) value.forEach((item) => visit(item, key));
    else if (value && typeof value === "object") {
      Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
    }
  };
  visit(report);
  return strings.join(" ");
};

export const currencyViolations = (report, expectedCurrency = "USD") => {
  const text = reportText(report);
  const expected = String(expectedCurrency || "USD").toUpperCase();
  const found = new Set(
    CURRENCY_CODES.filter((code) => new RegExp(`\\b${code}\\b`, "i").test(text))
  );
  if (/\$\s*\d/.test(text)) found.add("USD");
  if (/€\s*\d/.test(text)) found.add("EUR");
  if (/£\s*\d/.test(text)) found.add("GBP");
  return [...found]
    .filter((code) => code !== expected)
    .sort((a, b) => CURRENCY_CODES.indexOf(a) - CURRENCY_CODES.indexOf(b));
};

const unsupportedMoneyClaims = (verification = {}) => {
  const expected = String(verification?.serialization?.currency || "").toUpperCase();
  const moneyRx = new RegExp(
    `(?:\\b(?:${CURRENCY_CODES.join("|")})\\b|[$€£])\\s*[-+]?\\d`,
    "i"
  );
  const prose = (verification.droppedClaims || []).filter((item) =>
    moneyRx.test(item.sentence || "") ||
    (expected && new RegExp(`\\b${expected}\\b`, "i").test(item.sentence || ""))
  );
  const figures = (verification.droppedFigures || []).filter(
    (item) => item.kind === "recoverable"
  );
  return { prose, figures, count: prose.length + figures.length };
};

const rootCauseAlignment = (report, sourceFindings = []) => {
  const root = words(report.rootCause);
  const evidence = words(
    [
      ...(report.findings || []).flatMap((item) => [item.title, item.claim, item.category]),
      ...sourceFindings.flatMap((item) => [item.title, item.detail, item.rootCause, item.category]),
    ].join(" ")
  );
  if (root.size === 0) return 0;
  const supported = [...root].filter((word) => evidence.has(word)).length;
  return ratio(supported, root.size, 0);
};

const actionability = (report) => {
  // Vocabulary must cover what a strategist actually writes — the first live
  // pass scored real actions ("Reconcile the pixel", "Rebuild on OUTCOME_LEADS",
  // "Set a cost cap") as non-actionable and halved the dimension.
  const imperative = /\b(add|adjust|allocate|archive|build|cap|change|confirm|consolidate|create|delete|disable|enable|exclude|fix|fund|hold|increase|install|keep|launch|lower|merge|migrate|move|pause|protect|raise|reallocate|rebuild|reconcile|reduce|relaunch|remove|rename|restate|resubmit|retire|review|scale|separate|set|shift|split|standardize|switch|test|verify|weight)\b/i;
  const recommendations = report.recommendations || [];
  return ratio(
    recommendations.filter(
      (item) => imperative.test(item.action || "") && String(item.expectedImpact || "").length >= 15
    ).length,
    recommendations.length,
    0
  );
};

const evidenceCoverage = (report) => {
  const findings = report.findings || [];
  return ratio(
    findings.filter((finding) =>
      (finding.figures || []).some((figure) => figure.verified === true)
    ).length,
    findings.length,
    0
  );
};

const depthScore = (report) => {
  const findings = ratio((report.findings || []).length, 3, 0);
  const dives = ratio((report.campaignDeepDives || []).length, 2, 0);
  const recommendations = ratio((report.recommendations || []).length, 3, 0);
  return average([findings, dives, recommendations], 0);
};

const dispositionCoverage = (report, sourceFindings) => {
  const expected = new Set((sourceFindings || []).map((item) => item.ruleId).filter(Boolean));
  const present = new Set(
    (report.ruleFindingDispositions || []).map((item) => item.ruleId).filter(Boolean)
  );
  return ratio([...expected].filter((id) => present.has(id)).length, expected.size, 1);
};

export const gradeAnalystTrial = ({ audit, run, verified }) => {
  const report = verified?.report || {};
  const sourceFindings = audit?.ruleFindings || [];
  const expectedCurrency = run?.serialization?.currency || "USD";
  const figures = allFigures(report);
  const verifiable = figures.filter((figure) => figure?.compute?.op !== "estimate");
  const verifiedCount = verifiable.filter((figure) => figure.verified === true).length;
  const moneyFailures = unsupportedMoneyClaims({
    ...verified,
    serialization: run?.serialization,
  });
  const wrongCurrencies = currencyViolations(report, expectedCurrency);
  const unsafeScaleAttempts =
    num(verified?.stats?.deepDivesQuarantineFixed) +
    (report.findings || []).filter((finding) => finding.quarantineFlag).length;

  const dimensions = {
    figureIntegrity: ratio(
      num(verified?.stats?.figuresVerified),
      num(verified?.stats?.figuresTotal) - num(verified?.stats?.estimatesDemoted),
      0
    ),
    numericProseIntegrity: ratio(
      num(verified?.stats?.proseFieldsChecked) - num(verified?.stats?.proseSentencesDropped),
      num(verified?.stats?.proseFieldsChecked),
      1
    ),
    currencyIntegrity: wrongCurrencies.length === 0 ? 1 : 0,
    evidenceCoverage: evidenceCoverage(report),
    ruleCoverage: dispositionCoverage(report, sourceFindings),
    rootCauseAlignment: clamp(rootCauseAlignment(report, sourceFindings) / 0.25),
    actionability: actionability(report),
    depth: depthScore(report),
    safety: unsafeScaleAttempts === 0 ? 1 : 0,
  };

  const weights = {
    figureIntegrity: 0.2,
    numericProseIntegrity: 0.15,
    currencyIntegrity: 0.1,
    evidenceCoverage: 0.15,
    ruleCoverage: 0.1,
    rootCauseAlignment: 0.1,
    actionability: 0.08,
    depth: 0.07,
    safety: 0.05,
  };
  const total = Object.entries(weights).reduce(
    (sum, [key, weight]) => sum + dimensions[key] * weight,
    0
  );

  const hardFailures = [];
  if (wrongCurrencies.length > 0) hardFailures.push(`wrong_currency:${wrongCurrencies.join(",")}`);
  if (moneyFailures.count > 0) hardFailures.push(`unsupported_money:${moneyFailures.count}`);
  if (unsafeScaleAttempts > 0) hardFailures.push(`unsafe_scale:${unsafeScaleAttempts}`);
  if (verifiedCount === 0) hardFailures.push("no_verified_figures");
  if (dimensions.ruleCoverage < 1) hardFailures.push("missing_rule_dispositions");

  const warnings = [];
  if (dimensions.evidenceCoverage < 0.75) warnings.push("weak_finding_evidence_coverage");
  if (dimensions.rootCauseAlignment < 0.5) warnings.push("weak_root_cause_alignment");
  if (dimensions.depth < 0.6) warnings.push("thin_report");
  if (num(verified?.stats?.unsupportedNumericClaims) > 0) {
    warnings.push(`unsupported_numeric_claims:${verified.stats.unsupportedNumericClaims}`);
  }

  return {
    pass: hardFailures.length === 0 && total >= 0.8,
    total: Math.round(total * 1000) / 1000,
    dimensions,
    hardFailures,
    warnings,
    diagnostics: {
      expectedCurrency,
      wrongCurrencies,
      unsupportedMoneyClaims: moneyFailures.count,
      unsafeScaleAttempts,
      figuresVerifiable: verifiable.length,
      figuresVerified: verifiedCount,
      findings: (report.findings || []).length,
      campaignDeepDives: (report.campaignDeepDives || []).length,
      recommendations: (report.recommendations || []).length,
    },
  };
};

const findingSignature = (finding) => {
  const refs = [...(finding.entityRefs || []), ...(finding.campaignRefs || [])]
    .map((value) => String(value).toLowerCase())
    .sort();
  return `${String(finding.category || "unknown").toLowerCase()}|${refs.join("|")}|${String(
    finding.id || ""
  ).toLowerCase()}`;
};

const recoverableTotal = (report) =>
  (report.findings || []).reduce((sum, finding) => sum + num(finding.verifiedRecoverable), 0);

const relativeAgreement = (a, b) => {
  if (a === 0 && b === 0) return 1;
  return clamp(1 - Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1));
};

export const gradeAnalystConsistency = (trials) => {
  const completed = (trials || []).filter((trial) => trial?.verified?.report);
  if (completed.length < 2) {
    return {
      pass: completed.length === 1,
      trialCount: completed.length,
      dimensions: { findingAgreement: 1, rootCauseAgreement: 1, actionAgreement: 1, moneyAgreement: 1 },
      warnings: completed.length === 0 ? ["no_completed_trials"] : ["single_trial_no_stability_measure"],
    };
  }

  const comparisons = pairs(completed).map(([left, right]) => {
    const a = left.verified.report;
    const b = right.verified.report;
    return {
      findingAgreement: jaccard(
        new Set((a.findings || []).map(findingSignature)),
        new Set((b.findings || []).map(findingSignature))
      ),
      rootCauseAgreement: jaccard(words(a.rootCause), words(b.rootCause)),
      actionAgreement: jaccard(
        words((a.recommendations || []).map((item) => item.action).join(" ")),
        words((b.recommendations || []).map((item) => item.action).join(" "))
      ),
      moneyAgreement: relativeAgreement(recoverableTotal(a), recoverableTotal(b)),
    };
  });
  const dimensions = Object.fromEntries(
    Object.keys(comparisons[0]).map((key) => [
      key,
      Math.round(average(comparisons.map((item) => item[key])) * 1000) / 1000,
    ])
  );
  const warnings = [];
  if (dimensions.findingAgreement < 0.45) warnings.push("unstable_findings");
  if (dimensions.rootCauseAgreement < 0.2) warnings.push("unstable_root_cause");
  if (dimensions.actionAgreement < 0.2) warnings.push("unstable_recommendations");
  if (dimensions.moneyAgreement < 0.75) warnings.push("unstable_recoverable_money");
  return {
    pass: warnings.length === 0,
    trialCount: completed.length,
    dimensions,
    warnings,
  };
};

export const summarizeFixtureTrials = (trials) => {
  const grades = (trials || []).map((trial) => trial.grade).filter(Boolean);
  const passed = grades.filter((grade) => grade.pass).length;
  const consistency = gradeAnalystConsistency(trials);
  return {
    trialsRequested: trials.length,
    trialsCompleted: grades.length,
    trialsPassed: passed,
    passAtK: passed > 0,
    passPowK: grades.length === trials.length && passed === trials.length,
    averageScore: grades.length
      ? Math.round(average(grades.map((grade) => grade.total)) * 1000) / 1000
      : 0,
    consistency,
    pass:
      grades.length === trials.length &&
      passed === trials.length &&
      consistency.pass,
  };
};
