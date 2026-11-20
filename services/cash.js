import { REPORT_MS } from '../lib/limits.js';
import { SETTING_DEFAULTS } from '../lib/shop-settings.js';
import { money } from '../lib/util.js';

export const saleCash = { $subtract: ['$total', { $ifNull: ['$debt', 0] }] };
export const refundCash = (amount, credit) => ({ $subtract: [amount, { $ifNull: [credit, 0] }] });

export const cashAfter = (balance, { salesReceived, customerPayments, refunds, supplierPayments, expenses }) =>
  money(balance + salesReceived + customerPayments - refunds - supplierPayments - expenses);

// Supplier invoices store dated payments, including the initial payment. An older
// invoice can have only a paid total. Its undated part follows the invoice date.
const supplierPayments = {
  $concatArrays: [
    { $ifNull: ['$payments', []] },
    [{ date: '$date', amount: { $round: [{ $subtract: [{ $ifNull: ['$paid', 0] }, { $sum: '$payments.amount' }] }, 2] } }],
  ],
};

export async function cashMovement({ Sale, DebtEntry, Purchase, Expense, Setting }, start, end) {
  const throughEnd = { $lt: end };
  const amounts = async (model, date, amount, stages = []) => {
    const [row] = await model.aggregate([
      ...stages,
      { $match: { [date]: throughEnd } },
      {
        $group: {
          _id: null,
          before: { $sum: { $cond: [{ $lt: [`$${date}`, start] }, amount, 0] } },
          during: { $sum: { $cond: [{ $gte: [`$${date}`, start] }, amount, 0] } },
        },
      },
    ]).option({ maxTimeMS: REPORT_MS });
    return { before: money(row?.before ?? 0), during: money(row?.during ?? 0) };
  };

  const [sales, customers, refunds, suppliers, expenses, settings] = await Promise.all([
    amounts(Sale, 'createdAt', saleCash),
    amounts(DebtEntry, 'date', { $multiply: ['$amount', -1] }, [{ $match: { kind: 'payment' } }]),
    amounts(Sale, 'returns.at', refundCash('$returns.amount', '$returns.toAccount'), [
      { $match: { 'returns.at': throughEnd } },
      { $unwind: '$returns' },
    ]),
    // A cancelled invoice keeps its recorded payments to the supplier.
    amounts(Purchase, 'cashPayments.date', '$cashPayments.amount', [
      { $project: { cashPayments: supplierPayments } },
      { $unwind: '$cashPayments' },
    ]),
    amounts(Expense, 'date', '$amount'),
    Setting.findById('shop').select('openingCashBalance').lean(),
  ]);
  const flows = (point) => ({
    salesReceived: sales[point],
    customerPayments: customers[point],
    refunds: refunds[point],
    supplierPayments: suppliers[point],
    expenses: expenses[point],
  });
  const opening = settings?.openingCashBalance ?? SETTING_DEFAULTS.openingCashBalance;
  const openingBalance = cashAfter(opening, flows('before'));
  const movement = flows('during');
  return { openingBalance, ...movement, closingBalance: cashAfter(openingBalance, movement) };
}
