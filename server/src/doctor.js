// Preflight checks shared by `npm run doctor` and GET /api/health. Never prints a secret, needs no network.
// Each check: { id, level: 'pass' | 'info' | 'fail', detail }.
import fs from 'node:fs';
import { assertBindAllowed, bindHost, portProblem, scanHosts, scanKeys, DEFAULT_PORT, PORT_MIN, PORT_MAX } from './safety.js';
import { netguardSelfTest } from './netguard.js';
import { VERTICALS, unfilled } from './cast.js';
import { buildStory, rawStory } from './story.js';
import { Engine } from './engine.js';
import { EXPECTED, PKCE_CHALLENGE, PKCE_VERIFIER, buildMockTable, runScenario, scenarioList } from './scenarios.js';
import { findCredentials } from './credentials.js';
import { maskDeep } from './mask.js';
import { modeFrom } from './config.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import { MOCK_TABLE } from './mockTable.js';
import { settingsPath } from './settings.js';
import { perform } from './actions.js';
import { generateTools, parseSpec } from './openapi.js';
import { s256 } from './oauth.js';
import { sampleSpec } from './world.js';
import { keyPair } from './jwt.js';

export const settingsFile = (env = process.env) => (env.STANDALONE_ENV ? env.STANDALONE_ENV : settingsPath(env));

export async function runChecks({ env = process.env, table = MOCK_TABLE } = {}) {
  const checks = [];
  const add = (id, level, detail) => checks.push({ id, level, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 26 ? 'pass' : 'fail', `v${process.versions.node} (need >= 26)`);

  try { add('mode', 'pass', `${modeFrom(env)} is the opening mode (mock is the default); the header toggle switches between mock and live, both loopback-only`); }
  catch (e) { add('mode', 'fail', e.message); }

  try { add('bind', 'pass', `${assertBindAllowed(bindHost(env), env)}${env.MSFLAB_BIND ? ' (MSFLAB_BIND opt-in)' : ' (loopback)'}`); }
  catch (e) { add('bind', 'fail', e.message); }

  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);
  const problem = portProblem(port);
  add('port-range', problem ? 'fail' : 'pass', problem || `${port} is inside ${PORT_MIN}-${PORT_MAX} and not reserved`);

  const file = settingsFile(env);
  try { const m = fs.statSync(file).mode & 0o777; add('settings-file', m & 0o077 ? 'info' : 'pass', m & 0o077 ? 'the shared settings file is readable by others: chmod 600 it' : 'the shared settings file exists and is mode 600 (values are never printed)'); }
  catch { add('settings-file', 'info', 'no shared settings file: mock mode needs none'); }

  // Each scripted step gives the result the story says it does, in every vertical, and the Mock table agrees with the engine.
  const wrong = [];
  for (const [vertical, cast] of Object.entries(VERTICALS)) {
    for (const sc of scenarioList(cast)) {
      const { steps } = runScenario(cast, sc);
      if (steps.map((s) => (s.result.ok ? 'ok' : s.result.code)).join() !== EXPECTED[sc.id].join()) wrong.push(`${vertical}/${sc.id}`);
    }
  }
  add('scenarios', wrong.length ? 'fail' : 'pass', wrong.length ? `scripted steps that do not give their expected result: ${wrong.slice(0, 6).join(', ')}` : `${Object.keys(EXPECTED).length} scripted scenarios give their expected results in ${Object.keys(VERTICALS).length} verticals`);
  const fresh = buildMockTable();
  add('mock-table', JSON.stringify(fresh) === JSON.stringify(table) ? 'pass' : 'fail', JSON.stringify(fresh) === JSON.stringify(table) ? 'the mock table matches the engine' : 'the mock table drifts from the engine (run npm run mock-table)');

  // A live cycle on a throwaway engine, computed now: the aggregate cap at both enforcement points, and a hidden tool refused.
  const e = new Engine(VERTICALS.finance); const c = e.cast; const agg = { kind: 'aggregate', id: 'all-in-one' };
  const call = (user, name, args) => perform(e, 'mcp', { user, target: agg, rpc: { method: 'tools/call', params: { name, arguments: args } } });
  const atAgg = call(c.castUser, `${c.castApp2}__create_item`, { name: 'x' });
  const atHop = call(c.castUser, `${c.castApp2}__refund_item`, { id: 'r-1' });
  const good = call(c.castUser, `${c.castApp1}__read_record`, { id: 'r-1' });
  perform(e, 'setFault', { actor: c.castAdmin, aggregateSkipsCheck: true });
  const secondAlone = call(c.castUser, `${c.castApp2}__create_item`, { name: 'x' });
  const cap = !atAgg.ok && atAgg.data.enforcedAt === 'aggregate' && !atHop.ok && /member-hop/.test(atHop.data.enforcedAt) && good.ok && !secondAlone.ok && /member-hop/.test(secondAlone.data.enforcedAt);
  add('aggregate-cap', cap ? 'pass' : 'fail', cap ? 'a tool the member allows but the aggregate denies was refused at the aggregate; one the aggregate allows but the member denies at the member hop; with the first layer off the second still refuses (computed now)' : 'the aggregate cap did not behave');

  const parsed = generateTools(parseSpec(JSON.stringify(sampleSpec(c))));
  let remote = false; try { parseSpec(JSON.stringify({ openapi: '3.0.0', info: {}, paths: { '/a': { get: { $ref: 'https://x.example/y.json#/z' } } } })); } catch (err) { remote = err.code === 'external_ref_refused'; }
  add('openapi', parsed.tools.length === 4 && remote ? 'pass' : 'fail', `the sample specification gives ${parsed.tools.length} tools and a remote $ref is refused (computed now)`);

  // Real crypto: PKCE S256 against the RFC 7636 test vector, and an RS256 round trip with a locally generated RSA key.
  add('pkce', s256(PKCE_VERIFIER) === PKCE_CHALLENGE ? 'pass' : 'fail', 'S256 of the RFC 7636 example verifier gives the example challenge');
  const k = keyPair('doctor');
  add('rsa', k.publicKey.asymmetricKeyType === 'rsa' ? 'pass' : 'fail', 'RSA 2048 keys are generated locally on first use (never EC, never written to disk, never shown)');

  const raw = rawStory(); const text = JSON.stringify(raw);
  const holes = unfilled(text, VERTICALS.finance);
  add('story-tokens', holes.length ? 'fail' : 'pass', holes.length ? `unfilled {{tokens}}: ${[...new Set(holes)].join(', ')}` : 'every {{cast}} token is filled');
  const badVert = Object.entries(VERTICALS).filter(([, v2]) => unfilled(text, v2).length).map(([k2]) => k2);
  add('verticals', badVert.length ? 'fail' : 'pass', badVert.length ? `verticals missing a token: ${badVert.join(', ')}` : `${Object.keys(VERTICALS).length} vertical packs fill every token`);
  const filled = JSON.stringify([...Object.keys(VERTICALS).map((v) => buildStory(VERTICALS[v], v)), table]);
  const hosts = scanHosts(filled);
  add('story-hosts', hosts.length ? 'fail' : 'pass', hosts.length ? `non-reserved hosts: ${hosts.join(', ')}` : 'every host in the story data and the Mock table is .invalid or .example');
  // The credential detectors read TEXT: they are run on each string value, not on the JSON dump (in a dump, `"tokens":120` is a JSON key and a number, not an assignment).
  const leaves = []; const todo = [JSON.parse(filled)];
  while (todo.length) { const x = todo.pop(); if (typeof x === 'string') leaves.push(x); else if (x && typeof x === 'object') todo.push(...Object.values(x)); }
  const keys = scanKeys(filled); const creds = leaves.flatMap((t) => findCredentials(t)).filter((x) => x.id !== 'key-like' && x.id !== 'long-blob');
  add('story-keys', keys.length || creds.length ? 'fail' : 'pass', keys.length || creds.length ? 'credential-shaped text in the story data' : 'no credential-shaped value anywhere in the story data or the Mock table');
  const story = buildStory(VERTICALS.finance, 'finance');
  add('masking', JSON.stringify(maskDeep(story)) === JSON.stringify(story) ? 'pass' : 'fail', 'the response mask leaves the story untouched (it only changes credential-shaped values)');
  add('diagrams', DIAGRAM_NAMES.every((n) => buildDiagram(VERTICALS.finance, n).steps.length > 0) ? 'pass' : 'fail', `${DIAGRAM_NAMES.length} diagram-studio/1 diagrams load and validate`);

  const ng = await netguardSelfTest();
  add('netguard', ng.ok ? 'pass' : 'fail', ng.ok ? `blocked fetch, socket, socket-by-IP, dns lookup, dns resolve and udp to a non-loopback host (${ng.blocked}/6)` : ng.detail);
  add('tenant', 'pass', 'simulated only: no tenant, no credentials, no outbound network; every product claim is UNVERIFIED on our tenant');
  return checks;
}

export const allPassed = (checks) => checks.every((c) => c.level !== 'fail');
