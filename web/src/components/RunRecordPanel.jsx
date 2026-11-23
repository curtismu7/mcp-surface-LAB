import { useEffect, useState } from "react";
import RunObservability from "../run-observability/RunObservability";
import { sendJson } from "../api";

// Rule 27: "What each layer logged for this run", the shared panel under the Last action and "What Privilege did". This lab has no Real mode and reads no product log: Mock
// shows the decisions the engine took when its tables were generated, Live is the same local engine acting on your own calls, so every row is simulated and the panel's
// source is "mock" in both. (The header toggle's Live is the rule-19 source "real"; it is not a log source.)
const SOURCE = "mock";
// The actions that decide something and so make a run (server/src/actions.js RUN_OPS; a server test compares the two lists).
const RUN_OPS = ["mcp", "passThrough", "propose", "decide"];
const TITLE = "What each layer logged for this run";

// Where this lab's own lines live and where they can stream (the README says the same).
export const RUN_OBS_STREAMS = [
  { product: "MCP Surface LAB (Live engine)", lives: "the lab container's stdout: one line per decision (check, layer, actor, agent, result, run; never a token), stamped with the lab clock. Mock reads recorded tables and writes none", streams: "nowhere today: the family log collector does not read this container. If it did, the SIEM time would be Docker's wall-clock time per line, and the lab-clock time would stay inside the line" },
  { product: "Ping MCP gateway, Privilege, PingOne Authorize", lives: "not run by this lab: its gateway, policy engine and MCP servers are one simulated engine in one process", streams: "nothing to stream" },
];

const Note = ({ testId, children, busy }) => (
  <section className="ro" data-testid={testId} aria-label={TITLE} role={busy ? "status" : undefined}>
    <h2>{TITLE}</h2>
    <p className="ro-muted">{children}</p>
  </section>
);

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
      (r) => { if (alive) setState({ key, answer: r.body }); },
      (e) => { if (alive) { console.error(`[mcp-surface-lab] the run record could not be read: ${e?.message}`); setState({ key, answer: { error: "unreachable", message: "The lab server could not be reached." } }); } },
    );
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (mode !== "mock" && mode !== "live") return null;
  if (mode === "live" && last && !key) {
    return <Note testId="ro-no-run">{RUN_OPS.includes(last.op)
      ? "That attempt was turned away before the gateway took any decision, so it began no run, and there is no record for it."
      : `That action (${last.op}) changes configuration and takes no gateway, policy or approval decision, so it makes no run. The audit log above holds it.`}</Note>;
  }
  if (key && (state.key !== key || !state.answer)) return <Note testId="ro-loading" busy>Collecting this run&apos;s logs…</Note>;
  const answer = key ? state.answer : null;
  const record = answer ? (answer.error ? { error: answer.error, message: answer.message } : answer.record) : null;
  return (
    <>
      <RunObservability record={record} source={SOURCE} streams={RUN_OBS_STREAMS} />
      {answer && !answer.error && !answer.record && answer.message && <p className="ro-muted" data-testid="ro-none">{answer.message}</p>}
      <p className="ro-muted" data-testid="ro-lab-note">
        Under Privilege and Agent gateway is this lab&apos;s own simulated engine, not Ping&apos;s: the policy checks sit under Privilege, the gateway&apos;s own steps under Agent gateway. Person is a name picked from the lab&apos;s roster (it has no sign-in), Agent is the agent key and the backend credential step, and Resource server is the lab&apos;s mock MCP server. Authorize is not modelled.
        Times are the lab&apos;s own clock: it starts at 2026-11-02T09:00:00Z and moves only when you advance it. {mode === "mock"
          ? "Mock shows the decisions the engine took when its tables were generated, for the scripted scenario above."
          : "Live is the same engine acting on your calls, so these rows are simulated too."} Nothing here was read from a product log.
      </p>
    </>
  );
}
