// Heuristic detector for pages the AI API Creator's browser agent (V2 Phase
// 2, not yet built) must NOT attempt to automate through: CAPTCHA/bot
// challenges, and authentication/login walls. Per the explicit product
// requirement, the agent must fail gracefully and tell the user why rather
// than ever attempting to bypass one of these — this module exists to give
// the agent loop a cheap, generic (no per-site rules) way to recognize that
// situation and stop.
//
// Split into a pure classifier (classifySignals) and a thin Playwright
// wrapper (detectPageBlock) that only gathers signals — same shape as
// dynamicValueDetector.classifyValueText, which is pure and unit-testable
// without a browser. Deliberately conservative about login-wall detection
// (a password field alone is common as a header widget on many ordinary
// pages) but intentionally a little eager about CAPTCHA/bot-challenge
// detection, since the cost of a false positive (the agent stops and reports
// "this site looks protected") is far lower than the cost of a false
// negative (the agent silently proceeds against a page it can't actually
// act on, or worse, attempts to solve a challenge).
const CAPTCHA_TEXT_PATTERN = /verify you are human|i'm not a robot|complete the captcha|prove you are human|solve the puzzle to continue/i;
const BOT_CHALLENGE_TEXT_PATTERN = /just a moment|checking your browser|attention required|access denied|are you a human\?|please wait while we verify|unusual traffic|automated (queries|requests)/i;
const LOGIN_WALL_URL_PATTERN = /\b(login|signin|sign-in|log-in|auth)\b/i;
const LOGIN_WALL_TEXT_PATTERN = /log ?in to continue|sign ?in to continue|please log ?in|create an account to continue|you must be logged in/i;

const REASONS = Object.freeze({
  CAPTCHA: 'captcha',
  BOT_CHALLENGE: 'bot_challenge',
  LOGIN_WALL: 'login_wall',
  NONE: 'none'
});

// Pure — takes plain signal data (never a Playwright object), so this can be
// unit-tested with hand-built fixtures and reused identically by both a live
// page check and, later, a recorded-workflow health check if useful.
const classifySignals = (signals = {}) => {
  const {
    url = '',
    title = '',
    bodyText = '',
    hasCaptchaIframe = false,
    hasChallengeMarkup = false,
    passwordFieldCount = 0
  } = signals;

  const haystack = `${title}\n${bodyText}`;
  const matchedSignals = [];

  if (hasCaptchaIframe) matchedSignals.push('captcha_iframe');
  if (CAPTCHA_TEXT_PATTERN.test(haystack)) matchedSignals.push('captcha_text');
  if (hasCaptchaIframe || CAPTCHA_TEXT_PATTERN.test(haystack)) {
    return {
      blocked: true,
      reason: REASONS.CAPTCHA,
      message: 'This page is showing a CAPTCHA challenge. ForgeFlow does not attempt to solve CAPTCHAs, so automation was stopped here.',
      matchedSignals
    };
  }

  if (hasChallengeMarkup) matchedSignals.push('challenge_markup');
  if (BOT_CHALLENGE_TEXT_PATTERN.test(haystack)) matchedSignals.push('bot_challenge_text');
  if (hasChallengeMarkup || BOT_CHALLENGE_TEXT_PATTERN.test(haystack)) {
    return {
      blocked: true,
      reason: REASONS.BOT_CHALLENGE,
      message: 'This site appears to be showing an anti-bot/security check instead of its normal page. ForgeFlow does not attempt to bypass these, so automation was stopped here.',
      matchedSignals
    };
  }

  // Password field alone is common (header login widgets on ordinary
  // pages), so it only counts as an actual login wall when corroborated by
  // the URL or page text also looking like a dedicated login/auth screen —
  // otherwise nearly every site would false-positive.
  const looksLikeLoginScreen = LOGIN_WALL_URL_PATTERN.test(url) || LOGIN_WALL_TEXT_PATTERN.test(haystack);
  if (passwordFieldCount > 0 && looksLikeLoginScreen) {
    matchedSignals.push('password_field', looksLikeLoginScreen ? 'login_context' : null);
    return {
      blocked: true,
      reason: REASONS.LOGIN_WALL,
      message: 'This page requires logging in before continuing. ForgeFlow does not attempt to authenticate on the user\'s behalf, so automation was stopped here.',
      matchedSignals: matchedSignals.filter(Boolean)
    };
  }

  return { blocked: false, reason: REASONS.NONE, message: null, matchedSignals: [] };
};

// Runs entirely inside the page via page.evaluate — no Node/Playwright APIs
// reachable here, matching the pattern already established by
// backend/services/extraction/domExtractor.js and pageSnapshotBuilder.js.
const collectSignalsInPage = () => {
  const bodyText = (document.body ? document.body.innerText : '').slice(0, 4000);
  const hasCaptchaIframe = Array.from(document.querySelectorAll('iframe[src]')).some((frame) => (
    /recaptcha|hcaptcha|turnstile|captcha/i.test(frame.getAttribute('src') || '')
  ));
  const hasChallengeMarkup = Boolean(
    document.querySelector('#challenge-form, #challenge-stage, [class*="cf-challenge"], [class*="cf-turnstile"], [id*="challenge-running"]')
  );
  const passwordFieldCount = Array.from(document.querySelectorAll('input[type="password"]'))
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).length;

  return {
    url: window.location.href,
    title: document.title,
    bodyText,
    hasCaptchaIframe,
    hasChallengeMarkup,
    passwordFieldCount
  };
};

// Gathers signals from a live Playwright page and classifies them. Read-only
// — takes no action on the page.
const detectPageBlock = async (page) => {
  const signals = await page.evaluate(collectSignalsInPage);
  return classifySignals(signals);
};

module.exports = { detectPageBlock, classifySignals, REASONS };
