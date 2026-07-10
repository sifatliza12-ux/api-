/**
 * Global theme switcher, shared by every ForgeFlow extension page. All
 * extension pages live under the same chrome-extension://<id> origin, so
 * localStorage is already shared and synchronous across them — that's what
 * lets this run as a blocking <head> script and set the theme attribute
 * before first paint (no flash of the wrong theme), and what lets the
 * `storage` event below keep every other open ForgeFlow tab in sync the
 * instant the preference changes in one of them.
 *
 * Preference values: 'dark' | 'light' | 'system'. Resolved to an actual
 * 'dark' | 'light' written to <html data-theme="...">, which shared/theme.css
 * (loaded by every page alongside its own stylesheet) uses to override that
 * page's own --bg-a/--panel/--text/etc. variables.
 */
(function () {
    const THEME_KEY = 'forgeflow.theme';
    const root = document.documentElement;

    const systemPrefersLight = () => Boolean(
        window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    );

    const resolveTheme = (pref) => {
        if (pref === 'light' || pref === 'dark') return pref;
        return systemPrefersLight() ? 'light' : 'dark';
    };

    const getPreference = () => {
        try {
            return localStorage.getItem(THEME_KEY) || 'system';
        } catch (err) {
            return 'system';
        }
    };

    const applyTheme = (pref) => {
        root.setAttribute('data-theme', resolveTheme(pref));
    };

    // Applied synchronously, before CSS/paint, so there's no flash.
    applyTheme(getPreference());

    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
            if (getPreference() === 'system') applyTheme('system');
        });
    }

    // Fires in *other* open ForgeFlow tabs when one tab changes the
    // preference — same-origin localStorage writes don't raise this event
    // in the tab that made the change, only in the others, which is exactly
    // the cross-tab sync behavior we want.
    window.addEventListener('storage', (event) => {
        if (event.key === THEME_KEY) applyTheme(event.newValue || 'system');
    });

    window.ForgeFlowTheme = {
        get: getPreference,
        set(pref) {
            try { localStorage.setItem(THEME_KEY, pref); } catch (err) { /* private mode etc. */ }
            applyTheme(pref);
        }
    };
})();
