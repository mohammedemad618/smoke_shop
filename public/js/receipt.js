// The receipt: what it shows (the cashier after a sale, and the preview on the settings
// page, from the same function) and how it is printed. A receipt is printed from a block of
// its own at the end of the page (.print-area), alone on paper (style.css): an 80 mm roll
// prints it 72 mm wide and a 58 mm roll 48 mm, on a page exactly as long as the receipt, so
// the printer feeds no blank paper; an A4 sheet has margins and as many pages as it needs.
// The page size goes into the page's own stylesheet through CSSOM, which the shop's
// Content-Security-Policy allows (no inline style). Text goes in through escapeHtml only;
// the logo is a data: URL the server checked (lib/logo.js).
import { formatMoney, formatQty, formatWeight, formatDateTime, escapeHtml, packName } from './common.js';

// The paper choices of the settings (models/Setting.js RECEIPT_PAPERS), with the roll's width
export const PAPERS = Object.freeze({
  80: Object.freeze({ label: '80 مم', width: 80 }),
  58: Object.freeze({ label: '58 مم', width: 58 }),
  a4: Object.freeze({ label: 'A4', width: null }),
});
export const paperOf = (value) => (Object.hasOwn(PAPERS, value) ? value : '80');

// "9,000 للعلبة (10 قطع)", "1,000 للكيلو", "250 للقطعة"
function receiptPrice(item) {
  const price = `<span class="num">${formatMoney(item.unitPrice)}</span>`;
  if (item.mode === 'wholesale') return `${price} لل${packName(item.unit, item.packSize)}`;
  return `${price} ${item.unit === 'kg' ? 'للكيلو' : 'للقطعة'}`;
}

// An amount with the shop's currency after it, when it has one
const amount = (n, currency) =>
  `<span class="num">${formatMoney(n)}</span>${currency ? ` <span class="slip-currency">${escapeHtml(currency)}</span>` : ''}`;

/*
 * The receipt of `sale` (as POST /api/sales answers it) for the shop `shop` (GET /api/shop:
 * its name, phone, address and note, what to show, the currency), with its logo (a data:
 * URL, or '' for none). An invoice from before sales recorded who made them has no seller
 * to show.
 */
export function receiptHtml(sale, shop, logo = '') {
  const head = [
    logo ? `<img class="slip-logo" src="${escapeHtml(logo)}" alt="">` : '',
    `<strong>${escapeHtml(shop.shopName || 'نقطة البيع')}</strong>`,
    shop.receiptShowAddress && shop.address ? `<span>${escapeHtml(shop.address)}</span>` : '',
    shop.receiptShowPhone && shop.phone ? `<span class="num">${escapeHtml(shop.phone)}</span>` : '',
    `<span>فاتورة رقم <span class="num">${escapeHtml(sale.number)}</span></span>`,
    `<span>${formatDateTime(sale.createdAt)}</span>`,
    shop.receiptShowCashier && sale.madeBy?.name ? `<span>البائع: ${escapeHtml(sale.madeBy.name)}</span>` : '',
  ];
  const lines = sale.items
    .map(
      (i) => `<tr>
          <td>${escapeHtml(i.name)}<small>${receiptPrice(i)}</small></td>
          <td class="end num">${i.unit === 'kg' && i.mode !== 'wholesale' ? formatWeight(i.quantity) : formatQty(i.quantity)}</td>
          <td class="end num">${formatMoney(i.lineTotal)}</td>
        </tr>`,
    )
    .join('');
  const payment =
    sale.paymentType === 'credit'
      ? `<div><dt>بالدين على</dt><dd>${escapeHtml(sale.customerName)}</dd></div>
        <div><dt>المدفوع الآن</dt><dd class="num">${formatMoney(sale.paid)}</dd></div>
        <div><dt>أُضيف إلى الدين</dt><dd class="num">${formatMoney(sale.debt)}</dd></div>
        <div><dt>مجموع دينه الآن</dt><dd class="num">${formatMoney(sale.customerBalance)}</dd></div>`
      : `<div><dt>المدفوع</dt><dd class="num">${formatMoney(sale.paid)}</dd></div>
        <div><dt>الباقي</dt><dd class="num">${formatMoney(sale.change)}</dd></div>`;
  return `<div class="slip">
    <div class="slip-head">${head.join('')}</div>
    <table class="slip-items">
      <thead><tr><th>الصنف</th><th class="end">الكمية</th><th class="end">المبلغ</th></tr></thead>
      <tbody>${lines}</tbody>
    </table>
    <dl class="slip-sum">
      <div class="grand"><dt>الإجمالي</dt><dd>${amount(sale.total, shop.currency)}</dd></div>
      ${payment}
    </dl>
    <p class="slip-foot">${escapeHtml(shop.receiptNote || 'شكرًا لزيارتكم')}</p>
  </div>`;
}

/* Printing */

let area = null;
let pageRule = null;
let preparing = Promise.resolve();
let ready = false;
// Which receipt is the last one asked for: an older one still loading gives way
let latest = 0;

function printArea() {
  if (!area) {
    area = document.createElement('div');
    area.className = 'print-area';
    area.setAttribute('aria-hidden', 'true');
    document.body.append(area);
  }
  return area;
}

// The @page rule of the receipt in style.css, replacing the one set for the last receipt.
// Left as it is if the stylesheet cannot be reached: the print window's own paper then.
function setPage(text) {
  const sheet = [...document.styleSheets].find((s) => s.href && new URL(s.href).pathname === '/css/style.css');
  if (!sheet) return;
  try {
    const old = pageRule ? [...sheet.cssRules].indexOf(pageRule) : -1;
    if (old >= 0) sheet.deleteRule(old);
    pageRule = sheet.cssRules[sheet.insertRule(text, sheet.cssRules.length)];
  } catch {
    pageRule = null;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// An image loaded (or failed): data: URLs load at once
const loaded = (img) =>
  img.complete
    ? Promise.resolve()
    : new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });

// The printed receipt's height in millimetres, laid out at its roll's width out of sight
function heightMm(el) {
  el.classList.add('is-measuring');
  const px = el.getBoundingClientRect().height;
  el.classList.remove('is-measuring');
  return Math.ceil((px * 25.4) / 96);
}

async function prepare(html, paper) {
  const mine = ++latest;
  const el = printArea();
  el.dataset.paper = paper;
  el.innerHTML = html;
  document.body.classList.add('printing');
  // The logo and the font loaded first, or the length measured would be short; never more
  // than 2 seconds, so a font that does not come (offline) does not hold the receipt
  heightMm(el);
  await Promise.race([Promise.all([document.fonts?.ready, ...[...el.querySelectorAll('img')].map(loaded)]), wait(2000)]);
  if (mine !== latest) return; // another receipt took its place meanwhile
  // A little paper after the last line, which a roll's cutter needs anyway
  setPage(paper === 'a4' ? '@page { size: A4 portrait; margin: 12mm; }' : `@page { size: ${PAPERS[paper].width}mm ${heightMm(el) + 3}mm; margin: 0; }`);
}

// Gets `html` ready to print on `paper` ('80', '58' or 'a4'): the print window, opened by
// the button or by the keyboard (Ctrl+P), then prints it alone
export function prepareReceipt(html, paper) {
  ready = false;
  const current = prepare(html, paperOf(paper)).finally(() => {
    if (preparing === current) ready = true;
  });
  preparing = current;
  return current;
}

// Opens the print window for the receipt prepared last, at once when it is ready (still in
// the click that asked for it), otherwise once it is, unless it was closed or replaced
// meanwhile: never the page itself instead of the receipt
export async function printPrepared() {
  if (!ready) {
    const asked = latest;
    await preparing.catch(() => {});
    if (asked !== latest || !area?.childElementCount) return;
  }
  window.print();
}

export async function printReceipt(html, paper) {
  prepareReceipt(html, paper);
  await printPrepared();
}

// Nothing to print any more (the receipt window closed): the page prints as itself again,
// on the print window's own paper (the receipt's @page rule goes too)
export function clearReceipt() {
  latest += 1;
  document.body.classList.remove('printing');
  area?.replaceChildren();
  const sheet = pageRule?.parentStyleSheet;
  try {
    const old = sheet ? [...sheet.cssRules].indexOf(pageRule) : -1;
    if (old >= 0) sheet.deleteRule(old);
  } catch {
    // the stylesheet cannot be reached: nothing was set in it
  }
  pageRule = null;
}
