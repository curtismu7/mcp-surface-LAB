// Backend credential injection (slide 36): none, an app-wide static token, a per-user credential from the User Vault, a full second OAuth flow, and the
// fifth mode, TOKEN PASS-THROUGH: a front-end application acting as an agent mints a short-lived signed assertion naming the end user, itself and the target
// backend; the gateway verifies it and forwards it UNCHANGED; the backend verifies it itself (real RS256, locally generated keys) and scopes its answer to
// the end user. The agent never learns any credential. Every credential value here is a MOCK label with a fingerprint: no value, no real-looking secret.
import crypto from 'node:crypto';
import { refuse } from './errors.js';
import { safeId, take } from './util.js';
import { decode, publicKey, sign, tokenDigest, verify, MAX_LIFETIME_SEC, describeKey } from './jwt.js';
import { fingerprint, iso } from './common.js';
import { BASE_EPOCH } from './world.js';

export const AUTH_MODES = ['none', 'static-token', 'user-token', 'oauth', 'token-pass'];
export const DEFECTS = ['none', 'wrong-audience', 'expired', 'tampered', 'untrusted-issuer', 'replay', 'lifetime-too-long', 'alg-none'];
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const ACCESS_TTL = 900; const REFRESH_TTL = 7 * 86400; const SEEN_MAX = 200; const ATTEMPTS_MAX = 40;

const b64u = (x) => Buffer.from(x).toString('base64url');

export const credentialOps = {
  initCredentials() {
    this.vault = Object.create(null);
    const c = this.cast;
    for (const u of [c.castUser, c.castAdmin]) this.vault[u] = { [c.castApp2]: true };
    this.upstreamAuth = Object.create(null); // `${user}/${app}` -> { accessExpiresAt, refreshExpiresAt, refreshes }
    this.pass = { seen: new Set(), attempts: [], n: 0, total: 0, last: Object.create(null) };
  },
  issuerOf() { return `https://portal.${this.cast.castHost}.example`; },
  audienceOf(app) { return `https://${app.name}.${this.cast.castHost}.example/mcp`; },
  trust() { return { [this.issuerOf()]: { 'frontend-1': publicKey('frontend') } }; },

  setAuth(p) {
    take(p, ['actor', 'appId', 'authMode', 'staticHeader'], ['actor', 'appId']);
    const a = this.admin(p.actor); const app = this.appOf(p.appId);
    if (p.authMode !== undefined) { if (typeof p.authMode !== 'string' || !AUTH_MODES.includes(p.authMode)) throw refuse('bad_auth_mode', `authMode is one of ${AUTH_MODES.join(', ')}`); app.authMode = p.authMode; }
    if (p.staticHeader !== undefined) { if (!safeId(p.staticHeader, HEADER_NAME, 40)) throw refuse('bad_header', 'a header name is letters, digits and hyphens'); app.staticHeader = p.staticHeader; }
    this.record('app.auth', { actor: a.id, app: app.id, authMode: app.authMode, staticHeader: app.staticHeader });
    return { app: app.id, authMode: app.authMode, staticHeader: app.staticHeader };
  },

  // The User Vault is per-user and self-service: nobody else, an administrator included, may set or clear another user's entry (lab 8's rule, applied here).
  vaultSet(p) {
    take(p, ['actor', 'user', 'appId', 'present'], ['actor', 'user', 'appId', 'present']);
    const actor = this.user(p.actor); const owner = this.user(p.user); const app = this.appOf(p.appId);
    if (actor.id !== owner.id) { this.deny('vault_self_service_only', { actor: actor.id }); throw refuse('vault_self_service_only', 'a vault entry can only be set by the user it belongs to: there is no administrator override', 403); }
    if (typeof p.present !== 'boolean') throw refuse('bad_present', 'present is true or false');
    const mine = this.vault[owner.id] || (this.vault[owner.id] = Object.create(null));
    if (p.present) mine[app.id] = true; else delete mine[app.id];
    this.record('vault.set', { actor: actor.id, app: app.id, present: p.present });
    return { user: owner.id, app: app.id, present: p.present };
  },

  upstreamAuthorize(p) {
    take(p, ['user', 'appId'], ['user', 'appId']);
    const u = this.user(p.user); const app = this.appOf(p.appId);
    if (app.authMode !== 'oauth') throw refuse('not_oauth_mode', 'this application does not use a second OAuth flow', 409);
    this.upstreamAuth[`${u.id}/${app.id}`] = { accessExpiresAt: this.now() + ACCESS_TTL, refreshExpiresAt: this.now() + REFRESH_TTL, refreshes: 0 };
    this.hop('user to the member\'s own authorization server (second IdP), per calling user', { user: u.id, app: app.id }, { granted: true, note: 'the same two-IdP brokering and token refresh the gateway applies to any fronted server (deck claim)' });
    this.record('upstream.authorized', { actor: u.id, app: app.id });
    return { user: u.id, app: app.id, state: 'authorized' };
  },
  upstreamRevoke(p) {
    take(p, ['user', 'appId'], ['user', 'appId']);
    const u = this.user(p.user); const app = this.appOf(p.appId);
    delete this.upstreamAuth[`${u.id}/${app.id}`];
    this.record('upstream.revoked', { actor: u.id, app: app.id });
    return { user: u.id, app: app.id, state: 'none' };
  },

  // What the backend receives for one call, and who it believes the caller is. Throws a refusal when the credential cannot be produced.
  inject(app, user, rpc, ctx) {
    const mock = (kind, label) => ({ kind: 'mock', label, fingerprint: fingerprint(`${kind}:${label}`) });
    const hdr = (name, scheme, credential) => ({ name, scheme, credential });
    switch (app.authMode) {
      case 'none': return { identity: { kind: 'anonymous', actor: '(no credential)' }, received: { mode: 'none', headers: [] } };
      case 'static-token': return { identity: { kind: 'service', actor: `service-account:${app.name}` }, received: { mode: 'static-token', headers: [hdr(app.staticHeader, app.staticHeader === 'Authorization' ? 'Bearer' : '', mock('static', `MOCK app-wide token of ${app.name}`))] } };
      case 'user-token': {
        if (!this.vault[user.id]?.[app.id]) { this.deny('no_vault_credential', { user: user.id, app: app.id }); throw refuse('no_vault_credential', `this user has no credential for this application in the User Vault`, 403, { enforcedAt: 'credential injection' }); }
        return { identity: { kind: 'user', actor: user.id }, received: { mode: 'user-token', headers: [hdr(app.staticHeader, app.staticHeader === 'Authorization' ? 'Bearer' : '', mock('vault', `MOCK vault credential of ${user.id} for ${app.name}`))] } };
      }
      case 'oauth': {
        const k = `${user.id}/${app.id}`; const st = this.upstreamAuth[k];
        if (!st || st.refreshExpiresAt <= this.now()) { delete this.upstreamAuth[k]; this.deny('upstream_authorization_required', { user: user.id, app: app.id }); throw refuse('upstream_authorization_required', `this user has not authorized the member's own OAuth server yet`, 401, { enforcedAt: 'credential injection', authorizationUrl: `https://idp2.${this.cast.castHost}.example/authorize` }); }
        let refreshed = false;
        if (st.accessExpiresAt <= this.now()) { st.accessExpiresAt = this.now() + ACCESS_TTL; st.refreshes++; refreshed = true; }
        return { identity: { kind: 'user', actor: user.id }, received: { mode: 'oauth', refreshedThisCall: refreshed, headers: [hdr('Authorization', 'Bearer', mock('oauth', `MOCK upstream access token of ${user.id} for ${app.name}`))] } };
      }
      case 'token-pass': {
        const r = this.presentAssertion(app, user, 'none', rpc);
        return { identity: r.identity, received: r.received };
      }
      default: throw refuse('bad_auth_mode', 'unknown auth mode', 500);
    }
  },

  // The front-end application mints, the gateway verifies and forwards unchanged, the backend verifies on its own and scopes by the end user.
  mintAssertion(app, user, defect) {
    const now = this.now(); const issuer = this.issuerOf(); const aud = this.audienceOf(app);
    const claims = { iss: issuer, sub: user.id, act: { sub: 'frontend-portal' }, aud, iat: now, exp: now + 120, jti: `jti-${String(++this.pass.n).padStart(4, '0')}` };
    if (defect === 'wrong-audience') claims.aud = `https://other-backend.${this.cast.castHost}.example/mcp`;
    if (defect === 'expired') { claims.iat = now - 600; claims.exp = now - 300; }
    if (defect === 'lifetime-too-long') claims.exp = now + 3600;
    if (defect === 'untrusted-issuer') { claims.iss = `https://idp.rogue.example`; return sign(claims, 'rogue'); }
    if (defect === 'alg-none') return `${b64u(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64u(JSON.stringify(claims))}.`;
    const token = sign(claims, 'frontend');
    if (defect === 'tampered') { const [h, , s] = token.split('.'); return `${h}.${b64u(JSON.stringify({ ...claims, sub: this.cast.castAdmin }))}.${s}`; }
    return token;
  },

  presentAssertion(app, user, defect, rpc) {
    const attempt = { n: ++this.pass.total, user: user.id, app: app.id, defect, at: iso(this.t) };
    const push = (a) => { this.pass.attempts.push(a); if (this.pass.attempts.length > ATTEMPTS_MAX) this.pass.attempts.shift(); };
    const key = `${user.id}/${app.id}`;
    let token = defect === 'replay' && this.pass.last[key] ? this.pass.last[key] : this.mintAssertion(app, user, defect === 'replay' ? 'none' : defect);
    const d = decode(token);
    attempt.header = d ? d.header : null; attempt.claims = d ? d.claims : null;
    const minted = tokenDigest(token);
    this.hop('front-end application mints a short-lived signed assertion (RS256)', { for: user.id, target: this.audienceOf(app), defect }, { header: attempt.header, claims: attempt.claims });
    // the gateway verifies, then forwards the SAME bytes
    const g = verify(token, { trust: this.trust(), audience: this.audienceOf(app), now: this.now() });
    if (!g.ok) { push({ ...attempt, stage: 'gateway', verdict: 'refused', code: g.code }); this.deny('assertion_refused', { user: user.id, app: app.id, code: g.code, stage: 'gateway' }); throw refuse(`assertion_${g.code}`, `the gateway refused the assertion (${g.code})`, 401, { enforcedAt: 'gateway (assertion verification)', verifyCode: g.code }); }
    const forwarded = this.forward(token);
    this.hop('gateway verifies and forwards the assertion unchanged', { verified: ['signature', 'issuer', 'audience', 'expiry'] }, { unchanged: tokenDigest(forwarded) === minted });
    // the backend verifies independently: signature, audience, expiry, issuer, and a replayed jti
    const b = verify(forwarded, { trust: this.trust(), audience: this.audienceOf(app), now: this.now() });
    if (!b.ok) { push({ ...attempt, stage: 'backend', verdict: 'refused', code: b.code, unchanged: tokenDigest(forwarded) === minted }); throw refuse(`assertion_${b.code}`, `the backend refused the assertion (${b.code})`, 401, { enforcedAt: 'backend (assertion verification)', verifyCode: b.code }); }
    if (this.pass.seen.has(b.claims.jti)) { push({ ...attempt, stage: 'backend', verdict: 'refused', code: 'replay', unchanged: tokenDigest(forwarded) === minted }); this.deny('assertion_refused', { user: user.id, app: app.id, code: 'replay', stage: 'backend' }); throw refuse('assertion_replay', 'the backend refused the assertion: this jti was already used (replay)', 401, { enforcedAt: 'backend (replay check)', verifyCode: 'replay' }); }
    if (this.pass.seen.size >= SEEN_MAX) throw refuse('replay_cache_full', `the backend's replay cache holds ${SEEN_MAX} assertions: reset to start over`, 507);
    this.pass.seen.add(b.claims.jti); this.pass.last[key] = token;
    const unchanged = tokenDigest(forwarded) === minted;
    push({ ...attempt, stage: 'accepted', verdict: 'accepted', code: '', unchanged });
    this.record('assertion.accepted', { actor: user.id, app: app.id, jti: b.claims.jti });
    return { identity: { kind: 'assertion', actor: b.claims.sub }, received: { mode: 'token-pass', headers: [{ name: 'Authorization', scheme: 'Bearer', credential: { kind: 'mock', label: `MOCK signed assertion naming ${b.claims.sub} for ${app.name}`, fingerprint: fingerprint(`assertion:${b.claims.jti}`) } }], assertion: { forwardedUnchanged: unchanged, claims: b.claims } }, token, unchanged, claims: b.claims, header: b.header };
  },
  // The gateway's forwarding step: the exact bytes it received. (A gateway that re-serialised the claims would change them: the digest check would show it.)
  forward(token) { return String(token); },

  // The pass-through demonstration, as its own action: one attempt (two for a replay), the token shown (mock-issued) with its decoded header and claims.
  passThrough(p) {
    take(p, ['user', 'appId', 'defect'], ['user', 'appId']);
    const u = this.user(p.user); const app = this.appOf(p.appId);
    if (app.authMode !== 'token-pass') throw refuse('not_token_pass_mode', 'this application is not in token-pass mode', 409);
    const defect = p.defect === undefined ? 'none' : p.defect;
    if (typeof defect !== 'string' || !DEFECTS.includes(defect)) throw refuse('bad_defect', `defect is one of ${DEFECTS.join(', ')}`);
    this.assertRoom();
    const key = `${u.id}/${app.id}`;
    let primed = null;
    if (defect === 'replay' && !this.pass.last[key]) primed = this.presentAssertion(app, u, 'none');
    const r = this.presentAssertion(app, u, defect);
    const out = this.upstreamView(app, r.identity);
    return { user: u.id, app: app.id, defect, primedFirst: !!primed, accepted: true, unchanged: r.unchanged, mockToken: r.token, mockTokenLabel: 'mock-issued assertion, signed with a throwaway local RSA key', header: r.header, claims: r.claims, keyInfo: describeKey('frontend'), backendSaw: r.received, backendIdentity: r.identity, agentSees: { credential: 'none', note: 'the agent receives only the tool result' }, backendAnswer: out };
  },
  upstreamView(app, identity) { const rows = this.seedRecords(identity); return { identifiedCaller: identity.actor, recordsReturned: rows.length, scopedToEndUser: identity.kind === 'assertion' }; },
  seedRecords(identity) { const all = this.recordList(); return identity.kind === 'service' || identity.kind === 'anonymous' ? all : all.filter((r) => r.owner === identity.actor); },

  credentialsView() {
    return {
      modes: AUTH_MODES, defects: DEFECTS, maxAssertionLifetimeSec: MAX_LIFETIME_SEC, issuer: this.issuerOf(),
      vault: Object.fromEntries(Object.entries(this.vault).map(([u, m]) => [u, Object.keys(m)])),
      upstream: Object.entries(this.upstreamAuth).map(([k, v]) => ({ key: k, accessExpiresAt: iso(v.accessExpiresAt - BASE_EPOCH), refreshes: v.refreshes, state: v.accessExpiresAt > this.now() ? 'authorized' : 'access token expired (refreshes on next call)' })),
      attemptsTotal: this.pass.total, attemptsKept: this.pass.attempts.length, attempts: this.pass.attempts.slice(-20).map((a) => ({ n: a.n, user: a.user, app: a.app, defect: a.defect, stage: a.stage, verdict: a.verdict, code: a.code, unchanged: a.unchanged ?? null, claims: a.claims })), replayCache: this.pass.seen.size,
    };
  },
};
