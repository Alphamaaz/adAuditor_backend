import { describe, it, expect } from "vitest";
import { selectDueAccounts } from "./reaudit.service.js";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 5, 22);

describe("selectDueAccounts", () => {
  const accounts = [
    { id: "never", monitoringEnabled: true, lastAutoAuditAt: null },
    { id: "old", monitoringEnabled: true, lastAutoAuditAt: new Date(now - 8 * DAY).toISOString() },
    { id: "recent", monitoringEnabled: true, lastAutoAuditAt: new Date(now - 2 * DAY).toISOString() },
    { id: "off", monitoringEnabled: false, lastAutoAuditAt: null },
  ];

  it("returns monitored accounts that are due (never audited or past the interval)", () => {
    const due = selectDueAccounts({ accounts, now, intervalMs: 7 * DAY }).map((a) => a.id);
    expect(due).toContain("never");
    expect(due).toContain("old");
    expect(due).not.toContain("recent"); // within the interval
    expect(due).not.toContain("off"); // monitoring disabled
  });

  it("excludes everything when none are monitored", () => {
    const due = selectDueAccounts({
      accounts: accounts.map((a) => ({ ...a, monitoringEnabled: false })),
      now,
      intervalMs: 7 * DAY,
    });
    expect(due).toEqual([]);
  });

  it("treats an unparseable timestamp as due", () => {
    const due = selectDueAccounts({
      accounts: [{ id: "bad", monitoringEnabled: true, lastAutoAuditAt: "not-a-date" }],
      now,
      intervalMs: 7 * DAY,
    });
    expect(due.map((a) => a.id)).toEqual(["bad"]);
  });
});
