// Second-review fixes for MASKING (B1, S1, S2, S3). A credential typed with control characters woven through its keyword, as a keyword followed by a space,
// as URL userinfo with no scheme, or as quoted JSON must come back in NO answer, hop, audit entry, recording or state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, act, get, post, withServer, W } from './helpers.js';
import { createWorkspaces } from '../src/workspaces.js';
import { OP_NAMES } from '../src/actions.js';
import { cleanFree, findCredentials, maskText } from '../src/credentials.js';
import { maskDeep, maskResponseText } from '../src/mask.js';
import { SKEL, variants } from './skeleton.js';
import { credentialShaped } from '../src/util.js';

// Every C0 control except TAB/LF/CR, DEL and the C1 range are DELETED; the six the review named are tested in every position, the rest in a sweep.
const CONTROLS = ['\u0000', '\u0001', '\u001f', '\u007f', '\u0085', '\u009f'];
const TOK = ['abcdef12', '34567890zz'].join(''); // assembled at run time: no credential-shaped literal sits in the repository
const weave = (word, c) => [...word].join(c);
// shape: the text typed, and the value that must not survive
const SHAPES = [
  { k: 'password', make: (c) => `${weave('password', c)}: hunter2xyz`, probe: 'hunter2xyz' },
  { k: 'pw', make: (c) => `${weave('pw', c)}: Hunter2Secret`, probe: 'Hunter2Secret' },
  { k: 'token', make: (c) => `${weave('token', c)} ${TOK}`, probe: TOK },
  { k: 'Bearer', make: (c) => `${weave('Bearer', c)} abcdEFGH1234567890tokenvalue`, probe: 'abcdEFGH1234567890tokenvalue' },
  { k: 'sk-', make: (c) => `${weave('sk-', c)}Zy9Xw8Vv7Uu6Tt5Ss4Rr3Qq2Pp1`, probe: 'Zy9Xw8Vv7Uu6' },
  { k: 'my password is', make: (c) => `my${c} ${weave('password', c)} is hunter2xyz`, probe: 'hunter2xyz' },
];

test('B1: a control character woven through a keyword cannot hide the credential (cleanFree, maskText, findCredentials, the response mask)', () => {
  for (const c of CONTROLS) for (const sh of SHAPES) {
    const typed = `note ${sh.make(c)} end`;
    const label = `${sh.k} with U+${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
    assert.ok(!cleanFree(typed).includes(sh.probe), `cleanFree: ${label}: ${JSON.stringify(cleanFree(typed))}`);
    assert.ok(credentialShaped(typed), `credentialShaped: ${label}`);
    assert.ok(!maskText(typed).includes(sh.probe), `maskText: ${label}`);
    assert.ok(!maskResponseText(typed).includes(sh.probe), `the response mask: ${label}`);
    assert.ok(!JSON.stringify(maskDeep({ a: [typed] })).includes(sh.probe), `maskDeep: ${label}`);
  }
});

test('B1: EVERY C0 and C1 control (not only the six named) is deleted before matching, in any position, also when typed percent-encoded', () => {
  const all = [...Array(0x20).keys(), ...Array.from({ length: 33 }, (_, i) => 0x7f + i)].filter((n) => ![0x09, 0x0a, 0x0d].includes(n)).map((n) => String.fromCharCode(n));
  for (const c of all) {
    const typed = `${weave('password', c)}=hunter2xyz`;
    assert.ok(!cleanFree(typed).includes('hunter2xyz'), `U+${c.charCodeAt(0).toString(16)}`);
    assert.ok(!cleanFree(`p${encodeURIComponent(c)}assword=hunter2xyz`).includes('hunter2xyz'), `encoded U+${c.charCodeAt(0).toString(16)}`);
  }
  assert.equal(all.length, 0x20 - 3 + 0x21, 'C0 minus TAB/LF/CR, plus DEL and the 32 C1 characters');
});

test('B1: TAB, LF, CR and U+2028/2029 count BOTH as separators and as deleted, so legitimate multi-line text stays readable', () => {
  for (const b of ['\t', '\n', '\r', '\r\n', ' ', ' ']) {
    assert.ok(!cleanFree(`pass${b}word=hunter2xyz`).includes('hunter2xyz'), `deleted: ${JSON.stringify(b)}`);
    assert.ok(!cleanFree(`password${b}hunter2xyz`).includes('hunter2xyz'), `separator: ${JSON.stringify(b)}`);
    assert.ok(!cleanFree(`my${b}password${b}is${b}hunter2xyz`).includes('hunter2xyz'), `separator, plain language: ${JSON.stringify(b)}`);
    assert.ok(!maskResponseText(`pass${b}word: hunter2xyz`).includes('hunter2xyz'), `the response mask: ${JSON.stringify(b)}`);
    assert.ok(findCredentials(`to${b}ken ${TOK}`).length > 0, `findCredentials: ${JSON.stringify(b)}`);
  }
  // ordinary multi-line text is unchanged except that each break becomes one space
  assert.equal(cleanFree('Please review the change\nand approve it,\r\nthanks\tmuch'), 'Please review the change and approve it, thanks much');
  assert.equal(cleanFree('the token requirements\nand the password policy\nare in the handbook'), 'the token requirements and the password policy are in the handbook');
  // a span found only with the break deleted still covers the whole original range: no half of the keyword is left behind
  assert.match(maskText('x pass\nword=hunter2xyz y'), /^x \[masked:[a-z-]+\] y$/);
  assert.match(maskText('x pass\n\nword: hunter2xyz y'), /^x \[masked:[a-z-]+\] y$/);
});

test('B1: a control character typed into ANY free-text field of ANY action never lets the credential through: answers, hops, audit, recordings and state', { timeout: 600000 }, async () => {
  await withServer(async (url) => {
    let n = 0;
    for (const c of CONTROLS) for (const sh of SHAPES) {
      const typed = sh.make(c);
      for (const op of OP_NAMES) {
        const all = [...variants(SKEL[op], typed)];
        for (const body of [all[all.length - 1], ...all.slice(0, -1).filter((_, i) => i % 3 === 0)]) { // every string at once, and a third of the single-position variants
          const ws = `ctl-${n++}`;
          if (op === 'mcp') await act(url, 'setSessionLogging', { actor: C.castAdmin, enabled: true }, ws); // so the arguments are recorded too
          const r = await post(url, `/api/act/${op}`, { mode: 'live', vertical: 'finance', params: body }, W(ws));
          const t = `${await r.text()} ${[...r.headers.values()].join(' ')}`;
          assert.ok(!t.includes(sh.probe), `${sh.k} U+${c.charCodeAt(0).toString(16)} via ${op}: ${t.slice(0, 160)}`);
          if (n % 11 === 0) { const st = await (await get(url, '/api/state?mode=live', W(ws))).text(); assert.ok(!st.includes(sh.probe), `${sh.k} via ${op}: in the state`); }
        }
      }
    }
  }, { workspaces: createWorkspaces({ max: 100000 }) });
});

test('B1: the stored fields show the mask: a proposal note, a DCR client name and a recording (the review repro)', async () => {
  await withServer(async (url) => {
    const note = await act(url, 'propose', { actor: C.castUser, kind: 'mcp', name: 'helpdesk', backend: `https://helpdesk.${C.castHost}.example/mcp`, authMode: 'none', note: `p\u0001a\u0001s\u0001s\u0001w\u0001o\u0001r\u0001d: hunter2xyz` }, 'repro-b1');
    assert.equal(note.status, 200); assert.equal(note.body.result.note, '[masked:assignment]');
    const n2 = await act(url, 'propose', { actor: C.castUser, kind: 'mcp', name: 'helpdesk2', backend: `https://helpdesk.${C.castHost}.example/mcp`, authMode: 'none', note: 'pass\u0085word=hunter2xyz' }, 'repro-b1');
    assert.equal(n2.body.result.note, '[masked:assignment]');
    const dcr = await act(url, 'oauthRegister', { clientName: 'my\u0001 password is X1234567', redirectUris: [`https://agent.${C.castHost}.example/cb`] }, 'repro-b1');
    assert.ok(!JSON.stringify(dcr.body).includes('X1234567'));
    assert.deepEqual(dcr.body.state.oauth.clients.map((x) => x.name), ['my [masked:assignment]']);
    await act(url, 'setSessionLogging', { actor: C.castAdmin, enabled: true }, 'repro-b1');
    const call = await act(url, 'mcp', { user: C.castUser, target: { kind: 'app', id: C.castApp1 }, rpc: { method: 'tools/call', params: { name: 'search', arguments: { query: 'p\u0001assword: hunter2xyz' } } } }, 'repro-b1');
    assert.equal(call.status, 200);
    assert.ok(!JSON.stringify(call.body.state.recordings).includes('hunter2xyz'));
  });
});

// ---- S1: a keyword and a space ----------------------------------------------------------------------------------------------------------------------
// Rule: keyword + whitespace + a value of 6 or more characters that holds a digit. Tradeoff: a value with no digit ("password Hunter") is NOT masked, and a number or a date
// after "token" ("token 2026-11-02") IS. The README states both.
test('S1: a keyword followed by a space and a value is masked (password, pw, pwd, secret, token, api key, credentials, passphrase, db pwd, the key is)', () => {
  const cases = [
    ['password hunter2xyz', 'hunter2xyz'], ['pw hunter2xyz', 'hunter2xyz'], ['pwd hunter2xyz', 'hunter2xyz'], ['secret hunter2xyz', 'hunter2xyz'], ['passwd hunter2xyz', 'hunter2xyz'],
    ['api key hunter2xyz', 'hunter2xyz'], ['api_key hunter2xyz', 'hunter2xyz'], ['token hunter2xyz', 'hunter2xyz'], ['credentials hunter2xyz', 'hunter2xyz'], ['credential hunter2xyz', 'hunter2xyz'],
    ['passphrase hunter2xyz', 'hunter2xyz'], ['db pwd hunter2xyz', 'hunter2xyz'], ['client secret hunter2xyz', 'hunter2xyz'], ['the key is hunter2xyz', 'hunter2xyz'], ['key: hunter2xyz', 'hunter2xyz'],
    ['PASSWORD Hunter2xyz', 'Hunter2xyz'], ['the password  hunter2xyz please', 'hunter2xyz'], ['pw\thunter2xyz', 'hunter2xyz'], ['the secret key hunter2xyz', 'hunter2xyz'], ['session id 00D5g000008dkQz', '00D5g000008dkQz'],
  ];
  for (const [typed, probe] of cases) {
    assert.ok(!cleanFree(typed).includes(probe), `${typed} -> ${cleanFree(typed)}`);
    assert.ok(!maskResponseText(typed).includes(probe), `the response mask: ${typed}`);
  }
});

test('S1: the value rule is exactly 6 characters with a digit', () => {
  assert.ok(!cleanFree('password abc123').includes('abc123'), '6 characters with a digit: masked');
  assert.equal(cleanFree('password abc12'), 'password abc12', '5 characters: left alone');
  assert.equal(cleanFree('password abcdefg'), 'password abcdefg', '7 characters with no digit: left alone (a known miss)');
  assert.ok(!cleanFree('password a1bcdef').includes('a1bcdef'), 'the digit may sit anywhere in the value');
});

test('S1: ordinary sentences stay readable (the false-positive guard)', () => {
  for (const t of [
    'password reset', 'please reset your password', 'Your password must be at least twelve characters', 'the password policy is in the handbook', 'the token requirements are listed below',
    'secret santa is on friday', 'pw policy review', 'the key points are cost and time', 'a key part of the plan', 'passing the review needs sign-off', 'token exchange and token refresh',
    'credentials are held in the vault', 'the api key is rotated by the platform team', 'how a password manager works', 'passphrase rules apply', 'use the secret store', 'keyword search',
    'approved by priya.nair on 2026-11-02 under pol-code-write', 'see the access key guide', 'client secret rotation runbook',
  ]) assert.equal(cleanFree(t), t, t);
});

test('S1: the review repro surfaces (propose note, DCR clientName, OpenAPI operationId, parameter name) mask or refuse the keyword + space form', async () => {
  await withServer(async (url) => {
    const n = await act(url, 'propose', { actor: C.castUser, kind: 'mcp', name: 'helpdesk', backend: `https://helpdesk.${C.castHost}.example/mcp`, authMode: 'none', note: 'password hunter2xyz' }, 'repro-s1');
    assert.equal(n.body.result.note, '[masked:keyword-space]');
    const d = await act(url, 'oauthRegister', { clientName: 'password hunter2xyz', redirectUris: [`https://agent.${C.castHost}.example/cb`] }, 'repro-s1');
    assert.deepEqual(d.body.state.oauth.clients.map((x) => x.name), ['[masked:keyword-space]']);
    const spec = (op, param) => JSON.stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: { '/a': { get: { operationId: op, parameters: param ? [{ name: param, in: 'query', schema: { type: 'string' } }] : [] } } } });
    const o = await act(url, 'oaPreview', { spec: spec('password hunter2xyz') }, 'repro-s1', { mode: 'mock' });
    assert.equal(o.status, 200); assert.ok(!JSON.stringify(o.body).includes('hunter2xyz'), 'the tool name is not password_hunter2xyz'); assert.equal(o.body.result.tools[0].name, 'get_a');
    for (const p of ['api key hunter2xyz', 'secret hunter2xyz', 'pw hunter2xyz']) {
      const r = await act(url, 'oaPreview', { spec: spec('ok', p) }, 'repro-s1', { mode: 'mock' });
      assert.equal(r.status, 400, p); assert.equal(r.body.error, 'credential_in_spec'); assert.ok(!JSON.stringify(r.body).includes('hunter2xyz'));
    }
  });
});

// ---- S2: URL userinfo with no scheme -----------------------------------------------------------------------------------------------------------------
test('S2: user:password@host without a scheme is masked, with or without leading slashes; an e-mail address and mailto: are left alone', () => {
  for (const t of ['admin:hunter2xyz@db.example', '//admin:hunter2xyz@db.example', 'connect to admin:hunter2xyz@db.example:5432/app now', 'ssh://root:hunter2xyz@host.example', 'git:hunter2xyz@github.example/repo', 'x ftp:p@ss:w0rd@h.example y']) {
    const out = cleanFree(t);
    assert.ok(!out.includes('hunter2xyz') && !out.includes('w0rd'), `${t} -> ${out}`);
    assert.ok(!maskResponseText(t).includes('hunter2xyz') && !maskResponseText(t).includes('w0rd'), `the response mask: ${t}`);
  }
  assert.equal(cleanFree('admin:hunter2xyz@db.example'), '[masked:userinfo-bare]db.example', 'only the login is replaced, the host stays');
  for (const t of ['maya.chen@fabrikam.example', 'mailto:maya.chen@fabrikam.example', 'contact maya.chen@fabrikam.example or lee.park@fabrikam.example', 'Re: status', 'ratio 3:4 at 5pm', 'time 12:30 @ the office', 'ledger:read']) assert.equal(cleanFree(t), t, t);
});

// ---- S3: JSON-quoted assignment ----------------------------------------------------------------------------------------------------------------------
test('S3: a JSON-quoted assignment is masked ({"password":"x"}, with spaces, single quotes, two keys in minified JSON)', () => {
  for (const [t, probe] of [
    ['{"password":"hunter2xyz"}', 'hunter2xyz'], ['{"password" : "hunter2xyz"}', 'hunter2xyz'], ["{'pw':'hunter2xyz'}", 'hunter2xyz'], [`{"token":"${TOK}"}`, TOK],
    ['{"api_key":"hunter2xyz","x":1}', 'hunter2xyz'], ['{"a":"b","secret":"hunter2xyz"}', 'hunter2xyz'], ['"password": "hunter2xyz"', 'hunter2xyz'], ["password: 'hunter2xyz'", 'hunter2xyz'],
    ['{"password":"hunter2xyz","pw":"Other3Secret"}', 'Other3Secret'],
  ]) {
    assert.ok(!cleanFree(t).includes(probe), `${t} -> ${cleanFree(t)}`);
    assert.ok(!maskResponseText(t).includes(probe), `the response mask: ${t}`);
  }
  assert.ok(!cleanFree('{"password":"hunter2xyz","pw":"Other3Secret"}').includes('hunter2xyz'));
  // JSON that merely has a key with one of these names and a short value is not a secret in the text sense
  assert.equal(cleanFree('{"tokens":1}'), '{"tokens":1}');
  assert.equal(cleanFree('the "password" field is required'), 'the "password" field is required');
});

test('the new detectors terminate on hostile input (no catastrophic backtracking) and the response mask scans past 200,000 characters', { timeout: 300000 }, () => {
  const hostile = { colons: 'a:'.repeat(100000), at: 'a:b@'.repeat(50000), spaces: `password${' '.repeat(190000)}x`, kws: 'password '.repeat(20000), kwtok: `pw ${'a'.repeat(190000)}`, quotes: 'password"'.repeat(20000), keys: 'key: '.repeat(30000), ws: `${'\n'.repeat(100000)}pass${'\t'.repeat(50000)}word` };
  for (const [k, bad] of Object.entries(hostile)) assert.equal(typeof maskText(bad), 'string', k);
  const long = `${'x '.repeat(150000)}password: hunter2xyz`;
  assert.ok(!maskResponseText(long).includes('hunter2xyz'), 'a secret after 300,000 characters is still masked in an answer');
});
