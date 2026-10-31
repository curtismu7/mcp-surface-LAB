import { fillDeep, VERTICALS } from './cast.js';
import { BANNER, CLAIMS, CLAIM_LABEL, DISCREPANCIES, FIELD_SOURCES, LIMITS_TEXT, NOT_DEMONSTRATED, PRESENTER_TALK, RELEASE, SOURCE_NAMES, TALK_TRACK, TITLE, INTRO, WHY } from './data.js';
import { LIMITS, METHODS } from './engine.js';
import { AUTH_MODES, DEFECTS } from './ops-credentials.js';
import { CATALOG, GROUPS, LOG_LEVELS, UPSTREAMS, sampleSpec } from './world.js';
import { LIMITS as OA_LIMITS } from './openapi.js';
import { LIMITS as OAUTH_LIMITS, SCOPES } from './oauth.js';
import { STYLES } from './wire.js';
import { scenarioList, PKCE_VERIFIER, PKCE_CHALLENGE } from './scenarios.js';

export const rawStory = () => ({ title: TITLE, intro: INTRO, banner: BANNER, claims: CLAIMS, talkTrack: TALK_TRACK, why: WHY, discrepancies: DISCREPANCIES });

// The story with the cast filled in.
export function buildStory(cast, vertical) {
  const s = fillDeep(rawStory(), cast);
  return {
    title: s.title, intro: s.intro, release: RELEASE, claimLabel: CLAIM_LABEL, banner: s.banner, claims: s.claims, why: s.why,
    discrepancies: s.discrepancies, notDemonstrated: NOT_DEMONSTRATED,
    fieldSources: FIELD_SOURCES.map((f) => ({ ...f, sourceLabel: SOURCE_NAMES[f.source] })), sourceNames: SOURCE_NAMES, limitsText: LIMITS_TEXT, limits: LIMITS, openapiLimits: OA_LIMITS, oauthLimits: OAUTH_LIMITS,
    methods: METHODS, authModes: AUTH_MODES, defects: DEFECTS, groups: GROUPS, styles: STYLES, scopes: SCOPES, logLevels: LOG_LEVELS,
    catalogEntries: CATALOG.map((e) => ({ id: e.id, name: e.name, version: e.version, verified: e.verified, publisher: e.publisher, summary: e.summary })),
    upstreamTools: Object.fromEntries(Object.entries(UPSTREAMS).map(([k, u]) => [k, u.tools.map((t) => t.name)])),
    sampleSpec: JSON.stringify(sampleSpec(cast), null, 2), pkce: { verifier: PKCE_VERIFIER, challenge: PKCE_CHALLENGE, note: 'the RFC 7636 appendix B example pair' },
    cimdUrls: ['agent', 'notes', 'big', 'slow', 'wrongtype', 'redir', 'secret', 'gone', 'wild', 'unlisted'].map((n) => `https://${n}.${cast.castHost}.example/client.json`),
    scenarios: scenarioList(cast).map((sc) => ({ id: sc.id, title: sc.title, say: sc.say })),
    talkTrack: s.talkTrack, presenterTalk: PRESENTER_TALK, cast, vertical, verticals: Object.keys(VERTICALS),
  };
}

// docs/talk-track.md is generated from the same data the UI reads (`npm run talk-track`); a test fails if they drift.
export function renderTalkTrackMarkdown(cast) {
  const s = buildStory(cast, 'finance');
  const parts = ['# Talk track', '', '<!-- Generated from server/src/data.js by `npm run talk-track`. Do not edit by hand. -->', '', `> ${s.claimLabel}: every product claim here comes from the Ping ID4AI Workforce H2 2026 deck, slides 35 to 39 (release ${s.release}). Nothing here ran against a real gateway, MCP server, identity provider or tenant.`, ''];
  for (const t of s.talkTrack) parts.push(`## ${t.title}`, '', t.say, '');
  parts.push('## Where the deck and our own measured notes differ (shown, not resolved)', '');
  for (const d of s.discrepancies) parts.push(`- **${d.title}.** ${d.text}`);
  parts.push('', '## The scripted scenarios (Mock mode)', '');
  s.scenarios.forEach((sc, i) => parts.push(`${i + 1}. **${sc.title}.** ${sc.say}`));
  parts.push('', '## Not demonstrated', '');
  for (const n of s.notDemonstrated) parts.push(`- ${n}`);
  return `${parts.join('\n')}\n`;
}
