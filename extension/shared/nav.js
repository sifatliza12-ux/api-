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
 */
(function () {
    const NAV_ITEMS = [
        { key: 'dashboard', label: 'Dashboard', icon: '🏠', path: 'dashboard/dashboard.html' },
        { key: 'marketplace', label: 'Marketplace', icon: '◫', path: 'marketplace/marketplace.html' },
        { key: 'purchased-apis', label: 'Purchased APIs', icon: '🛒', path: 'purchased-apis/purchased-apis.html' },
        { key: 'my-apis', label: 'My APIs', icon: '✦', path: 'my-apis/my-apis.html' },
        { key: 'published-apis', label: 'Published APIs', icon: '📦', path: 'my-apis/my-apis.html?filter=published' },
        { key: 'plans', label: 'Plans & Pricing', icon: '◎', path: 'plans/plans.html' },
        { key: 'settings', label: 'Settings', icon: '⚙', path: 'settings/settings.html' }
    ];

    const pathTail = (path) => '/' + path.split('?')[0];

    // "My APIs" and "Published APIs" are the same physical page
    // (my-apis/my-apis.html) distinguished only by ?filter=published, so
    // matching has to look at both the path and that query flag to decide
    // which single nav item should read as active.
    const isActive = (item) => {
        const currentPath = window.location.pathname || '';
        const currentSearch = window.location.search || '';

        if (!currentPath.endsWith(pathTail(item.path))) {
            return false;
        }

        const isPublishedFilter = currentSearch.includes('filter=published');
        if (item.key === 'published-apis') return isPublishedFilter;
        if (item.key === 'my-apis') return !isPublishedFilter;
        return true;
    };

    const renderNav = () => {
        const container = document.getElementById('app-nav');
        if (!container || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
            return;
        }

        container.innerHTML = NAV_ITEMS.map((item) => {
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', renderNav);
    } else {
        renderNav();
    }
})();
