// Defence in depth: every API response passes through maskDeep, so a credential-shaped value can never leave in any field even if a code path
// forgot to clean its input. Iterative: a deep structure cannot overflow the stack. The generic long-blob detector is NOT applied here
// (ids, hashes and trace ids are long and legitimate); the specific token, key, bearer and assignment detectors are. Visitor text is
// already fully cleaned (long blobs included) on the way in by cleanFree.
import { DETECTORS, decodePercent, maskSpans, stripInvisible } from './credentials.js';

const SPECIFIC = DETECTORS.filter((d) => !d.generic);
// mockToken: the mock-issued, locally signed assertion of the pass-through lab (rule 4: mock tokens are shown raw, and labelled). It can carry no visitor text.
const INVISIBLE_TEST = /[\p{Default_Ignorable_Code_Point}\p{Cf}\uFFFD]/u;
const OPAQUE = new Set(['hash', 'prevHash', 'traceparent', 'traceId', 'chainHead', 'mockToken']);

export function maskResponseText(input) {
  let text = INVISIBLE_TEST.test(input) ? stripInvisible(input) : input; // an answer never carries characters that could split a secret
  if (/%[0-9A-Fa-f]{2}/.test(text)) { const d = decodePercent(text); if (d !== text && SPECIFIC.some((x) => { x.re.lastIndex = 0; return x.re.test(d); })) text = d; } // an encoded secret is shown decoded and masked
  const spans = [];
  for (const d of SPECIFIC) { d.re.lastIndex = 0; for (const m of text.matchAll(d.re)) spans.push({ start: m.index, end: m.index + m[0].length, id: d.id }); }
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
