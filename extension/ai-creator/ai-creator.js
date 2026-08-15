/**
 * ai-creator.js
 * The AI Creator page — natural-language -> structured intent -> confirm ->
 * browser-agent generation -> generated API, wired to the existing V2 AI
 * Creator backend (backend/routes/aiCreator.js) and, on success, the
 * existing My APIs / Run / Test / Publish infrastructure
 * (backend/routes/myApis.js, backend/routes/workflows.js). This file knows
 * nothing about any specific task, site, or parameter name — it only reads
 * the generic { name, type, value, label, description } parameter schema
 * and the generic { targetSite, task, parameters } intent schema the
 * backend already produces for ANY request, exactly like shared/paramForm.js
 * already does for a recorded workflow's parameters.
 *
 * There is no shared fetch/auth wrapper anywhere in this codebase (see
 * settings.js/my-apis.js) — this file follows the same established
 * per-page pattern: read window.FORGEFLOW_API_BASE + chrome.storage.local's
 * 'forgeflow.auth', build an Authorization header manually, call fetch()
 * directly.
 */

const API_BASE = window.FORGEFLOW_API_BASE;
const AUTH_STORAGE_KEY = 'forgeflow.auth';
const POLL_INTERVAL_MS = 6000;

// Only the backend's own STATUSES (aiCreationSessionStore.js) drive this —
// no separate frontend state machine. 'failed' has no entry here because it
// renders through the dedicated error area, not this status line.
const STATUS_MESSAGES = {
    created: 'Starting…',
    parsing: 'Understanding your request…',
    awaiting_confirmation: 'Waiting for your confirmation…',
    generating: 'Generating workflow — working with the website. This can take several minutes.',
    testing: 'Testing the generated API…',
    cancelled: 'This session was cancelled.'
};
const SPINNING_STATUSES = new Set(['parsing', 'generating', 'testing']);

const getAuthSession = () => new Promise((resolve) => {
    chrome.storage.local.get(AUTH_STORAGE_KEY, (result) => {
        resolve(result?.[AUTH_STORAGE_KEY] || null);
    });
});

const escapeHtml = (str) => {
    if (str === null || typeof str === 'undefined') return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

// --- Extracted-results panel ------------------------------------------
// Renders whatever structured dataset the backend returns — the `results`
// object from /generate, or a Run/Test response — as a generic JSON panel
// with an "N results captured" header and extraction metadata. Deliberately
// field-agnostic: it never looks at individual keys, so any record shape
// (products, flights, hotels, anything) renders identically. Never fabricates
// data — an empty/absent dataset shows an honest no-results state.

function normalizeResults(src) {
    if (!src) return null;
    const data = Array.isArray(src.data) ? src.data : [];
    // /generate returns totalFound/truncated at the top level; a Run/Test
    // response nests them under `execution` — accept either, generically.
    const totalFound = Number.isFinite(src.totalFound)
        ? src.totalFound
        : (src.execution && Number.isFinite(src.execution.totalFound))
            ? src.execution.totalFound
            : data.length;
    const truncated = typeof src.truncated === 'boolean'
        ? src.truncated
        : Boolean(src.execution && src.execution.truncated);
    const confidence = Number.isFinite(src.confidence) ? src.confidence : 0;
    const method = src.extractionMethod || src.method || 'none';
    const source = src.source || src.finalUrl || null;
    return { data, totalFound, truncated, confidence, method, source };
}

function resultsDatasetJson() {
    const n = normalizeResults(lastResults);
    return n && n.data.length ? JSON.stringify(n.data, null, 2) : '';
}

function resultsPanelHtml(n) {
    if (!n || !Array.isArray(n.data) || n.data.length === 0) {
        return `
            <div class="ai-results-panel ai-results-panel--empty">
                <p class="ai-results-count">No results captured</p>
                <p class="ai-results-empty-note">ForgeFlow reached the site but didn't detect a structured result set on the final page. Try <strong>Run API</strong> with different parameters, or refine your request with a follow-up message.</p>
            </div>`;
    }
    const pct = Math.round((n.confidence || 0) * 100);
    const meta = [
        `Method: ${escapeHtml(n.method)}`,
        `Confidence: ${pct}%`,
        n.source ? `Source: ${escapeHtml(n.source)}` : null,
        n.truncated ? `Truncated — showing ${n.data.length} of ${n.totalFound}` : null
    ].filter(Boolean).join(' &nbsp;·&nbsp; ');
    return `
        <div class="ai-results-panel">
            <div class="ai-results-header">
                <span class="ai-results-count">${n.totalFound} result${n.totalFound === 1 ? '' : 's'} captured</span>
                <div class="ai-results-actions">
                    <button type="button" class="btn btn-secondary" id="copy-results-btn">Copy JSON</button>
                    <button type="button" class="btn btn-secondary" id="download-results-btn">Download JSON</button>
                </div>
            </div>
            <p class="ai-results-meta">${meta}</p>
            <pre class="ai-results-json">${escapeHtml(JSON.stringify(n.data, null, 2))}</pre>
        </div>`;
}

function wireResultsPanel(nameForFile) {
    const copyBtn = document.getElementById('copy-results-btn');
    const downloadBtn = document.getElementById('download-results-btn');
    if (copyBtn) copyBtn.addEventListener('click', () => copyJson(resultsDatasetJson()));
    if (downloadBtn) downloadBtn.addEventListener('click', () => downloadJson(resultsDatasetJson(), `${nameForFile || 'forgeflow'}-results`));
}

// --- Module state -----------------------------------------------------

let authHeaders = {};
let session = null;           // latest formatSession()-shaped object from the backend
let lastGenerateExtra = null; // { myApiId, endpoint, method } from the most recent successful /generate response
let lastResults = null;       // extracted dataset from the most recent /generate response (or Run/Test), shown in the results panel
// The just-submitted text, shown immediately on Send — session.messages
// (server state) only reflects it once the backend round-trip completes,
// which can be a while, so this is what makes the message appear at once
// instead of only after the response arrives. Cleared once session.messages
// genuinely contains it (or on a fresh request), never rendered twice.
let pendingUserMessage = null;
let isBusy = false;
let siteConfirmed = false;    // local-only: user explicitly accepted an uncertain targetSite
let transientError = null;    // a request-level error with no session context (e.g. empty command)
let pollTimer = null;
let elapsedTimer = null;
let generateStartedAt = null;
let recognition = null;
let isListening = false;

// DOM refs — assigned once on DOMContentLoaded.
let authNote, chatTranscript, chatEmpty, confirmArea, statusArea, errorArea,
    resultArea, form, input, sendBtn, micBtn, voiceHint;

// --- Rendering ----------------------------------------------------------

function describeIntentForChat(intent) {
    if (!intent) return "I couldn't understand that request.";
    const siteName = intent.targetSite?.name || 'an unspecified site';
    const paramCount = Array.isArray(intent.parameters) ? intent.parameters.length : 0;
    const paramNote = paramCount ? ` with ${paramCount} parameter${paramCount === 1 ? '' : 's'}` : '';
    return `Got it — "${intent.task || 'this task'}" on ${siteName}${paramNote}. See the details below to confirm.`;
}

function renderTranscript() {
    chatTranscript.querySelectorAll('.ai-chat-message').forEach((el) => el.remove());

    const messages = Array.isArray(session?.messages) ? session.messages : [];
    // Already present in the real session (the backend echoed it back) —
    // don't render it a second time as a separate pending bubble.
    const showPending = pendingUserMessage && !messages.some((m) => m.role === 'user' && m.text === pendingUserMessage);

    if (!messages.length && !showPending) {
        chatEmpty.hidden = false;
        return;
    }
    chatEmpty.hidden = true;

    messages.forEach((msg) => {
        const el = document.createElement('div');
        if (msg.role === 'user' && typeof msg.text === 'string') {
            el.className = 'ai-chat-message ai-chat-message--user';
            el.textContent = msg.text;
        } else if (msg.role === 'assistant' && msg.type === 'intent') {
            el.className = 'ai-chat-message ai-chat-message--assistant';
            el.textContent = describeIntentForChat(msg.intent);
        } else if (msg.role === 'assistant' && msg.type === 'workflow_generated') {
            el.className = 'ai-chat-message ai-chat-message--assistant';
            el.textContent = 'Your API was generated successfully — see the result below.';
        } else if (msg.role === 'system' && msg.type === 'error') {
            el.className = 'ai-chat-message ai-chat-message--system';
            el.textContent = msg.text || 'Something went wrong.';
        } else {
            // Unknown/future message shape — skip rather than crash so a
            // backend addition never breaks this page.
            return;
        }
        chatTranscript.appendChild(el);
    });

    if (showPending) {
        const el = document.createElement('div');
        el.className = 'ai-chat-message ai-chat-message--user';
        el.textContent = pendingUserMessage;
        chatTranscript.appendChild(el);
    }

    chatTranscript.scrollTop = chatTranscript.scrollHeight;
}

function renderConfirmArea() {
    const intent = session?.intent;
    const show = session && session.status === 'awaiting_confirmation' && intent;
    if (!show) {
        confirmArea.hidden = true;
        confirmArea.innerHTML = '';
        return;
    }

    const needsSiteConfirm = Boolean(intent.targetSite?.needsConfirmation) && !siteConfirmed;

    const parameters = Array.isArray(intent.parameters) ? intent.parameters : [];
    const paramsHtml = parameters.length
        ? parameters.map((p) => `
            <div class="ai-confirm-row">
                <span class="ai-confirm-row-label">${escapeHtml(p.label || p.name)}</span>
                <span class="ai-confirm-row-value">${escapeHtml(String(p.value ?? ''))}</span>
            </div>
        `).join('')
        : '<p class="ai-confirm-row-value">No specific parameters detected.</p>';

    confirmArea.innerHTML = `
        <div class="ai-confirm-card">
            <p class="ai-confirm-heading">Here's what ForgeFlow understood:</p>
            <div class="ai-confirm-row"><span class="ai-confirm-row-label">Target</span><span class="ai-confirm-row-value">${escapeHtml(intent.targetSite?.name || 'Not identified')}</span></div>
            <div class="ai-confirm-row"><span class="ai-confirm-row-label">Task</span><span class="ai-confirm-row-value">${escapeHtml(intent.task || '—')}</span></div>
            <div class="ai-confirm-params">
                <span class="ai-confirm-row-label">Parameters</span>
                ${paramsHtml}
            </div>
            ${needsSiteConfirm ? `
                <div class="ai-site-warning">
                    <span>⚠ ForgeFlow isn't fully sure this is the right website. Please confirm before continuing, or send a message below to correct it.</span>
                    <div class="ai-confirm-actions">
                        <button type="button" class="btn btn-secondary" id="confirm-site-btn">Yes, this is the right site</button>
                    </div>
                </div>
            ` : `
                <div class="ai-confirm-actions">
                    <button type="button" class="btn btn-primary" id="generate-btn" ${isBusy ? 'disabled' : ''}>Confirm &amp; Generate</button>
                </div>
            `}
        </div>
    `;
    confirmArea.hidden = false;

    const confirmSiteBtn = document.getElementById('confirm-site-btn');
    if (confirmSiteBtn) {
        confirmSiteBtn.addEventListener('click', () => {
            siteConfirmed = true;
            renderAll();
        });
    }
    const generateBtn = document.getElementById('generate-btn');
    if (generateBtn) {
        generateBtn.addEventListener('click', handleGenerate);
    }
}

function startElapsedTimer() {
    if (elapsedTimer) return;
    if (!generateStartedAt) generateStartedAt = Date.now();
    const tick = () => {
        const el = document.getElementById('status-elapsed');
        if (!el) return;
        const secs = Math.floor((Date.now() - generateStartedAt) / 1000);
        el.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} elapsed`;
    };
    tick();
    elapsedTimer = setInterval(tick, 1000);
}

function stopElapsedTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    generateStartedAt = null;
}

function renderStatusArea() {
    // handleSubmit's POST (create/follow-up) is a real, in-flight request
    // with no session-visible status yet — session.status only updates
    // once the response arrives, so without this the status area (and any
    // "processing" feedback) would stay empty for the entire round-trip.
    // 'generating' is excluded because handleGenerate already reflects that
    // status optimistically onto `session` itself before this ever runs.
    if (isBusy && session?.status !== 'generating') {
        statusArea.hidden = false;
        statusArea.innerHTML = `
            <span class="ai-status-spinner" aria-hidden="true"></span>
            <span class="ai-status-text">${session ? 'Sending your message…' : 'Understanding your request…'}</span>
            <span class="ai-status-elapsed"></span>
        `;
        stopElapsedTimer();
        return;
    }

    const status = session?.status;
    const msg = status ? STATUS_MESSAGES[status] : null;
    if (!msg) {
        statusArea.hidden = true;
        statusArea.innerHTML = '';
        if (status !== 'generating') stopElapsedTimer();
        return;
    }

    statusArea.hidden = false;
    const spinning = SPINNING_STATUSES.has(status);
    statusArea.innerHTML = `
        ${spinning ? '<span class="ai-status-spinner" aria-hidden="true"></span>' : ''}
        <span class="ai-status-text">${escapeHtml(msg)}</span>
        <span class="ai-status-elapsed" id="status-elapsed"></span>
    `;

    if (status === 'generating') {
        startElapsedTimer();
    } else {
        stopElapsedTimer();
    }
}

function renderErrorArea() {
    if (transientError) {
        errorArea.hidden = false;
        errorArea.innerHTML = `<span>⚠ ${escapeHtml(transientError)}</span>`;
        return;
    }
    if (!session || session.status !== 'failed') {
        errorArea.hidden = true;
        errorArea.innerHTML = '';
        return;
    }
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const lastError = [...messages].reverse().find((m) => m.role === 'system' && m.type === 'error');
    errorArea.hidden = false;
    errorArea.innerHTML = `
        <span>⚠ ${escapeHtml(lastError?.text || 'Something went wrong.')}</span>
        <span>You can send a follow-up message below to try again.</span>
    `;
}

async function renderResultArea() {
    if (!session || session.status !== 'completed' || !lastGenerateExtra) {
        resultArea.hidden = true;
        resultArea.innerHTML = '';
        return;
    }

    resultArea.hidden = false;
    resultArea.innerHTML = '<p class="ai-result-heading">Loading your generated API…</p>';

    let myApi;
    try {
        const response = await fetch(`${API_BASE}/api/my-apis/${lastGenerateExtra.myApiId}`, { headers: authHeaders });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data) {
            throw new Error(data?.message || `Could not load the generated API (HTTP ${response.status}).`);
        }
        myApi = data;
    } catch (err) {
        resultArea.innerHTML = `<p class="ai-result-heading" style="color: var(--danger)">Generated, but could not load its details: ${escapeHtml(err.message)}</p>`;
        return;
    }

    const jsonText = JSON.stringify(myApi, null, 2);
    // paramForm.js reads `defaultValue`; the AI Creator's intent/workflow
    // parameters use `value` — a display-only rename, not new inference.
    const paramsForForm = (myApi.parameters || []).map((p) => ({ ...p, defaultValue: p.value }));
    const fieldsHtml = window.ForgeFlowParamForm.buildFieldsHtml(paramsForForm, {
        hint: 'These are the values used while generating this API. Editing them here does not yet change the recorded browser actions — send a follow-up message before generating to change what the AI does.'
    });

    resultArea.innerHTML = `
        <p class="ai-result-heading">✓ API generated successfully.</p>
        <div class="ai-confirm-row"><span class="ai-confirm-row-label">Name</span><span class="ai-confirm-row-value">${escapeHtml(myApi.name)}</span></div>
        <div class="ai-confirm-row"><span class="ai-confirm-row-label">Endpoint</span><span class="ai-confirm-row-value">${escapeHtml(myApi.method)} ${escapeHtml(myApi.endpoint)}</span></div>
        <div id="ai-results-wrap">${resultsPanelHtml(normalizeResults(lastResults))}</div>
        <div id="result-param-form">${fieldsHtml}</div>
        <div class="ai-result-actions">
            <button type="button" class="btn btn-primary" id="run-api-btn">Run API</button>
            <button type="button" class="btn btn-secondary" id="test-api-btn">Test API</button>
            <button type="button" class="btn btn-secondary" id="publish-api-btn">${myApi.published ? 'Unpublish' : 'Publish'}</button>
            <button type="button" class="btn btn-secondary" id="copy-json-btn">Copy JSON</button>
            <button type="button" class="btn btn-secondary" id="download-json-btn">Download JSON</button>
            <button type="button" class="btn btn-secondary" id="new-request-btn">Start New Request</button>
        </div>
        <div class="run-result" id="run-result-el" style="display:none"></div>
        <pre class="ai-json-block">${escapeHtml(jsonText)}</pre>
    `;

    wireResultsPanel(myApi.name);
    document.getElementById('run-api-btn').addEventListener('click', () => handleRunOrTest(myApi, 'run'));
    document.getElementById('test-api-btn').addEventListener('click', () => handleRunOrTest(myApi, 'test'));
    document.getElementById('publish-api-btn').addEventListener('click', () => handlePublish(myApi));
    document.getElementById('copy-json-btn').addEventListener('click', () => copyJson(jsonText));
    document.getElementById('download-json-btn').addEventListener('click', () => downloadJson(jsonText, myApi.name));
    document.getElementById('new-request-btn').addEventListener('click', resetForNewRequest);
}

function renderAll() {
    renderTranscript();
    renderConfirmArea();
    renderStatusArea();
    renderErrorArea();
    renderResultArea();
    sendBtn.disabled = isBusy;
    input.disabled = isBusy;
}

// --- Existing-functionality reuse: Run / Test / Publish -----------------
// Same backend endpoints my-apis.js's openApiModal already calls (Run:
// POST <api.endpoint>; Publish: POST /api/my-apis/:id/publish) — that
// page's own trigger logic is page-local closures over its own DOM and
// isn't exported, so this calls the same backend contract directly rather
// than duplicating a second implementation of it.

async function handleRunOrTest(myApi, mode) {
    const btn = document.getElementById(mode === 'run' ? 'run-api-btn' : 'test-api-btn');
    const resultEl = document.getElementById('run-result-el');
    const formContainer = document.getElementById('result-param-form');
    if (!btn || !resultEl || !formContainer) return;

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = mode === 'run' ? 'Running…' : 'Testing…';
    resultEl.style.display = 'none';
    resultEl.className = 'run-result';
    resultEl.innerHTML = '';

    try {
        const body = window.ForgeFlowParamForm.collectValues(formContainer);
        const url = mode === 'run'
            ? `${API_BASE}${myApi.endpoint}`
            : `${API_BASE}/api/workflows/${myApi.workflowId}/test`;
        const response = await fetch(url, {
            method: myApi.method || 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify(body)
        });
        const data = await response.json().catch(() => ({}));

        if (response.ok && data.success) {
            resultEl.classList.add('run-result--success');
            resultEl.innerHTML = `<div class="run-status">✓ ${mode === 'run' ? 'Run' : 'Test'} succeeded</div><pre class="ai-json-block">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
            // Refresh the headline results panel with this run's freshly
            // extracted dataset, so editing a parameter and re-running updates
            // the displayed results (demo parity). The raw run output above is
            // left exactly as before — existing behavior is unchanged.
            lastResults = data;
            const wrap = document.getElementById('ai-results-wrap');
            if (wrap) {
                wrap.innerHTML = resultsPanelHtml(normalizeResults(lastResults));
                wireResultsPanel(myApi.name);
            }
        } else {
            resultEl.classList.add('run-result--error');
            resultEl.textContent = `✗ ${data.message || `${mode === 'run' ? 'Run' : 'Test'} failed (HTTP ${response.status}).`}`;
        }
    } catch (err) {
        resultEl.classList.add('run-result--error');
        resultEl.textContent = '✗ Could not reach the ForgeFlow server. Please try again.';
    } finally {
        resultEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = originalLabel;
    }
}

function handlePublish(myApi) {
    if (myApi.published) {
        fetch(`${API_BASE}/api/my-apis/${myApi.id}/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({ published: false })
        }).then(() => renderResultArea()).catch(() => {});
        return;
    }

    window.openForgeFlowPricingModal({
        title: 'Publish API',
        initialPrice: myApi.price || '',
        submitLabel: 'Publish',
        submitPendingLabel: 'Publishing…',
        onSubmit: async (price, note) => {
            try {
                const response = await fetch(`${API_BASE}/api/my-apis/${myApi.id}/publish`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ published: true, price, description: note })
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.success) {
                    return { success: false, message: data.message || 'Could not publish this API.' };
                }
                await renderResultArea();
                return { success: true };
            } catch (err) {
                return { success: false, message: 'Could not reach the ForgeFlow server.' };
            }
        }
    });
}

function copyJson(text) {
    navigator.clipboard?.writeText(text).catch((err) => {
        console.warn('[ForgeFlow][ai-creator] clipboard copy failed', err);
    });
}

function downloadJson(text, name) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(name || 'forgeflow-api').replace(/[^a-z0-9-_]+/gi, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function resetForNewRequest() {
    session = null;
    lastGenerateExtra = null;
    lastResults = null;
    siteConfirmed = false;
    transientError = null;
    pendingUserMessage = null;
    stopPolling();
    stopElapsedTimer();
    input.value = '';
    renderAll();
}

// --- Backend calls --------------------------------------------------------

function applyServerSession(data) {
    if (data && typeof data.sessionId !== 'undefined') {
        session = data;
    }
}

function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
        if (!session) return;
        try {
            const response = await fetch(`${API_BASE}/api/ai-creator/sessions/${session.sessionId}`, { headers: authHeaders });
            const data = await response.json().catch(() => null);
            if (response.ok && data && data.success) {
                // Polling only ever updates the visible status/transcript —
                // success/failure is decided solely by the /generate
                // response itself (see handleGenerate), never by a poll.
                session = { ...session, status: data.status, messages: data.messages, updatedAt: data.updatedAt };
                renderStatusArea();
                renderTranscript();
            }
        } catch (err) {
            // Transient poll failure — keep showing the last known status
            // rather than interrupting the in-flight /generate request.
        }
    }, POLL_INTERVAL_MS);
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function handleSubmit(event) {
    event.preventDefault();
    if (isBusy) return;
    const text = input.value.trim();
    if (!text) return;

    transientError = null;
    siteConfirmed = false;
    isBusy = true;
    pendingUserMessage = text; // show it right now — see renderTranscript
    input.value = '';
    renderAll();

    try {
        const url = session
            ? `${API_BASE}/api/ai-creator/sessions/${session.sessionId}/messages`
            : `${API_BASE}/api/ai-creator/sessions`;
        const body = session ? { message: text } : { command: text };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify(body)
        });
        const data = await response.json().catch(() => null);

        if (!data) {
            transientError = `Request failed (HTTP ${response.status}).`;
        } else if (!response.ok && typeof data.sessionId === 'undefined') {
            // No session context at all — e.g. 400 empty/too-long command,
            // or a 404/409 before any session existed on this page.
            transientError = data.message || `Request failed (HTTP ${response.status}).`;
        } else {
            applyServerSession(data);
            // Now genuinely present in session.messages (the backend echoed
            // it back) — renderTranscript would otherwise render it twice.
            pendingUserMessage = null;
        }
    } catch (err) {
        transientError = 'Could not reach the ForgeFlow server. Please try again.';
    } finally {
        isBusy = false;
        renderAll();
    }
}

async function handleGenerate() {
    if (!session || isBusy) return;
    transientError = null;
    isBusy = true;
    // Optimistic: the backend sets the session to 'generating' as the very
    // first thing it does on receipt of this request (before the — possibly
    // several-minutes-long — browser agent run even starts), so reflecting
    // it immediately here is accurate, not a guess; the first poll or the
    // /generate response itself will confirm/correct it moments later.
    session = { ...session, status: 'generating' };
    renderAll();
    startPolling();

    try {
        const response = await fetch(`${API_BASE}/api/ai-creator/sessions/${session.sessionId}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders }
        });
        const data = await response.json().catch(() => null);

        stopPolling();

        if (!data) {
            transientError = `Request failed (HTTP ${response.status}) while generating.`;
        } else {
            applyServerSession(data);
            if (response.ok && data.success) {
                lastGenerateExtra = { myApiId: data.myApiId, endpoint: data.endpoint, method: data.method };
                // Real first-run results the backend extracted during generation
                // (see aiCreatorController /generate). null when nothing
                // structured was found — the panel then shows an honest empty
                // state rather than fabricated data.
                lastResults = data.results || null;
            } else {
                // Failure detail is already in the merged session's own
                // system/error chat message + status:'failed', rendered by
                // renderErrorArea — nothing extra to set here.
                lastGenerateExtra = null;
            }
        }
    } catch (err) {
        stopPolling();
        transientError = 'Could not reach the ForgeFlow server while generating. Please try again.';
    } finally {
        isBusy = false;
        renderAll();
    }
}

// --- Voice input ------------------------------------------------------
// Browser-native SpeechRecognition only (no paid/external speech API).
// Recognized text is placed into the SAME textarea typed input uses and
// sent through the SAME handleSubmit path — no separate pipeline.

function setupVoiceInput() {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
        micBtn.disabled = true;
        voiceHint.hidden = false;
        voiceHint.textContent = 'Voice input is not supported in this browser — you can still type your request.';
        return;
    }

    recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.addEventListener('start', () => {
        isListening = true;
        micBtn.classList.add('mic-btn--listening');
        micBtn.textContent = '⏹️';
        voiceHint.hidden = false;
        voiceHint.textContent = 'Listening…';
    });
    recognition.addEventListener('end', () => {
        isListening = false;
        micBtn.classList.remove('mic-btn--listening');
        micBtn.textContent = '🎙️';
        if (voiceHint.textContent === 'Listening…') voiceHint.hidden = true;
    });
    recognition.addEventListener('result', (event) => {
        const transcript = event.results?.[0]?.[0]?.transcript || '';
        input.value = transcript;
        input.focus();
    });
    recognition.addEventListener('error', (event) => {
        isListening = false;
        micBtn.classList.remove('mic-btn--listening');
        micBtn.textContent = '🎙️';
        voiceHint.hidden = false;
        voiceHint.textContent = event.error === 'not-allowed'
            ? 'Microphone permission was denied — you can still type your request.'
            : 'Voice input failed — you can still type your request.';
    });

    micBtn.addEventListener('click', () => {
        if (isBusy) return;
        if (isListening) { recognition.stop(); return; }
        try { recognition.start(); } catch (err) { /* recognition already running — ignore */ }
    });
}

// --- Init -----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
    authNote = document.getElementById('auth-note');
    chatTranscript = document.getElementById('chat-transcript');
    chatEmpty = document.getElementById('chat-empty');
    confirmArea = document.getElementById('confirm-area');
    statusArea = document.getElementById('status-area');
    errorArea = document.getElementById('error-area');
    resultArea = document.getElementById('result-area');
    form = document.getElementById('ai-input-form');
    input = document.getElementById('ai-input');
    sendBtn = document.getElementById('send-btn');
    micBtn = document.getElementById('mic-btn');
    voiceHint = document.getElementById('voice-hint');

    const authSession = await getAuthSession();
    if (!authSession?.token) {
        authNote.hidden = false;
        authNote.textContent = 'Log in from the ForgeFlow extension popup to use the AI Creator.';
        input.disabled = true;
        sendBtn.disabled = true;
        micBtn.disabled = true;
        return;
    }
    authHeaders = { Authorization: `Bearer ${authSession.token}` };

    setupVoiceInput();
    form.addEventListener('submit', handleSubmit);
});
