// The app's one masker: a thin adapter over the canonical shared-masker (server/src/shared/mask.js, shared-masker 1.4.0, commit 9bc664a).
// Every other module imports the masking names from here or from credentials.js; nothing else in the app detects credentials.
import { createMasker } from './shared/mask.js';

// Opaque values: things the lab mints ITSELF that look like a secret and are not one. They are recognised by their exact minted form (and, for the
// signed assertion, by their exact place), never by a key name alone: a visitor can type any key name into params, and the hop pane echoes the params,
// so a name-only rule would let a secret through under it.
//   mock-access-0001, mock-refresh-0001, mock-code-0001   the mock OAuth server's tokens (oauth.js), labelled mock, shown raw (rule 4)
//   00-<32 hex>-<16 hex>-01                               a W3C traceparent minted by trace.js (a valid incoming header is parsed, never continued)
//   traceId (the answer's top level)                      the 32-hex trace id of that traceparent
//   result.mockToken                                      the mock-issued assertion of the pass-through lab, signed with a throwaway local key
const MINTED_TOKEN = /^mock-(?:access|refresh|code)-\d{4}$/;
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const isMinted = (key, path, value) => typeof value === 'string' && (MINTED_TOKEN.test(value) || TRACEPARENT.test(value) || (path === 'traceId' && TRACE_ID.test(value)) || (path === 'result.mockToken' && key === 'mockToken'));

// Answers: state, hops, results, errors. The key name classifies a value (strong keys), except in the credentials panel of the state: that object is
// built by the lab (mode names, defect names, counters, the issuer URL), and its parent key is the word "credentials". Visitor text inside it is still
// masked as text.
const masker = createMasker({ opaque: isMinted, pathRules: [{ match: /^state\.credentials(\.|$)/, keyMode: 'none' }] });

// The story (GET /api/story) is lab-authored prose and data, never visitor input: key names are not read, and two fields that are public by design are opaque:
// the RFC 7636 appendix B example PKCE pair, and the sample OpenAPI document (it names an apiKey scheme and holds no key).
const storyMasker = createMasker({ keyMode: 'none', pathRules: [{ match: /^(pkce\.(verifier|challenge)|sampleSpec)$/, opaque: true }] });

export const { maskText, maskDeep, looksLikeCredential, isCredentialId } = masker;
export const maskStory = storyMasker.maskDeep;
export const maskResponseText = maskText; // the name the response mask and its tests used before the shared masker
