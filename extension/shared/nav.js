/**
 * Shared persistent navigation bar. Every ForgeFlow tab page includes this
 * script plus an empty `<nav id="app-nav">` — this fills it in with links
 * to every top-level destination and highlights whichever one matches the
 * current page, so users can always get from any page to any other page
 * without ever getting stuck.
 *
 * Navigation is done with plain `<a href>` tags pointing at
 * chrome-extension:// URLs, so clicking a link navigates the current tab
 * (not a new one) — one connected app, not a pile of separate tabs.
 *
 * Role-aware: every item always renders (Creator/Buyer mode never removes a
 * page, per product requirement) — only the *order* changes, prioritizing
 * whichever pages matter most for the current role. Falls back to the
 * original fixed order when there's no session or no role chosen yet.
 */
(function () {
    const NAV_ITEMS = [
        { key: 'dashboard', label: 'Dashboard', icon: '🏠', path: 'dashboard/dashboard.html' },
        { key: 'record', label: 'Record Workflow', icon: '⏺', path: 'dashboard/dashboard.html#record-banner' },
        { key: 'marketplace', label: 'Marketplace', icon: '◫', path: 'marketplace/marketplace.html' },
        { key: 'purchased-apis', label: 'Purchased APIs', icon: '🛒', path: 'purchased-apis/purchased-apis.html' },
        { key: 'my-purchases', label: 'My Purchases', icon: '🧾', path: 'my-purchases/my-purchases.html' },
        { key: 'my-apis', label: 'My APIs', icon: '✦', path: 'my-apis/my-apis.html' },
        { key: 'published-apis', label: 'Published APIs', icon: '📦', path: 'my-apis/my-apis.html?filter=published' },
        { key: 'purchase-requests', label: 'Purchase Requests', icon: '📥', path: 'purchase-requests/purchase-requests.html' },
        { key: 'wallet', label: 'Wallet', icon: '💰', path: 'wallet/wallet.html' },
        { key: 'analytics', label: 'Analytics', icon: '📊', path: 'analytics/analytics.html' },
        { key: 'plans', label: 'Plans & Pricing', icon: '◎', path: 'plans/plans.html' },
        { key: 'settings', label: 'Settings', icon: '⚙', path: 'settings/settings.html' }
    ];

    const CREATOR_PRIORITY = ['dashboard', 'record', 'my-apis', 'published-apis', 'purchase-requests', 'wallet', 'analytics', 'plans', 'settings'];
    const BUYER_PRIORITY = ['dashboard', 'marketplace', 'purchased-apis', 'my-purchases', 'plans', 'settings'];

    const AUTH_STORAGE_KEY = 'forgeflow.auth';

    const pathTail = (path) => '/' + path.split('?')[0].split('#')[0];

    // "My APIs" and "Published APIs" are the same physical page
    // (my-apis/my-apis.html) distinguished only by ?filter=published, and
    // "Dashboard"/"Record Workflow" are the same page distinguished only by
    // the #record-banner hash — matching has to look past the bare path for
    // both pairs so only one of each ever reads as active at a time.
    const isActive = (item) => {
        const currentPath = window.location.pathname || '';
        const currentSearch = window.location.search || '';
        const currentHash = window.location.hash || '';

        if (!currentPath.endsWith(pathTail(item.path))) {
            return false;
        }

        const isPublishedFilter = currentSearch.includes('filter=published');
        if (item.key === 'published-apis') return isPublishedFilter;
        if (item.key === 'my-apis') return !isPublishedFilter;

        const isRecordHash = currentHash === '#record-banner';
        if (item.key === 'record') return isRecordHash;
        if (item.key === 'dashboard') return !isRecordHash;

        return true;
    };

    // Priority keys first (in the given order), then everything else in its
    // original NAV_ITEMS order — every item is always included.
    const orderForRole = (role) => {
        const priority = role === 'creator' ? CREATOR_PRIORITY : role === 'buyer' ? BUYER_PRIORITY : null;
        if (!priority) return NAV_ITEMS;

        const byKey = new Map(NAV_ITEMS.map((item) => [item.key, item]));
        const ordered = priority.map((key) => byKey.get(key)).filter(Boolean);
        const remaining = NAV_ITEMS.filter((item) => !priority.includes(item.key));
        return [...ordered, ...remaining];
    };

    const renderNav = (role) => {
        const container = document.getElementById('app-nav');
        if (!container || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
            return;
        }

        container.innerHTML = orderForRole(role).map((item) => {
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
        // Render immediately in the default order so the nav never sits
        // empty while the role loads, then re-render once (if) a role is
        // known — a single reflow, same tradeoff every async-loaded stat on
        // these pages already makes.
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
