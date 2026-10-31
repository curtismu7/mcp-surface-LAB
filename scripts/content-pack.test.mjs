import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPack } from './build-content-pack.mjs';
import { validatePack } from './validate-content-pack.mjs';

const root = new URL('..', import.meta.url);
const committed = JSON.parse(fs.readFileSync(new URL('content-pack.json', root), 'utf8'));

test('the pack validates against the schema and its cross-references hold, with catalog D106', () => {
  assert.deepEqual(validatePack(buildPack()), []);
  assert.equal(buildPack().demo.catalog, 'D106');
  assert.equal(buildPack().schema, 'demo-content-pack/1');
});

test('the committed content-pack.json is exactly what the builder makes (no drift)', () => {
  assert.deepEqual(committed, buildPack());
});

test('every scripted scenario has a story and a try-it card', () => {
  const pack = buildPack();
  assert.equal(pack.stories.length, 8);
  for (const s of pack.stories) assert.ok(pack.cards.find((c) => c.story === s.id), s.id);
});

test('a broken pack is caught: unknown term and unknown story', () => {
  const pack = buildPack();
  pack.cards[0].terms = ['nope'];
  pack.cards[1].story = 'ghost';
  const errors = validatePack(pack).join('\n');
  assert.match(errors, /unknown term nope/);
  assert.match(errors, /unknown story ghost/);
});

test('the pack has the four Why it matters entries (challenge, technical, business) marked as Ping claims; names no real company, tenant or documentation URL; holds no credential', () => {
  const pack = buildPack(); const t = JSON.stringify(pack).toLowerCase();
  for (const w of ['united', 'mileageplus', 'datapower', 'optum', 'uhg']) assert.ok(!t.includes(w), w);
  assert.ok(!/https?:\/\/(?!(localhost|example\.invalid))/.test(t), 'only localhost and .invalid links');
  assert.ok(!/\bdoor\b/.test(t), 'say P1 Privilege Agent App, not door');
  for (const id of ['gateway', 'aggregate', 'openapi', 'catalog']) {
    const d = pack.cards.find((c) => c.id === `concept-why-${id}`).description;
    assert.match(d, /Challenge:/); assert.match(d, /Technical:/); assert.match(d, /Business:/); assert.match(d, /Ping claims, unverified on our tenant/);
  }
});

test('every glossary definition says it is UNVERIFIED on our tenant, and the lab-invented and measured parts say so', () => {
  const pack = buildPack();
  for (const g of pack.glossary) assert.match(g.definition, /UNVERIFIED on our tenant/, g.id);
  assert.match(pack.glossary.find((g) => g.id === 'aggregate-cap').definition, /lab-invented/); assert.match(pack.glossary.find((g) => g.id === 'aggregate-cap').definition, /measured AI-DEMO2 note/);
  assert.match(pack.glossary.find((g) => g.id === 'token-pass-through').definition, /lab-invented/); assert.match(pack.glossary.find((g) => g.id === 'cimd').definition, /never fetches/);
  assert.match(pack.glossary.find((g) => g.id === 'mcp-catalog').definition, /roadmap/);
});
