// The glue between the HTTP layer and the engine: Mock reads generated tables, Live drives the workspace's engine. Every action gets one W3C trace and a
// list of hops (the raw request and response panes), with anything credential-shaped masked.
import { Engine } from './engine.js';
import { perform } from './actions.js';
import { newTrace, formatTraceparent } from './trace.js';
import { scrub } from './util.js';

export function mockState(table, vertical, scenarioId) {
  const v = table.verticals[vertical];
  const sc = (typeof scenarioId === 'string' && v.scenarios.find((s) => s.id === scenarioId)) || v.scenarios[0];
  return { state: sc.state, scenario: { id: sc.id, title: sc.title, say: sc.say, steps: sc.steps }, scenarios: v.scenarios.map((s) => ({ id: s.id, title: s.title, say: s.say })) };
}

export function liveState(ws, workspaces, vertical, cast) {
  const e = workspaces.peek(ws, vertical) || new Engine(cast);
  return e.snapshot();
}

// Runs one engine action for a workspace with a trace. Returns { outcome, hops, traceparent, state }.
export function runAction({ ws, workspaces, vertical, cast, op, params, traceparent, route, engine }) {
  // A new workspace is only kept if the request CHANGED something the visitor can see: a refused request (bad parameters, an unknown user) and a pure preview
  // leave no workspace behind, so they cannot use up the cap. The cap itself is checked first, before any work.
  let e = engine; let fresh = null;
  if (!e) { e = workspaces.peek(ws, vertical) && workspaces.engine(ws, vertical, cast); if (!e) { workspaces.assertRoom(ws); e = new Engine(cast); fresh = JSON.stringify(e.snapshot()); } }
  const t = newTrace(traceparent);
  const root = t.span();
  e.trace = { traceId: t.traceId, span: t.span }; e.hops = []; e.hopsTruncated = false;
  let outcome;
  try { outcome = perform(e, op, params); } finally { e.trace = null; }
  if (fresh !== null && JSON.stringify(e.snapshot()) !== fresh) workspaces.adopt(ws, vertical, e);
  const first = { n: 1, label: 'browser to the lab API', request: { method: route.method, url: route.url, headers: { traceparent: formatTraceparent(t.traceId, root), 'x-workspace': ws }, body: scrub(params) }, response: { status: outcome.ok ? 200 : outcome.status, body: outcome.ok ? { ok: true } : { error: outcome.code } } };
  const hops = [first, ...e.hops.map((h, i) => ({ ...h, n: i + 2 }))];
  const truncated = e.hopsTruncated; e.hops = [];
  return { outcome, hops, hopsTruncated: truncated, traceparent: formatTraceparent(t.traceId, root), traceId: t.traceId, state: e.snapshot() };
}
