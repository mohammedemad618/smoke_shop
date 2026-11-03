// Every shop and host name, kept in memory so a request finds its shop without a query. The
// app updates it at once after its own writes (services/tenants.js); what the command line
// or another process writes is picked up by polling rev every 5 s, and everything is read
// again every 5 minutes. While the control database is unreachable the last state stays.

const TENANT_FIELDS = 'slug label dbName status statusReason shopNameCache rev';
const HOST_FIELDS = 'tenantId kind redirectUntil rev';
// rev comes from one counter, but two writers can commit out of order (11 before 10): each
// poll reads the last few revisions again so the late one is not missed
const REV_WINDOW = 20;

export function createRegistry({ Tenant, Host }, { pollMs = 5000, reloadMs = 5 * 60 * 1000 } = {}) {
  let tenants = new Map(); // id -> tenant
  let hosts = new Map(); // host name -> host
  let lastRev = 0;
  let timers = [];
  let busy = false;

  const keep = (map, key, doc) => {
    const current = map.get(key);
    if (!current || current.rev <= doc.rev) map.set(key, doc);
    lastRev = Math.max(lastRev, doc.rev ?? 0);
  };
  const applyTenant = (tenant) => keep(tenants, String(tenant._id), tenant);
  const applyHost = (host) => keep(hosts, host._id, host);

  async function load() {
    const [allTenants, allHosts] = await Promise.all([Tenant.find({}, TENANT_FIELDS).lean(), Host.find({}, HOST_FIELDS).lean()]);
    tenants = new Map(allTenants.map((t) => [String(t._id), t]));
    hosts = new Map(allHosts.map((h) => [h._id, h]));
    lastRev = Math.max(0, ...allTenants.map((t) => t.rev), ...allHosts.map((h) => h.rev));
  }

  async function poll() {
    const since = { rev: { $gt: lastRev - REV_WINDOW } };
    const [changedTenants, changedHosts] = await Promise.all([Tenant.find(since, TENANT_FIELDS).lean(), Host.find(since, HOST_FIELDS).lean()]);
    changedTenants.forEach(applyTenant);
    changedHosts.forEach(applyHost);
  }

  // One refresh at a time; a failure is logged and the next one tries again
  const refresh = (fn) => async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (err) {
      console.error(`Could not refresh the shops list: ${err.message}`);
    } finally {
      busy = false;
    }
  };

  return {
    load,
    poll,
    applyTenant,
    applyHost,
    // { host, tenant } for a host name the registry knows, else null
    resolve(name) {
      const host = hosts.get(name);
      const tenant = host && tenants.get(String(host.tenantId));
      return tenant ? { host, tenant } : null;
    },
    tenants: () => [...tenants.values()],
    hostsOf: (tenantId) => [...hosts.values()].filter((h) => String(h.tenantId) === String(tenantId)),
    async start() {
      await load();
      if (pollMs) timers.push(setInterval(refresh(poll), pollMs).unref());
      if (reloadMs) timers.push(setInterval(refresh(load), reloadMs).unref());
    },
    stop() {
      timers.forEach(clearInterval);
      timers = [];
    },
  };
}
