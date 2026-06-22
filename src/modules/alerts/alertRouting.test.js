import { describe, it, expect } from "vitest";
import { selectAlertRecipients } from "./alertRouting.js";

const members = [
  { userId: "owner", role: "OWNER", alertsEnabled: true, email: "owner@agency.com" },
  { userId: "mgrA", role: "MEMBER", alertsEnabled: true, email: "a@agency.com" },
  { userId: "mgrB", role: "MEMBER", alertsEnabled: true, email: "b@agency.com" },
  { userId: "muted", role: "OWNER", alertsEnabled: false, email: "muted@agency.com" },
];

describe("selectAlertRecipients — agency alert routing", () => {
  it("unassigned account → org OWNERs + the audit runner", () => {
    const out = selectAlertRecipients({ assigneeUserId: null, createdById: "mgrA", members });
    expect(out.sort()).toEqual(["a@agency.com", "owner@agency.com"].sort());
    // Members who aren't owners and didn't run it are NOT notified.
    expect(out).not.toContain("b@agency.com");
  });

  it("assigned account → only the assignee (+ runner), not the whole team", () => {
    const out = selectAlertRecipients({ assigneeUserId: "mgrB", createdById: "mgrA", members });
    expect(out.sort()).toEqual(["a@agency.com", "b@agency.com"].sort());
    // The owner does NOT get an assigned account's alert.
    expect(out).not.toContain("owner@agency.com");
  });

  it("respects a muted member even if they are the assignee", () => {
    const out = selectAlertRecipients({ assigneeUserId: "muted", createdById: null, members });
    expect(out).toEqual([]); // assignee muted, nobody else routed in
  });

  it("filters a muted owner out of the unassigned fallback", () => {
    const out = selectAlertRecipients({ assigneeUserId: null, createdById: null, members });
    expect(out).toEqual(["owner@agency.com"]); // the other owner is muted
  });

  it("dedupes when the assignee also ran the audit", () => {
    const out = selectAlertRecipients({ assigneeUserId: "mgrA", createdById: "mgrA", members });
    expect(out).toEqual(["a@agency.com"]);
  });
});
