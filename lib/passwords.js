// Passwords: hashing, checking, the rules for a new one and a generator for first passwords.
// One module for the shops and the admin panel. Hashes use scrypt from node:crypto with the
// plan's parameters (N=2^14, r=8, p=5: 16 MiB and about 150 ms each), so nothing has to be
// built on the server. At most two hashes run at a time, so a burst of sign-ins cannot take
// the memory or the CPU; others wait their turn, and past a short queue the request is
// refused as busy. Only the hash is ever stored: "$scrypt$ln=14,r=8,p=5$<salt>$<key>".
import { scrypt, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { httpError } from './errors.js';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

const PARAMS = Object.freeze({ ln: 14, r: 8, p: 5 });
const SALT_BYTES = 16;
const KEY_BYTES = 32;
// Twice what N=2^14, r=8 needs; also the ceiling for a stored hash with other parameters
const MAX_MEM = 64 * 1024 * 1024;
const MAX_RUNNING = 2;
const MAX_WAITING = 32;
const FORMAT = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

/* At most two at a time */

let running = 0;
const waiting = [];

async function limited(fn) {
  if (running >= MAX_RUNNING) {
    if (waiting.length >= MAX_WAITING) throw httpError(503, 'الخادم مشغول الآن. أعد المحاولة بعد لحظات');
    await new Promise((resolve) => waiting.push(resolve));
  }
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// For the tests: how many hashes run and wait right now
export const hashQueue = () => ({ running, waiting: waiting.length });

const derive = (password, salt, { ln, r, p }) =>
  new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, KEY_BYTES, { N: 2 ** ln, r, p, maxmem: MAX_MEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });

// Longer than any password could be: refused before any work is done
function assertLength(password) {
  if (typeof password !== 'string' || password.length > PASSWORD_MAX) throw httpError(400, 'كلمة المرور طويلة جدًا');
}

export async function hashPassword(password) {
  assertLength(password);
  const salt = randomBytes(SALT_BYTES);
  const key = await limited(() => derive(password, salt, PARAMS));
  return `$scrypt$ln=${PARAMS.ln},r=${PARAMS.r},p=${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// A stored hash, with its parameters checked so a damaged record cannot ask for a huge one
function parseHash(stored) {
  const m = FORMAT.exec(typeof stored === 'string' ? stored : '');
  if (!m) return null;
  const [ln, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (ln < 10 || ln > 16 || r < 1 || r > 16 || p < 1 || p > 16 || 128 * 2 ** ln * r > MAX_MEM) return null;
  return { params: { ln, r, p }, salt: Buffer.from(m[4], 'base64'), key: Buffer.from(m[5], 'base64') };
}

// True when the password matches the hash. Compared in constant time; a hash that cannot be
// read never matches.
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > PASSWORD_MAX) return false;
  const parsed = parseHash(stored);
  if (!parsed || parsed.key.length !== KEY_BYTES) {
    await verifyDummy(password);
    return false;
  }
  const key = await limited(() => derive(password, parsed.salt, parsed.params));
  return timingSafeEqual(key, parsed.key);
}

// The same work as a real check, for a user that does not exist, so the answer takes as
// long either way and does not tell which names are in use
const DUMMY_SALT = randomBytes(SALT_BYTES);
export async function verifyDummy(password) {
  await limited(() => derive(typeof password === 'string' ? password.slice(0, PASSWORD_MAX) : '', DUMMY_SALT, PARAMS));
  return false;
}

/* Rules for a new password */

// The most used passwords and keyboard runs, compared without case, spaces or a number on
// the end ("Password123" is "password")
const COMMON = new Set([
  'password', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'qwerty', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'azerty',
  'abcdef', 'abcdefgh', 'abcdefghij', 'abc', 'iloveyou', 'admin', 'administrator', 'welcome', 'letmein',
  'monkey', 'dragon', 'football', 'baseball', 'master', 'superman', 'batman', 'sunshine', 'princess',
  'shadow', 'michael', 'charlie', 'trustno1', 'whatever', 'freedom', 'starwars', 'computer', 'internet',
  'secret', 'changeme', 'default', 'login', 'pass', 'test', 'guest', 'user', 'root', 'shop', 'store',
  'market', 'cashier', 'pos', 'mohammed', 'mohammad', 'muhammad', 'ahmed', 'ali', 'hussein', 'hasan',
  'iraq', 'baghdad', 'basra', 'mosul', 'erbil', 'najaf', 'karbala',
  'محمد', 'علي', 'احمد', 'حسين', 'العراق', 'بغداد', 'كلمةالمرور', 'كلمةسر', 'مرحبا', 'السلام',
  'الله', 'اللهاكبر', 'بسمالله', 'حبيبي', 'متجر', 'دكان', 'محل', 'كاشير',
]);
const SEQUENCES = ['01234567890', '09876543210', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm', 'ضصثقفغعهخحجد'];

function isCommon(password) {
  const plain = password.toLowerCase().replace(/\s+/g, '');
  const stem = plain.replace(/[0-9٠-٩!@#$%^&*._-]+$/, '');
  if (COMMON.has(plain) || COMMON.has(stem)) return true;
  // One to four characters over and over ("aaaaaaaaaa", "1231231231"), or a run of the
  // keyboard or the digits
  if (new Set(plain).size <= 2) return true;
  for (let n = 3; n <= 4; n++) if (plain === plain.slice(0, n).repeat(Math.ceil(plain.length / n)).slice(0, plain.length)) return true;
  return SEQUENCES.some((run) => run.includes(plain) || (stem.length >= 4 && run.includes(stem) && plain.length - stem.length <= 4));
}

// null when the password may be used, or the Arabic reason it may not. Arabic letters are
// allowed and count as one character each. `username` and `slug` (the shop's address) must
// not appear in it, in any case. `min` is 10 for a shop's accounts and 14 for the admin
// (ADMIN_PASSWORD_MIN).
export const ADMIN_PASSWORD_MIN = 14;
// "10 أحرف", "14 حرفًا"
const letters = (n) => (n % 100 >= 3 && n % 100 <= 10 ? `${n} أحرف` : `${n} حرفًا`);
export function passwordProblem(password, { username = '', slug = '', min = PASSWORD_MIN } = {}) {
  if (typeof password !== 'string') return 'اكتب كلمة المرور';
  const length = [...password].length;
  if (length < min) return `كلمة المرور يجب أن تكون ${letters(min)} على الأقل`;
  if (password.length > PASSWORD_MAX) return `كلمة المرور طويلة جدًا (${PASSWORD_MAX} حرفًا كحد أقصى)`;
  if (password.trim() !== password) return 'كلمة المرور لا تبدأ ولا تنتهي بمسافة';
  const lower = password.toLowerCase();
  if (username && lower.includes(String(username).toLowerCase())) return 'كلمة المرور يجب ألا تحتوي اسم المستخدم';
  if (slug && lower.includes(String(slug).toLowerCase())) return 'كلمة المرور يجب ألا تحتوي عنوان المتجر';
  if (isCommon(password)) return 'كلمة المرور هذه شائعة وسهلة التخمين. اختر غيرها';
  return null;
}

/* First passwords */

// Letters and digits that cannot be mistaken for one another when read out or copied by
// hand (no 0/O, 1/l/I)
const READABLE = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// A random readable password that passes the rules for this user and shop (14 characters
// is about 81 bits)
export function generatePassword({ length = 14, username = '', slug = '' } = {}) {
  for (;;) {
    const password = Array.from({ length }, () => READABLE[randomInt(READABLE.length)]).join('');
    // Mixed case and a digit, so it reads as a password; and never one the rules refuse
    if (/[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && !passwordProblem(password, { username, slug })) return password;
  }
}
