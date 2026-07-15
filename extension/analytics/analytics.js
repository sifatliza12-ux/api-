/**
 * analytics.js
 * Role-aware Analytics dashboard. Creator mode is a read-only rollup over
 * data that already exists: GET /api/my-apis (created/published/draft
 * counts, unchanged), GET /marketplace (purchaseCount per owned listing,
 * unchanged), and GET /api/workflows/stats/mine (total runs + recent runs
 * across owned workflows — recentRuns is a new, additive, read-only field on
 * that same endpoint). Buyer mode is the same idea over GET
 * /marketplace/purchases/mine, GET /marketplace, and GET /subscription.
 * Nothing here writes anything or touches recording/replay/parameter
 * replacement/purchase flows — see shared/roles.js for where the role
 * preference itself lives, and dashboard.js for the same role-switching
 * pattern this page mirrors (minus the switcher control, which only lives on
 * the Dashboard/Settings pages).
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
        if (mins < 1) return 'Just now';
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

// Same deterministic "prototype" rating formula marketplace.js/dashboard.js
// use, so a given listing shows the same rating everywhere in the app.
const seededFraction = (seed) => {
    const x = Math.sin(seed * 999331) * 10000;
    return x - Math.floor(x);
};

const prototypeRating = (item) => {
    const seed = Number(item.id) || 1;
    return Math.round((3.6 + seededFraction(seed) * 1.4) * 10) / 10;
};

// Same category normalization dashboard.js/purchased-apis.js use, so a given
// listing's category reads the same everywhere in the app.
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
    const refreshBtn = document.getElementById('refresh-btn');
    const analyticsEyebrow = document.getElementById('analytics-eyebrow');
    const topbarSubtitle = document.getElementById('topbar-subtitle');
    const roleBadge = document.getElementById('role-badge');
    const creatorContent = document.getElementById('creator-analytics-content');
    const buyerContent = document.getElementById('buyer-analytics-content');

    // Creator elements
    const statCreated = document.getElementById('stat-created');
    const statPublished = document.getElementById('stat-published');
    const statDrafts = document.getElementById('stat-drafts');
    const statDownloads = document.getElementById('stat-downloads');
    const statRuns = document.getElementById('stat-runs');
    const statRating = document.getElementById('stat-rating');
    const statRevenue = document.getElementById('stat-revenue');
    const statPopular = document.getElementById('stat-popular');
    const publishedResultCount = document.getElementById('published-result-count');
    const publishedList = document.getElementById('published-analytics-list');
    const activityList = document.getElementById('activity-list');

    // Buyer elements
    const buyerStatPurchased = document.getElementById('buyer-stat-purchased');
    const buyerStatRuns = document.getElementById('buyer-stat-runs');
    const buyerStatSubscription = document.getElementById('buyer-stat-subscription');
    const buyerStatRemainingRuns = document.getElementById('buyer-stat-remaining-runs');
    const buyerRemainingRunsFill = document.getElementById('buyer-remaining-runs-fill');
    const favoriteCategoriesList = document.getElementById('favorite-categories-list');
    const buyerRecentUsedList = document.getElementById('buyer-recent-used-list');
    const buyerRecommendedList = document.getElementById('buyer-recommended-list');

    let authHeaders = {};
    let currentUserId = null;
    let hasSession = false;

    const renderSkeletonRows = (container, count = 3) => {
        if (!container) return;
        container.innerHTML = Array.from({ length: count }).map(() => `
            <div class="recent-api-row recent-api-row--skeleton" aria-hidden="true">
                <span class="skeleton-line skeleton-line--title" style="width:45%"></span>
                <span class="skeleton-line skeleton-line--pill" style="width:20%"></span>
            </div>
        `).join('');
    };

    const renderEmpty = (container, icon, title, body) => {
        if (!container) return;
        container.innerHTML = `
            <div class="marketplace-empty">
                <div class="marketplace-empty-icon" aria-hidden="true">${icon}</div>
                <h3>${escapeHtml(title)}</h3>
                <p>${escapeHtml(body)}</p>
            </div>
        `;
    };

    // ==================== CREATOR ====================

    const renderPublishedList = (ownedListings) => {
        if (!publishedList) return;

        if (publishedResultCount) {
            publishedResultCount.textContent = ownedListings.length
                ? `${ownedListings.length} API${ownedListings.length === 1 ? '' : 's'}`
                : '';
        }

        if (ownedListings.length === 0) {
            renderEmpty(publishedList, '📊', 'No published APIs yet.', 'Publish an API from My APIs to start seeing performance here.');
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

    const ACTIVITY_META = {
        created: { icon: '🆕', label: 'API created' },
        published: { icon: '🚀', label: 'API published' },
        updated: { icon: '✏️', label: 'API updated' },
        run: { icon: '▶️', label: 'API run' }
    };

    const renderActivity = (events) => {
        if (!activityList) return;

        if (events.length === 0) {
            renderEmpty(activityList, '🕓', 'No recent activity yet.', 'Record, publish, or run an API to see activity show up here.');
            return;
        }

        activityList.innerHTML = events.map((event) => {
            const meta = ACTIVITY_META[event.type];
            return `
                <div class="activity-row">
                    <span class="activity-icon" aria-hidden="true">${meta.icon}</span>
                    <div class="activity-row-body">
                        <p class="activity-row-title">${meta.label}${event.name ? `: <strong>${escapeHtml(event.name)}</strong>` : ''}</p>
                        ${event.detail ? `<p class="activity-row-detail">${escapeHtml(event.detail)}</p>` : ''}
                    </div>
                    <span class="activity-row-time">${formatRelativeDate(event.at)}</span>
                </div>
            `;
        }).join('');
    };

    // Builds the merged, time-sorted activity feed from data this page
    // already fetches — no separate "activity log" exists on the backend, so
    // this is derived, not fabricated: my_apis only ever gets updated_at
    // bumped by the publish/unpublish toggle (see myApisController.js), so an
    // updatedAt that differs from createdAt IS a publish-state change.
    const buildActivityEvents = (apis, recentRuns) => {
        const events = [];

        apis.forEach((api) => {
            events.push({ type: 'created', name: api.name, at: api.createdAt });
            if (api.updatedAt && api.updatedAt !== api.createdAt) {
                events.push({
                    type: api.published ? 'published' : 'updated',
                    name: api.name,
                    at: api.updatedAt
                });
            }
        });

        (recentRuns || []).forEach((run) => {
            events.push({
                type: 'run',
                name: run.workflowName,
                detail: run.success ? undefined : 'Run failed',
                at: run.createdAt
            });
        });

        return events.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 10);
    };

    let creatorLoaded = false;
    const loadCreatorData = async () => {
        renderSkeletonRows(publishedList);
        renderSkeletonRows(activityList, 4);
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
            const mostPopular = ownedListings.length
                ? ownedListings.slice().sort((a, b) => (b.purchaseCount || 0) - (a.purchaseCount || 0))[0]
                : null;

            if (statDownloads) statDownloads.textContent = String(totalDownloads);
            if (statRevenue) statRevenue.textContent = `$${totalRevenue.toFixed(2)}`;
            if (statRating) statRating.textContent = avgRating ? `${avgRating.toFixed(1)} ★` : '—';
            if (statPopular) statPopular.textContent = mostPopular ? mostPopular.name : 'No published APIs yet';

            renderPublishedList(ownedListings);
            renderActivity(buildActivityEvents(apis, runStats.recentRuns));

            creatorLoaded = true;
        } catch (err) {
            console.error('[ForgeFlow][analytics] failed to load creator analytics', err);
        }
    };

    // ==================== BUYER ====================

    const buildBuyerRowHtml = (it) => `
        <div class="recent-api-row">
            <span class="recent-api-row-name">${escapeHtml(it.name)}</span>
            <span class="recent-api-row-meta">${escapeHtml(it.publisher || 'Unknown creator')}${it.purchasedAt ? ` • ${formatRelativeDate(it.purchasedAt)}` : ''}</span>
        </div>
    `;

    let buyerLoaded = false;
    const loadBuyerData = async () => {
        renderSkeletonRows(buyerRecentUsedList);
        renderSkeletonRows(buyerRecommendedList);
        try {
            const [purchasesRes, marketRes, subRes] = await Promise.all([
                fetch(`${API_BASE}/marketplace/purchases/mine`, { headers: authHeaders }),
                fetch(`${API_BASE}/marketplace`, { headers: authHeaders }),
                fetch(`${API_BASE}/subscription`, { headers: authHeaders })
            ]);

            const purchases = purchasesRes.ok ? await purchasesRes.json().catch(() => []) : [];
            const marketplace = marketRes.ok ? await marketRes.json().catch(() => []) : [];
            const subscription = subRes.ok ? await subRes.json().catch(() => ({})) : {};

            const purchaseList = Array.isArray(purchases) ? purchases : [];

            if (buyerStatPurchased) buyerStatPurchased.textContent = String(purchaseList.length);
            if (buyerStatRuns) buyerStatRuns.textContent = String(subscription.usage?.apiRuns ?? 0);

            if (buyerStatSubscription) {
                buyerStatSubscription.textContent = subscription.planLabel || 'Free Plan';
            }

            const remaining = subscription.remaining?.apiRuns;
            const limit = subscription.limits?.apiRuns;
            if (buyerStatRemainingRuns) {
                buyerStatRemainingRuns.textContent = (typeof remaining === 'number' && typeof limit === 'number')
                    ? `${remaining} / ${limit}`
                    : '—';
            }
            if (buyerRemainingRunsFill) {
                const pct = (typeof remaining === 'number' && limit > 0) ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : 0;
                buyerRemainingRunsFill.style.width = `${pct}%`;
                buyerRemainingRunsFill.classList.toggle('is-depleted', remaining === 0);
            }

            // Favorite Categories — every category the buyer has purchased
            // into, ranked by count (not just the single top one), so this
            // reads as a real "favorites" breakdown rather than one label.
            const categoryCounts = {};
            purchaseList.forEach((p) => {
                const slug = normalizeCategorySlug(p.category);
                categoryCounts[slug] = (categoryCounts[slug] || 0) + 1;
            });
            const rankedCategories = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);

            if (favoriteCategoriesList) {
                if (rankedCategories.length === 0) {
                    renderEmpty(favoriteCategoriesList, '🏷️', 'No favorite categories yet.', 'Purchase a few Marketplace APIs to see your top categories here.');
                } else {
                    favoriteCategoriesList.innerHTML = rankedCategories.slice(0, 5).map(([slug, count]) => `
                        <span class="category-chip">${escapeHtml(categoryLabel(slug))} <span class="category-chip-count">${count}</span></span>
                    `).join('');
                }
            }

            // Recently Used APIs — most recently purchased first (the best
            // available proxy for "used" until per-run history is tracked).
            const byRecency = purchaseList.slice().sort((a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt)).slice(0, 5);
            if (byRecency.length === 0) {
                renderEmpty(buyerRecentUsedList, '🕓', 'Nothing run yet.', 'Run a purchased API from Purchased APIs to see it here.');
            } else if (buyerRecentUsedList) {
                buyerRecentUsedList.innerHTML = byRecency.map((it) => buildBuyerRowHtml(it)).join('');
            }

            // Recommendations — popular/highly-rated listings not already
            // owned, same ranking heuristic the Marketplace's "Featured" row
            // and Dashboard's "Recommended APIs" use.
            const purchasedIds = new Set(purchaseList.map((p) => p.id));
            const recommended = (Array.isArray(marketplace) ? marketplace : [])
                .filter((it) => !it.isOwnedByMe && !purchasedIds.has(it.id))
                .sort((a, b) => (prototypeRating(b) * ((b.purchaseCount || 0) + 1)) - (prototypeRating(a) * ((a.purchaseCount || 0) + 1)))
                .slice(0, 5);

            if (recommended.length === 0) {
                renderEmpty(buyerRecommendedList, '✨', 'Nothing new to recommend.', 'You already own everything trending in the Marketplace right now!');
            } else if (buyerRecommendedList) {
                buyerRecommendedList.innerHTML = recommended.map((it) => `
                    <div class="recent-api-row">
                        <span class="recent-api-row-name">${escapeHtml(it.name)}</span>
                        <span class="recent-api-row-meta">${it.price > 0 ? `$${it.price}` : 'Free'} • ${prototypeRating(it).toFixed(1)} ★</span>
                    </div>
                `).join('');
            }

            buyerLoaded = true;
        } catch (err) {
            console.error('[ForgeFlow][analytics] failed to load buyer analytics', err);
        }
    };

    // ==================== ROLE SWITCHING ====================

    const applyRole = (role) => {
        const resolved = role === 'buyer' ? 'buyer' : 'creator';

        if (analyticsEyebrow) analyticsEyebrow.textContent = resolved === 'creator' ? 'ForgeFlow · Creator' : 'ForgeFlow · Buyer';
        if (topbarSubtitle) {
            topbarSubtitle.textContent = resolved === 'creator'
                ? 'How your published APIs are performing across the Marketplace.'
                : 'Your Marketplace activity — purchases, usage, and recommendations.';
        }
        if (roleBadge) {
            roleBadge.hidden = !hasSession;
            roleBadge.textContent = resolved === 'creator' ? '🚀 Creator Mode' : '🛒 Buyer Mode';
        }

        const showCreator = resolved === 'creator';
        if (creatorContent) {
            creatorContent.hidden = !showCreator;
            creatorContent.classList.toggle('mode-content--visible', showCreator);
        }
        if (buyerContent) {
            buyerContent.hidden = showCreator;
            buyerContent.classList.toggle('mode-content--visible', !showCreator);
        }

        if (!hasSession) return;

        if (showCreator && !creatorLoaded) {
            loadCreatorData();
        } else if (!showCreator && !buyerLoaded) {
            loadBuyerData();
        }
    };

    let currentRole = 'creator';
    const refresh = () => {
        if (!hasSession) return;
        if (currentRole === 'buyer') {
            buyerLoaded = false;
            loadBuyerData();
        } else {
            creatorLoaded = false;
            loadCreatorData();
        }
    };

    if (refreshBtn) refreshBtn.addEventListener('click', refresh);

    // Refetch whenever this tab regains focus/visibility, so numbers here
    // don't go stale if the user made a change (published an API, had a
    // purchase approved) in another tab and switched back.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refresh();
    });

    (async () => {
        const session = await getAuthSession();
        if (!session?.token) {
            if (authNote) {
                authNote.hidden = false;
                authNote.textContent = 'Log in from the ForgeFlow extension popup to see your Analytics.';
            }
            renderEmpty(publishedList, '📊', 'Log in to see your Analytics.', 'Publishing and buying activity will show up here once you\'re signed in.');
            applyRole('creator');
            return;
        }

        hasSession = true;
        authHeaders = { Authorization: `Bearer ${session.token}` };
        currentUserId = session.user?.id || null;

        const role = currentUserId && window.ForgeFlowRoles ? await window.ForgeFlowRoles.getRole(currentUserId) : 'creator';
        currentRole = role === 'buyer' ? 'buyer' : 'creator';
        applyRole(currentRole);

        if (currentUserId && window.ForgeFlowRoles) {
            window.ForgeFlowRoles.onRoleChange(currentUserId, (nextRole) => {
                currentRole = nextRole === 'buyer' ? 'buyer' : 'creator';
                applyRole(currentRole);
            });
        }
    })();
});
