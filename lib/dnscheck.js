// Before a shop's certificate is asked for: its name must resolve to this server's address
// exactly, and to no IPv6 address (Let's Encrypt would try that first and fail). sslip.io
// answers any name that holds an address with that address, so this also catches a name
// that slipped past lib/slug.js and leads elsewhere. A name not found yet may be DNS being
// slow: that error is not final, and the job runner tries again later.
import dns from 'node:dns';

const MISSING = new Set(['ENODATA', 'ENOTFOUND', 'ENOENT']);

const final = (message) => Object.assign(new Error(message), { final: true });

export async function checkDns(host, ipv4, resolver = dns.promises) {
  let addresses;
  try {
    addresses = await resolver.resolve4(host);
  } catch (err) {
    throw new Error(`لم يُعثر على العنوان ${host} في DNS بعد (${err.code ?? err.message})`);
  }
  if (addresses.length !== 1 || addresses[0] !== ipv4) {
    throw final(`العنوان ${host} يشير إلى ${addresses.join('، ') || 'لا شيء'} وليس إلى ${ipv4}`);
  }
  let v6 = [];
  try {
    v6 = await resolver.resolve6(host);
  } catch (err) {
    if (!MISSING.has(err.code)) throw new Error(`تعذّر فحص سجل IPv6 للعنوان ${host} (${err.code ?? err.message})`);
  }
  if (v6.length) throw final(`للعنوان ${host} سجل IPv6 (${v6[0]})، فلا يمكن إصدار شهادته من هذا الخادم`);
}
