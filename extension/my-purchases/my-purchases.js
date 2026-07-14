/**
 * my-purchases.js
 * Buyer-only purchase history — every purchase_requests row the current
 * user has submitted (any status), powered by GET /purchase-requests/mine.
 * "Verification Required" rows can be edited and resubmitted in place
 * (PATCH /purchase-requests/:id); "Rejected" rows can start a brand-new
 * request for the same listing (POST /marketplace/:id/purchase-request) —
 * the same endpoint the Marketplace page's Purchase dialog uses.
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

const formatDate = (iso) => {
    if (!iso) return 'Unknown';
    try {
        return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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

const STATUS_LABELS = {
    pending: 'Pending Approval',
    verification_required: 'Verification Required',
    approved: 'Purchased',
    rejected: 'Rejected'
};

const PAYMENT_METHODS = [
    { value: 'bkash', label: 'bKash', instructions: 'Send Money to 01700-000000 (Personal), then enter the Transaction ID shown in your bKash confirmation SMS.' },
    { value: 'nagad', label: 'Nagad', instructions: 'Send Money to 01700-000000 (Personal), then enter the Transaction ID shown in your Nagad confirmation SMS.' },
    { value: 'rocket', label: 'Rocket', instructions: 'Send Money to 01700-000000-1 (Personal), then enter the Transaction ID shown in your Rocket confirmation SMS.' },
    { value: 'bank_transfer', label: 'Bank Transfer', instructions: 'Transfer to ForgeFlow Ltd., Account No. 0000-1111-2222, DBBL. Enter the transfer reference/transaction ID from your bank receipt.' }
];
const PAYMENT_METHOD_LABELS = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.value, m.label]));

const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;

const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
});

document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('refresh-btn');
    const authNote = document.getElementById('auth-note');
    const requestsList = document.getElementById('requests-list');
    const requestsResultCount = document.getElementById('requests-result-count');
    const statusChipsRow = document.getElementById('status-filter-chips');
    const marketplaceFooterLink = document.getElementById('marketplace-footer-link');

    if (marketplaceFooterLink && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        marketplaceFooterLink.href = chrome.runtime.getURL('marketplace/marketplace.html');
    }

    let requests = [];
    let activeStatus = 'all';
    let authHeaders = {};

    const renderSkeleton = () => {
        if (!requestsList) return;
        requestsList.innerHTML = Array.from({ length: 3 }).map(() => `
            <div class="request-card market-card--skeleton" aria-hidden="true">
                <div class="skeleton-line skeleton-line--title"></div>
                <div class="skeleton-line skeleton-line--desc"></div>
                <div class="skeleton-line skeleton-line--desc" style="width:60%"></div>
            </div>
        `).join('');
    };

    const openScreenshotViewer = (src) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `<img src="${src}" style="max-width:100%; max-height:90vh; border-radius: var(--radius-lg);" alt="Payment screenshot">`;
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
    };

    // Shared by both "Resubmit" (edit an existing verification_required
    // request) and "Submit New Request" (start a fresh one after a
    // rejection) — the only difference is which endpoint/method it posts to.
    const openPurchaseFormDialog = ({ title, request, submitLabel, onSubmit }) => {
        let selectedMethod = request.paymentMethod || PAYMENT_METHODS[0].value;
        let screenshotDataUrl = request.screenshot || null;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <h3>${escapeHtml(title)}</h3>
            <div class="modal-scroll-body">
                <p><strong>API:</strong> ${escapeHtml(request.listingName)} • <strong>Creator:</strong> ${escapeHtml(request.listingPublisher)} • <strong>Price:</strong> $${request.price}</p>

                <div class="form-field">
                    <span class="form-field-label">Payment Method</span>
                    <div class="payment-method-grid" id="pf-method-grid">
                        ${PAYMENT_METHODS.map((m) => `<button type="button" class="payment-method-option${m.value === selectedMethod ? ' active' : ''}" data-method="${m.value}">${m.label}</button>`).join('')}
                    </div>
                </div>

                <p class="payment-instructions" id="pf-instructions">${escapeHtml((PAYMENT_METHODS.find((m) => m.value === selectedMethod) || PAYMENT_METHODS[0]).instructions)}</p>

                <div class="form-field">
                    <label class="form-field-label" for="pf-transaction-id">Transaction ID <span aria-hidden="true">*</span></label>
                    <input type="text" id="pf-transaction-id" class="form-input" value="${escapeHtml(request.transactionId || '')}" required>
                </div>

                <div class="form-field">
                    <span class="form-field-label">Payment Screenshot (optional)</span>
                    <input type="file" id="pf-screenshot" class="form-input" accept="image/*">
                    <span class="form-field-hint">Up to 3MB.</span>
                    <img id="pf-screenshot-preview" class="screenshot-preview" style="${screenshotDataUrl ? '' : 'display:none'}" src="${screenshotDataUrl || ''}" alt="Screenshot preview">
                </div>

                <div class="form-field">
                    <label class="form-field-label" for="pf-note">Note to Creator (optional)</label>
                    <textarea id="pf-note" class="form-textarea">${escapeHtml(request.buyerNote || '')}</textarea>
                </div>

                <p class="form-field-hint" id="pf-error" style="color:#fecaca; display:none"></p>
            </div>
            <div class="modal-actions">
                <button class="btn btn-primary" id="pf-submit">${escapeHtml(submitLabel)}</button>
                <button class="btn btn-secondary modal-close">Cancel</button>
            </div>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        const methodGrid = overlay.querySelector('#pf-method-grid');
        const instructionsEl = overlay.querySelector('#pf-instructions');
        methodGrid.querySelectorAll('.payment-method-option').forEach((btn) => {
            btn.addEventListener('click', () => {
                selectedMethod = btn.dataset.method;
                methodGrid.querySelectorAll('.payment-method-option').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                const method = PAYMENT_METHODS.find((m) => m.value === selectedMethod);
                instructionsEl.textContent = method ? method.instructions : '';
            });
        });

        const screenshotInput = overlay.querySelector('#pf-screenshot');
        const screenshotPreview = overlay.querySelector('#pf-screenshot-preview');
        const errorEl = overlay.querySelector('#pf-error');

        screenshotInput.addEventListener('change', async () => {
            const file = screenshotInput.files && screenshotInput.files[0];
            if (!file) return;
            if (file.size > MAX_SCREENSHOT_BYTES) {
                errorEl.textContent = 'Screenshot is too large. Please choose an image under 3MB.';
                errorEl.style.display = 'block';
                screenshotInput.value = '';
                return;
            }
            errorEl.style.display = 'none';
            screenshotDataUrl = await readFileAsDataUrl(file);
            screenshotPreview.src = screenshotDataUrl;
            screenshotPreview.style.display = 'block';
        });

        const submitBtn = overlay.querySelector('#pf-submit');
        submitBtn.addEventListener('click', async () => {
            const transactionId = overlay.querySelector('#pf-transaction-id').value.trim();
            const buyerNote = overlay.querySelector('#pf-note').value.trim();

            if (!transactionId) {
                errorEl.textContent = 'Transaction ID is required.';
                errorEl.style.display = 'block';
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Submitting…';

            try {
                await onSubmit({ paymentMethod: selectedMethod, transactionId, screenshot: screenshotDataUrl, buyerNote }, overlay, errorEl, submitBtn);
            } finally {
                if (document.body.contains(overlay)) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = submitLabel;
                }
            }
        });
    };

    const handleResubmit = (request) => {
        openPurchaseFormDialog({
            title: 'Resubmit Purchase Request',
            request,
            submitLabel: 'Resubmit',
            onSubmit: async (payload, overlay, errorEl) => {
                const { ok, data } = await fetchJson(`${API_BASE}/purchase-requests/${request.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify(payload)
                });
                if (!ok) {
                    errorEl.textContent = data.message || 'Failed to resubmit. Please try again.';
                    errorEl.style.display = 'block';
                    return;
                }
                overlay.remove();
                alert('Purchase request resubmitted. Status is now Pending Approval.');
                loadRequests();
            }
        });
    };

    const handleNewRequest = (request) => {
        openPurchaseFormDialog({
            title: `Purchase ${request.listingName}`,
            request: { ...request, transactionId: '', screenshot: null, buyerNote: '' },
            submitLabel: 'Submit Purchase Request',
            onSubmit: async (payload, overlay, errorEl) => {
                const { ok, data } = await fetchJson(`${API_BASE}/marketplace/${request.listingId}/purchase-request`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify(payload)
                });
                if (!ok) {
                    errorEl.textContent = data.message || 'Failed to submit purchase request.';
                    errorEl.style.display = 'block';
                    return;
                }
                overlay.remove();
                alert(data.message || 'Purchase request submitted. The creator will review it shortly.');
                loadRequests();
            }
        });
    };

    const buildRequestCardHtml = (request) => {
        let actionsHtml = '';
        if (request.status === 'verification_required') {
            actionsHtml = `<div class="request-card-actions"><button type="button" class="btn btn-primary req-resubmit-btn">Edit &amp; Resubmit</button></div>`;
        } else if (request.status === 'rejected') {
            actionsHtml = `<div class="request-card-actions"><button type="button" class="btn btn-primary req-new-request-btn">Submit New Request</button></div>`;
        } else if (request.status === 'approved') {
            actionsHtml = `<div class="request-card-actions"><button type="button" class="btn btn-secondary req-view-purchased-btn">View in Purchased APIs</button></div>`;
        }

        return `
            <div class="request-card-top">
                <div class="request-card-heading">
                    <h3>${escapeHtml(request.listingName)}</h3>
                    <p>Creator: ${escapeHtml(request.listingPublisher)}</p>
                </div>
                <span class="badge badge-status-${request.status}">${STATUS_LABELS[request.status] || request.status}</span>
            </div>
            <div class="request-detail-grid">
                <div class="request-detail-item">
                    <span class="request-detail-label">Price</span>
                    <span class="request-detail-value">$${request.price}</span>
                </div>
                <div class="request-detail-item">
                    <span class="request-detail-label">Payment Method</span>
                    <span class="request-detail-value">${escapeHtml(PAYMENT_METHOD_LABELS[request.paymentMethod] || request.paymentMethod)}</span>
                </div>
                <div class="request-detail-item">
                    <span class="request-detail-label">Transaction ID</span>
                    <span class="request-detail-value">${escapeHtml(request.transactionId)}</span>
                </div>
                <div class="request-detail-item">
                    <span class="request-detail-label">Submitted</span>
                    <span class="request-detail-value">${formatDate(request.createdAt)}</span>
                </div>
            </div>
            ${request.screenshot ? `<img src="${request.screenshot}" class="screenshot-preview req-screenshot" alt="Payment screenshot" title="Click to enlarge">` : ''}
            ${request.buyerNote ? `<p class="request-note"><strong>Your note:</strong> ${escapeHtml(request.buyerNote)}</p>` : ''}
            ${request.creatorMessage ? `<p class="creator-message-box"><strong>Creator message:</strong> ${escapeHtml(request.creatorMessage)}</p>` : ''}
            ${actionsHtml}
        `;
    };

    const renderRequests = (items) => {
        if (!requestsList) return;

        if (requestsResultCount) {
            requestsResultCount.textContent = items.length ? `${items.length} purchase${items.length === 1 ? '' : 's'}` : '';
        }

        if (items.length === 0) {
            requestsList.innerHTML = `
                <div class="marketplace-empty">
                    <div class="marketplace-empty-icon" aria-hidden="true">🛒</div>
                    <h3>No purchases yet.</h3>
                    <p>Purchase requests you submit from the Marketplace will show up here.</p>
                </div>
            `;
            return;
        }

        requestsList.innerHTML = '';
        items.forEach((request) => {
            const card = document.createElement('article');
            card.className = 'request-card';
            card.innerHTML = buildRequestCardHtml(request);

            const screenshotEl = card.querySelector('.req-screenshot');
            if (screenshotEl) {
                screenshotEl.addEventListener('click', () => openScreenshotViewer(request.screenshot));
            }

            const resubmitBtn = card.querySelector('.req-resubmit-btn');
            if (resubmitBtn) resubmitBtn.addEventListener('click', () => handleResubmit(request));

            const newRequestBtn = card.querySelector('.req-new-request-btn');
            if (newRequestBtn) newRequestBtn.addEventListener('click', () => handleNewRequest(request));

            const viewPurchasedBtn = card.querySelector('.req-view-purchased-btn');
            if (viewPurchasedBtn) {
                viewPurchasedBtn.addEventListener('click', () => {
                    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
                        window.location.href = chrome.runtime.getURL('purchased-apis/purchased-apis.html');
                    }
                });
            }

            requestsList.appendChild(card);
        });
    };

    const applyFilter = () => {
        const filtered = activeStatus === 'all' ? requests : requests.filter((r) => r.status === activeStatus);
        renderRequests(filtered);
    };

    const loadRequests = async () => {
        renderSkeleton();
        try {
            const { ok, data } = await fetchJson(`${API_BASE}/purchase-requests/mine`, { headers: authHeaders });
            requests = ok && Array.isArray(data) ? data : [];
            applyFilter();
        } catch (err) {
            console.error('[ForgeFlow][my-purchases] load error', err);
            requests = [];
            applyFilter();
        }
    };

    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadRequests);
    }

    if (statusChipsRow) {
        const chips = statusChipsRow.querySelectorAll('.chip');
        chips.forEach((chip) => {
            chip.addEventListener('click', () => {
                activeStatus = (chip.dataset && chip.dataset.status) || 'all';
                chips.forEach((c) => c.classList.remove('active'));
                chip.classList.add('active');
                applyFilter();
            });
        });
    }

    (async () => {
        const session = await getAuthSession();
        if (!session?.token) {
            if (authNote) {
                authNote.hidden = false;
                authNote.textContent = 'Log in from the ForgeFlow extension popup to see your purchases.';
            }
            renderRequests([]);
            return;
        }

        authHeaders = { Authorization: `Bearer ${session.token}` };
        loadRequests();
    })();
});
