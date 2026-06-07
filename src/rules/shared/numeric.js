export const numberValue = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

export const sumSpend = (records) =>
  records.reduce((total, record) => total + numberValue(record.spend), 0);

export const sumImpressions = (records) =>
  records.reduce(
    (total, record) => total + numberValue(record.impressions),
    0
  );

export const sumClicks = (records) =>
  records.reduce((total, record) => total + numberValue(record.clicks), 0);

export const sumConversions = (records) =>
  records.reduce(
    (total, record) =>
      total + numberValue(record.conversions ?? record.results),
    0
  );
