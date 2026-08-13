// Shared error type for every AIProvider implementation (rule-based, Ollama,
// Anthropic, ...). Lives in its own file — not inside nlIntentParser.js or
// any single provider — specifically so provider modules can throw it
// without creating a require cycle back through nlIntentParser.js, which
// itself depends on aiProviders/index.js to pick a provider.
//
// Thrown only for output that is structurally untrustworthy (wrong
// fundamental shape, or a required field with no safe default) — never for
// anything sanitizeIntent (nlIntentParser.js) can coerce into a safe value
// instead. See nlIntentParser.js's sanitizeIntent for exactly where that
// line is drawn.
class IntentValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'IntentValidationError';
    this.details = details;
  }
}

module.exports = { IntentValidationError };
