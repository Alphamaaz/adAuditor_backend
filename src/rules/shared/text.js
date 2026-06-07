export const toArray = (value) =>
  Array.isArray(value) ? value : value ? [value] : [];

export const text = (value) => String(value || "").toLowerCase();

export const includesAny = (value, terms) => {
  const values = toArray(value).map(text);
  return terms.some((term) =>
    values.some((valueItem) => valueItem.includes(term))
  );
};

// Word-boundary match — prevents "Do not know".includes("no") false positives.
// Use this instead of .includes("no") or includesAny([..., "no", ...]).
export const matchesWord = (value, terms) => {
  const values = toArray(value).map(text);
  return terms.some((term) =>
    values.some((v) => new RegExp(`\\b${term}\\b`, "i").test(v))
  );
};
