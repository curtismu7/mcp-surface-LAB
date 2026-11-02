// OpenAPI to MCP, for real and local. Parses a user-pasted OpenAPI 3.x JSON document under hard limits, turns every operation into an MCP tool with a
// per-operation input schema (parameters, types, descriptions from the spec), and runs tool calls against an in-process MOCK REST backend. No network,
// no eval, no remote or file $ref (refused), no YAML (refused), no regular expression taken from the spec, no key that could reach Object.prototype.
// The tool NAMING rule (operationId, a documented fallback, a suffix on collision) is the lab's own: the deck does not state one.
import { refuse } from './errors.js';
import { cleanFree } from './credentials.js';
import { credentialShaped, isObj } from './util.js';
import { isCredentialId } from './mask.js';
import { MOCK_BACKEND_ITEMS } from './world.js';

export const LIMITS = { expandNodes: 1500, expandTotal: 20000, chars: 40000, depth: 40, nodes: 20000, paths: 100, operations: 60, params: 25, refDepth: 12, schemaChars: 8000, argsChars: 8000, enumItems: 50, requiredItems: 60, allOfBranches: 10, paramEntries: 80, securitySchemes: 10 };
// The longest list the lab reads under each of these keys, wherever it sits in the document. A longer one refuses the WHOLE specification, before any work is done
// on it (nothing is cut, nothing is skipped): the work per schema node is bounded by these, not only the number of nodes.
const LIST_CAPS = { required: LIMITS.requiredItems, enum: LIMITS.enumItems, allOf: LIMITS.allOfBranches, parameters: LIMITS.paramEntries };
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;

// The deepest nesting of [] and {} outside strings, found without recursion, so JSON.parse is never handed a bomb.
function nestingDepth(text) {
  let d = 0; let max = 0; let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') { d++; if (d > max) max = d; if (max > LIMITS.depth) return max; } else if (c === '}' || c === ']') d--;
  }
  return max;
}

export function parseSpec(text) {
  if (typeof text !== 'string') throw refuse('spec_missing', 'a specification is required');
  if (text.length > LIMITS.chars) throw refuse('spec_too_large', `the specification is over ${LIMITS.chars} characters`, 413);
  const t = text.trim();
  if (!t.startsWith('{')) throw refuse('not_json', 'JSON only: the lab does not parse YAML or anything else');
  if (nestingDepth(t) > LIMITS.depth) throw refuse('spec_too_deep', `the specification nests deeper than ${LIMITS.depth} levels`);
  let spec; try { spec = JSON.parse(t); } catch { throw refuse('not_json', 'the specification is not valid JSON'); }
  if (!isObj(spec)) throw refuse('not_json', 'the specification must be a JSON object');
  if (typeof spec.openapi !== 'string' || !/^3\.[01]\.\d{1,3}$/.test(spec.openapi)) throw refuse('unsupported_version', 'only OpenAPI 3.0.x and 3.1.x documents are accepted');
  // One iterative pass over every node: count them, refuse a forbidden key, and refuse every $ref that is not a local "#/" pointer.
  let nodes = 0; const work = [spec];
  while (work.length) {
    const n = work.pop();
    if (++nodes > LIMITS.nodes) throw refuse('spec_too_large', `the specification has more than ${LIMITS.nodes} nodes`, 413);
    if (Array.isArray(n)) { for (const x of n) if (x !== null && typeof x === 'object') work.push(x); continue; }
    for (const k of Object.keys(n)) {
      if (k === '__proto__') throw refuse('forbidden_key', 'the specification contains a key the lab refuses');
      const v = n[k];
      if (Array.isArray(v) && Object.hasOwn(LIST_CAPS, k) && v.length > LIST_CAPS[k]) throw refuse('list_too_long', `a "${k}" list holds more than ${LIST_CAPS[k]} entries: the lab refuses the whole document rather than reading part of it`, 413);
      if (k === '$ref') { if (typeof v !== 'string' || !v.startsWith('#/')) throw refuse('external_ref_refused', 'only local "#/" references are resolved: remote, file and relative references are refused'); continue; }
      if (v !== null && typeof v === 'object') work.push(v);
    }
  }
  return spec;
}

function pointer(root, ref) {
  let cur = root;
  for (const raw of ref.slice(2).split('/')) {
    let seg; try { seg = decodeURIComponent(raw); } catch { throw refuse('ref_not_found', 'a reference does not resolve'); }
    seg = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur) ? !/^\d{1,4}$/.test(seg) || Number(seg) >= cur.length : !isObj(cur) || !Object.hasOwn(cur, seg)) throw refuse('ref_not_found', 'a reference does not resolve');
    cur = cur[seg];
  }
  return cur;
}

// Expands a schema into a self-contained JSON schema: $ref resolved (local only), cycles cut, unsupported keywords dropped.
// The expansion budget counts nodes DURING expansion (a spec whose levels each $ref the next one is small as text and exponential once expanded).
let budget = { tool: 0, total: 0 };
let visited = 0; // units of schema work since generateTools began (a node expanded, a list entry read, a parameter looked at): tests assert this count, never elapsed time
export const expandedNodes = () => visited;
// Every unit of work is paid for here, so the cost of a document is bounded by the budget and not by how it is laid out.
function charge(units) {
  visited += units; budget.tool -= units; budget.total -= units;
  if (budget.tool < 0 || budget.total < 0) throw refuse('schema_too_large', `the schemas expand to more than ${LIMITS.expandNodes} units of work for one tool (or ${LIMITS.expandTotal} in all; a node or a list entry is one unit): the lab refuses the whole document`, 413);
}
function expand(root, node, stack, depth) {
  charge(1);
  if (depth > LIMITS.refDepth + 20) throw refuse('spec_too_deep', 'a schema nests too deeply');
  if (!isObj(node)) return {};
  if (Object.hasOwn(node, '$ref')) {
    const ref = node.$ref;
    if (stack.includes(ref)) return { type: 'object', description: 'recursive reference, not expanded' };
    if (stack.length >= LIMITS.refDepth) throw refuse('spec_too_deep', 'references are nested too deeply');
    return expand(root, pointer(root, ref), [...stack, ref], depth + 1);
  }
  const out = {};
  let n = node;
  if (Array.isArray(node.allOf)) { // allOf: merge the properties and required lists of every branch
    const merged = { ...node }; delete merged.allOf; const props = { ...(isObj(node.properties) ? node.properties : {}) }; const req = [...(Array.isArray(node.required) ? node.required : [])];
    charge(node.allOf.length);
    for (const b of node.allOf) { const e = expand(root, b, stack, depth + 1); Object.assign(props, e.properties || {}); req.push(...(e.required || [])); if (e.type && !merged.type) merged.type = e.type; }
    merged.properties = props; merged.required = req; n = merged;
  }
  if (typeof n.type === 'string' && TYPES.has(n.type)) out.type = n.type;
  if (typeof n.description === 'string') out.description = cleanFree(n.description, 200);
  if (typeof n.format === 'string') out.format = cleanFree(n.format, 30);
  if (Array.isArray(n.enum)) { charge(n.enum.length); out.enum = n.enum.filter((x) => ['string', 'number', 'boolean'].includes(typeof x)).map((x) => (typeof x === 'string' ? cleanFree(x, 60) : x)); }
  for (const k of ['minimum', 'maximum', 'minLength', 'maxLength']) if (Number.isFinite(n[k])) out[k] = n[k];
  if (typeof n.additionalProperties === 'boolean') out.additionalProperties = n.additionalProperties;
  if (isObj(n.items)) out.items = expand(root, n.items, stack, depth + 1);
  if (isObj(n.properties)) {
    const names = Object.keys(n.properties); if (names.length > 60) throw refuse('spec_too_large', 'a schema has more than 60 properties', 413);
    out.properties = {};
    for (const k of names) Object.defineProperty(out.properties, safePropName(k), { value: expand(root, n.properties[k], stack, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  if (Array.isArray(n.required)) { charge(n.required.length); out.required = [...new Set([...new Set(n.required.filter((x) => typeof x === 'string'))].map(safePropName))]; } // each distinct entry is judged once
  return out;
}

// A name taken from the specification is judged on its RAW text (invisible characters deleted, NFKC, percent-decoded), BEFORE it is turned into an identifier:
// sanitising first would turn "password: hunter2" into "password__hunter2", which no detector matches (review finding).
const verdicts = new Map(); // text -> verdict, so a name repeated across operations and parameters is judged once (cleared per document and when large)
export function leaky(raw) {
  const t = String(raw).slice(0, 2000);
  if (verdicts.has(t)) return verdicts.get(t);
  if (verdicts.size > 5000) verdicts.clear();
  const v = credentialShaped(t) || isCredentialId(t); // a name becomes an identifier, so it is also judged as an id (a long run with a digit, an sk-/pw-/token- prefix)
  verdicts.set(t, v);
  return v;
}
// A parameter, header or scheme name that looks like a credential is refused whole: it would be stored and shown as a name.
const clean = (raw) => { if (leaky(raw)) throw refuse('credential_in_spec', 'a name in the specification is shaped like a secret, so the lab refuses the document (masking is a heuristic, write plain names)'); return raw; };
const safePropName = (k) => { if (leaky(k)) return `arg_${String(k).length}`; return String(k).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64) || 'arg'; };

const slug = (path) => path.split('/').filter(Boolean).map((s) => (/^\{.*\}$/.test(s) ? `by_${s.slice(1, -1)}` : s)).join('_').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'root';

// The naming rule (lab-invented, documented on the page): the operationId if it is usable, else `<method>_<path>` (a {param} segment becomes by_<param>);
// a name that starts with a digit or "__" gets "op_" in front; an unusable or credential-shaped id falls back; a clash gets _2, _3 ...
function toolName(op, method, path, used) {
  let name = typeof op.operationId === 'string' ? op.operationId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56) : '';
  let rule = 'operationId';
  if (!name || leaky(op.operationId)) { name = `${method}_${slug(cleanFree(path, 120))}`.slice(0, 56); rule = 'fallback'; }
  if (leaky(name)) { name = `${method}_operation`; rule = 'fallback'; }
  if (/^(\d|__|-)/.test(name)) name = `op_${name}`;
  let final = name; let i = 2;
  while (used.has(final)) { final = `${name}_${i++}`; if (!rule.endsWith('+suffix')) rule = `${rule}+suffix`; }
  used.add(final);
  return { name: final, rule };
}

// The two report lists are shown up to SHOWN entries; what does not fit is COUNTED in a last warning line, never dropped without a word.
const SHOWN = 40;
const shown = (warnings, notExposed) => {
  const all = notExposed.length > SHOWN ? [...warnings, `${notExposed.length - SHOWN} more parameters the gateway does not expose are not listed`] : warnings;
  return all.length > SHOWN ? [...all.slice(0, SHOWN - 1), `${all.length - SHOWN + 1} more warnings are not listed`] : all;
};

export function generateTools(spec) {
  budget = { tool: LIMITS.expandNodes, total: LIMITS.expandTotal }; visited = 0;
  const paths = isObj(spec.paths) ? spec.paths : {};
  const pathKeys = Object.keys(paths);
  if (pathKeys.length > LIMITS.paths) throw refuse('too_many_paths', `the specification has more than ${LIMITS.paths} paths`, 413);
  const tools = []; const used = new Set(); const notExposed = []; const warnings = [];
  const params = (list, scope) => (Array.isArray(list) ? list : []).map((p) => (isObj(p) && typeof p.$ref === 'string' ? pointer(spec, p.$ref) : p)).filter(isObj).map((p) => ({ p, scope }));
  for (const path of pathKeys) {
    if (!path.startsWith('/')) throw refuse('bad_path', 'a path does not start with "/"');
    const item = paths[path];
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      if (!Object.hasOwn(item, method)) continue;
      const op = item[method];
      if (!isObj(op)) continue;
      if (tools.length >= LIMITS.operations) throw refuse('too_many_operations', `the specification has more than ${LIMITS.operations} operations: the lab refuses it whole rather than dropping some`, 413);
      budget.tool = LIMITS.expandNodes;
      const { name, rule } = toolName(op, method, path, used);
      const merged = new Map();
      charge((Array.isArray(item.parameters) ? item.parameters.length : 0) + (Array.isArray(op.parameters) ? op.parameters.length : 0)); // looking at a parameter is work too
      for (const { p } of [...params(item.parameters), ...params(op.parameters)]) if (typeof p.name === 'string' && typeof p.in === 'string') merged.set(`${p.in}:${clean(p.name)}`, p);
      if (merged.size > LIMITS.params) throw refuse('too_many_parameters', `an operation has more than ${LIMITS.params} parameters`, 413);
      budget.tool = LIMITS.expandNodes; // the per-tool budget starts again for the schemas of this tool
      const properties = {}; const required = []; const pathParams = []; const queryParams = []; const argNames = new Set(['body']);
      for (const p of merged.values()) {
        if (p.in === 'header' || p.in === 'cookie') { notExposed.push({ tool: name, in: p.in, why: p.in === 'header' ? 'headers are injected by the gateway, not chosen by the agent' : 'cookies are session state: the calling agent\'s responsibility' }); continue; }
        if (p.in !== 'path' && p.in !== 'query') continue;
        let an = safePropName(p.name); if (argNames.has(an)) an = `${p.in}_${an}`; argNames.add(an);
        const sch = expand(spec, isObj(p.schema) ? p.schema : { type: 'string' }, [], 0);
        if (typeof p.description === 'string' && !sch.description) sch.description = cleanFree(p.description, 200);
        Object.defineProperty(properties, an, { value: sch, enumerable: true, writable: true, configurable: true });
        if (p.in === 'path' || p.required === true) required.push(an);
        (p.in === 'path' ? pathParams : queryParams).push({ arg: an, name: p.name });
      }
      // every {placeholder} in the path must have a path parameter, or the call could not be built
      for (const m of path.matchAll(/\{([^}]{1,64})\}/g)) if (!pathParams.some((x) => x.name === m[1])) warnings.push(`${name}: path placeholder without a path parameter`);
      let hasBody = false;
      if (isObj(op.requestBody) || (isObj(op.requestBody) && op.requestBody.$ref)) {
        const rb = Object.hasOwn(op.requestBody, '$ref') ? pointer(spec, op.requestBody.$ref) : op.requestBody;
        const json = isObj(rb.content) ? Object.keys(rb.content).find((k) => /(^|\/|\+)json($|;)/i.test(k)) : null;
        if (json && isObj(rb.content[json])) { hasBody = true; const b = expand(spec, rb.content[json].schema, [], 0); b.description ||= 'request body'; Object.defineProperty(properties, 'body', { value: b, enumerable: true, writable: true, configurable: true }); if (rb.required === true) required.push('body'); }
        else warnings.push(`${name}: the request body is not JSON, so no body argument is generated`);
      }
      const inputSchema = { type: 'object', properties, required: [...new Set(required)], additionalProperties: false };
      if (JSON.stringify(inputSchema).length > LIMITS.schemaChars) throw refuse('schema_too_large', `a tool schema is over ${LIMITS.schemaChars} characters`, 413);
      const text = [op.summary, op.description].filter((x) => typeof x === 'string' && x).map((x) => cleanFree(x, 300)).join(' - ') || `${method.toUpperCase()} ${cleanFree(path, 80)}`;
      tools.push({ name, description: text.slice(0, 500), inputSchema, readOnly: method === 'get' || method === 'head', op: { method: method.toUpperCase(), path: cleanFree(path, 120), pathParams, queryParams, hasBody }, nameRule: rule });
    }
  }
  if (!tools.length) throw refuse('no_operations', 'the specification has no operations');
  // Authentication to the backend is header-based only: a header apiKey or an HTTP scheme is injected by the gateway; everything else is the calling agent's job.
  const auth = [];
  const schemes = isObj(spec.components) && isObj(spec.components.securitySchemes) ? spec.components.securitySchemes : {};
  const schemeKeys = Object.keys(schemes);
  if (schemeKeys.length > LIMITS.securitySchemes) throw refuse('too_many_security_schemes', `the specification has more than ${LIMITS.securitySchemes} security schemes: the lab refuses it whole rather than listing some`, 413);
  for (const k of schemeKeys) {
    const s = schemes[k]; if (!isObj(s)) continue;
    const label = safePropName(k);
    if (s.type === 'apiKey' && s.in === 'header' && typeof s.name === 'string' && HEADER_NAME.test(clean(s.name))) auth.push({ scheme: label, handled: 'header', header: s.name });
    else if (s.type === 'http' && /^(bearer|basic)$/i.test(String(s.scheme))) auth.push({ scheme: label, handled: 'header', header: 'Authorization' });
    else if (s.type === 'oauth2' || s.type === 'openIdConnect') auth.push({ scheme: label, handled: 'agent', why: 'a login flow: the calling agent\'s responsibility, by design (deck claim)' });
    else auth.push({ scheme: label, handled: 'agent', why: 'not a header: not injected by the gateway' });
  }
  const info = isObj(spec.info) ? spec.info : {};
  const server = Array.isArray(spec.servers) && isObj(spec.servers[0]) && typeof spec.servers[0].url === 'string' ? cleanFree(spec.servers[0].url, 100) : '(none)';
  return { api: { title: cleanFree(info.title ?? 'untitled', 80), version: cleanFree(info.version ?? '', 30), server }, tools, auth, notExposed: notExposed.slice(0, SHOWN), warnings: shown(warnings, notExposed) };
}

// A small JSON-schema check for tool arguments (type, required, enum, bounds, nested objects and arrays). Never builds a regex from the spec.
export function validateArgs(schema, value, depth = 0) {
  if (depth > 10) return 'nested too deeply';
  if (schema.type === 'object' || schema.properties) {
    if (!isObj(value)) return 'must be an object';
    const props = isObj(schema.properties) ? schema.properties : {};
    for (const k of Object.keys(value)) if (!Object.hasOwn(props, k) && schema.additionalProperties === false) return 'has a field the schema does not define';
    for (const r of schema.required || []) if (!Object.hasOwn(value, r) || value[r] === undefined) return 'is missing a required field';
    for (const k of Object.keys(value)) if (Object.hasOwn(props, k)) { const e = validateArgs(props[k], value[k], depth + 1); if (e) return e; }
    return null;
  }
  if (schema.type === 'array') { if (!Array.isArray(value)) return 'must be an array'; if (value.length > 100) return 'array too long'; for (const x of value) { const e = schema.items ? validateArgs(schema.items, x, depth + 1) : null; if (e) return e; } return null; }
  if (schema.type === 'string' && typeof value !== 'string') return 'must be a string';
  if (schema.type === 'integer' && !Number.isInteger(value)) return 'must be an integer';
  if (schema.type === 'number' && !(typeof value === 'number' && Number.isFinite(value))) return 'must be a number';
  if (schema.type === 'boolean' && typeof value !== 'boolean') return 'must be true or false';
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return 'is not one of the allowed values';
  if (typeof value === 'number') { if (Number.isFinite(schema.minimum) && value < schema.minimum) return 'is below the minimum'; if (Number.isFinite(schema.maximum) && value > schema.maximum) return 'is above the maximum'; }
  if (typeof value === 'string') { if (Number.isFinite(schema.minLength) && value.length < schema.minLength) return 'is too short'; if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) return 'is too long'; if (value.length > 2000) return 'is too long'; }
  return null;
}

// Builds the backend request for a tool call (path parameters percent-encoded, so an id can never add a path segment) and runs it on the mock backend.
export function callBackend(tool, args, { headers, requiresAuth }) {
  const a = isObj(args) ? args : {};
  let path = tool.op.path;
  for (const p of tool.op.pathParams) path = path.split(`{${p.name}}`).join(encodeURIComponent(String(a[p.arg])));
  const query = {}; for (const p of tool.op.queryParams) if (a[p.arg] !== undefined) query[p.name] = String(a[p.arg]);
  const bodyKeys = tool.op.hasBody && isObj(a.body) ? Object.keys(a.body) : [];
  // Only the TEMPLATE and the argument NAMES are ever shown: the substituted (percent-encoded) path would carry what the visitor typed in a form no masker recognises.
  const req = { method: tool.op.method, path: tool.op.path, pathParamNames: tool.op.pathParams.map((p) => p.name), queryNames: Object.keys(query), headerNames: headers.map((h) => h.name), bodyKeys };
  if (requiresAuth && !headers.length) return { request: req, status: 401, body: { error: 'the backend needs an authentication header and the gateway injected none' } };
  const lim = Math.min(Number(query.limit) || 50, 50);
  const route = `${tool.op.method} ${tool.op.path}`;
  if (route === 'GET /items') return { request: req, status: 200, body: { items: MOCK_BACKEND_ITEMS.slice(0, lim) } };
  const m = /^\/items\/([^/]+)$/.exec(path);
  if (m && tool.op.path === '/items/{id}') {
    const id = decodeURIComponent(m[1]); const it = MOCK_BACKEND_ITEMS.find((x) => x.id === id);
    if (tool.op.method === 'GET') return it ? { request: req, status: 200, body: it } : { request: req, status: 404, body: { error: 'no such item' } };
    if (tool.op.method === 'DELETE') return it ? { request: req, status: 200, body: { deleted: true } } : { request: req, status: 404, body: { error: 'no such item' } };
  }
  if (route === 'POST /items') return { request: req, status: 201, body: { id: 'i-4', created: true, fields: bodyKeys.length } };
  return { request: req, status: 200, body: { mock: true, note: 'generic answer: the lab backend has no handler for this route', method: tool.op.method, route: tool.op.path } };
}

export function diffTools(before, after) {
  const b = new Map(before.map((t) => [t.name, t])); const a = new Map(after.map((t) => [t.name, t]));
  return {
    added: [...a.keys()].filter((k) => !b.has(k)), removed: [...b.keys()].filter((k) => !a.has(k)),
    changed: [...a.keys()].filter((k) => b.has(k) && JSON.stringify(b.get(k).inputSchema) !== JSON.stringify(a.get(k).inputSchema)),
  };
}
