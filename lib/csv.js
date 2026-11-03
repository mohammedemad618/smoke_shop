// CSV files that Excel opens with the Arabic intact: UTF-8 with a byte order mark (without
// it Excel reads the file as the local code page), CRLF line ends, every text field quoted.
// A text that starts like a formula (= + - @, a tab or a return) gets a leading apostrophe,
// so a product or customer name typed as "=HYPERLINK(...)" stays text when opened. Numbers
// are written as numbers.

const BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (value instanceof Date) return value.toISOString();
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(headers, rows) {
  return BOM + [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

// Sends a CSV as a download named `filename` (Latin letters, digits, . _ - only)
export function sendCsv(res, filename, text) {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${safe}"`, 'Cache-Control': 'no-store' });
  res.send(text);
}
