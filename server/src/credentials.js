// Visitor free text. The detection is the shared masker's (mask.js -> shared/mask.js); this module only shapes what the lab stores and shows:
// cleanFree masks the WHOLE text first, then turns control and bidi-override characters into spaces, collapses white space and cuts to length (a secret that straddles the
// cut is masked, never half shown). The old names stay so no call site changes.
import { maskText } from './mask.js';
import { maskText as sharedMaskText } from './shared/mask.js';

export { maskText }; // the name the lab's tests and call sites import from here

export const MAX_FREE = 400;

// Stored text is shaped AFTER masking, and shaping never joins what the masker left apart: a control character (C0 and C1, TAB, LF and CR included) and a bidi
// override or isolate (U+202A to U+202E, U+2066 to U+2069) become a space, so none can split a word or reorder the text on screen; every other character is kept as typed.
// Zero-width and other format characters are NOT deleted: a deleted character would glue "h", "u", "n" ... back into a word the masker had no reason to mask
// (shared-masker corpus row L2146: a value hidden by zero-width spaces after a masked assignment).
const HOSTILE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
export const tidy = (text, max) => String(text).replace(HOSTILE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function cleanFree(value, max = MAX_FREE) {
  return tidy(maskText(String(value ?? '')), max); // mask the full text, then shape it
}

// The credential-shaped runs in the text, as [{ id }] (the detector of each); empty when there are none. Spans are not reported: callers use the count or the id.
export function findCredentials(text) {
  const ids = [];
  sharedMaskText(String(text), { mark: (id) => { ids.push({ id }); return `[masked:${id}]`; } });
  return ids;
}
