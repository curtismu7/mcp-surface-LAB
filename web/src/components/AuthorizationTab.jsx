import { useEffect, useState } from "react";
import { visible } from "../safeText";
import { ClaimTag, FieldSources, Json, Outcome, ScenarioBox, SourceTag } from "./Bits";

const FIELD_RE = /CIMD|PKCE|client_id_metadata|modelCIMD/i;
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Standards-based authorization and CIMD (slide 36): a full OAuth 2.1 authorization server with mandatory PKCE (S256), refresh tokens and discovery metadata.
// PKCE is verified for real. CIMD documents are fixed mocks keyed by .example URLs: the lab never fetches anything.
export default function AuthorizationTab({ story, mode, lab, actor, admin, scenarioId, setScenarioId }) {
  const s = lab.state; const ro = lab.readOnly; const o = s.oauth; const host = story.cast.castHost;
  const redirect0 = `https://agent.${host}.example/callback`;
  const [clientName, setClientName] = useState("Agent client");
  const [redirect, setRedirect] = useState(redirect0);
  const [clientId, setClientId] = useState("");
  const [challenge, setChallenge] = useState(story.pkce.challenge);
  const [verifier, setVerifier] = useState(story.pkce.verifier);
  const [method, setMethod] = useState("S256");
  const [scopes, setScopes] = useState(["mcp:tools", "offline_access"]);
  const [code, setCode] = useState("");
  const [tokens, setTokens] = useState(null);
  const [refresh, setRefresh] = useState("");
  const [cimdUrl, setCimdUrl] = useState(story.cimdUrls[0]);
  const [ttl, setTtl] = useState(String(o.cimd.cacheTTLHours));
  const [allow, setAllow] = useState(new Set(o.cimd.clients.map((c) => c.URL)));
  const [cimdRes, setCimdRes] = useState(null);
  const [genErr, setGenErr] = useState("");
  useEffect(() => { setRedirect(redirect0); setChallenge(story.pkce.challenge); setVerifier(story.pkce.verifier); setCimdUrl(story.cimdUrls[0]); }, [story.vertical]); // eslint-disable-line react-hooks/exhaustive-deps
  const allowKey = JSON.stringify(o.cimd.clients);
  useEffect(() => { setAllow(new Set(o.cimd.clients.map((c) => c.URL))); setTtl(String(o.cimd.cacheTTLHours)); }, [allowKey, o.cimd.cacheTTLHours]); // eslint-disable-line react-hooks/exhaustive-deps
  const clients = o.clients.filter((c) => c.kind === "dcr");
  const cid = clientId || clients[0]?.id || "";
  const cimdClients = o.clients.filter((c) => c.kind === "cimd");

  const register = () => lab.act("oauthRegister", { clientName, redirectUris: [redirect] });
  const authorize = async () => { const r = await lab.act("oauthAuthorize", { user: actor, clientId: cid.startsWith("https://") ? cid : cid, redirectUri: redirect, codeChallenge: challenge, codeChallengeMethod: method === "(none)" ? undefined : method, scope: scopes }); if (r.ok && r.body?.result?.code) setCode(r.body.result.code); };
  const exchange = async () => { const r = await lab.act("oauthToken", { grant: "authorization_code", code, codeVerifier: verifier, clientId: cid, redirectUri: redirect }); if (r.ok) { setTokens(r.body.result); setRefresh(r.body.result.refresh_token || ""); } };
  const doRefresh = async () => { const r = await lab.act("oauthToken", { grant: "refresh_token", refreshToken: refresh, clientId: cid }); if (r.ok) { setTokens(r.body.result); setRefresh(r.body.result.refresh_token || ""); } };
  const gen = async () => {
    setGenErr("");
    try { const bytes = crypto.getRandomValues(new Uint8Array(32)); const v = b64u(bytes); const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)); setVerifier(v); setChallenge(b64u(d)); } catch { setGenErr("This browser cannot make a PKCE pair here: use the example pair."); }
  };
  const resolve = async () => { const r = await lab.act("cimdResolve", { clientId: cimdUrl }); setCimdRes({ ok: r.ok && r.body?.ok !== false, status: r.status, body: r.body }); if (r.ok) setClientId(cimdUrl); };
  const saveCimd = () => lab.act("cimdSet", { actor: admin, clients: [...allow].map((URL) => ({ URL, IsPrivate: false })), cacheTTLHours: Number(ttl) });
  const toggleScope = (x) => setScopes((cur) => (cur.includes(x) ? cur.filter((y) => y !== x) : [...cur, x]));
  const allUrls = [...new Set([...story.cimdUrls, ...o.cimd.clients.map((c) => c.URL)])];

  return (
    <div className="stack">
      <ScenarioBox lab={lab} ids={["authorization"]} mode={mode} scenarioId={scenarioId} setScenarioId={setScenarioId} label="Authorization scenario" />
      <section className="panel">
        <h2 className="panel__title">Standards-based authorization and CIMD <ClaimTag /> <span className="tag" data-state="ok">slide 36</span></h2>
        <p className="muted">A full OAuth 2.1 authorization server: dynamic client registration, mandatory PKCE (S256, checked for real), single-use codes, rotating refresh tokens and published discovery metadata. CIMD: a client identifies itself by a document URL the tenant has allowlisted; the gateway fetches, validates and caches the document. <strong>The lab never fetches:</strong> each URL maps to one fixed mock document. (For the real document flow, see the separate cimd-lab; this is a text reference only.) {ro ? "Mock only reads tables: switch to Live to act." : <>Calling and proposing as <strong>{visible(actor)}</strong>, configuring as <strong>{visible(admin)}</strong>.</>}</p>
        <h3 className="panel__sub">1. Register a client (dynamic registration)</h3>
        <div className="row">
          <label>Client name<input value={clientName} maxLength={60} onChange={(e) => setClientName(e.target.value)} data-testid="client-name" autoComplete="off" /></label>
          <label className="grow">Redirect URI (https on a .example host, or loopback http)<input value={redirect} maxLength={200} onChange={(e) => setRedirect(e.target.value)} data-testid="redirect" autoComplete="off" /></label>
          <button type="button" disabled={ro || lab.busy} onClick={register} data-testid="register">Register</button>
        </div>
        <Outcome last={lab.last} ops={["oauthRegister"]} />
        <h3 className="panel__sub">2. Authorize, with PKCE</h3>
        <div className="row">
          <label>Client<select value={cid} onChange={(e) => setClientId(e.target.value)} data-testid="client-select">{clients.concat(cimdClients).map((c) => <option key={c.id} value={c.id}>{c.kind === "cimd" ? "CIMD " : ""}{c.id}</option>)}</select></label>
          <label className="grow">code_challenge<input value={challenge} onChange={(e) => setChallenge(e.target.value)} data-testid="challenge" autoComplete="off" spellCheck="false" /></label>
          <label>Method<select value={method} onChange={(e) => setMethod(e.target.value)} data-testid="method">{["S256", "plain", "(none)"].map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          <button type="button" onClick={gen} data-testid="gen-pkce">New random pair</button>
        </div>
        {genErr && <p className="field-error" role="alert">{genErr}</p>}
        <div className="row">{story.scopes.map((x) => <label className="check" key={x}><input type="checkbox" checked={scopes.includes(x)} onChange={() => toggleScope(x)} data-testid={`scope-${x}`} />{x}</label>)}
          <button type="button" disabled={ro || lab.busy || !cid} onClick={authorize} data-testid="authorize">Request a code</button></div>
        <Outcome last={lab.last} ops={["oauthAuthorize"]} />
        <h3 className="panel__sub">3. Exchange the code, then refresh</h3>
        <div className="row">
          <label className="grow">Code<input value={code} onChange={(e) => setCode(e.target.value)} data-testid="code" autoComplete="off" /></label>
          <label className="grow">code_verifier (hashed with S256 and compared with the challenge; it is never echoed)<input value={verifier} onChange={(e) => setVerifier(e.target.value)} data-testid="verifier" autoComplete="off" spellCheck="false" /></label>
          <button type="button" disabled={ro || lab.busy || !code} onClick={exchange} data-testid="exchange">Exchange</button>
        </div>
        <div className="row">
          <label className="grow">Refresh token<input value={refresh} onChange={(e) => setRefresh(e.target.value)} data-testid="refresh" autoComplete="off" /></label>
          <button type="button" disabled={ro || lab.busy || !refresh} onClick={doRefresh} data-testid="do-refresh">Refresh (rotates the pair)</button>
        </div>
        <Outcome last={lab.last} ops={["oauthToken"]} />
        {tokens && <div data-testid="tokens"><p className="muted">Mock-issued tokens, shown raw (labelled mock; they open nothing).</p><Json value={tokens} label="token response" testId="token-json" /></div>}
        <p className="muted" data-testid="oauth-counts">Pending codes {o.pendingCodes}; live access tokens {o.liveAccessTokens}; live refresh tokens {o.liveRefreshTokens}; lab clock {visible(s.now)}. <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("advance", { minutes: 1440 })} data-testid="advance-day">Advance one day</button></p>
      </section>

      <section className="panel" aria-label="CIMD" data-testid="cimd">
        <h3 className="panel__sub">CIMD client registration <SourceTag source="swagger" label="CIMDConfig.Clients[].URL, IsPrivate, CacheTTLHours, CIMDDocument: console swagger names (schema only)" /></h3>
        <div className="row">
          <label className="grow">Client ID metadata URL<input list="cimd-urls" value={cimdUrl} maxLength={200} onChange={(e) => setCimdUrl(e.target.value)} data-testid="cimd-url" autoComplete="off" /></label>
          <datalist id="cimd-urls">{allUrls.map((u) => <option key={u} value={u} />)}</datalist>
          <button type="button" disabled={ro || lab.busy} onClick={resolve} data-testid="cimd-resolve">Resolve: fetch (simulated), validate, cache</button>
        </div>
        <Outcome last={lab.last} ops={["cimdResolve"]} />
        {cimdRes?.ok && <p className="verdict" data-state="ok" data-testid="cimd-ok">Accepted: {cimdRes.body.result.fetched ? "fetched (a fixed mock document)" : "served from the cache, no fetch"}; redirect URIs {cimdRes.body.result.redirectUris.length}.</p>}
        <h4>The tenant allowlist and the cache lifetime</h4>
        <div className="checks checks__box">{allUrls.map((u) => <label key={u}><input type="checkbox" disabled={ro} checked={allow.has(u)} onChange={() => setAllow((cur) => { const n = new Set(cur); if (n.has(u)) n.delete(u); else n.add(u); return n; })} data-testid={`allow-${u.split(".")[0].replace("https://", "")}`} />{visible(u)}</label>)}</div>
        <div className="row"><label>CacheTTLHours (1 to 168)<input type="number" min={1} max={168} value={ttl} onChange={(e) => setTtl(e.target.value)} data-testid="ttl" /></label>
          <button type="button" disabled={ro || lab.busy} onClick={saveCimd} data-testid="save-cimd">Save the allowlist and lifetime</button></div>
        <Outcome last={lab.last} ops={["cimdSet"]} />
        <div className="scroll"><table className="tbl tbl--wide" data-testid="cimd-cache"><caption>Cache ({o.cimd.fetches} fetch(es), {o.cimd.cacheHits} hit(s))</caption>
          <thead><tr><th>URL</th><th>FetchedAt (lab clock, s)</th><th>Expires (s)</th><th>Error</th></tr></thead>
          <tbody>{o.cimd.cache.length === 0 ? <tr><td colSpan={4}>Nothing cached yet.</td></tr> : o.cimd.cache.map((c) => <tr key={c.URL}><td className="mono">{visible(c.URL)}</td><td>{c.FetchedAt}</td><td>{c.expiresAt}</td><td>{c.Error || "-"}</td></tr>)}</tbody></table></div>
      </section>

      <section className="panel" aria-label="Discovery metadata" data-testid="metadata">
        <h3 className="panel__sub">Published discovery metadata <SourceTag source="reading" label="client_id_metadata_document_supported: lab reading" /></h3>
        <p className="muted">It advertises S256 only, the two grants, dynamic registration and CIMD support, on reserved hosts.</p>
        <Json value={o.metadata} label="discovery metadata" testId="metadata-json" tall />
      </section>
      <FieldSources fields={story.fieldSources.filter((f) => FIELD_RE.test(f.field))} />
    </div>
  );
}
