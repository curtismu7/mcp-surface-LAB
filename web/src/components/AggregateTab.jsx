import { useEffect, useMemo, useState } from "react";
import { visible } from "../safeText";
import { ClaimTag, FieldSources, Json, Outcome, ScenarioBox, SourceTag, StatusTag } from "./Bits";

const PRESETS = (c) => [
  { id: "ok", label: "Allowed by both", name: `${c.castApp1}__read_record`, args: { id: "r-1" } },
  { id: "agg-denies", label: "Member allows, aggregate denies", name: `${c.castApp2}__create_item`, args: { name: "x" } },
  { id: "member-denies", label: "Aggregate allows, member denies", name: `${c.castApp2}__refund_item`, args: { id: "r-1" } },
  { id: "down", label: "Member is down", name: `${c.castApp4}__search`, args: { query: "q" } },
  { id: "hang", label: "Member recorded as sse (hangs)", name: `${c.castApp5}__search`, args: { query: "q" } },
  { id: "missing", label: "Member does not exist", name: `${c.castMissing}__search`, args: { query: "q" } },
  { id: "bare", label: "A bare, un-namespaced name", name: "search", args: { query: "q" } },
];
const FIELD_RE = /Members|AppRef|Alias|ToolFilter|aggregate|enforced twice|connected lazily|reported missing|hang|refusal|cap header|faults/i;

// MCP Aggregate (slide 37): one endpoint, many members; the aggregate's own policy is the cap, enforced on the listing and call and again at the member hop.
export default function AggregateTab({ story, mode, lab, actor, admin, scenarioId, setScenarioId }) {
  const s = lab.state; const ro = lab.readOnly; const agg = s.aggregates[0];
  const [res, setRes] = useState(null);
  const [tool, setTool] = useState("");
  const [args, setArgs] = useState("{}");
  const [style, setStyle] = useState("json");
  const [argErr, setArgErr] = useState("");
  const presets = useMemo(() => PRESETS(story.cast), [story]);
  const allNames = useMemo(() => agg.members.flatMap((m) => { const app = s.apps.find((a) => a.id === m.appRef.RefID); return app ? app.tools.map((t) => `${m.effectiveAlias}__${t.name}`) : []; }), [s, agg]);
  useEffect(() => { if (!tool && presets[0]) { setTool(presets[0].name); setArgs(JSON.stringify(presets[0].args)); } }, [presets, tool]);

  const call = async (method, params) => {
    setArgErr("");
    const r = await lab.act("mcp", { user: actor, target: { kind: "aggregate", id: agg.id }, rpc: { method, params }, style });
    setRes({ ok: r.ok && r.body?.ok !== false, status: r.status, body: r.body });
  };
  const doCall = () => { let a; try { a = JSON.parse(args || "{}"); } catch { setArgErr("The arguments are not valid JSON."); return; } call("tools/call", { name: tool, arguments: a }); };
  const view = res?.body?.result || res?.body?.data || null;
  const rpc = view?.rpc;

  // the aggregate's policy editor: a checkbox per prefixed tool per group
  const [grants, setGrants] = useState({});
  const policyKey = JSON.stringify(agg.policy);
  useEffect(() => { setGrants(Object.fromEntries(s.groups.map((g) => [g, new Set(agg.policy.grants.find((x) => x.group === g)?.tools || [])]))); }, [policyKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (g, n) => setGrants((cur) => { const set = new Set(cur[g]); if (set.has(n)) set.delete(n); else set.add(n); return { ...cur, [g]: set }; });
  const savePolicy = () => lab.act("aggSetPolicy", { actor: admin, aggregateId: agg.id, grants: s.groups.filter((g) => grants[g]?.size).map((g) => ({ group: g, tools: [...grants[g]] })) });

  const [alias, setAlias] = useState({}); const [filter, setFilter] = useState({}); const [newRef, setNewRef] = useState("");
  const saveMember = (m) => lab.act("aggSetMember", { actor: admin, aggregateId: agg.id, refId: m.appRef.RefID, ...(alias[m.appRef.RefID] !== undefined ? { alias: alias[m.appRef.RefID] } : {}), ...(filter[m.appRef.RefID] !== undefined ? { toolFilter: { Elems: filter[m.appRef.RefID].split(",").map((x) => x.trim()).filter(Boolean) } } : {}) });

  return (
    <div className="stack">
      <ScenarioBox lab={lab} ids={["aggregate-cap", "members"]} mode={mode} scenarioId={scenarioId} setScenarioId={setScenarioId} label="Aggregate scenarios" />
      <section className="panel">
        <h2 className="panel__title">MCP Aggregate: one endpoint, many servers <ClaimTag /> <span className="tag" data-state="ok">GA badge, slide 37</span></h2>
        <p className="muted">The agent connects once to <code>{agg.entryPath}</code>. Every member's tools arrive under <code>alias__tool</code>. The aggregate's own policy is the cap: a tool is visible only if it permits it, enforced on the listing and call at the aggregate and again at the member hop.</p>
        <p className="muted" data-testid="actor-note">{ro ? "Mock only reads tables: switch to Live to act." : <>Calling and proposing as <strong>{visible(actor)}</strong>, configuring as <strong>{visible(admin)}</strong>: calls are made as this user; configuration needs an administrator.</>}</p>
      </section>

      <section className="panel" aria-label="Members" data-testid="members">
        <h3 className="panel__sub">Members <SourceTag source="swagger" label="Members[], AppRef, Alias, ToolFilter: console swagger names (schema only)" /></h3>
        <div className="scroll"><table className="tbl tbl--wide">
          <thead><tr><th>Alias</th><th>Application</th><th>Status</th><th>Connection (lazy)</th><th>Tool filter</th><th>Edit</th></tr></thead>
          <tbody>{agg.members.map((m) => (
            <tr key={m.appRef.RefID} data-testid={`member-${m.appRef.RefID}`}>
              <td><code>{visible(m.effectiveAlias)}</code>{m.alias ? "" : <span className="muted"> (default)</span>}</td>
              <td>{visible(m.appRef.RefID)}</td>
              <td><StatusTag status={m.status} /> <span className="muted">{visible(m.note)}</span></td>
              <td data-testid={`conn-${m.appRef.RefID}`}>{m.connection.state}; connects {m.connection.connects}; calls {m.connection.calls}{m.connection.attempts > m.connection.calls ? `; failed attempts ${m.connection.attempts - m.connection.calls}` : ""}</td>
              <td>{m.toolFilter.Elems.length ? m.toolFilter.Elems.join(", ") : "all (empty means all)"}</td>
              <td>
                <div className="row">
                  <label>Alias<input value={alias[m.appRef.RefID] ?? m.alias} maxLength={32} onChange={(e) => setAlias((a) => ({ ...a, [m.appRef.RefID]: e.target.value }))} data-testid={`alias-${m.appRef.RefID}`} autoComplete="off" /></label>
                  <label>Tool filter (bare, comma separated)<input value={filter[m.appRef.RefID] ?? m.toolFilter.Elems.join(",")} onChange={(e) => setFilter((a) => ({ ...a, [m.appRef.RefID]: e.target.value }))} data-testid={`filter-${m.appRef.RefID}`} autoComplete="off" /></label>
                  <button type="button" disabled={ro || lab.busy} onClick={() => saveMember(m)} data-testid={`save-member-${m.appRef.RefID}`}>Save</button>
                  <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("aggRemoveMember", { actor: admin, aggregateId: agg.id, refId: m.appRef.RefID })}>Remove</button>
                </div>
              </td>
            </tr>))}</tbody></table></div>
        <div className="row">
          <label>Add a member (an application name; it is resolved lazily)<input value={newRef} maxLength={32} onChange={(e) => setNewRef(e.target.value)} data-testid="new-member" autoComplete="off" /></label>
          <button type="button" disabled={ro || lab.busy || !newRef} onClick={() => lab.act("aggSetMember", { actor: admin, aggregateId: agg.id, refId: newRef })} data-testid="add-member">Add member</button>
        </div>
        <Outcome last={lab.last} ops={["aggSetMember", "aggRemoveMember"]} />
        {lab.last?.op === "aggSetMember" && lab.last.ok && lab.last.result?.staleGrants > 0 && <p className="callout" data-state="warn" role="status" data-testid="stale-grants">{lab.last.result.staleGrants} grant name(s) now match nothing: the policy names tools by their prefixed form (measured, AI-DEMO2 note).</p>}
      </section>

      <section className="panel" aria-label="The aggregate policy (the cap)" data-testid="aggregate-policy">
        <h3 className="panel__sub">The aggregate's policy is the cap <SourceTag source="deck" /> <SourceTag source="measured" label="prefixed names in the grant: measured (AI-DEMO2 note)" /></h3>
        <p className="muted">Per group, the prefixed tools the aggregate permits. A member can only ever expose a subset of this, and only what its own policy also allows.</p>
        {s.groups.map((g) => (
          <fieldset className="fieldset" key={g}><legend>{g}</legend>
            <div className="checks checks__box">
              <label><input type="checkbox" checked={grants[g]?.has("*") || false} disabled={ro} onChange={() => toggle(g, "*")} data-testid={`pol-${g}-*`} />* (everything the members allow)</label>
              {allNames.map((n) => <label key={n}><input type="checkbox" checked={grants[g]?.has(n) || false} disabled={ro} onChange={() => toggle(g, n)} data-testid={`pol-${g}-${n}`} />{visible(n)}</label>)}
            </div>
          </fieldset>))}
        <button type="button" disabled={ro || lab.busy} onClick={savePolicy} data-testid="save-policy">Save the aggregate policy</button>
        <Outcome last={lab.last} ops={["aggSetPolicy"]} />
      </section>

      <section className="panel" aria-label="Call through the aggregate" data-testid="call-panel">
        <h3 className="panel__sub">Call through the aggregate as {visible(actor)}</h3>
        <div className="row">
          <button type="button" disabled={ro || lab.busy} onClick={() => call("tools/list", {})} data-testid="list-tools">List tools</button>
          <label>Wire style of the member hop (when a member is called)<select value={style} onChange={(e) => setStyle(e.target.value)} data-testid="style">{story.styles.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
        </div>
        <div className="scenario" role="group" aria-label="Presets">
          {presets.map((p) => <button key={p.id} type="button" onClick={() => { setTool(p.name); setArgs(JSON.stringify(p.args)); }} data-testid={`preset-${p.id}`}>{p.label}</button>)}
        </div>
        <div className="row">
          <label className="grow">Tool (namespaced)<input value={tool} maxLength={80} onChange={(e) => setTool(e.target.value)} data-testid="tool" autoComplete="off" /></label>
          <label className="grow">Arguments (JSON)<input value={args} onChange={(e) => setArgs(e.target.value)} data-testid="args" autoComplete="off" /></label>
          <button type="button" disabled={ro || lab.busy || !tool} onClick={doCall} data-testid="call-tool">Call</button>
        </div>
        {argErr && <p className="field-error" role="alert">{argErr}</p>}
        <div className="row">
          <label className="check"><input type="checkbox" checked={s.faults.aggregateSkipsCheck} disabled={ro || lab.busy} onChange={(e) => lab.act("setFault", { actor: admin, aggregateSkipsCheck: e.target.checked })} data-testid="fault-agg" />Fault: the aggregate skips its own check</label>
          <label className="check"><input type="checkbox" checked={s.faults.hopIgnoresCap} disabled={ro || lab.busy} onChange={(e) => lab.act("setFault", { actor: admin, hopIgnoresCap: e.target.checked })} data-testid="fault-hop" />Fault: the member hop ignores the cap header</label>
          <SourceTag source="invented" label="the two switches are lab-invented: each layer alone is enough" />
        </div>
        {res && (
          <div className="pair" data-testid="call-result">
            <div>
              <h4>What the agent sees <span className="verdict" data-state={res.ok ? "ok" : "bad"} data-testid="verdict">{res.ok ? "allowed" : `refused (${res.body?.error}, HTTP ${res.status})`}</span></h4>
              {rpc?.result?.tools ? <ul className="plain" data-testid="agent-tools">{rpc.result.tools.map((t) => <li key={t.name}><code>{visible(t.name)}</code>{t._meta?.unavailable ? <span className="tag" data-state="bad"> unavailable: {t._meta.unavailable}</span> : null}</li>)}</ul> : <Json value={rpc || { note: "no JSON-RPC body" }} label="JSON-RPC answer" testId="rpc" />}
              {view?.wire && <p className="muted" data-testid="wire-note">HTTP on the wire: {view.wire.httpStatus}. {visible(view.wire.note || "")}</p>}
            </div>
            <div>
              <h4>What the operator sees</h4>
              <dl className="kv">
                <dt>Enforced at</dt><dd data-testid="enforced-at">{visible(view?.operator?.enforcedAt || view?.enforcedAt || "")}</dd>
                {view?.reason && <><dt>Reason</dt><dd>{visible(view.reason)}</dd></>}
                {view?.operator?.cap && <><dt>Cap sent to the hop</dt><dd><code>{visible(view.operator.cap.join(", "))}</code></dd></>}
                {view?.operator?.connection && <><dt>Connection</dt><dd>{visible(JSON.stringify(view.operator.connection))}</dd></>}
                {view?.operator?.backendIdentity && <><dt>Backend saw</dt><dd>{visible(view.operator.backendIdentity.actor)} ({view.operator.backendIdentity.kind})</dd></>}
                {view?.measured && <><dt>Measured note</dt><dd>{visible(view.measured)}</dd></>}
              </dl>
              {view?.operator?.members && (
                <div className="scroll"><table className="tbl" data-testid="listing-members"><thead><tr><th>Member</th><th>Status</th><th>Listed</th><th>Hidden by the aggregate</th><th>Hidden by the member</th></tr></thead>
                  <tbody>{view.operator.members.map((m) => <tr key={m.alias}><td>{visible(m.alias)}</td><td><StatusTag status={m.status} /></td><td>{m.listed.length}</td><td>{m.hiddenByAggregate.map(visible).join(", ") || "-"}</td><td>{m.hiddenByMember.map(visible).join(", ") || "-"}</td></tr>)}</tbody></table></div>)}
            </div>
          </div>)}
        <Outcome last={lab.last} ops={["mcp"]} />
      </section>

      <section className="callout" data-state="warn" data-testid="deck-vs-measured">
        <h4>Deck claim versus our measured note: a member can hang</h4>
        <p><SourceTag source="deck" /> Slide 37: a member that is missing or unreachable is reported as such instead of silently dropping its tools.</p>
        <p><SourceTag source="measured" /> {visible(story.discrepancies.find((d) => d.id === "hang").text.replace(/^Deck \(slide 37\)[^.]*\. /, ""))}</p>
        <div className="row">
          <button type="button" disabled={ro || lab.busy} onClick={() => lab.act("setTransport", { actor: admin, appId: story.cast.castApp5, transport: s.apps.find((a) => a.id === story.cast.castApp5)?.transport === "sse" ? "streamable-http" : "sse" })} data-testid="toggle-transport">Toggle the recorded transport of {visible(story.cast.castApp5)} (now {s.apps.find((a) => a.id === story.cast.castApp5)?.transport ?? "unknown"})</button>
        </div>
      </section>
      <FieldSources fields={story.fieldSources.filter((f) => FIELD_RE.test(f.field))} />
    </div>
  );
}
