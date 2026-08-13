// Single entry point every AI-touching call in ForgeFlow goes through — no
// other file requires anthropicClient, an Ollama URL, or any vendor SDK
// directly. Each provider implements the same two-method AIProvider shape:
//   parseIntent(nlCommand) -> Promise<raw proposed intent, same shape
//     nlIntentParser.js's sanitizeIntent expects — NOT pre-validated>
//   decideNextAction(snapshot, intent, history) -> Promise<one browser
//     action for the AI Creator's browser agent (not implemented by any
//     provider yet — lands in a later phase)>
//
// Selection is controlled entirely by AI_PROVIDER:
//   "local" (default) | "rule-based" -> ruleBasedProvider (zero cost, zero
//     external dependency — this is what guarantees Anthropic is never
//     required just to use the AI Creator)
//   "ollama"                          -> ollamaProvider
//   "anthropic"                       -> anthropicProvider
// There is deliberately no "auto-upgrade to Anthropic because a key is
// present" branch — using Anthropic is always an explicit choice.
const resolveConfiguredProvider = () => (process.env.AI_PROVIDER || 'local').trim().toLowerCase();

const getProvider = () => {
  const configured = resolveConfiguredProvider();

  if (configured === 'anthropic') {
    return require('./anthropicProvider');
  }
  if (configured === 'ollama') {
    return require('./ollamaProvider');
  }
  if (configured === 'rule-based' || configured === 'local') {
    return require('./ruleBasedProvider');
  }

  throw new Error(`Unknown AI_PROVIDER "${configured}". Expected one of: local, rule-based, ollama, anthropic.`);
};

module.exports = { getProvider, resolveConfiguredProvider };
