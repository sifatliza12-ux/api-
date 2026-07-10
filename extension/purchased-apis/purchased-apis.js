/**
 * purchased-apis.js
 * Dedicated "Purchased APIs" tab — the library of every API a user owns
 * (bought or free), separate from the Marketplace browsing page. Populated
 * automatically by GET /marketplace/purchases/mine, the same endpoint the
 * Marketplace page's purchase flow already writes to via
 * POST /marketplace/:id/purchase — buying something in the Marketplace is
 * what makes it show up here, nothing on this page performs a purchase
 * itself.
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

const formatDate = (iso) => {
    if (!iso) return 'Unknown';
    try {
        return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
        return 'Unknown';
    }
};

const fetchJson = async (url, opts = {}) => {
    const response = await fetch(url, opts);
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
};

const getAuthSession = () => new Promise((resolve) => {
    chrome.storage.local.get(AUTH_STORAGE_KEY, (result) => {
        resolve(result?.[AUTH_STORAGE_KEY] || null);
    });
});

const MARKETPLACE_CATEGORY_LABELS = {
    all: 'All',
    productivity: 'Productivity',
    travel: 'Travel',
    finance: 'Finance',
    shopping: 'Shopping',
    education: 'Education',
    entertainment: 'Entertainment',
    'social-media': 'Social Media',
    other: 'Other'
};

const CATEGORY_ALIASES = {
    productivity: 'productivity',
    travel: 'travel',
    finance: 'finance',
    shopping: 'shopping',
    ecommerce: 'shopping',
    education: 'education',
    entertainment: 'entertainment',
    social: 'social-media',
    'social-media': 'social-media',
    'social media': 'social-media'
};

const normalizeCategorySlug = (raw) => {
    const key = String(raw || '').trim().toLowerCase();
    return CATEGORY_ALIASES[key] || 'other';
};

const categoryLabel = (slug) => MARKETPLACE_CATEGORY_LABELS[slug] || 'Other';

const isFreeItem = (it) => !!it.free || !it.price || Number(it.price) === 0;

document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('refresh-btn');
    const authNote = document.getElementById('auth-note');
    const purchasedGrid = document.getElementById('purchased-grid');
    const purchasedResultCount = document.getElementById('purchased-result-count');

    let purchasedItems = [];
    let authHeaders = {};

    const buildRunResultHtml = (data) => {
        const statusLine = `<p class="run-status">✓ ${escapeHtml(data.message || 'Run succeeded.')}</p>`;
        const items = Array.isArray(data.data) ? data.data : [];
        const resultsHtml = items.length
            ? `<div class="result-cards">${items.map((item) => {
                const rows = Object.entries(item || {}).map(([key, value]) => `
                    <div class="result-row">
                        <span class="result-row-label">${escapeHtml(key)}</span>
                        <span class="result-row-value">${escapeHtml(value === null || value === undefined || value === '' ? '—' : String(value))}</span>
                    </div>
                `).join('');
                return `<div class="result-card">${rows}</div>`;
            }).join('')}</div>`
            : '<p class="run-empty-note">Workflow ran successfully, but no results were extracted from the final page.</p>';
        return `${statusLine}${resultsHtml}`;
    };

    const handleRunApi = async (item) => {
        if (!item.endpoint) {
            alert('This API does not have a runnable endpoint yet.');
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <h3>Run ${escapeHtml(item.name)}</h3>
            <div class="modal-scroll-body">
                <p>Running with the workflow's recorded default values.</p>
                <div class="run-result" style="display:none"></div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary modal-close">Close</button>
            </div>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        const resultEl = overlay.querySelector('.run-result');
        resultEl.style.display = 'block';
        resultEl.textContent = 'Running…';

        try {
            const response = await fetch(`${API_BASE}${item.endpoint}`, {
                method: item.method || 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({})
            });
            const data = await response.json().catch(() => ({}));

            if (response.ok && data.success) {
                resultEl.className = 'run-result run-result--success';
                resultEl.innerHTML = buildRunResultHtml(data);
            } else {
                resultEl.className = 'run-result run-result--error';
                resultEl.textContent = `✗ ${data.message || `Run failed (HTTP ${response.status}).`}`;
            }
        } catch (err) {
            resultEl.className = 'run-result run-result--error';
            resultEl.textContent = `✗ Could not reach the backend: ${err.message}`;
        }
    };

    // API Details — a modal, same pattern as My APIs' "View API" and the
    // Marketplace's card-click detail view, so every "open the details" affordance
    // in the app behaves the same way and always has an obvious way out
    // (the Close button) rather than navigating to a page that could strand
    // the user.
    const openDetailsModal = (item) => {
        const free = isFreeItem(item);
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <h3>${escapeHtml(item.name)}</h3>
            <div class="modal-scroll-body">
                <div class="modal-badges">
                    <span class="badge badge-category">${escapeHtml(categoryLabel(normalizeCategorySlug(item.category)))}</span>
                    <span class="badge ${free ? 'badge-free' : 'badge-paid'}">${free ? 'Free' : 'Premium'}</span>
                    <span class="badge badge-owned">Owned</span>
                </div>
                <p>${escapeHtml(item.description || 'No description provided.')}</p>
                <p><strong>Method:</strong> ${escapeHtml(item.method || '')} • <strong>Version:</strong> ${escapeHtml(item.version || '')}</p>
                <p><strong>Creator:</strong> ${escapeHtml(item.publisher || 'Unknown')} • <strong>Price Paid:</strong> ${free ? 'Free' : `$${item.price}`}</p>
                <p><strong>Purchase Date:</strong> ${formatDate(item.purchasedAt)} (${formatRelativeDate(item.purchasedAt)})</p>
            </div>
            <div class="modal-actions">
                <button class="btn btn-primary run-api">Run API</button>
                <button class="btn btn-secondary modal-close">Close</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        overlay.querySelector('.run-api').addEventListener('click', () => handleRunApi(item));
    };

    const buildPurchasedCardHtml = (it) => `
        <div class="market-card-top">
            <div class="market-card-heading">
                <h3>${escapeHtml(it.name)}</h3>
                <div class="market-badges">
                    <span class="badge badge-category">${escapeHtml(categoryLabel(normalizeCategorySlug(it.category)))}</span>
                    <span class="badge badge-owned">Owned</span>
                </div>
            </div>
        </div>
        <p class="market-card-description">${escapeHtml(it.description || 'No description provided.')}</p>
        <div class="market-meta market-meta--rich">
            <span class="market-meta-item" title="Creator">👤 ${escapeHtml(it.publisher || 'Unknown')}</span>
            <span class="market-meta-item" title="Purchase date">🗓 Purchased ${formatDate(it.purchasedAt)}</span>
        </div>
        <div class="market-card-actions">
            <button type="button" class="btn btn-primary purchased-run-btn">Run API</button>
            <button type="button" class="btn btn-secondary purchased-details-btn">API Details</button>
        </div>
    `;

    const renderPurchased = (items) => {
        if (!purchasedGrid) return;

        if (purchasedResultCount) {
            purchasedResultCount.textContent = items.length ? `${items.length} API${items.length === 1 ? '' : 's'}` : '';
        }

        if (items.length === 0) {
            purchasedGrid.innerHTML = `
                <div class="marketplace-empty">
                    <div class="marketplace-empty-icon" aria-hidden="true">🛒</div>
                    <h3>No purchases yet.</h3>
                    <p>APIs you purchase from the Marketplace will show up here, ready to run.</p>
                </div>
            `;
            return;
        }

        purchasedGrid.innerHTML = '';
        items.forEach((it) => {
            const card = document.createElement('article');
            card.className = 'market-card';
            card.dataset.id = it.id;
            card.innerHTML = buildPurchasedCardHtml(it);
            card.querySelector('.purchased-run-btn').addEventListener('click', (event) => {
                event.stopPropagation();
                handleRunApi(it);
            });
            card.querySelector('.purchased-details-btn').addEventListener('click', (event) => {
                event.stopPropagation();
                openDetailsModal(it);
            });
            card.addEventListener('click', () => openDetailsModal(it));
            purchasedGrid.appendChild(card);
        });
    };

    const renderSkeleton = () => {
        if (!purchasedGrid) return;
        purchasedGrid.innerHTML = Array.from({ length: 3 }).map(() => `
            <div class="market-card market-card--skeleton" aria-hidden="true">
                <div class="skeleton-line skeleton-line--title"></div>
                <div class="skeleton-line skeleton-line--desc"></div>
                <div class="skeleton-line skeleton-line--desc" style="width:60%"></div>
                <div class="skeleton-line skeleton-line--pill"></div>
            </div>
        `).join('');
    };

    const loadPurchased = async () => {
        renderSkeleton();
        try {
            const { ok, data } = await fetchJson(`${API_BASE}/marketplace/purchases/mine`, { headers: authHeaders });
            purchasedItems = ok && Array.isArray(data) ? data : [];
            renderPurchased(purchasedItems);
        } catch (err) {
            console.error('[ForgeFlow][purchased-apis] load error', err);
            purchasedItems = [];
            renderPurchased(purchasedItems);
        }
    };

    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadPurchased);
    }

    (async () => {
        const session = await getAuthSession();
        if (!session?.token) {
            if (authNote) {
                authNote.hidden = false;
                authNote.textContent = 'Log in from the ForgeFlow extension popup to see your purchased APIs.';
            }
            renderPurchased([]);
            return;
        }

        authHeaders = { Authorization: `Bearer ${session.token}` };
        loadPurchased();
    })();
});
