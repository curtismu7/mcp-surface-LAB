import { useEffect, useState } from "react";
import RunObservability from "../run-observability/RunObservability";
import { sendJson } from "../api";

// Rule 27: "What each layer logged for this run", the shared panel under the Last action and "What Privilege did". This lab has no Real mode and reads no product log: Mock
// shows the decisions the engine took when its tables were generated, Live is the same local engine acting on your own calls, so every row is simulated and the panel's
// source is "mock" in both. (The header toggle's Live is the rule-19 source "real"; it is not a log source.)
const SOURCE = "mock";
// The actions that decide something and so make a run (server/src/actions.js RUN_OPS; a server test compares the two lists).
const RUN_OPS = ["mcp", "passThrough", "propose", "decide"];
// Protocol and session requests the lab can answer or refuse but does not map to rows here: the audit log holds them. A server test compares this list with the actions.
const PROTOCOL_OPS = ["oauthRegister", "oauthAuthorize", "oauthToken", "cimdResolve", "upstreamAuthorize", "route", "sessionOpen", "sessionUse"];
const TITLE = "What each layer logged for this run";

// Where this lab's own lines live and where they can stream (the README says the same).
export const LOG_STREAMS = [
  { product: "MCP Surface LAB (Live engine)", lives: "the lab container's stdout: one line per decision (check, layer, actor, agent, result, run; never a token), stamped with the lab clock. Mock reads recorded tables and writes none", streams: "nowhere today: the family log collector does not read this container. If it did, the SIEM time would be Docker's wall-clock time per line, and the lab-clock time would stay inside the line" },
  { product: "Ping MCP gateway, Privilege, PingOne Authorize", lives: "not run by this lab: its gateway, policy engine and MCP servers are one simulated engine in one process", streams: "nothing to stream" },
];

const Note = ({ testId, children, busy }) => (
  <section className="ro" data-testid={testId} aria-label={TITLE} role={busy ? "status" : undefined}>
    <h2>{TITLE}</h2>
    <p className="ro-muted">{children}</p>
  </section>
);

// What the page may show for an answer of GET /api/run-record: a record, the documented "no run" answer, or an { error, message }. Anything else (an HTML page from a proxy,
// a JSON string, an array, an empty object) is an alert: it is never read as "nothing ran yet".
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function answerOf(r) {
  const b = r.body;
  if (isObj(b) && typeof b.error === "string") return { error: b.error, message: typeof b.message === "string" ? b.message : "" };
  if (r.ok && isObj(b) && isObj(b.record)) return { record: b.record };
  if (r.ok && isObj(b) && b.record === null && typeof b.message === "string") return { record: null, message: b.message };
  return { error: "bad_answer", message: `The lab server answered with something that is not a run record (HTTP ${r.status}).` };
}

const noRunText = (op) => (RUN_OPS.includes(op)
  ? "That attempt was turned away before the gateway took any decision (a request the lab could not read), so it began no run, and there is no record for it."
  : op === "oaPreview" ? "That action (oaPreview) only reads a specification: it changes nothing and takes no decision, so it makes no run."
    : PROTOCOL_OPS.includes(op) ? `That request (${op}) is OAuth, CIMD, routing or session traffic. The lab can answer or refuse it, but this panel does not map it to rows, so it makes no run here. The lab's audit log holds what it did.`
      : `That action (${op}) changes configuration and takes no gateway, policy or approval decision, so it makes no run. The lab's audit log holds it.`);

// `mode` is the page's mode (mock or live). Mock reads the scripted scenario on screen; Live reads the run the last action made, by its id, and says so when that action began
// no run. The previous record is never shown while a new one is read (the key changes first), and an answer for a request that is no longer the latest is dropped.
export default function RunRecordPanel({ mode, vertical, last, scenarioId }) {
  const key = mode === "mock" ? (scenarioId ? `mock|${vertical}|${scenarioId}` : null) : mode === "live" && last?.runId ? `live|${vertical}|${last.runId}` : null;
  const [state, setState] = useState({ key: null, answer: null });
  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    const q = mode === "mock" ? `scenario=${encodeURIComponent(scenarioId)}` : `runId=${encodeURIComponent(last.runId)}`;
    sendJson("GET", `/api/run-record?mode=${mode}&vertical=${encodeURIComponent(vertical)}&${q}`).then(
      (r) => { if (alive) setState({ key, answer: answerOf(r) }); },
      (e) => { if (alive) { console.error(`[mcp-surface-lab] the run record could not be read: ${e?.message}`); setState({ key, answer: { error: "unreachable", message: "The lab server could not be reached." } }); } },
    );
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (mode !== "mock" && mode !== "live") return null;
  if (mode === "live" && last && !key) {
    return <Note testId="ro-no-run">{last.runLogFailed ? "The lab's recorder failed for this run, so no record was kept. The action itself went through; the server's stderr says why." : noRunText(last.op)}</Note>;
  }
  if (key && (state.key !== key || !state.answer)) return <Note testId="ro-loading" busy>Collecting this run&apos;s logs…</Note>;
  const answer = key ? state.answer : null;
  const record = answer ? (answer.error ? { error: answer.error, message: answer.message } : answer.record) : null;
  return (
    <>
      <RunObservability record={record} source={SOURCE} streams={LOG_STREAMS} />
      {answer && !answer.error && !answer.record && answer.message && <p className="ro-muted" data-testid="ro-none">{answer.message}</p>}
      {mode === "live" && last?.runLogFailed && <p className="ro-muted" role="alert" data-testid="ro-log-failed">The lab&apos;s log writer failed for this run: the record above holds every decision, but not every one reached stdout. The action itself went through; the server&apos;s stderr says why.</p>}
      <div data-testid="ro-lab-note">
        <p className="ro-muted">
          The line under the title says the lab&apos;s mock computed these rows: in this lab Mock and Live are both simulated, so it means this lab&apos;s own engine computed them, in Live as well. Nothing here was read from a product log.
        </p>
        <p className="ro-muted">
          Under Privilege and Agent gateway is that same engine standing in for Ping&apos;s, not Ping&apos;s: the policy checks sit under Privilege, the gateway&apos;s own steps under Agent gateway. The same entitlement is a refusal under Privilege when a call names a tool outside the policy, and information under Agent gateway when a listing is filtered in flight (the filter hides names; it turns no request away). Person is a name picked from the lab&apos;s roster (it has no sign-in), Agent is the agent key and the backend credential step, and Resource server is the lab&apos;s mock MCP server. Authorize is not modelled.
        </p>
        <p className="ro-muted">
          Times are the lab&apos;s own clock: it starts at 2026-11-02T09:00:00Z and moves only when you advance it. {mode === "mock"
            ? "Mock's run is the whole scripted scenario above, recorded when the lab's tables were generated: each row starts with the step (the call) that made it, and the counts in the summary add up every call of the scenario."
            : "Live is the same engine acting on your calls, one run for each call, attempt, proposal or decision."}
        </p>
      </div>
    </>
  );
}
