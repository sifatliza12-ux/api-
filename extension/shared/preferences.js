/**
 * Shared local-device preferences (Settings > Preferences), plus automatic
 * "last visited page" tracking so "Remember last visited page" has a real
 * page to return to. Any full ForgeFlow tab page that includes this script
 * gets its path recorded on load (when the preference is on); the popup
 * reads getLastVisitedPage()/getPrefs() to decide where its "Open Dashboard"
 * button should actually navigate.
 */
(function () {
    const PREFS_KEY = 'forgeflow.preferences';
    const LAST_PAGE_KEY = 'forgeflow.lastVisitedPage';

    const DEFAULT_PREFS = {
        defaultLandingPage: 'dashboard/dashboard.html',
        autoOpenReplayBrowser: true,
        rememberLastPage: true
    };

    const hasChromeStorage = () => typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

    const getPrefs = () => new Promise((resolve) => {
        if (!hasChromeStorage()) { resolve({ ...DEFAULT_PREFS }); return; }
        chrome.storage.local.get(PREFS_KEY, (result) => {
            resolve({ ...DEFAULT_PREFS, ...(result?.[PREFS_KEY] || {}) });
        });
    });

    const setPrefs = (patch) => new Promise((resolve) => {
        if (!hasChromeStorage()) { resolve({ ...DEFAULT_PREFS, ...patch }); return; }
        getPrefs().then((current) => {
            const next = { ...current, ...patch };
            chrome.storage.local.set({ [PREFS_KEY]: next }, () => resolve(next));
        });
    });

    const getLastVisitedPage = () => new Promise((resolve) => {
        if (!hasChromeStorage()) { resolve(null); return; }
        chrome.storage.local.get(LAST_PAGE_KEY, (result) => resolve(result?.[LAST_PAGE_KEY] || null));
    });

    const recordCurrentPage = () => {
        if (!hasChromeStorage()) return;
        // Strip the leading "/" so the stored value is a bare extension-relative
        // path, matching what chrome.runtime.getURL()/NAV_ITEMS elsewhere expect.
        const path = window.location.pathname.replace(/^\/+/, '');
        // The popup isn't a "landing page" destination (there's nothing to
        // redirect back to), so it must never overwrite what was last
        // visited — it only *reads* prefs/getLastVisitedPage() to decide
        // where its own "Open Dashboard" button goes.
        if (!path || path.startsWith('popup/')) return;
        getPrefs().then((prefs) => {
            if (!prefs.rememberLastPage) return;
            chrome.storage.local.set({ [LAST_PAGE_KEY]: path });
        });
    };

    recordCurrentPage();

    window.ForgeFlowPreferences = { getPrefs, setPrefs, getLastVisitedPage, DEFAULT_PREFS };
})();
