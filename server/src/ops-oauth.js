// Standards-based authorization and CIMD (slide 36) as engine operations. The authorization server itself is oauth.js.
import { InputError, refuse } from './errors.js';
import { take } from './util.js';
import { SCOPES } from './oauth.js';

// A refusal from the authorization server is written to the audit log (the code only, never the caller's text).
function guarded(self, kind, fn) {
  try { return fn(); } catch (e) { if (e instanceof InputError) self.deny(e.code, { during: kind }); throw e; }
}

export const oauthOps = {
  oauthRegister(p) {
    take(p, ['clientName', 'redirectUris'], ['redirectUris']);
    const r = guarded(this, 'oauth.register', () => this.auth.register(p));
    this.hop('dynamic client registration (RFC 7591)', { redirectUris: p.redirectUris.length }, { client_id: r.client_id, token_endpoint_auth_method: r.token_endpoint_auth_method });
    this.record('oauth.register', { client: r.client_id });
    return r;
  },
  cimdSet(p) {
    take(p, ['actor', 'clients', 'cacheTTLHours'], ['actor']);
    const a = this.admin(p.actor);
    const r = this.auth.setCimd(p);
    this.record('cimd.config', { actor: a.id, ...r });
    return r;
  },
  // Resolve a CIMD client_id URL: allowlist, cache, (simulated) fetch, document validation.
  cimdResolve(p) {
    take(p, ['clientId'], ['clientId']);
    const before = this.auth.cimd.fetches;
    const rec = guarded(this, 'cimd.resolve', () => this.auth.resolveCimd(p.clientId, this.now()));
    const fetched = this.auth.cimd.fetches > before;
    this.hop('CIMD: the gateway fetches, validates and caches the client document (simulated: a fixed mock document, never fetched)', { clientId: p.clientId }, { fetched, cached: !fetched, redirectUris: rec.redirectUris.length });
    this.record('cimd.resolve', { client: rec.id, fetched });
    return { clientId: rec.id, name: rec.name, redirectUris: rec.redirectUris, fetched, cacheHit: !fetched };
  },
  oauthAuthorize(p) {
    take(p, ['user', 'clientId', 'redirectUri', 'codeChallenge', 'codeChallengeMethod', 'scope'], ['user', 'clientId']);
    const u = this.user(p.user);
    const r = guarded(this, 'oauth.authorize', () => this.auth.authorize({ ...p, user: u.id }, this.now()));
    this.hop('authorization request with PKCE (S256)', { client: p.clientId, method: p.codeChallengeMethod }, { code: r.code });
    this.record('oauth.authorize', { actor: u.id });
    return r;
  },
  oauthToken(p) {
    take(p, ['grant', 'code', 'codeVerifier', 'clientId', 'redirectUri', 'refreshToken', 'scope'], ['grant']);
    const r = guarded(this, 'oauth.token', () => this.auth.token(p, this.now()));
    this.hop(`token endpoint: ${p.grant}`, { grant: p.grant }, { token_type: r.token_type, scope: r.scope, refreshToken: !!r.refresh_token });
    this.record('oauth.token', { grant: p.grant });
    return r;
  },
  oauthMetadata() { return this.auth.metadata(this.cast.castHost); },
};
export { refuse, SCOPES };
