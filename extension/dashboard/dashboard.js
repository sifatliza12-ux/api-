/**
 * dashboard.js
 * ForgeFlow's hub page — usage summary (Creating APIs, plan-limited) next
 * to the Marketplace (always available), a quick look at your APIs, and
 * Start/Stop Recording control. Recording talks directly to the background
 * service worker over the same chrome.runtime message API the popup always
 * used (start-recording / stop-recording / get-recorder-state) — recording
 * state lives in the background, not in any one UI, so starting it here and
 * stopping it from the popup (or vice versa) both work correctly.
 */

const API_BASE = 'http://localhost:5000';
const AUTH_STORAGE_KEY = 'forgeflow.auth';

const escapeHtml = (str) => {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const formatRelativeDate = (iso) => {
    if (!iso) return 'Unknown';
    try {
        const d = new Date(iso);
        const diff = Date.now() - d.getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    } catch (e) {
        return 'Unknown';
    }
};

const getAuthSession = () => new Promise((resolve) => {
    chrome.storage.local.get(AUTH_STORAGE_KEY, (result) => {
        resolve(result?.[AUTH_STORAGE_KEY] || null);
    });
});

const sendRuntimeMessage = (message) => new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
        }
        resolve(response || { ok: true });
    });
});

const defaultWorkflowName = () => `Workflow - ${new Date().toLocaleString()}`;

document.addEventListener('DOMContentLoaded', () => {
    const authNote = document.getElementById('auth-note');
    const recordBanner = document.getElementById('record-banner');
    const recordIndicator = document.getElementById('record-indicator');
    const recordStatusHeading = document.getElementById('record-status-heading');
    const recordStatusText = document.getElementById('record-status-text');
    const recordToggleBtn = document.getElementById('record-toggle-btn');
    const generationsValue = document.getElementById('usage-generations-value');
    const generationsFill = document.getElementById('usage-generations-fill');
    const runsValue = document.getElementById('usage-runs-value');
    const runsFill = document.getElementById('usage-runs-fill');
    const statTotal = document.getElementById('stat-total');
    const statPublished = document.getElementById('stat-published');
    const statDrafts = document.getElementById('stat-drafts');
    const recentList = document.getElementById('recent-apis-list');
    const myApisLink = document.getElementById('my-apis-link');
    const marketplaceLink = document.getElementById('marketplace-link');
    const viewAllApisLink = document.getElementById('view-all-apis-link');

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        if (myApisLink) myApisLink.href = chrome.runtime.getURL('my-apis/my-apis.html');
        if (viewAllApisLink) viewAllApisLink.href = chrome.runtime.getURL('my-apis/my-apis.html');
        if (marketplaceLink) marketplaceLink.href = chrome.runtime.getURL('marketplace/marketplace.html');
    }

    const renderBar = (fillEl, valueEl, used, limit) => {
        const remaining = Math.max(0, limit - used);
        const pct = limit > 0 ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : 0;
        if (valueEl) valueEl.textContent = `${remaining} / ${limit}`;
        if (fillEl) {
            fillEl.style.width = `${pct}%`;
            fillEl.classList.toggle('is-depleted', remaining === 0);
        }
    };

    const renderRecentApis = (apis) => {
        if (!recentList) return;
        const recent = apis.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 3);

        if (recent.length === 0) {
            recentList.innerHTML = '<p class="recent-apis-empty">No APIs yet — record a workflow from the extension popup to create your first one.</p>';
            return;
        }

        recentList.innerHTML = recent.map((api) => `
            <div class="recent-api-row">
                <span class="recent-api-row-name">${escapeHtml(api.name)}</span>
                <span class="recent-api-row-meta">${api.published ? 'Published' : 'Draft'} • ${formatRelativeDate(api.createdAt)}</span>
            </div>
        `).join('');
    };

    const loadDashboardData = async (authHeaders) => {
        try {
            const [subRes, apisRes] = await Promise.all([
                fetch(`${API_BASE}/subscription`, { headers: authHeaders }),
                fetch(`${API_BASE}/api/my-apis`, { headers: authHeaders })
            ]);

            if (subRes.ok) {
                const sub = await subRes.json().catch(() => ({}));
                renderBar(generationsFill, generationsValue, sub.usage?.apiGenerations ?? 0, sub.limits?.apiGenerations ?? 2);
                renderBar(runsFill, runsValue, sub.usage?.apiRuns ?? 0, sub.limits?.apiRuns ?? 2);
            }

            if (apisRes.ok) {
                const apis = await apisRes.json().catch(() => ([]));
                const list = Array.isArray(apis) ? apis : [];
                const published = list.filter((a) => a.published).length;
                if (statTotal) statTotal.textContent = String(list.length);
                if (statPublished) statPublished.textContent = String(published);
                if (statDrafts) statDrafts.textContent = String(list.length - published);
                renderRecentApis(list);
            }
        } catch (err) {
            console.error('[ForgeFlow][dashboard] failed to load dashboard data', err);
        }
    };

    // --- Recording control ---
    // Same message contract the popup has always used
    // (start-recording / stop-recording / get-recorder-state), so the
    // background service worker doesn't need to know or care which UI is
    // asking — recording started here can be stopped from the popup, and
    // vice versa.
    let recordingPollId = null;

    const updateRecordingUI = (state) => {
        const isRecording = Boolean(state?.isRecording);
        const eventCount = state?.events?.length || 0;

        if (recordBanner) recordBanner.classList.toggle('is-recording', isRecording);
        if (recordIndicator) recordIndicator.classList.toggle('is-recording', isRecording);
        if (recordStatusHeading) recordStatusHeading.textContent = isRecording ? 'Recording…' : 'Ready to Record';
        if (recordStatusText) {
            recordStatusText.textContent = isRecording
                ? `${eventCount} event${eventCount === 1 ? '' : 's'} captured. Switch to the tab you want to automate, then come back here to stop.`
                : "Start recording, then switch to the tab you want to automate. Come back and stop when you're done — your workflow becomes an API automatically.";
        }
        if (recordToggleBtn) {
            recordToggleBtn.textContent = isRecording ? 'Stop Recording' : 'Start Recording';
            recordToggleBtn.classList.toggle('is-recording', isRecording);
        }

        if (isRecording && !recordingPollId) {
            recordingPollId = window.setInterval(refreshRecordingState, 2000);
        } else if (!isRecording && recordingPollId) {
            window.clearInterval(recordingPollId);
            recordingPollId = null;
        }
    };

    const refreshRecordingState = async () => {
        const response = await sendRuntimeMessage({ type: 'get-recorder-state' });
        updateRecordingUI(response?.state);
    };

    const handleStartRecording = async () => {
        if (recordToggleBtn) recordToggleBtn.disabled = true;
        const response = await sendRuntimeMessage({ type: 'start-recording', source: 'dashboard' });
        if (recordToggleBtn) recordToggleBtn.disabled = false;
        updateRecordingUI(response?.state);
    };

    const handleStopRecording = async () => {
        const input = window.prompt('Name this workflow:', defaultWorkflowName());
        const name = (input || '').trim() || defaultWorkflowName();

        if (recordToggleBtn) recordToggleBtn.disabled = true;
        const response = await sendRuntimeMessage({ type: 'stop-recording', source: 'dashboard', save: true, name });
        if (recordToggleBtn) recordToggleBtn.disabled = false;
        updateRecordingUI(response?.state);

        if (response?.save?.ok) {
            alert('Workflow saved! Find it under My APIs.');
            const session = await getAuthSession();
            if (session?.token) {
                loadDashboardData({ Authorization: `Bearer ${session.token}` });
            }
        } else if (response?.save) {
            alert(`Could not save workflow: ${response.save.error || 'Unknown error'}`);
        }
    };

    const handleToggleRecording = async () => {
        const response = await sendRuntimeMessage({ type: 'get-recorder-state' });
        if (response?.state?.isRecording) {
            await handleStopRecording();
        } else {
            await handleStartRecording();
        }
    };

    if (recordToggleBtn) {
        recordToggleBtn.addEventListener('click', handleToggleRecording);
    }

    refreshRecordingState();

    (async () => {
        const session = await getAuthSession();
        if (!session?.token) {
            if (authNote) {
                authNote.hidden = false;
                authNote.textContent = 'Log in from the ForgeFlow extension popup to see your usage and APIs.';
            }
            renderBar(generationsFill, generationsValue, 0, 2);
            renderBar(runsFill, runsValue, 0, 2);
            renderRecentApis([]);
            return;
        }

        await loadDashboardData({ Authorization: `Bearer ${session.token}` });
    })();
});
