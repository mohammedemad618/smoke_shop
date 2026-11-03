// How long one query may run, so a slow one cannot hold the shared pool for long: 5 s by
// default (models/index.js sets it on every query and aggregate), 15 s for the reports,
// which set it themselves with .maxTimeMS(REPORT_MS) or .option({ maxTimeMS: REPORT_MS }).
// Later phases add the per-shop limits on requests running at once.
export const QUERY_MS = 5000;
export const REPORT_MS = 15000;
