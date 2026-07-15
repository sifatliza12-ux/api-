/**
 * creator-dashboard.js
 * Creator Studio — recording, publishing, and sales, with zero buyer
 * content. Recording talks directly to the background service worker over
 * the same chrome.runtime message API the popup and old dashboard always
 * used (start-recording / stop-recording / get-recorder-state) — recording
 * state lives in the background, not in any one UI, so starting it here and
 * stopping it from the popup (or the Buyer Dashboard's own tab) both still
 * work correctly.
 *
 * Landing on this page always means "creator mode now" — it sets the role
 * (idempotent) rather than gating/redirecting on it, since Mode Selection
 * (extension/mode-select/) is the only place that ever asks the user to
 * choose. See shared/roles.js for where the preference itself lives.
 */

const API_BASE = window.FORGEFLOW_API_BASE;
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

const formatDate = (iso) => {
    if (!iso) return 'Unknown';
    try {
        return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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

// Same deterministic "prototype" rating formula marketplace.js/analytics.js
// use, so a given listing shows the same rating everywhere in the app.
const seededFraction = (seed) => {
    const x = Math.sin(seed * 999331) * 10000;
    return x - Math.floor(x);
};
const prototypeRating = (item) => {
    const seed = Number(item.id) || 1;
    return Math.round((3.6 + seededFraction(seed) * 1.4) * 10) / 10;
};

const STATUS_LABELS = {
    pending: 'Pending',
    verification_required: 'Verification Required',
    approved: 'Approved',
    rejected: 'Rejected'
};

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
    const statDownloads = document.getElementById('stat-downloads');
    const statRuns = document.getElementById('stat-runs');
    const statRating = document.getElementById('stat-rating');
    const statRevenue = document.getElementById('stat-revenue');
    const recentList = document.getElementById('recent-apis-list');
    const pendingRequestsList = document.getElementById('pending-requests-list');
    const recentSalesList = document.getElementById('recent-sales-list');

    const qaPublishApi = document.getElementById('qa-publish-api');
    const qaManageApis = document.getElementById('qa-manage-apis');
    const qaOpenAnalytics = document.getElementById('qa-open-analytics');
    const viewAllApisLink = document.getElementById('view-all-apis-link');
    const viewRequestsLink = document.getElementById('view-requests-link');
    const viewWalletLink = document.getElementById('view-wallet-link');
    const walletLink = document.getElementById('wallet-link');
    const analyticsLink = document.getElementById('analytics-link');
    const modeSwitchLink = document.getElementById('mode-switch-link');

    const url = (path) => (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
        ? chrome.runtime.getURL(path)
        : '#';

    if (qaPublishApi) qaPublishApi.href = url('my-apis/my-apis.html');
    if (qaManageApis) qaManageApis.href = url('my-apis/my-apis.html');
    if (qaOpenAnalytics) qaOpenAnalytics.href = url('analytics/analytics.html');
    if (viewAllApisLink) viewAllApisLink.href = url('my-apis/my-apis.html');
    if (viewRequestsLink) viewRequestsLink.href = url('purchase-requests/purchase-requests.html');
    if (viewWalletLink) viewWalletLink.href = url('wallet/wallet.html');
    if (walletLink) walletLink.href = url('wallet/wallet.html');
    if (analyticsLink) analyticsLink.href = url('analytics/analytics.html');

    const renderBar = (fillEl, valueEl, used, limit) => {
        const remaining = Math.max(0, limit - used);
        const pct = limit > 0 ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : 0;
        if (valueEl) valueEl.textContent = `${remaining} / ${limit}`;
        if (fillEl) {
            fillEl.style.width = `${pct}%`;
            fillEl.classList.toggle('is-depleted', remaining === 0);
        }
    };

    const renderEmptyRow = (container, icon, heading, text) => {
        if (!container) return;
        container.innerHTML = `
            <div class="list-empty">
                <span class="list-empty-icon" aria-hidden="true">${icon}</span>
                <h3>${escapeHtml(heading)}</h3>
                <p>${escapeHtml(text)}</p>
            </div>
        `;
    };

    const renderSkeleton = (container, rows = 3) => {
        if (!container) return;
        container.innerHTML = Array.from({ length: rows }).map(() => `
            <div class="recent-api-row" aria-hidden="true">
                <span class="skeleton-line skeleton-line--title"></span>
                <span class="skeleton-line skeleton-line--desc"></span>
            </div>
        `).join('');
    };

    const renderRecentApis = (apis) => {
        if (!recentList) return;
        const recent = apis.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 3);

        if (recent.length === 0) {
            renderEmptyRow(recentList, '🗂️', 'No APIs yet', 'Record a workflow above to create your first one.');
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
        renderSkeleton(recentList, 3);
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
            console.error('[ForgeFlow][creator-dashboard] failed to load dashboard data', err);
        }
    };

    // Total Downloads / Total API Runs / Average Rating / Revenue, computed
    // from the existing, unmodified GET /marketplace and
    // GET /api/workflows/stats/mine — same calculation the old dashboard's
    // "Estimated Revenue" tile used.
    const loadCreatorExtras = async (authHeaders) => {
        try {
            const [marketRes, runStatsRes] = await Promise.all([
                fetch(`${API_BASE}/marketplace`, { headers: authHeaders }),
                fetch(`${API_BASE}/api/workflows/stats/mine`, { headers: authHeaders })
            ]);

            const marketplace = marketRes.ok ? await marketRes.json().catch(() => []) : [];
            const runStats = runStatsRes.ok ? await runStatsRes.json().catch(() => ({})) : {};

            const owned = (Array.isArray(marketplace) ? marketplace : []).filter((item) => item.isOwnedByMe);
            const totalDownloads = owned.reduce((sum, item) => sum + (item.purchaseCount || 0), 0);
            const totalRevenue = owned.reduce((sum, item) => sum + (item.purchaseCount || 0) * (item.price || 0), 0);
            const avgRating = owned.length ? owned.reduce((sum, item) => sum + prototypeRating(item), 0) / owned.length : null;

            if (statDownloads) statDownloads.textContent = String(totalDownloads);
            if (statRevenue) statRevenue.textContent = `$${totalRevenue.toFixed(2)}`;
            if (statRating) statRating.textContent = avgRating ? `${avgRating.toFixed(1)} ★` : '—';
            if (statRuns) statRuns.textContent = String(runStats.totalRuns || 0);
        } catch (err) {
            console.error('[ForgeFlow][creator-dashboard] failed to load creator extras', err);
        }
    };

    // Pending Purchase Requests — GET /purchase-requests/for-me, the exact
    // read-only endpoint purchase-requests.js itself uses, filtered here to
    // status === 'pending' for the dashboard summary card.
    const loadPendingRequests = async (authHeaders) => {
        renderSkeleton(pendingRequestsList, 2);
        try {
            const res = await fetch(`${API_BASE}/purchase-requests/for-me`, { headers: authHeaders });
            const all = res.ok ? await res.json().catch(() => []) : [];
            const pending = (Array.isArray(all) ? all : [])
                .filter((r) => r.status === 'pending')
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                .slice(0, 4);

            if (pending.length === 0) {
                renderEmptyRow(pendingRequestsList, '📥', 'No pending requests', 'New purchase requests from buyers will show up here.');
                return;
            }

            if (pendingRequestsList) {
                pendingRequestsList.innerHTML = pending.map((r) => `
                    <div class="recent-api-row">
                        <span class="recent-api-row-name">${escapeHtml(r.listingName)}</span>
                        <span class="recent-api-row-meta">${escapeHtml(r.buyerName)} • $${r.price} • ${formatRelativeDate(r.createdAt)}</span>
                    </div>
                `).join('');
            }
        } catch (err) {
            console.error('[ForgeFlow][creator-dashboard] failed to load pending requests', err);
            renderEmptyRow(pendingRequestsList, '⚠️', 'Could not load requests', 'Something went wrong loading purchase requests. Try refreshing the page.');
        }
    };

    // Recent Sales — GET /wallet/transactions, the exact read-only endpoint
    // wallet.js itself uses (a view over purchase_requests of any status).
    const loadRecentSales = async (authHeaders) => {
        renderSkeleton(recentSalesList, 2);
        try {
            const res = await fetch(`${API_BASE}/wallet/transactions`, { headers: authHeaders });
            const all = res.ok ? await res.json().catch(() => []) : [];
            const recent = (Array.isArray(all) ? all : [])
                .slice()
                .sort((a, b) => new Date(b.date) - new Date(a.date))
                .slice(0, 4);

            if (recent.length === 0) {
                renderEmptyRow(recentSalesList, '💰', 'No sales yet', 'Sales of your paid APIs will show up here once buyers start purchasing.');
                return;
            }

            if (recentSalesList) {
                recentSalesList.innerHTML = recent.map((t) => `
                    <div class="recent-api-row">
                        <span class="recent-api-row-name">${escapeHtml(t.listingName)}</span>
                        <span class="recent-api-row-meta">${escapeHtml(t.buyerName)} • $${Number(t.amount).toFixed(2)} • ${formatDate(t.date)}</span>
                        <span class="badge badge-status-${t.status}">${STATUS_LABELS[t.status] || t.status}</span>
                    </div>
                `).join('');
            }
        } catch (err) {
            console.error('[ForgeFlow][creator-dashboard] failed to load recent sales', err);
            renderEmptyRow(recentSalesList, '⚠️', 'Could not load sales', 'Something went wrong loading recent sales. Try refreshing the page.');
        }
    };

    // --- Recording control ---
    // Same message contract the popup and old dashboard have always used
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
        const response = await sendRuntimeMessage({ type: 'start-recording', source: 'creator-dashboard' });
        if (recordToggleBtn) recordToggleBtn.disabled = false;
        updateRecordingUI(response?.state);
    };

    const handleStopRecording = async () => {
        const input = window.prompt('Name this workflow:', defaultWorkflowName());
        const name = (input || '').trim() || defaultWorkflowName();

        if (recordToggleBtn) recordToggleBtn.disabled = true;
        const response = await sendRuntimeMessage({ type: 'stop-recording', source: 'creator-dashboard', save: true, name });
        if (recordToggleBtn) recordToggleBtn.disabled = false;
        updateRecordingUI(response?.state);

        if (response?.save?.ok) {
            alert('Workflow saved! Find it under My APIs.');
            const session = await getAuthSession();
            if (session?.token) {
                const authHeaders = { Authorization: `Bearer ${session.token}` };
                loadDashboardData(authHeaders);
                loadCreatorExtras(authHeaders);
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
            renderEmptyRow(pendingRequestsList, '🔒', 'Log in to continue', 'Log in to see your purchase requests.');
            renderEmptyRow(recentSalesList, '🔒', 'Log in to continue', 'Log in to see your recent sales.');
            return;
        }

        const userId = session.user?.id || null;
        const authHeaders = { Authorization: `Bearer ${session.token}` };

        // Landing here always means "creator mode now" — no redirect/guard,
        // Mode Selection is the only screen that ever asks.
        if (userId && window.ForgeFlowRoles) {
            window.ForgeFlowRoles.setRole(userId, 'creator');
        }

        if (modeSwitchLink) {
            modeSwitchLink.addEventListener('click', async (event) => {
                event.preventDefault();
                if (userId && window.ForgeFlowRoles) {
                    await window.ForgeFlowRoles.setRole(userId, 'buyer');
                }
                window.location.href = url('dashboard/buyer-dashboard.html');
            });
        }

        // Stat tiles show "…" instead of a misleading "0" while their real
        // value is still in flight.
        [statTotal, statPublished, statDrafts, statDownloads, statRuns, statRating, statRevenue].forEach((el) => {
            if (el) el.textContent = '…';
        });

        await loadDashboardData(authHeaders);
        await Promise.all([
            loadCreatorExtras(authHeaders),
            loadPendingRequests(authHeaders),
            loadRecentSales(authHeaders)
        ]);

        // Refetch the two request/sales widgets whenever this tab regains
        // visibility (e.g. the creator approved a request from the full
        // Purchase Requests page in another tab and switched back).
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                loadPendingRequests(authHeaders);
                loadRecentSales(authHeaders);
            }
        });
    })();
});
