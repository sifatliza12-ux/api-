// Manual smoke test for the REAL Ollama provider — talks to an actual local
// Ollama server. Not part of the automated suite (no other test file
// requires this one, and it isn't wired into `npm test`) because it needs
// Ollama genuinely installed and running with a real model pulled; the
// offline unit coverage for this provider lives in ollamaProvider.test.js
// and ollamaResponseUtils.test.js, which mock fetch and never touch a real
// server.
//
// Usage (from backend/):
//   OLLAMA_MODEL=qwen2.5:7b-instruct node test/ollamaProvider.smoke.js
// (OLLAMA_BASE_URL defaults to http://localhost:11434 if unset.)
//
// Prints the structured intent Ollama produced for a fixed sample command.
// Never prints environment variables, API keys, or any secret — Ollama
// calls carry no credentials at all, only the prompt text and the model's
// JSON response.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
require('dotenv').config();

const ollamaProvider = require('../services/aiProviders/ollamaProvider');
const { sanitizeIntent } = require('../services/nlIntentParser');

const SAMPLE_COMMAND = 'Create an API to search for flights from Dhaka to Dubai on FlightRadar.';

const main = async () => {
  console.log(`Checking Ollama at ${ollamaProvider.getBaseUrl()} for model "${ollamaProvider.getConfiguredModel() || '(none set)'}"...`);

  const availability = await ollamaProvider.isAvailable();
  if (!availability.available) {
    console.log(`Ollama is not available — skipping smoke test. Reason: ${availability.reason}`);
    console.log('This is expected if Ollama is not installed/running locally. Set OLLAMA_MODEL and start Ollama to run this smoke test for real.');
    process.exit(0);
  }
  console.log('Ollama is reachable and the configured model is pulled. Sending a real request...\n');

  console.log(`Command: "${SAMPLE_COMMAND}"\n`);

  const started = Date.now();
  try {
    const rawIntent = await ollamaProvider.parseIntent(SAMPLE_COMMAND);
    const intent = sanitizeIntent(rawIntent);
    console.log(`Structured intent (${Date.now() - started}ms):`);
    console.log(JSON.stringify(intent, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(`Smoke test failed after ${Date.now() - started}ms: ${error.message}`);
    if (error.details) {
      console.error('Details:', JSON.stringify(error.details, null, 2).slice(0, 1000));
    }
    process.exit(1);
  }
};

main();
