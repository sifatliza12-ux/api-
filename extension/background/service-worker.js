/**
 * service-worker.js
 * Background service worker for the API Builder extension.
 * Relays recording commands to the active tab.
 */

console.log('API Builder service worker initialized');

const resolveTargetTabId = async () => {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return activeTab?.id || null;
};

const forwardRecordingMessage = async (request) => {
    const targetTabId = await resolveTargetTabId();
    console.log('[ForgeFlow][service-worker] forwarding to tab', targetTabId);

    if (!targetTabId) {
        throw new Error('No active tab available for recording');
    }

    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(targetTabId, request, (response) => {
            if (chrome.runtime.lastError) {
                const errorMessage = chrome.runtime.lastError.message;
                console.error('[ForgeFlow][service-worker] tabs.sendMessage error', errorMessage);
                reject(new Error(errorMessage));
                return;
            }

            console.log('[ForgeFlow][service-worker] tabs.sendMessage response', response);
            resolve(response);
        });
    });
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('[ForgeFlow][service-worker] received', request);

    if (request?.type === 'start-recording' || request?.type === 'stop-recording') {
        (async () => {
            try {
                console.log(`[ForgeFlow][service-worker] forwarding ${request.type}`);
                const response = await forwardRecordingMessage(request);
                console.log(`[ForgeFlow][service-worker] forwarded ${request.type}`, response);
                sendResponse(response || { ok: true });
            } catch (error) {
                console.error(`[ForgeFlow][service-worker] failed to forward ${request.type}`, error);
                sendResponse({ ok: false, error: error.message });
            }
        })();
        return true;
    }

    sendResponse({ status: 'received' });
    return true;
});

chrome.runtime.onInstalled.addListener(() => {
    console.log('API Builder extension installed/updated');
});
