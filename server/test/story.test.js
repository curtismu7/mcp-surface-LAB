import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_CAST, VERTICALS } from '../src/cast.js';
import { buildStory, renderTalkTrackMarkdown } from '../src/story.js';
import { BANNER, CLAIMS, CLAIM_LABEL, DISCREPANCIES, FIELD_SOURCES, TALK_TRACK, WHY, SOURCE_NAMES } from '../src/data.js';
import { maskDeep } from '../src/mask.js';
import { DIAGRAM_NAMES, buildDiagram, loadDiagram, rawDiagram } from '../src/diagramData.js';
import { validateDiagram } from '../src/diagramStudioValidate.js';
import { maskResponseText } from '../src/mask.js';

test('the banner says it is simulated and a Ping claim UNVERIFIED on our tenant, and names its mode', () => {
  for (const [mode, re] of [['mock', /MOCK mode/], ['live', /LIVE mode/]]) { assert.match(BANNER[mode], /SIMULATED/); assert.match(BANNER[mode], re); assert.match(BANNER[mode], /UNVERIFIED on our tenant/); }
  assert.equal(CLAIM_LABEL, 'Ping release claim, UNVERIFIED on our tenant');
});

test('every field is tagged with where it comes from: deck claim, console swagger name (schema only), lab reading, lab-invented or measured (AI-DEMO2 note)', () => {
  assert.ok(FIELD_SOURCES.length >= 40);
  assert.deepEqual(Object.keys(SOURCE_NAMES).sort(), ['deck', 'invented', 'measured', 'reading', 'swagger']);
  for (const f of FIELD_SOURCES) { assert.ok(Object.hasOwn(SOURCE_NAMES, f.source), f.field); assert.ok(f.note.length > 25, f.field); }
  const sw = FIELD_SOURCES.filter((f) => f.source === 'swagger').map((f) => f.field).join(' ');
  for (const name of ['Members', 'AppRef', 'Alias', 'ToolFilter', 'AuthMode', 'CIMDConfig', 'CacheTTLHours', 'IsPrivate', 'FetchedAt']) assert.ok(sw.includes(name), name);
  const swaggerRows = FIELD_SOURCES.filter((f) => f.source === 'swagger');
  assert.ok(swaggerRows.every((r) => /^model|^Members|^modelMcp/.test(r.field)), 'the "swagger" tag is used only for bare field-name rows');
  assert.ok(FIELD_SOURCES.filter((f) => f.source === 'measured').every((f) => /AI-DEMO2/.test(f.note)), 'every measured row names its source');
  const story = buildStory(DEFAULT_CAST, 'finance');
  assert.ok(story.fieldSources.every((f) => f.sourceLabel));
});

test('every deck claim cites its slide (36 to 39), and the lab never says "door"', () => {
  assert.ok(CLAIMS.every((c) => [36, 37, 38, 39].includes(c.slide)));
  for (const s of [36, 37, 38, 39]) assert.ok(CLAIMS.some((c) => c.slide === s), `slide ${s}`);
  assert.ok(!/\bdoor\b/i.test(JSON.stringify(buildStory(DEFAULT_CAST, 'finance'))));
  assert.ok(CLAIMS.find((c) => c.id === 'deployment').claim.includes('clipped'), 'the clipped slide line is labelled as clipped');
});

test('the deck-versus-measured differences are shown: the hang, listed-is-not-working, refusal shape, token-pass framing, CIMD unproven, the clipped slide', () => {
  assert.deepEqual(DISCREPANCIES.map((d) => d.id).sort(), ['cimd-unproven', 'hang', 'listed-not-working', 'refusal-shape', 'slide-36-cut', 'token-pass-framing']);
  assert.match(DISCREPANCIES.find((d) => d.id === 'hang').text, /Deck \(slide 37\)/); assert.match(DISCREPANCIES.find((d) => d.id === 'hang').text, /measured note/);
});

test('the talk track has the four Why it matters entries (challenge, technical, business), marked as Ping claims, with the deck\'s wording', () => {
  assert.deepEqual(WHY, ['why-gateway', 'why-aggregate', 'why-openapi', 'why-catalog']);
  for (const id of WHY) { const t = TALK_TRACK.find((x) => x.id === id); for (const p of ['Challenge:', 'Technical:', 'Business:']) assert.match(t.say, new RegExp(p)); assert.match(t.say, /Ping claims, unverified on our tenant/); }
  assert.match(TALK_TRACK.find((x) => x.id === 'why-aggregate').say, /one policy cap enforced twice/); assert.match(TALK_TRACK.find((x) => x.id === 'why-catalog').say, /blind supply-chain risk/);
  assert.match(TALK_TRACK.find((x) => x.id === 'why-openapi').say, /days rather than sprints/); assert.match(TALK_TRACK.find((x) => x.id === 'why-gateway').say, /no attribution, no per-tool control/);
});

test('docs/talk-track.md is exactly what the generator makes (no drift)', () => {
  const file = new URL('../../docs/talk-track.md', import.meta.url);
  assert.equal(fs.readFileSync(file, 'utf8'), renderTalkTrackMarkdown(DEFAULT_CAST));
  assert.ok(!/\{\{/.test(fs.readFileSync(file, 'utf8')));
});

test('the response mask leaves every vertical\'s story untouched, and no fixed message in the source is altered by it (a "token is ..." sentence would be masked)', () => {
  for (const [v, c] of Object.entries(VERTICALS)) { const s = buildStory(c, v); assert.deepEqual(maskDeep(s), s, v); }
  const dir = new URL('../src/', import.meta.url); const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const code = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const m of code.matchAll(/(?:refuse|jerr)\(\s*'[a-z_0-9]+',\s*(?:\d+,\s*-?\d+,\s*)?(['`])((?:\\.|(?!\1).)*)\1/g)) { const msg = m[2].replace(/\$\{[^}]*\}/g, 'x'); if (maskResponseText(msg) !== msg) bad.push(`${f}: ${msg.slice(0, 70)}`); }
  }
  assert.deepEqual(bad, []);
});

test('the diagrams are diagram-studio/1 data, valid, loaded by name, with no overlapping node positions and every edge a step', () => {
  assert.deepEqual(DIAGRAM_NAMES, ['aggregate-cap', 'discovery-filter', 'passthrough-assertion']);
  for (const n of DIAGRAM_NAMES) {
    assert.deepEqual(validateDiagram(loadDiagram(n)), []);
    const d = rawDiagram(n); assert.equal(d.schema, 'diagram-studio/1');
    const boxes = d.nodes.map((x) => ({ x: x.x, y: x.y })); // a box is about 230 by 100
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(Math.abs(boxes[i].x - boxes[j].x) >= 260 || Math.abs(boxes[i].y - boxes[j].y) >= 130, `${n}: ${d.nodes[i].id} and ${d.nodes[j].id} overlap`);
    assert.equal(d.steps.length, d.edges.length, 'every edge is a step');
    const b = buildDiagram(DEFAULT_CAST, n);
    assert.ok(b.steps.every((s) => s.edge.length <= 44), `${n}: edge labels are short enough not to collide`);
    assert.ok(!/\{\{/.test(JSON.stringify(b)));
  }
  assert.equal(buildDiagram(DEFAULT_CAST, 'nope').name, 'aggregate-cap', 'an unknown name falls back');
  assert.ok(validateDiagram({ ...rawDiagram('aggregate-cap'), schema: 'x' }).length > 0);
});

test('the story lists the pieces the page needs: methods, auth modes, defects, scopes, the sample spec, the PKCE example pair and the CIMD URLs on reserved hosts', () => {
  const s = buildStory(DEFAULT_CAST, 'finance');
  assert.deepEqual(s.authModes, ['none', 'static-token', 'user-token', 'oauth', 'token-pass']); assert.ok(s.defects.includes('replay') && s.defects.includes('alg-none'));
  assert.equal(JSON.parse(s.sampleSpec).openapi, '3.0.3'); assert.equal(s.pkce.challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.ok(s.cimdUrls.every((u) => /^https:\/\/[a-z]+\.fabrikam\.example\/client\.json$/.test(u)));
  assert.equal(s.catalogEntries.filter((e) => !e.verified).length, 1);
});
