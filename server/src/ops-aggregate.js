// Configuring the aggregate: members (an application reference, an alias, a tool filter) and the aggregate's own policy, which is the cap.
import { refuse } from './errors.js';
import { NAME_RE, isObj, safeId, take } from './util.js';
import { LIMITS } from './engine.js';

export const aggregateOps = {
  // Names the aggregate policy mentions whose alias is no longer a member's alias: they match nothing (measured, AI-DEMO2 note: a renamed alias made the
  // existing grant stop matching until the tools were selected again).
  staleGrantNames(agg) {
    const aliases = new Set(agg.members.map((m) => this.aliasOf(m)));
    return agg.policy.grants.flatMap((g) => g.tools).filter((n) => n !== '*' && !aliases.has(n.slice(0, n.indexOf('__')))).length;
  },
  aggSetMember(p) {
    take(p, ['actor', 'aggregateId', 'refId', 'alias', 'toolFilter'], ['actor', 'aggregateId', 'refId']);
    const a = this.admin(p.actor); const agg = this.aggOf(p.aggregateId);
    const refId = safeId(p.refId, NAME_RE, 32);
    if (!refId) throw refuse('bad_ref', 'an application reference is a lowercase name');
    let m = agg.members.find((x) => x.appRef.RefID === refId);
    const adding = !m;
    if (adding && agg.members.length >= LIMITS.members) throw refuse('too_many_members', `an aggregate holds at most ${LIMITS.members} members`, 409);
    let alias = m ? m.alias : '';
    if (p.alias !== undefined) {
      if (p.alias === '') alias = '';
      else { alias = safeId(p.alias, NAME_RE, 32); if (!alias) throw refuse('bad_alias', 'an alias is lowercase letters, digits and hyphens, starting with a letter (no underscores, so the "__" separator is unambiguous)'); }
    }
    const effective = alias || refId;
    if (agg.members.some((x) => x !== m && this.aliasOf(x) === effective)) throw refuse('alias_collision', 'another member already uses this alias: identical tool names would collide', 409);
    let filter = m ? m.toolFilter : { Elems: [] };
    if (p.toolFilter !== undefined) {
      take(p.toolFilter, ['Elems'], ['Elems']);
      const el = p.toolFilter.Elems;
      if (!Array.isArray(el) || el.length > 20) throw refuse('bad_filter', 'ToolFilter.Elems is an array of at most 20 tool names');
      if (el.length) {
        const app = Object.hasOwn(this.apps, refId) ? this.apps[refId] : null;
        if (!app) throw refuse('member_missing', 'the member application does not exist, so a tool filter cannot be checked', 404);
        for (const x of el) if (typeof x !== 'string' || !app.tools.some((t) => t.name === x)) throw refuse('bad_filter', 'the filter names a tool the member does not have (bare names, no prefix)');
      }
      filter = { Elems: [...new Set(el)] };
    }
    if (adding) { m = { appRef: { RefKind: 'application', RefID: refId }, alias, toolFilter: filter }; agg.members.push(m); } else { m.alias = alias; m.toolFilter = filter; }
    this.record(adding ? 'aggregate.member.added' : 'aggregate.member.changed', { actor: a.id, aggregate: agg.id, member: refId, alias: effective });
    return { aggregate: agg.id, member: refId, alias: effective, staleGrants: this.staleGrantNames(agg) };
  },
  aggRemoveMember(p) {
    take(p, ['actor', 'aggregateId', 'refId'], ['actor', 'aggregateId', 'refId']);
    const a = this.admin(p.actor); const agg = this.aggOf(p.aggregateId);
    const i = typeof p.refId === 'string' ? agg.members.findIndex((x) => x.appRef.RefID === p.refId) : -1;
    if (i < 0) throw refuse('unknown_member', 'unknown member', 404);
    agg.members.splice(i, 1);
    this.record('aggregate.member.removed', { actor: a.id, aggregate: agg.id });
    return { aggregate: agg.id, members: agg.members.length, staleGrants: this.staleGrantNames(agg) };
  },
  aggSetPolicy(p) {
    take(p, ['actor', 'aggregateId', 'grants'], ['actor', 'aggregateId', 'grants']);
    const a = this.admin(p.actor); const agg = this.aggOf(p.aggregateId);
    const names = new Set();
    for (const m of agg.members) { const app = this.resolve(m); if (app) for (const t of app.tools) names.add(`${this.aliasOf(m)}__${t.name}`); }
    agg.policy = { grants: this.checkGrants(p.grants, { known: { tools: names, prompts: new Set(), resources: new Set() }, aggregate: true }) };
    this.record('aggregate.policy', { actor: a.id, aggregate: agg.id, grants: agg.policy.grants.length });
    return { aggregate: agg.id, grants: agg.policy.grants.length };
  },
};
export { isObj };
