import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CAST, VERTICALS, fill, fillDeep, loadCast, unfilled, verticalFrom } from '../src/cast.js';
import { rawStory } from '../src/story.js';
import { rawDiagram, DIAGRAM_NAMES } from '../src/diagramData.js';
import { scanHosts } from '../src/safety.js';
import { roster, seedApps, seedAggregate, AGENTS } from '../src/world.js';

test('there are three vertical packs, and every pack defines every token of every story text and diagram (a test fails on an undefined token)', () => {
  assert.deepEqual(Object.keys(VERTICALS), ['finance', 'health', 'retail']);
  const text = JSON.stringify([rawStory(), DIAGRAM_NAMES.map((n) => rawDiagram(n))]);
  assert.ok(/\{\{cast/.test(text), 'the data uses cast tokens');
  for (const [v, cast] of Object.entries(VERTICALS)) assert.deepEqual(unfilled(text, cast), [], v);
  const keys = Object.keys(DEFAULT_CAST).sort();
  for (const [v, cast] of Object.entries(VERTICALS)) assert.deepEqual(Object.keys(cast).sort(), keys, `${v} has the same tokens as the default pack`);
});

test('an undefined token is reported and left visible, never replaced with something', () => {
  assert.deepEqual(unfilled('hello {{castBrand}} {{nope}} {{__proto__}} {{constructor}}', DEFAULT_CAST), ['nope', '__proto__', 'constructor']);
  assert.equal(fill('{{nope}} {{constructor}}', DEFAULT_CAST), '{{nope}} {{constructor}}');
  assert.equal(fill('{{castBrand}}', DEFAULT_CAST), 'Fabrikam Bank');
});

test('fillDeep fills nested text and survives a deep structure', () => {
  assert.deepEqual(fillDeep({ a: ['{{castHost}}', { b: '{{castBrand}}' }], n: 3 }, DEFAULT_CAST), { a: ['fabrikam', { b: 'Fabrikam Bank' }], n: 3 });
  let deep = { v: '{{castBrand}}' }; for (let i = 0; i < 50000; i++) deep = { d: deep };
  assert.doesNotThrow(() => fillDeep(deep, DEFAULT_CAST));
});

test('the seeded world: unique people and applications in every pack, every member of the aggregate named from the cast, three agents owned by real users', () => {
  for (const [v, cast] of Object.entries(VERTICALS)) {
    const people = roster(cast).map((p) => p.id); assert.equal(new Set(people).size, people.length, `${v}: unique people`);
    const apps = seedApps(cast).map((a) => a.id); assert.equal(new Set(apps).size, apps.length, `${v}: unique applications`);
    assert.ok(apps.every((a) => /^[a-z][a-z0-9-]{0,31}$/.test(a)), `${v}: application names are valid aliases`);
    const members = seedAggregate(cast).members.map((m) => m.appRef.RefID);
    assert.deepEqual(members, [...apps, cast.castMissing], `${v}: the aggregate fronts every application plus one dangling reference`);
    assert.ok(!apps.includes(cast.castMissing));
    for (const a of AGENTS(cast)) assert.ok(people.includes(a.owner), `${v}: ${a.id}`);
  }
});

test('the packs are synthetic: only .example hosts, no email, no real company', () => {
  const t = JSON.stringify(VERTICALS);
  assert.deepEqual(scanHosts(t), []);
  assert.ok(!/@|https?:/.test(t));
});

test('verticalFrom only accepts a known pack, including against object-key tricks', () => {
  assert.equal(verticalFrom('health'), 'health');
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', undefined, null, 5, ['health'], {}, '']) assert.equal(verticalFrom(bad), 'finance');
});

test('customer.config.json: brand, host and the first user only; bad values are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msf-cast-')); const f = path.join(dir, 'customer.config.json');
  const w = (cast) => fs.writeFileSync(f, JSON.stringify({ cast, token: 'x' }));
  try {
    w({ brand: 'Acme Corp', host: 'acme', user: 'sam.lee' });
    const c = loadCast(f, 'health');
    assert.deepEqual([c.castBrand, c.castHost, c.castUser], ['Acme Corp', 'acme', 'sam.lee']);
    assert.equal(c.castAdmin, VERTICALS.health.castAdmin, 'everything else is the pack\'s');
    w({ brand: 'x@y.com', host: 'a.b', user: 'Bad Name!' }); assert.deepEqual([loadCast(f).castBrand, loadCast(f).castHost, loadCast(f).castUser], [DEFAULT_CAST.castBrand, DEFAULT_CAST.castHost, DEFAULT_CAST.castUser]);
    w({ brand: 'https://evil.invalid', user: DEFAULT_CAST.castAdmin }); assert.equal(loadCast(f).castUser, DEFAULT_CAST.castUser, 'cannot collide with another person');
    w({ brand: 'Acme‮evil' }); assert.ok(!/‮/.test(loadCast(f).castBrand));
    fs.writeFileSync(f, 'not json'); assert.equal(loadCast(f).castBrand, DEFAULT_CAST.castBrand);
    assert.equal(loadCast('/nonexistent').castBrand, DEFAULT_CAST.castBrand);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
