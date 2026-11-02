// Visitor free text. The detection is the shared masker's (mask.js -> shared/mask.js); this module only shapes what the lab stores and shows:
// cleanFree masks the WHOLE text first, then deletes invisible characters, collapses white space and cuts to length (a secret that straddles the
// cut is masked, never half shown). The old names stay so no call site changes.
import { maskText } from './mask.js';
import { maskText as sharedMaskText } from './shared/mask.js';

export { maskText }; // the name the lab's tests and call sites import from here

export const MAX_FREE = 400;

// Characters that render as nothing (default-ignorable, format, replacement) and every C0/C1 control except TAB, LF and CR: deleted from stored text.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\uFFFD]/gu;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
export const tidy = (text, max) => String(text).replace(INVISIBLE, '').replace(CONTROLS, '').replace(/\s+/g, ' ').trim().slice(0, max);

export function cleanFree(value, max = MAX_FREE) {
  return tidy(maskText(String(value ?? '')), max); // mask the full text, then shape it
}

// The credential-shaped runs in the text, as [{ id }] (the detector of each); empty when there are none. Spans are not reported: callers use the count or the id.
export function findCredentials(text) {
  const ids = [];
  sharedMaskText(String(text), { mark: (id) => { ids.push({ id }); return `[masked:${id}]`; } });
  return ids;
}
