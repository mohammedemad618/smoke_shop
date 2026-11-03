// A shop's data as CSV (lib/csv.js), for its owner (routes/export.js) and for the admin
// panel: the products, the sales by day of a period and the customers' debts. The sales use
// the very figures of the sales report (periodFigures), so the month's total row is the
// month on the sales page.
import { toCsv } from '../lib/csv.js';
import { money } from '../lib/util.js';
import { REPORT_MS } from '../lib/limits.js';
import { periodFigures, sumFigures } from '../routes/sales.js';

export const EXPORT_KINDS = Object.freeze(['products', 'sales', 'debts']);

const yesNo = (value) => (value ? 'نعم' : 'لا');

export async function productsCsv(models) {
  const products = await models.Product.find().collation({ locale: 'ar' }).sort({ name: 1 }).populate('category', 'name').maxTimeMS(REPORT_MS).lean();
  const headers = ['الاسم', 'الباركود', 'القسم', 'الوحدة', 'سعر الشراء', 'سعر البيع', 'الربح في الوحدة', 'تتبّع الكمية', 'الكمية في المخزن', 'حد التنبيه', 'سعر الجملة', 'كمية الجملة'];
  const rows = products.map((p) => [
    p.name,
    p.barcode,
    p.category?.name ?? '',
    p.unit === 'kg' ? 'كغم' : 'قطعة',
    p.purchasePrice,
    p.salePrice,
    money(p.salePrice - p.purchasePrice),
    yesNo(p.trackStock),
    p.trackStock ? p.stock : null,
    p.trackStock ? p.lowStockAlert : null,
    p.hasWholesale ? p.wholesalePrice : null,
    p.hasWholesale ? p.wholesaleQty : null,
  ]);
  return toCsv(headers, rows);
}

// One line a day of [start, end) in timeZone, then the period's total
export async function salesCsv(models, { start, end, timeZone }) {
  const periods = await periodFigures(models, start, end, 'day', timeZone);
  const sum = sumFigures(periods);
  const headers = ['اليوم', 'عدد الفواتير', 'القطع', 'المبيعات', 'التكلفة', 'الربح', 'المرتجعات', 'البيع بالدين', 'المصاريف', 'المسدد من ديون المبيعات', 'صافي الربح'];
  const line = (label, f) => [label, f.count, f.pieces, f.total, f.cost, f.profit, f.returns, f.credit, f.expenses, f.collected, f.netProfit];
  return toCsv(headers, [...periods.map((p) => line(p.key, p)), line('المجموع', sum)]);
}

export async function debtsCsv(models) {
  const [customers, balances] = await Promise.all([
    models.Customer.find().collation({ locale: 'ar' }).sort({ name: 1 }).maxTimeMS(REPORT_MS).lean(),
    models.DebtEntry.aggregate([{ $group: { _id: '$customer', balance: { $sum: '$amount' }, lastActivity: { $max: '$date' } } }]).option({ maxTimeMS: REPORT_MS }),
  ]);
  const byId = new Map(balances.map((b) => [String(b._id), b]));
  const headers = ['الزبون', 'الهاتف', 'الرصيد', 'الحالة', 'آخر حركة', 'ملاحظة'];
  const rows = customers.map((c) => {
    const b = byId.get(String(c._id));
    const balance = money(b?.balance ?? 0);
    const state = balance > 0 ? 'عليه دين' : balance < 0 ? 'له رصيد مدفوع مقدمًا' : 'لا شيء';
    return [c.name, c.phone, balance, state, b?.lastActivity ? new Date(b.lastActivity).toISOString().slice(0, 10) : '', c.note];
  });
  return toCsv(headers, rows);
}

export async function exportCsv(models, kind, range) {
  if (kind === 'products') return productsCsv(models);
  if (kind === 'sales') return salesCsv(models, range);
  return debtsCsv(models);
}
