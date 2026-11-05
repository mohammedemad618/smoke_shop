// The shop's settings (models/Setting.js) as plain data, for the schema and the routes
// alike. No side effects on import.

// What a shop has before its owner changes anything, and what a settings document from
// before a field existed reads as: the receipt and the product form as they always were
export const SETTING_DEFAULTS = Object.freeze({
  shopName: '',
  receiptNote: '',
  timeZone: 'Asia/Baghdad',
  currency: 'د.ع',
  phone: '',
  address: '',
  receiptPaper: '80',
  receiptLogo: '',
  receiptShowPhone: true,
  receiptShowAddress: true,
  receiptShowCashier: false,
  autoPrint: false,
  defaultTrackStock: true,
  defaultLowStockAlert: 5,
  defaultBlockWhenOut: false,
  // «أصغر فئة نقدية»: each sale line is rounded up to a multiple of it; 0 rounds nothing
  roundingStep: 0,
});

// The receipt's paper: an 80 mm or 58 mm roll, or an A4 sheet
export const RECEIPT_PAPERS = Object.freeze(['80', '58', 'a4']);
// The highest stock alert a new product can start with
export const LOW_STOCK_MAX = 100000;
// The smallest notes a shop can round its sale lines up to, 0 for no rounding
export const ROUNDING_STEPS = Object.freeze([0, 50, 100, 250, 500, 1000]);

// The step a shop's sales round to now, from its settings document (or a part of it)
export const roundingStepOf = (doc) => (ROUNDING_STEPS.includes(doc?.roundingStep) ? doc.roundingStep : 0);

// The settings as the pages read them: every field, a missing one at its default
export const settingsOf = (doc) => Object.fromEntries(Object.entries(SETTING_DEFAULTS).map(([key, value]) => [key, doc?.[key] ?? value]));
