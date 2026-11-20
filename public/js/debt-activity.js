const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

export function debtActivity(lastActivity, now = Date.now()) {
  const date = Date.parse(lastActivity);
  if (!Number.isFinite(date)) return 'none';
  return now - date > THIRTY_DAYS ? 'stale' : 'recent';
}
