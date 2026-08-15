// Generic target-site discovery for ForgeFlow's AI browser agent.
//
// The problem this solves: nlIntentParser can extract a NAMED target
// ("Walton", "the official Samsung website", an airline, a hotel brand, …)
// while correctly leaving targetSite.url null, because the model must never
// fabricate a URL. The browser agent then has a name but nowhere to begin.
//
// This module turns a name into a *reached, verified* starting URL, entirely
// generically:
//   1. run a plain web search for the name,
//   2. rank the result links by how well they correspond to the name
//      (host-label match + title/snippet overlap + root-domain preference),
//   3. if one candidate clearly wins, navigate to it and VERIFY the live page
//      actually corresponds to the requested target,
//   4. otherwise report the outcome honestly (ambiguous / unreachable) with
//      the candidates it saw, so the caller can ask the user to clarify
//      rather than silently guessing.
//
// It contains NO list of known sites, brands, domains, categories, or tasks.
// Every signal is derived at runtime from the target NAME and the LIVE page.
// The search backend and the verification step are both injectable so tests
// run fully offline against deterministic fixtures; the defaults use the same
// Playwright page the agent already owns.
//
// Trust model (see nlIntentParser.classifyUrlSource for where a URL's source
// is decided): a URL the USER typed is authoritative and bypasses this module
// entirely; a URL the MODEL guessed is passed here as `seedUrl` and is only
// accepted if it VERIFIES against the target — it is never navigated to as if
// it were authoritative. A URL this module returns is trust level
// 'discovered': found by search AND confirmed by loading it.

const DEFAULT_SEARCH_URL_TEMPLATE = process.env.SITE_DISCOVERY_SEARCH_URL
  || 'https://duckduckgo.com/html/?q={query}';
const DISCOVERY_ENABLED = process.env.SITE_DISCOVERY_ENABLED !== 'false';
const NAV_TIMEOUT_MS = Number(process.env.SITE_DISCOVERY_TIMEOUT_MS) || 15000;

// A candidate must clear this to be pickable at all, and must beat the runner-
// up by at least AMBIGUITY_MARGIN, or the result is reported as ambiguous
// instead of a silent arbitrary pick.
const MIN_CONFIDENCE = 0.45;
const AMBIGUITY_MARGIN = 0.12;
const MAX_CANDIDATES = 10;

// Generic filler words that carry no site-identity signal — stripped from the
// target name before token matching so "the official Samsung website" and
// "Samsung" tokenize to the same identifying token(s). NOT a site list.
const NAME_STOPWORDS = new Set([
  'the', 'official', 'website', 'site', 'web', 'store', 'shop', 'online',
  'app', 'homepage', 'home', 'page', 'www', 'please', 'use', 'go', 'to',
  'on', 'a', 'an', 'of', 'for', 'and'
]);

const tokenizeName = (name) => String(name || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .split(/\s+/)
  .filter((t) => t && !NAME_STOPWORDS.has(t));

const hostOf = (url) => {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch (error) {
    return '';
  }
};

// The registrable-ish label of a host, e.g. "waltonbd.com" -> "waltonbd",
// "shop.samsung.co.uk" -> "samsung". A deliberately simple heuristic (not a
// full public-suffix list): take the label immediately left of the final
// 1–2 short suffix segments. Good enough for scoring/verification; never used
// to fabricate anything.
const registrableLabel = (host) => {
  const parts = String(host || '').split('.').filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  // Handle two-part public suffixes like co.uk / com.bd by stepping back one
  // extra segment when the second-to-last is itself a short suffix-like token.
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  const SHORT_SUFFIXES = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);
  if (parts.length >= 3 && SHORT_SUFFIXES.has(secondLast) && last.length <= 3) {
    return parts[parts.length - 3];
  }
  return secondLast;
};

const pathOf = (url) => {
  try {
    return new URL(url).pathname || '/';
  } catch (error) {
    return '/';
  }
};

// Scores a single candidate 0..1 for how likely it is to BE the named target
// (not merely mention it). Host-label identity is the dominant signal — the
// official site of "X" almost always has "x" in its registrable label — with
// title/snippet overlap and a root-path bonus as tie-breakers.
const scoreCandidate = (targetTokens, candidate) => {
  const host = hostOf(candidate.url);
  if (!host || !targetTokens.length) return 0;
  const label = registrableLabel(host);
  const title = String(candidate.title || '').toLowerCase();
  const snippet = String(candidate.snippet || '').toLowerCase();

  let hostScore = 0;
  for (const tok of targetTokens) {
    if (label === tok) hostScore = Math.max(hostScore, 1);
    else if (label.includes(tok) || tok.includes(label)) hostScore = Math.max(hostScore, 0.7);
    else if (host.includes(tok)) hostScore = Math.max(hostScore, 0.5);
  }

  const inTitle = targetTokens.filter((t) => title.includes(t)).length / targetTokens.length;
  const inSnippet = targetTokens.filter((t) => snippet.includes(t)).length / targetTokens.length;
  const path = pathOf(candidate.url);
  const rootBonus = (path === '/' || path === '') ? 0.1 : 0;

  const score = 0.6 * hostScore + 0.2 * inTitle + 0.1 * inSnippet + rootBonus;
  return Math.min(1, Math.round(score * 100) / 100);
};

// Ranks candidates for a target name, collapsing multiple results from the
// SAME host into one (they are the same site, not competing options — so two
// deep links into one store never read as "ambiguous"). Pure and
// deterministic: unit-tested directly.
const rankCandidates = (targetName, candidates) => {
  const tokens = tokenizeName(targetName);
  const bestByHost = new Map();
  for (const cand of candidates || []) {
    const host = hostOf(cand.url);
    if (!host) continue;
    const scored = { url: cand.url, title: cand.title || '', snippet: cand.snippet || '', host, score: scoreCandidate(tokens, cand) };
    const existing = bestByHost.get(host);
    if (!existing || scored.score > existing.score) bestByHost.set(host, scored);
  }
  return [...bestByHost.values()].sort((a, b) => b.score - a.score);
};

// Default search backend: drives the agent's own Playwright page to a plain
// web search and scrapes result links generically (any external http(s)
// anchor, DuckDuckGo redirect links unwrapped). Best-effort by nature — the
// whole thing is injectable so production can swap in a proper search API and
// tests inject deterministic candidates. Never throws.
const defaultSearchResults = async (query, { page }) => {
  const searchUrl = DEFAULT_SEARCH_URL_TEMPLATE.replace('{query}', encodeURIComponent(query));
  const searchHost = hostOf(searchUrl);
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } catch (error) {
    return [];
  }
  const anchors = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
    .map((a) => ({ href: a.getAttribute('href') || '', text: (a.innerText || '').trim() }))).catch(() => []);

  const seen = new Set();
  const candidates = [];
  for (const { href, text } of anchors) {
    let url = href;
    const redirect = /[?&](?:uddg|url|u)=([^&]+)/.exec(href);
    if (redirect) {
      try { url = decodeURIComponent(redirect[1]); } catch (error) { /* keep raw */ }
    }
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//i.test(url)) continue;
    const host = hostOf(url);
    if (!host || host === searchHost || seen.has(host)) continue;
    seen.add(host);
    candidates.push({ url, title: text, snippet: '' });
    if (candidates.length >= 15) break;
  }
  return candidates;
};

// Default navigator: loads a URL on the shared page and reports the URL the
// page actually ended on (following redirects). Injectable for tests.
const defaultNavigate = async (page, url) => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  return page.url();
};

// Verifies that navigating to `expectedUrl` actually lands on a page that
// CORRESPONDS to the named target, rather than a same-name-different-thing or
// an unrelated redirect. Two independent checks: the final host's registrable
// label still relates to where we meant to go (not silently bounced to an
// unrelated domain), AND the live host/title/body actually mention the target
// name. With no name to check against (a bare model-guessed URL), it can only
// confirm the page loaded — reported honestly via the reason.
const verifyDestination = async (page, { targetName, expectedUrl, navigate = defaultNavigate }) => {
  let finalUrl;
  try {
    finalUrl = await navigate(page, expectedUrl);
  } catch (error) {
    return { ok: false, url: expectedUrl, reason: `could not load the destination: ${error.message}` };
  }
  const finalHost = hostOf(finalUrl);
  if (!finalHost) return { ok: false, url: finalUrl, reason: 'destination had no resolvable host' };

  const expectedHost = hostOf(expectedUrl);
  const hostOk = finalHost === expectedHost
    || registrableLabel(finalHost) === registrableLabel(expectedHost);

  const tokens = tokenizeName(targetName);
  let title = '';
  try { title = (await page.title()) || ''; } catch (error) { /* ignore */ }
  let body = '';
  try {
    body = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 4000) : ''));
  } catch (error) { /* ignore */ }
  // Corroborate against the page's own CONTENT (title/body), NOT its host —
  // hostOk already covers "we didn't get bounced to another domain", so the
  // host label (which by construction contains the name) must not be what
  // satisfies this second, independent check.
  const haystack = `${title} ${body}`.toLowerCase();
  const nameOk = tokens.length === 0 || tokens.some((t) => haystack.includes(t));

  if (hostOk && nameOk) {
    return { ok: true, url: finalUrl, reason: tokens.length ? 'host and target name corroborated on the live page' : 'destination loaded (no name available to corroborate)' };
  }
  if (!hostOk) return { ok: false, url: finalUrl, reason: 'navigation redirected to an unrelated domain' };
  return { ok: false, url: finalUrl, reason: 'the destination page did not mention the requested target' };
};

// The main entry point. Returns one of:
//   { status: 'discovered',  url, urlTrust: 'discovered', confidence, candidates, reason }
//   { status: 'ambiguous',   candidates, confidence, reason }   // never picks
//   { status: 'unreachable', candidates, reason }
//   { status: 'disabled' | 'no_query', reason }
// and NEVER throws — discovery failing must not crash a run, only report.
const discoverTargetSite = async ({
  page,
  targetName,
  task,
  seedUrl = null,
  searchResults = defaultSearchResults,
  verify = verifyDestination,
  navigate = defaultNavigate,
  minConfidence = MIN_CONFIDENCE,
  margin = AMBIGUITY_MARGIN,
  autoSelectBest = false
} = {}) => {
  if (!DISCOVERY_ENABLED) {
    return { status: 'disabled', reason: 'site discovery is disabled by configuration' };
  }
  const name = String(targetName || '').trim();

  // 1) A model-GUESSED URL is a candidate, not an answer: try it first, but
  //    only accept it if it verifies against the target. On failure we fall
  //    through to a real search when we have a name to search for.
  if (seedUrl) {
    const seedCheck = await verify(page, { targetName: name, expectedUrl: seedUrl, navigate });
    if (seedCheck.ok) {
      return {
        status: 'discovered',
        url: seedCheck.url,
        urlTrust: 'discovered',
        confidence: 0.85,
        candidates: [{ url: seedCheck.url, host: hostOf(seedCheck.url), score: 0.85 }],
        reason: 'model-suggested URL verified against the requested target'
      };
    }
    if (!name) {
      return { status: 'unreachable', candidates: [], reason: seedCheck.reason || 'model-suggested URL did not correspond to the target' };
    }
  }

  if (!name) {
    return { status: 'no_query', reason: 'no target name available to discover from' };
  }

  // 2) Search generically for the name.
  let results = [];
  try {
    results = await searchResults(name, { page, task });
  } catch (error) {
    results = [];
  }
  const ranked = rankCandidates(name, results).slice(0, MAX_CANDIDATES);
  if (!ranked.length) {
    return { status: 'unreachable', candidates: [], reason: 'the web search returned no usable candidate sites' };
  }

  // 3) Decide.
  //
  // The minConfidence/margin gates below measure how well a candidate's HOST
  // matches an explicitly NAMED site — they exist to refuse to guess when the
  // user pointed at a specific site (a candidate that doesn't clearly match
  // the named site, or a near-tie between two plausible sites, is a real
  // ambiguity we surface rather than pick blindly).
  //
  // But when the user did NOT name a site and only described a task
  // (autoSelectBest), that name<->host confidence is the wrong gate: there is
  // no named site to match, and any candidate that actually verifies on the
  // live page fulfills the request. In that case we take the strongest-RANKED
  // candidate and let live verification (step 4) be the suitability gate
  // instead of blocking. This never lowers the threshold for a named site
  // (autoSelectBest defaults false), and never invents a site — a candidate
  // that fails to verify, or an empty search, still returns unreachable.
  const top = ranked[0];
  const second = ranked[1];
  if (!autoSelectBest) {
    if (top.score < minConfidence) {
      return { status: 'ambiguous', candidates: ranked.slice(0, 3), confidence: top.score, reason: 'no candidate strongly matched the requested target name' };
    }
    if (second && second.score >= minConfidence && (top.score - second.score) < margin) {
      return { status: 'ambiguous', candidates: ranked.slice(0, 3), confidence: top.score, reason: 'several candidate sites matched the target name about equally' };
    }
  }

  // 4) Verify the winner on the live page before committing to it.
  const check = await verify(page, { targetName: name, expectedUrl: top.url, navigate });
  if (!check.ok) {
    return { status: 'unreachable', candidates: ranked.slice(0, 3), reason: `the best candidate (${top.host}) did not verify: ${check.reason}` };
  }
  return {
    status: 'discovered',
    url: check.url,
    urlTrust: 'discovered',
    confidence: top.score,
    candidates: [top],
    reason: `discovered via web search and verified on the live page (${top.host})`
  };
};

module.exports = {
  discoverTargetSite,
  rankCandidates,
  scoreCandidate,
  verifyDestination,
  tokenizeName,
  registrableLabel,
  hostOf,
  // exported for tests / callers that want to reason about the knobs
  MIN_CONFIDENCE,
  AMBIGUITY_MARGIN
};
