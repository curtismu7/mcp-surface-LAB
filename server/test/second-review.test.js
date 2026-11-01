// Second-review fixes: S5 (a missing file is a 404, not the page), S7 (the hidden-name check matches whole names), N2 (a pure preview needs no workspace slot).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rawDiagram } from '../src/diagramData.js';
import { isPageAddress } from '../src/app.js';
import { createWorkspaces } from '../src/workspaces.js';
import { NAME_CHAR, containsWholeName, encodeAnswer, filterWire } from '../src/wire.js';
import net from 'node:net';
import { A, APP, U, act, callTool, codeOf, mcp, newEngine, ok, run, withServer } from './helpers.js';

// A request line sent byte for byte: neither fetch nor new URL() may normalise "%2e%2e" or "/../" before the server sees it.
function rawHttp(base, { method = 'GET' } = {}) {
  const u = new URL(base.slice(0, base.indexOf('/', 'http://'.length) < 0 ? undefined : base.indexOf('/', 'http://'.length))); // host and port only; the path is taken from the string below
  const at = base.indexOf('/', 'http://'.length); const reqPath = at < 0 ? '/' : base.slice(at);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), '127.0.0.1'); let data = '';
    sock.on('data', (c) => { data += c; }); sock.on('error', reject);
    sock.on('close', () => { const [head, ...rest] = data.split('\r\n\r\n'); const lines = head.split('\r\n'); resolve({ status: Number(lines[0].split(' ')[1]), headers: Object.fromEntries(lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()])), text: rest.join('\r\n\r\n') }); });
    sock.write(`${method} ${reqPath} HTTP/1.1\r\nHost: 127.0.0.1:${u.port}\r\nConnection: close\r\n\r\n`);
  });
}

// ---- S5 ----------------------------------------------------------------------------------------------------------------------------------------
async function withDist(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msl-dist-'));
  const dist = path.join(root, 'dist'); fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>PAGE</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log("asset")');
  fs.writeFileSync(path.join(dist, 'real.css'), 'body{}');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'OUTSIDE-THE-WEB-ROOT');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"OUTSIDE-THE-WEB-ROOT"}');
  try { await withServer(fn, { webDist: dist }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('S5: a missing file with an extension, a dot segment or a dot-file is a fixed JSON 404 for GET and HEAD; a page address still gets the page', async () => {
  await withDist(async (url) => {
    for (const p of ['/favicon.ico', '/robots.txt', '/missing.css', '/x.js', '/manifest.webmanifest', '/%2e%2e/%2e%2e/etc/passwd', '/..%2fpackage.json', '/%2e%2e%2fpackage.json', '/.env', '/.git/config', '/a/.hidden', '/a/%2e/b', '/..%5coutside.txt', '/a.b', '/deep/path/file.tar.gz', '/assets/missing.js', '/assets/', '/%E0%A4%A']) {
      for (const method of ['GET', 'HEAD']) {
        const r = await rawHttp(`${url}${p}`, { method });
        assert.equal(r.status, 404, `${method} ${p}`);
        assert.match(String(r.headers['content-type']), /application\/json/, `${method} ${p}`);
        if (method === 'GET') assert.deepEqual(JSON.parse(r.text), { error: 'not_found' }, p);
      }
    }
    for (const p of ['/', '/openapi', '/some/deep/route', '/a/b.c/d', '/UPPER']) {
      for (const method of ['GET', 'HEAD']) { const r = await rawHttp(`${url}${p}`, { method }); assert.equal(r.status, 200, `${method} ${p}`); assert.match(String(r.headers['content-type']), /text\/html/); if (method === 'GET') assert.match(r.text, /PAGE/); }
    }
    assert.equal((await rawHttp(`${url}/real.css`)).status, 200); assert.equal((await rawHttp(`${url}/assets/app.js`)).text, 'console.log("asset")');
  });
});

test('S5: the web root still cannot be escaped (encoded dot segments, encoded slashes, backslashes, double encoding): no answer holds a file from outside it', async () => {
  await withDist(async (url) => {
    for (const p of ['/%2e%2e/outside.txt', '/..%2foutside.txt', '/..%2Foutside.txt', '/%2e%2e%2foutside.txt', '/..%5coutside.txt', '/%252e%252e/outside.txt', '/....//outside.txt', '/..;/outside.txt', '/%2e%2e/package.json', '/../package.json', '/assets/../../outside.txt', '/x/..', '/assets/%2e%2e/%2e%2e/outside.txt', '/%00/../outside.txt']) {
      for (const method of ['GET', 'HEAD']) { const r = await rawHttp(`${url}${p}`, { method }); assert.ok(!r.text.includes('OUTSIDE-THE-WEB-ROOT'), `${method} ${p}`); assert.ok(r.status < 500, `${method} ${p}: ${r.status}`); }
    }
  });
});

test('S5: isPageAddress is the one rule: no dot segment, no dot-file, no extension in the last segment, no backslash, decodable', () => {
  for (const p of ['/', '/a', '/a/b', '/a/b.c/d', '/a/b%20c', '/a-b_c', '//']) assert.equal(isPageAddress(p), true, p);
  for (const p of ['/a.js', '/a/b.c', '/.x', '/a/.x', '/..', '/a/..', '/a/./b', '/%2e%2e/x', '/a%2f..%2fb', '/a\\b', '/%E0%A4%A', '/a.', '/favicon.ico']) assert.equal(isPageAddress(p), false, p);
});

// ---- S7 ----------------------------------------------------------------------------------------------------------------------------------------
const nameSpec = (extraDesc = '') => JSON.stringify({ openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: { '/items': { get: { operationId: 'listItems', description: extraDesc || 'List the items' } }, '/list': { post: { operationId: 'list', description: 'Create a list' } } } });

test('S7: a hidden tool whose name is the start of a visible one ("list" / "listItems") no longer refuses the whole listing for the caller who may not see it', () => {
  const e = newEngine();
  ok(run(e, 'oaDeploy', { actor: A, name: 'lists', spec: nameSpec() }));
  const staff = mcp(e, U, APP('lists'), 'tools/list');
  assert.equal(staff.ok, true, `the review repro: ${staff.code}`);
  assert.deepEqual(staff.result.rpc.result.tools.map((t) => t.name), ['listItems'], 'staff are read-only by default: the POST /list tool is hidden');
  assert.deepEqual(mcp(e, A, APP('lists'), 'tools/list').result.rpc.result.tools.map((t) => t.name).sort(), ['list', 'listItems']);
  assert.ok(mcp(e, U, APP('lists'), 'tools/list', {}, { style: 'sse' }).ok && mcp(e, U, APP('lists'), 'tools/list', {}, { style: 'gzip-sse' }).ok, 'the same over the streamed and compressed wires');
  assert.equal(codeOf(callTool(e, U, APP('lists'), 'list')), 'access_denied', 'the hidden tool is still not callable');
});

test('S7: the check still fails closed when the hidden name really appears: in a visible description (as a word), as a name, in a notification, in _meta', () => {
  const e = newEngine();
  ok(run(e, 'oaDeploy', { actor: A, name: 'lists', spec: nameSpec('First call list, then read the rest') }));
  const staff = mcp(e, U, APP('lists'), 'tools/list');
  assert.equal(staff.ok, false); assert.equal(staff.code, 'hidden_name_in_frame'); assert.equal(staff.status, 502);
  // at the wire level, in the places a name can hide
  const keep = (k, it) => it.name !== 'secret_tool';
  const refuseCode = (message, style = 'json') => { try { filterWire(encodeAnswer(message, style), keep); return 'passed'; } catch (err) { return err.code; } };
  const tools = [{ name: 'secret_tool' }, { name: 'visible_tool', description: 'x' }];
  const listing = (extra = {}) => ({ jsonrpc: '2.0', id: 1, result: { tools, ...extra } });
  assert.equal(refuseCode(listing()), 'passed', 'a hidden name that appears only in the hidden item itself is removed with it');
  assert.equal(refuseCode(listing({ note: 'secret_tool is available' })), 'hidden_name_in_frame');
  assert.equal(refuseCode(listing({ _meta: { tool: 'secret_tool' } })), 'hidden_name_in_frame');
  assert.equal(refuseCode(listing({ tools: [{ name: 'secret_tool' }, { name: 'visible_tool', description: 'uses secret_tool.' }] })), 'hidden_name_in_frame');
  assert.equal(refuseCode(listing({ tools: [{ name: 'secret_tool' }, { name: 'visible_tool', description: '(secret_tool)' }] }), 'sse'), 'hidden_name_in_frame');
  assert.equal(refuseCode(listing({ tools: [{ name: 'secret_tool' }, { name: 'secret_tool_v2' }] })), 'passed', 'a longer, different name is a different name');
  assert.equal(refuseCode(listing({ tools: [{ name: 'secret_tool' }, { name: 'visible_tool', description: 'my_secret_tool' }] })), 'passed');
});

test('S7: containsWholeName: a name is whole unless a letter, digit, underscore or hyphen touches it', () => {
  const t = (blob, name) => containsWholeName(blob, name);
  assert.equal(t('list', 'list'), true, 'the whole blob'); assert.equal(t('"list"', 'list'), true); assert.equal(t('a list b', 'list'), true); assert.equal(t('list.', 'list'), true); assert.equal(t('(list)', 'list'), true);
  assert.equal(t('listItems', 'list'), false); assert.equal(t('mylist', 'list'), false); assert.equal(t('list_cases', 'list'), false); assert.equal(t('a_list', 'list'), false); assert.equal(t('list-all', 'list'), false); assert.equal(t('all-list', 'list'), false);
  assert.equal(t('list2', 'list'), false); assert.equal(t('2list', 'list'), false); assert.equal(t('lisT', 'list'), false, 'case matters');
  assert.equal(t('listItems and list', 'list'), true, 'a later whole occurrence is found after an embedded one'); assert.equal(t('xlist list', 'list'), true);
  assert.equal(t('über', 'ber'), false, 'a letter outside ASCII touches too'); assert.equal(t('', 'list'), false); assert.equal(t('abc', ''), false);
  for (const ch of ['é', '7', '_', '-', 'Z']) assert.equal(NAME_CHAR.test(ch), true, ch);
  for (const ch of ['.', ' ', '"', ',', ':', '(', ')', '/', '\\', '\n']) assert.equal(NAME_CHAR.test(ch), false, JSON.stringify(ch));
});

// ---- N2 ----------------------------------------------------------------------------------------------------------------------------------------
test('N2: a pure preview in Live needs no workspace slot: it works in a new workspace at the cap, holds no slot, and an existing workspace keeps its state', async () => {
  const workspaces = createWorkspaces({ max: 1 });
  await withServer(async (url) => {
    const spec = JSON.stringify({ openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: { '/a': { get: { operationId: 'a' } } } });
    assert.equal((await act(url, 'advance', { minutes: 5 }, 'full')).status, 200);
    assert.equal(workspaces.size(), 1);
    const p = await act(url, 'oaPreview', { spec }, 'brand-new');
    assert.equal(p.status, 200, 'the review repro answered 503 workspace_limit'); assert.equal(p.body.result.tools[0].name, 'a');
    assert.equal(workspaces.size(), 1, 'no slot was taken'); assert.equal(workspaces.peek('brand-new', 'finance'), null);
    const blocked = await act(url, 'advance', { minutes: 5 }, 'brand-new');
    assert.equal(blocked.status, 503); assert.equal(blocked.body.error, 'workspace_limit');
    const mine = await act(url, 'oaPreview', { spec }, 'full');
    assert.equal(mine.status, 200); assert.equal(mine.body.state.clockSeconds, 300, 'the answer carries the workspace\'s own state, not a blank one');
    assert.equal((await act(url, 'oaPreview', { spec: 'not json' }, 'brand-new')).status, 400, 'a refused preview is still refused honestly');
    assert.equal(workspaces.size(), 1);
  }, { workspaces });
});

// ---- S8 ----------------------------------------------------------------------------------------------------------------------------------------
// The layout was measured in a real browser (scripts of the review: any label/label, label/node or node/node overlap over 1 px, at 1280 and 375 wide, light and dark). A browser
// is not part of this suite, so the position that fixed it is pinned: "Trusted issuers and keys" sits under the backend, where the gateway's verify arrow, its reply and the
// backend's own verify arrow each have their own side of the box (under the gateway the reply and the backend's arrow shared the box's right side and their labels met).
test('S8: the pass-through diagram keeps the trust store under the backend (the label overlap fix)', () => {
  const nodes = Object.fromEntries(rawDiagram('passthrough-assertion').nodes.map((n) => [n.id, n]));
  assert.deepEqual([nodes.trust.x, nodes.trust.y], [nodes.be.x, 300]); assert.equal(nodes.be.x, 1500); assert.equal(nodes.gw.x, 1000);
});

test('S5: the page names an inline icon, so a browser never asks for /favicon.ico (which is a 404 now) and logs a console error', () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/index.html'), 'utf8');
  assert.match(html, /<link rel="icon" href="data:,"/);
});
