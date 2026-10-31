import { useState } from "react";
import { visible } from "../safeText";
import { ClaimTag, FieldSources, Json, Outcome, ScenarioBox, SourceTag, StatusTag } from "./Bits";

const FIELD_RE = /proposal|session logging|headless|hostname|replica|re-validated/i;

// Approval-gated creation, hosted servers, headless agents and deployment notes (slide 36).
export default function CreationTab({ story, mode, lab, actor, admin, scenarioId, setScenarioId }) {
  const s = lab.state; const ro = lab.readOnly; const cr = s.creation; const c = story.cast;
  const [f, setF] = useState({ kind: "mcp", name: "helpdesk", backend: `https://helpdesk.${c.castHost}.example/mcp`, authMode: "static-token", note: "" });
  const [adj, setAdj] = useState({});
  const [route, setRoute] = useState(`/${c.castApp1}/mcp`);
  const [routeRes, setRouteRes] = useState(null);
  const [sess, setSess] = useState({});
  const [agentRes, setAgentRes] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const propose = () => lab.act("propose", { actor, kind: f.kind, name: f.name, backend: f.backend, authMode: f.authMode, ...(f.note ? { note: f.note } : {}) });
  const decide = (p, decision) => lab.act("decide", { actor: admin, proposalId: p.id, decision, revision: p.revision, ...(decision === "approve" && Object.keys(adj[p.id] || {}).length ? { adjust: adj[p.id] } : {}) });
  const setAdjust = (id, k, v) => setAdj((a) => ({ ...a, [id]: { ...a[id], [k]: v } }));
  const lookup = async () => { const r = await lab.act("route", { path: route }); setRouteRes({ ok: r.ok, status: r.status, body: r.body }); };
  const callAs = async (a) => { const r = await lab.act("mcp", { as: a.id, target: { kind: "app", id: c.castApp1 }, rpc: { method: "tools/call", params: { name: "get_status", arguments: {} } } }); setAgentRes({ id: a.id, ok: r.ok && r.body?.ok !== false, status: r.status, error: r.body?.error }); };
  const sessionsKey = (replica) => sess[replica] || cr.deployment.sessions[0]?.id || "";

  return (
    <div className="stack">
      <ScenarioBox lab={lab} ids={["creation"]} mode={mode} scenarioId={scenarioId} setScenarioId={setScenarioId} label="Creation scenario" />
      <section className="panel">
        <h2 className="panel__title">Approval-gated creation, hosting, headless agents and deployment <ClaimTag /> <span className="tag" data-state="ok">slide 36</span></h2>
        <p className="muted">Non-administrators propose new MCP or HTTP applications; an administrator reviews, can adjust the configuration, and approves before anything is created. {ro ? "Mock only reads tables: switch to Live to act." : <>Calling and proposing as <strong>{visible(actor)}</strong>, configuring as <strong>{visible(admin)}</strong> (a person who is not an administrator proposes; an administrator decides; nobody decides their own).</>}</p>
        <h3 className="panel__sub">Propose a new application</h3>
        <div className="row">
          <label>Kind<select value={f.kind} onChange={set("kind")} data-testid="p-kind">{cr.kinds.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
          <label>Name<input value={f.name} maxLength={32} onChange={set("name")} data-testid="p-name" autoComplete="off" /></label>
          <label className="grow">Backend (https on a .example host)<input value={f.backend} maxLength={150} onChange={set("backend")} data-testid="p-backend" autoComplete="off" /></label>
          <label>Authentication mode<select value={f.authMode} onChange={set("authMode")} data-testid="p-auth">{cr.authModes.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
          <label className="grow">Note<input value={f.note} maxLength={200} onChange={set("note")} data-testid="p-note" autoComplete="off" /></label>
          <button type="button" disabled={ro || lab.busy} onClick={propose} data-testid="propose">Propose</button>
        </div>
        <Outcome last={lab.last} ops={["propose", "decide", "amend"]} />
        <div className="scroll"><table className="tbl tbl--wide" data-testid="proposals">
          <thead><tr><th>Proposal</th><th>By</th><th>Application</th><th>State</th><th>Rev</th><th>Decision (administrators)</th></tr></thead>
          <tbody>{cr.proposals.length === 0 ? <tr><td colSpan={6}>No proposals yet.</td></tr> : cr.proposals.map((p) => (
            <tr key={p.id} data-testid={`proposal-${p.id}`}><td>{p.id}</td><td>{visible(p.proposer)}</td><td>{p.kind} <code>{visible(p.name)}</code><br /><span className="muted">{visible(p.backend)}; auth {p.authMode}{p.note ? `; ${visible(p.note)}` : ""}</span></td>
              <td><StatusTag status={p.state} />{p.decidedBy ? <span className="muted"> by {visible(p.decidedBy)}</span> : null}{p.adjustments.length ? <span className="muted"> adjusted {p.adjustments.map((a) => a.field).join(", ")}</span> : null}{p.createdApp ? <span className="muted"> created {visible(p.createdApp)}</span> : null}</td><td>{p.revision}</td>
              <td>{p.state === "pending" ? (
                <div className="row">
                  <label>Adjust name<input value={adj[p.id]?.name ?? ""} maxLength={32} placeholder="(unchanged)" onChange={(e) => setAdjust(p.id, "name", e.target.value)} data-testid={`adj-name-${p.id}`} autoComplete="off" /></label>
                  <label>Adjust auth<select value={adj[p.id]?.authMode ?? ""} onChange={(e) => setAdjust(p.id, "authMode", e.target.value)} data-testid={`adj-auth-${p.id}`}><option value="">(unchanged)</option>{cr.authModes.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
                  <button type="button" disabled={ro || lab.busy} onClick={() => decide(p, "approve")} data-testid={`approve-${p.id}`}>Approve revision {p.revision}</button>
                  <button type="button" disabled={ro || lab.busy} onClick={() => decide(p, "deny")} data-testid={`deny-${p.id}`}>Deny</button>
                  <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("amend", { actor, proposalId: p.id, note: "amended" })} data-testid={`amend-${p.id}`}>Amend (as the proposer)</button>
                </div>) : p.state === "denied" ? (
                <button type="button" disabled={ro || lab.busy} onClick={() => decide(p, "approve")} data-testid={`approve-${p.id}`}>Try to approve it now</button>) : "-"}</td></tr>))}</tbody></table></div>
        <p className="muted">Values are re-validated when a proposal is approved, not frozen at request time (lab reading). A proposal older than {cr.proposalTtlDays} days on the lab clock is stale. <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("advance", { minutes: 1440 })} data-testid="advance-day">Advance one day</button> Lab clock {visible(s.now)}.</p>
      </section>

      <section className="panel" aria-label="Session logging" data-testid="session-logging">
        <h3 className="panel__sub">Session logging <SourceTag source="deck" /></h3>
        <label className="check"><input type="checkbox" checked={s.sessionLogging} disabled={ro || lab.busy} onChange={(e) => lab.act("setSessionLogging", { actor: admin, enabled: e.target.checked })} data-testid="logging" />Record tool invocations and their arguments (arguments are masked if they look like a credential)</label>
        <div className="scroll"><table className="tbl tbl--wide" data-testid="recordings"><caption>Recorded invocations ({s.recordings.total})</caption><thead><tr><th>#</th><th>Who</th><th>Target</th><th>Tool</th><th>Arguments</th></tr></thead>
          <tbody>{s.recordings.shown.length === 0 ? <tr><td colSpan={5}>Nothing recorded.</td></tr> : s.recordings.shown.map((r) => <tr key={r.n}><td>{r.n}</td><td>{visible(r.actor)}</td><td>{visible(r.target)}</td><td>{visible(r.tool || "")}</td><td className="mono">{visible(JSON.stringify(r.arguments))}</td></tr>)}</tbody></table></div>
      </section>

      <section className="panel" aria-label="Headless agents" data-testid="agents">
        <h3 className="panel__sub">Headless agents <SourceTag source="deck" /> <SourceTag source="measured" label="scope needed for mcp: measured (AI-DEMO2 note)" /></h3>
        <p className="muted">An agent authenticates with a scoped access key or a Federated Identity and acts as its owning user, so the same policy and audit apply.</p>
        <div className="scroll"><table className="tbl tbl--wide"><thead><tr><th>Agent</th><th>Owner</th><th>Authenticates with</th><th>Scopes</th><th>Enabled</th><th>Actions</th></tr></thead>
          <tbody>{s.agents.map((a) => (
            <tr key={a.id} data-testid={`agent-${a.id}`}><td>{visible(a.id)}</td><td>{visible(a.owner)}</td><td>{a.auth}</td><td>{a.scopes.join(", ")}</td><td><StatusTag status={a.enabled ? "ok" : "revoked"} /></td>
              <td><div className="row"><button type="button" disabled={ro || lab.busy} onClick={() => lab.act("setAgent", { actor: admin, agentId: a.id, enabled: !a.enabled })} data-testid={`toggle-${a.id}`}>{a.enabled ? "Revoke" : "Re-enable"}</button>
                <button type="button" disabled={ro || lab.busy} onClick={() => callAs(a)} data-testid={`call-as-${a.id}`}>Call as this agent</button></div></td></tr>))}</tbody></table></div>
        {agentRes && <p className="verdict" data-state={agentRes.ok ? "ok" : "bad"} data-testid="agent-result">{visible(agentRes.id)}: {agentRes.ok ? "allowed, acting as its owner" : `refused (${agentRes.error}, HTTP ${agentRes.status})`}</p>}
        <Outcome last={lab.last} ops={["setAgent", "mcp", "setSessionLogging"]} />
      </section>

      <section className="panel" aria-label="Deployment" data-testid="deployment">
        <h3 className="panel__sub">Deployment: one hostname, applications by path <SourceTag source="deck" /> <SourceTag source="invented" label="two-replica illustration: lab-invented" /></h3>
        <div className="callout" data-state="warn" data-testid="slide-clipped"><h4>Slide 36 is clipped here</h4><p>{visible(story.claims.find((x) => x.id === "deployment").claim)}</p></div>
        <p className="muted">Host: <code>{visible(cr.deployment.host)}</code></p>
        <div className="scroll"><table className="tbl"><thead><tr><th>Path</th><th>Serves</th></tr></thead><tbody>{cr.deployment.paths.map((p) => <tr key={p.path}><td className="mono">{visible(p.path)}</td><td>{visible(p.serves)}</td></tr>)}</tbody></table></div>
        <div className="row"><label className="grow">Look up a path<input value={route} maxLength={100} onChange={(e) => setRoute(e.target.value)} data-testid="route" autoComplete="off" /></label><button type="button" disabled={ro || lab.busy} onClick={lookup} data-testid="route-go">Look up</button></div>
        {routeRes && <p className="verdict" data-state={routeRes.ok ? "ok" : "bad"} data-testid="route-result">{routeRes.ok ? `served by ${visible(routeRes.body.result.serves)} (${routeRes.body.result.kind})` : `refused (${routeRes.body?.error}, HTTP ${routeRes.status})`}</p>}
        <h4>OAuth session state is per gateway process</h4>
        <div className="row">
          {cr.deployment.replicas.map((rp) => <button key={rp} type="button" disabled={ro || lab.busy} onClick={() => lab.act("sessionOpen", { user: actor, replica: rp })} data-testid={`open-${rp}`}>Open a session on {rp}</button>)}
          <label className="check"><input type="checkbox" checked={cr.deployment.pinned} disabled={ro || lab.busy} onChange={(e) => lab.act("setPinning", { actor: admin, enabled: e.target.checked })} data-testid="pinning" />Pin client sessions to a replica</label>
        </div>
        <div className="scroll"><table className="tbl" data-testid="sessions"><thead><tr><th>Session</th><th>User</th><th>Opened on</th><th>Use</th></tr></thead>
          <tbody>{cr.deployment.sessions.length === 0 ? <tr><td colSpan={4}>No sessions.</td></tr> : cr.deployment.sessions.map((x) => <tr key={x.id}><td>{x.id}</td><td>{visible(x.user)}</td><td>{x.replica}</td>
            <td><div className="row">{cr.deployment.replicas.map((rp) => <button key={rp} type="button" disabled={ro || lab.busy} onClick={() => lab.act("sessionUse", { sessionId: x.id, replica: rp })} data-testid={`use-${x.id}-${rp}`}>Next request lands on {rp}</button>)}</div></td></tr>)}</tbody></table></div>
        <Outcome last={lab.last} ops={["sessionOpen", "sessionUse", "setPinning", "route"]} />
        {lab.last?.op === "sessionUse" && lab.last.ok && <p className="muted" data-testid="session-served">Served by {lab.last.result.servedBy} (pinned: {String(lab.last.result.pinned)}).</p>}
      </section>
      <FieldSources fields={story.fieldSources.filter((f2) => FIELD_RE.test(f2.field))} />
    </div>
  );
}
