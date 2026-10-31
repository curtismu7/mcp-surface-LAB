// The Mock tables are generated from the engine. A test fails if they drift, if the talk-track doc drifts, and if the HTTP API (Live) gives a different final
// state than the scripted run for the same steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCK_TABLE } from '../src/mockTable.js';
import { EXPECTED, buildMockTable, runScenario, scenarioList, stepParams } from '../src/scenarios.js';
import { VERTICALS, DEFAULT_CAST } from '../src/cast.js';
import { renderTalkTrackMarkdown } from '../src/story.js';
import { OP_NAMES } from '../src/actions.js';
import { act, get, json, withServer, W } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the committed Mock table is exactly what the engine generates now (run `npm run mock-table` after a change)', () => {
  assert.deepEqual(MOCK_TABLE, buildMockTable());
});

test('every scripted step gives the result the story says, in every vertical, and every scenario and step has a say', () => {
  for (const [v, cast] of Object.entries(VERTICALS)) {
    for (const sc of scenarioList(cast)) {
      const got = runScenario(cast, sc).steps.map((s) => (s.result.ok ? 'ok' : s.result.code));
      assert.deepEqual(got, EXPECTED[sc.id], `${v}/${sc.id}`);
      assert.ok(sc.say.length > 20);
      for (const st of sc.steps) assert.ok(st.say.length > 5);
    }
  }
  assert.deepEqual(Object.keys(EXPECTED), scenarioList(DEFAULT_CAST).map((s) => s.id));
});

test('the Mock table records the steps that were run, and every action the engine has is exercised by at least one scenario', () => {
  const t = MOCK_TABLE.verticals.finance.scenarios.find((s) => s.id === 'aggregate-cap');
  assert.deepEqual(t.steps.map((s) => (s.ok ? 'ok' : s.code)), EXPECTED['aggregate-cap']);
  assert.equal(MOCK_TABLE.verticals.finance.scenarios.length, 8);
  const used = new Set(scenarioList(DEFAULT_CAST).flatMap((s) => s.steps.map((x) => x.op)));
  const unused = OP_NAMES.filter((o) => !used.has(o));
  assert.deepEqual(unused.sort(), ['aggRemoveMember', 'aggSetPolicy', 'cimdSet', 'setAppUp', 'upstreamRevoke'], 'only the config edits that have their own engine tests');
});

test('docs/talk-track.md is exactly what the talk-track data generates (run `npm run talk-track`)', () => {
  assert.equal(fs.readFileSync(path.join(root, 'docs/talk-track.md'), 'utf8'), renderTalkTrackMarkdown(DEFAULT_CAST));
});

test('MOCK/LIVE PARITY: replaying every scenario through the HTTP API gives exactly the state the Mock table holds', async () => {
  await withServer(async (url) => {
    let n = 0;
    for (const sc of scenarioList(VERTICALS.finance)) {
      const ws = `parity-${n++}`; const prev = [];
      for (const [i, st] of sc.steps.entries()) {
        const r = await act(url, st.op, stepParams(st, prev), ws);
        prev.push(r.body.ok ? { ok: true, result: r.body.result } : { ok: false, code: r.body.error });
        assert.equal(r.body.ok === true ? 'ok' : r.body.error, EXPECTED[sc.id][i], `${sc.id}: ${st.say}`);
      }
      const live = (await json(await get(url, '/api/state?mode=live&vertical=finance', W(ws)))).state;
      const mock = MOCK_TABLE.verticals.finance.scenarios.find((s) => s.id === sc.id).state;
      assert.deepEqual(live, mock, sc.id);
    }
  });
});

test('a mutated engine is caught by the drift test: a changed refusal makes the generated table differ from the committed one', () => {
  const t = buildMockTable(); t.verticals.finance.scenarios[0].steps[1].code = 'allowed';
  assert.notDeepEqual(t, MOCK_TABLE);
});
