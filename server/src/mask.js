// Defence in depth: every API response passes through maskDeep, so a credential-shaped value can never leave in any field even if a code path
// forgot to clean its input. Iterative: a deep structure cannot overflow the stack. The generic long-blob detector is NOT applied here
// (ids, hashes and trace ids are long and legitimate); the specific token, key, bearer and assignment detectors are. Visitor text is
// already fully cleaned (long blobs included) on the way in by cleanFree.
import { decodePercent, findCredentials, maskSpans, stripInvisible } from './credentials.js';

// mockToken: the mock-issued, locally signed assertion of the pass-through lab (rule 4: mock tokens are shown raw, and labelled). It can carry no visitor text.
const INVISIBLE_TEST = /[\p{Default_Ignorable_Code_Point}\p{Cf}\uFFFD\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u; // invisible, format and control characters (TAB, LF, CR stay)
const OPAQUE = new Set(['hash', 'prevHash', 'traceparent', 'traceId', 'chainHead', 'mockToken']);

export function maskResponseText(input) {
  let text = INVISIBLE_TEST.test(input) ? stripInvisible(input) : input; // an answer never carries characters that could split a secret (a control character included)
  if (/%[0-9A-Fa-f]{2}/.test(text)) { const d = stripInvisible(decodePercent(text)); if (d !== text && findCredentials(d, { generic: false, all: true }).length) text = d; } // an encoded secret is shown decoded and masked
  const spans = findCredentials(text, { generic: false, all: true }); // the specific detectors only, separators tried both as spaces and deleted
  return spans.length ? maskSpans(text, spans) : text;
}

// Assign by own property, so a key named __proto__ stays a plain data key and is neither dropped nor allowed to change the copy's prototype.
const put = (dst, key, val) => Object.defineProperty(dst, key, { value: val, enumerable: true, writable: true, configurable: true });
export function maskDeep(value) {
  const clone = (x) => (Array.isArray(x) ? [] : x && typeof x === 'object' ? {} : x);
  const root = { v: clone(value) };
  const work = [[value, root, 'v', false]];
  while (work.length) {
    const [src, dst, key, opaque] = work.pop();
    if (typeof src === 'string') { put(dst, key, opaque ? src : maskResponseText(src)); continue; }
    if (src === null || typeof src !== 'object') { put(dst, key, src); continue; }
    const copy = clone(src); put(dst, key, copy);
    for (const k of Object.keys(src).reverse()) work.push([src[k], copy, k, OPAQUE.has(k)]);
  }
  return root.v;
}
