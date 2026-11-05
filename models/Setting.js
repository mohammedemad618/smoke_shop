import { Schema } from 'mongoose';
import { logoProblem } from '../lib/logo.js';
import { LOW_STOCK_MAX, RECEIPT_PAPERS, ROUNDING_STEPS, SETTING_DEFAULTS } from '../lib/shop-settings.js';

const validTimeZone = (value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const D = SETTING_DEFAULTS;

// The shop's own settings, in one document with _id 'shop'. The name, phone, address, note
// and logo show on the receipt and the name in the header; the time zone and the currency
// are display defaults only (days are still cut at the browser's midnight, as audited, and
// the currency is a label next to totals, never part of a calculation). The defaults for a
// new product fill the product form; products already made keep their own values.
const settingSchema = new Schema(
  {
    _id: { type: String, default: 'shop' },
    shopName: { type: String, trim: true, maxlength: [60, 'اسم المتجر طويل جدًا'], default: D.shopName },
    receiptNote: { type: String, trim: true, maxlength: [120, 'ملاحظة الإيصال طويلة جدًا'], default: D.receiptNote },
    timeZone: {
      type: String,
      trim: true,
      default: D.timeZone,
      validate: { validator: validTimeZone, message: 'المنطقة الزمنية غير صالحة' },
    },
    currency: { type: String, trim: true, maxlength: [10, 'اسم العملة طويل جدًا'], default: D.currency },
    phone: { type: String, trim: true, maxlength: [30, 'رقم الهاتف طويل جدًا'], default: D.phone },
    address: { type: String, trim: true, maxlength: [120, 'عنوان المحل طويل جدًا'], default: D.address },

    // The receipt and its printing
    receiptPaper: { type: String, enum: { values: RECEIPT_PAPERS, message: 'مقاس الورق غير صالح' }, default: D.receiptPaper },
    // A small image at the top of the receipt, as a data: URL (lib/logo.js has the rules)
    receiptLogo: {
      type: String,
      default: D.receiptLogo,
      validate: { validator: (value) => !value || !logoProblem(value), message: 'صورة الشعار غير صالحة' },
    },
    receiptShowPhone: { type: Boolean, default: D.receiptShowPhone },
    receiptShowAddress: { type: Boolean, default: D.receiptShowAddress },
    // The name of whoever made the sale (sale.madeBy)
    receiptShowCashier: { type: Boolean, default: D.receiptShowCashier },
    // The print window opens by itself once after each completed sale
    autoPrint: { type: Boolean, default: D.autoPrint },

    // What a new product starts with in the product form
    defaultTrackStock: { type: Boolean, default: D.defaultTrackStock },
    defaultLowStockAlert: {
      type: Number,
      default: D.defaultLowStockAlert,
      min: [0, 'حد التنبيه لا يمكن أن يكون سالبًا'],
      max: [LOW_STOCK_MAX, `حد التنبيه لا يزيد على ${LOW_STOCK_MAX}`],
      validate: { validator: Number.isInteger, message: 'حد التنبيه يجب أن يكون عددًا صحيحًا' },
    },
    defaultBlockWhenOut: { type: Boolean, default: D.defaultBlockWhenOut },

    // «أصغر فئة نقدية»: every sale line from now on is rounded up to a multiple of it (0: as
    // priced). Each sale keeps the step it was made with (models/Sale.js), so changing it
    // never changes an invoice already made, nor what its returns give back.
    roundingStep: {
      type: Number,
      default: D.roundingStep,
      validate: { validator: (value) => ROUNDING_STEPS.includes(value), message: 'أصغر فئة نقدية غير صالحة' },
    },
  },
  { timestamps: true, versionKey: false },
);

export default settingSchema;
