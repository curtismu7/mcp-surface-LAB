// The independent review's findings, each proven here (and each mutation-checked): the expansion bomb, percent-encoded echo, invisible characters, a full audit log,
// the token cap, multi-byte text on a stream, names outside listings, name collisions with the aggregate path, recordings that never truncate, and the smaller items.
import test from 'node:test';
import assert from 'node:assert/strict';
import { expandedNodes, generateTools, parseSpec } from '../src/openapi.js';
import { cleanFree } from '../src/credentials.js';
import { maskDeep } from '../src/mask.js';
import { filterWire, encodeAnswer, splitChunks } from '../src/wire.js';
import { AuthServer, LIMITS as OAUTH } from '../src/oauth.js';
import { PKCE_CHALLENGE, PKCE_VERIFIER } from '../src/scenarios.js';
import { cimdDocs, CIMD_ALLOWLIST_DEFAULT, sampleSpec } from '../src/world.js';
import { RECORDING_LIMITS, fitsRecording } from '../src/engine.js';
import { sign, verify, publicKey } from '../src/jwt.js';
import { newTrace } from '../src/trace.js';
import { A, A1, A2, A2N, A3, A4, A5, AGG, APP, C, U, U2, act, callTool, codeOf, get, mcp, newEngine, ok, post, rawHttp, run, withServer, W } from './helpers.js';
import { SECRETS } from './secrets.js';
import { createWorkspaces } from '../src/workspaces.js';

const sample = JSON.stringify(sampleSpec(C));

// ---- B2: the expansion bomb -------------------------------------------------------------------------------------------------------------------------------
const bomb = (levels, fan = 10) => {
  const schemas = {};
  for (let l = 0; l < levels; l++) { const props = {}; for (let i = 0; i < fan; i++) props[`p${i}`] = l === levels - 1 ? { type: 'string' } : { $ref: `#/components/schemas/L${l + 1}` }; schemas[`L${l}`] = { type: 'object', properties: props }; }
  return JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, components: { schemas }, paths: { '/a': { post: { operationId: 'a', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/L0' } } } } } } } });
};
test('B2: a small spec whose levels each reference the next ten times is refused cleanly after a BOUNDED amount of work, from 2 to 12 levels (the expansion is budgeted while it happens)', () => {
  // No clock: the proof is the number of schema nodes visited. Unbudgeted, 12 levels of fan 10 would visit 10^12 of them; budgeted, never more than the total budget (plus the node that trips it).
  for (let levels = 2; levels <= 12; levels++) {
    let code;
    try { generateTools(parseSpec(bomb(levels))); code = 'ok'; } catch (e) { code = e.code; }
    assert.ok(expandedNodes() <= 20001, `${levels} levels visited ${expandedNodes()} nodes`);
    if (levels >= 5) assert.equal(code, 'schema_too_large', `${levels} levels`);
    if (levels >= 5) assert.ok(expandedNodes() > 1500, `${levels} levels: the per-tool budget (1500) is what stopped it, so more than that was visited`);
  }
  assert.equal(generateTools(parseSpec(bomb(2))).tools.length, 1, 'a modest spec still works');
  assert.ok(expandedNodes() < 200, 'and visits few nodes');
  assert.equal(generateTools(parseSpec(sample)).tools.length, 4);
});
test('B2: the bomb through the HTTP API (Mock and Live) is a 413 and the server still answers afterwards', async () => {
  await withServer(async (url) => {
    for (const mode of ['mock', 'live']) {
      const r = await post(url, '/api/act/oaPreview', { mode, vertical: 'finance', params: { spec: bomb(9) } }, W(`bomb-${mode}`));
      assert.equal(r.status, 413); assert.equal((await r.json()).error, 'schema_too_large');
      assert.ok(expandedNodes() <= 20001, 'the work done for the refusal is bounded');
    }
    assert.equal((await get(url, '/api/health')).status, 200);
  });
});

// ---- B3: percent-encoded echo -----------------------------------------------------------------------------------------------------------------------------
test('B3: a credential typed as a path argument comes back in no field, plain, percent-encoded or double-encoded: only the template and the argument names are shown', async () => {
  const e = newEngine(); ok(run(e, 'oaDeploy', { actor: A, name: 'invoices', spec: sample }));
  const shapes = Object.entries(SECRETS).filter(([k]) => !/pem|filler/.test(k));
  for (const [k, v] of shapes) {
    for (const form of [v, encodeURIComponent(v), encodeURIComponent(encodeURIComponent(v))]) {
      e.trace = { traceId: 'a'.repeat(32), span: () => 'b'.repeat(16) }; e.hops = [];
      const r = callTool(e, U, APP('invoices'), 'getItem', { id: form });
      const all = JSON.stringify([r, e.hops, e.snapshot()]);
      const needle = { plainIs: 'hunter2xyz', pwColon: 'Hunter2Secret', passEq: 'Tr0ub4dor', passphrase: 'correct', userinfo: 'hunter2', tokenWord: ['abcdef12', '34567890zz'].join(''), accountKey: ['abcd', 'EFGH1234'].join(''), sessionId: ['00D5g0', '00008dkQz'].join(''), assignment: 'hunter2hunter2', bearer: 'tokenvalue' }[k] || v.slice(4, 16);
      for (const probe of [needle, encodeURIComponent(needle), encodeURIComponent(encodeURIComponent(needle)), needle.replace(/ /g, '%20')]) assert.ok(!all.includes(probe), `${k} (${form === v ? 'plain' : 'encoded'}): ${probe}`);
      assert.ok(e.hops.some((h) => h.request?.request?.path === '/items/{id}'), 'the template is shown');
    }
  }
  for (const [k, v] of [['plainIs', SECRETS.plainIs], ['pwColon', SECRETS.pwColon], ['userinfo', SECRETS.userinfo]]) { // the reviewer's exact repros, over HTTP
    await withServer(async (url) => {
      await act(url, 'oaDeploy', { actor: A, name: 'invoices', spec: sample }, 'b3');
      const r = await act(url, 'mcp', { user: U, target: { kind: 'app', id: 'invoices' }, rpc: { method: 'tools/call', params: { name: 'getItem', arguments: { id: encodeURIComponent(v) } } } }, 'b3');
      assert.ok(!JSON.stringify(r.body).includes(encodeURIComponent(v).slice(0, 24)) && !JSON.stringify(r.body).includes('Tangerine'), k);
      assert.ok(r.body.hops.every((h) => !/%20|%3A/.test(JSON.stringify(h))), `${k}: no percent-encoded typed text in any hop`);
    });
  }
});

// ---- S1: invisible characters and charsets ---------------------------------------------------------------------------------------------------------------
test('S1: every invisible or default-ignorable character is deleted before matching, so none can split a secret (Hangul fillers, variation selectors, tag characters, CGJ, ALM, Mongolian separator, U+FFFD ...)', async () => {
  const key = ['s', 'k-', 'AbCd', 'Ef1234GhIjKl'];
  for (const z of ['ㅤ', 'ﾠ', 'ᅟ', 'ᅠ', '͏', '؜', '᠎', '︀', '️', '⁪', '⁯', '\u{E0001}', '\u{E0041}', '឴', '឵', '�', '​', '⁠', '­']) {
    const text = `x ${key[0]}${z}${key[1]}${z}${key[2]}${key[3]} y`;
    assert.ok(!cleanFree(text).includes('AbCdEf'), JSON.stringify(z));
    assert.ok(!JSON.stringify(maskDeep({ a: text })).includes('AbCdEf'), `${JSON.stringify(z)} in a response`);
  }
  await withServer(async (url) => {
    for (const z of ['ㅤ', 'ﾠ', 'ᅟ', '️', '\u{E0041}', '�']) {
      const r = await post(url, '/api/act/mcp', { mode: 'live', params: { zzz: `x ${key[0]}${z}${key[1]}${z}${key[2]}${key[3]} y` } }); const t = await r.text();
      assert.ok(!t.includes('AbCdEf'), `${JSON.stringify(z)}: ${t.slice(0, 200)}`);
    }
  });
});
test('S1: a body declared in a charset other than UTF-8 (utf-7 decodes a zero-width character to U+FFFD) is refused with 415; utf-8 in any case is fine', async () => {
  await withServer(async (url) => {
    const host = new URL(url).host; const body = JSON.stringify({ mode: 'live', params: { minutes: 1 } });
    for (const ct of ['application/json; charset=utf-7', 'application/json;charset="latin1"', 'application/json; charset=utf-16']) { const r = await rawHttp(`${url}/api/act/advance`, { method: 'POST', headers: { host, origin: url, 'content-type': ct }, body }); assert.equal(r.status, 415, ct); assert.deepEqual(JSON.parse(r.text), { error: 'unsupported_charset' }); }
    for (const ct of ['application/json; charset=utf-8', 'application/json; charset=UTF-8', 'application/json']) assert.equal((await rawHttp(`${url}/api/act/advance`, { method: 'POST', headers: { host, origin: url, 'content-type': ct }, body })).status, 200, ct);
  });
});

// ---- S2: a full audit log refuses WHOLE requests ----------------------------------------------------------------------------------------------------------
test('S2: at a full audit log every action that changes something is refused BEFORE it changes anything (clock, policy, availability, transport, vault, upstream authorization)', () => {
  const e = newEngine();
  while (e.audit.length < 495) e.record('fill');
  const view = () => JSON.stringify({ t: e.t, pol: e.apps[A1].policy, up: e.apps[A5].up, tr: e.apps[A5].transport, vault: e.vault[U2]?.[A1], upstream: Object.keys(e.upstreamAuth), faults: e.faults, apps: Object.keys(e.apps), props: e.proposals.length, audit: e.audit.length });
  const before = view();
  const cases = [['advance', { minutes: 5 }], ['setAppUp', { actor: A, appId: A5, up: false }], ['setTransport', { actor: A, appId: A5, transport: 'streamable-http' }], ['vaultSet', { actor: U2, user: U2, appId: A1, present: true }],
    ['setPolicy', { actor: A, appId: A1, grants: [{ group: 'admins', tools: ['*'] }] }], ['upstreamAuthorize', { user: U, appId: A3 }], ['setFault', { actor: A, hopIgnoresCap: true }], ['setAuth', { actor: A, appId: A1, authMode: 'none' }],
    ['propose', { actor: U, kind: 'mcp', name: 'x1', backend: `https://x.${C.castHost}.example`, authMode: 'none' }], ['mcp', { user: U, target: APP(A1), rpc: { method: 'ping' } }], ['sessionOpen', { user: U, replica: 'replica-a' }]];
  for (const [op, p] of cases) { const r = run(e, op, p); assert.equal(r.code, 'log_full', op); assert.equal(r.status, 507, op); assert.equal(view(), before, `${op} changed state before refusing`); }
  assert.equal(e.snapshot().audit.dropped, 0, 'nothing was dropped silently');
  assert.equal(ok(run(e, 'oaPreview', { spec: sample })).tools.length, 4, 'a pure action still works');
});
test('S2: a refusal that would be audited when there is no room is counted, never silently dropped', () => {
  const e = newEngine(); while (e.audit.length < 500) e.record('fill', {});
  e.deny('policy', {}); e.deny('policy', {});
  assert.equal(e.snapshot().audit.dropped, 2); assert.equal(e.audit.length, 500);
});

// ---- S3: the token cap never consumes a credential ---------------------------------------------------------------------------------------------------------
const mkAuth = () => new AuthServer({ host: C.castHost, docs: cimdDocs(C), allowlist: CIMD_ALLOWLIST_DEFAULT(C) });
const redirect = `https://agent.${C.castHost}.example/callback`;
test('S3: at the token cap a refresh token or a code is NOT consumed: the refusal leaves it valid, a retry gives the same refusal, and expiry frees room', () => {
  const s = mkAuth(); const c = s.register({ clientName: 'c', redirectUris: [redirect] }).client_id;
  const code = (n) => { const a = s.authorize({ clientId: c, redirectUri: redirect, codeChallenge: PKCE_CHALLENGE, codeChallengeMethod: 'S256', scope: ['mcp:tools', 'offline_access'], user: U }, n); return s.token({ grant: 'authorization_code', code: a.code, codeVerifier: PKCE_VERIFIER, clientId: c, redirectUri: redirect }, n); };
  let t = code(0); let refused; let k = 0;
  for (; k < 400; k++) { try { t = s.token({ grant: 'refresh_token', refreshToken: t.refresh_token, clientId: c }, 1); } catch (e) { refused = e; break; } }
  assert.equal(refused.code, 'too_many_tokens');
  const rt = t.refresh_token;
  for (let i = 0; i < 3; i++) assert.throws(() => s.token({ grant: 'refresh_token', refreshToken: rt, clientId: c }, 1), (e) => e.code === 'too_many_tokens', 'the retry gets the same refusal, not invalid_grant');
  assert.equal(s.refresh[rt].used, false, 'the refresh token was not consumed');
  // a pending code is not consumed either
  const a = s.authorize({ clientId: c, redirectUri: redirect, codeChallenge: PKCE_CHALLENGE, codeChallengeMethod: 'S256', scope: ['mcp:tools'], user: U }, 1);
  assert.throws(() => s.token({ grant: 'authorization_code', code: a.code, codeVerifier: PKCE_VERIFIER, clientId: c, redirectUri: redirect }, 1), (e) => e.code === 'too_many_tokens');
  assert.equal(s.codes[a.code].used, false);
  // expired tokens are pruned, so time frees room and the same refresh token still works
  assert.ok(Object.keys(s.access).length + Object.keys(s.refresh).length > 0);
  const later = OAUTH.accessTtl + 5; s.sweep(later);
  assert.equal(Object.keys(s.access).length, 0, 'expired access tokens are pruned');
  assert.equal(typeof s.token({ grant: 'refresh_token', refreshToken: rt, clientId: c }, later).access_token, 'string');
});

// ---- S4: multi-byte text on a stream ----------------------------------------------------------------------------------------------------------------------
test('S4: multi-byte text survives a stream and a compressed stream at every byte offset and every upstream chunk size', () => {
  const text = 'Café 日本語 😀 résumé';
  for (let pad = 0; pad < 36; pad++) {
    const msg = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a', description: `${'x'.repeat(pad)}${text}` }] } };
    for (const style of ['sse', 'gzip-sse', 'json']) {
      const w = encodeAnswer(msg, style); const whole = Buffer.concat(w.chunks);
      for (const size of [1, 3, 7, 23, 31, 40]) {
        const out = filterWire({ headers: w.headers, chunks: splitChunks(whole, size) }, () => true);
        assert.equal(out.messages.find((m) => m.result).result.tools[0].description, `${'x'.repeat(pad)}${text}`, `${style} pad ${pad} chunk ${size}`);
      }
    }
  }
});

// ---- S5: names outside listings, and responses that yield nothing ---------------------------------------------------------------------------------------
const keepOnly = (k, it) => it.name !== 'secret_tool';
const wire = (type, body, enc) => ({ headers: { 'content-type': type, ...(enc ? { 'content-encoding': enc } : {}) }, chunks: splitChunks(Buffer.from(body)) });
const code = (fn) => { try { fn(); return 'passed'; } catch (e) { return e.code; } };
const tools = [{ name: 'ok_tool' }, { name: 'secret_tool' }];
test('S5: a hidden name anywhere else in the response (a notification, error data, structured content, _meta, plain text) refuses the whole response; nested listings are filtered', () => {
  const j = (o) => wire('application/json', JSON.stringify(o));
  const listing = { jsonrpc: '2.0', id: 1, result: { tools } };
  // nested listings are filtered in place
  const nested = filterWire(j({ jsonrpc: '2.0', id: 1, result: { structuredContent: { tools } } }), keepOnly);
  assert.deepEqual(nested.messages[0].result.structuredContent.tools.map((t) => t.name), ['ok_tool']);
  assert.deepEqual(filterWire(j({ jsonrpc: '2.0', method: 'notifications/x', params: { tools } }), keepOnly).messages[0].params.tools.map((t) => t.name), ['ok_tool']);
  assert.deepEqual(filterWire(j({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x', data: { tools } } }), keepOnly).messages[0].error.data.tools.map((t) => t.name), ['ok_tool']);
  // a hidden name that survives anywhere is refused
  assert.equal(code(() => filterWire(j({ jsonrpc: '2.0', id: 1, result: { tools, _meta: { all: ['secret_tool'] } } }), keepOnly)), 'hidden_name_in_frame');
  assert.equal(code(() => filterWire(wire('text/event-stream', `data: ${JSON.stringify(listing)}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: 'ran secret_tool' } })}\n\n`), keepOnly)), 'hidden_name_in_frame');
  assert.equal(code(() => filterWire(j([listing, { jsonrpc: '2.0', id: 2, error: { code: 1, message: 'no secret_tool' } }]), keepOnly)), 'hidden_name_in_frame');
  assert.equal(code(() => filterWire(j({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'ok_tool' }], note: 'fine' } }), keepOnly)), 'passed', 'with nothing hidden nothing is refused');
});
test('S5: a stream whose frames are all dropped (a byte-order mark before data:, DATA: in capitals, only comments, empty) is refused, never passed on empty', () => {
  const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } });
  for (const [n, s] of Object.entries({ bom: `﻿data: ${frame}\n\n`, capitals: `DATA: ${frame}\n\n`, comments: ': a\n\n: b\n\n', empty: '', idRetryOnly: 'id: 5\nretry: 10\n\n' })) assert.equal(code(() => filterWire(wire('text/event-stream', s), keepOnly)), 'unparseable_frame', n);
});

// ---- S6: one path, one application ------------------------------------------------------------------------------------------------------------------------
test('S6: no creation route can take the name of the aggregate or its path; the path still resolves to the aggregate', () => {
  const e = newEngine();
  for (const name of ['all-in-one']) {
    assert.equal(codeOf(run(e, 'oaDeploy', { actor: A, name, spec: sample })), 'name_taken');
    assert.equal(codeOf(run(e, 'catDeploy', { actor: A, entryId: 'kb-search', name })), 'name_taken');
    ok(run(e, 'propose', { actor: U, kind: 'mcp', name, backend: `https://x.${C.castHost}.example`, authMode: 'none' }));
    assert.equal(codeOf(run(e, 'decide', { actor: A2, proposalId: 'prop-0001', decision: 'approve', revision: 1 })), 'name_taken', 'the approval re-validates the name');
    ok(run(e, 'decide', { actor: A2, proposalId: 'prop-0001', decision: 'approve', revision: 1, adjust: { name: 'desk' } }));
    ok(run(e, 'propose', { actor: U, kind: 'mcp', name: 'other', backend: `https://x.${C.castHost}.example`, authMode: 'none' }));
    assert.equal(codeOf(run(e, 'decide', { actor: A2, proposalId: 'prop-0002', decision: 'approve', revision: 1, adjust: { name } })), 'name_taken', 'an adjustment to the aggregate name');
  }
  assert.equal(ok(run(e, 'route', { path: '/all-in-one/mcp' })).kind, 'aggregate');
  assert.ok(!Object.hasOwn(e.apps, 'all-in-one'));
  assert.equal(e.nameInUse('all-in-one'), true); assert.equal(e.nameInUse('brand-new'), false);
});

// ---- S7: recordings never truncate ------------------------------------------------------------------------------------------------------------------------
test('S7: with session logging on, arguments that would not fit a recording are refused whole (413), at each limit exactly; with it off they are not', () => {
  const e = newEngine(); const withArgs = (args) => callTool(e, A, APP(A1), 'search', args);
  ok(run(e, 'setSessionLogging', { actor: A, enabled: true }));
  const sch = (x) => ({ type: 'object', properties: { query: { type: 'string' } } });
  assert.ok(sch);
  // the search tool takes a string: probe the limit check on the strings
  const words = (n) => `${'ab '.repeat(Math.floor((n - 3) / 3))}${'abc'}`.slice(0, n); // n characters of ordinary words (no run is credential-shaped)
  assert.equal(words(300).length, 300);
  assert.equal(codeOf(withArgs({ query: words(300) })), 'ok', '300 characters fit');
  const big = withArgs({ query: `${words(300)}d` }); assert.equal(codeOf(big), 'arguments_too_large_to_record'); assert.equal(big.status, 413);
  assert.equal(e.snapshot().recordings.total, 1, 'only the call that fit was recorded, whole');
  assert.equal(e.snapshot().recordings.shown[0].arguments.query.length, 300);
  ok(run(e, 'setSessionLogging', { actor: A, enabled: false })); assert.equal(codeOf(withArgs({ query: words(900) })), 'ok', 'with logging off nothing needs to fit a recording');
  // the limits themselves, on any value
  const arr = (n) => Array.from({ length: n }, () => 1); const obj = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 1]));
  assert.equal(fitsRecording({ a: arr(12) }), true); assert.equal(fitsRecording({ a: arr(13) }), false);
  assert.equal(fitsRecording(obj(24)), true); assert.equal(fitsRecording(obj(25)), false);
  assert.equal(fitsRecording('x'.repeat(300)), true); assert.equal(fitsRecording('x'.repeat(301)), false);
  assert.equal(fitsRecording({ a: { b: { c: { d: 1 } } } }), true); assert.equal(fitsRecording({ a: { b: { c: { d: { e: { f: 1 } } } } } }), false);
  assert.equal(fitsRecording(undefined), true); assert.equal(fitsRecording({ ['k'.repeat(41)]: 1 }), false);
});

// ---- S8: honest checks and coverage -------------------------------------------------------------------------------------------------------------------------
test('S8a: "unchanged" is computed from what the backend received: a token that still verifies but differs in its last (padding) bits is accepted and reported as CHANGED', () => {
  const e = newEngine(); ok(run(e, 'setAuth', { actor: A, appId: A2N, authMode: 'token-pass' }));
  assert.equal(ok(run(e, 'passThrough', { user: U, appId: A2N })).unchanged, true);
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  e.forward = (tok) => { const last = tok.slice(-1); const i = B64.indexOf(last); return tok.slice(0, -1) + B64[i ^ 1]; }; // same 2048 signature bits, different text
  const r = ok(run(e, 'passThrough', { user: U, appId: A2N }));
  assert.equal(r.accepted, true); assert.equal(r.unchanged, false, 'a hard-coded true would be caught here');
  assert.equal(e.snapshot().credentials.attempts.at(-1).unchanged, false);
});
test('S8b: the member tool filter is part of the cap sent to the member hop (with the aggregate check off, a tool outside the filter is still refused at the hop)', () => {
  const e = newEngine(); ok(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A1, toolFilter: { Elems: ['search'] } }));
  ok(run(e, 'setFault', { actor: A, aggregateSkipsCheck: true }));
  const r = callTool(e, U, AGG, `${A1}__read_record`, { id: 'r-1' });
  assert.equal(codeOf(r), 'access_denied'); assert.equal(r.data.enforcedAt, 'member-hop (aggregate cap)');
  assert.equal(codeOf(callTool(e, U, AGG, `${A1}__search`, { query: 'q' })), 'ok');
  assert.deepEqual(r.data.reason, 'cap');
});
test('S8b: the wire style a call asks for is the style used, and a refusal-free call reports it; a bad style is refused', () => {
  const e = newEngine();
  for (const style of ['json', 'sse', 'gzip', 'gzip-sse']) { const r = ok(callTool(e, U, APP(A1), 'search', { query: 'q' }, { style })); assert.equal(r.wire.style, style); assert.equal(r.operator.frames.length, style.includes('sse') ? 3 : 1, `${style}: streamed answers carry a comment and a notification frame`); }
  assert.equal(codeOf(callTool(e, U, APP(A1), 'search', { query: 'q' }, { style: 'br' })), 'bad_style');
  const agg = ok(callTool(e, U, AGG, `${A1}__search`, { query: 'q' }, { style: 'gzip' })); assert.equal(agg.wire.style, 'json', 'the aggregate itself answers in plain JSON');
});
test('S8b: setTransport sse makes a member hang (and only a member: direct calls are unaffected); streamable-http fixes it; other values are refused', () => {
  const e = newEngine();
  assert.equal(codeOf(callTool(e, U, AGG, `${A1}__search`, { query: 'q' })), 'ok');
  ok(run(e, 'setTransport', { actor: A, appId: A1, transport: 'sse' }));
  assert.equal(codeOf(callTool(e, U, AGG, `${A1}__get_status`)), 'member_timeout'); assert.equal(codeOf(callTool(e, U, APP(A1), 'get_status')), 'ok', 'called directly it still works (measured)');
  assert.match(ok(mcp(e, U, AGG, 'tools/list')).operator.members.find((m) => m.alias === A1).warning, /sse/);
  ok(run(e, 'setTransport', { actor: A, appId: A1, transport: 'streamable-http' })); assert.equal(codeOf(callTool(e, U, AGG, `${A1}__get_status`)), 'ok');
  for (const bad of ['http', 5, '', null]) assert.ok(['bad_transport', 'missing_field'].includes(codeOf(run(e, 'setTransport', { actor: A, appId: A1, transport: bad }))));
  assert.equal(codeOf(run(e, 'setTransport', { actor: U, appId: A1, transport: 'sse' })), 'admin_only');
});
test('S8b: the response-level mask (app.js) is a second line of defence: a credential-shaped value in any answer field is masked even if the engine forgot to clean it', async () => {
  const workspaces = createWorkspaces({ max: 10 });
  await withServer(async (url) => {
    const e = workspaces.engine('default', 'finance', C); const secret = SECRETS.github;
    const real = e.snapshot.bind(e); e.snapshot = () => ({ ...real(), leaked: `oops ${secret}`, nested: { deep: [secret] } });
    const t = await (await get(url, '/api/state?mode=live')).text();
    assert.ok(!t.includes(secret.slice(4, 20))); assert.match(t, /\[masked:github-token\]/);
    const w = await (await post(url, '/api/act/advance', { mode: 'live', params: { minutes: 1 } })).text();
    assert.ok(!w.includes(secret.slice(4, 20)));
  }, { workspaces });
});
test('S8b: the settings of a talk-track entry no longer overclaims: the honesty entry says the masking is a heuristic', async () => {
  const { TALK_TRACK } = await import('../src/data.js');
  assert.match(TALK_TRACK.find((t) => t.id === 'honesty').say, /heuristic/); assert.ok(!/never comes back/.test(JSON.stringify(TALK_TRACK)));
});

// ---- nits -------------------------------------------------------------------------------------------------------------------------------------------------
test('nits: nbf is enforced; exp before iat, an empty jti and an empty sub are refused', () => {
  const base = { iss: 'https://i.example', sub: 'u', aud: 'https://b.example/mcp', iat: 1000, exp: 1100, jti: 'j' }; const trust = { [base.iss]: { 'frontend-1': publicKey('frontend') } };
  const v = (claims, now = 1050) => verify(sign(claims, 'frontend'), { trust, audience: base.aud, now }).code;
  assert.equal(v({ ...base, nbf: 1060 }), 'not_yet_valid'); assert.equal(v({ ...base, nbf: 1040 }), undefined, 'a past nbf is fine'); assert.equal(v({ ...base, nbf: 'x' }), 'not_yet_valid');
  assert.equal(verify(sign({ ...base, iat: 1100, exp: 1090 }, 'frontend'), { trust, audience: base.aud, now: 1085 }).code, 'exp_before_iat');
  assert.equal(v({ ...base, jti: '' }), 'missing_claims'); assert.equal(v({ ...base, sub: '' }), 'missing_claims');
});
test('nits: proposals expire on READ: the view shows expired, amend is refused, and the name is free again, with no one having tried to decide', () => {
  const e = newEngine(); ok(run(e, 'propose', { actor: U, kind: 'mcp', name: 'helpdesk', backend: `https://h.${C.castHost}.example`, authMode: 'none' }));
  for (let i = 0; i < 7; i++) ok(run(e, 'advance', { minutes: 1440 })); assert.equal(e.snapshot().creation.proposals[0].state, 'pending', 'exactly 7 days is still pending');
  ok(run(e, 'advance', { minutes: 1 })); assert.equal(e.snapshot().creation.proposals[0].state, 'expired');
  assert.equal(codeOf(run(e, 'amend', { actor: U, proposalId: 'prop-0001', note: 'x' })), 'not_pending');
  assert.equal(codeOf(run(e, 'propose', { actor: U2, kind: 'mcp', name: 'helpdesk', backend: `https://h.${C.castHost}.example`, authMode: 'none' })), 'ok', 'an expired proposal does not block the name');
});
test('nits: maskDeep keeps an own __proto__ key as data, and the lab never continues a caller-sent trace id', () => {
  const o = JSON.parse('{"__proto__":{"a":"b"},"x":1}'); const m = maskDeep(o);
  assert.equal(Object.keys(m).join(), '__proto__,x'); assert.deepEqual(Object.getOwnPropertyDescriptor(m, '__proto__').value, { a: 'b' }); assert.equal(Object.getPrototypeOf(m), Object.prototype);
  const id = 'f3a9c2e17b4d58a6f0c1e9d27b3a45c8'; const t = newTrace(`00-${id}-${'1'.repeat(16)}-01`); assert.notEqual(t.traceId, id);
});
test('nits: attempts show totals, not a silent window; the page says how many are kept', () => {
  const e = newEngine(); ok(run(e, 'setAuth', { actor: A, appId: A2N, authMode: 'token-pass' }));
  for (let i = 0; i < 45; i++) run(e, 'passThrough', { user: U, appId: A2N, defect: 'expired' });
  const c = e.snapshot().credentials; assert.equal(c.attemptsTotal, 45); assert.equal(c.attemptsKept, 40); assert.equal(c.attempts.length, 20);
});
test('nits: CSP and framing headers are set, and an unknown /assets/ path is a JSON 404 (not the index page)', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'msf-dist-')); fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>x</title>');
  try {
    await withServer(async (url) => {
      const r = await get(url, '/api/health'); assert.match(r.headers.get('content-security-policy'), /default-src 'self'/); assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(r.headers.get('x-frame-options'), 'DENY');
      const a = await rawHttp(`${url}/assets/nope.js`, { headers: { host: new URL(url).host } }); assert.equal(a.status, 404); assert.deepEqual(JSON.parse(a.text), { error: 'not_found' });
      assert.equal((await rawHttp(`${url}/some/page`, { headers: { host: new URL(url).host } })).status, 200);
    }, { webDist: dist });
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});
