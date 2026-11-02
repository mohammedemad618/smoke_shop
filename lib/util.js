// Round to 2 decimals so totals like 0.1 + 0.2 don't drift
export const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
