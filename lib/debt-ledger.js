import { REPORT_MS } from './limits.js';
import { money } from './util.js';

// Apply payments oldest first. A return settles its own invoice first, and an
// advance contributes to sales collection when a later credit sale uses it.
export async function replayDebts(DebtEntry, end, { customers, onCollected, onPayment } = {}) {
  const filter = { date: { $lt: end }, ...(customers ? { customer: { $in: customers } } : {}) };
  const entries = await DebtEntry.find(filter).select('customer date kind sale amount')
    .sort({ customer: 1, date: 1, createdAt: 1, _id: 1 }).maxTimeMS(REPORT_MS).lean();
  let customer = null;
  let open = [];
  let ahead = 0;
  let balance = 0;
  for (const entry of entries) {
    if (String(entry.customer) !== customer) {
      customer = String(entry.customer);
      open = [];
      ahead = 0;
      balance = 0;
    }
    balance = money(balance + entry.amount);
    if (entry.amount > 0) {
      const used = Math.min(ahead, entry.amount);
      ahead = money(ahead - used);
      if (used > 0 && entry.kind === 'sale') onCollected?.(entry.date, used);
      const left = money(entry.amount - used);
      if (left > 0) open.push({ kind: entry.kind, sale: String(entry.sale ?? ''), left });
      continue;
    }
    let rest = -entry.amount;
    let appliedToSales = 0;
    const ownFirst = entry.kind === 'return'
      ? [...open].sort((a, b) => (b.sale === String(entry.sale)) - (a.sale === String(entry.sale)))
      : open;
    for (const debt of ownFirst) {
      if (rest <= 0) break;
      const used = Math.min(debt.left, rest);
      debt.left = money(debt.left - used);
      rest = money(rest - used);
      if (entry.kind === 'payment' && debt.kind === 'sale') appliedToSales = money(appliedToSales + used);
    }
    open = open.filter((debt) => debt.left > 0);
    ahead = money(ahead + rest);
    if (entry.kind === 'payment') {
      if (appliedToSales > 0) onCollected?.(entry.date, appliedToSales);
      onPayment?.(entry, {
        appliedToSales,
        appliedToOtherDebt: money(-entry.amount - rest - appliedToSales),
        advance: rest,
        balanceAfter: balance,
      });
    }
  }
}

export async function collectedEvents(DebtEntry, end) {
  const events = [];
  await replayDebts(DebtEntry, end, { onCollected: (date, amount) => events.push({ date, amount }) });
  return events;
}
