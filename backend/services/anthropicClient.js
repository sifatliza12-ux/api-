const Anthropic = require('@anthropic-ai/sdk');

let client = null;

// Lazily constructed so a missing API key only breaks the parameterization
// route (at request time, with a clear error) instead of crashing the whole
// server on startup.
const getClient = () => {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set. Add it to backend/.env');
    }
    client = new Anthropic({ apiKey });
  }
  return client;
};

module.exports = { getClient };
