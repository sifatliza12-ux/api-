// AIProvider implementation backed by Anthropic. Only ever constructed/used
// when AI_PROVIDER=anthropic is explicitly set (see aiProviders/index.js) —
// never selected automatically just because ANTHROPIC_API_KEY happens to be
// present, so ForgeFlow never silently starts billing a user who configured
// a key for something else (e.g. the existing extraction/llmExtractor.js
// path). Reuses the existing backend/services/anthropicClient.js singleton
// — no second Anthropic client is created here.
//
// This is a straight move of the tool-use logic that used to live directly
// in nlIntentParser.js (V2 Phase 1) — behavior is unchanged, only the
// location. parseIntent returns the RAW proposed-intent object exactly as
// the model produced it; validating/sanitizing that shape is deliberately
// NOT this provider's job, so every provider (rule-based, Ollama, Anthropic)
// is validated identically by nlIntentParser.js's sanitizeIntent.
const anthropicClient = require('../anthropicClient');
const { IntentValidationError } = require('./errors');

const MODEL = 'claude-opus-4-8';

const PROPOSE_INTENT_TOOL = {
  name: 'propose_automation_intent',
  description: 'Propose a structured automation intent parsed from a natural-language request to create a web automation API.',
  input_schema: {
    type: 'object',
    properties: {
      targetSite: {
        type: 'object',
        description: 'Your best understanding of which website the user wants automated.',
        properties: {
          name: { type: 'string', description: 'The site name as stated or implied by the user, e.g. "FlightRadar24". Empty string if genuinely unclear.' },
          url: { type: 'string', description: 'Your best-guess root or search URL for this site, e.g. "https://www.flightradar24.com". Omit entirely if you are not reasonably confident of a real URL.' },
          confidence: { type: 'number', description: 'Your confidence, from 0 to 1, that this name/URL is the site the user actually meant. Use a LOW value (below 0.5) if the user did not name a specific site, or if multiple different sites could plausibly match.' }
        },
        required: ['name', 'confidence']
      },
      task: { type: 'string', description: 'A short human-readable description of the automation task, e.g. "Search for flights".' },
      parameters: {
        type: 'array',
        description: 'The variable inputs this task needs. Do not invent parameters the user did not imply.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short camelCase parameter name, e.g. origin' },
            type: { type: 'string', enum: ['text', 'number', 'date', 'select', 'boolean'] },
            value: { type: 'string', description: 'The value extracted from the user\'s command for this parameter, if one was given, e.g. "Dhaka". Empty string if the user did not supply a value yet.' },
            label: { type: 'string', description: 'Human-readable label suitable for a form field, e.g. "Origin City".' },
            description: { type: 'string', description: 'A short description of what this parameter controls.' }
          },
          required: ['name', 'type', 'label']
        }
      }
    },
    required: ['targetSite', 'task', 'parameters']
  }
};

const buildPrompt = (nlCommand) => `You are the natural-language front end of an API-creation tool. A user has described, in plain English, a web automation task they want turned into a callable API.

User request: "${nlCommand}"

Identify:
1. The target website they want automated (best guess at a name and a real URL, with an honest confidence score — do not guess a URL you are not reasonably sure actually exists, and use a low confidence score whenever the request does not clearly name one specific site).
2. A short description of the task.
3. The variable parameters this task needs (only ones implied by the request itself — do not invent extra fields), each with a camelCase name, the most appropriate type (text, number, date, select, or boolean — never invent another type), a human-readable label, and the value the user actually supplied if any.

Call the propose_automation_intent tool with your findings. This is understanding-only — you are not being asked to visit the website or verify anything, only to interpret the request.`;

// Calls anthropicClient.getClient() fresh on every invocation (not
// destructured/cached at module load) so tests can monkey-patch
// anthropicClient.getClient after this module has already been required —
// see backend/test/nlIntentParser.test.js's withMockedIntentResponse.
const parseIntent = async (nlCommand) => {
  const client = anthropicClient.getClient();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [PROPOSE_INTENT_TOOL],
    tool_choice: { type: 'tool', name: PROPOSE_INTENT_TOOL.name },
    messages: [{ role: 'user', content: buildPrompt(nlCommand) }]
  });

  const toolUse = response.content.find(
    (block) => block.type === 'tool_use' && block.name === PROPOSE_INTENT_TOOL.name
  );

  if (!toolUse) {
    throw new IntentValidationError('Model did not call the expected tool.', { response });
  }

  return toolUse.input;
};

// Browser-action reasoning (V2 Phase C/D) is not implemented by this
// provider yet — Phase A only covers intent parsing.
const decideNextAction = async () => {
  throw new Error('anthropicProvider.decideNextAction is not implemented yet — browser agent support lands in a later phase.');
};

module.exports = { name: 'anthropic', parseIntent, decideNextAction };
