/**
 * marketplace.js
 * Dedicated, full-viewport Marketplace page — opened as its own extension
 * tab from the popup launcher so it has real room for cards, filters, and
 * whatever else lands here later, instead of being squeezed into the 390px
 * popup.
 *
 * ForgeFlow is an API marketplace, not an app store: every listing goes
 * through Purchase -> Owned -> Run API. Purchasing is simulated (no payment
 * gateway yet), but the state itself is real and backend-persisted, so
 * wiring in real payments later only changes what happens before a
 * purchase is recorded, not this state machine.
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

// Fixed marketplace taxonomy shown in the category chips — a static
// product decision, not something derived from any particular API.
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

// Maps whatever category string a listing actually has (older seed data
// uses "social"/"automation"/"ecommerce", freshly-published APIs default
// to "all") onto the fixed taxonomy above. Purely a value-based lookup —
// never keyed on an API's name — so it works the same for any listing,
// demo or real.
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

// The backend doesn't track real ratings yet, so this is still a stable
// "prototype" number derived from each listing's own id — deterministic and
// generic, not hardcoded to specific demo APIs. Purchase count, by
// contrast, is now real (see loadMarketplaceItems) and used instead of a
// fake install count.
const seededFraction = (seed) => {
    const x = Math.sin(seed * 999331) * 10000;
    return x - Math.floor(x);
};

const getPrototypeStats = (item) => {
    const seed = Number(item.id) || 1;
    const rating = Math.round((3.6 + seededFraction(seed) * 1.4) * 10) / 10; // 3.6–5.0
    return { rating };
};

const formatCount = (n) => {
    const num = Number(n) || 0;
    if (num >= 1000) return `${(num / 1000).toFixed(num % 1000 >= 100 ? 1 : 0)}k`;
    return String(num);
};

const renderStars = (rating) => {
    const full = Math.min(5, Math.max(0, Math.round(rating)));
    return '★'.repeat(full) + '☆'.repeat(5 - full);
};

const isFreeItem = (it) => !!it.free || !it.price || Number(it.price) === 0;

// Complexity tiers mirror the price bands explained on the Plans & Pricing
// page (extension/plans/plans.html) — simple automations are priced $1–5,
// medium $5–10, complex $10–20, enterprise $20+. Real per-workflow
// complexity scoring (step count, page count, login detection, etc.)
// doesn't exist in the backend yet, so this is a display-time inference
// from price — generic across every listing since it never looks at an
// API's name, just its price.
const COMPLEXITY_TIERS = [
    { slug: 'simple', label: 'Simple', max: 5 },
    { slug: 'medium', label: 'Medium', max: 10 },
    { slug: 'complex', label: 'Complex', max: 20 },
    { slug: 'enterprise', label: 'Enterprise', max: Infinity }
];

const getComplexityTier = (item) => {
    const price = Number(item.price) || 0;
    return COMPLEXITY_TIERS.find((tier) => price <= tier.max) || COMPLEXITY_TIERS[COMPLEXITY_TIERS.length - 1];
};

// Popular/Trending are engagement badges. Popular now reads off the real
// purchase count; Trending still leans on the prototype rating (no real
// rating data exists yet) combined with real purchases.
const POPULAR_PURCHASE_THRESHOLD = 5;
const TRENDING_RATING_THRESHOLD = 4.7;
const TRENDING_PURCHASE_THRESHOLD = 2;

const getEngagementBadges = (item) => {
    const stats = getPrototypeStats(item);
    const purchaseCount = Number(item.purchaseCount) || 0;
    const badges = [];
    if (purchaseCount >= POPULAR_PURCHASE_THRESHOLD) {
        badges.push({ slug: 'popular', label: '🔥 Popular' });
    }
    if (stats.rating >= TRENDING_RATING_THRESHOLD && purchaseCount >= TRENDING_PURCHASE_THRESHOLD) {
        badges.push({ slug: 'trending', label: '📈 Trending' });
    }
    return badges;
};

document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('refresh-btn');
    const marketplaceSearch = document.getElementById('marketplace-search');
    const marketplaceFilter = document.getElementById('marketplace-filter');
    const marketplaceSort = document.getElementById('marketplace-sort');
    const marketplaceList = document.getElementById('marketplace-list');
    const marketplaceFeaturedSection = document.getElementById('marketplace-featured-section');
    const marketplaceFeatured = document.getElementById('marketplace-featured');
    const marketplaceResultCount = document.getElementById('marketplace-result-count');
    const categoryChipsRow = document.getElementById('marketplace-category-chips');
    const purchasedApisFooterLink = document.getElementById('purchased-apis-footer-link');

    if (purchasedApisFooterLink && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        purchasedApisFooterLink.href = chrome.runtime.getURL('purchased-apis/purchased-apis.html');
    }

    let marketplaceItems = [];
    let activeCategory = 'all';
    let currentUser = null;
    let authHeaders = {};

    const isLoggedIn = () => Boolean(authHeaders.Authorization);

    // --- Card action state: every listing is in exactly one of these ---
    // Paid items go through the manual-approval purchase-request workflow
    // (see handlePurchase/openPurchaseDialog below), so a pending request
    // shows "Pending Approval" instead of "Buy" until the creator resolves
    // it. Free items never produce a purchase request — they stay on the
    // original 'run'/'purchase' pair.
    const getCardAction = (it) => {
        if (isLoggedIn() && it.isOwnedByMe) return 'creator';
        if (isLoggedIn() && it.isPurchasedByMe) return 'run';
        if (isLoggedIn() && it.myPurchaseRequestStatus === 'pending') return 'pending';
        if (isLoggedIn() && it.myPurchaseRequestStatus === 'verification_required') return 'verification_required';
        if (isLoggedIn() && it.myPurchaseRequestStatus === 'rejected') return 'rejected';
        return 'purchase';
    };

    const PURCHASE_REQUEST_STATUS_LABELS = {
        pending: 'Pending Approval',
        verification_required: 'Verification Required',
        rejected: 'Purchase Rejected'
    };

    const buildMarketCardHtml = (it) => {
        const stats = getPrototypeStats(it);
        const free = isFreeItem(it);
        const catSlug = normalizeCategorySlug(it.category);
        const complexity = getComplexityTier(it);
        const engagementBadgesHtml = getEngagementBadges(it)
            .map((b) => `<span class="badge badge-${b.slug}">${b.label}</span>`)
            .join('');
        const priceLabel = free ? 'Free' : `$${it.price}`;
        const action = getCardAction(it);

        const actionButtonHtml = action === 'creator'
            ? `<div class="market-card-actions">
                    <button type="button" class="btn btn-secondary market-edit-btn">Edit</button>
                    <button type="button" class="btn btn-secondary market-analytics-btn">Analytics</button>
               </div>`
            : action === 'run'
                ? `<button type="button" class="btn btn-primary market-run-btn">Run API</button>`
                : action === 'pending'
                    ? `<button type="button" class="btn btn-secondary" disabled>Pending Approval</button>`
                    : action === 'verification_required'
                        ? `<button type="button" class="btn btn-secondary market-verify-btn">Verification Required</button>`
                        : action === 'rejected'
                            ? `<button type="button" class="btn btn-primary market-buy-btn">Purchase Rejected — Try Again</button>`
                            : `<button type="button" class="btn btn-primary market-buy-btn">${free ? 'Get for Free' : `Buy for $${it.price}`}</button>`;

        const ownerBadgeHtml = action === 'creator'
            ? '<span class="badge badge-owner">Your Listing</span>'
            : action === 'run'
                ? '<span class="badge badge-owned">Owned</span>'
                : (action === 'pending' || action === 'verification_required' || action === 'rejected')
                    ? `<span class="badge badge-status-${action}">${PURCHASE_REQUEST_STATUS_LABELS[action]}</span>`
                    : '';

        return `
            <div class="market-card-top">
                <div class="market-card-heading">
                    <h3>${escapeHtml(it.name)}</h3>
                    <div class="market-badges">
                        <span class="badge badge-category">${escapeHtml(categoryLabel(catSlug))}</span>
                        <span class="badge badge-complexity-${complexity.slug}">${complexity.label}</span>
                        <span class="badge ${free ? 'badge-free' : 'badge-paid'}">${free ? 'Free' : 'Premium'}</span>
                        ${ownerBadgeHtml}
                        ${engagementBadgesHtml}
                    </div>
                </div>
                <span class="market-price ${free ? 'market-price--free' : ''}">${priceLabel}</span>
            </div>
            <p class="market-card-description">${escapeHtml(it.description || 'No description provided.')}</p>
            <div class="market-meta market-meta--rich">
                <span class="market-meta-item" title="Creator">👤 ${escapeHtml(it.publisher || 'Unknown')}</span>
                <span class="market-meta-item" title="Published">🕐 ${formatRelativeDate(it.createdAt)}</span>
            </div>
            <div class="market-stats">
                <span class="market-stat" title="${stats.rating.toFixed(1)} out of 5">
                    <span class="market-stars" aria-hidden="true">${renderStars(stats.rating)}</span>
                    <span class="market-stat-value">${stats.rating.toFixed(1)}</span>
                </span>
                <span class="market-stat" title="${it.purchaseCount || 0} purchases">🛒 ${formatCount(it.purchaseCount)}</span>
            </div>
            ${actionButtonHtml}
        `;
    };

    const requireLogin = (message) => {
        alert(message || 'Log in from the ForgeFlow extension popup first.');
    };

    // Free items: unchanged instant "charge and grant" — nothing about this
    // path changed by the manual-approval workflow below. Paid items now
    // open the Purchase dialog instead of buying instantly.
    const handlePurchase = async (item, onDone, btn) => {
        if (!isLoggedIn()) {
            requireLogin('Log in from the ForgeFlow extension popup to purchase Marketplace APIs.');
            return;
        }

        if (!isFreeItem(item)) {
            openPurchaseDialog(item, onDone);
            return;
        }

        if (btn) btn.disabled = true;
        try {
            const resp = await fetch(`${API_BASE}/marketplace/${item.id}/purchase`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders }
            });
            const data = await resp.json().catch(() => ({}));

            if (!resp.ok) {
                alert(data.message || 'Purchase failed. Please try again.');
                if (btn) btn.disabled = false;
                return;
            }

            const idx = marketplaceItems.findIndex((m) => m.id === item.id);
            if (idx !== -1) {
                marketplaceItems[idx].isPurchasedByMe = true;
                marketplaceItems[idx].purchaseCount = (marketplaceItems[idx].purchaseCount || 0) + 1;
            }

            alert(data.message || 'Added to your library.');
            applyMarketplaceFilters();
            if (onDone) onDone();
        } catch (err) {
            console.error('[ForgeFlow][marketplace] purchase failed', err);
            alert('Could not reach the ForgeFlow server. Please try again.');
            if (btn) btn.disabled = false;
        }
    };

    // --- Purchase dialog (manual-approval flow for paid items) ---

    const PAYMENT_METHODS = [
        { value: 'bkash', label: 'bKash', instructions: 'Send Money to 01700-000000 (Personal), then enter the Transaction ID shown in your bKash confirmation SMS.' },
        { value: 'nagad', label: 'Nagad', instructions: 'Send Money to 01700-000000 (Personal), then enter the Transaction ID shown in your Nagad confirmation SMS.' },
        { value: 'rocket', label: 'Rocket', instructions: 'Send Money to 01700-000000-1 (Personal), then enter the Transaction ID shown in your Rocket confirmation SMS.' },
        { value: 'bank_transfer', label: 'Bank Transfer', instructions: 'Transfer to ForgeFlow Ltd., Account No. 0000-1111-2222, DBBL. Enter the transfer reference/transaction ID from your bank receipt.' }
    ];

    const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;

    const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });

    const openPurchaseDialog = (item, onDone) => {
        let selectedMethod = PAYMENT_METHODS[0].value;
        let screenshotDataUrl = null;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <h3>Purchase ${escapeHtml(item.name)}</h3>
            <div class="modal-scroll-body">
                <p><strong>Creator:</strong> ${escapeHtml(item.publisher || 'Unknown')} • <strong>Price:</strong> $${item.price}</p>

                <div class="form-field">
                    <span class="form-field-label">Payment Method</span>
                    <div class="payment-method-grid" id="pd-method-grid">
                        ${PAYMENT_METHODS.map((m, i) => `<button type="button" class="payment-method-option${i === 0 ? ' active' : ''}" data-method="${m.value}">${m.label}</button>`).join('')}
                    </div>
                </div>

                <p class="payment-instructions" id="pd-instructions">${escapeHtml(PAYMENT_METHODS[0].instructions)}</p>

                <div class="form-field">
                    <label class="form-field-label" for="pd-transaction-id">Transaction ID <span aria-hidden="true">*</span></label>
                    <input type="text" id="pd-transaction-id" class="form-input" placeholder="e.g. 8N7A3XZ9K1" required>
                </div>

                <div class="form-field">
                    <span class="form-field-label">Payment Screenshot (optional)</span>
                    <input type="file" id="pd-screenshot" class="form-input" accept="image/*">
                    <span class="form-field-hint">Up to 3MB. Helps the creator verify your payment faster.</span>
                    <img id="pd-screenshot-preview" class="screenshot-preview" style="display:none" alt="Screenshot preview">
                </div>

                <div class="form-field">
                    <label class="form-field-label" for="pd-note">Note to Creator (optional)</label>
                    <textarea id="pd-note" class="form-textarea" placeholder="Anything the creator should know about this payment..."></textarea>
                </div>

                <p class="form-field-hint" id="pd-error" style="color:#fecaca; display:none"></p>
            </div>
            <div class="modal-actions">
                <button class="btn btn-primary" id="pd-submit">Submit Purchase Request</button>
                <button class="btn btn-secondary modal-close">Cancel</button>
            </div>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        const methodGrid = overlay.querySelector('#pd-method-grid');
        const instructionsEl = overlay.querySelector('#pd-instructions');
        methodGrid.querySelectorAll('.payment-method-option').forEach((btn) => {
            btn.addEventListener('click', () => {
                selectedMethod = btn.dataset.method;
                methodGrid.querySelectorAll('.payment-method-option').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                const method = PAYMENT_METHODS.find((m) => m.value === selectedMethod);
                instructionsEl.textContent = method ? method.instructions : '';
            });
        });

        const screenshotInput = overlay.querySelector('#pd-screenshot');
        const screenshotPreview = overlay.querySelector('#pd-screenshot-preview');
        const errorEl = overlay.querySelector('#pd-error');

        screenshotInput.addEventListener('change', async () => {
            const file = screenshotInput.files && screenshotInput.files[0];
            if (!file) { screenshotDataUrl = null; screenshotPreview.style.display = 'none'; return; }
            if (file.size > MAX_SCREENSHOT_BYTES) {
                errorEl.textContent = 'Screenshot is too large. Please choose an image under 3MB.';
                errorEl.style.display = 'block';
                screenshotInput.value = '';
                screenshotDataUrl = null;
                screenshotPreview.style.display = 'none';
                return;
            }
            errorEl.style.display = 'none';
            screenshotDataUrl = await readFileAsDataUrl(file);
            screenshotPreview.src = screenshotDataUrl;
            screenshotPreview.style.display = 'block';
        });

        const submitBtn = overlay.querySelector('#pd-submit');
        submitBtn.addEventListener('click', async () => {
            const transactionId = overlay.querySelector('#pd-transaction-id').value.trim();
            const buyerNote = overlay.querySelector('#pd-note').value.trim();

            if (!transactionId) {
                errorEl.textContent = 'Transaction ID is required.';
                errorEl.style.display = 'block';
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Submitting…';

            try {
                const resp = await fetch(`${API_BASE}/marketplace/${item.id}/purchase-request`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({
                        paymentMethod: selectedMethod,
                        transactionId,
                        screenshot: screenshotDataUrl,
                        buyerNote
                    })
                });
                const data = await resp.json().catch(() => ({}));

                if (!resp.ok) {
                    errorEl.textContent = data.message || 'Could not submit purchase request. Please try again.';
                    errorEl.style.display = 'block';
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Submit Purchase Request';
                    return;
                }

                const idx = marketplaceItems.findIndex((m) => m.id === item.id);
                if (idx !== -1) {
                    marketplaceItems[idx].myPurchaseRequestStatus = 'pending';
                }
                applyMarketplaceFilters();
                overlay.remove();
                alert(data.message || 'Purchase request submitted. The creator will review it shortly.');
                if (onDone) onDone();
            } catch (err) {
                console.error('[ForgeFlow][marketplace] purchase-request failed', err);
                errorEl.textContent = 'Unable to reach the ForgeFlow backend. Please try again.';
                errorEl.style.display = 'block';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Submit Purchase Request';
            }
        });
    };

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

    const handleRunApi = async (item, btn) => {
        if (!isLoggedIn()) {
            requireLogin('Log in from the ForgeFlow extension popup to run purchased APIs.');
            return;
        }
        if (!item.endpoint) {
            alert('This API does not have a runnable endpoint yet.');
            return;
        }

        // Disabled for the duration of the run so a rapid double-click can't
        // open two modals / fire two concurrent runs; re-enabled once the
        // modal is up and dismissible on its own.
        if (btn) btn.disabled = true;

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
        if (btn) btn.disabled = false;

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
            resultEl.textContent = '✗ Could not reach the ForgeFlow server. Please try again.';
        }
    };

    const openAnalyticsView = (item) => {
        const revenue = (Number(item.purchaseCount) || 0) * (Number(item.price) || 0);
        alert(
            `Analytics for "${item.name}"\n\n` +
            `Purchases: ${item.purchaseCount || 0}\n` +
            `Price: ${isFreeItem(item) ? 'Free' : `$${item.price}`}\n` +
            `Simulated revenue: $${revenue.toFixed(2)}\n\n` +
            `(Real payment analytics will replace this once payment processing launches.)`
        );
    };

    // "Edit" — a creator changing the listing's name/description shown to
    // buyers. Price is a Creator-mode-only action now (see "Update Price"
    // on extension/my-apis/my-apis.js) — this Marketplace page is the
    // Buyer-mode destination (see shared/nav.js), so buyers browsing it
    // must only ever see the price, never a control to change it.
    const handleEditListingDetails = async (item, btn) => {
        const newName = prompt('Listing name:', item.name || '');
        if (newName === null) return;
        if (!newName.trim()) {
            alert('Name cannot be empty.');
            return;
        }

        const newDescription = prompt('Listing description:', item.description || '');
        if (newDescription === null) return;

        if (btn) btn.disabled = true;
        try {
            const resp = await fetch(`${API_BASE}/marketplace/${item.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ name: newName.trim(), description: newDescription })
            });

            if (resp.ok) {
                const idx = marketplaceItems.findIndex((m) => m.id === item.id);
                if (idx !== -1) {
                    marketplaceItems[idx].name = newName.trim();
                    marketplaceItems[idx].description = newDescription;
                }
                applyMarketplaceFilters();
                alert('Listing details updated.');
            } else {
                const d = await resp.json().catch(() => ({}));
                alert(d.message || 'Could not update the listing. Please try again.');
            }
        } catch (err) {
            console.error('[ForgeFlow][marketplace] update listing details failed', err);
            alert('Could not reach the ForgeFlow server. Please try again.');
        } finally {
            if (btn) btn.disabled = false;
        }
    };

    const handleRemoveListing = async (item, overlay, btn) => {
        if (!confirm('Remove this listing from the marketplace? This will not delete your API.')) return;
        if (btn) btn.disabled = true;
        try {
            const resp = await fetch(`${API_BASE}/marketplace/${item.id}`, {
                method: 'DELETE',
                headers: authHeaders
            });
            if (resp.ok) {
                marketplaceItems = (marketplaceItems || []).filter((m) => m.id !== item.id);
                applyMarketplaceFilters();
                if (overlay) overlay.remove();
            } else {
                const d = await resp.json().catch(() => ({}));
                alert(d.message || 'Could not remove the listing. Please try again.');
                if (btn) btn.disabled = false;
            }
        } catch (err) {
            console.error('[ForgeFlow][marketplace] remove listing failed', err);
            alert('Could not reach the ForgeFlow server. Please try again.');
            if (btn) btn.disabled = false;
        }
    };

    const attachMarketCardHandlers = (card, it) => {
        card.addEventListener('click', () => openMarketModal(it));

        const buyBtn = card.querySelector('.market-buy-btn');
        if (buyBtn) {
            buyBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                handlePurchase(it, null, buyBtn);
            });
        }

        const runBtn = card.querySelector('.market-run-btn');
        if (runBtn) {
            runBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                handleRunApi(it, runBtn);
            });
        }

        const verifyBtn = card.querySelector('.market-verify-btn');
        if (verifyBtn) {
            verifyBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
                    window.location.href = chrome.runtime.getURL('my-purchases/my-purchases.html');
                }
            });
        }

        const editBtn = card.querySelector('.market-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                handleEditListingDetails(it, editBtn);
            });
        }

        const analyticsBtn = card.querySelector('.market-analytics-btn');
        if (analyticsBtn) {
            analyticsBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                openAnalyticsView(it);
            });
        }
    };

    const renderMarketplaceSkeleton = () => {
        if (marketplaceResultCount) marketplaceResultCount.textContent = '';

        if (marketplaceList) {
            marketplaceList.innerHTML = Array.from({ length: 6 }).map(() => `
                <div class="market-card market-card--skeleton" aria-hidden="true">
                    <div class="skeleton-line skeleton-line--title"></div>
                    <div class="skeleton-line skeleton-line--desc"></div>
                    <div class="skeleton-line skeleton-line--desc" style="width:60%"></div>
                    <div class="skeleton-line skeleton-line--pill"></div>
                </div>
            `).join('');
        }

        if (marketplaceFeaturedSection && marketplaceFeatured) {
            marketplaceFeaturedSection.hidden = false;
            marketplaceFeatured.innerHTML = Array.from({ length: 3 }).map(() => `
                <div class="market-card market-card--featured market-card--skeleton" aria-hidden="true">
                    <div class="skeleton-line skeleton-line--title"></div>
                    <div class="skeleton-line skeleton-line--desc"></div>
                </div>
            `).join('');
        }
    };

    const renderFeatured = (items) => {
        if (!marketplaceFeatured || !marketplaceFeaturedSection) return;

        if (!items || items.length === 0) {
            marketplaceFeaturedSection.hidden = true;
            marketplaceFeatured.innerHTML = '';
            return;
        }

        // "Featured" = highest rating × purchase-count out of the full,
        // unfiltered catalog — a generic ranking rule, not a hand-picked
        // list, so it stays correct as listings come and go.
        const featured = items
            .slice()
            .sort((a, b) => {
                const sa = getPrototypeStats(a);
                const sb = getPrototypeStats(b);
                return (sb.rating * ((b.purchaseCount || 0) + 1)) - (sa.rating * ((a.purchaseCount || 0) + 1));
            })
            .slice(0, 3);

        marketplaceFeaturedSection.hidden = false;
        marketplaceFeatured.innerHTML = '';
        featured.forEach((it) => {
            const card = document.createElement('article');
            card.className = 'market-card market-card--featured';
            card.dataset.id = it.id;
            card.innerHTML = `<span class="featured-ribbon">★ Featured</span>${buildMarketCardHtml(it)}`;
            attachMarketCardHandlers(card, it);
            marketplaceFeatured.appendChild(card);
        });
    };

    const renderMarketplace = (items) => {
        if (!marketplaceList) return;

        if (marketplaceResultCount) {
            marketplaceResultCount.textContent = items && items.length
                ? `${items.length} API${items.length === 1 ? '' : 's'}`
                : '';
        }

        if (!items || items.length === 0) {
            marketplaceList.innerHTML = `
                <div class="marketplace-empty">
                    <div class="marketplace-empty-icon" aria-hidden="true">🔍</div>
                    <h3>No APIs found.</h3>
                    <p>Try a different search term, category, or filter.</p>
                </div>
            `;
            return;
        }

        marketplaceList.innerHTML = '';
        items.forEach((it) => {
            const card = document.createElement('article');
            card.className = 'market-card';
            card.dataset.id = it.id;
            card.innerHTML = buildMarketCardHtml(it);
            attachMarketCardHandlers(card, it);
            marketplaceList.appendChild(card);
        });
    };

    const applyMarketplaceFilters = () => {
        const q = (marketplaceSearch && marketplaceSearch.value || '').trim().toLowerCase();
        const filter = (marketplaceFilter && marketplaceFilter.value) || 'all';
        const sort = (marketplaceSort && marketplaceSort.value) || 'newest';

        let result = (marketplaceItems || []).slice();
        if (q) {
            result = result.filter(i => `${i.name} ${i.description || ''} ${i.publisher || ''}`.toLowerCase().includes(q));
        }
        if (filter === 'free') result = result.filter(i => isFreeItem(i));
        if (filter === 'paid') result = result.filter(i => !isFreeItem(i));

        if (activeCategory && activeCategory !== 'all') {
            result = result.filter(i => normalizeCategorySlug(i.category) === activeCategory);
        }

        if (sort === 'price-asc') {
            result.sort((a, b) => (a.price || 0) - (b.price || 0));
        } else if (sort === 'price-desc') {
            result.sort((a, b) => (b.price || 0) - (a.price || 0));
        } else if (sort === 'downloads-desc') {
            result.sort((a, b) => (b.purchaseCount || 0) - (a.purchaseCount || 0));
        } else if (sort === 'rating-desc') {
            result.sort((a, b) => getPrototypeStats(b).rating - getPrototypeStats(a).rating);
        } else {
            result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // newest (default)
        }

        // The "Featured" strip is an editorial/browsing aid over the FULL
        // catalog. Once the user is actively searching or filtering, keeping
        // it visible (and unfiltered) made it look like search/filter wasn't
        // doing anything — the browse grid below would shrink, but the row
        // of cards at the top of the page stayed exactly the same. Hiding it
        // whenever any filter is active removes that illusion.
        const isBrowsingUnfiltered = !q && filter === 'all' && activeCategory === 'all';
        if (isBrowsingUnfiltered) {
            renderFeatured(marketplaceItems);
        } else if (marketplaceFeaturedSection) {
            marketplaceFeaturedSection.hidden = true;
        }

        renderMarketplace(result);
    };

    const loadMarketplaceItems = async () => {
        renderMarketplaceSkeleton();
        try {
            const { ok, data } = await fetchJson(`${API_BASE}/marketplace`, { headers: authHeaders });
            if (!ok) {
                console.warn('[ForgeFlow][marketplace] failed to load marketplace items', data);
                marketplaceItems = [];
                applyMarketplaceFilters();
                return;
            }
            marketplaceItems = data || [];
            applyMarketplaceFilters();
        } catch (err) {
            console.error('[ForgeFlow][marketplace] loadMarketplaceItems error', err);
            marketplaceItems = [];
            applyMarketplaceFilters();
        }
    };

    // --- API Details modal ---

    const openMarketModal = (item) => {
        const stats = getPrototypeStats(item);
        const free = isFreeItem(item);
        const complexity = getComplexityTier(item);
        const action = getCardAction(item);
        const engagementBadgesHtml = getEngagementBadges(item)
            .map((b) => `<span class="badge badge-${b.slug}">${b.label}</span>`)
            .join('');

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const actionsHtml = action === 'creator'
            ? `
                <button class="btn btn-secondary edit-listing">Edit</button>
                <button class="btn btn-secondary view-analytics">Analytics</button>
                <button class="btn btn-secondary remove-listing">Remove Listing</button>
                <button class="btn btn-secondary modal-close">Close</button>
            `
            : action === 'run'
                ? `
                <button class="btn btn-primary run-api">Run API</button>
                <button class="btn btn-secondary modal-close">Close</button>
            `
                : action === 'pending'
                    ? `
                <button class="btn btn-secondary" disabled>Pending Approval</button>
                <button class="btn btn-secondary modal-close">Close</button>
            `
                    : action === 'verification_required'
                        ? `
                <button class="btn btn-primary market-verify">Verification Required — Resubmit</button>
                <button class="btn btn-secondary modal-close">Close</button>
            `
                        : action === 'rejected'
                            ? `
                <button class="btn btn-primary market-buy">Purchase Rejected — Try Again</button>
                <button class="btn btn-secondary modal-close">Close</button>
            `
                            : `
                <button class="btn btn-primary market-buy">${free ? 'Get for Free' : `Buy for $${item.price}`}</button>
                <button class="btn btn-secondary modal-close">Close</button>
            `;

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <h3>${escapeHtml(item.name)}</h3>
            <div class="modal-scroll-body">
                <div class="modal-badges">
                    <span class="badge badge-category">${escapeHtml(categoryLabel(normalizeCategorySlug(item.category)))}</span>
                    <span class="badge badge-complexity-${complexity.slug}">${complexity.label}</span>
                    <span class="badge ${free ? 'badge-free' : 'badge-paid'}">${free ? 'Free' : 'Premium'}</span>
                    ${engagementBadgesHtml}
                </div>
                <p>${escapeHtml(item.description || 'No description provided.')}</p>
                <p><strong>Method:</strong> ${escapeHtml(item.method || '')} • <strong>Version:</strong> ${escapeHtml(item.version || '')}</p>
                <p><strong>Creator:</strong> ${escapeHtml(item.publisher || 'Unknown')} • <strong>Price:</strong> <span id="market-price-${item.id}">${item.price && item.price > 0 ? '$' + item.price : 'Free'}</span></p>
                <p><strong>Published:</strong> ${formatRelativeDate(item.createdAt)}</p>
                <p><strong>Rating:</strong> ${stats.rating.toFixed(1)} ★ • <strong>Purchases:</strong> ${formatCount(item.purchaseCount)}</p>
                <h4 class="modal-section-label">Parameters</h4>
                <p class="modal-parameters-note">Full parameter details for this workflow are shared with the buyer after purchase.</p>
            </div>
            <div class="modal-actions">
                ${actionsHtml}
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        const buyBtn = overlay.querySelector('.market-buy');
        if (buyBtn) {
            buyBtn.addEventListener('click', () => handlePurchase(item, () => overlay.remove(), buyBtn));
        }

        const runBtn = overlay.querySelector('.run-api');
        if (runBtn) {
            runBtn.addEventListener('click', () => handleRunApi(item, runBtn));
        }

        const verifyBtn = overlay.querySelector('.market-verify');
        if (verifyBtn) {
            verifyBtn.addEventListener('click', () => {
                if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
                    window.location.href = chrome.runtime.getURL('my-purchases/my-purchases.html');
                }
            });
        }

        const editBtn = overlay.querySelector('.edit-listing');
        if (editBtn) {
            editBtn.addEventListener('click', () => handleEditListingDetails(item, editBtn));
        }

        const analyticsBtn = overlay.querySelector('.view-analytics');
        if (analyticsBtn) {
            analyticsBtn.addEventListener('click', () => openAnalyticsView(item));
        }

        const removeBtn = overlay.querySelector('.remove-listing');
        if (removeBtn) {
            removeBtn.addEventListener('click', () => handleRemoveListing(item, overlay, removeBtn));
        }
    };

    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            loadMarketplaceItems();
        });
    }

    if (marketplaceSearch) {
        marketplaceSearch.addEventListener('input', () => applyMarketplaceFilters());
    }

    if (marketplaceFilter) {
        marketplaceFilter.addEventListener('change', () => applyMarketplaceFilters());
    }

    if (marketplaceSort) {
        marketplaceSort.addEventListener('change', () => applyMarketplaceFilters());
    }

    if (categoryChipsRow) {
        const chips = categoryChipsRow.querySelectorAll('.chip');
        chips.forEach((chip) => {
            chip.addEventListener('click', () => {
                activeCategory = (chip.dataset && chip.dataset.category) || 'all';
                chips.forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                applyMarketplaceFilters();
            });
        });
    }

    (async () => {
        const session = await getAuthSession();
        if (session?.token) {
            currentUser = session.user || null;
            authHeaders = { Authorization: `Bearer ${session.token}` };
        }
        loadMarketplaceItems();
    })();
});
