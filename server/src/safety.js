// Safety rules. Pure functions plus two tiny middlewares. No I/O.
//  1. Loopback bind only unless MSFLAB_BIND is set on purpose.
//  2. Host header must be a loopback name (DNS-rebinding defence).
//  3. A write must be same-origin: a cross-origin Origin, or a cross-site Sec-Fetch-Site, is refused.
//  4. Every host in any shipped text is reserved (.invalid / .example / apex of example.com|net|org).
//  5. Ports are 7350-7399 and never one of the forbidden ones.
//  6. Every key-looking string is an obviously fake sk-MOCK- value.

export function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(h);
}

export function bindHost(env = process.env) { return env.MSFLAB_BIND || '127.0.0.1'; }

export function assertBindAllowed(host, env = process.env) {
  if (isLoopbackHost(host) || env.MSFLAB_BIND) return host;
  throw new Error(`refusing to bind ${host}: loopback only. Set MSFLAB_BIND to opt in.`);
}

export const PORT_MIN = 7350;
export const PORT_MAX = 7399;
export const DEFAULT_PORT = 7350;
const FORBIDDEN_PORTS = new Set([8080, 5173, 3000, 3900, 4000, 4400, 4510, 4600, 4601, 4840, 18080, 19080, 19090]);
export function portProblem(port) {
  if (!Number.isInteger(port)) return 'PORT is not an integer';
  if (FORBIDDEN_PORTS.has(port)) return `port ${port} is reserved for something else`;
  if (port < PORT_MIN || port > PORT_MAX) return `port ${port} is outside ${PORT_MIN}-${PORT_MAX}`;
  return null;
}
export function resolvePort(env = process.env) {
  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);
  const problem = portProblem(port);
  if (problem) throw new Error(problem);
  return port;
}

export function isReservedHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return /(^|\.)(invalid|example)$/.test(h);
}

const NETWORK_URL = /\b(?:https?|wss?|ftp|sftp|ssh|smtp|tcp|udp):\/\/([^\s/?#"'<>\\]+)/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const stripAuthority = (a) => a.replace(/^[^@]*@/, '').replace(/:\d+$/, '');

// Every hostname or IP in text that is not reserved. Loopback names in URLs are allowed. Empty = clean.
export function scanHosts(text) {
  const found = new Set();
  const s = String(text);
  for (const m of s.matchAll(NETWORK_URL)) found.add(stripAuthority(m[1]).toLowerCase());
  for (const m of s.matchAll(EMAIL)) found.add(m[1].toLowerCase());
  for (const m of s.matchAll(IPV4)) found.add(m[0]);
  return [...found].filter((h) => !isReservedHost(h) && !isLoopbackHost(h)).sort();
}

// Any "sk-" secret that is not an obviously fake sk-MOCK- value. Empty = clean.
export function scanKeys(text) {
  return [...String(text).matchAll(/\bsk-(?!MOCK-)[A-Za-z0-9_-]{8,}/g)].map((m) => `${m[0].slice(0, 8)}...`);
}

// Free text from a caller (custodian, description): control characters stripped, length capped. Rendered as text, never as markup.
export function cleanText(value, max = 80) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').trim().slice(0, max);
}

// The family lab-proxy (https://local.ping-devops.com:8443) sends Host `<name>:<this lab's port>` for a name listed in
// LAB_ALLOWED_HOSTS (a comma list of host names, no ports). Loopback always works; unset means loopback only. index.js
// parses it before the server starts and passes the set to createApp.
export function labProxyHosts(env = process.env, port = resolvePort(env)) {
  return new Set(String(env.LAB_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).map((n) => `${n}:${port}`));
}

// Behind the lab-proxy the browser's Origin is the proxy's (https://local.ping-devops.com:8443) while Host is this lab's own
// name. X-Forwarded-Host/-Proto are believed only when Host is one of proxyHosts (never loopback), so a request that did not
// come through the proxy cannot use them.
export function isProxiedSameOrigin(headers, proxyHosts) {
  const xfh = String(headers['x-forwarded-host'] || '').trim().toLowerCase();
  const xfp = String(headers['x-forwarded-proto'] || '').trim().toLowerCase();
  return proxyHosts.has(String(headers.host || '').toLowerCase()) && xfh !== '' && (xfp === 'https' || xfp === 'http')
    && headers.origin === `${xfp}://${xfh}`;
}

export function makeHostCheck(proxyHosts = new Set()) {
  return function hostCheck(req, res, next) {
    const raw = String(req.headers.host || '');
    const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.replace(/:\d+$/, '');
    if (!isLoopbackHost(host) && !proxyHosts.has(raw.toLowerCase())) return res.status(403).json({ error: 'bad_host', message: 'Host must be a loopback name' });
    next();
  };
}
export const hostCheck = makeHostCheck();

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export function makeSameOriginWrites(proxyHosts = new Set()) {
  return function sameOriginWrites(req, res, next) {
    if (!WRITE.has(req.method)) return next();
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'cross_origin', message: 'writes must be same-origin' });
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { /* malformed */ }
      if (!ok && !isProxiedSameOrigin(req.headers, proxyHosts)) return res.status(403).json({ error: 'cross_origin', message: 'writes must be same-origin' });
    }
    next();
  };
}
export const sameOriginWrites = makeSameOriginWrites();
