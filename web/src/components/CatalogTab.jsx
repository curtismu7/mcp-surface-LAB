import { useState } from "react";
import { visible } from "../safeText";
import { ClaimTag, FieldSources, Json, Outcome, ScenarioBox, SourceTag, StatusTag } from "./Bits";

const FIELD_RE = /catalog|containers namespaced|customer-published/i;

// MCP Catalog and hosted servers (slides 36 and 39). The entries are the lab's own, not Ping's catalog.
export default function CatalogTab({ story, mode, lab, actor, admin, scenarioId, setScenarioId }) {
  const s = lab.state; const ro = lab.readOnly; const cat = s.catalog;
  const [names, setNames] = useState({});
  const [tenant, setTenant] = useState("");
  const [cfg, setCfg] = useState({});
  const [res, setRes] = useState(null);
  const [user, setUser] = useState("");
  const who = user || actor;
  const tn = tenant || s.tenants[0];
  const nameFor = (e) => names[e.id] ?? e.id.split("-")[0];
  const history = (d) => d.history.join(" > ");
  const callOn = async (d, method, tool) => {
    if (!d.appId) { setRes({ ok: false, status: 0, body: { error: "other_tenant", detail: "this container belongs to another tenant's namespace and has no application on this gateway view" } }); return; }
    const r = await lab.act("mcp", { user: who, target: { kind: "app", id: d.appId }, rpc: { method, params: method === "tools/call" ? { name: tool, arguments: tool === "get_doc" ? { id: "d-1" } : tool === "create_ticket" ? { title: "t" } : tool === "convert" ? { value: 1, to: "m" } : { query: "q" } } : {} } });
    setRes({ ok: r.ok && r.body?.ok !== false, status: r.status, body: r.body, dep: d.id });
  };
  const view = res?.body?.result || res?.body?.data;

  return (
    <div className="stack">
      <ScenarioBox lab={lab} ids={["catalog"]} mode={mode} scenarioId={scenarioId} setScenarioId={setScenarioId} label="Catalog scenario" />
      <section className="panel">
        <h2 className="panel__title">MCP Catalog and hosted servers <ClaimTag /> <span className="tag" data-state="ok">slides 36 and 39</span></h2>
        <p className="muted">Curated, verified MCP servers (the entries below are written by the lab, not Ping's catalog). A catalog entry deploys as a managed container behind the gateway in one step, with per-tool authorization, credential injection and audit applied from the first request. Deployments are health-checked and redeployed on configuration change. {ro ? "Mock only reads tables: switch to Live to act." : <>Calling and proposing as <strong>{visible(actor)}</strong>, configuring as <strong>{visible(admin)}</strong>.</>}</p>
        <div className="row"><label>Deploy into the namespace of tenant<select value={tn} onChange={(e) => setTenant(e.target.value)} data-testid="cat-tenant">{s.tenants.map((t) => <option key={t} value={t}>tenant-{t}</option>)}</select></label></div>
        <div className="scroll"><table className="tbl tbl--wide" data-testid="entries">
          <thead><tr><th>Entry</th><th>Version</th><th>Verified</th><th>Architectures</th><th>Tools</th><th>Deploy</th></tr></thead>
          <tbody>{cat.entries.map((e) => (
            <tr key={e.id} data-testid={`entry-${e.id}`}><td><strong>{visible(e.name)}</strong><br /><span className="muted">{visible(e.summary)}</span></td><td>{e.version}</td>
              <td><StatusTag status={e.verified ? "verified" : "denied"} /> {e.verified ? "" : <span className="muted">not verified</span>}</td><td>{e.arch.join(", ")}</td><td>{e.tools.join(", ")}</td>
              <td><div className="row"><label>Name<input value={nameFor(e)} maxLength={32} onChange={(ev) => setNames((n) => ({ ...n, [e.id]: ev.target.value }))} data-testid={`name-${e.id}`} autoComplete="off" /></label>
                <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("catDeploy", { actor: admin, entryId: e.id, name: nameFor(e), tenant: tn })} data-testid={`deploy-${e.id}`}>Deploy</button></div></td></tr>))}</tbody></table></div>
        <div className="row">
          <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("catPublish", { actor: admin })} data-testid="publish">Publish my own entry</button>
          <span className="tag" data-state="bad" data-testid="roadmap-tag">roadmap</span><SourceTag source="deck" label="customer-published entries: on the roadmap (deck claim), nothing modelled" />
        </div>
        <Outcome last={lab.last} ops={["catDeploy", "catPublish"]} />
      </section>

      <section className="panel" aria-label="Deployments" data-testid="deployments">
        <h3 className="panel__sub">Deployments ({cat.deployments.length}) <SourceTag source="invented" label="states: lab-invented" /></h3>
        {cat.deployments.length === 0 && <p className="muted">None yet. Deploy a verified entry above.</p>}
        {cat.deployments.map((d) => (
          <article key={d.id} className="panel" data-testid={`dep-${d.id}`}>
            <h4><code>{visible(d.id)}</code> <StatusTag status={d.state} /> <span className="tag" data-state="none">container {d.container}</span></h4>
            <p className="muted" data-testid={`history-${d.id}`}>States so far: {history(d)}. Generation {d.generation}; probes {d.probes}; calls {d.calls}. {d.redeployReason ? `Last redeploy: ${visible(d.redeployReason)}.` : ""}</p>
            <div className="row">
              <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("catCrash", { actor: admin, id: d.id })} data-testid={`crash-${d.id}`}>Crash the container</button>
              <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("catHealth", { actor: admin, id: d.id })} data-testid={`health-${d.id}`}>Run a health check</button>
              <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("catRedeploy", { actor: admin, id: d.id })} data-testid={`redeploy-${d.id}`}>Redeploy</button>
            </div>
            <div className="row">
              <label>Log level<select value={cfg[d.id]?.logLevel ?? d.config.logLevel} onChange={(e) => setCfg((c) => ({ ...c, [d.id]: { ...c[d.id], logLevel: e.target.value } }))} data-testid={`level-${d.id}`}>{cat.logLevels.map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
              <label>Max results<input type="number" min={1} max={50} value={cfg[d.id]?.maxResults ?? d.config.maxResults} onChange={(e) => setCfg((c) => ({ ...c, [d.id]: { ...c[d.id], maxResults: Number(e.target.value) } }))} data-testid={`max-${d.id}`} /></label>
              <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("catConfigure", { actor: admin, id: d.id, config: { logLevel: cfg[d.id]?.logLevel ?? d.config.logLevel, maxResults: cfg[d.id]?.maxResults ?? d.config.maxResults } })} data-testid={`configure-${d.id}`}>Apply configuration (redeploys)</button>
            </div>
            <div className="row">
              <label>Call as<select value={who} onChange={(e) => setUser(e.target.value)} data-testid="cat-user">{s.users.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}</select></label>
              <button type="button" disabled={ro || lab.busy} onClick={() => callOn(d, "tools/list")} data-testid={`list-${d.id}`}>List its tools</button>
              <button type="button" disabled={ro || lab.busy} onClick={() => callOn(d, "tools/call", cat.entries.find((e) => e.id === d.entry).tools[0])} data-testid={`call-${d.id}`}>Call its first tool (the first request is already controlled)</button>
            </div>
          </article>))}
        {res && (
          <div className="pair" data-testid="cat-result">
            <div><h4>What the agent sees <span className="verdict" data-state={res.ok ? "ok" : "bad"}>{res.ok ? "allowed" : `refused (${res.body?.error}, HTTP ${res.status})`}</span></h4>
              <Json value={view?.rpc?.result?.tools ? view.rpc.result.tools.map((t) => t.name) : view?.rpc?.result?.content?.[0]?.text ?? view?.rpc ?? { detail: res.body?.detail }} label="answer" testId="cat-answer" /></div>
            <div><h4>What the operator sees</h4>
              <dl className="kv"><dt>Enforced at</dt><dd>{visible(view?.operator?.enforcedAt || view?.enforcedAt || "-")}</dd>
                {view?.operator?.containerEnv && <><dt>Container environment</dt><dd data-testid="container-env">{visible(JSON.stringify(view.operator.containerEnv))}</dd></>}</dl></div>
          </div>)}
        <Outcome last={lab.last} ops={["catCrash", "catHealth", "catRedeploy", "catConfigure", "mcp"]} />
      </section>
      <FieldSources fields={story.fieldSources.filter((f) => FIELD_RE.test(f.field))} />
    </div>
  );
}
