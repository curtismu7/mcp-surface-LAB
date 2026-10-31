import { useState } from "react";
import { visible } from "../safeText";
import { ClaimTag, FieldSources, Json, Outcome, ScenarioBox, SourceTag, StatusTag } from "./Bits";

const FIELD_RE = /AuthMode|token-pass|assertion|RS256|User Vault|second OAuth|lifetime cap/i;
const MODE_TEXT = { none: "No credential.", "static-token": "One app-wide token: every user is the same service account.", "user-token": "The calling user's own credential from the User Vault.", oauth: "A full second OAuth flow, completed per user.", "token-pass": "The fifth mode: a signed assertion naming the end user, forwarded unchanged." };

// Backend credential injection (slide 36): what the agent sees, what the backend receives, and whether the backend can tell who acted.
export default function CredentialsTab({ story, mode, lab, actor, admin, scenarioId, setScenarioId }) {
  const s = lab.state; const ro = lab.readOnly; const c = story.cast;
  const [appId, setAppId] = useState(c.castApp1);
  const [user, setUser] = useState("");
  const [runs, setRuns] = useState([]);
  const [pass, setPass] = useState(null);
  const [defect, setDefect] = useState("none");
  const who = user || actor;
  const app = s.apps.find((a) => a.id === appId) || s.apps[0];
  const tp = s.apps.find((a) => a.authMode === "token-pass") || null;
  const mcpApps = s.apps.filter((a) => a.kind !== "http");

  const tryCall = async () => {
    const tools = { [c.castApp1]: ["read_record", { id: "r-1" }], [c.castApp2]: ["search", { query: "q" }], [c.castApp3]: ["list_cases", {}] };
    const [name, a] = tools[app.id] || [app.tools[0]?.name, {}];
    const r = await lab.act("mcp", { user: who, target: { kind: "app", id: app.id }, rpc: { method: "tools/call", params: { name, arguments: a } } });
    const v = r.body?.result || r.body?.data;
    const row = { n: runs.length + 1, mode: app.authMode, app: app.id, user: who, ok: r.ok && r.body?.ok !== false, status: r.status, error: r.body?.error, sees: v?.rpc?.result ? "the tool result only" : "a refusal", backend: v?.operator?.credential, identity: v?.operator?.backendIdentity, answer: v?.rpc?.result?.content?.[0]?.text };
    setRuns((cur) => [...cur.slice(-9), row]);
  };
  const runPass = async () => { const r = await lab.act("passThrough", { user: who, appId: tp.id, defect }); setPass({ ok: r.ok && r.body?.ok !== false, status: r.status, body: r.body }); };
  const vaultOf = (u) => s.credentials.vault[u] || [];
  const up = s.credentials.upstream.find((x) => x.key === `${who}/${app.id}`);
  const result = pass?.body?.result; const refusal = pass?.body?.data;

  return (
    <div className="stack">
      <ScenarioBox lab={lab} ids={["credentials"]} mode={mode} scenarioId={scenarioId} setScenarioId={setScenarioId} label="Credentials scenario" />
      <section className="panel">
        <h2 className="panel__title">Backend credential injection and token pass-through <ClaimTag /> <span className="tag" data-state="ok">slide 36</span></h2>
        <p className="muted">The gateway holds the credential the MCP server expects, so it never sits with the agent. {ro ? "Mock only reads tables: switch to Live to act." : <>Calling and proposing as <strong>{visible(actor)}</strong>, configuring as <strong>{visible(admin)}</strong>.</>} Every credential below is a labelled MOCK with a fingerprint: no value is ever shown. <SourceTag source="swagger" label="AuthMode values: console swagger names (schema only)" /></p>
        <div className="row">
          <label>Application<select value={app.id} onChange={(e) => setAppId(e.target.value)} data-testid="cred-app">{mcpApps.map((a) => <option key={a.id} value={a.id}>{a.id} ({a.authMode})</option>)}</select></label>
          <label>Authentication mode<select value={app.authMode} disabled={ro || lab.busy} onChange={(e) => lab.act("setAuth", { actor: admin, appId: app.id, authMode: e.target.value })} data-testid="cred-mode">{story.authModes.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          <label>Header the credential travels in<select value={app.staticHeader} disabled={ro || lab.busy} onChange={(e) => lab.act("setAuth", { actor: admin, appId: app.id, staticHeader: e.target.value })} data-testid="cred-header">{["Authorization", "X-Api-Key"].map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
          <label>Call as<select value={who} onChange={(e) => setUser(e.target.value)} data-testid="cred-user">{s.users.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}</select></label>
          <button type="button" disabled={ro || lab.busy} onClick={tryCall} data-testid="cred-call">Call a tool and record the result</button>
        </div>
        <p className="muted" data-testid="mode-text">{MODE_TEXT[app.authMode]}</p>
        <Outcome last={lab.last} ops={["setAuth", "mcp"]} />
        <div className="scroll"><table className="tbl tbl--wide" data-testid="runs">
          <caption>Results of your calls (the agent sees only the first column)</caption>
          <thead><tr><th>Mode</th><th>As</th><th>The agent sees</th><th>The backend received</th><th>The backend believes the caller is</th><th>Answer</th></tr></thead>
          <tbody>{runs.length === 0 ? <tr><td colSpan={6}>Nothing yet.</td></tr> : runs.map((r) => (
            <tr key={r.n} data-testid="run-row"><td>{r.mode}</td><td>{visible(r.user)}</td><td>{r.ok ? "the tool result only" : `a refusal (${visible(r.error || "")})`}</td>
              <td>{r.backend?.headers?.length ? r.backend.headers.map((h) => <span key={h.name}><code>{visible(h.name)}</code> {h.scheme} <span className="tag" data-state="none">{visible(h.credential.label)} [{h.credential.fingerprint}]</span></span>) : "no credential"}</td>
              <td data-testid="identity">{r.identity ? `${visible(r.identity.actor)} (${r.identity.kind})` : "-"}</td><td className="mono">{visible(r.answer || "")}</td></tr>))}</tbody></table></div>
      </section>

      <section className="panel" aria-label="Vault and upstream OAuth" data-testid="vault">
        <h3 className="panel__sub">The User Vault and the second OAuth flow <SourceTag source="reading" label="self-service vault: lab reading" /></h3>
        <p className="muted">The vault is per user: a vault entry can only be set by the user it belongs to, an administrator included. The second OAuth flow is per user too; the access token refreshes when it expires on the lab clock.</p>
        <div className="scroll"><table className="tbl"><thead><tr><th>User</th><th>Vault entries</th></tr></thead><tbody>{s.users.map((p) => <tr key={p.id}><td>{visible(p.id)}</td><td data-testid={`vault-${p.id}`}>{vaultOf(p.id).join(", ") || "none"}</td></tr>)}</tbody></table></div>
        <div className="row">
          <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("vaultSet", { actor, user: who, appId: app.id, present: true })} data-testid="vault-store">Store a vault credential for {visible(who)} (acting as {visible(actor)})</button>
          <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("vaultSet", { actor, user: who, appId: app.id, present: false })}>Remove it</button>
          <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("upstreamAuthorize", { user: who, appId: app.id })} data-testid="oauth-authorize">Authorize the member's OAuth server as {visible(who)}</button>
          <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("advance", { minutes: 20 })} data-testid="advance20">Advance the lab clock 20 minutes</button>
        </div>
        <p className="muted" data-testid="upstream-state">Second OAuth for {visible(who)} on {visible(app.id)}: {up ? `${up.state}; refreshes ${up.refreshes}` : "not authorized"}. Lab clock {visible(s.now)}.</p>
        <Outcome last={lab.last} ops={["vaultSet", "upstreamAuthorize", "advance"]} />
      </section>

      <section className="panel" aria-label="Token pass-through" data-testid="passthrough">
        <h3 className="panel__sub">Token pass-through, with real RS256 signatures <SourceTag source="deck" /> <SourceTag source="invented" label="claims, lifetime cap and replay check: lab-invented" /></h3>
        <p className="muted">A front-end application acting as an agent mints a short-lived signed assertion naming the end user, itself and the target backend. The gateway verifies it and forwards it unchanged; the backend verifies it again and scopes its answer to the end user. The key is a throwaway RSA key generated locally, never shown.</p>
        {!tp ? <p className="callout" role="status" data-testid="no-tp">No application is in token-pass mode. Set the authentication mode of an application above to <code>token-pass</code> (in Live).</p> : (
          <div className="row">
            <label>Target backend<span className="mono"> {visible(tp.id)}</span></label>
            <label>Defect to inject<select value={defect} onChange={(e) => setDefect(e.target.value)} data-testid="defect">{story.defects.map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
            <button type="button" disabled={ro || lab.busy} onClick={runPass} data-testid="mint">Mint, verify, forward as {visible(who)}</button>
          </div>)}
        {pass && (
          <div data-testid="pass-result">
            <p className="verdict" data-state={pass.ok ? "ok" : "bad"} data-testid="pass-verdict">{pass.ok ? "accepted by the gateway and the backend" : `refused (${pass.body?.error}) by ${visible(refusal?.enforcedAt || "")}`}</p>
            {result && (
              <div className="pair">
                <div><h4>The assertion <span className="tag" data-state="none">{visible(result.mockTokenLabel)}</span></h4>
                  <Json value={result.mockToken} label="mock-issued assertion" testId="mock-token" /><Json value={{ header: result.header, claims: result.claims, key: result.keyInfo }} label="decoded header and claims" testId="decoded" /></div>
                <div><h4>What each side saw</h4>
                  <dl className="kv"><dt>The agent</dt><dd data-testid="agent-sees">{visible(result.agentSees.note)}</dd>
                    <dt>Gateway forwarded</dt><dd data-testid="unchanged">{result.unchanged ? "the same bytes, unchanged (digests equal)" : "CHANGED"}</dd>
                    <dt>Backend identified</dt><dd>{visible(result.backendIdentity.actor)} ({result.backendIdentity.kind})</dd>
                    <dt>Backend answer</dt><dd data-testid="scoped">{result.backendAnswer.recordsReturned} record(s), scoped to the end user: {String(result.backendAnswer.scopedToEndUser)}</dd></dl></div>
              </div>)}
          </div>)}
        <Outcome last={lab.last} ops={["passThrough"]} />
        <div className="scroll"><table className="tbl tbl--wide" data-testid="attempts"><caption>Attempts (this workspace)</caption>
          <thead><tr><th>#</th><th>User</th><th>Defect</th><th>Stage</th><th>Verdict</th><th>Code</th><th>Forwarded unchanged</th></tr></thead>
          <tbody>{s.credentials.attempts.length === 0 ? <tr><td colSpan={7}>No attempts yet.</td></tr> : s.credentials.attempts.map((a, i) => <tr key={i}><td>{a.n}</td><td>{visible(a.user)}</td><td>{a.defect}</td><td>{a.stage}</td><td><StatusTag status={a.verdict} /></td><td>{a.code || "-"}</td><td>{a.unchanged === null ? "-" : String(a.unchanged)}</td></tr>)}</tbody></table></div>
        <p className="muted">Replay cache at the backend: {s.credentials.replayCache} assertion id(s). The token above is mock-issued; the gateway and the backend each verify it independently (RS256 only: none, HS256 and anything else are refused).</p>
      </section>
      <FieldSources fields={story.fieldSources.filter((f) => FIELD_RE.test(f.field))} />
    </div>
  );
}
