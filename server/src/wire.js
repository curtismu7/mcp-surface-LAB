// The wire between the gateway and an upstream MCP server, modelled for real: JSON bodies, Server-Sent-Events streams (CRLF or LF, a frame split
// across chunks, multi-line data, comments, notifications) and gzip. The gateway's in-flight filter decodes it, removes what the caller is not
// entitled to from listings, and encodes it again. Anything it cannot parse or does not support FAILS CLOSED (the whole response is refused),
// never passed through. Nothing here touches a socket: the "upstream" is an in-process function that produces these bytes.
import zlib from 'node:zlib';
import { refuse } from './errors.js';
import { isObj } from './util.js';

export const MAX_WIRE = 1_000_000;
export const STYLES = ['json', 'sse', 'gzip', 'gzip-sse'];
const LISTINGS = ['tools', 'prompts', 'resources'];

export function splitChunks(buf, size = 23) {
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out.length ? out : [Buffer.alloc(0)];
}

// What an upstream server sends for one JSON-RPC answer, in the chosen style. The streamed styles add a comment line and a notification frame
// before the answer, break the JSON over several data lines and use CRLF, so a naive filter that looks at "one chunk, one JSON document" fails.
export function encodeAnswer(message, style) {
  const streamed = style === 'sse' || style === 'gzip-sse';
  let body;
  if (streamed) {
    const note = { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'upstream ready' } };
    const lines = JSON.stringify(message, null, 1).split('\n').map((l) => `data: ${l}`).join('\r\n');
    body = Buffer.from(`: keep-alive\r\n\r\nevent: message\r\ndata: ${JSON.stringify(note)}\r\n\r\nevent: message\r\n${lines}\r\n\r\n`);
  } else body = Buffer.from(JSON.stringify(message));
  const gz = style === 'gzip' || style === 'gzip-sse';
  if (gz) body = zlib.gzipSync(body);
  return { headers: { 'content-type': streamed ? 'text/event-stream' : 'application/json', ...(gz ? { 'content-encoding': 'gzip' } : {}) }, chunks: splitChunks(body) };
}

// An incremental SSE parser (the field rules of the SSE spec: lines end at CRLF, LF or CR; a blank line dispatches; data lines join with LF).
export class SseParser {
  constructor() { this.buf = ''; this.cur = { event: '', data: [], has: false }; this.frames = []; }
  push(text) {
    this.buf += text;
    if (this.buf.length > MAX_WIRE) throw refuse('response_too_large', 'the upstream stream is larger than the lab allows', 502);
    let i = 0;
    for (;;) {
      let j = -1; let len = 0;
      for (let k = i; k < this.buf.length; k++) {
        const ch = this.buf[k];
        if (ch === '\n') { j = k; len = 1; break; }
        if (ch === '\r') { if (k + 1 >= this.buf.length) break; /* CR at the end: wait, it may be CRLF */ j = k; len = this.buf[k + 1] === '\n' ? 2 : 1; break; }
      }
      if (j < 0) break;
      this.line(this.buf.slice(i, j)); i = j + len;
    }
    this.buf = this.buf.slice(i);
  }
  line(l) {
    if (l === '') { if (this.cur.has) this.frames.push({ event: this.cur.event || 'message', data: this.cur.data.join('\n') }); this.cur = { event: '', data: [], has: false }; return; }
    if (l.startsWith(':')) { this.frames.push({ comment: true }); return; }
    const c = l.indexOf(':'); const field = c < 0 ? l : l.slice(0, c); let v = c < 0 ? '' : l.slice(c + 1); if (v.startsWith(' ')) v = v.slice(1);
    if (field === 'data') { this.cur.data.push(v); this.cur.has = true; } else if (field === 'event') { this.cur.event = v; this.cur.has = true; }
    else if (field === 'id' || field === 'retry') this.cur.has = true;
  }
  end() {
    // A trailing CR is a complete line ending now; anything half-finished is ambiguous, so the response is refused.
    if (this.buf.endsWith('\r')) { this.line(this.buf.slice(0, -1)); this.buf = ''; }
    if (this.buf.length || this.cur.has) throw refuse('unparseable_frame', 'the upstream stream ended in the middle of a frame', 502);
  }
  take() { const f = this.frames; this.frames = []; return f; }
}

// The in-flight filter. `keep(kind, item)` says whether the caller may see one listed item. Returns the new wire plus operator-side stats.
export function filterWire(wire, keep) {
  const enc = String(wire.headers['content-encoding'] || 'identity').toLowerCase();
  if (enc !== 'identity' && enc !== 'gzip') throw refuse('unsupported_encoding', 'the upstream used a content encoding the lab does not decode, so the response was refused rather than passed through', 502);
  let body = Buffer.concat(wire.chunks);
  if (body.length > MAX_WIRE) throw refuse('response_too_large', 'the upstream response is larger than the lab allows', 502);
  if (enc === 'gzip') { try { body = zlib.gunzipSync(body, { maxOutputLength: MAX_WIRE }); } catch { throw refuse('bad_encoding', 'the compressed response could not be decoded within the lab limits', 502); } }
  const type = String(wire.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const stats = { encoding: enc, contentType: type, upstreamChunks: wire.chunks.length, frames: [] };
  const messages = [];
  const filterMessage = (msg, index, kind) => {
    if (!isObj(msg)) throw refuse('unparseable_frame', 'a frame in the upstream response is not a JSON-RPC message', 502);
    const st = { index, kind, hidden: [] };
    // Every listing, WHERE EVER it sits in the message (a result, a notification's params, error data, structured content, _meta ...), is filtered, iteratively.
    const work = [[msg, true]];
    while (work.length) {
      const [node, top] = work.pop();
      if (Array.isArray(node)) { for (const x of node) if (x !== null && typeof x === 'object') work.push([x, false]); continue; }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (LISTINGS.includes(k) && (top ? false : true) && Array.isArray(v)) { st.nested = true; node[k] = filterList(k, v, st); continue; }
        if (v !== null && typeof v === 'object') work.push([v, node === msg && k === 'result']);
      }
    }
    if (isObj(msg.result)) {
      for (const k of LISTINGS) {
        if (!Object.hasOwn(msg.result, k)) continue;
        const list = msg.result[k];
        if (!Array.isArray(list)) throw refuse('unparseable_frame', 'a listing in the upstream response is malformed', 502);
        st.listing = k; st.before = list.length;
        msg.result[k] = filterList(k, list, st);
        st.after = msg.result[k].length;
      }
    }
    stats.frames.push(st);
    messages.push(msg);
    return msg;
  };
  const filterList = (k, list, st) => {
    const kept = list.filter((it) => isObj(it) && typeof (k === 'resources' ? it.uri : it.name) === 'string' && keep(k, it));
    for (const it of list) if (!kept.includes(it)) { const n = isObj(it) ? (it.name ?? it.uri) : null; if (typeof n === 'string') st.hidden.push(n); }
    return kept;
  };
  let outBody;
  if (type === 'application/json') {
    let parsed; try { parsed = JSON.parse(body.toString('utf8')); } catch { throw refuse('unparseable_frame', 'the upstream body is not JSON', 502); }
    if (Array.isArray(parsed)) parsed = parsed.map((m, i) => filterMessage(m, i, 'response')); else parsed = filterMessage(parsed, 0, 'response');
    outBody = Buffer.from(JSON.stringify(parsed));
  } else if (type === 'text/event-stream') {
    // Decode the WHOLE body first (a multi-byte character split between two pieces would otherwise be mangled), then feed the text in small pieces: a frame split anywhere still parses.
    const p = new SseParser(); const text = body.toString('utf8'); const out = []; let idx = 0;
    for (let i = 0; i < text.length; i += 31) p.push(text.slice(i, i + 31));
    p.end();
    for (const f of p.take()) {
      if (f.comment) { stats.frames.push({ index: idx++, kind: 'comment' }); continue; }
      if (f.data === '') continue;
      let msg; try { msg = JSON.parse(f.data); } catch { throw refuse('unparseable_frame', 'a frame in the upstream stream is not JSON', 502); }
      const isNote = isObj(msg) && typeof msg.method === 'string' && msg.id === undefined;
      const m = filterMessage(msg, idx++, isNote ? 'notification' : 'response');
      out.push(`event: ${f.event}\ndata: ${JSON.stringify(m)}\n\n`);
    }
    outBody = Buffer.from(out.join(''));
  } else throw refuse('unsupported_content_type', 'the upstream used a content type the lab does not filter, so the response was refused rather than passed through', 502);
  // Fail closed: a response that yields no message at all (every frame dropped: a byte-order mark before "data:", "DATA:" in capitals ...) is refused, never passed on empty.
  if (!messages.length) throw refuse('unparseable_frame', 'the upstream response carried no message the lab could read, so it was refused', 502);
  // A name hidden from a listing must not survive ANYWHERE else in the response (a notification, error data, structured content, _meta ...): if one does, the whole response is refused.
  const hidden = stats.frames.flatMap((f) => f.hidden || []).filter((n) => typeof n === 'string' && n.length >= 2);
  if (hidden.length) {
    const blob = JSON.stringify(messages);
    for (const n of hidden) if (blob.includes(JSON.stringify(n).slice(1, -1))) throw refuse('hidden_name_in_frame', 'the upstream response carried a name the caller may not see outside a listing, so the whole response was refused', 502);
  }
  const gz = enc === 'gzip';
  return { headers: { 'content-type': type, ...(gz ? { 'content-encoding': 'gzip' } : {}) }, chunks: splitChunks(gz ? zlib.gzipSync(outBody) : outBody), stats, messages };
}

// What the client does with the wire it finally receives: decode and parse, no filtering. Used to show the agent's view and by the tests.
export function readWire(wire) {
  return filterWire(wire, () => true).messages;
}
