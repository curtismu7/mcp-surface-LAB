// HTTP hygiene (shared-masker 1.4.0 recipe): the fixed 404 and error answers, the 415 for a charset problem, the 405 with Allow from one route table, the page
// shell for page addresses only, and the workspace-id rule that refuses a credential-shaped id before a slot exists. Every typed value is built at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get, post, rawHttp, withServer, W } from './helpers.js';
import { createWorkspaces } from '../src/workspaces.js';

const GH = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
const HEX = 'a3f9c2e17b4d58a6f0c1e9d27b3a45c8e6f1d097';
const JSONHDR = { 'content-type': 'application/json' };

async function withDist(fn, opts = {}) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'msf-hyg-')); fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>PAGE</title>'); fs.mkdirSync(path.join(dist, 'assets')); fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'export {};');
  try { await withServer(fn, { webDist: dist, ...opts }); } finally { fs.rmSync(dist, { recursive: true, force: true }); }
}
const host = (url) => new URL(url).host;

test('H1: the final 404 and the error handler answer fixed JSON that never carries the path, the query or the body', async () => {
  await withDist(async (url) => {
    for (const p of [`/api/${GH}`, `/api/act/${GH}/x`, `/${GH}.js`, `/x/${GH}.map`, `/api/state/${HEX}`]) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH']) {
        const r = await rawHttp(`${url}${p}?q=${GH}`, { method, headers: { host: host(url), origin: url, 'x-probe': GH } });
        assert.equal(r.status, 404, `${method} ${p}`);
        if (method !== 'HEAD') { assert.deepEqual(JSON.parse(r.text), { error: 'not_found' }, `${method} ${p}`); assert.ok(!r.text.includes('a1B2c3D4'), 'not echoed'); }
        assert.ok(!JSON.stringify(r.headers).includes('a1B2c3D4'), 'no header echoes it');
      }
    }
    const bad = await rawHttp(`${url}/api/act/mcp`, { method: 'POST', headers: { host: host(url), origin: url, ...JSONHDR }, body: `{"a":"${GH}` });
    assert.equal(bad.status, 400); assert.deepEqual(JSON.parse(bad.text), { error: 'bad_request' });
    const big = await rawHttp(`${url}/api/act/mcp`, { method: 'POST', headers: { host: host(url), origin: url, ...JSONHDR }, body: JSON.stringify({ params: { x: GH.repeat(5000) } }) });
    assert.equal(big.status, 413); assert.deepEqual(JSON.parse(big.text), { error: 'payload_too_large' });
  });
});

test('H2: POST, PUT, DELETE and PATCH on / are a 405 with Allow: GET, HEAD (fixed JSON, never the page); on any other path they are a 404; with no web build / is a 404', async () => {
  await withDist(async (url) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await rawHttp(`${url}/`, { method, headers: { host: host(url), origin: url } });
      assert.equal(r.status, 405, `${method} /`); assert.deepEqual(JSON.parse(r.text), { error: 'method_not_allowed' }); assert.equal(r.headers.allow, 'GET, HEAD');
    }
    for (const method of ['GET', 'HEAD']) assert.equal((await rawHttp(`${url}/`, { method, headers: { host: host(url) } })).status, 200, method);
    for (const p of ['/openapi', '/some/deep/route']) {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const r = await rawHttp(`${url}${p}`, { method, headers: { host: host(url), origin: url } });
        assert.equal(r.status, 404, `${method} ${p}`); assert.deepEqual(JSON.parse(r.text), { error: 'not_found' }, `${method} ${p}`); assert.equal(r.headers.allow, undefined);
      }
    }
  });
  await withServer(async (url) => { // no web build at all: "/" is not a route
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) { const r = await rawHttp(`${url}/`, { method, headers: { host: host(url), origin: url } }); assert.equal(r.status, 404, method); assert.deepEqual(JSON.parse(r.text), { error: 'not_found' }); assert.equal(r.headers.allow, undefined); }
  });
});

test('H3: a charset problem is a 415 with a fixed body on /api and on every other path; the typed charset is in no answer and in no process output', async () => {
  const out = []; const realOut = process.stdout.write.bind(process.stdout); const realErr = process.stderr.write.bind(process.stderr);
  await withDist(async (url) => {
    process.stdout.write = (c, ...a) => { out.push(String(c)); return realOut(c, ...a); }; process.stderr.write = (c, ...a) => { out.push(String(c)); return realErr(c, ...a); };
    try {
      for (const [p, ct] of [['/api/act/advance', 'application/json; charset=utf-7'], ['/api/act/advance', `application/json; charset=${GH}`], ['/api/reset', 'application/json;charset="latin1"'], ['/anything', 'application/json; charset=utf-16'], ['/', `text/plain; charset=${GH}`], ['/api/state', 'application/json; charset="unterminated']]) {
        for (const method of ['POST', 'GET']) {
          const r = await rawHttp(`${url}${p}`, { method, headers: { host: host(url), origin: url, 'content-type': ct }, body: method === 'POST' ? '{}' : undefined });
          assert.equal(r.status, 415, `${method} ${p} ${ct.slice(0, 30)}`); assert.deepEqual(JSON.parse(r.text), { error: 'unsupported_charset' });
          assert.ok(!r.text.includes('a1B2c3D4') && !JSON.stringify(r.headers).includes('a1B2c3D4'), 'the typed value is not echoed');
        }
      }
      const u8 = await rawHttp(`${url}/api/reset`, { method: 'POST', headers: { host: host(url), origin: url, 'content-type': 'application/json;charset=utf8' }, body: '{}' });
      assert.equal(u8.status, 415, 'the body parser accepts only utf-8 spelled with the hyphen'); assert.deepEqual(JSON.parse(u8.text), { error: 'unsupported_charset' });
      for (const ct of ['application/json', 'application/json; charset=utf-8', 'application/json; charset="UTF-8"', 'application/json;charset=UTF-8']) {
        const r = await rawHttp(`${url}/api/reset`, { method: 'POST', headers: { host: host(url), origin: url, 'content-type': ct }, body: '{}' });
        assert.equal(r.status, 200, ct);
      }
    } finally { process.stdout.write = realOut; process.stderr.write = realErr; }
  });
  assert.ok(!out.join('').includes('a1B2c3D4'), 'nothing typed was logged');
});

test('H4: a known route with the wrong method is a 405 with Allow from the route table; an unknown route or action is a 404', async () => {
  await withServer(async (url) => {
    const table = [['/api/health', 'GET, HEAD'], ['/api/state', 'GET, HEAD'], ['/api/story', 'GET, HEAD'], ['/api/diagram', 'GET, HEAD'], ['/api/info', 'GET, HEAD'], ['/api/act/mcp', 'POST'], ['/api/reset', 'POST']];
    for (const [p, allow] of table) {
      const wrong = allow === 'POST' ? ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH'] : ['POST', 'PUT', 'DELETE', 'PATCH'];
      for (const method of wrong) {
        const r = await rawHttp(`${url}${p}`, { method, headers: { host: host(url), origin: url } });
        assert.equal(r.status, 405, `${method} ${p}`); assert.equal(r.headers.allow, allow, `${method} ${p}`);
        if (method !== 'HEAD') assert.deepEqual(JSON.parse(r.text), { error: 'method_not_allowed' });
      }
    }
    for (const [method, p] of [['GET', '/api/act/nope'], ['GET', `/api/act/${GH}`], ['PUT', '/api/act/__proto__'], ['GET', '/api/nothing'], ['GET', '/api/state/extra'], ['POST', '/api/']]) {
      const r = await rawHttp(`${url}${p}`, { method, headers: { host: host(url), origin: url } });
      assert.equal(r.status, 404, `${method} ${p}`); assert.deepEqual(JSON.parse(r.text), { error: 'not_found' }); assert.equal(r.headers.allow, undefined);
    }
    assert.equal((await rawHttp(`${url}/api/state?mode=live`, { method: 'HEAD', headers: { host: host(url) } })).status, 200, 'HEAD is allowed where GET is');
  });
});

test('H5: the page shell is served for page addresses only: /assets, /assets/, /api, dot-files and files with an extension are a JSON 404', async () => {
  await withDist(async (url) => {
    for (const p of ['/assets', '/assets/', '/assets/x', '/assets/x.js', '/api', '/api/', '/ASSETS', '/.git/config', '/.env', '/favicon.ico', '/a/b.map', '//', '/%', '/%zz', '/a%5cb']) {
      for (const method of ['GET', 'HEAD']) {
        const r = await rawHttp(`${url}${p}`, { method, headers: { host: host(url) } });
        assert.equal(r.status, 404, `${method} ${p}`); assert.match(String(r.headers['content-type']), /application\/json/, `${method} ${p}`);
        if (method === 'GET') assert.deepEqual(JSON.parse(r.text), { error: 'not_found' }, p);
      }
    }
    const real = await rawHttp(`${url}/assets/app.js`, { headers: { host: host(url) } });
    assert.equal(real.status, 200); assert.match(String(real.headers['content-type']), /javascript/); assert.equal(real.text, 'export {};');
    for (const p of ['/assets', '/assets/']) { const d = await rawHttp(`${url}${p}`, { headers: { host: host(url) } }); assert.equal(d.status, 404, p); assert.equal(d.headers.location, undefined, `${p}: a directory is never redirected (a Location header would echo the path)`); }
    for (const p of ['/', '/openapi', '/some/deep/route/', '/UPPER']) {
      for (const method of ['GET', 'HEAD']) { const r = await rawHttp(`${url}${p}`, { method, headers: { host: host(url) } }); assert.equal(r.status, 200, `${method} ${p}`); assert.match(String(r.headers['content-type']), /text\/html/); }
    }
  });
});

test('H6: a workspace id shaped like a credential is a 400 bad_workspace on every route that uses one, before a slot exists, and is never echoed', async () => {
  const ids = [`pw-${HEX.slice(0, 12)}`, `token-${GH.slice(4, 20).toLowerCase()}`, `password-${HEX.slice(0, 10)}`, `secret-${HEX.slice(0, 12)}`, `bearer-${HEX.slice(0, 12)}`, `ghp-${HEX.slice(0, 20)}`, `sk-${HEX.slice(0, 20)}`, HEX, HEX.slice(0, 32), `w-${HEX}`.slice(0, 40)];
  const workspaces = createWorkspaces();
  await withServer(async (url) => {
    for (const id of ids) {
      const calls = [
        await get(url, '/api/state?mode=live', W(id)),
        await post(url, '/api/act/advance', { mode: 'live', vertical: 'finance', params: { minutes: 1 } }, W(id)),
        await post(url, '/api/reset', {}, W(id)),
      ];
      for (const r of calls) {
        const t = await r.text();
        assert.equal(r.status, 400, id); assert.deepEqual(JSON.parse(t), { error: 'bad_workspace' }, id);
        assert.ok(!t.includes(id.slice(3, 12)) && !JSON.stringify([...r.headers]).includes(id.slice(3, 12)), `${id} is not echoed`);
      }
    }
    assert.equal(workspaces.size(), 0, 'no refused id took a slot');
    // ordinary ids still work
    for (const id of ['default', 'lab-2', 'maya-demo']) {
      const r = await post(url, '/api/act/advance', { mode: 'live', vertical: 'finance', params: { minutes: 1 } }, W(id));
      assert.equal(r.status, 200, id); assert.equal((await r.json()).workspace, id);
    }
    assert.equal(workspaces.size(), 3);
    const known = await post(url, '/api/act/advance', { mode: 'live', vertical: 'finance', params: { minutes: 1 } }, W('password-reset-demo'));
    assert.equal(known.status, 400, 'known trade-off: a lab name that STARTS with password- is refused (isCredentialId reads the prefix)');
  }, { workspaces });
});
