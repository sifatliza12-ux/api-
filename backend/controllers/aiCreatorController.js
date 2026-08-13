// V2 AI API Creator — Phase 1: session creation + status, backed by
// nlIntentParser.js and aiCreationSessionStore.js. Deliberately thin, same
// convention as workflowController.js/myApisController.js: business logic
// (parsing, validation, normalization) lives in the services this controller
// calls, not here. No browser automation happens anywhere in this file —
// that's Phase 2.
const sessionStore = require('../services/aiCreationSessionStore');
const { parseIntent, IntentValidationError } = require('../services/nlIntentParser');

// Generous enough for a real natural-language request/follow-up, small
// enough to keep a single bad request from being an expensive/unbounded
// Anthropic call — same defensive-input-length philosophy already used
// elsewhere in this backend (e.g. purchaseRequestController's screenshot
// size cap).
const MAX_COMMAND_LENGTH = 2000;

const nowIso = () => new Date().toISOString();

const extractLatestIntent = (chatMessages) => {
  for (let i = chatMessages.length - 1; i >= 0; i -= 1) {
    if (chatMessages[i].role === 'assistant' && chatMessages[i].type === 'intent') {
      return chatMessages[i].intent;
    }
  }
  return null;
};

// The shape both createSession/addMessage (write paths) and getSession (read
// path) return — enough for a future chat UI to render status, history, the
// latest parsed intent for a confirmation screen, and (once Phase 2 exists)
// the resulting workflow id.
const formatSession = (session) => ({
  sessionId: String(session.id),
  status: session.status,
  nlCommand: session.nlCommand,
  messages: session.chatMessages,
  intent: extractLatestIntent(session.chatMessages),
  generatedWorkflowId: session.generatedWorkflowId,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt
});

// Runs the shared "append user text -> parsing -> parseIntent -> record
// outcome" sequence used by both createSession and addMessage, so the two
// endpoints can't drift on error handling/status transitions.
const runParseAndRecord = async (sessionId, textToParse) => {
  sessionStore.setStatus(sessionId, 'parsing');

  try {
    const intent = await parseIntent(textToParse);
    sessionStore.appendMessage(sessionId, { role: 'assistant', type: 'intent', intent, at: nowIso() });
    const finalSession = sessionStore.setStatus(sessionId, 'awaiting_confirmation');
    return { ok: true, session: finalSession, intent };
  } catch (err) {
    const isValidationError = err instanceof IntentValidationError;
    const message = err.message || 'Failed to understand that request.';
    sessionStore.appendMessage(sessionId, { role: 'system', type: 'error', text: message, at: nowIso() });
    const finalSession = sessionStore.setStatus(sessionId, 'failed');
    return { ok: false, session: finalSession, message, status: isValidationError ? 422 : 500 };
  }
};

// POST /api/ai-creator/sessions
// Body: { command: string }
// Creates a session, sends the command straight to nlIntentParser (no
// browser, no workflow yet — see requirement 5), and returns the parsed
// intent for a future confirmation screen.
const createSession = async (req, res) => {
  try {
    const command = req.body?.command;
    if (typeof command !== 'string' || !command.trim()) {
      return res.status(400).json({ success: false, message: 'Request body must include a non-empty "command" string.' });
    }
    const trimmed = command.trim();
    if (trimmed.length > MAX_COMMAND_LENGTH) {
      return res.status(400).json({ success: false, message: `"command" must be ${MAX_COMMAND_LENGTH} characters or fewer.` });
    }

    const created = sessionStore.create({ ownerId: req.user.id, nlCommand: trimmed });
    sessionStore.appendMessage(created.id, { role: 'user', text: trimmed, at: nowIso() });

    const result = await runParseAndRecord(created.id, trimmed);
    if (!result.ok) {
      return res.status(result.status).json({ success: false, ...formatSession(result.session) });
    }
    return res.status(201).json({ success: true, ...formatSession(result.session) });
  } catch (err) {
    console.error('[Backend] AI creator createSession failed', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to create AI creation session.' });
  }
};

// GET /api/ai-creator/sessions/:id
const getSession = (req, res) => {
  try {
    const session = sessionStore.getById(req.params.id);
    if (!session || session.ownerId !== req.user.id) {
      return res.status(404).json({ success: false, message: `No AI creation session found for id "${req.params.id}".` });
    }
    return res.json({ success: true, ...formatSession(session) });
  } catch (err) {
    console.error('[Backend] AI creator getSession failed', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to load session.' });
  }
};

// A follow-up is only meaningful once there's an intent to refine (or to
// retry after a failed parse) — not mid-generation/already-completed, which
// don't exist yet in Phase 1 but are guarded against here so this endpoint's
// contract doesn't need to change when Phase 2 introduces them.
const ALLOWED_FOLLOWUP_STATUSES = new Set(['awaiting_confirmation', 'failed']);

// POST /api/ai-creator/sessions/:id/messages
// Body: { message: string }
// Minimal follow-up support (requirement 7): re-parses the ORIGINAL command
// plus every follow-up message as one combined request, rather than a
// separate revision-aware prompt — simple enough for Phase 1, and already
// enough to support something like "actually use Chittagong as the origin"
// on top of an earlier "search flights from Dhaka to Dubai" without any
// browser awareness. No workflow generation happens here.
const addMessage = async (req, res) => {
  try {
    const session = sessionStore.getById(req.params.id);
    if (!session || session.ownerId !== req.user.id) {
      return res.status(404).json({ success: false, message: `No AI creation session found for id "${req.params.id}".` });
    }
    if (!ALLOWED_FOLLOWUP_STATUSES.has(session.status)) {
      return res.status(409).json({ success: false, message: `This session is currently "${session.status}" and cannot accept a new message right now.` });
    }

    const message = req.body?.message;
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Request body must include a non-empty "message" string.' });
    }
    const trimmed = message.trim();
    if (trimmed.length > MAX_COMMAND_LENGTH) {
      return res.status(400).json({ success: false, message: `"message" must be ${MAX_COMMAND_LENGTH} characters or fewer.` });
    }

    const withMessage = sessionStore.appendMessage(session.id, { role: 'user', text: trimmed, at: nowIso() });
    const combinedCommand = withMessage.chatMessages
      .filter((m) => m.role === 'user' && typeof m.text === 'string')
      .map((m) => m.text)
      .join('\n');

    const result = await runParseAndRecord(session.id, combinedCommand);
    if (!result.ok) {
      return res.status(result.status).json({ success: false, ...formatSession(result.session) });
    }
    return res.json({ success: true, ...formatSession(result.session) });
  } catch (err) {
    console.error('[Backend] AI creator addMessage failed', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to process message.' });
  }
};

module.exports = { createSession, getSession, addMessage };
