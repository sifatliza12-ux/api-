/**
 * Shared persistent navigation bar. Every ForgeFlow full-page tab includes
 * this script plus an empty `<nav id="app-nav">` — this fills it in with
 * links to that mode's destinations and highlights whichever one matches
 * the current page, so users can always get from any page back to their
 * dashboard or any other page in their workspace without getting stuck.
 *
 * Navigation is done with plain `<a href>` tags pointing at
 * chrome-extension:// URLs, so clicking a link navigates the current tab
 * (not a new one) — one connected app, not a pile of separate tabs.
 *
 * Mode-aware by *filtering*, not just reordering: Creator and Buyer each see
 * only their own destinations (per product requirement — Creator/Buyer
 * should feel like two different applications sharing one account), plus
 * Settings in both. "Notifications" isn't a nav link on purpose — the bell
 * (shared/notifications.js) is already injected into every page's topbar
 * and covers that requirement without a dedicated page.
 *
 * The two dashboard pages (dashboard/creator-dashboard.html,
 * dashboard/buyer-dashboard.html) know their own mode outright and declare
 * it via `data-nav-mode` on `<nav id="app-nav">`, so they render instantly
 * with no async wait. Every other page doesn't know the mode up front, so
 * it falls back to the full union list for the first paint, then re-renders
 * once shared/roles.js resolves the user's saved mode (and again live, on
 * any cross-tab mode switch).
 */
(function () {
    const CREATOR_NAV_ITEMS = [
        { key: 'dashboard', label: 'Dashboard', icon: '🏠', path: 'dashboard/creator-dashboard.html' },
        { key: 'record', label: 'Record Workflow', icon: '⏺', path: 'dashboard/creator-dashboard.html#record-banner' },
        { key: 'my-apis', label: 'My APIs', icon: '✦', path: 'my-apis/my-apis.html' },
        { key: 'published-apis', label: 'Published APIs', icon: '📦', path: 'my-apis/my-apis.html?filter=published' },
        { key: 'analytics', label: 'Analytics', icon: '📊', path: 'analytics/analytics.html' },
        { key: 'wallet', label: 'Wallet', icon: '💰', path: 'wallet/wallet.html' },
        { key: 'purchase-requests', label: 'Purchase Requests', icon: '📥', path: 'purchase-requests/purchase-requests.html' },
        { key: 'settings', label: 'Settings', icon: '⚙', path: 'settings/settings.html' }
    ];

    const BUYER_NAV_ITEMS = [
        { key: 'dashboard', label: 'Dashboard', icon: '🏠', path: 'dashboard/buyer-dashboard.html' },
        { key: 'marketplace', label: 'Marketplace', icon: '◫', path: 'marketplace/marketplace.html' },
        { key: 'purchased-apis', label: 'Purchased APIs', icon: '🛒', path: 'purchased-apis/purchased-apis.html' },
        { key: 'run-api', label: 'Run API', icon: '▶', path: 'dashboard/buyer-dashboard.html#quick-run-widget' },
        { key: 'purchase-history', label: 'Purchase History', icon: '🧾', path: 'my-purchases/my-purchases.html' },
        { key: 'settings', label: 'Settings', icon: '⚙', path: 'settings/settings.html' }
    ];

    // Pre-role-known fallback only (first paint on pages that don't declare
    // data-nav-mode, before the async role lookup below resolves) — points
    // "Dashboard" at the universal Mode Selection gateway since which
    // per-mode dashboard to link to isn't known yet.
    const ALL_ITEMS = [
        { key: 'dashboard', label: 'Dashboard', icon: '🏠', path: 'mode-select/mode-select.html' },
        { key: 'marketplace', label: 'Marketplace', icon: '◫', path: 'marketplace/marketplace.html' },
        { key: 'purchased-apis', label: 'Purchased APIs', icon: '🛒', path: 'purchased-apis/purchased-apis.html' },
        { key: 'purchase-history', label: 'Purchase History', icon: '🧾', path: 'my-purchases/my-purchases.html' },
        { key: 'my-apis', label: 'My APIs', icon: '✦', path: 'my-apis/my-apis.html' },
        { key: 'published-apis', label: 'Published APIs', icon: '📦', path: 'my-apis/my-apis.html?filter=published' },
        { key: 'purchase-requests', label: 'Purchase Requests', icon: '📥', path: 'purchase-requests/purchase-requests.html' },
        { key: 'wallet', label: 'Wallet', icon: '💰', path: 'wallet/wallet.html' },
        { key: 'analytics', label: 'Analytics', icon: '📊', path: 'analytics/analytics.html' },
        { key: 'settings', label: 'Settings', icon: '⚙', path: 'settings/settings.html' }
    ];

    const AUTH_STORAGE_KEY = 'forgeflow.auth';

    const itemsForMode = (mode) => {
        if (mode === 'creator') return CREATOR_NAV_ITEMS;
        if (mode === 'buyer') return BUYER_NAV_ITEMS;
        return ALL_ITEMS;
    };

    const splitPath = (path) => {
        const [pathAndQuery, hash] = path.split('#');
        const [pathOnly, query] = pathAndQuery.split('?');
        return { pathOnly: '/' + pathOnly, query: query || '', hash: hash ? '#' + hash : '' };
    };

    // Generic active-link match: an item is active only if its own path
    // matches AND its own query/hash suffix matches the current URL's — so
    // pages sharing one physical file but distinguished by ?query (My APIs
    // vs Published APIs) or #hash (Dashboard vs Record Workflow, Dashboard
    // vs Run API) never both read as active at once, with no hardcoded
    // per-key special-casing.
    const isActive = (item) => {
        const currentPath = window.location.pathname || '';
        const currentSearch = window.location.search || '';
        const currentHash = window.location.hash || '';
        const { pathOnly, query, hash } = splitPath(item.path);

        if (!currentPath.endsWith(pathOnly)) return false;
        if (query && !currentSearch.includes(query)) return false;
        if (!query && currentSearch.includes('filter=published')) return false;
        if (hash && currentHash !== hash) return false;
        if (!hash && currentHash && (currentHash === '#record-banner' || currentHash === '#quick-run-widget')) return false;

        return true;
    };

    const renderNav = (mode) => {
        const container = document.getElementById('app-nav');
        if (!container || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
            return;
        }

        container.innerHTML = itemsForMode(mode).map((item) => {
            const href = chrome.runtime.getURL(item.path);
            const activeClass = isActive(item) ? ' active' : '';
            return `
                <a class="app-nav-link${activeClass}" href="${href}" data-nav-key="${item.key}"${isActive(item) ? ' aria-current="page"' : ''}>
                    <span class="app-nav-icon" aria-hidden="true">${item.icon}</span>
                    <span>${item.label}</span>
                </a>
            `;
        }).join('');
    };

    const getAuthSession = () => new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.storage) { resolve(null); return; }
        chrome.storage.local.get(AUTH_STORAGE_KEY, (result) => resolve(result?.[AUTH_STORAGE_KEY] || null));
    });

    const init = async () => {
        const container = document.getElementById('app-nav');
        const declaredMode = container?.dataset?.navMode;

        // The two dashboard pages know their own mode outright — render it
        // immediately, no async role lookup needed.
        if (declaredMode === 'creator' || declaredMode === 'buyer') {
            renderNav(declaredMode);
            return;
        }

        // Every other page: render the neutral union immediately so the nav
        // never sits empty, then re-render once (if) a role is known.
        renderNav(null);

        if (!window.ForgeFlowRoles) return;
        const session = await getAuthSession();
        const userId = session?.user?.id;
        if (!userId) return;

        const role = await window.ForgeFlowRoles.getRole(userId);
        renderNav(role);

        window.ForgeFlowRoles.onRoleChange(userId, (nextRole) => renderNav(nextRole));
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
