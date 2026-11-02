// Literal-number boundary tests: for every limit the lab states, N is accepted and N+1 is refused (or the clock reads exactly N). The numbers are written out here
// ON PURPOSE, not read from the code, so changing a limit in the code fails a test until the page, the README and this file agree. (Second review, finding S6.)
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { A, AGG, APP, C, U, callTool, codeOf, newEngine, ok, run, withServer } from './helpers.js';
import { Engine, LIMITS as ENGINE_LIMITS } from '../src/engine.js';
import { AuthServer, LIMITS as OAUTH_LIMITS, s256 } from '../src/oauth.js';
import { LIMITS, expandedNodes, generateTools, parseSpec } from '../src/openapi.js';
import { MAX_TOKEN, decode, sign, publicKey, verify } from '../src/jwt.js';
import { MAX_FREE, cleanFree, findCredentials } from '../src/credentials.js';
import { maskResponseText } from '../src/mask.js';
import { MAX_WIRE, SseParser, filterWire } from '../src/wire.js';
import { createWorkspaces } from '../src/workspaces.js';
import { CATALOG } from '../src/world.js';

const code = (fn) => { try { fn(); return 'passed'; } catch (e) { return e.code || `threw ${e.message}`; } };
const doc = (paths, extra = {}) => JSON.stringify({ openapi: '3.0.3', info: { title: 'T', version: '1' }, paths, ...extra });

test('the stated limits are the ones written here (a change of a limit fails this until the tests, the page and the README are updated together)', () => {
  assert.deepEqual(ENGINE_LIMITS, { audit: 500, recordings: 200, apps: 30, members: 12, hops: 40, clockMinutes: 1440, clockTotalDays: 90, grants: 8, listNames: 80 });
  assert.deepEqual(OAUTH_LIMITS, { clients: 20, redirectUris: 5, codes: 50, tokens: 120, cimdBytes: 5120, cimdEntries: 20, codeTtl: 600, accessTtl: 900, refreshTtl: 604800, ttlHoursMax: 168 });
  assert.deepEqual(LIMITS, { expandNodes: 1500, expandTotal: 20000, chars: 40000, depth: 40, nodes: 20000, paths: 100, operations: 60, params: 25, refDepth: 12, schemaChars: 8000, argsChars: 8000, enumItems: 50, requiredItems: 60, allOfBranches: 10, paramEntries: 80, securitySchemes: 10 });
  assert.equal(MAX_TOKEN, 4096); assert.equal(MAX_FREE, 400); assert.equal(MAX_WIRE, 1_000_000);
});

// ---- engine.js ---------------------------------------------------------------------------------------------------------------------------------
test('audit log: an action is refused when FEWER THAN 8 entries remain (492 entries: accepted, 493: refused 507), record() stops at 500, a refusal note is dropped and counted at 500', () => {
  const fill = (n) => { const e = newEngine(); e.audit = Array.from({ length: n }, (_, i) => ({ n: i })); return e; };
  assert.equal(codeOf(run(fill(492), 'advance', { minutes: 1 })), 'ok', '492 entries + 8 headroom = 500: room');
  const full = run(fill(493), 'advance', { minutes: 1 });
  assert.equal(full.code, 'log_full'); assert.equal(full.status, 507);
  const e499 = fill(499); e499.record('x'); assert.equal(e499.audit.length, 500);
  assert.throws(() => e499.record('y'), (err) => err.code === 'log_full', '500 entries: record() refuses');
  const d499 = fill(499); d499.deny('c'); assert.equal(d499.audit.length, 500); assert.equal(d499.auditDropped, 0);
  const d500 = fill(500); d500.deny('c'); assert.equal(d500.audit.length, 500); assert.equal(d500.auditDropped, 1);
});

test('tool arguments: 8000 characters of JSON are accepted, 8001 are refused (413); an aggregate tool name of 200 characters is read, 201 is refused; a JSON-RPC method of 40 characters is read, 41 is refused', () => {
  const e = newEngine();
  const tool = { inputSchema: { type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } }, additionalProperties: false, required: [] } };
  const argsOf = (n) => { const make = (len) => ({ a: [...Array.from({ length: 7 }, () => 'x'.repeat(1000)), 'y'.repeat(len)] }); const a = make(n - JSON.stringify(make(0)).length); assert.equal(JSON.stringify(a).length, n); return a; };
  assert.doesNotThrow(() => e.validateToolArgs(tool, argsOf(8000)));
  assert.throws(() => e.validateToolArgs(tool, argsOf(8001)), (err) => err.code === 'invalid_arguments' && err.status === 413);
  const alias = C.castApp1;
  const agg = (n) => run(e, 'mcp', { user: U, target: AGG, rpc: { method: 'tools/call', params: { name: `${alias}__${'x'.repeat(n - alias.length - 2)}` } } });
  assert.notEqual(agg(200).code, 'bad_rpc', 'a 200-character name gets as far as the policy'); assert.equal(agg(201).code, 'bad_rpc');
  const m = (n) => run(e, 'mcp', { user: U, target: APP(C.castApp1), rpc: { method: 'x'.repeat(n) } });
  assert.notEqual(m(40).code, 'bad_rpc'); assert.equal(m(41).code, 'bad_rpc');
});

test('the application cap: the 30th application is created, the 31st is refused, at all three places that create one (approve, oaDeploy, catDeploy)', () => {
  const filled = (to) => { const e = newEngine(); for (let i = Object.keys(e.apps).length; i < to; i++) e.putApp({ id: `fill-${i}`, name: `fill-${i}`, kind: 'created', source: 'test', upstream: null, up: true, transport: 'streamable-http', authMode: 'none', staticHeader: 'Authorization', entryPath: `/fill-${i}/mcp`, policy: { grants: [] } }); assert.equal(Object.keys(e.apps).length, to); return e; };
  const spec = doc({ '/a': { get: { operationId: 'a' } } });
  const propose = (e) => { ok(run(e, 'propose', { actor: U, kind: 'mcp', name: 'newapp', backend: `https://b.${C.castHost}.example/mcp`, authMode: 'none' })); return () => run(e, 'decide', { actor: A, proposalId: 'prop-0001', decision: 'approve', revision: 1 }); };
  for (const [site, attempt] of [
    ['approve', (e) => propose(e)()],
    ['oaDeploy', (e) => run(e, 'oaDeploy', { actor: A, name: 'newapp', spec })],
    ['catDeploy', (e) => run(e, 'catDeploy', { actor: A, entryId: CATALOG[0].id, name: 'newapp' })],
  ]) {
    assert.equal(codeOf(attempt(filled(29))), 'ok', `${site}: the 30th application`);
    const r = attempt(filled(30)); assert.equal(r.code, 'too_many_apps', `${site}: the 31st`); assert.equal(r.status, 409);
  }
});

// ---- jwt.js ------------------------------------------------------------------------------------------------------------------------------------
test('assertion verification: iat may be 5 seconds ahead (not 6), nbf 5 seconds ahead (not 6), a lifetime of 300 seconds is allowed (not 301)', () => {
  const now = 1_800_000_000; const iss = 'https://portal.x.example'; const audience = 'https://a.x.example/mcp';
  const trust = { [iss]: { 'frontend-1': publicKey('frontend') } };
  const check = (over) => verify(sign({ iss, sub: 'u', aud: audience, jti: 'j1', iat: now, exp: now + 100, ...over }, 'frontend'), { trust, audience, now });
  assert.equal(check({ iat: now + 5, exp: now + 105 }).ok, true); assert.equal(check({ iat: now + 6, exp: now + 106 }).code, 'issued_in_the_future');
  assert.equal(check({ nbf: now + 5 }).ok, true); assert.equal(check({ nbf: now + 6 }).code, 'not_yet_valid');
  assert.equal(check({ iat: now, exp: now + 300 }).ok, true); assert.equal(check({ iat: now, exp: now + 301 }).code, 'lifetime_too_long');
  assert.equal(check({ exp: now }).code, 'expired', 'exp equal to now is expired'); assert.equal(check({ exp: now + 1 }).ok, true);
});

test('a token of 4096 characters is read, one of 4097 is not (decode)', () => {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sig = 'A'.repeat(342);
  const make = (pad, hpad) => `${b({ alg: 'RS256', typ: 'JWT', kid: 'k', ...(hpad ? { h: 'h'.repeat(hpad) } : {}) })}.${b({ sub: 'u', pad: 'p'.repeat(pad) })}.${sig}`;
  const find = (target) => { for (let h = 0; h < 4; h++) for (let p = 0; p < 4200; p++) { const t = make(p, h); if (t.length === target) return t; if (t.length > target) break; } throw new Error(`no token of ${target}`); };
  const t4096 = find(4096); const t4097 = find(4097);
  assert.equal(t4096.length, 4096); assert.ok(decode(t4096)); assert.equal(t4097.length, 4097); assert.equal(decode(t4097), null);
});

// ---- the lab clock: credentials ----------------------------------------------------------------------------------------------------------------
const advanceTo = (e, minutes) => { for (let left = minutes; left > 0; left -= 1440) ok(run(e, 'advance', { minutes: Math.min(left, 1440) })); };
const upstreamState = (e) => e.credentialsView().upstream[0]?.state;

test('second OAuth flow: the access token lasts exactly 15 minutes (14 authorized, 15 expired), the refresh token exactly 7 days (7 days minus a minute works, 7 days is refused)', () => {
  const e = newEngine(); ok(run(e, 'upstreamAuthorize', { user: U, appId: C.castApp3 }));
  advanceTo(e, 14); assert.equal(upstreamState(e), 'authorized');
  advanceTo(e, 1); assert.match(upstreamState(e), /access token expired/);
  assert.equal(codeOf(callTool(e, U, APP(C.castApp3), 'list_cases')), 'ok', 'a call refreshes the access token');
  assert.equal(upstreamState(e), 'authorized'); advanceTo(e, 14); assert.equal(upstreamState(e), 'authorized'); advanceTo(e, 1); assert.match(upstreamState(e), /access token expired/);
  const early = newEngine(); ok(run(early, 'upstreamAuthorize', { user: U, appId: C.castApp3 })); advanceTo(early, 7 * 1440 - 1);
  assert.equal(codeOf(callTool(early, U, APP(C.castApp3), 'list_cases')), 'ok', '7 days minus a minute: the refresh token still works');
  const late = newEngine(); ok(run(late, 'upstreamAuthorize', { user: U, appId: C.castApp3 })); advanceTo(late, 7 * 1440);
  const r = callTool(late, U, APP(C.castApp3), 'list_cases'); assert.equal(r.code, 'upstream_authorization_required'); assert.equal(r.status, 401);
});

test('the pass-through assertion carries a 120-second lifetime', () => {
  const e = newEngine(); const r = ok(run(e, 'setAuth', { actor: A, appId: C.castApp1, authMode: 'token-pass' }));
  const p = ok(run(e, 'passThrough', { user: U, appId: C.castApp1 }));
  assert.equal(r.authMode, 'token-pass'); assert.equal(p.claims.exp - p.claims.iat, 120);
});

// ---- oauth.js ----------------------------------------------------------------------------------------------------------------------------------
const redirect = 'https://app.x.example/cb';
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const server = (opts = {}) => new AuthServer({ host: 'x', docs: {}, allowlist: [], ...opts });
const authz = (s, client, now) => s.authorize({ clientId: client, redirectUri: redirect, codeChallenge: s256(verifier), codeChallengeMethod: 'S256', scope: ['mcp:tools'], user: 'u' }, now);
const exchange = (s, client, code, now) => s.token({ grant: 'authorization_code', code, codeVerifier: verifier, clientId: client, redirectUri: redirect }, now);

test('OAuth: 20 registered clients, the 21st is refused', () => {
  const s = server(); for (let i = 0; i < 20; i++) s.register({ clientName: `c${i}`, redirectUris: [redirect] });
  assert.equal(code(() => s.register({ clientName: 'c20', redirectUris: [redirect] })), 'too_many_clients');
});

test('OAuth: 5 redirect URIs, not 6; 50 pending authorization codes, the 51st refused; a USED code takes no slot (N3)', () => {
  const s = server(); const c = s.register({ clientName: 'c', redirectUris: Array.from({ length: 5 }, (_, i) => `https://app${i}.x.example/cb`) }).client_id;
  assert.equal(code(() => s.register({ clientName: 'd', redirectUris: Array.from({ length: 6 }, (_, i) => `https://app${i}.x.example/cb`) })), 'invalid_redirect_uri');
  const c1 = s.register({ clientName: 'c1', redirectUris: [redirect] }).client_id;
  const codes = []; for (let i = 0; i < 50; i++) codes.push(authz(s, c1, 1000).code);
  assert.equal(code(() => authz(s, c1, 1000)), 'too_many_codes', 'the 51st pending code');
  assert.equal(s.snapshot(1000).pendingCodes, 50);
  exchange(s, c1, codes[0], 1000); // one is used: it is no longer pending
  assert.equal(s.snapshot(1000).pendingCodes, 49);
  assert.equal(typeof authz(s, c1, 1000).code, 'string', 'a slot is free again');
  assert.equal(code(() => authz(s, c1, 1000)), 'too_many_codes');
  assert.ok(c);
});

test('OAuth: 120 live tokens, the 121st is refused before the code is consumed', () => {
  const s = server(); const c = s.register({ clientName: 'c', redirectUris: [redirect] }).client_id;
  for (let i = 0; i < 120; i++) exchange(s, c, authz(s, c, 1000).code, 1000);
  const extra = authz(s, c, 1000).code;
  assert.equal(code(() => exchange(s, c, extra, 1000)), 'too_many_tokens');
  assert.equal(code(() => exchange(s, c, extra, 1000)), 'too_many_tokens', 'the code is still unused');
});

test('OAuth: a code lives 600 seconds (599 works, 600 is refused), an access token 900 (899 live, 900 gone), a refresh token 7 days (7 days minus a second works, 7 days is refused)', () => {
  const s = server(); const c = s.register({ clientName: 'c', redirectUris: [redirect] }).client_id;
  const a = authz(s, c, 1000); assert.equal(a.expires_in, 600);
  assert.equal(typeof exchange(s, c, a.code, 1599).access_token, 'string');
  const b = authz(s, c, 1000); assert.equal(code(() => exchange(s, c, b.code, 1600)), 'invalid_grant');
  const t = exchange(s, c, authz(s, c, 2000).code, 2000); assert.equal(t.expires_in, 900);
  assert.equal(s.snapshot(2899).liveAccessTokens, 1); assert.equal(s.snapshot(2900).liveAccessTokens, 0);
  const withRefresh = (now) => { const code1 = s.authorize({ clientId: c, redirectUri: redirect, codeChallenge: s256(verifier), codeChallengeMethod: 'S256', scope: ['mcp:tools', 'offline_access'], user: 'u' }, now).code; return exchange(s, c, code1, now); };
  const r1 = withRefresh(5000); const week = 7 * 86400;
  assert.equal(typeof s.token({ grant: 'refresh_token', refreshToken: r1.refresh_token, clientId: c }, 5000 + week - 1).access_token, 'string');
  const r2 = withRefresh(5000);
  assert.equal(code(() => s.token({ grant: 'refresh_token', refreshToken: r2.refresh_token, clientId: c }, 5000 + week)), 'invalid_grant');
});

test('CIMD: a client document of 5120 bytes is accepted, 5121 is refused; an allowlist of 20 entries is accepted, 21 is refused; the cache holds 20 documents, a 21st is refused; CacheTTLHours 168 is accepted, 169 is refused', () => {
  const url = (n) => `https://c${n}.x.example/client.json`;
  const docFor = (n, size) => ({ outcome: 'ok', contentType: 'application/json', size, doc: { client_id: url(n), client_name: 'c', redirect_uris: [`https://c${n}.x.example/cb`] } });
  const s = server({ docs: { [url(1)]: docFor(1, 5120), [url(2)]: docFor(2, 5121) }, allowlist: [{ URL: url(1), IsPrivate: false }, { URL: url(2), IsPrivate: false }] });
  assert.equal(s.resolveCimd(url(1), 1000).id, url(1)); assert.equal(code(() => s.resolveCimd(url(2), 1000)), 'cimd_too_large');
  const list = (n) => Array.from({ length: n }, (_, i) => ({ URL: url(i), IsPrivate: false }));
  assert.equal(s.setCimd({ clients: list(20) }).clients, 20); assert.equal(code(() => s.setCimd({ clients: list(21) })), 'bad_allowlist');
  assert.equal(s.setCimd({ cacheTTLHours: 168 }).cacheTTLHours, 168); assert.equal(code(() => s.setCimd({ cacheTTLHours: 169 })), 'bad_ttl');
  const c = server({ allowlist: list(21).slice(0, 20) });
  for (let i = 0; i < 20; i++) assert.equal(code(() => c.resolveCimd(url(i), 1000)), 'cimd_not_found');
  c.setCimd({ clients: list(21).slice(1) }); // url(20) joins the allowlist
  assert.equal(code(() => c.resolveCimd(url(20), 1000)), 'cimd_cache_full', 'the 21st cached document');
  assert.equal(code(() => c.resolveCimd(url(5), 1000)), 'cimd_not_found', 'a document already cached is still answered from the cache');
});

// ---- openapi.js --------------------------------------------------------------------------------------------------------------------------------
test('OpenAPI size limits: 40000 characters accepted, 40001 refused; 60 operations accepted, 61 refused; 100 paths accepted, 101 refused', () => {
  const base = doc({ '/a': { get: { operationId: 'a' } } });
  assert.equal(code(() => parseSpec(base + ' '.repeat(40000 - base.length))), 'passed'); assert.equal(code(() => parseSpec(base + ' '.repeat(40001 - base.length))), 'spec_too_large');
  const ops = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`/o${i}`, { get: { operationId: `o${i}` } }]));
  assert.equal(code(() => generateTools(parseSpec(doc(ops(60))))), 'passed'); assert.equal(code(() => generateTools(parseSpec(doc(ops(61))))), 'too_many_operations');
  const paths = (n) => ({ '/a': { get: { operationId: 'a' } }, ...Object.fromEntries(Array.from({ length: n - 1 }, (_, i) => [`/e${i}`, {}])) });
  assert.equal(code(() => generateTools(parseSpec(doc(paths(100))))), 'passed'); assert.equal(code(() => generateTools(parseSpec(doc(paths(101))))), 'too_many_paths');
});

test('OpenAPI nesting: 40 levels of [] and {} are accepted, 41 are refused; 20000 nodes are accepted and 20001 refused (the node limit is out of reach of a 40000-character document, so it is driven by raising the character limit for this test)', () => {
  const nested = (k) => `{"openapi":"3.0.3","info":{"title":"T","version":"1"},"paths":{},"x-pad":${'{"a":'.repeat(k - 1)}{}${'}'.repeat(k - 1)}}`;
  // the root object is level 1, so x-pad nests k levels on top of it: k = 39 gives a deepest level of 40
  assert.equal(code(() => parseSpec(nested(39))), 'passed'); assert.equal(code(() => parseSpec(nested(40))), 'spec_too_deep');
  const keep = LIMITS.chars; LIMITS.chars = 10_000_000;
  try {
    const withNodes = (n) => JSON.stringify({ openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: {}, 'x-pad': Array.from({ length: n - 4 }, () => ({})) }); // root, info, paths, x-pad array + the rest
    assert.equal(code(() => parseSpec(withNodes(20000))), 'passed'); assert.equal(code(() => parseSpec(withNodes(20001))), 'spec_too_large');
  } finally { LIMITS.chars = keep; }
});

// A query parameter whose schema is a $ref to an object with m properties costs 2 + m units of schema work (the reference, the object, each property). The property names are
// distinct letters that all read as "p_" once made into an identifier, so the generated schema stays small (1500 distinct properties would be over the 8000-character schema
// limit long before the work limit), and the schemas are shared components, so the document stays under the 40000-character limit.
const unitsOp = (schemaUnits, tag, ms = new Set()) => {
  const P = Math.ceil(schemaUnits / 62); let rest = schemaUnits; const params = [];
  for (let i = 0; i < P; i++) { const m = Math.min(60, rest - 2 - 2 * (P - 1 - i)); ms.add(m); params.push({ name: `${tag}q${i}`, in: 'query', schema: { $ref: `#/components/schemas/M${m}` } }); rest -= 2 + m; }
  assert.equal(rest, 0); return params;
};
const components = (ms) => ({ components: { schemas: Object.fromEntries([...ms].map((m) => [`M${m}`, { type: 'object', properties: Object.fromEntries(Array.from({ length: m }, (_, j) => [`p${String.fromCharCode(0x100 + j)}`, { type: 'string' }])) }])) } });
test('expansion budget: one tool may use 1500 units of schema work (1500 accepted, 1501 refused), a whole document 20000 (20000 accepted, 20001 refused); each parameter list entry is a unit too', () => {
  const one = (units) => { const ms = new Set(); return doc({ '/a': { get: { operationId: 'a', parameters: unitsOp(units, 'a', ms) } } }, components(ms)); };
  assert.equal(code(() => generateTools(parseSpec(one(1500)))), 'passed'); assert.equal(expandedNodes(), 1500 + 25, '1500 units of schema + 25 parameter list entries');
  assert.equal(code(() => generateTools(parseSpec(one(1501)))), 'schema_too_large');
  // twenty operations of 984 schema units + 16 list entries = 1000 units each = 20000
  const many = (last) => { const ms = new Set(); return doc(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`/t${i}`, { get: { operationId: `t${i}`, parameters: unitsOp(i === 19 ? last : 984, `t${i}`, ms) } }])), components(ms)); };
  assert.equal(code(() => generateTools(parseSpec(many(984)))), 'passed'); assert.equal(expandedNodes(), 20000);
  assert.equal(code(() => generateTools(parseSpec(many(985)))), 'schema_too_large');
});

test('OpenAPI shape limits: 25 parameters accepted, 26 refused; 60 properties accepted, 61 refused; 12 nested $ref hops accepted, 13 refused', () => {
  const qs = (n) => Array.from({ length: n }, (_, i) => ({ name: `q${i}`, in: 'query' }));
  assert.equal(code(() => generateTools(parseSpec(doc({ '/a': { get: { operationId: 'a', parameters: qs(25) } } })))), 'passed');
  assert.equal(code(() => generateTools(parseSpec(doc({ '/a': { get: { operationId: 'a', parameters: qs(26) } } })))), 'too_many_parameters');
  const props = (n) => doc({ '/a': { get: { operationId: 'a', parameters: [{ name: 'o', in: 'query', schema: { type: 'object', properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { type: 'string' }])) } }] } } });
  assert.equal(code(() => generateTools(parseSpec(props(60)))), 'passed'); assert.equal(code(() => generateTools(parseSpec(props(61)))), 'spec_too_large');
  const chain = (hops) => { const schemas = {}; for (let i = 1; i <= hops; i++) schemas[`S${i}`] = i === hops ? { type: 'string' } : { $ref: `#/components/schemas/S${i + 1}` }; return doc({ '/a': { get: { operationId: 'a', parameters: [{ name: 'q', in: 'query', schema: { $ref: '#/components/schemas/S1' } }] } } }, { components: { schemas } }); };
  assert.equal(code(() => generateTools(parseSpec(chain(12)))), 'passed'); assert.equal(code(() => generateTools(parseSpec(chain(13)))), 'spec_too_deep');
});

test('OpenAPI tool schema size: 8000 characters accepted, 8001 refused', () => {
  const pad = (n) => { if (n === 0) return ''; const t = 'abcdefghi '.repeat(Math.ceil(n / 10)).slice(0, n); return t.endsWith(' ') ? `${t.slice(0, -1)}x` : t; }; // exactly n characters, readable words, no trailing space
  const spec = (extra) => {
    const params = Array.from({ length: 25 }, (_, i) => ({ name: `parameter_name_with_padding_${String.fromCharCode(97 + i)}`, in: 'query', schema: { type: 'string', ...(i === 0 ? { enum: Array.from({ length: 50 }, (_x, j) => `option number ${j} of the fifty allowed values`) } : {}), description: `d${pad(Math.max(0, Math.min(190, extra - i * 190)))}` } }));
    return doc({ '/a': { get: { operationId: 'a', parameters: params } } });
  };
  // the generated schema grows by exactly one character per extra character of description: find the extra that gives 8000
  const lengthAt = (extra) => { try { return JSON.stringify(generateTools(parseSpec(spec(extra))).tools[0].inputSchema).length; } catch (e) { return e.code; } };
  let lo = 0; let hi = 4750;
  while (lo < hi) { const mid = Math.floor((lo + hi + 1) / 2); const l = lengthAt(mid); if (typeof l === 'number' && l <= 8000) lo = mid; else hi = mid - 1; }
  assert.equal(lengthAt(lo), 8000, 'a document whose tool schema is exactly 8000 characters long'); assert.equal(lengthAt(lo + 1), 'schema_too_large');
});

// ---- workspaces.js, the body, the wire, the text limits ----------------------------------------------------------------------------------------
test('workspaces: 200 are held, the 201st is refused (503); a workspace lives exactly 1 hour untouched (3600000 ms stays, 3600001 ms goes)', () => {
  const ws = createWorkspaces(); for (let i = 0; i < 200; i++) ws.engine(`w${i}`, 'finance', C);
  assert.equal(code(() => ws.engine('w200', 'finance', C)), 'workspace_limit'); assert.equal(ws.size(), 200);
  let t = 0; const timed = createWorkspaces({ now: () => t }); timed.engine('a', 'finance', C); // made at t = 0
  t = 3_600_000; assert.ok(timed.peek('a', 'finance'), 'an hour exactly: still there');
  t = 3_600_001; assert.equal(timed.peek('a', 'finance'), null, 'an hour and a millisecond: gone');
});

test('the JSON body limit is 64 KiB: 65536 bytes are read, 65537 are refused (413)', async () => {
  await withServer(async (url) => {
    const body = (n) => { const j = '{"mode":"live","params":{"minutes":1}}'; return j + ' '.repeat(n - j.length); };
    const ok1 = await fetch(`${url}/api/act/advance`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: body(65536) });
    assert.equal(ok1.status, 200);
    const big = await fetch(`${url}/api/act/advance`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: body(65537) });
    assert.equal(big.status, 413); assert.equal((await big.json()).error, 'payload_too_large');
  });
});

test('the upstream wire limit is 1,000,000 bytes: exactly that is read, one more is refused (plain, gzip, and a streamed parser buffer)', () => {
  const msg = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}';
  const padded = (n) => Buffer.from(msg + ' '.repeat(n - msg.length));
  const plain = (n) => ({ headers: { 'content-type': 'application/json' }, chunks: [padded(n)] });
  const gz = (n) => ({ headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, chunks: [zlib.gzipSync(padded(n))] });
  assert.equal(code(() => filterWire(plain(1_000_000), () => true)), 'passed'); assert.equal(code(() => filterWire(plain(1_000_001), () => true)), 'response_too_large');
  assert.equal(code(() => filterWire(gz(1_000_000), () => true)), 'passed'); assert.equal(code(() => filterWire(gz(1_000_001), () => true)), 'bad_encoding');
  assert.equal(code(() => new SseParser().push('x'.repeat(1_000_000))), 'passed'); assert.equal(code(() => new SseParser().push('x'.repeat(1_000_001))), 'response_too_large');
});

test('free text is cut at exactly 400 characters (after masking); the shared masker reads every character, so a token at any offset is masked', () => {
  const words = (n) => 'w '.repeat(Math.ceil(n / 2)).slice(0, n - 1) + 'w';
  assert.equal(cleanFree(words(400)).length, 400); assert.equal(cleanFree(words(400)), words(400)); assert.equal(cleanFree(words(401)).length, 400); assert.equal(cleanFree(words(401)), words(401).slice(0, 400));
  const tokenAt = (at) => `${' '.repeat(at)}${['gh', 'p_a1B2c3D4e5F6g7H8i9J0'].join('')}`; // a prefixed token starting at `at`
  for (const at of [0, 199_990, 200_000, 300_000]) {
    assert.equal(findCredentials(tokenAt(at)).length, 1, `read at ${at}`);
    assert.ok(maskResponseText(tokenAt(at)).includes('[masked:prefix-token]'), `the response mask reads every character it sends: ${at}`);
  }
  assert.ok(!cleanFree(tokenAt(300_000), 400).includes('a1B2c3D4'), 'masked before the cut');
});
