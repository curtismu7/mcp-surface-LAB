// The adapter's opaque() decision (mask.js): only the values the lab mints are left as they are, and only where it mints them. A visitor can type any key name into params
// and the hop pane echoes params, so a name alone must never make a value opaque.
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskDeep, maskTyped } from '../src/mask.js';
import { scrub } from '../src/util.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const TP = `00-${TRACE}-00f067aa0ba902b7-01`;
const JWT = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJtYXlhIn0', 'abcdefghij1234567890XYZ_-abcdefghij'].join('.');

test('O1: the mock OAuth server\'s tokens (mock-access/refresh/code-NNNN) are shown raw under any key, and nothing else of that key is', () => {
  for (const v of ['mock-access-0001', 'mock-refresh-0002', 'mock-code-0003', 'mock-access-9999']) {
    assert.deepEqual(maskDeep({ result: { access_token: v, refresh_token: v, code: v } }), { result: { access_token: v, refresh_token: v, code: v } }, v);
    assert.deepEqual(scrub({ refresh_token: v }), { refresh_token: v }, `${v} in a hop pane`);
  }
  for (const v of ['mock-access-001', 'mock-access-00011', 'mock-access-0001x', 'xmock-refresh-0001', 'mock-token-0001', 'mock-access-000a', ' mock-code-0001']) {
    assert.equal(maskDeep({ access_token: v }).access_token, '[masked:assignment]', JSON.stringify(v));
  }
});

test('O2: the trace id is opaque at the top of an answer only; the same 32 hex characters anywhere else are masked', () => {
  assert.deepEqual(maskDeep({ traceId: TRACE }), { traceId: TRACE });
  assert.deepEqual(maskDeep({ traceId: 'g'.repeat(32) }), { traceId: 'g'.repeat(32) }, 'a word run is ordinary text');
  assert.equal(maskDeep({ hops: { traceId: TRACE } }).hops.traceId, '[masked:opaque]');
  assert.equal(maskDeep({ note: TRACE }).note, '[masked:opaque]');
  assert.equal(maskDeep({ traceId: `${TRACE}ab` }).traceId, '[masked:opaque]', 'a 34 character value is not a trace id');
  assert.equal(scrub({ traceId: TRACE }).traceId, '[masked:opaque]', 'a typed trace id in a hop pane is masked');
});

test('O3: a traceparent is left alone by the masker itself; the same text under a credential word is not', () => {
  assert.deepEqual(maskDeep({ headers: { traceparent: TP } }), { headers: { traceparent: TP } });
  assert.deepEqual(scrub({ traceparent: TP }), { traceparent: TP });
  assert.equal(maskDeep({ password: TP }).password, '[masked:assignment]');
});

test('O4: the mock-issued assertion is opaque at result.mockToken only', () => {
  assert.deepEqual(maskDeep({ result: { mockToken: JWT } }), { result: { mockToken: JWT } });
  assert.equal(maskDeep({ params: { mockToken: JWT } }).params.mockToken, '[masked:assignment]');
  assert.equal(maskDeep({ mockToken: JWT }).mockToken, '[masked:assignment]');
  assert.equal(maskDeep({ result: { other: JWT } }).result.other, '[masked:jwt]');
  assert.equal(maskDeep({ result: { mockToken: { deeper: JWT } } }).result.mockToken.deeper, '[masked:assignment]', 'only a string under the key is opaque');
  assert.equal(scrub({ mockToken: JWT }).mockToken, '[masked:assignment]');
});

test('O5: the credentials panel of the state is read as lab data (state.credentials), nowhere else', () => {
  const panel = { modes: ['none', 'static-token', 'user-token'], maxAssertionLifetimeSec: 300, issuer: 'https://portal.fabrikam.example', attemptsTotal: 0 };
  assert.deepEqual(maskDeep({ state: { credentials: panel } }), { state: { credentials: panel } });
  assert.equal(maskDeep({ credentials: panel }).credentials.issuer, '[masked:assignment]', 'the same panel at another place is a credentials value');
  assert.equal(maskDeep({ credentials: panel }).credentials.maxAssertionLifetimeSec, '[masked:assignment]');
  assert.equal(maskDeep({ state: { credentials: { password: 'hunter2xyz' } } }).state.credentials.password, 'hunter2xyz', 'known trade-off: key names are not read inside the panel (the engine never stores a typed value under a key there)');
  assert.equal(maskDeep({ state: { credentials: { note: 'password=hunter2xyz' } } }).state.credentials.note, '[masked:assignment]');
});

test('O6: what a visitor typed (scrub, maskTyped) keeps only the mock OAuth tokens raw: no trace id, no assertion, no panel rule', () => {
  assert.deepEqual(maskTyped({ code: 'mock-code-0001' }), { code: 'mock-code-0001' });
  assert.equal(maskTyped({ refresh_token: 'mock-refresh-0001x' }).refresh_token, '[masked:assignment]');
  assert.equal(scrub({ result: { mockToken: JWT } }).result.mockToken, '[masked:assignment]');
  assert.equal(scrub({ state: { credentials: { issuer: 'https://portal.fabrikam.example' } } }).state.credentials.issuer, '[masked:assignment]');
});
