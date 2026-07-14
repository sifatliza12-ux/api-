/**
 * wallet.js
 * Creator-only earnings dashboard — GET /wallet/overview for the stat cards
 * and GET /wallet/transactions for the Recent Transactions table (a view
 * over purchase_requests of any status, not just completed sales, so a
 * creator can see Pending/Verification Required/Rejected rows here too).
 * Total Revenue / Pending Revenue are real sums over this creator's own
 * data but tagged "placeholder" — same convention the Dashboard's
 * "Estimated Revenue" card already uses — since no real payment gateway is
 * connected yet.
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

const STATUS_LABELS = {
    pending: 'Pending',
    verification_required: 'Verification Required',
    approved: 'Approved',
    rejected: 'Rejected'
};

document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('refresh-btn');
    const authNote = document.getElementById('auth-note');
    const transactionsTable = document.getElementById('transactions-table');
    const transactionsResultCount = document.getElementById('transactions-result-count');

    let authHeaders = {};

    const renderStatsSkeleton = () => {
        ['stat-total-revenue', 'stat-pending-revenue', 'stat-completed-sales', 'stat-pending-requests', 'stat-apis-sold', 'stat-avg-price', 'stat-most-purchased'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = '…';
        });
    };

    const renderStats = (overview) => {
        document.getElementById('stat-total-revenue').textContent = `$${Number(overview.totalRevenue || 0).toFixed(2)}`;
        document.getElementById('stat-pending-revenue').textContent = `$${Number(overview.pendingRevenue || 0).toFixed(2)}`;
        document.getElementById('stat-completed-sales').textContent = overview.completedSales || 0;
        document.getElementById('stat-pending-requests').textContent = overview.pendingPurchaseRequests || 0;
        document.getElementById('stat-apis-sold').textContent = overview.totalApisSold || 0;
        document.getElementById('stat-avg-price').textContent = `$${Number(overview.averageSellingPrice || 0).toFixed(2)}`;
        document.getElementById('stat-most-purchased').textContent = overview.mostPurchasedApiName || '—';
    };

    const renderTransactionsSkeleton = () => {
        if (!transactionsTable) return;
        transactionsTable.innerHTML = Array.from({ length: 4 }).map(() => `
            <div class="transaction-row market-card--skeleton" aria-hidden="true">
                <div class="skeleton-line skeleton-line--title"></div>
                <div class="skeleton-line skeleton-line--desc"></div>
                <div class="skeleton-line skeleton-line--pill"></div>
                <div class="skeleton-line skeleton-line--pill"></div>
                <div class="skeleton-line skeleton-line--desc"></div>
            </div>
        `).join('');
    };

    const renderTransactions = (transactions) => {
        if (!transactionsTable) return;

        if (transactionsResultCount) {
            transactionsResultCount.textContent = transactions.length ? `${transactions.length} transaction${transactions.length === 1 ? '' : 's'}` : '';
        }

        if (transactions.length === 0) {
            transactionsTable.innerHTML = `
                <div class="marketplace-empty">
                    <div class="marketplace-empty-icon" aria-hidden="true">💳</div>
                    <h3>No transactions yet.</h3>
                    <p>Sales of your paid APIs will show up here once buyers start purchasing.</p>
                </div>
            `;
            return;
        }

        transactionsTable.innerHTML = transactions.map((t) => `
            <div class="transaction-row">
                <span class="transaction-buyer">${escapeHtml(t.buyerName)}</span>
                <span class="transaction-api" title="${escapeHtml(t.listingName)}">${escapeHtml(t.listingName)}</span>
                <span class="transaction-amount">$${Number(t.amount).toFixed(2)}</span>
                <span class="badge badge-status-${t.status}">${STATUS_LABELS[t.status] || t.status}</span>
                <span class="transaction-date">${formatDate(t.date)}</span>
            </div>
        `).join('');
    };

    const loadWallet = async () => {
        renderStatsSkeleton();
        renderTransactionsSkeleton();
        try {
            const [overviewResp, transactionsResp] = await Promise.all([
                fetchJson(`${API_BASE}/wallet/overview`, { headers: authHeaders }),
                fetchJson(`${API_BASE}/wallet/transactions`, { headers: authHeaders })
            ]);

            renderStats(overviewResp.ok ? overviewResp.data : {});
            renderTransactions(transactionsResp.ok && Array.isArray(transactionsResp.data) ? transactionsResp.data : []);
        } catch (err) {
            console.error('[ForgeFlow][wallet] load error', err);
            renderStats({});
            renderTransactions([]);
        }
    };

    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadWallet);
    }

    (async () => {
        const session = await getAuthSession();
        if (!session?.token) {
            if (authNote) {
                authNote.hidden = false;
                authNote.textContent = 'Log in from the ForgeFlow extension popup to see your Wallet.';
            }
            renderStats({});
            renderTransactions([]);
            return;
        }

        authHeaders = { Authorization: `Bearer ${session.token}` };
        loadWallet();
    })();
});
