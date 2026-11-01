// Small shared helpers. No I/O. Everything a visitor types passes through one of these before it is used as a key, an id or text.
import { cleanFree, findCredentials, stripInvisible } from './credentials.js';

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const own = (o, k) => typeof k === 'string' && isObj(o) && Object.hasOwn(o, k);
export const nullMap = (entries = []) => Object.assign(Object.create(null), Object.fromEntries(entries));

// A copy of the visitor's parameters that is safe to show: strings cleaned and masked, nothing else changed. Iterative-free but depth-limited.
export function scrub(value, depth = 0) {
  if (typeof value === 'string') return cleanFree(value, 300);
  if (Array.isArray(value)) return depth > 4 ? [] : value.slice(0, 12).map((v) => scrub(v, depth + 1));
  if (isObj(value)) return depth > 4 ? {} : Object.fromEntries(Object.keys(value).slice(0, 24).map((k) => [cleanFree(k, 40), scrub(value[k], depth + 1)]));
  return typeof value === 'number' || typeof value === 'boolean' || value === null ? value : undefined;
}

// True when the text would be masked by the credential detectors (a typed value must never become an id, a name or a key).
export const credentialShaped = (s) => findCredentials(stripInvisible(String(s))).length > 0; // control and invisible characters deleted first

// An identifier the visitor typed: a string that fits the form and does not look like a credential. Returns it, or null.
export function safeId(v, re, max = 40) {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || !re.test(v) || credentialShaped(v)) return null;
  return v;
}

export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

import { refuse } from './errors.js';
// Strict parameter shape: an object, only the listed keys (an unknown key is refused WITHOUT naming it), every required key present.
export function take(p, allowed, required = []) {
  if (!isObj(p)) throw refuse('bad_request', 'the parameters must be an object');
  for (const k of Object.keys(p)) if (!allowed.includes(k)) throw refuse('unknown_field', 'a parameter is not one the lab takes');
  for (const r of required) if (p[r] === undefined || p[r] === null) throw refuse('missing_field', 'a required parameter is missing');
  return p;
}
