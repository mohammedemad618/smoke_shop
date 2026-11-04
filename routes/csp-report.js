import express, { Router } from 'express';
import { rateLimit } from '../lib/ratelimit.js';
import { allow } from '../lib/permissions.js';

const router = Router();
const clip = (value, length) => String(value ?? '').slice(0, length);

// What the shop's Content-Security-Policy (report-only for now, lib/security.js) would have
// blocked, sent by the browser itself. Public, since a browser reports without a session,
// and limited per shop so it cannot be used to fill the logs. One short line each in the
// server's log, and nothing stored: a week without any from the shop's own devices means the
// policy can be enforced.
router.post(
  '/',
  allow('public'),
  rateLimit({ windowMs: 60 * 1000, max: 30, key: (req) => String(req.tenant._id) }),
  express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }),
  (req, res) => {
    // report-uri sends { "csp-report": {...} }; the Reporting API a list of { type, body }
    const report = req.body?.['csp-report'] ?? (Array.isArray(req.body) ? req.body[0]?.body : null) ?? {};
    console.warn(
      JSON.stringify({
        csp: req.tenant.slug,
        directive: clip(report['effective-directive'] ?? report['violated-directive'] ?? report.effectiveDirective, 80),
        blocked: clip(report['blocked-uri'] ?? report.blockedURL, 200),
        page: clip(report['document-uri'] ?? report.documentURL, 200),
      }),
    );
    res.status(204).end();
  },
);

export default router;
