import { useRef } from "react";
import { visible } from "../safeText";

// Raw JSON or text, rendered as text only (never markup). Control and bidi characters are shown as visible escapes.
export function Json({ value, label, testId, tall }) {
  return <pre className={`json${tall ? " json--tall" : ""}`} tabIndex={0} aria-label={label} data-testid={testId}>{visible(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</pre>;
}

// Every product claim carries this tag. It is on every tab, and in presenter mode too.
export function ClaimTag({ label }) {
  return <span className="tag" data-state="warn" data-testid="claim-tag">{label || "Ping release claim, UNVERIFIED on our tenant"}</span>;
}

// Where a field comes from: the deck, the console swagger (a name only), the lab's reading, the lab's own invention, or an AI-DEMO2 measured note.
const SRC = { deck: ["deck claim", "ok"], swagger: ["console swagger name (schema only)", "ok"], reading: ["lab reading", "warn"], invented: ["lab-invented", "none"], measured: ["measured (AI-DEMO2 note)", "ok"] };
export function SourceTag({ source, label }) {
  const [text, state] = SRC[source] || [source, "none"];
  return <span className="tag" data-state={state} data-testid="source-tag">{label || text}</span>;
}

// status words with a state, so meaning never rests on colour alone
const GOOD = new Set(["ok", "healthy", "connected", "approved", "authorized", "accepted", "verified", "allowed", "running", "granted", "pass"]);
const BAD = new Set(["missing", "unreachable", "unhealthy", "denied", "refused", "failed", "expired", "revoked", "exited", "hung", "fail"]);
export const StatusTag = ({ status }) => <span className="tag" data-state={GOOD.has(status) ? "ok" : BAD.has(status) ? "bad" : "warn"} data-testid="status">{status}</span>;

export function Hops({ hops, traceId, truncated }) {
  return (
    <details className="hops" data-testid="hops">
      <summary>Raw hops with traceparent{traceId ? ` (trace ${traceId.slice(0, 8)}...)` : ""} ({hops.length})</summary>
      {truncated && <p className="muted">Only the first hops are shown.</p>}
      {hops.map((h) => (
        <div key={h.n}>
          <h4 className="hops__title">{h.n}. {h.label}</h4>
          <Json value={h.request} label={`hop ${h.n} request`} />
          <Json value={h.response} label={`hop ${h.n} response`} />
        </div>
      ))}
    </details>
  );
}

// The per-field source table, so every claim is tagged deck claim, swagger name, lab reading, lab-invented or measured.
export function FieldSources({ fields, title }) {
  return (
    <details data-testid="field-sources">
      <summary>{title || "Where each field comes from"} ({fields.length})</summary>
      <div className="scroll"><table className="tbl tbl--wide">
        <thead><tr><th>Field</th><th>Source</th><th>Note</th></tr></thead>
        <tbody>{fields.map((f) => <tr key={f.field}><td><code>{visible(f.field)}</code></td><td><SourceTag source={f.source} /></td><td>{visible(f.note)}</td></tr>)}</tbody>
      </table></div>
    </details>
  );
}

// Stale-response guard: run() returns a function that says whether a newer request has started since.
export function useSeq() {
  const seq = useRef(0);
  return () => { const mine = ++seq.current; return () => mine === seq.current; };
}

// A refusal or a success message under a control, as text. The browser logs a deliberate 4xx as a console message: that is the refusal the visitor asked to see.
export function Outcome({ last, ops }) {
  if (!last || (ops && !ops.includes(last.op))) return null;
  return last.ok ? <p className="muted" role="status" data-testid="outcome">Done.</p> : <p className="field-error" role="alert" data-testid="outcome">Refused ({last.error}, HTTP {last.status}): {visible(last.detail || "")}</p>;
}

// Mock mode: the end state of a scripted scenario, with each step's result. Live mode shows nothing here.
export function ScenarioBox({ lab, ids, mode, scenarioId, setScenarioId, label }) {
  if (mode !== "mock" || !lab.scenarios.length) return null;
  const list = lab.scenarios.filter((s) => !ids || ids.includes(s.id));
  const cur = lab.scenario && (!ids || ids.includes(lab.scenario.id)) ? lab.scenario : null;
  return (
    <section className="panel" data-testid="scenario-box" aria-label="Scripted scenarios">
      <h3 className="panel__sub">{label || "Scripted scenarios"} <span className="tag" data-state="none">Mock: generated from the engine</span></h3>
      <div className="scenario" role="group" aria-label="Scenario">
        {list.map((s) => <button key={s.id} type="button" aria-pressed={cur?.id === s.id} onClick={() => setScenarioId(s.id)} data-testid={`scn-${s.id}`}>{s.title}</button>)}
      </div>
      {cur ? (
        <>
          <p className="muted">{cur.say}</p>
          <ol className="steps" data-testid="scenario-steps">{cur.steps.map((st, i) => <li key={i} data-state={st.ok ? "ok" : "bad"}><strong>{st.ok ? "ok" : `refused (${st.code})`}.</strong> {visible(st.say)}</li>)}</ol>
        </>
      ) : <p className="muted">Pick a scenario: the page below shows the state at its end.</p>}
    </section>
  );
}
