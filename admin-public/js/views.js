// The admin panel's labels and the parts of its screens built from the server's data: a
// shop's row, a job's steps, an account, a session, a backup, an audit entry. Every value
// goes in through h() as text (dom.js), so a shop name such as <img src=x onerror=...> is
// shown as those characters and never becomes an element. No side effects on import.
import { h, formatAgo, formatBytes, formatDate, formatDateTime, formatNumber } from './dom.js';

export const STATUS_LABELS = Object.freeze({
  provisioning: 'قيد التجهيز',
  active: 'نشط',
  suspended: 'موقوف',
  pending_deletion: 'بانتظار الحذف',
  deleted: 'محذوف',
});

export const CERT_LABELS = Object.freeze({ none: 'لا توجد', pending: 'قيد الإصدار', issued: 'صادرة', failed: 'فشل الإصدار', retired: 'أُزيلت' });

export const JOB_LABELS = Object.freeze({
  provision: 'تجهيز المتجر',
  backup: 'نسخة احتياطية',
  restore: 'استعادة نسخة احتياطية',
  rename: 'تغيير العنوان',
  delete: 'حذف المتجر',
  purge: 'الحذف النهائي',
  cleanup: 'حذف قاعدة بيانات قديمة',
});

export const JOB_STATUS = Object.freeze({ queued: 'في الانتظار', running: 'جارٍ', done: 'تم', failed: 'فشل', cancelled: 'أُلغي' });

const STEP_LABELS = Object.freeze({
  host: 'حجز العنوان',
  database: 'قاعدة البيانات',
  indexes: 'الفهارس',
  settings: 'الإعدادات وقسم «عام»',
  owner: 'حساب المالك',
  dns: 'فحص DNS',
  certificate: 'شهادة الأمان',
  activate: 'جاهز',
  backup: 'نسخة احتياطية مُتحقَّق منها',
  pending: 'إغلاق المتجر 30 يومًا قبل الحذف',
  drop: 'حذف قاعدة البيانات',
  retire: 'إيقاف العناوين وإزالة الشهادات',
  deleted: 'محذوف',
  suspend: 'إيقاف المتجر أثناء الاستعادة',
  restore: 'الاستعادة إلى قاعدة جديدة',
  users: 'نسخ حسابات الدخول الحالية إليها',
  switch: 'التبديل إلى القاعدة المستعادة',
  resume: 'استئناف المتجر',
  forget: 'إزالتها من سجل المتجر',
});
const JOB_STEP_LABELS = Object.freeze({
  rename: { dns: 'فحص DNS للعنوان الجديد', certificate: 'شهادة أمان العنوان الجديد', switch: 'العنوان الجديد أساسي، والقديم يحوّل إليه 90 يومًا' },
  restore: { backup: 'نسخة من البيانات الحالية قبل الاستعادة' },
  purge: { backup: 'نسخة نهائية مُتحقَّق منها' },
});
export const stepLabel = (type, key) => JOB_STEP_LABELS[type]?.[key] ?? STEP_LABELS[key] ?? key;

export const BACKUP_KINDS = Object.freeze({ nightly: 'ليلية', manual: 'يدوية', 'pre-delete': 'قبل الحذف', 'pre-restore': 'قبل الاستعادة', purge: 'نهائية' });

export const ACTION_LABELS = Object.freeze({
  'tenant.create': 'إنشاء متجر',
  'tenant.status': 'تغيير الحالة',
  'tenant.update': 'تعديل بيانات المتجر',
  'tenant.settings': 'تعديل إعدادات المتجر',
  'tenant.owner.reset': 'إعادة تعيين كلمة المرور',
  'tenant.user.reset': 'إعادة تعيين كلمة المرور',
  'tenant.owner.create': 'إنشاء حساب المالك',
  'tenant.sessions.revoke': 'إلغاء الجلسات',
  'tenant.backup': 'نسخة احتياطية',
  'tenant.restore.request': 'طلب استعادة',
  'tenant.restore': 'استعادة نسخة',
  'tenant.rename.request': 'طلب تغيير العنوان',
  'tenant.rename': 'تغيير العنوان',
  'tenant.delete': 'طلب حذف',
  'tenant.delete.cancel': 'إلغاء الحذف',
  'tenant.purge': 'حذف نهائي',
  'tenant.purge.now': 'تقديم الحذف النهائي',
  'tenant.cleanup': 'حذف قاعدة قديمة',
  'tenant.export': 'تصدير البيانات',
  'job.retry': 'إعادة محاولة عمل',
  'job.cancel': 'إلغاء عمل',
  'admin.login': 'دخول المسؤول',
  'admin.logout': 'خروج المسؤول',
  'admin.code': 'رمز تحقق خاطئ',
  'admin.session.ended': 'إنهاء الجلسة بعد رموز خاطئة',
  'admin.create': 'إنشاء حساب مسؤول',
  'admin.reset': 'إعادة ضبط حساب مسؤول',
  'admin.unlock': 'فك قفل الدخول',
});

// A table cell with its column's name, which phones show above the value (there tables
// become cards, style.css); the first cell of a row is the card's title
const cell = (label, props = {}, ...children) => h('td', { ...props, dataset: { label } }, ...children);
const titleCell = (props = {}, ...children) => h('td', { ...props, className: `cell-title ${props.className ?? ''}`.trim() }, ...children);

export function statusBadge(status) {
  return h('span', { className: `state is-${status}`, text: STATUS_LABELS[status] ?? status });
}

export function certBadge(cert) {
  const status = cert?.status ?? 'none';
  const badge = h('span', { className: `state cert is-cert-${status}`, text: CERT_LABELS[status] ?? status });
  if (cert?.lastError) badge.title = cert.lastError;
  return badge;
}

// Where a shop of the list opens: its page, or the progress of its setup while it is made
export const shopHref = (t) => (t.status === 'provisioning' && t.job ? `#/job/${t.job.id}` : `#/shop/${t.id}`);

// One row of the shops list. Its name is the link (keyboards and screen readers reach the
// shop through it); a click anywhere on the row opens it too.
export function shopRow(t, { onOpen } = {}) {
  const row = h(
    'tr',
    { className: 'is-link', dataset: { id: t.id } },
    titleCell({}, h('a', { className: 'pname', href: shopHref(t), text: t.label || t.slug }), t.shopName && t.shopName !== t.label ? h('span', { className: 'pcat', text: t.shopName }) : null),
    cell('العنوان', { className: 'host-cell' }, h('span', { className: 'host-name', text: t.host })),
    cell('الحالة', {}, statusBadge(t.status), t.job ? h('span', { className: 'pcat', text: `${JOB_LABELS[t.job.type] ?? t.job.type}: ${JOB_STATUS[t.job.status] ?? t.job.status}` }) : null),
    cell('الفواتير', { className: 'end num', text: formatNumber(t.usage?.salesCount) }),
    cell('حجم البيانات', { className: 'end num', text: formatBytes(t.usage?.dataBytes) }),
    cell('آخر نشاط', { text: formatAgo(t.lastActivityAt) }),
    cell('الشهادة', {}, certBadge(t.cert)),
  );
  if (onOpen) row.addEventListener('click', (e) => e.target.closest?.('a') || onOpen(t));
  return row;
}

// A job's steps: done, skipped, waiting (the first one still to do while it runs), failed
export function stepList(job) {
  const running = ['queued', 'running'].includes(job.status);
  let current = running ? job.steps.findIndex((s) => s.status === 'pending') : -1;
  if (current < 0 && running) current = job.steps.length;
  return h(
    'ol',
    { className: 'steps' },
    job.steps.map((step, i) => {
      const state = step.status === 'pending' && i === current ? 'running' : step.status;
      const detail = step.status === 'failed' ? step.error : step.note;
      return h(
        'li',
        { className: `step is-${state}` },
        h('span', { className: 'step-icon', attrs: { 'aria-hidden': 'true' } }),
        h('div', { className: 'step-text' }, h('strong', { text: stepLabel(job.type, step.key) }), detail ? h('small', { text: detail }) : null),
      );
    }),
  );
}

export function userRow(u, { onReset } = {}) {
  const state = u.disabled ? 'موقوف' : u.mustChangePassword ? 'بانتظار تغيير كلمة المرور المؤقتة' : 'فعّال';
  return h(
    'tr',
    {},
    titleCell({}, h('span', { className: 'pname num', text: u.username }), u.displayName ? h('span', { className: 'pcat', text: u.displayName }) : null),
    cell('الدور', { text: u.role === 'owner' ? 'المالك' : u.role }),
    cell('الحالة', { text: state }),
    cell('آخر دخول', { text: formatDateTime(u.lastLoginAt) }),
    h('td', { className: 'row-actions' }, onReset ? h('button', { className: 'btn btn-sm', type: 'button', text: 'إعادة تعيين كلمة المرور', on: { click: () => onReset(u) } }) : null),
  );
}

export function sessionRow(s) {
  return h(
    'tr',
    {},
    titleCell({ className: 'num', text: s.username || '—' }),
    cell('الجهاز', { className: 'ua-cell' }, h('span', { className: 'ua', text: s.ua || '—' })),
    cell('IP', { className: 'num', text: s.ip || '—' }),
    cell('آخر استخدام', { text: formatAgo(s.lastSeenAt) }),
    cell('تنتهي', { text: formatDateTime(s.expiresAt) }),
  );
}

export function backupRow(b, { onRestore } = {}) {
  return h(
    'tr',
    {},
    titleCell({ text: formatDateTime(b.createdAt) }),
    cell('النوع', {}, BACKUP_KINDS[b.kind] ?? b.kind, b.current ? null : h('span', { className: 'pcat', text: 'من قاعدة سابقة' })),
    cell('الحجم', { className: 'end num', text: formatBytes(b.bytes) }),
    h('td', { className: 'row-actions' }, onRestore ? h('button', { className: 'btn btn-sm', type: 'button', text: 'استعادة', on: { click: () => onRestore(b) } }) : null),
  );
}

const DETAIL_LABELS = Object.freeze({
  label: 'التسمية',
  dbName: 'القاعدة',
  previousDb: 'القاعدة السابقة',
  archive: 'النسخة',
  bytes: 'الحجم بالبايت',
  method: 'الطريقة',
  username: 'الحساب',
  fields: 'الحقول',
  kind: 'النوع',
  ended: 'جلسات انتهت',
  reason: 'السبب',
  job: 'العمل',
  to: 'إلى',
  cleared: 'سجلات مُسحت',
  counts: 'الأعداد',
});

// An audit entry's details as one line of text
export function auditDetails(e) {
  const d = e.details ?? {};
  if (e.action === 'tenant.status') return `من ${STATUS_LABELS[d.from] ?? d.from} إلى ${STATUS_LABELS[d.to] ?? d.to}${d.reason ? ` (${d.reason})` : ''}`;
  if (e.action === 'tenant.rename') return `من ${d.from} إلى ${d.to}`;
  if (d.step && d.error) return `${d.job ? `${JOB_LABELS[d.job] ?? d.job}، ` : ''}${stepLabel(d.job ?? '', d.step)}: ${d.error}`;
  const parts = Object.entries(d).map(([key, value]) => `${DETAIL_LABELS[key] ?? key}: ${value !== null && typeof value === 'object' ? JSON.stringify(value) : value}`);
  const line = parts.join('، ');
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export function auditRow(e) {
  return h(
    'tr',
    { className: e.result === 'failed' ? 'is-failed' : '' },
    titleCell({}, ACTION_LABELS[e.action] ?? e.action, e.result === 'failed' ? h('span', { className: 'state is-deleted', text: 'فشل' }) : null),
    cell('الوقت', { text: formatDateTime(e.at) }),
    cell('المتجر', { className: 'num', text: e.tenantSlug || '—' }),
    cell('التفاصيل', { className: 'details-cell' }, h('span', { className: 'audit-details', text: auditDetails(e) }), h('span', { className: 'pcat num', text: e.actor })),
    cell('IP', { className: 'num', text: e.ip || '—' }),
  );
}

// A definition list of label/value pairs; a value may be an element
export function facts(pairs) {
  return h(
    'dl',
    { className: 'facts' },
    pairs.filter(Boolean).map(([label, value]) => h('div', {}, h('dt', { text: label }), h('dd', {}, value ?? '—'))),
  );
}

export { formatDate };
