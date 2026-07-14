/**
 * purchase-requests.js
 * Creator-only page: every buyer purchase request awaiting (or already
 * given) a decision, powered by GET /purchase-requests/for-me. Approve/
 * Reject/Request Verification each call the matching backend action —
 * exactly the seam a real payment gateway would later replace ("creator
 * clicks Approve" -> "gateway webhook confirms payment") without changing
 * anything on this page.
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
    pending: 'Pending',
    verification_required: 'Verification Required',
    approved: 'Approved',
    rejected: 'Rejected'
};

const PAYMENT_METHOD_LABELS = {
    bkash: 'bKash',
    nagad: 'Nagad',
    rocket: 'Rocket',
    bank_transfer: 'Bank Transfer'
};

document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('refresh-btn');
    const authNote = document.getElementById('auth-note');
    const requestsList = document.getElementById('requests-list');
    const requestsResultCount = document.getElementById('requests-result-count');
    const statusChipsRow = document.getElementById('status-filter-chips');

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

    // Small message-collection modal shared by Reject (optional message) and
    // Request Verification (required message) — same hand-rolled
    // .modal-overlay/.modal pattern every other dialog in the app uses.
    const openMessageDialog = ({ title, placeholder, required, confirmLabel, onConfirm }) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <h3>${escapeHtml(title)}</h3>
            <div class="modal-scroll-body">
                <div class="form-field">
                    <textarea id="msg-dialog-text" class="form-textarea" placeholder="${escapeHtml(placeholder)}"></textarea>
                </div>
                <p class="form-field-hint" id="msg-dialog-error" style="color:#fecaca; display:none"></p>
            </div>
            <div class="modal-actions">
                <button class="btn btn-primary" id="msg-dialog-confirm">${escapeHtml(confirmLabel)}</button>
                <button class="btn btn-secondary modal-close">Cancel</button>
            </div>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        overlay.querySelector('#msg-dialog-confirm').addEventListener('click', async () => {
            const text = overlay.querySelector('#msg-dialog-text').value.trim();
            const errorEl = overlay.querySelector('#msg-dialog-error');
            if (required && !text) {
                errorEl.textContent = 'Please write a short message.';
                errorEl.style.display = 'block';
                return;
            }
            await onConfirm(text, overlay);
        });
    };

    const handleApprove = async (request) => {
        if (!confirm(`Approve this purchase request from ${request.buyerName}? The buyer will immediately get access to "${request.listingName}".`)) return;
        try {
            const { ok, data } = await fetchJson(`${API_BASE}/purchase-requests/${request.id}/approve`, {
                method: 'POST',
                headers: authHeaders
            });
            if (!ok) {
                alert(data.message || 'Failed to approve this request.');
                return;
            }
            alert('Purchase approved.');
            loadRequests();
        } catch (err) {
            console.error('[ForgeFlow][purchase-requests] approve failed', err);
            alert('Unable to reach the ForgeFlow backend. Please try again.');
        }
    };

    const handleReject = (request) => {
        openMessageDialog({
            title: 'Reject Purchase Request',
            placeholder: 'Optional reason for the buyer (e.g. transaction ID not found)...',
            required: false,
            confirmLabel: 'Reject',
            onConfirm: async (message, overlay) => {
                try {
                    const { ok, data } = await fetchJson(`${API_BASE}/purchase-requests/${request.id}/reject`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders },
                        body: JSON.stringify({ message })
                    });
                    if (!ok) {
                        alert(data.message || 'Failed to reject this request.');
                        return;
                    }
                    overlay.remove();
                    loadRequests();
                } catch (err) {
                    console.error('[ForgeFlow][purchase-requests] reject failed', err);
                    alert('Unable to reach the ForgeFlow backend. Please try again.');
                }
            }
        });
    };

    const handleRequestVerification = (request) => {
        openMessageDialog({
            title: 'Request Verification',
            placeholder: 'Explain what needs verifying (e.g. transaction ID looks incomplete)...',
            required: true,
            confirmLabel: 'Request Verification',
            onConfirm: async (message, overlay) => {
                try {
                    const { ok, data } = await fetchJson(`${API_BASE}/purchase-requests/${request.id}/request-verification`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders },
                        body: JSON.stringify({ message })
                    });
                    if (!ok) {
                        alert(data.message || 'Failed to request verification.');
                        return;
                    }
                    overlay.remove();
                    loadRequests();
                } catch (err) {
                    console.error('[ForgeFlow][purchase-requests] request-verification failed', err);
                    alert('Unable to reach the ForgeFlow backend. Please try again.');
                }
            }
        });
    };

    // Screenshot is buyer-submitted data rendered as an <img src> — escaped
    // like every other user-supplied field so a malformed/malicious value
    // can't break out of the attribute (the backend also validates it's a
    // real image data URL, but this page never trusts that alone).
    const openScreenshotViewer = (src) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `<img src="${escapeHtml(src)}" style="max-width:100%; max-height:90vh; border-radius: var(--radius-lg);" alt="Payment screenshot">`;
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
    };

    const buildRequestCardHtml = (request) => {
        const actionsHtml = (request.status === 'pending' || request.status === 'verification_required')
            ? `
                <button type="button" class="btn btn-primary req-approve-btn">Approve</button>
                <button type="button" class="btn btn-secondary req-reject-btn">Reject</button>
                <button type="button" class="btn btn-secondary req-verify-btn">Request Verification</button>
            `
            : '';

        return `
            <div class="request-card-top">
                <div class="request-card-heading">
                    <h3>${escapeHtml(request.listingName)}</h3>
                    <p>Buyer: ${escapeHtml(request.buyerName)}</p>
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
            ${request.screenshot ? `<img src="${escapeHtml(request.screenshot)}" class="screenshot-preview req-screenshot" alt="Payment screenshot" title="Click to enlarge">` : ''}
            ${request.buyerNote ? `<p class="request-note"><strong>Buyer note:</strong> ${escapeHtml(request.buyerNote)}</p>` : ''}
            ${request.creatorMessage ? `<p class="creator-message-box"><strong>Your message:</strong> ${escapeHtml(request.creatorMessage)}</p>` : ''}
            ${actionsHtml ? `<div class="request-card-actions">${actionsHtml}</div>` : ''}
        `;
    };

    const renderRequests = (items) => {
        if (!requestsList) return;

        if (requestsResultCount) {
            requestsResultCount.textContent = items.length ? `${items.length} request${items.length === 1 ? '' : 's'}` : '';
        }

        if (items.length === 0) {
            requestsList.innerHTML = `
                <div class="marketplace-empty">
                    <div class="marketplace-empty-icon" aria-hidden="true">📭</div>
                    <h3>No purchase requests${activeStatus !== 'all' ? ' with this status' : ''}.</h3>
                    <p>When a buyer purchases one of your paid APIs, their request will show up here.</p>
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

            const approveBtn = card.querySelector('.req-approve-btn');
            if (approveBtn) approveBtn.addEventListener('click', () => handleApprove(request));

            const rejectBtn = card.querySelector('.req-reject-btn');
            if (rejectBtn) rejectBtn.addEventListener('click', () => handleReject(request));

            const verifyBtn = card.querySelector('.req-verify-btn');
            if (verifyBtn) verifyBtn.addEventListener('click', () => handleRequestVerification(request));

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
            const { ok, data } = await fetchJson(`${API_BASE}/purchase-requests/for-me`, { headers: authHeaders });
            requests = ok && Array.isArray(data) ? data : [];
            applyFilter();
        } catch (err) {
            console.error('[ForgeFlow][purchase-requests] load error', err);
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
                authNote.textContent = 'Log in from the ForgeFlow extension popup to see your purchase requests.';
            }
            renderRequests([]);
            return;
        }

        authHeaders = { Authorization: `Bearer ${session.token}` };
        loadRequests();
    })();
});
