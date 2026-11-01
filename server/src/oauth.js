// A small OAuth 2.1 authorization server, real in its logic and local in everything else: dynamic client registration, CIMD (client ID metadata document)
// registration from mock documents, MANDATORY PKCE with S256 verified for real (code_challenge = base64url(sha256(verifier))), single-use authorization
// codes, refresh tokens that rotate (reuse of an old one revokes the whole family), and discovery metadata. Time is the lab clock (seconds), passed in.
// LAB RULE: no fetch ever. A CIMD "fetch" reads a fixed mock document keyed by an .example URL and applies the limits as simulated outcomes.
import crypto from 'node:crypto';
import { refuse } from './errors.js';
import { cleanFree } from './credentials.js';
import { credentialShaped, isObj } from './util.js';

export const LIMITS = { clients: 20, redirectUris: 5, codes: 50, tokens: 120, cimdBytes: 5120, cimdEntries: 20, codeTtl: 600, accessTtl: 900, refreshTtl: 7 * 86400, ttlHoursMax: 168 };
export const SCOPES = ['mcp:tools', 'mcp:read', 'offline_access'];
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/; // base64url of a SHA-256 digest is exactly 43 characters
const REDIRECT = /^(?:https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:example|invalid)(?::\d{2,5})?|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{2,5})?)(?:\/[A-Za-z0-9._~/-]{0,100})?$/;

export const s256 = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class AuthServer {
  constructor({ host, docs, allowlist }) {
    this.issuer = `https://auth.${host}.example`;
    this.docs = docs; // url -> fixed mock outcome (never fetched)
    this.cimd = { clients: allowlist.map((c) => ({ ...c })), cacheTTLHours: 24, cache: {}, fetches: 0, hits: 0 };
    this.clients = {}; this.codes = {}; this.access = {}; this.refresh = {}; this.n = { client: 0, code: 0, access: 0, refresh: 0, family: 0 };
  }

  // ---- registration -------------------------------------------------------------------------------------------------------------------------
  validRedirects(list) {
    if (!Array.isArray(list) || list.length < 1 || list.length > LIMITS.redirectUris) throw refuse('invalid_redirect_uri', `give 1 to ${LIMITS.redirectUris} redirect URIs`);
    for (const u of list) if (typeof u !== 'string' || u.length > 200 || !REDIRECT.test(u) || credentialShaped(u)) throw refuse('invalid_redirect_uri', 'a redirect URI must be https on a reserved .example or .invalid host, or http on loopback, with a plain path');
    return [...list];
  }
  register({ clientName, redirectUris }) {
    if (Object.keys(this.clients).length >= LIMITS.clients) throw refuse('too_many_clients', `the lab holds at most ${LIMITS.clients} clients: reset to start over`, 409);
    const uris = this.validRedirects(redirectUris);
    const id = `dcr-${String(++this.n.client).padStart(4, '0')}`;
    this.clients[id] = { id, kind: 'dcr', name: cleanFree(clientName ?? 'client', 60) || 'client', redirectUris: uris, authMethod: 'none' };
    return { client_id: id, token_endpoint_auth_method: 'none', redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'] };
  }

  // ---- CIMD ---------------------------------------------------------------------------------------------------------------------------------
  setCimd({ clients, cacheTTLHours }) {
    if (clients !== undefined) {
      if (!Array.isArray(clients) || clients.length > LIMITS.cimdEntries) throw refuse('bad_allowlist', `the allowlist takes at most ${LIMITS.cimdEntries} entries`);
      const next = [];
      for (const c of clients) {
        if (!isObj(c) || Object.keys(c).some((k) => k !== 'URL' && k !== 'IsPrivate') || typeof c.URL !== 'string' || (c.IsPrivate !== undefined && typeof c.IsPrivate !== 'boolean')) throw refuse('bad_allowlist', 'each entry is { URL, IsPrivate }');
        const u = this.cimdUrl(c.URL, 'bad_allowlist');
        if (next.some((x) => x.URL === u)) throw refuse('bad_allowlist', 'an entry is listed twice');
        next.push({ URL: u, IsPrivate: c.IsPrivate === true });
      }
      this.cimd.clients = next;
    }
    if (cacheTTLHours !== undefined) {
      if (!Number.isInteger(cacheTTLHours) || cacheTTLHours < 1 || cacheTTLHours > LIMITS.ttlHoursMax) throw refuse('bad_ttl', `CacheTTLHours is a whole number from 1 to ${LIMITS.ttlHoursMax}`);
      this.cimd.cacheTTLHours = cacheTTLHours;
    }
    return { clients: this.cimd.clients.length, cacheTTLHours: this.cimd.cacheTTLHours };
  }
  // The URL form a CIMD client_id must have: https, a host, a path, no fragment, no userinfo, no dot segments, no credential-shaped text.
  cimdUrl(raw, code = 'invalid_client_id') {
    if (typeof raw !== 'string' || raw.length > 200) throw refuse(code, 'a client ID metadata URL is a short https URL');
    let u; try { u = new URL(raw); } catch { throw refuse(code, 'the client_id is not a URL'); }
    if (u.protocol !== 'https:') throw refuse(code, 'a client ID metadata URL must be https');
    if (u.username || u.password || u.hash || u.pathname === '/' || u.pathname === '' || /(^|\/)\.\.?(\/|$)/.test(u.pathname) || u.search) throw refuse(code, 'a client ID metadata URL has a path, no fragment, no query, no credentials and no dot segments');
    if (u.href !== raw || credentialShaped(raw)) throw refuse(code, 'the URL must be written in its plain form');
    return raw;
  }
  // Resolve a CIMD client_id: allowlist, then cache, then the (simulated) fetch, then the document checks. Returns the client record.
  resolveCimd(url, now) {
    const u = this.cimdUrl(url);
    if (!this.cimd.clients.some((c) => c.URL === u)) throw refuse('cimd_not_allowlisted', 'the tenant has not allowlisted this client ID metadata URL', 403);
    const c = this.cimd.cache[u];
    if (c && c.expiresAt > now) { this.cimd.hits++; if (c.error) throw refuse(c.error, 'the cached outcome for this client document is a refusal', 400); return this.clients[`cimd:${u}`]; }
    if (Object.keys(this.cimd.cache).length >= LIMITS.cimdEntries && !c) throw refuse('cimd_cache_full', 'the document cache is full: reset to start over', 409);
    this.cimd.fetches++;
    const entry = { fetchedAt: now, expiresAt: now + this.cimd.cacheTTLHours * 3600 };
    const fail = (code, status = 400) => { this.cimd.cache[u] = { ...entry, error: code }; delete this.clients[`cimd:${u}`]; throw refuse(code, `the client document was refused (${code})`, status); };
    const m = Object.hasOwn(this.docs, u) ? this.docs[u] : null;
    if (!m || m.outcome === 'not_found') return fail('cimd_not_found', 404);
    if (m.outcome === 'timeout') return fail('cimd_fetch_timeout', 504);
    if (m.outcome === 'redirect') return fail('cimd_redirect_refused', 502);
    if (String(m.contentType).split(';')[0].trim().toLowerCase() !== 'application/json') return fail('cimd_wrong_content_type', 502);
    if (m.size > LIMITS.cimdBytes) return fail('cimd_too_large', 502);
    const d = m.doc;
    if (!isObj(d) || d.client_id !== u) return fail('cimd_client_id_mismatch');
    if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== 'none') return fail('cimd_symmetric_secret_refused');
    if (Object.hasOwn(d, 'client_secret')) return fail('cimd_symmetric_secret_refused');
    try { this.validRedirects(d.redirect_uris); } catch { return fail('cimd_bad_redirect_uri'); }
    this.cimd.cache[u] = { ...entry };
    const rec = { id: u, kind: 'cimd', name: cleanFree(d.client_name ?? 'client', 60), redirectUris: [...d.redirect_uris], authMethod: 'none' };
    this.clients[`cimd:${u}`] = rec;
    return rec;
  }
  client(id, now) {
    if (typeof id !== 'string' || id.length > 200) throw refuse('invalid_client', 'unknown client');
    if (id.startsWith('https://')) return this.resolveCimd(id, now);
    if (!Object.hasOwn(this.clients, id) || this.clients[id].kind !== 'dcr') throw refuse('invalid_client', 'unknown client', 401);
    return this.clients[id];
  }

  // ---- authorization code + PKCE -------------------------------------------------------------------------------------------------------------
  authorize({ clientId, redirectUri, codeChallenge, codeChallengeMethod, scope, user }, now) {
    const cl = this.client(clientId, now);
    if (typeof redirectUri !== 'string' || !cl.redirectUris.includes(redirectUri)) throw refuse('invalid_redirect_uri', 'the redirect URI does not exactly match a registered one');
    if (typeof codeChallenge !== 'string' || !CHALLENGE.test(codeChallenge)) throw refuse('pkce_required', 'PKCE is mandatory: send a code_challenge (43 base64url characters)');
    if (codeChallengeMethod !== 'S256') throw refuse('pkce_s256_required', 'only code_challenge_method S256 is accepted ("plain" and a missing method are refused)');
    const sc = scope === undefined ? ['mcp:tools'] : Array.isArray(scope) ? scope : null;
    if (!sc || !sc.length || sc.length > 3 || !sc.every((s) => SCOPES.includes(s))) throw refuse('invalid_scope', `scopes: ${SCOPES.join(', ')}`);
    this.sweep(now);
    // Only a code that can still be exchanged is pending: a used one is kept (until it expires) to catch a replay, but it does not take a slot.
    if (Object.values(this.codes).filter((c) => !c.used).length >= LIMITS.codes) throw refuse('too_many_codes', 'too many pending authorization codes: reset to start over', 409);
    const code = `mock-code-${String(++this.n.code).padStart(4, '0')}`;
    this.codes[code] = { clientId: cl.id, redirectUri, challenge: codeChallenge, scope: [...new Set(sc)], user, expiresAt: now + LIMITS.codeTtl, used: false, family: null };
    return { code, expires_in: LIMITS.codeTtl };
  }
  // Room for `need` more tokens, checked BEFORE a code or a refresh token is consumed: a refusal here must leave every credential exactly as it was.
  room(now, need) {
    this.sweep(now);
    if (Object.keys(this.access).length + Object.keys(this.refresh).length + need > LIMITS.tokens) throw refuse('too_many_tokens', 'too many live tokens, so reset to start over', 409);
  }
  issue(cl, scope, user, family, now) {
    const at = `mock-access-${String(++this.n.access).padStart(4, '0')}`; const out = { access_token: at, token_type: 'Bearer', expires_in: LIMITS.accessTtl, scope: scope.join(' ') };
    this.access[at] = { clientId: cl, user, scope, family, expiresAt: now + LIMITS.accessTtl };
    if (scope.includes('offline_access')) { const rt = `mock-refresh-${String(++this.n.refresh).padStart(4, '0')}`; this.refresh[rt] = { clientId: cl, user, scope, family, expiresAt: now + LIMITS.refreshTtl, used: false }; out.refresh_token = rt; }
    return out;
  }
  revokeFamily(f) { for (const k of Object.keys(this.access)) if (this.access[k].family === f) delete this.access[k]; for (const k of Object.keys(this.refresh)) if (this.refresh[k].family === f) delete this.refresh[k]; }
  token(p, now) {
    if (p.grant === 'authorization_code') {
      const rec = typeof p.code === 'string' && Object.hasOwn(this.codes, p.code) ? this.codes[p.code] : null;
      if (!rec) throw refuse('invalid_grant', 'the authorization code is unknown or expired');
      if (rec.used) { if (rec.family !== null) this.revokeFamily(rec.family); throw refuse('invalid_grant', 'the authorization code was already used: the tokens issued from it are revoked'); }
      if (rec.expiresAt <= now) { delete this.codes[p.code]; throw refuse('invalid_grant', 'the authorization code is unknown or expired'); }
      if (rec.clientId !== p.clientId) throw refuse('invalid_grant', 'the code was issued to a different client');
      if (rec.redirectUri !== p.redirectUri) throw refuse('invalid_grant', 'the redirect URI differs from the one the code was issued for');
      if (typeof p.codeVerifier !== 'string' || !VERIFIER.test(p.codeVerifier)) throw refuse('invalid_grant', 'the code_verifier is missing or not 43 to 128 characters of [A-Za-z0-9._~-]');
      if (!same(s256(p.codeVerifier), rec.challenge)) throw refuse('invalid_grant', 'PKCE verification failed: base64url(sha256(code_verifier)) does not equal the code_challenge');
      this.room(now, rec.scope.includes('offline_access') ? 2 : 1);
      rec.used = true; rec.family = `fam-${++this.n.family}`;
      return this.issue(rec.clientId, rec.scope, rec.user, rec.family, now);
    }
    if (p.grant === 'refresh_token') {
      const rt = typeof p.refreshToken === 'string' && Object.hasOwn(this.refresh, p.refreshToken) ? this.refresh[p.refreshToken] : null;
      if (!rt) throw refuse('invalid_grant', 'unknown, revoked or expired refresh token');
      if (rt.used) { this.revokeFamily(rt.family); throw refuse('invalid_grant', 'a refresh token that was already used was presented again: the whole token family is revoked'); }
      if (rt.expiresAt <= now) throw refuse('invalid_grant', 'unknown, revoked or expired refresh token');
      if (rt.clientId !== p.clientId) throw refuse('invalid_grant', 'the refresh token belongs to a different client');
      let scope = rt.scope;
      if (p.scope !== undefined) { if (!Array.isArray(p.scope) || !p.scope.length || !p.scope.every((s) => rt.scope.includes(s))) throw refuse('invalid_scope', 'a refresh can narrow the scope, never widen it'); scope = [...new Set(p.scope)]; }
      this.room(now, scope.includes('offline_access') ? 2 : 1);
      rt.used = true;
      return this.issue(rt.clientId, scope, rt.user, rt.family, now);
    }
    throw refuse('unsupported_grant_type', 'only authorization_code and refresh_token are supported');
  }
  sweep(now) { for (const k of Object.keys(this.codes)) if (this.codes[k].expiresAt <= now) delete this.codes[k]; for (const k of Object.keys(this.access)) if (this.access[k].expiresAt <= now) delete this.access[k]; for (const k of Object.keys(this.refresh)) if (this.refresh[k].expiresAt <= now) delete this.refresh[k]; }

  // ---- discovery ----------------------------------------------------------------------------------------------------------------------------
  metadata(host) {
    const base = `https://${host}.example`;
    return {
      protectedResource: { resource: `${base}/mcp`, authorization_servers: [this.issuer], bearer_methods_supported: ['header'], scopes_supported: SCOPES },
      authorizationServer: {
        issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`, registration_endpoint: `${this.issuer}/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'], scopes_supported: SCOPES, client_id_metadata_document_supported: true,
      },
    };
  }
  snapshot(now) {
    const live = (o) => Object.values(o).filter((x) => x.expiresAt > now).length;
    return {
      issuer: this.issuer,
      clients: Object.values(this.clients).map((c) => ({ id: c.id, kind: c.kind, name: c.name, redirectUris: c.redirectUris })),
      cimd: { clients: this.cimd.clients, cacheTTLHours: this.cimd.cacheTTLHours, fetches: this.cimd.fetches, cacheHits: this.cimd.hits, cache: Object.entries(this.cimd.cache).map(([url, v]) => ({ URL: url, FetchedAt: v.fetchedAt, expiresAt: v.expiresAt, Error: v.error || '' })) },
      pendingCodes: Object.values(this.codes).filter((c) => !c.used && c.expiresAt > now).length, liveAccessTokens: live(this.access), liveRefreshTokens: Object.values(this.refresh).filter((x) => !x.used && x.expiresAt > now).length,
    };
  }
}
