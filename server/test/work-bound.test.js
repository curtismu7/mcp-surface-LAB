// Second-review fixes for the OpenAPI converter: B2 (work per document is bounded, not only the number of nodes) and S4 (nothing is silently cut: a list over its limit
// refuses the WHOLE document). No test here measures elapsed time: the proof is the work counter (units of schema work done) and the answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, expandedNodes, generateTools, parseSpec, validateArgs } from '../src/openapi.js';
import { A, act, codeOf, newEngine, run, withServer, get } from './helpers.js';

const doc = (paths, extra = {}) => JSON.stringify({ openapi: '3.0.3', info: { title: 'T', version: '1' }, paths, ...extra });
const code = (fn) => { try { fn(); return 'passed'; } catch (e) { return e.code || `threw ${e.message}`; } };
const gen = (paths, extra) => generateTools(parseSpec(doc(paths, extra)));
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

// The review's repro: S.required holds 6000 entries, 25 parameter components reference S, 8 paths x 8 methods each reference all 25 at path level (about 37,000 characters).
const REPRO = (entries = 6000) => {
  const parameters = {}; for (let i = 0; i < 25; i++) parameters[`p${i}`] = { name: `q${i}`, in: 'query', schema: { $ref: '#/components/schemas/S' } };
  const refs = Array.from({ length: 25 }, (_, i) => ({ $ref: `#/components/parameters/p${i}` }));
  const paths = {}; for (let k = 0; k < 8; k++) { const it = { parameters: refs }; for (const m of METHODS) it[m] = { operationId: `${m}${k}`, responses: {} }; paths[`/x${k}`] = it; }
  return JSON.stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths, components: { schemas: { S: { type: 'object', required: Array.from({ length: entries }, () => 'a') } }, parameters } });
};

test('B2: the review repro (a 6000-entry required list under 25 x 8 x 8 references) is refused at once, as a whole, before any schema work', async () => {
  const text = REPRO();
  assert.ok(text.length < 40000, `the repro is ${text.length} characters`);
  assert.equal(code(() => parseSpec(text)), 'list_too_long');
  await withServer(async (url) => {
    const before = expandedNodes();
    const r = await act(url, 'oaPreview', { spec: text }, 'b2-a', { mode: 'mock' });
    assert.equal(r.status, 413); assert.equal(r.body.error, 'list_too_long'); assert.match(r.body.detail, /"required" list holds more than 60 entries/);
    assert.equal(expandedNodes(), before, 'no schema was expanded: the work counter did not move');
    for (const op of ['oaDeploy']) { const d = await act(url, op, { actor: A, name: 'repro', spec: text }, 'b2-b'); assert.equal(d.status, 413, op); assert.equal(d.body.error, 'list_too_long'); }
  });
});

test('B2: below the list cap the same layout is bounded by the WORK budget: units of work stop at the total budget, whatever the layout', () => {
  // 50 required entries x 25 parameters = 1,300 units per operation: each operation fits, the sum does not. Without charging list entries the same document
  // costs ~52 units per operation and runs on to the operation limit instead.
  const text = REPRO(50);
  assert.equal(code(() => generateTools(parseSpec(text))), 'schema_too_large');
  assert.ok(expandedNodes() >= LIMITS.expandTotal - 1500 && expandedNodes() <= LIMITS.expandTotal + LIMITS.requiredItems + 80, `units of work: ${expandedNodes()}`);
  // 60 entries x 25 parameters = 1,550 units: the PER-TOOL budget stops the very first operation
  assert.equal(code(() => generateTools(parseSpec(REPRO(60)))), 'schema_too_large');
  assert.ok(expandedNodes() <= LIMITS.expandNodes + LIMITS.requiredItems + 80, `units of work: ${expandedNodes()}`);
  // a document of repeated entries does the detector work once per DISTINCT entry
  const g = gen({ '/a': { post: { operationId: 'a', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { x: { type: 'string' } }, required: Array.from({ length: 60 }, () => 'x') } } } } } } });
  assert.deepEqual(g.tools[0].inputSchema.properties.body.required, ['x']);
});

test('B2: the work counter is deterministic and bounded for the worst layouts a 40,000-character document allows', () => {
  const layouts = {
    enumFarm: doc({ '/a': { get: { operationId: 'a', parameters: Array.from({ length: 25 }, (_, i) => ({ name: `q${i}`, in: 'query', schema: { type: 'string', enum: Array.from({ length: 50 }, (_x, j) => `v${j}`) } })) } } }),
    allOfFarm: doc({ '/a': { post: { operationId: 'a', requestBody: { content: { 'application/json': { schema: { allOf: Array.from({ length: 10 }, (_, i) => ({ type: 'object', properties: { [`p${i}`]: { type: 'string' } } })) } } } } } } }),
    manyParams: doc({ '/a': { parameters: Array.from({ length: 80 }, (_, i) => ({ name: `q${i % 25}`, in: 'query' })), get: { operationId: 'a' }, put: { operationId: 'b' }, post: { operationId: 'c' } } }),
  };
  for (const [k, text] of Object.entries(layouts)) {
    const c = code(() => generateTools(parseSpec(text)));
    assert.ok(c === 'passed' || ['schema_too_large', 'too_many_parameters'].includes(c), `${k}: ${c}`);
    assert.ok(expandedNodes() <= LIMITS.expandTotal + LIMITS.requiredItems + 80, `${k}: units of work ${expandedNodes()}`);
  }
});

test('B2: the health endpoint stays answerable while the repro document is posted (the deterministic bound: no schema work happens)', async () => {
  await withServer(async (url) => {
    const before = expandedNodes();
    const [r, h] = await Promise.all([act(url, 'oaPreview', { spec: REPRO() }, 'b2-health', { mode: 'mock' }), get(url, '/api/health')]);
    assert.equal(h.status, 200); assert.equal((await h.json()).schema, 'demo-health/1');
    assert.equal(r.status, 413);
    assert.equal(expandedNodes(), before);
    const within = await act(url, 'oaPreview', { spec: REPRO(50) }, 'b2-health-2', { mode: 'mock' });
    assert.equal(within.status, 413); assert.equal(within.body.error, 'schema_too_large');
    assert.ok(expandedNodes() <= LIMITS.expandTotal + LIMITS.requiredItems + 80, 'the work the request did is bounded by the budget');
    assert.equal((await get(url, '/api/health')).status, 200);
  });
});

test('B2: the list caps are exact: 60 required entries pass and 61 are refused; 50 enum values pass and 51 are refused; 10 allOf branches pass and 11 are refused; 80 parameters pass and 81 are refused', () => {
  const body = (schema) => ({ '/a': { post: { operationId: 'a', requestBody: { content: { 'application/json': { schema } } } } } });
  const names = (n) => Array.from({ length: n }, (_, i) => `f${i}`);
  assert.equal(code(() => parseSpec(doc(body({ type: 'object', properties: Object.fromEntries(names(60).map((k) => [k, { type: 'string' }])), required: names(60) })))), 'passed');
  assert.equal(code(() => parseSpec(doc(body({ type: 'object', required: names(61) })))), 'list_too_long');
  assert.equal(code(() => parseSpec(doc(body({ type: 'string', enum: names(50) })))), 'passed');
  assert.equal(code(() => parseSpec(doc(body({ type: 'string', enum: names(51) })))), 'list_too_long');
  assert.equal(code(() => parseSpec(doc(body({ allOf: names(10).map((k) => ({ type: 'object', properties: { [k]: { type: 'string' } } })) })))), 'passed');
  assert.equal(code(() => parseSpec(doc(body({ allOf: names(11).map((k) => ({ type: 'object', properties: { [k]: { type: 'string' } } })) })))), 'list_too_long');
  const params = (n) => ({ '/a': { get: { operationId: 'a', parameters: Array.from({ length: n }, () => ({ name: 'dup', in: 'query' })) } } });
  assert.equal(code(() => parseSpec(doc(params(80)))), 'passed');
  assert.equal(code(() => parseSpec(doc(params(81)))), 'list_too_long');
  // the cap applies wherever the list sits, also under a $ref'd component and next to a property that is itself NAMED like a keyword
  assert.equal(code(() => parseSpec(doc({}, { components: { schemas: { S: { required: names(61) } } } }))), 'list_too_long');
  assert.equal(code(() => parseSpec(doc(body({ type: 'object', properties: { required: { type: 'string' }, enum: { type: 'string' }, allOf: { type: 'string' } } })))), 'passed', 'a property named required/enum/allOf is not a list');
});

// ---- S4: no silent slicing -----------------------------------------------------------------------------------------------------------------------
test('S4: an enum of 51 values is refused whole; an enum of 50 keeps all 50, and the last one is accepted when a tool is called with it', () => {
  const enumPath = (n) => ({ '/a': { get: { operationId: 'a', parameters: [{ name: 'k', in: 'query', schema: { type: 'string', enum: Array.from({ length: n }, (_, i) => `v${i}`) } }] } } });
  assert.equal(code(() => gen(enumPath(60))), 'list_too_long', 'the review repro: 60 values became 50');
  assert.equal(code(() => gen(enumPath(51))), 'list_too_long');
  const g = gen(enumPath(50));
  assert.equal(g.tools[0].inputSchema.properties.k.enum.length, 50);
  assert.equal(validateArgs(g.tools[0].inputSchema, { k: 'v49' }), null, 'the 50th value is allowed');
  assert.equal(validateArgs(g.tools[0].inputSchema, { k: 'v50' }), 'is not one of the allowed values');
});

test('S4: allOf with 11 or 12 branches is refused whole, and with 10 every branch contributes its properties', () => {
  const branches = (n) => Array.from({ length: n }, (_, i) => ({ type: 'object', properties: { [`p${i}`]: { type: 'string' } } }));
  const doc2 = (n) => ({ '/a': { post: { operationId: 'a', requestBody: { content: { 'application/json': { schema: { allOf: branches(n) } } } } } } });
  assert.equal(code(() => gen(doc2(12))), 'list_too_long'); assert.equal(code(() => gen(doc2(11))), 'list_too_long');
  assert.deepEqual(Object.keys(gen(doc2(10)).tools[0].inputSchema.properties.body.properties).sort(), Array.from({ length: 10 }, (_, i) => `p${i}`).sort());
});

test('S4: 80 duplicate parameters followed by 10 unique ones are refused whole instead of ignoring the unique ones; 80 in all is accepted', () => {
  const dup = { name: 'dup', in: 'query' };
  const list = (dups, uniques) => [...Array.from({ length: dups }, () => dup), ...Array.from({ length: uniques }, (_, i) => ({ name: `u${i}`, in: 'query' }))];
  assert.equal(code(() => gen({ '/a': { get: { operationId: 'a', parameters: list(80, 10) } } })), 'list_too_long');
  const g = gen({ '/a': { get: { operationId: 'a', parameters: list(70, 10) } } });
  assert.deepEqual(Object.keys(g.tools[0].inputSchema.properties).sort(), ['dup', ...Array.from({ length: 10 }, (_, i) => `u${i}`)].sort(), 'every unique parameter is read');
  assert.equal(code(() => gen({ '/a': { get: { operationId: 'a', parameters: list(0, 80) } } })), 'too_many_parameters', '80 listed is accepted by the list cap and then judged by the 25-parameter cap');
  // path-level and operation-level lists are each capped
  assert.equal(code(() => gen({ '/a': { parameters: list(81, 0), get: { operationId: 'a' } } })), 'list_too_long');
});

test('S4: 11 security schemes are refused whole; with 10, all 10 are listed, the header scheme in the 10th place included', () => {
  const schemes = (n, lastHeader) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, i === n - 1 && lastHeader ? { type: 'apiKey', in: 'header', name: 'X-Late-Key' } : { type: 'http', scheme: 'basic' }]));
  const base = { '/a': { get: { operationId: 'a' } } };
  assert.equal(code(() => gen(base, { components: { securitySchemes: schemes(11, true) } })), 'too_many_security_schemes');
  const g = gen(base, { components: { securitySchemes: schemes(10, true) } });
  assert.equal(g.auth.length, 10);
  assert.equal(g.auth.at(-1).header, 'X-Late-Key', 'the header scheme in the 10th place is not lost');
  const e = newEngine();
  assert.equal(codeOf(run(e, 'oaDeploy', { actor: A, name: 'late', spec: doc(base, { components: { securitySchemes: schemes(11, true) } }) })), 'too_many_security_schemes');
});

test('S4: parameters the gateway does not expose and warnings beyond the 40 shown are COUNTED in a last line, never dropped silently', () => {
  const paths = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`/p${i}`, { get: { operationId: `op${i}`, parameters: [{ name: 'X-Request-Id', in: 'header' }] } }]));
  const g = gen(paths);
  assert.equal(g.notExposed.length, 40);
  assert.ok(g.warnings.includes('5 more parameters the gateway does not expose are not listed'), JSON.stringify(g.warnings));
  const warn = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`/w${i}/{id}`, { get: { operationId: `w${i}` } }])); // a placeholder with no path parameter warns
  const w = gen(warn);
  assert.equal(w.warnings.length, 40); assert.equal(w.warnings.at(-1), '6 more warnings are not listed');
  assert.equal(gen({ '/a': { get: { operationId: 'a' } } }).warnings.length, 0);
});

test('B2: the work counter is exact: a parameter list entry, a node, an enum value, an allOf branch and a required entry are one unit each', () => {
  const units = (paths, extra) => { generateTools(parseSpec(doc(paths, extra))); return expandedNodes(); };
  const q = (schema) => ({ '/a': { get: { operationId: 'a', parameters: [{ name: 'k', in: 'query', schema }] } } });
  assert.equal(units(q({ type: 'string' })), 1 + 1, 'one list entry + one schema node');
  assert.equal(units(q({ type: 'string', enum: ['a', 'b', 'c'] })), 1 + 1 + 3, 'plus three enum values');
  assert.equal(units(q({ allOf: [{ type: 'string' }, { type: 'string' }] })), 1 + 1 + 2 + 2, 'plus two branches (counted once as a list, once as the nodes they are)');
  assert.equal(units(q({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'a', 'b'] })), 1 + 1 + 1 + 3, 'one list entry, a node, a property, three required entries (duplicates are paid for, judged once)');
  assert.equal(units({ '/a': { parameters: [{ name: 'p', in: 'query' }], get: { operationId: 'a', parameters: [{ name: 'k', in: 'query' }] }, put: { operationId: 'b' } } }), (2 + 2) + (1 + 1), 'get: two list entries and two parameter nodes; put: one entry (the path-level one) and one node');
});

test('B2: enum entries are paid for: 15 parameters of 2 properties with a 50-value enum each exceed the per-tool budget although they are few nodes and few characters', () => {
  const nums = Array.from({ length: 50 }, (_, i) => i);
  const schemas = { O: { type: 'object', properties: { a: { type: 'integer', enum: nums }, b: { type: 'integer', enum: nums } } } };
  const params = (n) => Array.from({ length: n }, (_, i) => ({ name: `k${String.fromCharCode(97 + i)}`, in: 'query', schema: { $ref: '#/components/schemas/O' } }));
  const d = (n) => doc({ '/a': { get: { operationId: 'a', parameters: params(n) } } }, { components: { schemas } });
  assert.equal(code(() => generateTools(parseSpec(d(14)))), 'passed'); // 14 x (1 + 1 + 2 x 51) = 1456 units
  assert.equal(code(() => generateTools(parseSpec(d(15)))), 'schema_too_large'); // 15 x 104 = 1560
});
