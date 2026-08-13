// AIProvider implementation with zero external dependency and zero cost —
// the guaranteed default (see aiProviders/index.js: AI_PROVIDER=local always
// resolves here today, since the Ollama provider's generation logic isn't
// implemented until a later phase). Pure regex/heuristic extraction, no
// network call, no model.
//
// This is deliberately NOT a general-purpose natural-language understander.
// It can only recognize a narrow set of common phrasings ("from X to Y",
// "search for/an API to <task>", an explicit site name after "on"/"at"). Per
// the product requirement to never claim false confidence, anything it
// can't confidently extract is left with a low/zero confidence score rather
// than guessed — nlIntentParser.js's sanitizeIntent already turns that into
// a "needs confirmation" state for the caller, so this provider doesn't need
// its own separate low-confidence signalling mechanism.
const TASK_PREFIX_PATTERN = /^\s*(please\s+)?(make|create|build|generate)\s+(me\s+)?(an|a)\s+api\s+(to|for|that)\s+/i;

// "from Dhaka to Dubai" -> origin=Dhaka, destination=Dubai. Deliberately
// requires both "from" and "to" together (not a bare "to Dubai") so this
// only fires on the one phrasing it can extract reliably; a bare "to
// <place>" is handled separately below as a single destination-only param.
const FROM_TO_PATTERN = /\bfrom\s+([A-Za-z][A-Za-z\s]{1,40}?)\s+to\s+([A-Za-z][A-Za-z\s]{1,40}?)(?=[.,!?]|\s+(?:on|using|via|for|with|and)\b|$)/i;

// Only matches when there was no "from ... to ..." above (checked by the
// caller) — e.g. "flights to Dubai" with no stated origin.
const BARE_TO_PATTERN = /\bto\s+([A-Za-z][A-Za-z\s]{1,40}?)(?=[.,!?]|\s+(?:on|using|via|for|with|and)\b|$)/i;

// A bare domain-like token (site.tld) anywhere in the command is the only
// site signal this provider trusts even a little — everything else (a
// plain site NAME with no domain, e.g. "on FlightRadar") is real-world
// ambiguous enough (which FlightRadar? .com? a rebrand?) that guessing a URL
// for it would be pretending to a certainty this provider doesn't have.
const DOMAIN_PATTERN = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,})\b/i;
const NAMED_SITE_PATTERN = /\bon\s+([A-Z][A-Za-z0-9][\w.-]{1,40})\b/;

const MAX_PARAM_VALUE_WORDS = 6;

const cleanupPhrase = (raw) => String(raw || '').trim().replace(/\s+/g, ' ');

const toTitleCase = (raw) => cleanupPhrase(raw)
  .split(' ')
  .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word))
  .join(' ');

const isPlausibleValue = (raw) => {
  const cleaned = cleanupPhrase(raw);
  return cleaned.length > 0 && cleaned.split(' ').length <= MAX_PARAM_VALUE_WORDS;
};

const extractTask = (nlCommand) => {
  const withoutPrefix = nlCommand.replace(TASK_PREFIX_PATTERN, '').trim();
  const task = withoutPrefix || nlCommand.trim();
  return task.charAt(0).toUpperCase() + task.slice(1);
};

const extractParameters = (nlCommand) => {
  const parameters = [];

  const fromTo = nlCommand.match(FROM_TO_PATTERN);
  if (fromTo && isPlausibleValue(fromTo[1]) && isPlausibleValue(fromTo[2])) {
    parameters.push({ name: 'origin', type: 'text', value: toTitleCase(fromTo[1]), label: 'Origin', description: 'Starting point extracted from the command.' });
    parameters.push({ name: 'destination', type: 'text', value: toTitleCase(fromTo[2]), label: 'Destination', description: 'Destination extracted from the command.' });
    return parameters;
  }

  const bareTo = nlCommand.match(BARE_TO_PATTERN);
  if (bareTo && isPlausibleValue(bareTo[1])) {
    parameters.push({ name: 'destination', type: 'text', value: toTitleCase(bareTo[1]), label: 'Destination', description: 'Destination extracted from the command.' });
  }

  return parameters;
};

const extractTargetSite = (nlCommand) => {
  const domainMatch = nlCommand.match(DOMAIN_PATTERN);
  if (domainMatch) {
    const domain = domainMatch[1].toLowerCase();
    return { name: domain, url: `https://${domain}`, confidence: 0.6 };
  }

  const namedMatch = nlCommand.match(NAMED_SITE_PATTERN);
  if (namedMatch) {
    // A bare name with no domain (e.g. "on FlightRadar") isn't enough for
    // this provider to guess a real URL for — leave url unset and keep
    // confidence low so the caller is asked to confirm rather than being
    // handed a fabricated address.
    return { name: cleanupPhrase(namedMatch[1]), confidence: 0.3 };
  }

  // Genuinely no site signal at all — sanitizeIntent already treats a
  // name-less site as zero confidence, so there's nothing extra to do here.
  return { name: '', confidence: 0 };
};

const parseIntent = async (nlCommand) => {
  const command = String(nlCommand || '');
  return {
    targetSite: extractTargetSite(command),
    task: extractTask(command),
    parameters: extractParameters(command)
  };
};

// Browser-action reasoning (V2 Phase C/D) is not implemented by this
// provider yet — Phase A only covers intent parsing.
const decideNextAction = async () => {
  throw new Error('ruleBasedProvider.decideNextAction is not implemented yet — browser agent support lands in a later phase.');
};

module.exports = { name: 'rule-based', parseIntent, decideNextAction };
