// Backend credential injection (five modes) and token pass-through with real RS256: every failure case, who refuses it, and what each side sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decode, keyPair, sign, tokenDigest, verify, publicKey } from '../src/jwt.js';
import { A, A1, A2N, A3, APP, C, U, U2, callTool, codeOf, newEngine, ok, run } from './helpers.js';

const trustFor = (iss) => ({ [iss]: { 'frontend-1': publicKey('frontend') } });
const base = { iss: 'https://issuer.example', sub: 'u', aud: 'https://b.example/mcp', iat: 1000, exp: 1100, jti: 'j1' };

test('RS256: a signed token verifies; the key is RSA 2048 and never EC', () => {
  const t = sign(base, 'frontend');
  const r = verify(t, { trust: trustFor(base.iss), audience: base.aud, now: 1050 });
  assert.equal(r.ok, true); assert.equal(r.header.alg, 'RS256'); assert.equal(r.claims.sub, 'u');
  const k = keyPair('frontend'); assert.equal(k.publicKey.asymmetricKeyType, 'rsa'); assert.equal(k.publicKey.asymmetricKeyDetails.modulusLength, 2048);
});

test('verification refuses, each with its own reason: tampered payload, wrong key, wrong audience, expired, future, too long, missing claims, untrusted issuer, unknown kid', () => {
  const trust = trustFor(base.iss); const v = (t, o = {}) => verify(t, { trust, audience: base.aud, now: 1050, ...o }).code;
  const good = sign(base, 'frontend'); const [h, p, s] = good.split('.');
  assert.equal(v(`${h}.${Buffer.from(JSON.stringify({ ...base, sub: 'admin' })).toString('base64url')}.${s}`), 'bad_signature', 'tampered payload');
  assert.equal(v(sign(base, 'rogue', { kid: 'frontend-1' })), 'bad_signature', 'signed by another key but claiming the right kid');
  assert.equal(v(sign(base, 'rogue')), 'unknown_key', 'a key id the issuer does not publish');
  assert.equal(v(good, { audience: 'https://other.example/mcp' }), 'wrong_audience');
  assert.equal(v(good, { now: 1100 }), 'expired'); assert.equal(v(good, { now: 5000 }), 'expired');
  assert.equal(v(sign({ ...base, iat: 2000, exp: 2100 }, 'frontend')), 'issued_in_the_future');
  assert.equal(v(sign({ ...base, exp: 1000 + 3600 }, 'frontend')), 'lifetime_too_long');
  assert.equal(v(sign({ ...base, jti: undefined }, 'frontend')), 'missing_claims'); assert.equal(v(sign({ ...base, sub: 5 }, 'frontend')), 'missing_claims');
  assert.equal(v(sign({ ...base, exp: undefined }, 'frontend')), 'missing_time_claims');
  assert.equal(v(sign({ ...base, iss: 'https://other-issuer.example' }, 'frontend')), 'untrusted_issuer');
  assert.equal(verify(sign({ ...base, aud: [base.aud, 'x'] }, 'frontend'), { trust, audience: base.aud, now: 1050 }).ok, true, 'an audience list that contains ours is accepted');
});

test('only RS256 is accepted: none, HS256 (algorithm confusion with the public key as the secret), ES256 and a missing alg are refused', () => {
  const trust = trustFor(base.iss); const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const pay = b64(base);
  const none = `${b64({ alg: 'none', typ: 'JWT' })}.${pay}.`;
  const pub = keyPair('frontend').publicKey.export({ type: 'spki', format: 'pem' });
  const hs = `${b64({ alg: 'HS256', typ: 'JWT', kid: 'frontend-1' })}.${pay}.${crypto.createHmac('sha256', pub).update(`${b64({ alg: 'HS256', typ: 'JWT', kid: 'frontend-1' })}.${pay}`).digest('base64url')}`;
  for (const t of [none, hs, `${b64({ alg: 'ES256' })}.${pay}.AAAA`, `${b64({})}.${pay}.AAAA`, `${b64({ alg: 'rs256', kid: 'frontend-1' })}.${pay}.AAAA`]) assert.equal(verify(t, { trust, audience: base.aud, now: 1050 }).code, 'alg_not_allowed');
});

test('malformed tokens are refused without throwing: wrong part count, bad characters, non-JSON, oversize, non-strings, __proto__ issuer', () => {
  const trust = trustFor(base.iss);
  for (const t of ['', 'a.b', 'a.b.c.d', '!!.@@.##', 'x'.repeat(5000), null, undefined, 5, {}, 'eyJ.eyJ.sig', `${Buffer.from('{}').toString('base64url')}.${Buffer.from('[]').toString('base64url')}.AA`]) assert.equal(verify(t, { trust, audience: base.aud, now: 1050 }).ok, false, String(t).slice(0, 20));
  const pro = sign({ ...base, iss: '__proto__' }, 'frontend');
  assert.equal(verify(pro, { trust, audience: base.aud, now: 1050 }).code, 'untrusted_issuer', 'an issuer named like a prototype key is not trusted');
  assert.equal(decode('a.b.c'), null);
});

test('the five modes: what the backend receives and whether it can tell who acted', () => {
  const e = newEngine();
  const read = (user, app = A1) => ok(callTool(e, user, APP(app), 'read_record', { id: 'r-1' }));
  // static-token: every user is the same service account (and the backend returns the record regardless of who asked)
  const s1 = read(U); const s2 = read(U2);
  assert.deepEqual([s1.operator.backendIdentity.kind, s1.operator.credential.mode], ['service', 'static-token']);
  assert.equal(s1.operator.credential.headers[0].credential.fingerprint, s2.operator.credential.headers[0].credential.fingerprint, 'the same app-wide value for everyone');
  assert.match(s2.rpc.result.content[0].text, /"found":true/, 'user2 reads user1\'s record: the backend cannot tell who asked');
  assert.ok(!JSON.stringify(s1.rpc).includes('MOCK') && !JSON.stringify(s1.rpc).includes('Authorization'), 'the agent never sees the credential');
  // user-token: the user's own vault credential, and the backend sees the person
  ok(run(e, 'setAuth', { actor: A, appId: A1, authMode: 'user-token' }));
  ok(run(e, 'vaultSet', { actor: U, user: U, appId: A1, present: true })); ok(run(e, 'vaultSet', { actor: U2, user: U2, appId: A1, present: true }));
  const v1 = read(U); const v2 = read(U2);
  assert.notEqual(v1.operator.credential.headers[0].credential.fingerprint, v2.operator.credential.headers[0].credential.fingerprint, 'a different credential per user');
  assert.match(v1.rpc.result.content[0].text, /"identifiedCaller":"maya.chen"/); assert.match(v2.rpc.result.content[0].text, /"found":false/, 'the backend scopes to the person it can see');
  // none
  ok(run(e, 'setAuth', { actor: A, appId: A1, authMode: 'none' }));
  assert.deepEqual(read(U).operator.credential.headers, []); assert.equal(read(U).operator.backendIdentity.kind, 'anonymous');
});

test('the User Vault is self-service: nobody, an administrator included, sets another user\'s entry; a missing entry is refused before the backend', () => {
  const e = newEngine();
  ok(run(e, 'setAuth', { actor: A, appId: A1, authMode: 'user-token' }));
  assert.equal(codeOf(callTool(e, U2, APP(A1), 'read_record', { id: 'r-3' })), 'no_vault_credential');
  const r = run(e, 'vaultSet', { actor: A, user: U2, appId: A1, present: true });
  assert.equal(codeOf(r), 'vault_self_service_only'); assert.equal(r.status, 403);
  assert.equal(codeOf(callTool(e, U2, APP(A1), 'read_record', { id: 'r-3' })), 'no_vault_credential', 'still none');
  ok(run(e, 'vaultSet', { actor: U2, user: U2, appId: A1, present: true }));
  assert.equal(codeOf(callTool(e, U2, APP(A1), 'read_record', { id: 'r-3' })), 'ok');
  ok(run(e, 'vaultSet', { actor: U2, user: U2, appId: A1, present: false }));
  assert.equal(codeOf(callTool(e, U2, APP(A1), 'read_record', { id: 'r-3' })), 'no_vault_credential', 'removing the entry removes access');
  assert.equal(codeOf(run(e, 'vaultSet', { actor: U2, user: U2, appId: A1, present: 'yes' })), 'bad_present');
  assert.ok(e.snapshot().audit.shown.some((x) => x.kind === 'refused' && x.code === 'vault_self_service_only' && x.actor === A));
});

test('the second OAuth flow, per user: not authorized, authorized, access token expiry refreshes, refresh expiry needs authorizing again', () => {
  const e = newEngine();
  const call = (u) => codeOf(callTool(e, u, APP(A3), 'list_cases'));
  assert.equal(call(U), 'upstream_authorization_required');
  ok(run(e, 'upstreamAuthorize', { user: U, appId: A3 }));
  assert.equal(call(U), 'ok'); assert.equal(call(U2), 'upstream_authorization_required', 'per user');
  ok(run(e, 'advance', { minutes: 20 }));
  const r = ok(callTool(e, U, APP(A3), 'list_cases')); assert.equal(r.operator.credential.refreshedThisCall, true, 'the access token expired and was refreshed');
  assert.equal(ok(callTool(e, U, APP(A3), 'list_cases')).operator.credential.refreshedThisCall, false);
  assert.equal(e.snapshot().credentials.upstream[0].refreshes, 1);
  for (let i = 0; i < 8; i++) ok(run(e, 'advance', { minutes: 1440 }));
  assert.equal(call(U), 'upstream_authorization_required', 'the refresh lifetime (7 days) is over');
  ok(run(e, 'upstreamAuthorize', { user: U, appId: A3 })); ok(run(e, 'upstreamRevoke', { user: U, appId: A3 }));
  assert.equal(call(U), 'upstream_authorization_required');
  assert.equal(codeOf(run(e, 'upstreamAuthorize', { user: U, appId: A1 })), 'not_oauth_mode');
});

test('every editable credential field matters: authMode (each of the five) and the header name', () => {
  const e = newEngine();
  const mode = (m) => ok(run(e, 'setAuth', { actor: A, appId: A1, authMode: m }));
  for (const m of ['none', 'static-token', 'user-token', 'oauth', 'token-pass']) { mode(m); assert.equal(e.snapshot().apps.find((a) => a.id === A1).authMode, m); }
  mode('static-token');
  assert.equal(ok(callTool(e, U, APP(A1), 'search', { query: 'q' })).operator.credential.headers[0].name, 'Authorization');
  ok(run(e, 'setAuth', { actor: A, appId: A1, staticHeader: 'X-Api-Key' }));
  const h = ok(callTool(e, U, APP(A1), 'search', { query: 'q' })).operator.credential.headers[0]; assert.deepEqual([h.name, h.scheme], ['X-Api-Key', '']);
  for (const bad of ['bad name', 'x\nz', '', 'a'.repeat(41), 5, '1abc']) assert.equal(codeOf(run(e, 'setAuth', { actor: A, appId: A1, staticHeader: bad })), 'bad_header', String(bad));
  assert.equal(codeOf(run(e, 'setAuth', { actor: A, appId: A1, authMode: 'obo' })), 'bad_auth_mode', 'obo is in the swagger but not modelled here');
  assert.equal(codeOf(run(e, 'setAuth', { actor: U, appId: A1, authMode: 'none' })), 'admin_only');
});

const pass = (e, defect, user = U) => run(e, 'passThrough', { user, appId: A2N, defect });
const tokenPassEngine = () => { const e = newEngine(); ok(run(e, 'setAuth', { actor: A, appId: A2N, authMode: 'token-pass' })); return e; };

test('pass-through: a valid assertion is verified by the gateway, forwarded UNCHANGED, verified again by the backend, and scopes the answer to the end user', () => {
  const e = tokenPassEngine();
  const r = ok(pass(e, 'none'));
  assert.equal(r.accepted, true); assert.equal(r.unchanged, true);
  assert.deepEqual([r.claims.sub, r.claims.act.sub, r.claims.aud], [U, 'frontend-portal', `https://${A2N}.${C.castHost}.example/mcp`]);
  assert.equal(r.header.alg, 'RS256'); assert.equal(r.claims.exp - r.claims.iat, 120);
  assert.deepEqual(r.backendIdentity, { kind: 'assertion', actor: U });
  assert.deepEqual(r.backendAnswer, { identifiedCaller: U, recordsReturned: 2, scopedToEndUser: true }, 'two of the four records belong to this user');
  // the token really verifies with the lab's public key, and a bit flipped anywhere breaks it
  assert.equal(verify(r.mockToken, { trust: { [r.claims.iss]: { 'frontend-1': publicKey('frontend') } }, audience: r.claims.aud, now: e.now() }).ok, true);
  const flipped = `${r.mockToken.slice(0, -4)}${r.mockToken.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
  assert.equal(verify(flipped, { trust: { [r.claims.iss]: { 'frontend-1': publicKey('frontend') } }, audience: r.claims.aud, now: e.now() }).code, 'bad_signature');
  assert.match(r.mockTokenLabel, /mock-issued/); assert.deepEqual(r.agentSees, { credential: 'none', note: 'the agent receives only the tool result' });
  assert.equal(r.keyInfo.alg, 'RS256'); assert.equal(r.keyInfo.bits, 2048); assert.ok(!JSON.stringify(r).includes('PRIVATE'));
  // a call through the gateway with a token-pass app works and the backend sees the end user
  const c = ok(callTool(e, U, APP(A2N), 'search', { query: 'q' }));
  assert.equal(c.operator.backendIdentity.actor, U); assert.equal(c.operator.credential.assertion.forwardedUnchanged, true);
});

test('the forwarding step is checked by digest: if the gateway changed one byte the page would say "changed" (mutation of the forward step is caught)', () => {
  const e = tokenPassEngine();
  const t = sign({ ...base }, 'frontend');
  assert.equal(tokenDigest(e.forward(t)), tokenDigest(t));
  e.forward = (tok) => `${tok}x`; // a gateway that rewrote the token
  const r = pass(e, 'none'); assert.equal(r.ok, false, 'the backend refuses bytes that differ from what was signed');
  assert.equal(e.snapshot().credentials.attempts.at(-1).unchanged, false, 'and the page says the token was changed');
});

test('pass-through failures: each is refused, with the right code, by the right party, and leaves the replay cache untouched', () => {
  const e = tokenPassEngine();
  const want = { 'wrong-audience': ['assertion_wrong_audience', 'gateway'], expired: ['assertion_expired', 'gateway'], tampered: ['assertion_bad_signature', 'gateway'], 'untrusted-issuer': ['assertion_untrusted_issuer', 'gateway'], 'alg-none': ['assertion_alg_not_allowed', 'gateway'], 'lifetime-too-long': ['assertion_lifetime_too_long', 'gateway'] };
  for (const [defect, [code, who]] of Object.entries(want)) {
    const r = pass(e, defect);
    assert.equal(codeOf(r), code, defect); assert.equal(r.status, 401, defect); assert.match(r.data.enforcedAt, new RegExp(who), defect);
  }
  assert.equal(e.snapshot().credentials.replayCache, 0, 'a refused assertion is never remembered');
  assert.equal(codeOf(pass(e, 'bogus')), 'bad_defect');
  assert.equal(codeOf(run(e, 'passThrough', { user: U, appId: A1 })), 'not_token_pass_mode');
  assert.equal(codeOf(run(e, 'passThrough', { user: 'nobody', appId: A2N })), 'unknown_user');
  const att = e.snapshot().credentials.attempts; assert.equal(att.length, 6); assert.ok(att.every((a) => a.verdict === 'refused'));
});

test('replay: the first presentation is accepted, the second is refused by the BACKEND (the gateway does not track jti); a fresh assertion works again', () => {
  const e = tokenPassEngine();
  const r = pass(e, 'replay');
  assert.equal(codeOf(r), 'assertion_replay'); assert.match(r.data.enforcedAt, /backend/);
  const att = e.snapshot().credentials.attempts; assert.deepEqual(att.map((a) => [a.verdict, a.code]), [['accepted', ''], ['refused', 'replay']]);
  assert.equal(att[1].claims.jti, att[0].claims.jti, 'the same jti');
  assert.equal(codeOf(pass(e, 'none')), 'ok', 'a newly minted assertion has a new jti');
  assert.equal(e.snapshot().credentials.replayCache, 2);
  // the replay cache is bounded and refuses rather than forgetting
  const small = tokenPassEngine();
  for (let i = 0; i < 200; i++) ok(pass(small, 'none'));
  assert.equal(codeOf(pass(small, 'none')), 'replay_cache_full');
});

test('the assertion expires on the lab clock: a token minted now is refused after its 120 seconds', () => {
  const e = tokenPassEngine();
  const r = ok(pass(e, 'none'));
  const trust = { [r.claims.iss]: { 'frontend-1': publicKey('frontend') } };
  assert.equal(verify(r.mockToken, { trust, audience: r.claims.aud, now: e.now() + 119 }).ok, true);
  assert.equal(verify(r.mockToken, { trust, audience: r.claims.aud, now: e.now() + 121 }).code, 'expired');
});

test('a credential value is never shown: every credential in an answer is a labelled MOCK with a fingerprint, never a value', () => {
  const e = newEngine();
  for (const m of ['static-token', 'user-token']) { ok(run(e, 'setAuth', { actor: A, appId: A1, authMode: m })); ok(run(e, 'vaultSet', { actor: U, user: U, appId: A1, present: true })); }
  const r = ok(callTool(e, U, APP(A1), 'search', { query: 'q' }));
  const cred = r.operator.credential.headers[0].credential;
  assert.deepEqual(Object.keys(cred).sort(), ['fingerprint', 'kind', 'label']); assert.equal(cred.kind, 'mock'); assert.match(cred.label, /^MOCK /); assert.match(cred.fingerprint, /^[0-9a-f]{8}$/);
});
