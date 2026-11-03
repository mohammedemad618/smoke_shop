import { Schema } from 'mongoose';

const validTimeZone = (value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

// The shop's own settings, in one document with _id 'shop'. The name and the note show on
// the receipt and in the header; the time zone and the currency are display defaults only
// (days are still cut at the browser's midnight, as audited).
const settingSchema = new Schema(
  {
    _id: { type: String, default: 'shop' },
    shopName: { type: String, trim: true, maxlength: [60, 'اسم المتجر طويل جدًا'], default: '' },
    receiptNote: { type: String, trim: true, maxlength: [120, 'ملاحظة الإيصال طويلة جدًا'], default: '' },
    timeZone: {
      type: String,
      trim: true,
      default: 'Asia/Baghdad',
      validate: { validator: validTimeZone, message: 'المنطقة الزمنية غير صالحة' },
    },
    currency: { type: String, trim: true, maxlength: [10, 'اسم العملة طويل جدًا'], default: 'د.ع' },
    phone: { type: String, trim: true, maxlength: [30, 'رقم الهاتف طويل جدًا'], default: '' },
    address: { type: String, trim: true, maxlength: [120, 'عنوان المحل طويل جدًا'], default: '' },
  },
  { timestamps: true, versionKey: false },
);

export default settingSchema;
