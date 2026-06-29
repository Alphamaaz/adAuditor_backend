import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assessFinding, applyTrustLayer } from "./trustLayer.js";
import { reconcileRecoverable, RECOVERABLE_CAP_FRACTION } from "./recoverable.js";
import { runDeterministicAudit } from "../../modules/audits/auditEngine.service.js";

/**
 * The trust layer is the GENERAL gate that replaced per-account whack-a-mole.
 * These tests encode the universal invariants every account/platform must hold:
 *   - no finding asserts a recoverable figure from an attribution artifact;
 *   - overlapping slices of the same spend are counted ONCE — the report body
 *     (sum of per-finding net recoverable) equals the reconciled headline and
 *     never exceeds the spend cap (real accounts were claiming 60-141%).
 */

describe("assessFinding — single-finding verdicts", () => {
  const ctx = { META: { spend: 100000, conversions: 500 } };

  it("SUPPRESSES an implausible per-segment CPA (attribution artifact / Punjab class)", () => {
    const f = {
      ruleId: "SEG-WASTE-001",
      platform: "META",
      estimatedImpact: "PKR 49,000 in this segment is recoverable",
      evidence: { dimension: "region", segment: "Punjab", spend: 50000, conversions: 2, segmentCpa: 25000, baselineCpa: 200 },
    };
    expect(assessFinding(f, ctx).verdict).toBe("SUPPRESS");
  });

  it("SUPPRESSES a geo segment that holds the spend but not the conversions", () => {
    const f = {
      ruleId: "META-GEO-001",
      platform: "META",
      estimatedImpact: "PKR 40,000 is recoverable",
      // 45% of spend, ~1% of conversions → results dropped by the breakdown.
      evidence: { dimension: "region", segment: "Punjab", spend: 45000, conversions: 5, baselineCpa: 200, segmentCpa: 9000 },
    };
    expect(assessFinding(f, ctx).verdict).toBe("SUPPRESS");
  });

  it("SUPPRESSES a claim larger than the segment's own spend", () => {
    const f = {
      ruleId: "SEG-WASTE-001",
      platform: "META",
      estimatedImpact: "PKR 9,000 in this segment is recoverable",
      evidence: { dimension: "placement", segment: "x", spend: 1000, conversions: 0 },
    };
    expect(assessFinding(f, ctx).verdict).toBe("SUPPRESS");
  });

  it("SUPPRESSES a segment that IS the whole account (materiality)", () => {
    const f = {
      ruleId: "SEG-WASTE-001",
      platform: "META",
      estimatedImpact: "PKR 5,000 in this segment is recoverable",
      evidence: { dimension: "device", segment: "mobile app", spend: 99000, conversions: 480, segmentCpa: 206, baselineCpa: 200 },
    };
    expect(assessFinding(f, ctx).verdict).toBe("SUPPRESS");
  });

  it("HEDGES a thin-sample MEDIUM finding to DIRECTIONAL", () => {
    const f = {
      ruleId: "SEG-WASTE-001",
      platform: "META",
      severity: "MEDIUM",
      estimatedImpact: "PKR 600 in this segment is recoverable",
      evidence: { dimension: "placement", segment: "x", spend: 1500, conversions: 1, segmentCpa: 300, baselineCpa: 200, significant: false },
    };
    expect(assessFinding(f, ctx).verdict).toBe("DIRECTIONAL");
  });

  it("does NOT hedge a CRITICAL structural finding even on a thin rate sample", () => {
    const f = {
      ruleId: "CAMP-CPA-001",
      platform: "META",
      severity: "CRITICAL",
      estimatedImpact: "PKR 20,000 is recoverable",
      evidence: { worstEntity: "PK", spend: 25000, conversions: 2, significant: false },
    };
    expect(assessFinding(f, ctx).verdict).toBe("CONFIDENT");
  });

  it("passes a healthy, well-attributed finding through as CONFIDENT", () => {
    const f = {
      ruleId: "SEG-WASTE-001",
      platform: "META",
      severity: "HIGH",
      estimatedImpact: "PKR 8,000 in this segment is recoverable",
      evidence: { dimension: "placement", segment: "facebook", spend: 30000, conversions: 100, segmentCpa: 300, baselineCpa: 200, significant: true },
    };
    expect(assessFinding(f, ctx).verdict).toBe("CONFIDENT");
  });
});

describe("applyTrustLayer — overlap reconciliation makes body == headline", () => {
  const dataset = { summary: { totals: { spend: 257696 }, platforms: { META: { spend: 257696, conversions: 5203 } } } };
  const findings = () => [
    { ruleId: "CAMP-CPA-001", platform: "META", severity: "HIGH", estimatedImpact: "PKR 120,977 is recoverable", evidence: { worstEntity: "Alt Testing | new cr", significant: true } },
    { ruleId: "SEG-WASTE-001", platform: "META", severity: "HIGH", estimatedImpact: "PKR 88,033 in this segment is recoverable", evidence: { dimension: "placement", segment: "facebook", spend: 158000, conversions: 1418, segmentCpa: 111, baselineCpa: 50, significant: true } },
    { ruleId: "SEG-WASTE-001", platform: "META", severity: "MEDIUM", estimatedImpact: "PKR 34,685 in this segment is recoverable", evidence: { dimension: "age", segment: "18-24", spend: 92000, conversions: 1173, segmentCpa: 79, baselineCpa: 50, significant: true } },
    { ruleId: "SEG-WASTE-001", platform: "META", severity: "MEDIUM", estimatedImpact: "PKR 9,000 is recoverable", evidence: { dimension: "day_of_week", segment: "Tuesday", spend: 7000, conversions: 27, segmentCpa: 60, baselineCpa: 50, significant: true } },
  ];

  it("assigns exactly one primary per overlapping pool and nets the rest to 0", () => {
    const kept = applyTrustLayer({ findings: findings(), dataset });
    const net = kept.map((f) => f.evidence.netRecoverable);
    const body = net.reduce((s, n) => s + n, 0);
    const { total: headline } = reconcileRecoverable(kept, { accountSpend: 257696 });
    expect(body).toBe(headline);
    // campaign 120,977 (primary) + Tuesday 9,000 (independent lever); placement &
    // age overlap the campaign pool → net 0.
    expect(body).toBeLessThanOrEqual(257696 * RECOVERABLE_CAP_FRACTION);
    const primaries = kept.filter((f) => f.evidence.trust.role === "primary");
    expect(primaries).toHaveLength(1);
    expect(primaries[0].ruleId).toBe("CAMP-CPA-001");
  });

  it("reframes overlapping findings so they no longer claim an additive dollar", () => {
    const kept = applyTrustLayer({ findings: findings(), dataset });
    const placement = kept.find((f) => f.evidence.segment === "facebook");
    expect(placement.evidence.trust.role).toBe("secondary");
    expect(placement.evidence.netRecoverable).toBe(0);
    expect(placement.estimatedImpact).toMatch(/already counts|same recovery|not additional/i);
  });
});

// ── Real-account regression corpus ────────────────────────────────────────────
// Anonymised/real audit snapshots exported from the DB live in ./scripts/corpus
// (see scripts/exportAudit.js). Replaying them through the live engine is how new
// client shapes stop slipping through. Skips cleanly when the corpus is absent
// (fresh checkout / CI without the data) so the suite never depends on it.
const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "../../../scripts/corpus");
const corpusFiles = existsSync(corpusDir)
  ? readdirSync(corpusDir).filter((f) => f.endsWith(".json"))
  : [];

describe.skipIf(corpusFiles.length === 0)("real-account corpus invariants", () => {
  for (const file of corpusFiles) {
    const audit = JSON.parse(readFileSync(join(corpusDir, file), "utf8"));
    if (!audit.normalizedDataset) continue;
    const spend = Number(audit.normalizedDataset.summary?.totals?.spend) || 0;

    describe(file.slice(0, 8), () => {
      const { findings } = runDeterministicAudit({ ...audit, normalizedDataset: audit.normalizedDataset });
      const recoverableFindings = findings.filter(
        (f) => f.evidence?.blocksDelivery !== true && f.evidence?.diagnostic !== true
      );
      const body = recoverableFindings.reduce((s, f) => s + (f.evidence?.netRecoverable || 0), 0);
      const { total: headline } = reconcileRecoverable(recoverableFindings, { accountSpend: spend });

      it("body (sum of per-finding net) equals the reconciled headline", () => {
        expect(Math.abs(body - headline)).toBeLessThanOrEqual(2);
      });

      it("never claims more than the spend cap is recoverable", () => {
        expect(body).toBeLessThanOrEqual(Math.round(spend * RECOVERABLE_CAP_FRACTION) + 2);
      });

      it("no surviving finding asserts an implausible per-segment CPA", () => {
        for (const f of findings) {
          const e = f.evidence || {};
          if (e.segmentCpa > 0 && e.baselineCpa > 0 && (e.netRecoverable || 0) > 0) {
            expect(e.segmentCpa).toBeLessThanOrEqual(e.baselineCpa * 12);
          }
        }
      });

      it("no finding's net recoverable exceeds its own segment spend", () => {
        for (const f of findings) {
          const e = f.evidence || {};
          if (Number.isFinite(e.spend) && e.spend > 0 && (e.netRecoverable || 0) > 0) {
            expect(e.netRecoverable).toBeLessThanOrEqual(e.spend * 1.05);
          }
        }
      });

      // A conversion-tracking anomaly, when present, must (a) be CRITICAL, (b) be
      // diagnostic so it never claims recoverable dollars, and (c) carry a trusted
      // baseline materially higher than the poisoned blended one.
      it("any tracking anomaly is CRITICAL, diagnostic, and re-baselines upward", () => {
        const anomalies = findings.filter((f) => f.ruleId === "TRACK-ANOMALY-001");
        for (const f of anomalies) {
          const e = f.evidence || {};
          expect(f.severity).toBe("CRITICAL");
          expect(e.diagnostic).toBe(true);
          expect(e.netRecoverable || 0).toBe(0);
          expect(e.trustedBaselineCpa).toBeGreaterThan(e.reportedBaselineCpa);
          expect(e.distortion).toBeGreaterThanOrEqual(1.3);
        }
      });
    });
  }
});
