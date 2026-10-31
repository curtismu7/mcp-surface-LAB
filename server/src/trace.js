// Rule 14: W3C Trace Context on every (mock) hop. One trace id per evaluation, a new span id per hop. A valid incoming
// `traceparent` header continues its trace; anything else starts a new one. Nothing is sent anywhere: these are the raw
// request/response panes the UI shows. Values are random, mock, and carry no meaning outside this app.
import { randomBytes } from 'node:crypto';

const TP = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO32 = '0'.repeat(32);
const ZERO16 = '0'.repeat(16);

export function parseTraceparent(v) {
  if (typeof v !== 'string' || v.length !== 55) return null;
  const m = TP.exec(v);
  return m && m[1] !== ZERO32 && m[2] !== ZERO16 ? { traceId: m[1], parentId: m[2], flags: m[3] } : null;
}
export const formatTraceparent = (traceId, spanId, flags = '01') => `00-${traceId}-${spanId}-${flags}`;

// The lab ALWAYS starts its own trace: a 32-hex trace id sent by the caller is indistinguishable from a 32-hex secret, so it is never echoed back
// (in a response header, a hop pane or the traceId field). A valid incoming header is parsed (and tested) but not continued.
export function newTrace(_incoming, rand = randomBytes) {
  const span = () => rand(8).toString('hex').replace(/^0{16}$/, '0000000000000001');
  return { traceId: rand(16).toString('hex').replace(/^0{32}$/, `${'0'.repeat(31)}1`), parentId: null, span };
}
