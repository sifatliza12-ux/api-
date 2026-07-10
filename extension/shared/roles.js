/**
 * Shared role state — Creator vs Buyer. One account, not two: this only
 * stores which mode the *interface* should prioritize right now, keyed by
 * user id (so switching accounts on the same browser profile never leaks
 * one person's mode onto another's session), and never touches or filters
 * any actual data (APIs, purchases, workflows) — see roles.js callers in
 * dashboard.js, which always load the full data set and only change how
 * it's *displayed*.
 *
 * Persisted in chrome.storage.local (same store auth/profile/notification
 * preferences already use) and mirrored to every open ForgeFlow tab via
 * chrome.storage.onChanged, so switching roles in one tab updates the
 * others without a reload.
 */
(function () {
    const ROLES_KEY = 'forgeflow.roles'; // { [userId]: 'creator' | 'buyer' }

    const hasChromeStorage = () => typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

    const getAllRoles = () => new Promise((resolve) => {
        if (!hasChromeStorage()) { resolve({}); return; }
        chrome.storage.local.get(ROLES_KEY, (result) => resolve(result?.[ROLES_KEY] || {}));
    });

    // undefined (not 'creator'/'buyer') means this user has never chosen —
    // that's the signal dashboard.js uses to route to onboarding.
    const getRole = async (userId) => {
        if (!userId) return undefined;
        const all = await getAllRoles();
        return all[String(userId)];
    };

    const setRole = (userId, role) => new Promise((resolve) => {
        if (!userId || !hasChromeStorage()) { resolve(role); return; }
        getAllRoles().then((all) => {
            const next = { ...all, [String(userId)]: role };
            chrome.storage.local.set({ [ROLES_KEY]: next }, () => resolve(role));
        });
    });

    const hasChosenRole = async (userId) => {
        const role = await getRole(userId);
        return role === 'creator' || role === 'buyer';
    };

    // Fires `callback(newRole)` whenever this user's role changes from *any*
    // open ForgeFlow tab (including this one, for symmetry with the storage
    // API's own semantics). Returns an unsubscribe function.
    const onRoleChange = (userId, callback) => {
        if (!hasChromeStorage() || !chrome.storage.onChanged || !userId) return () => {};
        const listener = (changes, areaName) => {
            if (areaName !== 'local' || !changes[ROLES_KEY]) return;
            const nextAll = changes[ROLES_KEY].newValue || {};
            callback(nextAll[String(userId)]);
        };
        chrome.storage.onChanged.addListener(listener);
        return () => chrome.storage.onChanged.removeListener(listener);
    };

    window.ForgeFlowRoles = { getRole, setRole, hasChosenRole, onRoleChange };
})();
