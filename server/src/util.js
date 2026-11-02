// Small shared helpers. No I/O. Everything a visitor types passes through one of these before it is used as a key, an id or text.
import { tidy } from './credentials.js';
import { isCredentialId, looksLikeCredential, maskDeep } from './mask.js';

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const own = (o, k) => typeof k === 'string' && isObj(o) && Object.hasOwn(o, k);
export const nullMap = (entries = []) => Object.assign(Object.create(null), Object.fromEntries(entries));

// A copy of the visitor's parameters that is safe to show and to store (a hop pane, the audit log). Three steps: (1) bound the shape (depth, array length,
// key count; only strings, numbers, booleans and null survive) and replace a string that is JSON text by its masked re-serialisation (see maskJsonText);
// (2) mask the whole copy with the shared masker (values and object keys, the key name classifies the value); (3) cut strings and keys to length.
export function scrub(value) {
  return tidyDeep(maskDeep(bound(value, 0)), 0);
}
// A JSON document typed as a string (an OpenAPI spec, a request body): masked as the document it is. The shared masker reads the same text as prose and does not
// treat `"name": "pw hunter2xyz"` as a secret (a name field is a label there); read as an object, the value is masked.
const maskJsonText = (s) => {
  if (s.length > 65536 || !/^\s*[{[]/.test(s)) return s;
  try { return JSON.stringify(maskDeep(JSON.parse(s))); } catch { return s; }
};
function bound(value, depth) {
  if (typeof value === 'string') return maskJsonText(value);
  if (Array.isArray(value)) return depth > 4 ? [] : value.slice(0, 12).map((v) => bound(v, depth + 1));
  if (isObj(value)) return depth > 4 ? {} : Object.fromEntries(Object.keys(value).slice(0, 24).map((k) => [k, bound(value[k], depth + 1)]));
  return typeof value === 'number' || typeof value === 'boolean' || value === null ? value : undefined;
}
function tidyDeep(value, depth) {
  if (typeof value === 'string') return tidy(value, 300);
  if (Array.isArray(value)) return value.map((v) => tidyDeep(v, depth + 1));
  if (isObj(value)) return Object.fromEntries(Object.keys(value).map((k) => [tidy(k, 40), tidyDeep(value[k], depth + 1)]));
  return value;
}

// True when the text would be masked by the shared masker (a typed value must never become a name or a key).
export const credentialShaped = (s) => looksLikeCredential(String(s));

// An identifier the visitor typed: a string that fits the form and does not look like a credential. Returns it, or null.
export function safeId(v, re, max = 40) {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || !re.test(v) || credentialShaped(v) || isCredentialId(v)) return null; // an id is also refused when it is shaped like a credential id (long run with a digit, sk-/pw-/token- prefix ...)
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
