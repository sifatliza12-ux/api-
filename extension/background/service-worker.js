/**
 * service-worker.js
 * Single source of truth for the recording system.
 */

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

const syncTab = async (tabId, state) => {
    if (!tabId) {
        return { ok: false, error: 'No tab available' };
    }

    return sendToTab(tabId, { type: 'recorder:sync', state });
};

const startRecording = async (tabId) => {
    const activeTab = await getActiveTab();
    const targetTabId = tabId || activeTab?.id || null;
    const nextState = await saveState({
        ...(await getSnapshot()),
        isRecording: true,
        events: [],
        activeTabId: targetTabId,
        activeTabUrl: activeTab?.url || '',
        pageTitle: activeTab?.title || '',
        startedAt: new Date().toISOString(),
        stoppedAt: null
    });

    if (targetTabId) {
        await injectRecorderIntoTab(targetTabId);
        await syncTab(targetTabId, nextState);
    }

    return { ok: true, state: nextState };
};

const stopRecording = async (tabId) => {
    const activeTab = await getActiveTab();
    const targetTabId = tabId || activeTab?.id || null;
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

    return { ok: true, state: nextState };
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
                const result = await stopRecording(sender.tab?.id);
                sendResponse(result);
                return;
            }

            if (request?.type === 'get-recorder-state') {
                const state = await getSnapshot();
                sendResponse({ ok: true, state });
                return;
            }

            if (request?.type === 'recorder-event') {
                const currentState = await getSnapshot();
                if (!currentState.isRecording) {
                    sendResponse({ ok: true, state: currentState });
                    return;
                }

                const nextEvent = {
                    timestamp: new Date().toISOString(),
                    type: request.event?.type || 'unknown',
                    selector: request.event?.selector || null,
                    url: request.event?.url || sender.url || currentState.activeTabUrl,
                    pageTitle: request.event?.pageTitle || document.title || currentState.pageTitle,
                    value: request.event?.value ?? null
                };

                const nextState = await saveState({
                    ...currentState,
                    isRecording: true,
                    events: [...currentState.events, nextEvent],
                    activeTabId: sender.tab?.id || currentState.activeTabId,
                    activeTabUrl: sender.url || currentState.activeTabUrl,
                    pageTitle: request.event?.pageTitle || currentState.pageTitle
                });

                sendResponse({ ok: true, state: nextState });
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

chrome.runtime.onInstalled.addListener(() => {
    console.log('[Recorder][service-worker] installed');
});
