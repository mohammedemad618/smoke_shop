import mongoose from 'mongoose';

const FIELD_LABELS = {
  name: 'الاسم',
  barcode: 'الباركود',
  purchasePrice: 'سعر الشراء',
  salePrice: 'سعر البيع',
  category: 'القسم',
  stock: 'كمية المخزن',
  lowStockAlert: 'حد التنبيه',
};

const DUPLICATE_MESSAGES = {
  barcode: 'هذا الباركود مسجل لمنتج آخر',
  name: 'يوجد قسم بهذا الاسم',
};

export function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

function castMessage(err) {
  const label = FIELD_LABELS[err.path];
  return label ? `قيمة ${label} غير صالحة` : 'معرّف غير صالح';
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0];
    return res.status(409).json({ error: DUPLICATE_MESSAGES[field] ?? 'هذه القيمة مستخدمة من قبل' });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const first = Object.values(err.errors)[0];
    const message = first instanceof mongoose.Error.CastError ? castMessage(first) : first.message;
    return res.status(400).json({ error: message });
  }
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ error: castMessage(err) });
  }
  if (err instanceof mongoose.Error.VersionError) {
    return res.status(409).json({ error: 'تغيّرت الفاتورة في نفس اللحظة من مكان آخر. حدّث الصفحة وأعد المحاولة' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'البيانات المرسلة غير صالحة' });
  }
  if (err.expose && err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'حدث خطأ غير متوقع في الخادم' });
}
