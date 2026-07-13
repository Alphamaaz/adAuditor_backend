import { createHash } from "crypto";

const norm = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export const analystRowDisplayName = (row) =>
  row?.name ??
  row?.value ??
  row?.segment ??
  row?.keyword ??
  row?.searchTerm ??
  row?.campaignName ??
  row?.date ??
  null;

const identityEntries = (row) => {
  const idEntries = Object.entries(row || {})
    .filter(
      ([key, value]) =>
        value !== null &&
        value !== undefined &&
        value !== "" &&
        (key === "id" || /Id$|_id$/i.test(key))
    )
    .sort(([a], [b]) => a.localeCompare(b));
  if (idEntries.length > 0) return idEntries;

  const identityKeys = [
    "date",
    "name",
    "value",
    "segment",
    "keyword",
    "searchTerm",
    "campaignName",
    "adsetName",
    "adSetName",
    "adGroupName",
    "placement",
    "device",
    "age",
    "gender",
    "region",
    "country",
    "network",
    "dayOfWeek",
  ];
  return identityKeys
    .filter((key) => row?.[key] !== null && row?.[key] !== undefined && row?.[key] !== "")
    .map((key) => [key, row[key]]);
};

const baseIdentity = ({ platform, table, row }) =>
  JSON.stringify([
    norm(platform),
    norm(table),
    ...identityEntries(row).map(([key, value]) => [key, norm(value)]),
  ]);

const shortHash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

/**
 * Assign deterministic, compact references to every row in one source table.
 * Duplicate display names remain distinct. The occurrence counter is only a
 * fallback for rows with identical native identity; platform IDs win when
 * present. Call this before sorting so serializer and verifier agree.
 */
export const rowsWithAnalystRefs = ({ platform, table, rows }) => {
  const occurrences = new Map();
  return (rows || []).map((row) => {
    const identity = baseIdentity({ platform, table, row });
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    const digest = shortHash(`${identity}:${occurrence}`);
    return {
      row,
      rowRef: `${String(platform || "ANY").toUpperCase()}:${String(
        table || "row"
      ).toLowerCase()}:r_${digest}`,
    };
  });
};

export const isAnalystRowRef = (value) =>
  /^[A-Z]+:[a-z0-9_-]+:r_[a-f0-9]{12}$/i.test(String(value || ""));

