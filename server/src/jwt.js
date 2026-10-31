// Real RS256 for the token pass-through lab. Keys are RSA 2048, generated locally the first time they are needed (never EC, never written to disk,
// never shown). A verifier accepts ONE algorithm (RS256): "none", HS256 and anything else are refused, which closes the classic algorithm-confusion hole.
// Time is the lab clock (seconds), passed in, so tests and the Mock table are deterministic.
import crypto from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');
const PART = /^[A-Za-z0-9_-]+$/;
export const MAX_TOKEN = 4096;
export const MAX_LIFETIME_SEC = 300; // lab-invented: "short-lived" in the deck is not given a number

const keys = new Map();
// name -> { kid, privateKey, publicKey }. Lazy: RSA key generation is the slow part and most paths never need it.
export function keyPair(name) {
  if (!keys.has(name)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    keys.set(name, { kid: `${name}-1`, privateKey, publicKey });
  }
  return keys.get(name);
}

export function sign(payload, name, headerOver = {}) {
  const k = keyPair(name);
  const header = { alg: 'RS256', typ: 'JWT', kid: k.kid, ...headerOver };
  const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(data), k.privateKey);
  return `${data}.${b64u(sig)}`;
}

// Decode without trusting anything: for display and for choosing which issuer's keys to try. Returns null on any malformation.
export function decode(token) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !PART.test(parts[0]) || !PART.test(parts[1]) || (parts[2] !== '' && !PART.test(parts[2]))) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (header === null || typeof header !== 'object' || Array.isArray(header) || claims === null || typeof claims !== 'object' || Array.isArray(claims)) return null;
    return { header, claims, parts };
  } catch { return null; }
}

// trust: { [issuer]: { [kid]: publicKey } }. Checks, in this order: shape, algorithm, issuer is trusted, key id is known, signature, audience, lifetime.
// Returns { ok: true, header, claims } or { ok: false, code }.
export function verify(token, { trust, audience, now, maxLifetime = MAX_LIFETIME_SEC }) {
  const d = decode(token);
  if (!d) return { ok: false, code: 'malformed' };
  const { header, claims, parts } = d;
  if (header.alg !== 'RS256') return { ok: false, code: 'alg_not_allowed' };
  if (typeof claims.iss !== 'string' || !Object.hasOwn(trust, claims.iss)) return { ok: false, code: 'untrusted_issuer' };
  const set = trust[claims.iss];
  if (typeof header.kid !== 'string' || !Object.hasOwn(set, header.kid)) return { ok: false, code: 'unknown_key' };
  let good = false;
  try { good = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), set[header.kid], Buffer.from(parts[2], 'base64url')); } catch { good = false; }
  if (!good) return { ok: false, code: 'bad_signature' };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) return { ok: false, code: 'wrong_audience' };
  if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.iat)) return { ok: false, code: 'missing_time_claims' };
  if (claims.exp <= now) return { ok: false, code: 'expired' };
  if (claims.iat > now + 5) return { ok: false, code: 'issued_in_the_future' };
  if (claims.exp - claims.iat > maxLifetime) return { ok: false, code: 'lifetime_too_long' };
  if (typeof claims.sub !== 'string' || typeof claims.jti !== 'string') return { ok: false, code: 'missing_claims' };
  return { ok: true, header, claims };
}

export const publicKey = (name) => keyPair(name).publicKey;
// Public facts only (never key material) for the page: the key id, the algorithm, the size and the public exponent.
export function describeKey(name) {
  const k = keyPair(name); const jwk = k.publicKey.export({ format: 'jwk' });
  return { kid: k.kid, alg: 'RS256', kty: jwk.kty, bits: Buffer.from(jwk.n, 'base64url').length * 8, e: jwk.e };
}
export const tokenDigest = (token) => crypto.createHash('sha256').update(token).digest('hex');
