/**
 * service-worker.js
 * Single source of truth for the recording system.
 */

importScripts('../shared/config.js');

console.log('[Recorder][service-worker] initialized');

const STORAGE_KEY = 'forgeflow.recorder.state';
const DEFAULT_STATE = Object.freeze({
    isRecording: false,
    events: [],
    activeTabId: null,
    activeTabUrl: '',
    pageTitle: '',
    startedAt: null,
    stoppedAt: null
});

let recorderState = { ...DEFAULT_STATE };

const loadState = async () => {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    const storedState = result?.[STORAGE_KEY];

    if (!storedState || typeof storedState !== 'object') {
        return { ...DEFAULT_STATE };
    }

    return {
        ...DEFAULT_STATE,
        ...storedState,
        events: Array.isArray(storedState.events) ? storedState.events : []
    };
};

const saveState = async (state) => {
    recorderState = {
        ...DEFAULT_STATE,
        ...state,
        events: Array.isArray(state?.events) ? state.events : []
    };

    await chrome.storage.session.set({ [STORAGE_KEY]: recorderState });
    return recorderState;
};

const getSnapshot = async () => {
    const state = await loadState();
    recorderState = state;
    return { ...state, events: [...state.events] };
};

// Recording can be active across multiple tabs at once, so events can arrive
// concurrently. Without serialization, two near-simultaneous
// read-modify-write cycles (getSnapshot -> saveState) can race: both read the
// same events array, and the second write silently clobbers the first's
// appended event. This queue forces every state mutation to complete fully
// before the next one starts, regardless of which tab/listener triggered it.
let stateQueue = Promise.resolve();

const enqueueStateOp = (operation) => {
    const result = stateQueue.then(operation, operation);
    // Keep the queue alive even if this operation failed, so a single error
    // doesn't permanently stall every future state mutation.
    stateQueue = result.then(() => undefined, () => undefined);
    return result;
};

const getActiveTab = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
};

const injectRecorderIntoTab = async (tabId) => {
    if (!tabId) {
        return { ok: false, error: 'No tab available' };
    }

    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: false },
            files: ['content/content.js']
        });
        return { ok: true };
    } catch (error) {
        console.error('[Recorder][service-worker] injection failed', error);
        return { ok: false, error: error.message };
    }
};

const sendToTab = async (tabId, message) => {
    if (!tabId) {
        return { ok: false, error: 'No tab available' };
    }

    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                const errorMessage = chrome.runtime.lastError.message;
                resolve({ ok: false, error: errorMessage });
                return;
            }

            resolve(response || { ok: true });
        });
    });
};

const BACKEND_BASE_URL = self.FORGEFLOW_API_BASE;
const AUTH_STORAGE_KEY = 'forgeflow.auth';

// Recording/API generation now requires an account (workflows are owned per
// user), so the token the popup saved to chrome.storage.local needs to ride
// along on this request — it's the same storage area the popup itself reads,
// just accessed here since the service worker is what actually calls the
// backend.
const getAuthToken = async () => {
    const result = await chrome.storage.local.get(AUTH_STORAGE_KEY);
    return result?.[AUTH_STORAGE_KEY]?.token || null;
};

const saveWorkflowToBackend = async ({ name, description, events }) => {
    console.log('[Recorder][pipeline] step 1: events received from recorder', { name, eventCount: events?.length ?? 0 });

    if (!Array.isArray(events) || events.length === 0) {
        console.warn('[Recorder][pipeline] FAILED at step 1: no events to save');
        return { ok: false, error: 'No events were recorded.' };
    }

    const token = await getAuthToken();
    console.log('[Recorder][pipeline] auth token present?', Boolean(token));
    if (!token) {
        console.warn('[Recorder][pipeline] FAILED before reaching backend: no auth token in chrome.storage.local — request was never sent');
        return { ok: false, error: 'You must be logged in to save a workflow. Open the ForgeFlow popup and log in first.' };
    }

    try {
        console.log('[Recorder][pipeline] sending POST /api/workflows/parameterize', { eventCount: events.length });
        const response = await fetch(`${BACKEND_BASE_URL}/api/workflows/parameterize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ name, description, events })
        });
        const data = await response.json().catch(() => ({}));
        console.log('[Recorder][pipeline] backend responded', { status: response.status, data });

        if (!response.ok || !data.success) {
            console.warn('[Recorder][pipeline] FAILED at backend:', data.message || response.status);
            return { ok: false, error: data.message || `Save failed (HTTP ${response.status})` };
        }

        console.log('[Recorder][pipeline] SUCCESS — workflow saved', { workflowId: data.workflowId });
        return { ok: true, workflow: data };
    } catch (error) {
        console.error('[Recorder][pipeline] FAILED — network/fetch error reaching backend', error);
        return { ok: false, error: error.message || 'Could not reach the backend.' };
    }
};

const syncTab = async (tabId, state) => {
    if (!tabId) {
        return { ok: false, error: 'No tab available' };
    }

    return sendToTab(tabId, { type: 'recorder:sync', state });
};

const startRecording = (tabId) => enqueueStateOp(async () => {
    const currentState = await getSnapshot();
    const activeTab = await getActiveTab();
    const targetTabId = tabId || activeTab?.id || null;

    if (currentState.isRecording) {
        // A session is already running — re-sync the requesting tab without
        // wiping the events collected so far.
        console.log('[Recorder][service-worker] start-recording ignored, session already active', {
            eventCount: currentState.events.length,
            startedAt: currentState.startedAt
        });

        if (targetTabId) {
            await injectRecorderIntoTab(targetTabId);
            await syncTab(targetTabId, currentState);
        }

        return { ok: true, state: currentState };
    }

    const nextState = await saveState({
        ...currentState,
        isRecording: true,
        events: [],
        activeTabId: targetTabId,
        activeTabUrl: activeTab?.url || '',
        pageTitle: activeTab?.title || '',
        startedAt: new Date().toISOString(),
        stoppedAt: null
    });

    console.log('[Recorder][service-worker] recording started', {
        tabId: targetTabId,
        startedAt: nextState.startedAt
    });

    if (targetTabId) {
        await injectRecorderIntoTab(targetTabId);
        await syncTab(targetTabId, nextState);
    }

    return { ok: true, state: nextState };
});

const stopRecording = async ({ tabId, save, name, description } = {}) => {
    const activeTab = await getActiveTab();
    const targetTabId = tabId || activeTab?.id || null;

    // Deliberately OUTSIDE enqueueStateOp: the recorder-event handler below
    // also goes through that same queue, so waiting on the drain from
    // inside it would deadlock — this tab's own outstanding sends could
    // never get their turn to be processed (and so never decrement
    // inFlightSends and let the drain resolve) while stopRecording was
    // sitting in front of them in the queue. Reading state out here first
    // to find the ACTUAL recording tab is also more reliable than "whichever
    // tab happens to be focused right now" — stop-recording is typically
    // triggered from the popup, which is itself the focused tab at that
    // moment, not the site being recorded.
    const preDrainState = await getSnapshot();
    const recordingTabId = preDrainState.activeTabId || targetTabId;
    if (recordingTabId) {
        // Give the recording tab a chance to confirm every event it tried
        // to send has actually landed before the queued op below reads the
        // "final" event log — otherwise a click/keypress fired right before
        // stop can lose its race against its own message round trip (or a
        // retry backoff) and silently vanish from the saved workflow. See
        // content.js's 'recorder:drain' handler for the other half of this.
        await sendToTab(recordingTabId, { type: 'recorder:drain' });
    }

    return enqueueStateOp(async () => {
        const currentState = await getSnapshot();
        const nextState = await saveState({
            ...currentState,
            isRecording: false,
            activeTabId: targetTabId,
            activeTabUrl: activeTab?.url || currentState.activeTabUrl,
            pageTitle: activeTab?.title || currentState.pageTitle,
            stoppedAt: new Date().toISOString()
        });

        if (targetTabId) {
            await syncTab(targetTabId, nextState);
        }

        const result = { ok: true, state: nextState };

        if (save) {
            result.save = await saveWorkflowToBackend({ name, description, events: nextState.events });
        }

        return result;
    });
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('[Recorder][service-worker] received', request);

    (async () => {
        try {
            if (request?.type === 'recorder:ready') {
                const state = await getSnapshot();
                sendResponse({ ok: true, state });
                return;
            }

            if (request?.type === 'start-recording') {
                const result = await startRecording(sender.tab?.id);
                sendResponse(result);
                return;
            }

            if (request?.type === 'stop-recording') {
                const result = await stopRecording({
                    tabId: sender.tab?.id,
                    save: Boolean(request.save),
                    name: request.name,
                    description: request.description
                });
                sendResponse(result);
                return;
            }

            if (request?.type === 'get-recorder-state') {
                const state = await getSnapshot();
                sendResponse({ ok: true, state });
                return;
            }

            if (request?.type === 'recorder-event') {
                const result = await enqueueStateOp(async () => {
                    const currentState = await getSnapshot();
                    if (!currentState.isRecording) {
                        return { ok: true, state: currentState };
                    }

                    const nextEvent = {
                        timestamp: new Date().toISOString(),
                        type: request.event?.type || 'unknown',
                        selector: request.event?.selector || null,
                        // Fallback locator candidates (label/role/css/etc) content.js
                        // captures alongside selector — dropping these here silently
                        // strips every recorded step down to its single, most fragile
                        // selector before the backend ever sees it, discarding the
                        // whole point of recording more than one way to relocate an
                        // element.
                        locators: Array.isArray(request.event?.locators) ? request.event.locators : null,
                        url: request.event?.url || sender.url || currentState.activeTabUrl,
                        pageTitle: request.event?.pageTitle || currentState.pageTitle,
                        value: request.event?.value ?? null,
                        meta: request.event?.meta || null
                    };

                    const nextState = await saveState({
                        ...currentState,
                        isRecording: true,
                        events: [...currentState.events, nextEvent],
                        activeTabId: sender.tab?.id || currentState.activeTabId,
                        activeTabUrl: sender.url || currentState.activeTabUrl,
                        pageTitle: request.event?.pageTitle || currentState.pageTitle
                    });

                    return { ok: true, state: nextState };
                });

                sendResponse(result);
                return;
            }

            sendResponse({ ok: true, status: 'received' });
        } catch (error) {
            console.error('[Recorder][service-worker] message handling failed', error);
            sendResponse({ ok: false, error: error.message });
        }
    })();

    return true;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
    (async () => {
        try {
            const state = await getSnapshot();
            if (!state.isRecording) {
                return;
            }
            await injectRecorderIntoTab(tabId);
            await syncTab(tabId, state);
        } catch (error) {
            console.warn('[Recorder][service-worker] tab activation sync failed', error);
        }
    })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') {
        return;
    }

    (async () => {
        try {
            const state = await getSnapshot();
            if (!state.isRecording || !tabId) {
                return;
            }

            if (tab?.url?.startsWith('chrome://')) {
                return;
            }

            await injectRecorderIntoTab(tabId);
            await syncTab(tabId, state);
        } catch (error) {
            console.warn('[Recorder][service-worker] tab navigation sync failed', error);
        }
    })();
});

chrome.tabs.onCreated.addListener((tab) => {
    enqueueStateOp(async () => {
        const state = await getSnapshot();
        if (!state.isRecording) {
            return;
        }

        const nextEvent = {
            timestamp: new Date().toISOString(),
            type: 'new_page',
            selector: null,
            url: tab.url || tab.pendingUrl || '',
            pageTitle: tab.title || '',
            value: null,
            meta: {
                openerTabId: tab.openerTabId ?? null,
                newTabId: tab.id
            }
        };

        await saveState({
            ...state,
            events: [...state.events, nextEvent]
        });

        console.log('[Recorder][service-worker] new_page event recorded', nextEvent);
    }).catch((error) => {
        console.warn('[Recorder][service-worker] failed to record new_page event', error);
    });
});

chrome.runtime.onInstalled.addListener(() => {
    console.log('[Recorder][service-worker] installed');
});
