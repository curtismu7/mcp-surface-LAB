// The wire: SSE framing (CRLF, LF, CR, split anywhere, multi-line data, comments, notifications), gzip, and the fail-closed rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { SseParser, encodeAnswer, filterWire, readWire, splitChunks, STYLES, MAX_WIRE } from '../src/wire.js';

const tools = (names) => ({ jsonrpc: '2.0', id: 1, result: { tools: names.map((n) => ({ name: n, description: n, inputSchema: { type: 'object' } })) } });
const keepOnly = (...ok) => (kind, it) => ok.includes(it.name);
const namesOf = (messages) => messages.flatMap((m) => m.result?.tools?.map((t) => t.name) ?? []);

test('every style of upstream answer is filtered to the same result', () => {
  for (const style of STYLES) {
    const out = filterWire(encodeAnswer(tools(['a', 'b', 'c', 'secret']), style), keepOnly('a', 'c'));
    assert.deepEqual(namesOf(out.messages), ['a', 'c'], style);
    assert.deepEqual(out.stats.frames.find((f) => f.listing === 'tools').hidden.sort(), ['b', 'secret'], style);
    assert.deepEqual(namesOf(readWire(out)), ['a', 'c'], `${style}: what the client receives is the filtered list`);
    assert.ok(!Buffer.concat(zlib.gunzipSync ? (out.headers['content-encoding'] ? [zlib.gunzipSync(Buffer.concat(out.chunks))] : out.chunks) : out.chunks).toString().includes('secret'), `${style}: the hidden name is nowhere in the bytes sent on`);
  }
});

test('a streamed answer is split into chunks, carries a comment and a notification, and survives', () => {
  const w = encodeAnswer(tools(['a', 'hidden']), 'sse');
  assert.ok(w.chunks.length > 5, 'many chunks');
  const out = filterWire(w, keepOnly('a'));
  assert.deepEqual(out.stats.frames.map((f) => f.kind), ['comment', 'notification', 'response']);
});

test('the SSE parser: CRLF, LF and CR endings, a frame split at every possible byte, multi-line data, ids and retry', () => {
  const text = ': hello\r\nevent: message\r\nid: 7\r\nretry: 100\r\ndata: {"a":\r\ndata: 1}\r\n\r\nevent: message\ndata: {"b":2}\n\ndata: {"c":3}\r\r';
  const whole = (() => { const p = new SseParser(); p.push(text); p.end(); return p.take(); })();
  assert.deepEqual(whole.filter((f) => !f.comment).map((f) => JSON.parse(f.data)), [{ a: 1 }, { b: 2 }, { c: 3 }]);
  for (let cut = 1; cut < text.length; cut++) {
    const p = new SseParser(); p.push(text.slice(0, cut)); p.push(text.slice(cut)); p.end();
    assert.deepEqual(p.take().filter((f) => !f.comment).map((f) => JSON.parse(f.data)), [{ a: 1 }, { b: 2 }, { c: 3 }], `cut at ${cut}`);
  }
  // a CRLF split between CR and LF is one line ending, not two
  const p = new SseParser(); p.push('data: x\r'); p.push('\n\r'); p.push('\n'); p.end();
  assert.equal(p.take().length, 1);
});

test('fail closed: an unparseable frame, a half-finished frame, a non-object message and a malformed listing refuse the WHOLE response', () => {
  const sse = (body) => ({ headers: { 'content-type': 'text/event-stream' }, chunks: [Buffer.from(body)] });
  const json = (body) => ({ headers: { 'content-type': 'application/json' }, chunks: [Buffer.from(body)] });
  const code = (fn) => { try { fn(); return 'passed'; } catch (e) { return e.code; } };
  assert.equal(code(() => filterWire(sse('data: not json\n\n'), () => true)), 'unparseable_frame');
  assert.equal(code(() => filterWire(sse('data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a"}]}}'), () => true)), 'unparseable_frame', 'no terminating blank line: ambiguous, refused');
  assert.equal(code(() => filterWire(json('[1,2]'), () => true)), 'unparseable_frame');
  assert.equal(code(() => filterWire(json('{"result":{"tools":"all of them"}}'), () => true)), 'unparseable_frame', 'a listing that is not an array');
  assert.equal(code(() => filterWire(json('{"result":{"tools":{"name":"a"}}}'), () => true)), 'unparseable_frame');
  assert.equal(code(() => filterWire(json('nope'), () => true)), 'unparseable_frame');
  assert.equal(code(() => filterWire({ headers: { 'content-type': 'text/html' }, chunks: [Buffer.from('<p>')] }, () => true)), 'unsupported_content_type');
  assert.equal(code(() => filterWire({ headers: { 'content-type': 'application/json', 'content-encoding': 'br' }, chunks: [Buffer.from('x')] }, () => true)), 'unsupported_encoding');
  assert.equal(code(() => filterWire({ headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, chunks: [Buffer.from('not gzip')] }, () => true)), 'bad_encoding');
});

test('a tool listed with a malformed entry is dropped, never passed through; a listing hidden in a batch is filtered too', () => {
  const body = JSON.stringify([{ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a' }, 'bad', { nope: 1 }, { name: 5 }, null] } }, { jsonrpc: '2.0', id: 2, result: { prompts: [{ name: 'p' }, { name: 'q' }] } }]);
  const out = filterWire({ headers: { 'content-type': 'application/json' }, chunks: [Buffer.from(body)] }, keepOnly('a', 'p'));
  assert.deepEqual(out.messages[0].result.tools.map((t) => t.name), ['a']);
  assert.deepEqual(out.messages[1].result.prompts.map((t) => t.name), ['p']);
});

test('a listing is recognised by its SHAPE, not by the request id or method: an id the gateway never sent is filtered all the same', () => {
  const out = filterWire(encodeAnswer({ jsonrpc: '2.0', id: 9999, result: { tools: [{ name: 'a' }, { name: 'z' }] } }, 'sse'), keepOnly('a'));
  assert.deepEqual(namesOf(out.messages), ['a']);
});

test('a compression bomb is refused within the lab limit, and an over-large body is refused before it is decoded', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(MAX_WIRE + 10, 0x20));
  assert.ok(bomb.length < 10000);
  assert.throws(() => filterWire({ headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, chunks: splitChunks(bomb) }, () => true), (e) => e.code === 'bad_encoding');
  assert.throws(() => filterWire({ headers: { 'content-type': 'application/json' }, chunks: [Buffer.alloc(MAX_WIRE + 1)] }, () => true), (e) => e.code === 'response_too_large');
});

test('splitChunks always returns at least one chunk and reassembles exactly', () => {
  assert.equal(splitChunks(Buffer.alloc(0)).length, 1);
  const b = Buffer.from('x'.repeat(100)); assert.equal(Buffer.concat(splitChunks(b, 7)).toString(), b.toString());
});
