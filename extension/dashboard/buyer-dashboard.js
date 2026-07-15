/**
 * buyer-dashboard.js
 * Buyer Hub — browsing, purchasing, and running Marketplace APIs, with zero
 * creator content. Landing on this page always means "buyer mode now" — it
 * sets the role (idempotent) rather than gating/redirecting on it, since
 * Mode Selection (extension/mode-select/) is the only screen that ever asks
 * the user to choose. See shared/roles.js for where the preference itself
 * lives.
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

document.addEventListener('DOMContentLoaded', () => {
    const authNote = document.getElementById('auth-note');
    const qaBrowseMarketplace = document.getElementById('qa-browse-marketplace');
    const qaRunPurchased = document.getElementById('qa-run-purchased');
    const qaPurchaseHistory = document.getElementById('qa-purchase-history');
    const marketplaceLink = document.getElementById('marketplace-link');
    const viewPurchasedLink = document.getElementById('view-purchased-link');
    const viewMarketplaceLink = document.getElementById('view-marketplace-link');
    const viewHistoryLink = document.getElementById('view-history-link');
    const modeSwitchLink = document.getElementById('mode-switch-link');

    const buyerPurchasedList = document.getElementById('buyer-purchased-list');
    const buyerRecentUsedList = document.getElementById('buyer-recent-used-list');
    const buyerRecommendedList = document.getElementById('buyer-recommended-list');
    const historyTotal = document.getElementById('history-total');
    const historyRecent = document.getElementById('history-recent');

    const quickRunSelect = document.getElementById('quick-run-select');
    const quickRunBtn = document.getElementById('quick-run-btn');
    const quickRunResult = document.getElementById('quick-run-result');

    const url = (path) => (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
        ? chrome.runtime.getURL(path)
        : '#';

    if (marketplaceLink) marketplaceLink.href = url('marketplace/marketplace.html');
    if (qaBrowseMarketplace) qaBrowseMarketplace.href = url('marketplace/marketplace.html');
    if (viewMarketplaceLink) viewMarketplaceLink.href = url('marketplace/marketplace.html');
    if (qaRunPurchased) qaRunPurchased.href = url('purchased-apis/purchased-apis.html');
    if (viewPurchasedLink) viewPurchasedLink.href = url('purchased-apis/purchased-apis.html');
    if (qaPurchaseHistory) qaPurchaseHistory.href = url('my-purchases/my-purchases.html');
    if (viewHistoryLink) viewHistoryLink.href = url('my-purchases/my-purchases.html');

    let authHeaders = {};

    const renderEmptyRow = (container, text) => {
        if (container) container.innerHTML = `<p class="recent-apis-empty">${escapeHtml(text)}</p>`;
    };

    const buildBuyerRowHtml = (it, { showRun } = {}) => `
        <div class="recent-api-row">
            <span class="recent-api-row-name">${escapeHtml(it.name)}</span>
            <span class="recent-api-row-meta">${escapeHtml(it.publisher || 'Unknown creator')}${it.purchasedAt ? ` • ${formatRelativeDate(it.purchasedAt)}` : ''}</span>
            ${showRun ? `<button type="button" class="btn btn-secondary btn-sm buyer-row-run-btn" data-endpoint="${escapeHtml(it.endpoint || '')}" data-method="${escapeHtml(it.method || 'POST')}">Run</button>` : ''}
        </div>
    `;

    const runEndpoint = async (endpoint, method, resultEl) => {
        if (!endpoint) return;
        if (resultEl) {
            resultEl.hidden = false;
            resultEl.textContent = 'Running…';
        }
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, {
                method: method || 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({})
            });
            const data = await response.json().catch(() => ({}));
            const message = response.ok && data.success ? (data.message || 'Run succeeded.') : (data.message || 'Run failed.');
            if (resultEl) {
                resultEl.textContent = message;
            } else {
                alert(message);
            }
        } catch (err) {
            const message = `Could not reach the backend: ${err.message}`;
            if (resultEl) {
                resultEl.textContent = message;
            } else {
                alert(message);
            }
        }
    };

    const handleBuyerRowRun = async (btn) => {
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Running…';
        await runEndpoint(btn.dataset.endpoint, btn.dataset.method, null);
        btn.disabled = false;
        btn.textContent = original;
    };

    const wireBuyerRowRunButtons = (container) => {
        if (!container) return;
        container.querySelectorAll('.buyer-row-run-btn').forEach((btn) => {
            btn.addEventListener('click', () => handleBuyerRowRun(btn));
        });
    };

    // --- Quick Run: pick any purchased API from a dropdown and run it in
    // place, same POST-to-endpoint pattern as the row-level Run buttons. ---
    let quickRunItems = [];

    const populateQuickRun = (purchases) => {
        quickRunItems = purchases.filter((p) => p.endpoint);
        if (!quickRunSelect) return;

        if (quickRunItems.length === 0) {
            quickRunSelect.innerHTML = '<option value="">No purchased APIs yet</option>';
            quickRunSelect.disabled = true;
            if (quickRunBtn) quickRunBtn.disabled = true;
            return;
        }

        quickRunSelect.disabled = false;
        quickRunSelect.innerHTML = '<option value="">Select a purchased API…</option>' +
            quickRunItems.map((it, idx) => `<option value="${idx}">${escapeHtml(it.name)}</option>`).join('');
    };

    if (quickRunSelect) {
        quickRunSelect.addEventListener('change', () => {
            if (quickRunBtn) quickRunBtn.disabled = quickRunSelect.value === '';
        });
    }

    if (quickRunBtn) {
        quickRunBtn.addEventListener('click', async () => {
            const idx = Number(quickRunSelect?.value);
            const item = quickRunItems[idx];
            if (!item) return;
            quickRunBtn.disabled = true;
            await runEndpoint(item.endpoint, item.method, quickRunResult);
            quickRunBtn.disabled = false;
        });
    }

    let buyerDataLoaded = false;
    const loadBuyerData = async () => {
        if (buyerDataLoaded) return;
        try {
            const [purchasesRes, marketRes] = await Promise.all([
                fetch(`${API_BASE}/marketplace/purchases/mine`, { headers: authHeaders }),
                fetch(`${API_BASE}/marketplace`, { headers: authHeaders })
            ]);

            const purchases = purchasesRes.ok ? await purchasesRes.json().catch(() => []) : [];
            const marketplace = marketRes.ok ? await marketRes.json().catch(() => []) : [];
            const purchaseList = Array.isArray(purchases) ? purchases : [];

            populateQuickRun(purchaseList);

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

            // Purchase History summary — same fetch, just totals + most recent.
            if (historyTotal) historyTotal.textContent = String(purchaseList.length);
            if (historyRecent) {
                const mostRecent = byRecency[0];
                historyRecent.textContent = mostRecent ? formatDate(mostRecent.purchasedAt) : '—';
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
            console.error('[ForgeFlow][buyer-dashboard] failed to load buyer data', err);
        }
    };

    (async () => {
        const session = await getAuthSession();
        if (!session?.token) {
            if (authNote) {
                authNote.hidden = false;
                authNote.textContent = 'Log in from the ForgeFlow extension popup to see your purchases.';
            }
            renderEmptyRow(buyerPurchasedList, 'Log in to see your purchases.');
            renderEmptyRow(buyerRecentUsedList, 'Log in to see recently used APIs.');
            renderEmptyRow(buyerRecommendedList, 'Log in to see recommendations.');
            return;
        }

        const userId = session.user?.id || null;
        authHeaders = { Authorization: `Bearer ${session.token}` };

        // Landing here always means "buyer mode now" — no redirect/guard,
        // Mode Selection is the only screen that ever asks.
        if (userId && window.ForgeFlowRoles) {
            window.ForgeFlowRoles.setRole(userId, 'buyer');
        }

        if (modeSwitchLink) {
            modeSwitchLink.addEventListener('click', async (event) => {
                event.preventDefault();
                if (userId && window.ForgeFlowRoles) {
                    await window.ForgeFlowRoles.setRole(userId, 'creator');
                }
                window.location.href = url('dashboard/creator-dashboard.html');
            });
        }

        await loadBuyerData();
    })();
});
