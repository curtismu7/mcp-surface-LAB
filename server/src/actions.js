// One dispatch for everything that changes (or reads through) an engine, used by the API, the scripted scenarios and the tests, so they cannot drift apart.
// A refusal from the engine is data ({ ok: false, status, code, detail }), never an exception; anything else is a bug and propagates.
import { InputError } from './errors.js';

// pure: true = reads nothing and changes nothing, so it also runs in Mock mode (the same parser).
const OPS = {
  mcp: (e, p) => e.mcp(p), advance: (e, p) => e.advance(p),
  setPolicy: (e, p) => e.setPolicy(p), setTransport: (e, p) => e.setTransport(p), setFault: (e, p) => e.setFault(p), setAppUp: (e, p) => e.setAppUp(p),
  aggSetMember: (e, p) => e.aggSetMember(p), aggRemoveMember: (e, p) => e.aggRemoveMember(p), aggSetPolicy: (e, p) => e.aggSetPolicy(p),
  oaPreview: { pure: true, run: (e, p) => e.oaPreview(p) }, oaDeploy: (e, p) => e.oaDeploy(p), oaRedeploy: (e, p) => e.oaRedeploy(p),
  setAuth: (e, p) => e.setAuth(p), vaultSet: (e, p) => e.vaultSet(p), upstreamAuthorize: (e, p) => e.upstreamAuthorize(p), upstreamRevoke: (e, p) => e.upstreamRevoke(p), passThrough: (e, p) => e.passThrough(p),
  catDeploy: (e, p) => e.catDeploy(p), catCrash: (e, p) => e.catCrash(p), catHealth: (e, p) => e.catHealth(p), catRedeploy: (e, p) => e.catRedeploy(p), catConfigure: (e, p) => e.catConfigure(p), catPublish: (e, p) => e.catPublish(p),
  oauthRegister: (e, p) => e.oauthRegister(p), cimdSet: (e, p) => e.cimdSet(p), cimdResolve: (e, p) => e.cimdResolve(p), oauthAuthorize: (e, p) => e.oauthAuthorize(p), oauthToken: (e, p) => e.oauthToken(p),
  propose: (e, p) => e.propose(p), amend: (e, p) => e.amend(p), decide: (e, p) => e.decide(p), setSessionLogging: (e, p) => e.setSessionLogging(p), setAgent: (e, p) => e.setAgent(p),
  route: (e, p) => e.route(p), setPinning: (e, p) => e.setPinning(p), sessionOpen: (e, p) => e.sessionOpen(p), sessionUse: (e, p) => e.sessionUse(p),
};
export const OP_NAMES = Object.keys(OPS);
export const isOp = (name) => typeof name === 'string' && Object.hasOwn(OPS, name);
export const isPure = (name) => isOp(name) && typeof OPS[name] === 'object' && OPS[name].pure === true;

export function perform(engine, op, params) {
  if (!isOp(op)) throw new Error('unknown op');
  const fn = typeof OPS[op] === 'function' ? OPS[op] : OPS[op].run;
  try { return { ok: true, result: fn(engine, params) }; }
  catch (e) { if (e instanceof InputError) return { ok: false, status: e.status, code: e.code, detail: e.message, data: e.data }; throw e; }
}
