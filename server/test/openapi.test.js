// OpenAPI to MCP: the parser under hard limits, hostile documents, the generated tools, the mock backend, deploy and redeploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, callBackend, diffTools, generateTools, parseSpec, validateArgs } from '../src/openapi.js';
import { sampleSpec } from '../src/world.js';
import { A, A1, APP, C, U, callTool, codeOf, listNames, mcp, newEngine, ok, run } from './helpers.js';

const doc = (paths, extra = {}) => JSON.stringify({ openapi: '3.0.3', info: { title: 'T', version: '1' }, paths, ...extra });
const gen = (paths, extra) => generateTools(parseSpec(doc(paths, extra)));
const code = (fn) => { try { fn(); return 'passed'; } catch (e) { return e.code || `threw ${e.message}`; } };
const sample = JSON.stringify(sampleSpec(C));

test('the sample specification: every operation is a tool with a per-operation schema from the spec', () => {
  const g = generateTools(parseSpec(sample));
  assert.deepEqual(g.tools.map((t) => t.name), ['listItems', 'createItem', 'getItem', 'delete_items_by_id']);
  const list = g.tools[0].inputSchema; assert.deepEqual(list.properties.limit, { type: 'integer', minimum: 1, maximum: 50, description: 'page size' }); assert.deepEqual(list.required, []);
  const get = g.tools[2]; assert.deepEqual(get.inputSchema.required, ['id']); assert.equal(get.inputSchema.properties.id.description, 'item id'); assert.equal(get.description, 'Get one item');
  const create = g.tools[1].inputSchema; assert.deepEqual(create.required, ['body']); assert.deepEqual(create.properties.body.required, ['name']); assert.equal(create.properties.body.properties.qty.type, 'integer');
  assert.equal(g.tools[3].nameRule, 'fallback'); assert.equal(g.tools[0].nameRule, 'operationId');
  assert.deepEqual(g.tools.map((t) => t.readOnly), [true, false, true, false]);
  assert.equal(g.api.title, `${C.castApi} API`);
});

test('the naming rule: operationId, else method_path (a {param} becomes by_param); an unusable id falls back; a clash gets _2, _3', () => {
  const g = gen({ '/a/{id}/b': { get: {}, post: { operationId: 'dup' }, put: { operationId: 'dup' }, patch: { operationId: 'dup' } }, '/c': { get: { operationId: 'has space!' }, delete: { operationId: '9lives' }, head: { operationId: '__proto__' } } });
  assert.deepEqual(g.tools.map((t) => t.name), ['get_a_by_id_b', 'dup', 'dup_2', 'dup_3', 'has_space_', 'op_9lives', 'op___proto__']);
  assert.deepEqual(g.tools.map((t) => t.nameRule), ['fallback', 'operationId', 'operationId+suffix', 'operationId+suffix', 'operationId', 'operationId', 'operationId']);
  assert.ok(g.tools.every((t) => /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(t.name)));
  assert.equal(new Set(g.tools.map((t) => t.name)).size, g.tools.length);
  // a credential-shaped operationId never becomes a tool name
  const secret = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
  assert.equal(gen({ '/x': { get: { operationId: secret } } }).tools[0].name, 'get_x');
});

test('descriptions and names from the spec are cleaned: control characters, long text and credential-shaped text never reach a tool', () => {
  const secret = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
  const g = gen({ '/x': { get: { summary: `see ${secret} please`, description: 'x'.repeat(2000) } } });
  assert.ok(!JSON.stringify(g).includes(secret)); assert.ok(g.tools[0].description.length <= 500);
  assert.match(g.tools[0].description, /\[masked:/);
});

test('header and cookie parameters are not tool arguments (headers are injected, session state is the agent\'s); a clash between locations is renamed', () => {
  const g = gen({ '/x/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true }, { name: 'id', in: 'query' }, { name: 'X-Trace', in: 'header' }, { name: 'sid', in: 'cookie' }, { name: 'body', in: 'query' }] } } });
  const props = Object.keys(g.tools[0].inputSchema.properties);
  assert.deepEqual(props.sort(), ['id', 'query_body', 'query_id'].sort());
  assert.deepEqual(g.notExposed.map((x) => x.in).sort(), ['cookie', 'header']);
});

test('authentication is header-based only: a header apiKey or an HTTP scheme is injected, everything else is the agent\'s job', () => {
  const g = gen({ '/x': { get: {} } }, { components: { securitySchemes: { k: { type: 'apiKey', in: 'header', name: 'X-Api-Key' }, b: { type: 'http', scheme: 'bearer' }, q: { type: 'apiKey', in: 'query', name: 'k' }, c: { type: 'apiKey', in: 'cookie', name: 'c' }, o: { type: 'oauth2', flows: {} }, i: { type: 'openIdConnect' }, bad: { type: 'apiKey', in: 'header', name: 'bad header\nname' } } } });
  const by = Object.fromEntries(g.auth.map((a) => [a.scheme, a]));
  assert.deepEqual([by.k.handled, by.k.header], ['header', 'X-Api-Key']); assert.deepEqual([by.b.handled, by.b.header], ['header', 'Authorization']);
  for (const k of ['q', 'c', 'o', 'i', 'bad']) assert.equal(by[k].handled, 'agent', k);
  assert.match(by.o.why, /agent's responsibility/);
});

test('local $ref only: remote, file, relative and non-string references are refused; unresolvable and cyclic ones are handled', () => {
  const withRef = (ref) => doc({ '/a': { get: { operationId: 'a', responses: { 200: { $ref: ref } } } } });
  for (const ref of ['https://spec.example/o.json#/x', 'http://x.example/y', 'file:///etc/passwd', './other.json#/x', 'other.json', '//x.example/y', '#', 'data:application/json,{}', 5, null, ['#/a'], {}]) assert.equal(code(() => parseSpec(withRef(ref))), 'external_ref_refused', String(JSON.stringify(ref)));
  assert.equal(code(() => generateTools(parseSpec(doc({ '/a': { get: { operationId: 'a', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Nope' } } } } } } })))), 'ref_not_found');
  // a self-referencing schema does not loop and does not overflow
  const tree = JSON.stringify({ openapi: '3.0.3', info: {}, paths: { '/t': { post: { operationId: 't', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } }, components: { schemas: { Node: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/components/schemas/Node' } }, a: { $ref: '#/components/schemas/Other' } } }, Other: { $ref: '#/components/schemas/Node' } } } });
  const t = generateTools(parseSpec(tree)).tools[0].inputSchema;
  assert.match(JSON.stringify(t), /recursive reference, not expanded/);
  // a pointer into the prototype chain does not resolve
  assert.equal(code(() => generateTools(parseSpec(doc({ '/a': { get: { operationId: 'a', requestBody: { content: { 'application/json': { schema: { $ref: '#/__proto__/x' } } } } } } })))), 'forbidden_key' === 'x' ? '' : 'ref_not_found');
  assert.equal(code(() => generateTools(parseSpec(doc({ '/a': { get: { operationId: 'a', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/constructor' } } } } } } })))), 'ref_not_found');
});

test('hostile documents: __proto__ keys are refused, constructor/prototype/toString names are harmless and never pollute anything', () => {
  assert.equal(code(() => parseSpec('{"openapi":"3.0.0","info":{},"paths":{"/a":{"get":{"operationId":"a"}}},"__proto__":{"polluted":1}}')), 'forbidden_key');
  assert.equal(code(() => parseSpec('{"openapi":"3.0.0","info":{},"paths":{"/a":{"get":{"operationId":"a","x":{"__proto__":{"polluted":1}}}}}}')), 'forbidden_key');
  const g = gen({ '/constructor': { get: { operationId: 'constructor', parameters: [{ name: 'constructor', in: 'query' }, { name: 'toString', in: 'query' }, { name: 'hasOwnProperty', in: 'query' }, { name: 'prototype', in: 'query' }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { constructor: { type: 'string' }, valueOf: { type: 'number' } } } } } } } }, '/toString': { get: {} } });
  assert.equal(g.tools[0].name, 'constructor');
  assert.deepEqual(Object.keys(g.tools[0].inputSchema.properties).sort(), ['body', 'constructor', 'hasOwnProperty', 'prototype', 'toString']);
  assert.equal({}.polluted, undefined); assert.equal(Object.prototype.polluted, undefined);
  assert.equal(JSON.parse(JSON.stringify(g.tools[0].inputSchema)).properties.body.properties.constructor.type, 'string');
  // validation with such names does not trip over the prototype
  assert.equal(validateArgs(g.tools[0].inputSchema, { constructor: 'x', toString: 'y' }), null);
  assert.equal(validateArgs(g.tools[0].inputSchema, { nope: 1 }), 'has a field the schema does not define');
  assert.equal({}.constructor, Object);
});

test('bounds: size, depth, node count, paths, operations and parameters each refuse the WHOLE document (nothing is dropped)', () => {
  assert.equal(code(() => parseSpec('x'.repeat(LIMITS.chars + 1))), 'spec_too_large');
  assert.equal(code(() => parseSpec(`{"openapi":"3.0.0","info":${'['.repeat(LIMITS.depth + 5)}${']'.repeat(LIMITS.depth + 5)},"paths":{}}`)), 'spec_too_deep');
  assert.equal(code(() => parseSpec(`{"openapi":"3.0.0","a":${'['.repeat(30000)}`)), 'spec_too_deep', 'a nesting bomb is stopped before JSON.parse');
  assert.equal(code(() => parseSpec(`{"openapi":"3.0.0","info":{},"paths":{},"x":[${Array.from({ length: LIMITS.nodes + 5 }, () => '{}').join(',')}]}`)), 'spec_too_large');
  const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`/p${i}`, { get: { operationId: `op${i}` } }]));
  assert.equal(gen(many(LIMITS.operations)).tools.length, LIMITS.operations);
  assert.equal(code(() => gen(many(LIMITS.operations + 1))), 'too_many_operations');
  assert.equal(code(() => gen(Object.fromEntries(Array.from({ length: LIMITS.paths + 1 }, (_, i) => [`/p${i}`, {}])))), 'too_many_paths');
  assert.equal(code(() => gen({ '/x': { get: { parameters: Array.from({ length: LIMITS.params + 1 }, (_, i) => ({ name: `p${i}`, in: 'query' })) } } })), 'too_many_parameters');
  assert.equal(code(() => gen({ '/x': { get: { parameters: [{ name: 'p', in: 'query', schema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`k${i}`, {}])) } }] } } })), 'spec_too_large');
  assert.equal(code(() => gen({ '/x': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, { type: 'string', description: 'lorem ipsum dolor '.repeat(11).slice(0, 199) }])) } } } } } } })), 'schema_too_large');
});

test('JSON only, 3.x only, an object only: YAML, swagger 2, an array and garbage are refused', () => {
  for (const [txt, c] of [['openapi: 3.0.0\ninfo:\n  title: x', 'not_json'], ['<xml/>', 'not_json'], ['', 'not_json'], ['[]', 'not_json'], ['{"swagger":"2.0"}', 'unsupported_version'], ['{"openapi":"4.0.0"}', 'unsupported_version'], ['{"openapi":3}', 'unsupported_version'], ['{"openapi":"3.0.0"', 'not_json'], ['{"openapi":"3.0.0","info":{},"paths":{}}', 'passed']]) assert.equal(code(() => { const s = parseSpec(txt); if (!Object.keys(s.paths).length) generateTools(s); }), c === 'passed' ? 'no_operations' : c, txt.slice(0, 20));
  assert.equal(code(() => parseSpec(undefined)), 'spec_missing'); assert.equal(code(() => parseSpec(5)), 'spec_missing'); assert.equal(code(() => parseSpec({})), 'spec_missing');
});

test('request bodies: JSON bodies become a body argument; other content types are noted, not guessed', () => {
  const g = gen({ '/u': { post: { operationId: 'up', requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object' } } } } } } });
  assert.deepEqual(Object.keys(g.tools[0].inputSchema.properties), []); assert.match(g.warnings[0], /not JSON/);
  const h = gen({ '/u': { post: { operationId: 'up', requestBody: { content: { 'application/vnd.api+json': { schema: { type: 'object' } } } } } } });
  assert.deepEqual(Object.keys(h.tools[0].inputSchema.properties), ['body']);
});

test('argument validation: required, types, enum, bounds, nested objects and arrays; patterns from the spec are never compiled', () => {
  const s = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string', minLength: 2, maxLength: 4 }, n: { type: 'integer', minimum: 1, maximum: 3 }, e: { enum: ['x', 'y'] }, arr: { type: 'array', items: { type: 'number' } }, o: { type: 'object', required: ['k'], properties: { k: { type: 'boolean' } } } } };
  assert.equal(validateArgs(s, { a: 'ab' }), null);
  for (const bad of [{}, { a: 1 }, { a: 'a' }, { a: 'abcde' }, { a: 'ab', n: 0 }, { a: 'ab', n: 4 }, { a: 'ab', n: 1.5 }, { a: 'ab', e: 'z' }, { a: 'ab', arr: ['x'] }, { a: 'ab', arr: 'x' }, { a: 'ab', o: {} }, { a: 'ab', o: { k: 'yes' } }, { a: 'ab', z: 1 }, 'x', null, []]) assert.notEqual(validateArgs(s, bad), null, JSON.stringify(bad));
  assert.equal(validateArgs({ type: 'string', pattern: '(a+)+$' }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'), null, 'a hostile pattern is ignored, never run');
  let deep = {}; const root = { type: 'object', properties: { d: deep } }; for (let i = 0; i < 30; i++) { deep.type = 'object'; deep.properties = { d: {} }; deep = deep.properties.d; }
  assert.equal(typeof validateArgs(root, JSON.parse('{"d":'.repeat(30) + '{}' + '}'.repeat(30))), 'string', 'nesting is bounded');
});

test('the mock REST backend: routes, path parameters percent-encoded (an id cannot add a path segment), headers named, no echo of values', () => {
  const g = generateTools(parseSpec(sample)); const by = Object.fromEntries(g.tools.map((t) => [t.name, t]));
  const hdr = [{ name: 'X-Api-Key' }];
  assert.equal(callBackend(by.listItems, { limit: 2 }, { headers: hdr, requiresAuth: true }).body.items.length, 2);
  assert.equal(callBackend(by.getItem, { id: 'i-2' }, { headers: hdr, requiresAuth: true }).body.name, 'Beta');
  const miss = callBackend(by.getItem, { id: '../../etc/passwd' }, { headers: hdr, requiresAuth: true });
  assert.equal(miss.status, 404); assert.equal(miss.request.path, '/items/{id}', 'only the template is shown'); assert.ok(!JSON.stringify(miss).includes('passwd') && !JSON.stringify(miss).includes('%2F'));
  assert.equal(callBackend(by.getItem, { id: 'i-1' }, { headers: [], requiresAuth: true }).status, 401, 'the backend wants a header and the gateway injected none');
  assert.equal(callBackend(by.createItem, { body: { name: 'z' } }, { headers: hdr, requiresAuth: true }).status, 201);
  assert.equal(callBackend(by.delete_items_by_id, { id: 'i-9' }, { headers: hdr, requiresAuth: true }).status, 404);
  assert.deepEqual(callBackend(by.getItem, { id: 'i-1' }, { headers: hdr, requiresAuth: true }).request.headerNames, ['X-Api-Key']);
  const generic = generateTools(parseSpec(doc({ '/other': { get: { operationId: 'o' } } }))).tools[0];
  assert.equal(callBackend(generic, {}, { headers: [], requiresAuth: false }).body.mock, true, 'an unknown route gets the generic mock answer');
});

test('preview is pure; deploy registers an ordinary application; staff get the read-only default; redeploy follows the spec', () => {
  const e = newEngine(); const before = JSON.stringify(e.snapshot());
  const p = ok(run(e, 'oaPreview', { spec: sample })); assert.equal(p.tools.length, 4); assert.equal(JSON.stringify(e.snapshot()), before, 'preview changed nothing');
  const d = ok(run(e, 'oaDeploy', { actor: A, name: 'invoices', spec: sample }));
  assert.equal(d.appId, 'invoices');
  assert.deepEqual(listNames(e, U, APP('invoices')), ['listItems', 'getItem'], 'the lab default grant: read-only operations for staff');
  assert.equal(codeOf(callTool(e, U, APP('invoices'), 'createItem', { body: { name: 'z' } })), 'access_denied');
  const got = ok(callTool(e, U, APP('invoices'), 'getItem', { id: 'i-2' }));
  assert.match(got.rpc.result.content[0].text, /"status":200/); assert.match(got.rpc.result.content[0].text, /Beta/);
  assert.deepEqual(got.operator.credential.headers.map((h) => h.name), ['X-Api-Key'], 'the header the spec names is injected by the gateway');
  assert.equal(got.operator.credential.headers[0].credential.kind, 'mock');
  assert.ok(!JSON.stringify(got.rpc).includes('X-Api-Key') && !JSON.stringify(got.rpc).includes('MOCK'), 'the agent never sees the credential');
  // administrators call the mutating operation; inheriting credential injection means a mode change changes what the backend gets
  assert.equal(codeOf(callTool(e, A, APP('invoices'), 'createItem', { body: { name: 'z' } })), 'ok');
  ok(run(e, 'setAuth', { actor: A, appId: 'invoices', authMode: 'none' }));
  assert.match(callTool(e, U, APP('invoices'), 'getItem', { id: 'i-2' }).result.rpc.result.content[0].text, /"status":401/, 'no credential injected: the backend refuses');
  // redeploy with an operation removed
  const s2 = sampleSpec(C); delete s2.paths['/items/{id}'].delete; s2.paths['/items'].get.operationId = 'renamed';
  const r = ok(run(e, 'oaRedeploy', { actor: A, id: 'oa-1', spec: JSON.stringify(s2) }));
  assert.deepEqual(r.diff, { added: ['renamed'], removed: ['listItems', 'delete_items_by_id'], changed: [] });
  assert.equal(codeOf(callTool(e, A, APP('invoices'), 'delete_items_by_id', { id: 'i-1' })), 'access_denied', 'a removed operation is gone for everyone');
  assert.ok(!listNames(e, U, APP('invoices')).includes('listItems'));
  assert.ok(!listNames(e, U, APP('invoices')).includes('renamed'), 'an added operation arrives with no grant');
  assert.equal(e.snapshot().openapi.servers[0].generation, 2);
  // the removed operation also left the staff grant
  assert.ok(!JSON.stringify(e.apps.invoices.policy).includes('listItems'));
});

test('deploy validation: administrators only, a free name, caps, a bad specification changes nothing', () => {
  const e = newEngine();
  assert.equal(codeOf(run(e, 'oaDeploy', { actor: U, name: 'x', spec: sample })), 'admin_only');
  assert.equal(codeOf(run(e, 'oaDeploy', { actor: A, name: A1, spec: sample })), 'name_taken');
  assert.equal(codeOf(run(e, 'oaDeploy', { actor: A, name: 'Bad Name', spec: sample })), 'bad_name');
  assert.equal(codeOf(run(e, 'oaDeploy', { actor: A, name: 'x', spec: '{"openapi":"3.0.0","info":{},"paths":{"/a":{"get":{"$ref":"http://x.example/y"}}}}' })), 'external_ref_refused');
  assert.equal(Object.keys(e.apps).length, 5, 'a refused spec created nothing');
  for (let i = 0; i < 5; i++) ok(run(e, 'oaDeploy', { actor: A, name: `s${i}`, spec: sample }));
  assert.equal(codeOf(run(e, 'oaDeploy', { actor: A, name: 'more', spec: sample })), 'too_many_servers');
  assert.equal(codeOf(run(e, 'oaRedeploy', { actor: A, id: 'nope', spec: sample })), 'unknown_server');
  assert.equal(codeOf(run(e, 'oaRedeploy', { actor: A, id: '__proto__', spec: sample })), 'unknown_server');
});

test('diffTools reports added, removed and changed', () => {
  const a = [{ name: 'x', inputSchema: { a: 1 } }, { name: 'y', inputSchema: {} }]; const b = [{ name: 'x', inputSchema: { a: 2 } }, { name: 'z', inputSchema: {} }];
  assert.deepEqual(diffTools(a, b), { added: ['z'], removed: ['y'], changed: ['x'] });
});

test('a call to a generated tool through an aggregate works and is namespaced too', () => {
  const e = newEngine();
  ok(run(e, 'oaDeploy', { actor: A, name: 'invoices', spec: sample }));
  ok(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: 'invoices' }));
  ok(run(e, 'aggSetPolicy', { actor: A, aggregateId: 'all-in-one', grants: [{ group: 'staff', tools: ['invoices__getItem', `${A1}__search`] }, { group: 'admins', tools: ['*'] }] }));
  assert.ok(listNames(e, U, { kind: 'aggregate', id: 'all-in-one' }).includes('invoices__getItem'));
  assert.equal(codeOf(mcp(e, U, { kind: 'aggregate', id: 'all-in-one' }, 'tools/call', { name: 'invoices__getItem', arguments: { id: 'i-1' } })), 'ok');
});
