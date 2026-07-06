const { getClient } = require('./anthropicClient');
const { condenseEvents } = require('./eventCondenser');

const MODEL = 'claude-opus-4-8';

const VALID_PARAM_TYPES = new Set(['text', 'date', 'number', 'select']);
const VALID_PARAM_EVENT_TYPES = new Set(['input', 'change']);

const PROPOSE_PARAMETERS_TOOL = {
  name: 'propose_workflow_parameters',
  description: 'Propose which steps in a recorded browser workflow represent variable data the user would want to change on reuse.',
  input_schema: {
    type: 'object',
    properties: {
      parameters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short camelCase parameter name, e.g. movieTitle' },
            type: { type: 'string', enum: ['text', 'date', 'number', 'select'] },
            label: { type: 'string', description: 'Human-readable label suitable for a form field' },
            eventIndex: { type: 'integer', description: 'The "index" field of the event this parameter maps to' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Only when type is "select": the distinct option values implied by the workflow'
            }
          },
          required: ['name', 'type', 'label', 'eventIndex']
        }
      }
    },
    required: ['parameters']
  }
};

const buildPrompt = (condensedEvents) => `You are analyzing a recorded browser workflow so it can be turned into a reusable, parameterized API.

Below is the chronological, de-duplicated event log (repeated keystrokes into the same field have already been collapsed to their final value). Each event has an "index" field — that is the identifier you must reference.

${JSON.stringify(condensedEvents, null, 2)}

Identify which events represent VARIABLE data — a value the user would plausibly want to change every time this workflow runs (a search term, a date, a ticker symbol, a quantity, a dropdown selection, etc). Only "input" and "change" events can ever be variable. Every "click", "dblclick", "navigation", "scroll", "touch", and "new_page" event is always a FIXED step and must never be proposed as a parameter.

For each variable event, propose:
- a short camelCase parameter name
- the most appropriate type: "text", "date", "number", or "select"
- a human-readable label suitable for a form field
- the eventIndex it maps back to (the "index" field above)
- if type is "select", the distinct option values implied by the workflow

Call the propose_workflow_parameters tool with your findings. If nothing in the workflow looks reusable/variable, return an empty parameters array — do not invent one.`;

// Claude's job is ONLY to classify which event indices are variable and
// propose parameter metadata. We never ask it to reproduce the event log
// itself — string substitution over data we already have exactly is far
// more reliable than hoping the model echoes a long structure back verbatim
// without drift, truncation, or hallucination.
const parameterizeWorkflow = async (events) => {
  const condensed = condenseEvents(events);

  if (condensed.length === 0) {
    return { parameters: [], template: [] };
  }

  const client = getClient();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [PROPOSE_PARAMETERS_TOOL],
    tool_choice: { type: 'tool', name: PROPOSE_PARAMETERS_TOOL.name },
    messages: [
      { role: 'user', content: buildPrompt(condensed) }
    ]
  });

  const toolUse = response.content.find(
    (block) => block.type === 'tool_use' && block.name === PROPOSE_PARAMETERS_TOOL.name
  );
  const rawParameters = Array.isArray(toolUse?.input?.parameters) ? toolUse.input.parameters : [];

  const condensedByIndex = new Map(condensed.map((event) => [event.index, event]));
  const usedNames = new Set();
  const parameters = [];

  for (const candidate of rawParameters) {
    const targetEvent = condensedByIndex.get(candidate.eventIndex);

    // Defensive validation: never trust the model to have honored the
    // "only input/change" instruction, picked a real/in-range index, or
    // proposed a unique name.
    if (!targetEvent || !VALID_PARAM_EVENT_TYPES.has(targetEvent.type)) {
      console.warn('[workflowParameterizer] dropping invalid parameter proposal', candidate);
      continue;
    }

    if (!candidate.name || usedNames.has(candidate.name)) {
      console.warn('[workflowParameterizer] dropping parameter with missing/duplicate name', candidate);
      continue;
    }

    usedNames.add(candidate.name);
    parameters.push({
      name: candidate.name,
      type: VALID_PARAM_TYPES.has(candidate.type) ? candidate.type : 'text',
      label: candidate.label || candidate.name,
      eventIndex: candidate.eventIndex,
      options: Array.isArray(candidate.options) ? candidate.options : undefined
    });
  }

  const paramByEventIndex = new Map(parameters.map((param) => [param.eventIndex, param]));

  const steps = condensed.map((event) => {
    const param = paramByEventIndex.get(event.index);
    if (!param) {
      return { ...event };
    }

    return { ...event, value: `{{${param.name}}}` };
  });

  return { parameters, steps };
};

module.exports = { parameterizeWorkflow };
