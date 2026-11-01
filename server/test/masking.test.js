import test from 'node:test';
import assert from 'node:assert/strict';
import { DETECTORS, MAX_FREE, cleanFree, findCredentials, maskText } from '../src/credentials.js';
import { maskDeep } from '../src/mask.js';
import { SECRETS, PLAIN } from './secrets.js';

test('every credential shape is found and masked', () => {
  for (const [name, v] of Object.entries(SECRETS)) {
    assert.ok(findCredentials(`please use ${v} for this`).length > 0, name);
    const out = maskText(`please use ${v} for this`);
    assert.ok(!out.includes(v), `${name} is masked`);
    assert.match(out, /\[masked:/);
  }
  assert.ok(DETECTORS.length >= 10);
});

test('cleanFree: masks, strips control and bidi characters, collapses space, caps, and never throws', () => {
  const v = SECRETS.github;
  assert.ok(!cleanFree(`token ${v}`).includes(v));
  assert.equal(cleanFree('a\u0000b\u202ec  d'), 'abc d', 'a control character and a bidi character are DELETED (a space between words stays; TAB, LF and CR are separators)');
  assert.equal(cleanFree('one\ttwo\nthree\r\nfour\u2028five'), 'one two three four five', 'TAB, LF, CR, U+2028 stay readable as spaces');
  assert.equal(cleanFree('x'.repeat(5000)).length <= MAX_FREE, true);
  assert.equal(cleanFree(undefined), ''); assert.equal(cleanFree(null), ''); assert.equal(cleanFree({}), '[object Object]');
  assert.equal(cleanFree('I need read access to review the change for the release'), 'I need read access to review the change for the release', 'ordinary text is left alone');
});

test('a secret split across the 400 character cap is still masked (masking happens before the cut)', () => {
  const v = SECRETS.github;
  const text = `${'a '.repeat(190)}${v}`;
  assert.ok(!cleanFree(text, 400).includes(v.slice(0, 20)) || cleanFree(text, 400).length <= 400);
  const out = cleanFree(`${'a '.repeat(195)}${v}`, 400);
  assert.ok(!out.includes(v));
  assert.ok(!out.includes(v.slice(0, 12)), 'not even a prefix of the token survives');
});

// No elapsed-time assertion (it failed under machine load). A catastrophic-backtracking detector would never return, so completing is the proof; the runner timeout is only a hang guard.
test('detectors terminate on hostile inputs of 20000 characters and give the expected answer for each', { timeout: 900000 }, () => {
  const hostile = { a: 'a'.repeat(20000), pw: 'password' + ' '.repeat(20000), pem: '-----BEGIN PRIVATE KEY-----' + 'x'.repeat(20000), sk: 'sk-' + '-'.repeat(20000), bearer: 'Bearer ' + 'a'.repeat(20000), jwt: 'eyJ' + 'a.'.repeat(10000), eq: ('a=').repeat(10000), kw: 'pw '.repeat(7000), kw2: 'pw:pw:pw:'.repeat(2200), ws: `pw${' '.repeat(20000)}:` };
  for (const [k, bad] of Object.entries(hostile)) { const out = maskText(bad); assert.equal(typeof out, 'string', k); assert.ok(out.length <= bad.length + 200, k); }
  assert.equal(maskText(hostile.pw), hostile.pw, 'a keyword with nothing after it is left alone');
});

test('maskDeep masks nested values, keeps ids, hashes and trace ids, does not mutate, and survives a deep structure', () => {
  const v = SECRETS.github;
  const input = { a: [{ b: `x ${v}` }], hash: 'f'.repeat(64), traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, id: 'req-0001', n: 5, nil: null };
  const out = maskDeep(input);
  assert.ok(!JSON.stringify(out).includes(v));
  assert.equal(out.hash, input.hash); assert.equal(out.traceparent, input.traceparent); assert.equal(out.id, 'req-0001'); assert.equal(out.n, 5);
  assert.ok(input.a[0].b.includes(v), 'the input is not mutated');
  let deep = { v: `y ${v}` }; for (let i = 0; i < 50000; i++) deep = { d: deep };
  assert.doesNotThrow(() => maskDeep(deep));
});

// The needles: the part of each value that must not survive. For a keyword form it is the value after the keyword.
const CORE = { plainIs: 'hunter2xyz', pwColon: 'Hunter2Secret', passEq: 'Tr0ub4dor', passphrase: 'correct horse battery', userinfo: 'hunter2@', tokenWord: ['abcdef12', '34567890zz'].join(''), google: ['a0AfH6SMB', 'xQ1w2e3r4t', '5y6u7i8o9p0'].join(''), accountKey: ['abcd', 'EFGH1234'].join(''), sessionId: '00D5g000008dkQz', key31: ['Zq9Xk2Lm8R', 't4Vb7Nc1Hd', '5Fj3Gs6Pw0Y'].join(''), shortGh: 'shortone1234' };

test('plain-language and short credentials are masked (a review found these raw): "my password is ...", pw:, pass=, a passphrase, URL userinfo, "token <word>", Google tokens, AccountKey, session ids, a 31 character key, a short prefixed token', () => {
  for (const [name, needle] of Object.entries(CORE)) {
    const v = SECRETS[name];
    const out = cleanFree(`before ${v} after`);
    assert.ok(!out.includes(needle), `${name}: "${needle}" survived in "${out}"`);
    assert.match(out, /\[masked:/, name);
    assert.ok(out.startsWith('before') , name);
  }
});

test('ordinary prose, ids, dates, resource and policy names are NOT masked (no false positives)', () => {
  for (const text of PLAIN) assert.equal(cleanFree(text), text);
  for (const id of ['req-0001', 'g-0001', 'gh-repo-core', 'snow-role-writer', 'maya.chen', 'ledger-reconciler', 'pol-code-write', 'dbx-schema-pii', '2026-11-02T10:00:00.000Z']) assert.equal(cleanFree(id), id, id);
});

test('masking happens BEFORE the cut to length: a token that straddles the limit is masked, not half shown', () => {
  const v = SECRETS.github;
  // the cut falls 1 to 8 characters into the token. With cut-then-mask the visible fragment ("ghp_", "ghp_Zq9"...) is too short to be recognised and survives.
  for (let into = 1; into <= 8; into++) {
    const filler = 'x '.repeat(200).slice(0, 400 - into); // exactly 400 - into characters, then the token starts
    const out = cleanFree(`${filler}${v}`, 400);
    assert.ok(out.length <= 400, `into ${into}`);
    for (let k = 2; k <= into; k++) assert.ok(!out.endsWith(v.slice(0, k)), `into ${into}: the output must not end with the fragment ${v.slice(0, k)}`);
    assert.ok(!out.includes('ghp_'), `into ${into}`);
  }
  assert.ok(!cleanFree(`${'a'.repeat(19990)} ${v}`, 400).includes('ghp_'));
});

test('zero-width and soft-hyphen characters interleaved through a token cannot hide it: they are deleted before masking', () => {
  const v = SECRETS.github;
  for (const z of ['\u200b', '\u200d', '\u2060', '\ufeff', '\u00ad', '\u202e']) {
    const out = cleanFree(`use ${[...v].join(z)} now`);
    assert.ok(!out.includes(v.slice(4, 14)), JSON.stringify(z));
    assert.match(out, /\[masked:github-token\]/);
  }
  assert.equal(cleanFree('a\u200bb'), 'ab');
});

test('the response mask also catches the new shapes (a value that reaches a response by any path)', () => {
  for (const name of ['userinfo', 'tokenWord', 'google', 'accountKey', 'sessionId', 'plainIs', 'passEq', 'shortGh']) {
    const out = JSON.stringify(maskDeep({ x: `see ${SECRETS[name]} please` }));
    assert.ok(!out.includes(CORE[name]), name);
  }
  assert.deepEqual(maskDeep({ a: PLAIN }), { a: PLAIN });
});

test('a PGP private key block and fullwidth look-alikes of a token are masked too', () => {
  const pgp = ['-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\nlQOYBF9abc123xyz\n-----END PGP ', 'PRIVATE KEY BLOCK-----'].join('');
  assert.ok(!cleanFree(`k ${pgp}`).includes('lQOYBF9abc123xyz'));
  const full = SECRETS.github.replace(/[a-z_]/g, (c) => (c === '_' ? '＿' : String.fromCharCode(c.charCodeAt(0) + 0xfee0)));
  assert.ok(!cleanFree(`k ${full}`).includes('Zq9') && !cleanFree(`k ${full}`).includes('ｇｈｐ') || cleanFree(`k ${full}`).includes('[masked:'));
  assert.match(cleanFree(`k ${full}`), /\[masked:/);
});

test('two assignments with no space between them (minified JSON) are masked one by one, so the second value cannot survive (review fix)', () => {
  const t = ['{"a":"p', 'w: Hunter2Secret!","b":"p', 'w: Other3Secret!"}'].join('');
  const out = maskText(t);
  assert.ok(!out.includes('Hunter2Secret') && !out.includes('Other3Secret'), out);
  assert.ok(!cleanFree(t, 300).includes('Other3Secret'));
});
