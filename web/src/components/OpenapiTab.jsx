import { useEffect, useRef, useState } from "react";
import { visible } from "../safeText";
import { ClaimTag, FieldSources, Json, Outcome, ScenarioBox, SourceTag } from "./Bits";

const FIELD_RE = /OpenAPI|tool naming|header and cookie|default grant on a generated/i;

// OpenAPI to MCP (slide 38). The parser and the generated tools are REAL and local; the backend is an in-process mock REST service. Nothing leaves the machine.
export default function OpenapiTab({ story, mode, lab, actor, admin, scenarioId, setScenarioId }) {
  const s = lab.state; const ro = lab.readOnly;
  const [text, setText] = useState(story.sampleSpec);
  const [name, setName] = useState(story.cast.castApi);
  const [prev, setPrev] = useState(null);
  const [perr, setPerr] = useState(null);
  const seq = useRef(0);
  const [user, setUser] = useState("");
  const [srvApp, setSrvApp] = useState("");
  const [tool, setTool] = useState("");
  const [args, setArgs] = useState("{}");
  const [res, setRes] = useState(null);
  const [argErr, setArgErr] = useState("");
  const servers = s.openapi.servers;
  const cur = servers.find((x) => x.appId === srvApp) || servers[0];
  useEffect(() => { setText(story.sampleSpec); setName(story.cast.castApi); }, [story.vertical]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = async () => {
    const mine = ++seq.current;
    const r = await lab.act("oaPreview", { spec: text });
    if (mine !== seq.current) return;
    if (r.ok) { setPrev(r.body.result); setPerr(null); } else { setPrev(null); setPerr({ code: r.body?.error, detail: r.body?.detail }); }
  };
  // Remove one operation from the pasted JSON (so a redeploy shows it disappearing). Works on the text, never on the server's copy.
  const removeOp = (path, method) => { try { const d = JSON.parse(text); delete d.paths[path][method.toLowerCase()]; if (!Object.keys(d.paths[path]).length) delete d.paths[path]; setText(JSON.stringify(d, null, 2)); } catch { setPerr({ code: "not_json", detail: "the specification text is not valid JSON, so the lab cannot edit it" }); } };
  const deploy = () => lab.act("oaDeploy", { actor: admin, name, spec: text });
  const redeploy = () => lab.act("oaRedeploy", { actor: admin, id: cur.id, spec: text });
  const callTool = async () => {
    setArgErr(""); let a; try { a = JSON.parse(args || "{}"); } catch { setArgErr("The arguments are not valid JSON."); return; }
    const r = await lab.act("mcp", { user: user || actor, target: { kind: "app", id: cur.appId }, rpc: { method: "tools/call", params: { name: tool || cur.tools[0]?.name, arguments: a } } });
    setRes({ ok: r.ok && r.body?.ok !== false, status: r.status, body: r.body });
  };
  const listAs = async () => { const r = await lab.act("mcp", { user: user || actor, target: { kind: "app", id: cur.appId }, rpc: { method: "tools/list" } }); setRes({ ok: r.ok, status: r.status, body: r.body, listing: true }); };
  const view = res?.body?.result || res?.body?.data;
  const toolsShown = prev?.tools;
  const people = s.users;

  return (
    <div className="stack">
      <ScenarioBox lab={lab} ids={["openapi"]} mode={mode} scenarioId={scenarioId} setScenarioId={setScenarioId} label="OpenAPI scenario" />
      <section className="panel">
        <h2 className="panel__title">OpenAPI to MCP <ClaimTag /> <span className="tag" data-state="ok">slide 38</span> <span className="tag" data-state="ok" data-testid="real-tag">runs for real, locally</span></h2>
        <p className="muted">Paste an OpenAPI 3.x JSON document. Every operation becomes a tool with a per-operation schema from the spec. The parser is bounded (40,000 characters, 60 operations, depth 40), refuses remote and file references and YAML, and never evaluates anything. Calls run against an in-process mock backend: no network. Authentication to the backend is header-based only; login flows stay the agent's job.</p>
        <label>OpenAPI document (JSON)<textarea value={text} rows={14} maxLength={40000} spellCheck="false" onChange={(e) => setText(e.target.value)} data-testid="spec" /></label>
        <div className="row">
          <button type="button" onClick={() => setText(story.sampleSpec)} data-testid="load-sample">Load the sample</button>
          <button type="button" disabled={lab.busy} onClick={preview} data-testid="preview">Generate the tools (preview)</button>
          <label>Name for the application<input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} data-testid="oa-name" autoComplete="off" /></label>
          <button type="button" disabled={ro || lab.busy || !name} onClick={deploy} data-testid="deploy">Deploy as an MCP application</button>
          <button type="button" disabled={ro || lab.busy || !cur} onClick={redeploy} data-testid="redeploy">Redeploy {cur ? visible(cur.appId) : ""} from this text</button>
        </div>
        {ro && <p className="muted" data-testid="oa-ro">Mock mode: the preview runs the same parser on your text; deploying and calling need Live.</p>}
        {perr && <p className="field-error" role="alert" data-testid="spec-error">Refused ({perr.code}): {visible(perr.detail)}</p>}
        <Outcome last={lab.last} ops={["oaDeploy", "oaRedeploy"]} />
        {lab.last?.ok && lab.last.op === "oaRedeploy" && (
          <div className="callout" data-testid="redeploy-diff"><h4>The tool surface followed the specification</h4>
            <p>Added: {lab.last.result.diff.added.map(visible).join(", ") || "none"}. Removed: {lab.last.result.diff.removed.map(visible).join(", ") || "none"}. Schema changed: {lab.last.result.diff.changed.map(visible).join(", ") || "none"}. A removed operation is gone for everyone; an added one arrives with no grant.</p></div>)}
      </section>

      {toolsShown && (
        <section className="panel" aria-label="Generated tools" data-testid="generated">
          <h3 className="panel__sub">{toolsShown.length} tools generated from {visible(prev.api.title)} {visible(prev.api.version)} <span className="muted">(backend base: {visible(prev.api.server)}, never contacted)</span></h3>
          <div className="scroll"><table className="tbl tbl--wide" data-testid="tool-table">
            <thead><tr><th>Tool</th><th>Naming</th><th>Operation</th><th>Arguments (from the spec)</th><th>Edit</th></tr></thead>
            <tbody>{toolsShown.map((t) => (
              <tr key={t.name} data-testid={`tool-${t.name}`}><td><code>{visible(t.name)}</code><br /><span className="muted">{visible(t.description)}</span></td><td><SourceTag source="invented" label={t.nameRule} /></td><td>{t.method} {visible(t.path)}</td>
                <td>{t.args.length ? t.args.map((a) => <code key={a}>{visible(a)}{t.required.includes(a) ? "*" : ""} </code>) : "none"}</td>
                <td><button type="button" onClick={() => removeOp(t.path, t.method)} data-testid={`remove-${t.name}`}>Remove from the text</button></td></tr>))}</tbody></table></div>
          <h4>Authentication to the backend (header-based only)</h4>
          <ul className="plain" data-testid="auth-list">{prev.auth.length ? prev.auth.map((a) => <li key={a.scheme}><code>{visible(a.scheme)}</code>: {a.handled === "header" ? <>the gateway injects the <code>{visible(a.header)}</code> header</> : <>{visible(a.why)}</>}</li>) : <li>no security scheme declared</li>}</ul>
          {prev.notExposed.length > 0 && <p className="muted" data-testid="not-exposed">Not exposed as arguments: {prev.notExposed.map((n) => `${visible(n.tool)} (${n.in})`).join(", ")}.</p>}
          {prev.warnings.length > 0 && <p className="muted">Notes: {prev.warnings.map(visible).join("; ")}</p>}
          <details><summary>Input schema of each tool</summary>{toolsShown.map((t) => <div key={t.name}><h4>{visible(t.name)}</h4><Json value={t.inputSchema} label={`schema of ${t.name}`} tall /></div>)}</details>
        </section>)}

      <section className="panel" aria-label="Deployed servers" data-testid="deployed">
        <h3 className="panel__sub">Generated servers fronted by the gateway ({servers.length})</h3>
        {servers.length === 0 && <p className="muted">None yet. Deploy the specification above as an application.</p>}
        {servers.map((x) => (
          <div key={x.id} data-testid={`server-${x.appId}`}>
            <p><strong>{visible(x.appId)}</strong> (generation {x.generation}, {x.deployments} deployment(s), spec digest <code>{x.specDigest}</code>): {x.tools.map((t) => t.name).join(", ")}</p>
          </div>))}
        {cur && (
          <>
            <div className="row">
              <label>Server<select value={cur.appId} onChange={(e) => { setSrvApp(e.target.value); setTool(""); }} data-testid="server-select">{servers.map((x) => <option key={x.id} value={x.appId}>{x.appId}</option>)}</select></label>
              <label>Call as<select value={user || actor} onChange={(e) => setUser(e.target.value)} data-testid="oa-user">{people.map((p) => <option key={p.id} value={p.id}>{p.id} ({p.groups.join(", ")})</option>)}</select></label>
              <button type="button" disabled={ro || lab.busy} onClick={listAs} data-testid="oa-list">List the tools this user sees</button>
            </div>
            <div className="row">
              <label>Tool<select value={tool || cur.tools[0]?.name || ""} onChange={(e) => setTool(e.target.value)} data-testid="oa-tool">{cur.tools.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</select></label>
              <label className="grow">Arguments (JSON)<input value={args} onChange={(e) => setArgs(e.target.value)} data-testid="oa-args" autoComplete="off" /></label>
              <button type="button" disabled={ro || lab.busy} onClick={callTool} data-testid="oa-call">Call</button>
            </div>
            {argErr && <p className="field-error" role="alert">{argErr}</p>}
          </>)}
        {res && (
          <div className="pair" data-testid="oa-result">
            <div><h4>What the agent sees <span className="verdict" data-state={res.ok ? "ok" : "bad"}>{res.ok ? "allowed" : `refused (${res.body?.error}, HTTP ${res.status})`}</span></h4>
              {view?.rpc?.result?.tools ? <ul className="plain" data-testid="oa-visible">{view.rpc.result.tools.map((t) => <li key={t.name}><code>{visible(t.name)}</code></li>)}</ul> : <Json value={view?.rpc ? view.rpc.result?.content?.[0]?.text ?? view.rpc : { note: "a bare 403" }} label="answer" testId="oa-answer" />}</div>
            <div><h4>What the backend received</h4>
              {view?.operator?.credential ? <Json value={view.operator.credential} label="credential injection" testId="oa-cred" /> : <p className="muted">Nothing: the call was refused before the backend.</p>}</div>
          </div>)}
      </section>
      <FieldSources fields={story.fieldSources.filter((f) => FIELD_RE.test(f.field))} />
    </div>
  );
}
