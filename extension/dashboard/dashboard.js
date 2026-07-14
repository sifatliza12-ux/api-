/**
 * dashboard.js
 * ForgeFlow's hub page — usage summary (Creating APIs, plan-limited) next
 * to the Marketplace (always available), a quick look at your APIs, and
 * Start/Stop Recording control. Recording talks directly to the background
 * service worker over the same chrome.runtime message API the popup always
 * used (start-recording / stop-recording / get-recorder-state) — recording
 * state lives in the background, not in any one UI, so starting it here and
 * stopping it from the popup (or vice versa) both work correctly.
 *
 * Role-aware on top of all that: Creator/Buyer only changes which of the two
 * content blocks below is visible and which stats get fetched — it never
 * changes what data exists. A Creator who switches to Buyer still owns every
 * API (My APIs/Published APIs are untouched), and a Buyer who switches to
 * Creator still owns every purchase (Purchased APIs is untouched). See
 * shared/roles.js for where the role preference itself lives.
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

const CATEGORY_ALIASES = {
    productivity: 'productivity', travel: 'travel', finance: 'finance',
    shopping: 'shopping', ecommerce: 'shopping', education: 'education',
    entertainment: 'entertainment', social: 'social-media', 'social-media': 'social-media', 'social media': 'social-media'
};
const CATEGORY_LABELS = {
    productivity: 'Productivity', travel: 'Travel', finance: 'Finance', shopping: 'Shopping',
    education: 'Education', entertainment: 'Entertainment', 'social-media': 'Social Media', other: 'Other'
};
const normalizeCategorySlug = (raw) => CATEGORY_ALIASES[String(raw || '').trim().toLowerCase()] || 'other';
const categoryLabel = (slug) => CATEGORY_LABELS[slug] || 'Other';

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
    const myApisLink = document.getElementById('my-apis-link');
    const marketplaceLink = document.getElementById('marketplace-link');
    const viewAllApisLink = document.getElementById('view-all-apis-link');

    // Role UI
    const topbarSubtitle = document.getElementById('topbar-subtitle');
    const roleSwitcherGroup = document.getElementById('role-switcher-group');
    const roleBadge = document.getElementById('role-badge');
    const roleSwitcherBtn = document.getElementById('role-switcher-btn');
    const roleSwitcherLabel = document.getElementById('role-switcher-label');
    const roleSwitcherMenu = document.getElementById('role-switcher-menu');
    const creatorModeContent = document.getElementById('creator-mode-content');
    const buyerModeContent = document.getElementById('buyer-mode-content');

    // Creator quick actions
    const qaRecordNewApi = document.getElementById('qa-record-new-api');
    const qaPublishApi = document.getElementById('qa-publish-api');
    const qaManageApis = document.getElementById('qa-manage-apis');
    const qaOpenAnalytics = document.getElementById('qa-open-analytics');

    // Buyer quick actions + links
    const qaBrowseMarketplace = document.getElementById('qa-browse-marketplace');
    const qaRunPurchased = document.getElementById('qa-run-purchased');
    const qaUpgradePlan = document.getElementById('qa-upgrade-plan');
    const upgradePlanLink = document.getElementById('upgrade-plan-link');
    const viewPurchasedLink = document.getElementById('view-purchased-link');
    const viewMarketplaceLink = document.getElementById('view-marketplace-link');

    // Buyer stats + lists
    const buyerStatPurchased = document.getElementById('buyer-stat-purchased');
    const buyerStatRuns = document.getElementById('buyer-stat-runs');
    const buyerStatFavoriteCategory = document.getElementById('buyer-stat-favorite-category');
    const buyerStatRecentPurchases = document.getElementById('buyer-stat-recent-purchases');
    const buyerPurchasedList = document.getElementById('buyer-purchased-list');
    const buyerRecentUsedList = document.getElementById('buyer-recent-used-list');
    const buyerRecommendedList = document.getElementById('buyer-recommended-list');

    const url = (path) => (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
        ? chrome.runtime.getURL(path)
        : '#';

    if (myApisLink) myApisLink.href = url('my-apis/my-apis.html');
    if (viewAllApisLink) viewAllApisLink.href = url('my-apis/my-apis.html');
    if (marketplaceLink) marketplaceLink.href = url('marketplace/marketplace.html');
    if (qaPublishApi) qaPublishApi.href = url('my-apis/my-apis.html');
    if (qaManageApis) qaManageApis.href = url('my-apis/my-apis.html');
    if (qaOpenAnalytics) qaOpenAnalytics.href = url('analytics/analytics.html');
    if (qaBrowseMarketplace) qaBrowseMarketplace.href = url('marketplace/marketplace.html');
    if (viewMarketplaceLink) viewMarketplaceLink.href = url('marketplace/marketplace.html');
    if (qaRunPurchased) qaRunPurchased.href = url('purchased-apis/purchased-apis.html');
    if (viewPurchasedLink) viewPurchasedLink.href = url('purchased-apis/purchased-apis.html');
    if (qaUpgradePlan) qaUpgradePlan.href = url('plans/plans.html');
    if (upgradePlanLink) upgradePlanLink.href = url('plans/plans.html');

    if (qaRecordNewApi) {
        qaRecordNewApi.addEventListener('click', () => {
            if (!recordBanner) return;
            recordBanner.scrollIntoView({ behavior: 'smooth', block: 'center' });
            recordBanner.classList.add('attention-pulse');
            window.setTimeout(() => recordBanner.classList.remove('attention-pulse'), 1200);
        });
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

    let cachedSubscription = null;

    const loadDashboardData = async (authHeaders) => {
        try {
            const [subRes, apisRes] = await Promise.all([
                fetch(`${API_BASE}/subscription`, { headers: authHeaders }),
                fetch(`${API_BASE}/api/my-apis`, { headers: authHeaders })
            ]);

            if (subRes.ok) {
                const sub = await subRes.json().catch(() => ({}));
                cachedSubscription = sub;
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

    // --- Creator extras: Total Downloads / Total API Runs / Average Rating /
    // Estimated Revenue (placeholder), computed from the existing, unmodified
    // GET /marketplace and the new read-only GET /api/workflows/stats/mine. ---
    let creatorExtrasLoaded = false;
    const loadCreatorExtras = async (authHeaders) => {
        if (creatorExtrasLoaded) return;
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

            creatorExtrasLoaded = true;
        } catch (err) {
            console.error('[ForgeFlow][dashboard] failed to load creator extras', err);
        }
    };

    // --- Buyer content: stats + Purchased/Recently Used/Recommended, all
    // from existing, unmodified GET /marketplace/purchases/mine and
    // GET /marketplace — never mutates a purchase or a listing. ---
    const buildBuyerRowHtml = (it, { showRun } = {}) => `
        <div class="recent-api-row">
            <span class="recent-api-row-name">${escapeHtml(it.name)}</span>
            <span class="recent-api-row-meta">${escapeHtml(it.publisher || 'Unknown creator')}${it.purchasedAt ? ` • ${formatRelativeDate(it.purchasedAt)}` : ''}</span>
            ${showRun ? `<button type="button" class="btn btn-secondary btn-sm buyer-row-run-btn" data-endpoint="${escapeHtml(it.endpoint || '')}" data-method="${escapeHtml(it.method || 'POST')}">Run</button>` : ''}
        </div>
    `;

    const handleBuyerRowRun = async (btn) => {
        const endpoint = btn.dataset.endpoint;
        if (!endpoint) return;
        const session = await getAuthSession();
        const authHeaders = session?.token ? { Authorization: `Bearer ${session.token}` } : {};
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Running…';
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, {
                method: btn.dataset.method || 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({})
            });
            const data = await response.json().catch(() => ({}));
            alert(response.ok && data.success ? (data.message || 'Run succeeded.') : (data.message || 'Run failed.'));
        } catch (err) {
            alert(`Could not reach the backend: ${err.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = original;
        }
    };

    const wireBuyerRowRunButtons = (container) => {
        if (!container) return;
        container.querySelectorAll('.buyer-row-run-btn').forEach((btn) => {
            btn.addEventListener('click', () => handleBuyerRowRun(btn));
        });
    };

    const renderEmptyRow = (container, text) => {
        if (container) container.innerHTML = `<p class="recent-apis-empty">${escapeHtml(text)}</p>`;
    };

    let buyerDataLoaded = false;
    const loadBuyerData = async (authHeaders) => {
        if (buyerDataLoaded) return;
        try {
            const [purchasesRes, marketRes, subRes] = await Promise.all([
                fetch(`${API_BASE}/marketplace/purchases/mine`, { headers: authHeaders }),
                fetch(`${API_BASE}/marketplace`, { headers: authHeaders }),
                cachedSubscription ? Promise.resolve(null) : fetch(`${API_BASE}/subscription`, { headers: authHeaders })
            ]);

            const purchases = purchasesRes.ok ? await purchasesRes.json().catch(() => []) : [];
            const marketplace = marketRes.ok ? await marketRes.json().catch(() => []) : [];
            if (subRes && subRes.ok) cachedSubscription = await subRes.json().catch(() => cachedSubscription);

            const purchaseList = Array.isArray(purchases) ? purchases : [];

            if (buyerStatPurchased) buyerStatPurchased.textContent = String(purchaseList.length);
            if (buyerStatRuns) buyerStatRuns.textContent = String(cachedSubscription?.usage?.apiRuns ?? 0);

            const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const recentCount = purchaseList.filter((p) => p.purchasedAt && new Date(p.purchasedAt).getTime() >= sevenDaysAgo).length;
            if (buyerStatRecentPurchases) buyerStatRecentPurchases.textContent = String(recentCount);

            const categoryCounts = {};
            purchaseList.forEach((p) => {
                const slug = normalizeCategorySlug(p.category);
                categoryCounts[slug] = (categoryCounts[slug] || 0) + 1;
            });
            const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0];
            if (buyerStatFavoriteCategory) buyerStatFavoriteCategory.textContent = topCategory ? categoryLabel(topCategory[0]) : '—';

            // Purchased APIs card — alphabetical, a browsable library view.
            const byName = purchaseList.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, 4);
            if (byName.length === 0) {
                renderEmptyRow(buyerPurchasedList, 'No purchases yet — browse the Marketplace to get started.');
            } else if (buyerPurchasedList) {
                buyerPurchasedList.innerHTML = byName.map((it) => buildBuyerRowHtml(it, { showRun: true })).join('');
                wireBuyerRowRunButtons(buyerPurchasedList);
            }

            // Recently Used APIs — most recently purchased first (the best
            // available proxy for "used" until per-run history is tracked).
            const byRecency = purchaseList.slice().sort((a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt)).slice(0, 4);
            if (byRecency.length === 0) {
                renderEmptyRow(buyerRecentUsedList, 'Nothing run yet — run a purchased API to see it here.');
            } else if (buyerRecentUsedList) {
                buyerRecentUsedList.innerHTML = byRecency.map((it) => buildBuyerRowHtml(it, { showRun: true })).join('');
                wireBuyerRowRunButtons(buyerRecentUsedList);
            }

            // Recommended APIs — popular/highly-rated listings not already
            // owned, same ranking heuristic the Marketplace's "Featured" row uses.
            const purchasedIds = new Set(purchaseList.map((p) => p.id));
            const recommended = (Array.isArray(marketplace) ? marketplace : [])
                .filter((it) => !it.isOwnedByMe && !purchasedIds.has(it.id))
                .sort((a, b) => (prototypeRating(b) * ((b.purchaseCount || 0) + 1)) - (prototypeRating(a) * ((a.purchaseCount || 0) + 1)))
                .slice(0, 4);

            if (recommended.length === 0) {
                renderEmptyRow(buyerRecommendedList, 'You already own everything trending right now!');
            } else if (buyerRecommendedList) {
                buyerRecommendedList.innerHTML = recommended.map((it) => `
                    <div class="recent-api-row">
                        <span class="recent-api-row-name">${escapeHtml(it.name)}</span>
                        <span class="recent-api-row-meta">${it.price > 0 ? `$${it.price}` : 'Free'} • ${prototypeRating(it).toFixed(1)} ★</span>
                    </div>
                `).join('');
            }

            buyerDataLoaded = true;
        } catch (err) {
            console.error('[ForgeFlow][dashboard] failed to load buyer data', err);
        }
    };

    // --- Role switching ---
    const ROLE_META = {
        creator: { icon: '🚀', label: 'Creator', badge: '🚀 Creator Mode' },
        buyer: { icon: '🛒', label: 'Buyer', badge: '🛒 Buyer Mode' }
    };

    let currentUserId = null;
    let currentAuthHeaders = {};

    // Single source of truth for open/closed — every open/close path below
    // goes through these two functions, so there is only ever one state to
    // reason about (and only one dropdown instance on this page to begin
    // with). Closing is a synchronous DOM update with no dependency on the
    // async role-save call below, so it happens immediately no matter how
    // long chrome.storage.local takes to round-trip.
    let isRoleMenuOpen = false;

    const openRoleMenu = () => {
        if (!roleSwitcherMenu || isRoleMenuOpen) return;
        isRoleMenuOpen = true;
        roleSwitcherMenu.hidden = false;
        if (roleSwitcherBtn) roleSwitcherBtn.setAttribute('aria-expanded', 'true');
    };

    const closeRoleMenu = () => {
        if (!roleSwitcherMenu || !isRoleMenuOpen) return;
        isRoleMenuOpen = false;
        roleSwitcherMenu.hidden = true;
        if (roleSwitcherBtn) roleSwitcherBtn.setAttribute('aria-expanded', 'false');
    };

    const toggleRoleMenu = () => {
        if (isRoleMenuOpen) {
            closeRoleMenu();
        } else {
            openRoleMenu();
        }
    };

    // Briefly replays the same rise-fade entrance animation the mode
    // content already uses on switch, so the badge/label change reads as a
    // smooth transition rather than an instant text swap.
    const pulseRoleIndicators = () => {
        [roleBadge, roleSwitcherLabel].forEach((el) => {
            if (!el) return;
            el.classList.remove('role-indicator-pulse');
            // Force a reflow so removing+re-adding the class restarts the
            // animation even if it was already mid-flight.
            void el.offsetWidth;
            el.classList.add('role-indicator-pulse');
        });
    };

    const applyRole = (role) => {
        const resolved = role === 'buyer' ? 'buyer' : 'creator';
        const meta = ROLE_META[resolved];

        if (roleBadge) roleBadge.textContent = meta.badge;
        if (roleSwitcherLabel) roleSwitcherLabel.textContent = `Current Mode: ${meta.icon} ${meta.label}`;
        pulseRoleIndicators();
        if (topbarSubtitle) {
            topbarSubtitle.textContent = resolved === 'creator'
                ? 'Creator mode — record workflows, publish APIs, and track performance.'
                : 'Buyer mode — browse, purchase, and run Marketplace APIs.';
        }

        const showCreator = resolved === 'creator';
        if (creatorModeContent) {
            creatorModeContent.hidden = !showCreator;
            creatorModeContent.classList.toggle('mode-content--visible', showCreator);
        }
        if (buyerModeContent) {
            buyerModeContent.hidden = showCreator;
            buyerModeContent.classList.toggle('mode-content--visible', !showCreator);
        }

        if (showCreator) {
            loadCreatorExtras(currentAuthHeaders);
        } else {
            loadBuyerData(currentAuthHeaders);
        }
    };

    const switchRole = async (role) => {
        if (!currentUserId || !window.ForgeFlowRoles) return;
        // Update the UI and close the menu right away — persisting the
        // choice happens in the background and shouldn't gate how quickly
        // the dropdown responds to the click that just happened.
        applyRole(role);
        closeRoleMenu();
        await window.ForgeFlowRoles.setRole(currentUserId, role);
    };

    if (roleSwitcherBtn) {
        roleSwitcherBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleRoleMenu();
        });
    }

    document.querySelectorAll('.role-switcher-option').forEach((btn) => {
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            switchRole(btn.dataset.roleChoice);
        });
    });

    document.addEventListener('click', (event) => {
        if (isRoleMenuOpen && roleSwitcherGroup && !roleSwitcherGroup.contains(event.target)) {
            closeRoleMenu();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isRoleMenuOpen) {
            closeRoleMenu();
            roleSwitcherBtn?.focus();
        }
    });

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
                creatorExtrasLoaded = false;
                loadCreatorExtras({ Authorization: `Bearer ${session.token}` });
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
            applyRole('creator');
            return;
        }

        currentUserId = session.user?.id || null;
        currentAuthHeaders = { Authorization: `Bearer ${session.token}` };

        // First-time experience: a logged-in user who has never chosen a
        // role gets the onboarding screen instead of the Dashboard. Once
        // they choose, shared/roles.js remembers it and this never fires
        // again for that account.
        if (currentUserId && window.ForgeFlowRoles) {
            const chosen = await window.ForgeFlowRoles.hasChosenRole(currentUserId);
            if (!chosen) {
                window.location.href = url('onboarding/onboarding.html');
                return;
            }
        }

        await loadDashboardData(currentAuthHeaders);

        if (roleSwitcherGroup) roleSwitcherGroup.hidden = false;
        const role = currentUserId && window.ForgeFlowRoles ? await window.ForgeFlowRoles.getRole(currentUserId) : 'creator';
        applyRole(role);

        if (currentUserId && window.ForgeFlowRoles) {
            window.ForgeFlowRoles.onRoleChange(currentUserId, (nextRole) => applyRole(nextRole));
        }
    })();
});
