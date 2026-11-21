import { REPORT_MS } from './limits.js';
import { money } from './util.js';

// Payments settle the oldest debt. Returns settle their own invoice first.
// An existing advance reduces the next charge without another cash receipt.
export async function replayDebts(DebtEntry, end, { customers, onCharge, onReturn, onPayment } = {}) {
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
      onCharge?.(entry, used);
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
      if (debt.kind === 'sale') appliedToSales = money(appliedToSales + used);
    }
    open = open.filter((debt) => debt.left > 0);
    ahead = money(ahead + rest);
    const settled = entry.kind === 'payment' ? onPayment : onReturn;
    settled?.(entry, {
      appliedToSales,
      appliedToOtherDebt: money(-entry.amount - rest - appliedToSales),
      advance: rest,
      balanceAfter: balance,
    });
  }
}

export async function debtMovement(DebtEntry, start, end) {
  const debt = () => ({ opening: 0, added: 0, paid: 0, returns: 0, advanceUsed: 0, closing: 0 });
  const sales = debt();
  const manual = debt();
  const advances = { opening: 0, received: 0, returns: 0, used: 0, closing: 0 };
  let received = 0;
  function post(row, date, field, amount, direction) {
    if (!amount) return;
    row.closing = money(row.closing + direction * amount);
    if (date < start) row.opening = money(row.opening + direction * amount);
    else row[field] = money(row[field] + amount);
  }
  function settle(entry, parts) {
    const payment = entry.kind === 'payment';
    const field = payment ? 'paid' : 'returns';
    post(sales, entry.date, field, parts.appliedToSales, -1);
    post(manual, entry.date, field, parts.appliedToOtherDebt, -1);
    post(advances, entry.date, payment ? 'received' : 'returns', parts.advance, 1);
    if (payment && entry.date >= start) received = money(received - entry.amount);
  }
  await replayDebts(DebtEntry, end, {
    onCharge(entry, used) {
      const row = entry.kind === 'sale' ? sales : manual;
      post(row, entry.date, 'added', entry.amount, 1);
      post(row, entry.date, 'advanceUsed', used, -1);
      post(advances, entry.date, 'used', used, -1);
    },
    onReturn: settle,
    onPayment: settle,
  });
  return { sales, manual, advances, received };
}
