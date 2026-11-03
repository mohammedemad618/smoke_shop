// The control database (pos_control): which shops exist, their addresses, the audit log and
// the long tasks. Bound only to the control connection from lib/db.js, never to mongoose's
// default connection or the base one. Later phases add Admin, Session and LoginAttempt here.
import tenantSchema from './Tenant.js';
import hostSchema from './Host.js';
import auditLogSchema from './AuditLog.js';
import jobSchema from './Job.js';
import counterSchema from '../../models/Counter.js';
import { limitQueryTime } from '../../models/index.js';

// Counter holds 'rev', the one sequence behind every tenant and host change
export const CONTROL_SCHEMAS = Object.freeze({
  Tenant: tenantSchema,
  Host: hostSchema,
  AuditLog: auditLogSchema,
  Job: jobSchema,
  Counter: counterSchema,
});
// Counter's limits come with the shop models (the same schema)
for (const [name, schema] of Object.entries(CONTROL_SCHEMAS)) if (name !== 'Counter') limitQueryTime(schema);
