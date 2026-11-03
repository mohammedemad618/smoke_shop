// What each role of a shop's account may do. Only the owner exists now, and may do
// everything; a cashier role (selling only) comes later and is added here.
import { httpError } from './errors.js';

export const ROLES = Object.freeze({
  owner: Object.freeze(['*']),
});

export const can = (user, action) => {
  const allowed = ROLES[user?.role] ?? [];
  return allowed.includes('*') || allowed.includes(action);
};

// The route answers 403 to a signed-in account whose role does not allow `action`
export function allow(action) {
  return function checkPermission(req, res, next) {
    if (can(req.user, action)) return next();
    next(httpError(403, 'هذا الإجراء لصاحب المتجر فقط', 'FORBIDDEN'));
  };
}
