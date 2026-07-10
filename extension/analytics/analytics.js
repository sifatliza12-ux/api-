/**
 * analytics.js
 * Creator-only detail view behind the "Analytics" nav item / Dashboard quick
 * action. Purely a read-only rollup over data that already exists: GET
 * /api/my-apis (created/published/draft counts, unchanged), GET /marketplace
 * (purchaseCount per owned listing, unchanged), and the new read-only GET
 * /api/workflows/stats/mine (total runs across owned workflows). Nothing
 * here writes anything or touches recording/replay/purchase flows.
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

const getAuthSession = () => new Promise((resolve) => {
    chrome.storage.local.get(AUTH_STORAGE_KEY, (result) => {
        resolve(result?.[AUTH_STORAGE_KEY] || null);
    });
});

// Same deterministic "prototype" rating formula marketplace.js uses, so a
// given listing shows the same rating everywhere in the app.
const seededFraction = (seed) => {
    const x = Math.sin(seed * 999331) * 10000;
    return x - Math.floor(x);
};

const prototypeRating = (item) => {
    const seed = Number(item.id) || 1;
    return Math.round((3.6 + seededFraction(seed) * 1.4) * 10) / 10;
};

document.addEventListener('DOMContentLoaded', () => {
    const authNote = document.getElementById('auth-note');
    const refreshBtn = document.getElementById('refresh-btn');
    const statCreated = document.getElementById('stat-created');
    const statPublished = document.getElementById('stat-published');
    const statDrafts = document.getElementById('stat-drafts');
    const statDownloads = document.getElementById('stat-downloads');
    const statRuns = document.getElementById('stat-runs');
    const statRating = document.getElementById('stat-rating');
    const statRevenue = document.getElementById('stat-revenue');
    const publishedResultCount = document.getElementById('published-result-count');
    const publishedList = document.getElementById('published-analytics-list');

    let authHeaders = {};

    const renderPublishedList = (ownedListings) => {
        if (!publishedList) return;

        if (publishedResultCount) {
            publishedResultCount.textContent = ownedListings.length
                ? `${ownedListings.length} API${ownedListings.length === 1 ? '' : 's'}`
                : '';
        }

        if (ownedListings.length === 0) {
            publishedList.innerHTML = `
                <div class="marketplace-empty">
                    <div class="marketplace-empty-icon" aria-hidden="true">📊</div>
                    <h3>No published APIs yet.</h3>
                    <p>Publish an API from My APIs to start seeing performance here.</p>
                </div>
            `;
            return;
        }

        publishedList.innerHTML = ownedListings.map((item) => `
            <div class="analytics-row">
                <div>
                    <p class="analytics-row-name">${escapeHtml(item.name)}</p>
                    <p class="analytics-row-meta">${item.price > 0 ? `$${item.price}` : 'Free'}</p>
                </div>
                <div class="analytics-row-stats">
                    <div class="analytics-row-stat">
                        <span class="analytics-row-stat-label">Downloads</span>
                        <span class="analytics-row-stat-value">${item.purchaseCount || 0}</span>
                    </div>
                    <div class="analytics-row-stat">
                        <span class="analytics-row-stat-label">Rating</span>
                        <span class="analytics-row-stat-value">${prototypeRating(item).toFixed(1)} ★</span>
                    </div>
                    <div class="analytics-row-stat">
                        <span class="analytics-row-stat-label">Est. Revenue</span>
                        <span class="analytics-row-stat-value">$${((item.purchaseCount || 0) * (item.price || 0)).toFixed(2)}</span>
                    </div>
                </div>
            </div>
        `).join('');
    };

    const load = async () => {
        try {
            const [myApisRes, marketplaceRes, runStatsRes] = await Promise.all([
                fetch(`${API_BASE}/api/my-apis`, { headers: authHeaders }),
                fetch(`${API_BASE}/marketplace`, { headers: authHeaders }),
                fetch(`${API_BASE}/api/workflows/stats/mine`, { headers: authHeaders })
            ]);

            const myApis = myApisRes.ok ? await myApisRes.json().catch(() => []) : [];
            const marketplace = marketplaceRes.ok ? await marketplaceRes.json().catch(() => []) : [];
            const runStats = runStatsRes.ok ? await runStatsRes.json().catch(() => ({})) : {};

            const apis = Array.isArray(myApis) ? myApis : [];
            const published = apis.filter((a) => a.published).length;

            if (statCreated) statCreated.textContent = String(apis.length);
            if (statPublished) statPublished.textContent = String(published);
            if (statDrafts) statDrafts.textContent = String(apis.length - published);
            if (statRuns) statRuns.textContent = String(runStats.totalRuns || 0);

            const ownedListings = (Array.isArray(marketplace) ? marketplace : []).filter((item) => item.isOwnedByMe);
            const totalDownloads = ownedListings.reduce((sum, item) => sum + (item.purchaseCount || 0), 0);
            const totalRevenue = ownedListings.reduce((sum, item) => sum + (item.purchaseCount || 0) * (item.price || 0), 0);
            const avgRating = ownedListings.length
                ? ownedListings.reduce((sum, item) => sum + prototypeRating(item), 0) / ownedListings.length
                : null;

            if (statDownloads) statDownloads.textContent = String(totalDownloads);
            if (statRevenue) statRevenue.textContent = `$${totalRevenue.toFixed(2)}`;
            if (statRating) statRating.textContent = avgRating ? `${avgRating.toFixed(1)} ★` : '—';

            renderPublishedList(ownedListings);
        } catch (err) {
            console.error('[ForgeFlow][analytics] failed to load analytics data', err);
        }
    };

    if (refreshBtn) refreshBtn.addEventListener('click', load);

    (async () => {
        const session = await getAuthSession();
        if (!session?.token) {
            if (authNote) {
                authNote.hidden = false;
                authNote.textContent = 'Log in from the ForgeFlow extension popup to see your Analytics.';
            }
            renderPublishedList([]);
            return;
        }

        authHeaders = { Authorization: `Bearer ${session.token}` };
        load();
    })();
});
