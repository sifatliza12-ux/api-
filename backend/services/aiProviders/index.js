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
//     external dependency — this is what guarantees Anthropic/Groq are
//     never required just to use the AI Creator)
//   "ollama"                          -> ollamaProvider (local, free, slow
//     on CPU-only hardware)
//   "anthropic"                       -> anthropicProvider
//   "groq"                            -> groqProvider (cloud, fast — see
//     GROQ_API_KEY/GROQ_MODEL in .env.example; an alternative to Ollama for
//     machines where local inference isn't practical)
// There is deliberately no "auto-upgrade because a key is present" branch
// for either cloud provider — using one is always an explicit choice.
const resolveConfiguredProvider = () => (process.env.AI_PROVIDER || 'local').trim().toLowerCase();

const getProvider = () => {
  const configured = resolveConfiguredProvider();

  if (configured === 'anthropic') {
    return require('./anthropicProvider');
  }
  if (configured === 'groq') {
    return require('./groqProvider');
  }
  if (configured === 'ollama') {
    return require('./ollamaProvider');
  }
  if (configured === 'rule-based' || configured === 'local') {
    return require('./ruleBasedProvider');
  }

  throw new Error(`Unknown AI_PROVIDER "${configured}". Expected one of: local, rule-based, ollama, anthropic, groq.`);
};

module.exports = { getProvider, resolveConfiguredProvider };
