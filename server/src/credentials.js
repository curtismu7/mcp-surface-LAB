// Credential-shaped text. Anything a visitor types that looks like a token, a key, a password or key material is masked on the way IN
// (reason, comment) so the raw value never enters state, a receipt, an outbox entry, a hop pane, a log line or an error.
// Lab-written detectors; linear patterns only (no nested quantifiers), run on input capped at MAX_FREE characters.
export const MAX_FREE = 400;

const D = (id, re) => ({ id, re });
// Lab-written, heuristic detectors: they catch the common shapes, plain-language passwords and keys of 20 characters or more. Not every secret has a
// recognisable shape (a short random password with no keyword before it is not found), and the page says so.
export const DETECTORS = [
  D('private-key', /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[^]{0,4000}?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g),
  D('url-userinfo', /\b[a-zA-Z][a-zA-Z0-9+.-]{1,20}:\/\/[^/\s:@]{1,100}:[^@\s]{1,200}@/g),
  // user:password@host with no scheme ("admin:pw@db.example", "//admin:pw@db.example"). mailto: is an address, not a login. An address typed as "To:bob@x.example"
  // is masked too: the false positive is accepted, the miss is not.
  D('userinfo-bare', /\b(?!mailto:)[A-Za-z0-9._~%+-]{1,64}:[^@\s/]{1,200}@(?=[A-Za-z0-9])/g),
  D('github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{6,}|github_pat_[A-Za-z0-9_]{6,})/g),
  D('gitlab-token', /\bglpat-[A-Za-z0-9_-]{6,}/g),
  D('slack-token', /\bxox[abprs]-[A-Za-z0-9-]{6,}/g),
  D('aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g),
  D('google-token', /\b(?:ya29\.[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,})/g),
  D('api-key', /\bsk-[A-Za-z0-9_-]{8,}/g),
  D('jwt', /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g),
  D('bearer', /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{10,}/gi),
  // "token abcdef1234567890" (an Authorization header): the word needs a digit, so "token requirements" is left alone
  D('token-word', /\btoken\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,}/gi),
  // a passphrase is several words: take the next four
  D('passphrase', /\bpassphrase\s*(?:[:=]|\bis\b)\s*\S+(?:[ \t]+\S+){0,3}/gi),
  // The value stops before a second keyword with its own : or = (in minified JSON `"pw: x","pw: x"` has no space, so one greedy run would swallow the
  // second keyword and leave ITS value showing). Each keyword then gets its own span.
  // A quote may sit between the keyword and the colon (JSON: {"password":"x"}).
  D('assignment', /\b(?:password|passwd|pwd|pw|pass|secret(?:[ _-]?key)?|token|api[_-]?key|apikey|client[_-]?secret|private[_-]?key|access[_-]?key|account[_-]?key|session[_-]?id|sessionid|credential)s?["']?\s*(?:[:=]|\bis\b)\s*(?:(?!\b(?:password|passwd|pwd|pw|pass|secret(?:[ _-]?key)?|token|api[_-]?key|apikey|client[_-]?secret|private[_-]?key|access[_-]?key|account[_-]?key|session[_-]?id|sessionid|credential)s?["']?\s*[:=])\S){3,}/gi),
  // A keyword followed by a space and a value ("password hunter2xyz", "pw Tr0ub4dor", "api key abc123def"): the value is taken when it is 6 or more characters
  // long and holds a digit, which keeps "password reset" and "token requirements" readable. Heuristic with a known tradeoff: "token 2026-11-02" is masked, and a
  // value with no digit ("password Hunter") is not.
  D('keyword-space', /\b(?:password|passwd|passphrase|pwd|pw|pass|secret(?:[ _-]?key)?|token|credentials?|api[ _-]?key|apikey|client[ _-]?secret|private[ _-]?key|access[ _-]?key|account[ _-]?key|session[ _-]?id|sessionid)s?["']?\s+(?=\S*\d)\S{6,}/gi),
  // "the key is X1234567", "key: X1234567"
  D('key-is', /\bkey["']?\s*(?:[:=]|\bis\b)\s*(?=\S*\d)\S{6,}/gi),
  // A long run of key characters. Two detectors, both checked in code rather than with a look-ahead (to stay linear): a run of 20 or more of
  // letters, digits, _ and - that has both a letter and a digit (or is 32 or more and is not just lowercase words joined by hyphens), and a run of 32 or
  // more that also uses + / = (base64) unless it is a lowercase path such as a URL path.
  { id: 'key-like', generic: true, re: /[A-Za-z0-9_-]{20,}/g, accept: (m) => (/\d/.test(m) && /[A-Za-z]/.test(m)) || (m.length >= 32 && !/^[a-z]+(?:-[a-z]+)+$/.test(m)) },
  { id: 'long-blob', generic: true, re: /[A-Za-z0-9+/_=-]{32,}/g, accept: (m) => !/^[a-z0-9._-]+(?:\/[a-z0-9._-]+)+$/.test(m) && !/^[a-z]+(?:-[a-z]+)+$/.test(m) },
];

const MAX_SCAN = 200000;
const SEPARATOR = /[\t\n\r\u2028\u2029]/;
const SPECIFIC = DETECTORS.filter((d) => !d.generic);
const scan = (t, detectors) => {
  const spans = [];
  for (const d of detectors) { d.re.lastIndex = 0; for (const m of t.matchAll(d.re)) if (!d.accept || d.accept(m[0])) spans.push({ start: m.index, end: m.index + m[0].length, id: d.id }); }
  return spans;
};
// Spans { start, end, id } of every credential-shaped run in the text. TAB, LF, CR and U+2028/2029 are separators (a space between words) and are ALSO tried
// deleted ("pass<LF>word=x" is a password assignment once the break is gone); a span found that way covers the original range, separators included.
export function findCredentials(text, { generic = true, all = false } = {}) {
  const t = all ? String(text) : String(text).slice(0, MAX_SCAN); // `all`: the response mask looks at every character it sends
  const spans = scan(t, generic ? DETECTORS : SPECIFIC);
  if (SEPARATOR.test(t)) {
    let joined = ''; const at = [];
    for (let i = 0; i < t.length; i++) { const c = t[i]; if (c === '\t' || c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') continue; joined += c; at.push(i); }
    for (const s of scan(joined, SPECIFIC)) spans.push({ start: at[s.start], end: at[s.end - 1] + 1, id: s.id });
  }
  return spans;
}

export function maskSpans(text, spans) {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start || b.end - a.end);
  let out = ''; let at = 0;
  for (const s of sorted) { if (s.start < at) { at = Math.max(at, s.end); continue; } out += `${text.slice(at, s.start)}[masked:${s.id}]`; at = s.end; }
  return out + text.slice(at);
}

// Percent-encoded text ("my%20password%20is%20...", "https%3A%2F%2Fu%3Apw%40host", double-encoded too) is decoded (bounded: three rounds) before matching, so
// an encoded secret is masked, and what is returned is the DECODED and masked text, never the encoded original.
const PCT = /%[0-9A-Fa-f]{2}/;
export function decodePercent(text) {
  let t = String(text);
  for (let i = 0; i < 3 && PCT.test(t); i++) { try { const d = decodeURIComponent(t); if (d === t) break; t = d; } catch { break; } }
  return t;
}
export function maskText(input) {
  const text = stripInvisible(String(input)); // invisible and control characters are deleted first, so they cannot split a keyword
  return text ? maskSpans(text, findCredentials(text)) : text;
}

// Free text from the visitor: zero-width, bidi AND control characters DELETED (so a token cannot be hidden by interleaving them: "p<U+0001>assword" is
// "password"), credential-shaped runs masked, whitespace (TAB, LF, CR, U+2028/2029 included) collapsed to one space, and only THEN cut to length (a token that
// straddles the cut is masked, not half shown).
// Every character that renders as nothing (default-ignorable: Hangul fillers, variation selectors, tag characters, combining grapheme joiner, Mongolian vowel
// separator ...), every format character (zero-width, bidi, soft hyphen), the replacement character and every C0/C1 control except TAB, LF and CR: deleted.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\uFFFD]/gu;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
export const stripInvisible = (text) => String(text).normalize('NFKC').replace(INVISIBLE, '').replace(CONTROLS, ''); // fullwidth look-alikes become the ASCII they imitate
export function cleanFree(value, max = MAX_FREE) {
  const flat = stripInvisible(String(value ?? '').slice(0, MAX_SCAN));
  const decoded = PCT.test(flat) ? stripInvisible(decodePercent(flat)) : flat; // a decoded %01 is a control character too
  const text = decoded !== flat && findCredentials(decoded).length ? decoded : flat;
  return maskText(text).replace(/\s+/g, ' ').trim().slice(0, max);
}
