// OAuth 2.1: registration, mandatory PKCE with S256 verified for real, single-use codes, rotating refresh tokens, CIMD, discovery metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AuthServer, LIMITS, s256 } from '../src/oauth.js';
import { PKCE_CHALLENGE, PKCE_VERIFIER } from '../src/scenarios.js';
import { cimdDocs, CIMD_ALLOWLIST_DEFAULT } from '../src/world.js';
import { A, C, U, codeOf, newEngine, ok, run } from './helpers.js';

const redirect = `https://agent.${C.castHost}.example/callback`;
const url = (n) => `https://${n}.${C.castHost}.example/client.json`;
const mk = () => new AuthServer({ host: C.castHost, docs: cimdDocs(C), allowlist: CIMD_ALLOWLIST_DEFAULT(C) });
const code = (fn) => { try { fn(); return 'passed'; } catch (e) { return e.code || `threw ${e.message}`; } };
const flow = (s, over = {}, now = 0) => { const c = s.register({ clientName: 'c', redirectUris: [redirect] }); const a = s.authorize({ clientId: c.client_id, redirectUri: redirect, codeChallenge: PKCE_CHALLENGE, codeChallengeMethod: 'S256', scope: ['mcp:tools', 'offline_access'], user: U, ...over }, now); return { client: c.client_id, code: a.code }; };
const exchange = (s, f, over = {}, now = 0) => s.token({ grant: 'authorization_code', code: f.code, codeVerifier: PKCE_VERIFIER, clientId: f.client, redirectUri: redirect, ...over }, now);

test('PKCE S256 is verified for real: the RFC 7636 test vector, and base64url(sha256(verifier)) computed independently', () => {
  assert.equal(PKCE_CHALLENGE, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(s256(PKCE_VERIFIER), crypto.createHash('sha256').update(PKCE_VERIFIER).digest('base64url'));
  const s = mk(); const f = flow(s); const t = exchange(s, f);
  assert.equal(t.token_type, 'Bearer'); assert.ok(t.access_token && t.refresh_token); assert.equal(t.expires_in, LIMITS.accessTtl);
});

test('PKCE is mandatory and S256 only: no challenge, a malformed challenge, "plain" and a missing method are refused at the authorization request', () => {
  const s = mk(); const c = s.register({ clientName: 'c', redirectUris: [redirect] });
  const a = (over) => code(() => s.authorize({ clientId: c.client_id, redirectUri: redirect, user: U, ...over }, 0));
  assert.equal(a({}), 'pkce_required'); assert.equal(a({ codeChallenge: 'short', codeChallengeMethod: 'S256' }), 'pkce_required'); assert.equal(a({ codeChallenge: `${PKCE_CHALLENGE}=`, codeChallengeMethod: 'S256' }), 'pkce_required');
  assert.equal(a({ codeChallenge: PKCE_CHALLENGE, codeChallengeMethod: 'plain' }), 'pkce_s256_required'); assert.equal(a({ codeChallenge: PKCE_CHALLENGE }), 'pkce_s256_required'); assert.equal(a({ codeChallenge: PKCE_CHALLENGE, codeChallengeMethod: 's256' }), 'pkce_s256_required');
  assert.equal(a({ codeChallenge: PKCE_CHALLENGE, codeChallengeMethod: 'S256' }), 'passed');
});

test('the token endpoint rejects a wrong verifier, a wrong-length verifier, a bad charset, a missing one, and a verifier that is the challenge itself (S256 mismatch)', () => {
  for (const v of [`${PKCE_VERIFIER.slice(0, -1)}A`, PKCE_VERIFIER.slice(0, 42), `${PKCE_VERIFIER}${PKCE_VERIFIER}${PKCE_VERIFIER}`, `${PKCE_VERIFIER.slice(0, 40)}***`, undefined, 5, null, PKCE_CHALLENGE, `${'a'.repeat(43)}`]) {
    const s = mk(); const f = flow(s);
    assert.equal(code(() => exchange(s, f, { codeVerifier: v })), 'invalid_grant', String(v).slice(0, 12));
  }
  // a verifier that does not match does not burn the code (RFC 6749 leaves this open; the lab lets the client retry within the ten minutes)
  const s = mk(); const f = flow(s); code(() => exchange(s, f, { codeVerifier: 'a'.repeat(43) }));
  assert.equal(typeof exchange(s, f).access_token, 'string');
});

test('codes are single use, bound to client and redirect URI, and expire after ten minutes; reuse revokes what the first use issued', () => {
  let s = mk(); let f = flow(s); const t = exchange(s, f);
  assert.equal(code(() => exchange(s, f)), 'invalid_grant'); assert.equal(code(() => s.token({ grant: 'refresh_token', refreshToken: t.refresh_token, clientId: f.client }, 1)), 'invalid_grant', 'the tokens from the reused code are gone');
  s = mk(); f = flow(s); assert.equal(code(() => exchange(s, f, { clientId: 'dcr-9999' })), 'invalid_grant'); assert.equal(code(() => exchange(s, f, { redirectUri: `${redirect}x` })), 'invalid_grant');
  s = mk(); f = flow(s); assert.equal(code(() => exchange(s, f, {}, LIMITS.codeTtl)), 'invalid_grant', 'expired exactly at the TTL'); 
  s = mk(); f = flow(s); assert.equal(typeof exchange(s, f, {}, LIMITS.codeTtl - 1).access_token, 'string');
  for (const bad of ['mock-code-9999', '__proto__', undefined, 5, {}]) assert.equal(code(() => s.token({ grant: 'authorization_code', code: bad, codeVerifier: PKCE_VERIFIER, clientId: f.client, redirectUri: redirect }, 0)), 'invalid_grant', String(bad));
});

test('refresh tokens rotate: each use issues a new pair; reuse of an old one revokes the whole family; scope can narrow, never widen', () => {
  const s = mk(); const f = flow(s); const t1 = exchange(s, f);
  const t2 = s.token({ grant: 'refresh_token', refreshToken: t1.refresh_token, clientId: f.client }, 10);
  assert.notEqual(t2.refresh_token, t1.refresh_token); assert.notEqual(t2.access_token, t1.access_token);
  assert.equal(code(() => s.token({ grant: 'refresh_token', refreshToken: t1.refresh_token, clientId: f.client }, 11)), 'invalid_grant', 'reuse detected');
  assert.equal(code(() => s.token({ grant: 'refresh_token', refreshToken: t2.refresh_token, clientId: f.client }, 12)), 'invalid_grant', 'and the newest one in the family is revoked too');
  const s2 = mk(); const f2 = flow(s2); const u1 = exchange(s2, f2);
  assert.equal(code(() => s2.token({ grant: 'refresh_token', refreshToken: u1.refresh_token, clientId: f2.client, scope: ['mcp:tools', 'mcp:read'] }, 1)), 'invalid_scope');
  const narrow = s2.token({ grant: 'refresh_token', refreshToken: u1.refresh_token, clientId: f2.client, scope: ['mcp:tools'] }, 1); assert.equal(narrow.scope, 'mcp:tools'); assert.equal(narrow.refresh_token, undefined, 'offline_access was dropped, so no new refresh token');
  const s3 = mk(); const f3 = flow(s3); const w1 = exchange(s3, f3);
  assert.equal(code(() => s3.token({ grant: 'refresh_token', refreshToken: w1.refresh_token, clientId: 'dcr-9999' }, 1)), 'invalid_grant', 'bound to its client');
  assert.equal(code(() => s3.token({ grant: 'refresh_token', refreshToken: w1.refresh_token, clientId: f3.client }, LIMITS.refreshTtl)), 'invalid_grant', 'expired');
  assert.equal(code(() => s3.token({ grant: 'password' }, 0)), 'unsupported_grant_type');
});

test('without offline_access there is no refresh token; scopes are a known list', () => {
  const s = mk(); const f = flow(s, { scope: ['mcp:tools'] }); assert.equal(exchange(s, f).refresh_token, undefined);
  for (const bad of [['admin'], [], ['mcp:tools', 'mcp:read', 'offline_access', 'x'], 'mcp:tools', [5]]) assert.equal(code(() => flow(s, { scope: bad })), 'invalid_scope', JSON.stringify(bad));
});

test('registration: redirect URIs are https on a reserved host or loopback http with a plain path; bounded; the client count is capped', () => {
  const s = mk(); const reg = (r) => code(() => s.register({ clientName: 'c', redirectUris: r }));
  assert.equal(reg([redirect]), 'passed'); assert.equal(reg(['http://127.0.0.1:8123/cb']), 'passed'); assert.equal(reg(['http://localhost/cb']), 'passed');
  for (const bad of [[], 'x', [5], ['http://real.com/cb'], ['https://real.com/cb'], ['https://x.example/cb?a=1'], ['https://x.example/cb#f'], ['https://u:p@x.example/cb'], ['javascript:alert(1)'], Array(6).fill(redirect), ['https://x.example/' + 'a'.repeat(300)], ['https://x.example/cb\n']]) assert.equal(reg(bad), 'invalid_redirect_uri', JSON.stringify(bad).slice(0, 40));
  const t = mk(); for (let i = 0; i < LIMITS.clients; i++) t.register({ clientName: `c${i}`, redirectUris: [redirect] });
  assert.equal(code(() => t.register({ clientName: 'x', redirectUris: [redirect] })), 'too_many_clients');
});

test('the redirect URI must match exactly, and an unknown client is refused', () => {
  const s = mk(); const c = s.register({ clientName: 'c', redirectUris: [redirect] });
  for (const r of [`${redirect}/`, `${redirect}?x=1`, redirect.replace('https', 'http'), undefined, 5]) assert.equal(code(() => s.authorize({ clientId: c.client_id, redirectUri: r, codeChallenge: PKCE_CHALLENGE, codeChallengeMethod: 'S256', user: U }, 0)), 'invalid_redirect_uri');
  for (const id of ['dcr-9999', '__proto__', 'constructor', undefined, 5, `cimd:${url('agent')}`]) assert.equal(code(() => s.authorize({ clientId: id, redirectUri: redirect, codeChallenge: PKCE_CHALLENGE, codeChallengeMethod: 'S256', user: U }, 0)), 'invalid_client', String(id));
});

test('CIMD: every outcome is a simulated one from a fixed mock document, and each limit is a refusal', () => {
  const s = mk(); const r = (n) => code(() => s.resolveCimd(url(n), 0));
  const want = { notes: 'cimd_client_id_mismatch', big: 'cimd_too_large', slow: 'cimd_fetch_timeout', wrongtype: 'cimd_wrong_content_type', redir: 'cimd_redirect_refused', secret: 'cimd_symmetric_secret_refused', gone: 'cimd_not_found', wild: 'cimd_bad_redirect_uri', unlisted: 'cimd_not_allowlisted', agent: 'passed' };
  for (const [n, c] of Object.entries(want)) assert.equal(r(n), c, n);
  const rec = s.resolveCimd(url('agent'), 1); assert.deepEqual([rec.kind, rec.id, rec.redirectUris], ['cimd', url('agent'), [redirect]]);
  assert.equal(s.cimd.fetches, 9, 'one fetch per allowlisted document, none for the unlisted one');
});

test('CIMD URL form: https, a path, no fragment, no query, no credentials, no dot segments, written plainly; and never fetched for anything else', () => {
  const s = mk(); const r = (u) => code(() => s.resolveCimd(u, 0));
  for (const bad of ['http://agent.fabrikam.example/client.json', 'https://agent.fabrikam.example/', 'https://agent.fabrikam.example', 'https://u:p@agent.fabrikam.example/client.json', 'https://agent.fabrikam.example/client.json#f', 'https://agent.fabrikam.example/client.json?x=1', 'https://agent.fabrikam.example/a/../client.json', 'HTTPS://AGENT.FABRIKAM.EXAMPLE/client.json', 'ftp://x.example/y', 'not a url', '', 5, null, `https://x.example/${'a'.repeat(300)}`]) assert.equal(r(bad), 'invalid_client_id', String(bad).slice(0, 40));
  assert.equal(r('https://elsewhere.example/client.json'), 'cimd_not_allowlisted');
  assert.equal(s.cimd.fetches, 0, 'nothing was fetched for any of them');
});

test('CIMD caching: a hit costs no fetch; a failure is cached too; the cache expires after CacheTTLHours on the lab clock (the field is proven by mutation)', () => {
  const s = mk(); const ttl = s.cimd.cacheTTLHours * 3600;
  s.resolveCimd(url('agent'), 0); s.resolveCimd(url('agent'), ttl - 1); assert.deepEqual([s.cimd.fetches, s.cimd.hits], [1, 1]);
  s.resolveCimd(url('agent'), ttl); assert.equal(s.cimd.fetches, 2, 'refetched exactly at the TTL');
  assert.equal(code(() => s.resolveCimd(url('slow'), 0)), 'cimd_fetch_timeout'); assert.equal(code(() => s.resolveCimd(url('slow'), 10)), 'cimd_fetch_timeout'); assert.equal(s.cimd.fetches, 3, 'the failure was cached, not refetched');
  const q = mk(); q.setCimd({ cacheTTLHours: 1 }); q.resolveCimd(url('agent'), 100000); q.resolveCimd(url('agent'), 100000 + 3599); assert.equal(q.cimd.fetches, 1); q.resolveCimd(url('agent'), 100000 + 3600); assert.equal(q.cimd.fetches, 2, 'a shorter TTL expires sooner');
  for (const bad of [0, 169, 1.5, '3', null, -1]) assert.equal(code(() => s.setCimd({ cacheTTLHours: bad })), 'bad_ttl', String(bad));
});

test('the CIMD allowlist (Clients: URL, IsPrivate) is editable and matters: removing an entry refuses it, adding one admits it; entries are validated', () => {
  const s = mk();
  s.setCimd({ clients: [{ URL: url('agent'), IsPrivate: true }] });
  assert.equal(code(() => s.resolveCimd(url('notes'), 0)), 'cimd_not_allowlisted'); assert.equal(code(() => s.resolveCimd(url('agent'), 0)), 'passed');
  assert.deepEqual(s.snapshot(0).cimd.clients, [{ URL: url('agent'), IsPrivate: true }], 'IsPrivate is stored (its meaning is not stated, so nothing acts on it)');
  s.setCimd({ clients: [{ URL: url('unlisted') }] }); assert.equal(code(() => s.resolveCimd(url('unlisted'), 0)), 'passed');
  for (const bad of ['x', [{ URL: 5 }], [{ URL: 'http://a.example/x' }], [{ URL: url('agent'), extra: 1 }], [{ URL: url('agent'), IsPrivate: 'yes' }], [{ URL: url('agent') }, { URL: url('agent') }], Array(21).fill({ URL: url('agent') }), [null]]) assert.equal(code(() => s.setCimd({ clients: bad })), 'bad_allowlist', JSON.stringify(bad).slice(0, 40));
});

test('discovery metadata advertises S256 only, the two grants, DCR and CIMD support, all on a reserved host', () => {
  const m = mk().metadata(C.castHost);
  assert.deepEqual(m.authorizationServer.code_challenge_methods_supported, ['S256']); assert.deepEqual(m.authorizationServer.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.equal(m.authorizationServer.client_id_metadata_document_supported, true); assert.match(m.authorizationServer.registration_endpoint, /\.example\/register$/);
  assert.deepEqual(m.authorizationServer.token_endpoint_auth_methods_supported, ['none']); assert.ok(!JSON.stringify(m).includes('plain'));
  assert.ok(JSON.stringify(m).match(/https:\/\/[^"]+/g).every((u) => /\.example(\/|$)/.test(u)));
});

test('through the engine: audited, hops recorded, the same refusals, and the clock moves token lifetimes', () => {
  const e = newEngine();
  const c = ok(run(e, 'oauthRegister', { clientName: 'x', redirectUris: [redirect] }));
  const a = ok(run(e, 'oauthAuthorize', { user: U, clientId: c.client_id, redirectUri: redirect, codeChallenge: PKCE_CHALLENGE, codeChallengeMethod: 'S256' }));
  assert.equal(codeOf(run(e, 'oauthToken', { grant: 'authorization_code', code: a.code, codeVerifier: 'a'.repeat(43), clientId: c.client_id, redirectUri: redirect })), 'invalid_grant');
  assert.equal(e.snapshot().oauth.pendingCodes, 1);
  ok(run(e, 'advance', { minutes: 11 })); assert.equal(e.snapshot().oauth.pendingCodes, 0, 'the code expired on the lab clock');
  assert.equal(codeOf(run(e, 'cimdSet', { actor: U, cacheTTLHours: 2 })), 'admin_only'); ok(run(e, 'cimdSet', { actor: A, cacheTTLHours: 2 })); assert.equal(e.snapshot().oauth.cimd.cacheTTLHours, 2);
  assert.ok(e.snapshot().audit.shown.some((x) => x.kind === 'refused' && x.code === 'invalid_grant'));
  assert.equal(e.snapshot().oauth.metadata.authorizationServer.client_id_metadata_document_supported, true);
});
