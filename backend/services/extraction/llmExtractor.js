const { getClient } = require('../anthropicClient');

const MODEL = 'claude-sonnet-5';
const MAX_PAGE_TEXT_CHARS = 12000;

const isConfigured = () => !!process.env.ANTHROPIC_API_KEY;

// Best-effort last resort, only ever reached after the free/local DOM
// strategies (hint + auto-detect) both come back empty. Never called if no
// API key is set. Any failure here (missing key, API error, malformed JSON
// back) must surface as a rejected promise so the orchestrator's .catch()
// can swallow it — this must never be the thing that breaks a replay.
const extractWithLlm = async (page) => {
  if (!isConfigured()) return null;

  const pageText = await page.evaluate(
    (maxChars) => (document.body ? document.body.innerText.slice(0, maxChars) : ''),
    MAX_PAGE_TEXT_CHARS
  );
  if (!pageText || pageText.trim().length < 50) return null;

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Extract the repeating structured records (e.g. search results, listings, products) from this page text as a JSON array of objects with consistent keys across every object. Use short snake_case keys inferred from context. Return ONLY the JSON array, no prose, no markdown fences.\n\nPage text:\n${pageText}`
    }]
  });

  const raw = response.content?.[0]?.text || '';
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]);
  return Array.isArray(parsed) ? parsed : null;
};

module.exports = { extractWithLlm };
