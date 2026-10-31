import crypto from 'node:crypto';
import { BASE_EPOCH } from './world.js';
export const iso = (t) => `${new Date((BASE_EPOCH + t) * 1000).toISOString().slice(0, 19)}Z`;
// An 8-hex fingerprint of a MOCK credential label: it shows that two values differ (or are the same) without showing any value.
export const fingerprint = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
