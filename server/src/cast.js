// {{token}} templating for the story and the seeded world. customer.config.json (optional, git-ignored) overrides brand, host and the first user.
// Tokens are filled from one of three vertical packs. A test fails on any token a pack does not define.
// Every person, agent, application and host in a pack is synthetic: only .example hosts, no real company, tenant or account.
import fs from 'node:fs';
import { scanHosts } from './safety.js';

const TOKEN = /\{\{(\w+)\}\}/g;
const MAX_CAST = 40;
const ID = /^[a-z0-9.-]{1,40}$/;

export const VERTICALS = {
  finance: {
    castBrand: 'Fabrikam Bank', castHost: 'fabrikam', castAdmin: 'priya.nair', castAdmin2: 'lee.park', castUser: 'maya.chen', castUser2: 'omar.reyes',
    castOutsider: 'sam.jones', castTeam: 'payments-platform', castAgent: 'recon-bot', castApi: 'invoices', castTenant2: 'contractco',
    castApp1: 'ledger', castApp2: 'payments', castApp3: 'cases', castApp4: 'archive', castApp5: 'legacy-core', castMissing: 'treasury-old',
  },
  health: {
    castBrand: 'Contoso Health', castHost: 'contoso', castAdmin: 'grace.liu', castAdmin2: 'kofi.mensah', castUser: 'lena.ortiz', castUser2: 'tariq.hassan',
    castOutsider: 'noah.becker', castTeam: 'clinical-platform', castAgent: 'intake-bot', castApi: 'referrals', castTenant2: 'locumco',
    castApp1: 'records', castApp2: 'claims', castApp3: 'triage', castApp4: 'imaging', castApp5: 'legacy-ehr', castMissing: 'pharmacy-old',
  },
  retail: {
    castBrand: 'Northwind Retail', castHost: 'northwind', castAdmin: 'olu.adeyemi', castAdmin2: 'anna.berg', castUser: 'diego.ruiz', castUser2: 'hana.sato',
    castOutsider: 'mia.kowalski', castTeam: 'commerce-platform', castAgent: 'stock-bot', castApi: 'orders', castTenant2: 'seasonalco',
    castApp1: 'stock', castApp2: 'checkout', castApp3: 'returns', castApp4: 'loyalty', castApp5: 'legacy-pos', castMissing: 'pricing-old',
  },
};
export const DEFAULT_VERTICAL = 'finance';
export const DEFAULT_CAST = VERTICALS[DEFAULT_VERTICAL];

export const unfilled = (text, cast) => [...String(text).matchAll(TOKEN)].map((m) => m[1]).filter((k) => !Object.hasOwn(cast, k));
export const fill = (text, cast) => String(text).replace(TOKEN, (m, k) => (Object.hasOwn(cast, k) ? cast[k] : m));
// Iterative, so a deep structure cannot overflow the stack.
export function fillDeep(value, cast) {
  const clone = (x) => (Array.isArray(x) ? [] : x && typeof x === 'object' ? {} : x);
  const outRoot = { v: clone(value) };
  const work = [[value, outRoot, 'v']];
  while (work.length) {
    const [src, dst, key] = work.pop();
    if (typeof src === 'string') { dst[key] = fill(src, cast); continue; }
    if (src === null || typeof src !== 'object') { dst[key] = src; continue; }
    const copy = clone(src);
    dst[key] = copy;
    for (const k of Object.keys(src).reverse()) work.push([src[k], copy, k]);
  }
  return outRoot.v;
}

export const verticalFrom = (id) => (typeof id === 'string' && Object.hasOwn(VERTICALS, id) ? id : DEFAULT_VERTICAL);

// Only brand, host and the first user, as short plain strings; anything else in the file is ignored. The user must not collide with another person in the pack.
export function loadCast(file, vertical = DEFAULT_VERTICAL) {
  const cast = { ...VERTICALS[verticalFrom(vertical)] };
  if (!file) return cast;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [short, key] of [['brand', 'castBrand'], ['user', 'castUser'], ['host', 'castHost']]) {
      const v = cfg?.cast?.[short];
      if (typeof v !== 'string' || !v.trim()) continue;
      const clean = v.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').trim().slice(0, MAX_CAST);
      if (/:\/\/|@/.test(clean) || scanHosts(clean).length) continue;
      if (short !== 'brand' && !ID.test(clean.toLowerCase())) continue;
      if (short === 'host' && clean.includes('.')) continue;
      const val = short === 'brand' ? clean : clean.toLowerCase();
      if (short === 'user' && Object.entries(cast).some(([k, x]) => k !== 'castUser' && x === val)) continue;
      cast[key] = val;
    }
  } catch { /* no file or not JSON: the defaults */ }
  return cast;
}
