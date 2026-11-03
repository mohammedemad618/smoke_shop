// How the routers of the sign-in paths match a path: exactly. By default Express takes
// /API/Auth/Login and /api/auth/login/ for /api/auth/login, while nginx's limits on signing
// in pick the path by pattern (ops/nginx/pos.conf): a variant the pattern missed would reach
// the handler without them. With these options such a variant is no route at all. Routers
// do not take this from the app, so each one is made with it: Router(EXACT).
export const EXACT = Object.freeze({ caseSensitive: true, strict: true });
