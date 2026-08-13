// AIProvider implementation backed by a local Ollama server — the intended
// primary free/local AI engine (see AI_PROVIDER=ollama in
// aiProviders/index.js). Nothing here is hard-coded to one model: both the
// server URL and the model name are read from environment variables, with
// isAvailable() responsible for honestly detecting whether Ollama is
// actually reachable and whether the configured model is actually pulled,
// rather than assuming either.
//
// Phase A scope: only isAvailable()/config-reading exists so far.
// parseIntent/decideNextAction (the actual prompt design, response parsing,
// and tool-call-style action loop) are implemented in a later phase — see
// the two stubs below, which fail loudly rather than silently returning
// something wrong if this provider is selected before that lands.
const DEFAULT_BASE_URL = 'http://localhost:11434';
const AVAILABILITY_TIMEOUT_MS = 2000;

const getBaseUrl = () => (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
const getConfiguredModel = () => (process.env.OLLAMA_MODEL || '').trim();

// Checks that an Ollama server is actually running at OLLAMA_BASE_URL AND
// that OLLAMA_MODEL is one of the models it currently has pulled. Never
// throws — a provider should be able to ask "is this option even usable?"
// without a try/catch of its own.
const isAvailable = async () => {
  const model = getConfiguredModel();
  if (!model) {
    return { available: false, reason: 'OLLAMA_MODEL is not set.' };
  }

  const baseUrl = getBaseUrl();
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS) });
    if (!response.ok) {
      return { available: false, reason: `Ollama at ${baseUrl} responded with HTTP ${response.status}.` };
    }
    const data = await response.json();
    const installedModels = Array.isArray(data.models) ? data.models.map((m) => m.name) : [];
    if (!installedModels.includes(model)) {
      return { available: false, reason: `Configured model "${model}" is not pulled in Ollama. Run "ollama pull ${model}".` };
    }
    return { available: true, reason: null };
  } catch (error) {
    return { available: false, reason: `Could not reach Ollama at ${baseUrl}: ${error.message}` };
  }
};

const parseIntent = async () => {
  throw new Error('ollamaProvider.parseIntent is not implemented yet. Set AI_PROVIDER=rule-based or AI_PROVIDER=anthropic for now.');
};

const decideNextAction = async () => {
  throw new Error('ollamaProvider.decideNextAction is not implemented yet — browser agent support lands in a later phase.');
};

module.exports = { name: 'ollama', isAvailable, getBaseUrl, getConfiguredModel, parseIntent, decideNextAction };
