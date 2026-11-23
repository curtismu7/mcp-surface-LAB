// Rule 27: this lab's side of the shared run-observability panel. The vendored collector (runObservability.js) is never edited here.
//
// Every decision the engine takes during a run action (actions.js RUN_OPS) is stamped ONCE, in engine.js, with the lab clock (engine.observe). This module is
// handed those stored events and does three things: keeps them as a run (live: the engine keeps its last 20), writes ONE stdout line for each, and builds the
// record from the stored events only. Nothing is re-run, no time is invented (a record's times are the lines' times), and an event the engine did not compute is
// never shown. A scenario's events are stored in the Mock table when it is generated (scenarios.js), read back here.
//
// Mock and Live both produce `simulated` rows: Live is this lab's own engine acting on the visitor's calls, nothing is read from a product log, so every record
// has source `mock` (the shared contract keeps `real` for rows read from a product's log or reply). The lab clock is not the wall clock: it starts at
// 2026-11-02T09:00:00Z and moves only when the visitor advances it, so every time here is the lab's.
//
// Stdout line (what a collector would ship; Live only, Mock reads a table and decides nothing when read):
// `<lab-clock iso> mcp-surface-lab decision check=<id> layer=<layer> actor=<user> agent=<agent|-> result=<passed|stopped|unclear> run=<id>`
// The family's matchers read words such as refused, denied, rejected, forbidden, failed, invalid, expired, mismatch, token, audience, scope and served, so the line
// uses none of them (the check ids come from a fixed table, and the one id with such a word is renamed in engine.js). A test runs every line through classify().
import crypto from 'node:crypto';
import { LAYERS, createMasker, createRunObservability, keepPattern } from './runObservability.js';

export const MAX_RUNS = 20; // live runs the engine keeps (the newest is never the one dropped)
const SERVICE = 'mcp-surface-lab';
const RESULT = { allowed: 'passed', refused: 'stopped', blocked: 'stopped', info: 'unclear' };

// Only safe characters survive, so a name cannot add a second key=value pair, a quote or a line.
export const lineValue = (v, n = 64) => String(v ?? '').replace(/[^A-Za-z0-9._:/@-]+/g, '_').slice(0, n) || '-';
// The panel masks emails, addresses and ids in every row, so the stdout line masks them too (then keeps only safe characters).
const { mask } = createMasker();
const KEEP = keepPattern({});
const field = (v) => lineValue(mask(String(v ?? ''), KEEP));
export const decisionLine = (e, runId) => `${e.at} ${SERVICE} decision check=${lineValue(e.check)} layer=${lineValue(e.layer, 12)} actor=${field(e.actor)} agent=${field(e.agent)} result=${RESULT[e.outcome] || 'unclear'} run=${lineValue(runId)}`;

// A person row alone is no decision: an action that only looked a user up began no run.
export const hasDecision = (events) => Array.isArray(events) && events.some((e) => e.layer !== 'person');

// Run ids are unique across Reset, workspaces and verticals: a random part per process and a counter that nothing resets.
const PART = crypto.randomBytes(3).toString('hex');
let made = 0;

// Keeps the events of one action as a run on its engine (the newest MAX_RUNS), and writes one stdout line per event. `kept` is false for a request that began no run (it
// failed validation, or its workspace is not held): its lines are still written, with run=-, and it gets no id. Returns null when the action made no decision (the caller
// says so; it never shows an older run), else { id, writeError }: the id is null when no run was kept, writeError is the first error the writer threw.
// The run is kept, with its id, BEFORE anything is written, so a writer that fails part-way loses lines and never the run: every line is tried, and the page is told.
export function commitRun(engine, events, write, kept = true) {
  if (!hasDecision(events)) return null;
  const id = kept ? `run-${PART}-${++made}` : null;
  const stored = events.map((e, i) => ({ ...e, seq: i + 1 }));
  if (kept) {
    engine.runs.push({ id, mode: 'live', events: stored });
    if (engine.runs.length > MAX_RUNS) engine.runs.shift();
  }
  let writeError = null;
  for (const e of stored) { try { write(decisionLine(e, id)); } catch (err) { writeError ??= err; } }
  return { id, writeError };
}

const PRODUCT = { person: 'lab roster', agent: 'lab agent and credential step', privilege: 'lab policy engine', gateway: 'lab simulated MCP gateway', resource: 'lab mock MCP server' };
// Why a layer has no row. Statements about this lab, used when the run has no event for the layer.
const WHY = {
  person: 'No roster user was looked up in this run. The lab has no sign-in step: a person is only ever a name picked from its roster.',
  agent: 'No agent key and no backend credential were evaluated in this run (a stop before the credential step, a listing, an approval).',
  authorize: 'This lab does not model PingOne Authorize. Its own engine decides, shown under Privilege and Agent gateway.',
  privilege: 'The lab\'s policy engine took no decision in this run.',
  gateway: 'The simulated gateway took no decision of its own in this run.',
  resource: 'The mock MCP server was not asked in this run: an earlier decision stopped the call, or the run needed no server (an aggregate listing, an approval).',
};

// The record of one run, from its stored events. Rows tie on the lab clock (one action decides many things at one instant), and the collector breaks a tie by layer,
// so ties are put back in the order the engine decided them: a refusal must never read as coming before the check that made it.
export async function buildRecord({ runId, events, clock = Date.now }) {
  const rec = await createRunObservability({ clock }).collectRun({
    runId, startedAt: events[0].at, endedAt: events[events.length - 1].at, source: 'mock',
    layers: LAYERS.map((layer) => ({
      layer, products: [], reason: WHY[layer],
      simulated: events.filter((e) => e.layer === layer).map((e) => ({ at: e.at, product: PRODUCT[layer], outcome: e.outcome, message: e.n ? `Step ${e.n}: ${e.message}` : e.message, detail: { ...e.detail, check: e.check, seq: e.seq, ...(e.n ? { scenarioStep: e.n } : {}), ...(e.actor ? { actor: e.actor } : {}), ...(e.agent ? { agent: e.agent } : {}) } })),
    })), // no correlation: nothing is matched against logs here, so no id is declared and names stay readable
  });
  const stamped = rec.rows.filter((r) => r.at !== null).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.detail.seq - b.detail.seq);
  return { ...rec, rows: [...stamped.map((r, i) => ({ ...r, id: `r${i + 1}` })), ...rec.rows.filter((r) => r.at === null)] };
}

// The record of a Live run the engine holds, or null.
export function liveRecord(engine, runId) {
  const run = engine ? engine.runs.find((r) => r.id === runId) : null;
  return run ? buildRecord({ runId: run.id, events: run.events }) : null;
}

// The record of a scripted scenario in the Mock table: the decisions the engine took when the table was generated (scenarios.js stored them), or null.
export function scenarioRecord(vertical, scenario) {
  const events = scenario.run?.events;
  return hasDecision(events) ? buildRecord({ runId: `mock-${vertical}-${scenario.id}`, events: events.map((e, i) => ({ ...e, seq: i + 1 })) }) : null;
}
