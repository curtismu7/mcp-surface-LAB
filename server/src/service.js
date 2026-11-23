// The glue between the HTTP layer and the engine: Mock reads generated tables, Live drives the workspace's engine. Every action gets one W3C trace and a
// list of hops (the raw request and response panes), with anything credential-shaped masked. An mcp action also returns the gateway trace ("What Privilege did").
import { Engine } from './engine.js';
import { isPure, perform } from './actions.js';
import { newTrace, formatTraceparent } from './trace.js';
import { scrub } from './util.js';
import { commitRun } from './runObs.js';

export function mockState(table, vertical, scenarioId) {
  const v = table.verticals[vertical];
  const sc = (typeof scenarioId === 'string' && v.scenarios.find((s) => s.id === scenarioId)) || v.scenarios[0];
  return { state: sc.state, scenario: { id: sc.id, title: sc.title, say: sc.say, steps: sc.steps }, scenarios: v.scenarios.map((s) => ({ id: s.id, title: s.title, say: s.say })) };
}

export function liveState(ws, workspaces, vertical, cast) {
  const e = workspaces.peek(ws, vertical) || new Engine(cast);
  return e.snapshot();
}

// Runs one engine action for a workspace with a trace. Returns { outcome, hops, traceparent, state, runId }. `log` receives one stdout line per decision of a run.
export function runAction({ ws, workspaces, vertical, cast, op, params, traceparent, route, engine, log = () => {} }) {
  // A new workspace is only kept if the request CHANGED something the visitor can see: a refused request (bad parameters, an unknown user) and a pure preview
  // leave no workspace behind, so they cannot use up the cap. The cap itself is checked first, before any work.
  // A PURE action (the OpenAPI preview) reads nothing and changes nothing, so it never needs a slot: with no workspace yet it runs on a throw-away engine, even at the cap.
  let e = engine; let fresh = null;
  if (!e) { e = workspaces.peek(ws, vertical) && workspaces.engine(ws, vertical, cast); if (!e) { if (isPure(op)) e = new Engine(cast); else { workspaces.assertRoom(ws); e = new Engine(cast); fresh = JSON.stringify(e.snapshot()); } } }
  const t = newTrace(traceparent);
  const root = t.span();
  e.trace = { traceId: t.traceId, span: t.span }; e.hops = []; e.hopsTruncated = false; e.gwTrace = null;
  let outcome;
  try { outcome = perform(e, op, params); } finally { e.trace = null; }
  if (fresh !== null && JSON.stringify(e.snapshot()) !== fresh) workspaces.adopt(ws, vertical, e);
  // Run observability (rule 27): the events this action stored are kept as a run and written to stdout. A recorder that throws must never break the action or its audit.
  // The run is kept only when the workspace that holds it is (a run id the record route could not find is never returned), and a writer that fails leaves the run and its id.
  let runId = null; let runLogFailed = false;
  try {
    const c = e.lastRun ? commitRun(e, e.lastRun, log, e.lastRunKept && workspaces.peek(ws, vertical) === e) : null;
    runId = c?.id ?? null;
    if (c?.writeError) throw c.writeError;
  } catch (err) { runLogFailed = true; console.error(`[mcp-surface-lab] the run log was not written completely: ${String(err?.code || err?.name || 'Error').slice(0, 40)}: ${String(err?.message).replace(/[\r\n]+/g, ' ').slice(0, 200)}`); }
  e.lastRun = null;
  const first = { n: 1, label: 'browser to the lab API', request: { method: route.method, url: route.url, headers: { traceparent: formatTraceparent(t.traceId, root), 'x-workspace': ws }, body: scrub(params) }, response: { status: outcome.ok ? 200 : outcome.status, body: outcome.ok ? { ok: true } : { error: outcome.code } } };
  const hops = [first, ...e.hops.map((h, i) => ({ ...h, n: i + 2 }))];
  const truncated = e.hopsTruncated; e.hops = [];
  const gatewayTrace = e.gwTrace; e.gwTrace = null; // "What Privilege did": set by an mcp action only
  return { outcome, hops, gatewayTrace, runId, runLogFailed, hopsTruncated: truncated, traceparent: formatTraceparent(t.traceId, root), traceId: t.traceId, state: e.snapshot() };
}
