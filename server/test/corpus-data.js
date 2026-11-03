// The shared-masker corpora (copied from shared-masker 1.4.0, test/corpus). Each probe is an array of short fragments, joined at run time.
import { readFileSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`./corpus/${name}`, import.meta.url), 'utf8'));
export const leaks = read('leaks.json');
export const ordinary = read('ordinary.json');
export const join = (a) => a.join('');
export const expand = (row) => `${row.fillBefore ? `${'a'.repeat(row.fillBefore)} ` : ''}${join(row.input)}${row.fillAfter ? ` ${'a'.repeat(row.fillAfter)}` : ''}`;
