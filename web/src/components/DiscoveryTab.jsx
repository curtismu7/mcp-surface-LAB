import { useEffect, useState } from "react";
import { visible } from "../safeText";
import { ClaimTag, FieldSources, Json, Outcome, ScenarioBox, SourceTag, StatusTag } from "./Bits";

const FIELD_RE = /per-tool|in-flight|fail closed|deny by default|refusal on a member|grant shape/i;
const KINDS = [["tools", "Tools"], ["prompts", "Prompts"], ["resources", "Resources"]];

// Per-tool policy and entitlement-aware discovery (slide 36): the decision is on the JSON-RPC method and its target; listings are filtered in flight.
export default function DiscoveryTab({ story, mode, lab, actor, admin, scenarioId, setScenarioId }) {
  const s = lab.state; const ro = lab.readOnly;
  const [appId, setAppId] = useState(story.cast.castApp1);
  const [style, setStyle] = useState("sse");
  const [res, setRes] = useState(null);
  const [tool, setTool] = useState("export_all");
  const [method, setMethod] = useState("tools/list");
  const [param, setParam] = useState("");
  const app = s.apps.find((a) => a.id === appId) || s.apps[0];
  const mcpApps = s.apps.filter((a) => a.kind !== "http");

  const send = async (rpcMethod, params) => { const r = await lab.act("mcp", { user: actor, target: { kind: "app", id: app.id }, rpc: { method: rpcMethod, params }, style }); setRes({ ok: r.ok && r.body?.ok !== false, status: r.status, body: r.body, method: rpcMethod }); };
  const list = (kind) => send(`${kind}/list`, {});
  const view = res?.body?.result || res?.body?.data || null;
  const rpc = view?.rpc;
  const listing = rpc?.result ? (rpc.result.tools || rpc.result.prompts || rpc.result.resources) : null;
  const upstream = res && res.method.endsWith("/list") ? (res.method.startsWith("tools") ? app.tools.map((t) => t.name) : res.method.startsWith("prompts") ? app.prompts : app.resources) : null;

  // the application's policy editor
  const [grants, setGrants] = useState({});
  const key = JSON.stringify(app.policy) + app.id;
  useEffect(() => { setGrants(Object.fromEntries(s.groups.map((g) => { const gr = app.policy.grants.find((x) => x.group === g); return [g, { tools: new Set(gr?.tools || []), prompts: new Set(gr?.prompts || []), resources: new Set(gr?.resources || []) }]; }))); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (g, k, n) => setGrants((cur) => { const set = new Set(cur[g][k]); if (set.has(n)) set.delete(n); else set.add(n); return { ...cur, [g]: { ...cur[g], [k]: set } }; });
  const names = { tools: app.tools.map((t) => t.name), prompts: app.prompts, resources: app.resources };
  const save = () => lab.act("setPolicy", { actor: admin, appId: app.id, grants: s.groups.filter((g) => grants[g] && (grants[g].tools.size || grants[g].prompts.size || grants[g].resources.size)).map((g) => ({ group: g, tools: [...grants[g].tools], prompts: [...grants[g].prompts], resources: [...grants[g].resources] })) });

  return (
    <div className="stack">
      <ScenarioBox lab={lab} ids={["discovery"]} mode={mode} scenarioId={scenarioId} setScenarioId={setScenarioId} label="Discovery scenario" />
      <section className="panel">
        <h2 className="panel__title">Per-tool policy and entitlement-aware discovery <ClaimTag /> <span className="tag" data-state="ok">slide 36</span></h2>
        <p className="muted">Authorization is evaluated on the JSON-RPC method and its target (tools, prompts, resources; listing and invocation), not just "can this user reach this server". The upstream lists everything; the gateway removes what you may not use, in flight, so the agent never learns it exists. {ro ? "Mock only reads tables: switch to Live to act." : <>Calling and proposing as <strong>{visible(actor)}</strong>, configuring as <strong>{visible(admin)}</strong>.</>}</p>
        <div className="row">
          <label>Application<select value={app.id} onChange={(e) => { setAppId(e.target.value); setRes(null); }} data-testid="disc-app">{mcpApps.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}</select></label>
          <label>Upstream wire<select value={style} onChange={(e) => setStyle(e.target.value)} data-testid="disc-style">{story.styles.map((x) => <option key={x} value={x}>{x === "sse" ? "sse (event stream, chunked)" : x === "gzip-sse" ? "gzip-sse (compressed stream)" : x}</option>)}</select></label>
          {KINDS.map(([k, label]) => <button key={k} type="button" disabled={ro || lab.busy} onClick={() => list(k)} data-testid={`list-${k}`}>List {label.toLowerCase()}</button>)}
        </div>
        <div className="row">
          <label>Call a tool by name<input list="disc-tools" value={tool} maxLength={60} onChange={(e) => setTool(e.target.value)} data-testid="disc-tool" autoComplete="off" /></label>
          <datalist id="disc-tools">{app.tools.map((t) => <option key={t.name} value={t.name} />)}</datalist>
          <button type="button" disabled={ro || lab.busy} onClick={() => send("tools/call", { name: tool, arguments: {} })} data-testid="disc-call">Call it (no arguments)</button>
          <label>Any JSON-RPC method<input value={method} maxLength={40} onChange={(e) => setMethod(e.target.value)} data-testid="disc-method" autoComplete="off" /></label>
          <label>name or uri<input value={param} maxLength={60} onChange={(e) => setParam(e.target.value)} data-testid="disc-param" autoComplete="off" /></label>
          <button type="button" disabled={ro || lab.busy || !method} onClick={() => send(method, method === "resources/read" ? { uri: param } : param ? { name: param } : {})} data-testid="disc-send">Send</button>
        </div>
        {res && (
          <div className="pair" data-testid="disc-result">
            <div>
              <h4>What the upstream sent (everything)</h4>
              {upstream ? <ul className="plain" data-testid="upstream-list">{upstream.map((n) => <li key={typeof n === "string" ? n : n.uri || n.name}><code>{visible(typeof n === "string" ? n : n.uri || n.name)}</code></li>)}</ul> : <p className="muted">Only listings show the upstream's full answer.</p>}
              <p className="muted">Wire style: {style}. {view?.operator?.frames?.length ? `${view.operator.frames.length} frame(s): ${view.operator.frames.map((f) => f.kind).join(", ")}.` : ""}</p>
            </div>
            <div>
              <h4>What the agent receives <span className="verdict" data-state={res.ok ? "ok" : "bad"} data-testid="disc-verdict">{res.ok ? "allowed" : `refused (${res.body?.error}, HTTP ${res.status})`}</span></h4>
              {listing ? <ul className="plain" data-testid="agent-list">{listing.map((n) => <li key={n.name || n.uri}><code>{visible(n.name || n.uri)}</code></li>)}</ul> : <Json value={rpc || { note: "a bare 403: no JSON-RPC body" }} label="answer" testId="disc-rpc" />}
              {view?.wire && <p className="muted" data-testid="disc-wire">HTTP {view.wire.httpStatus}. {visible(view.wire.note || "")}</p>}
              {view?.reason && <p className="muted" data-testid="disc-reason">Operator-only reason: <code>{visible(view.reason)}</code> (the agent cannot tell a hidden tool from one that does not exist).</p>}
              {view?.operator?.log?.length > 0 && <div data-testid="gateway-log"><h4>Gateway log <SourceTag source="measured" label="line wording: measured (AI-DEMO2 note)" /></h4><ul className="plain">{view.operator.log.map((l, i) => <li key={i}><code>{visible(l)}</code></li>)}</ul></div>}
            </div>
          </div>)}
        <Outcome last={lab.last} ops={["mcp"]} />
      </section>

      <section className="panel" aria-label="Policy" data-testid="policy-panel">
        <h3 className="panel__sub">Policy of {visible(app.id)} <SourceTag source="invented" label="grant shape: lab-invented" /></h3>
        <p className="muted">A grant names a group and the tools, prompts and resources it may see and use; the grants of a user's groups add up; no grant means no access, from the first initialize.</p>
        {s.groups.map((g) => (
          <fieldset className="fieldset" key={g}><legend>{g}</legend>
            {KINDS.map(([k, label]) => names[k].length > 0 && (
              <div key={k}><strong>{label}</strong>
                <div className="checks">
                  <label><input type="checkbox" disabled={ro} checked={grants[g]?.[k].has("*") || false} onChange={() => toggle(g, k, "*")} data-testid={`g-${g}-${k}-*`} />*</label>
                  {names[k].map((n0) => { const n = typeof n0 === "string" ? n0 : n0.name || n0; return <label key={n}><input type="checkbox" disabled={ro} checked={grants[g]?.[k].has(n) || false} onChange={() => toggle(g, k, n)} data-testid={`g-${g}-${k}-${n}`} />{visible(n)}</label>; })}
                </div>
              </div>))}
          </fieldset>))}
        <button type="button" disabled={ro || lab.busy} onClick={save} data-testid="save-app-policy">Save the policy</button>
        <Outcome last={lab.last} ops={["setPolicy"]} />
        <p className="muted">Status of the application: <StatusTag status={app.up ? "running" : "unreachable"} /> authentication mode <code>{visible(app.authMode)}</code>.</p>
      </section>
      <FieldSources fields={story.fieldSources.filter((f) => FIELD_RE.test(f.field))} />
    </div>
  );
}
