/**
 * settings.js
 * Profile, Appearance, Notifications, Preferences, Account, Security, and
 * About — the Settings page. Authentication itself (login/register/logout
 * endpoints, token handling) is untouched; this page only *reads* the
 * existing session (GET /api/auth/me) and the existing subscription usage
 * (GET /subscription), the same way Dashboard/Marketplace/My APIs already
 * do. Profile edits, notification toggles, and preferences with no backend
 * counterpart yet are stored locally (chrome.storage.local), same pattern
 * the task brief calls for elsewhere ("local preferences for now").
 */

const API_BASE = window.FORGEFLOW_API_BASE;
const AUTH_STORAGE_KEY = 'forgeflow.auth';
const PROFILE_OVERRIDES_KEY = 'forgeflow.profileOverrides';
const NOTIFICATION_PREFS_KEY = 'forgeflow.notificationPrefs';

// No CI/build pipeline exists yet to stamp a real build number — this is a
// stable placeholder until one does, distinct from the manifest version.
const BUILD_NUMBER = '1000';

const DEFAULT_NOTIFICATION_PREFS = {
    marketplaceUpdates: true,
    apiPurchases: true,
    apiPublished: true,
    productAnnouncements: true
};

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

const saveAuthSession = (token, user) => new Promise((resolve) => {
    chrome.storage.local.set({ [AUTH_STORAGE_KEY]: { token, user } }, resolve);
});

const clearAuthSession = () => new Promise((resolve) => {
    chrome.storage.local.remove(AUTH_STORAGE_KEY, resolve);
});

const getStorageValue = (key, fallback) => new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result?.[key] ?? fallback));
});

const setStorageValue = (key, value) => new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
});

document.addEventListener('DOMContentLoaded', () => {
    const authNote = document.getElementById('auth-note');

    // Profile
    const profileAvatar = document.getElementById('profile-avatar');
    const profileName = document.getElementById('profile-name');
    const profileEmail = document.getElementById('profile-email');
    const profileUsername = document.getElementById('profile-username');
    const editProfileBtn = document.getElementById('edit-profile-btn');

    // Appearance
    const themeToggleGroup = document.getElementById('theme-toggle-group');

    // Role
    const roleToggleGroup = document.getElementById('role-toggle-group');

    // Notifications
    const notificationsList = document.getElementById('notifications-list');

    // Preferences
    const prefLandingPage = document.getElementById('pref-landing-page');
    const prefAutoOpenReplay = document.getElementById('pref-auto-open-replay');
    const prefRememberLastPage = document.getElementById('pref-remember-last-page');

    // Account
    const accountPlan = document.getElementById('account-plan');
    const accountGenerations = document.getElementById('account-generations');
    const accountRuns = document.getElementById('account-runs');
    const upgradePlanBtn = document.getElementById('upgrade-plan-btn');

    // Security
    const changePasswordBtn = document.getElementById('change-password-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const deleteAccountBtn = document.getElementById('delete-account-btn');

    // About
    const aboutVersion = document.getElementById('about-version');
    const aboutBuild = document.getElementById('about-build');
    const privacyPolicyBtn = document.getElementById('privacy-policy-btn');
    const termsBtn = document.getElementById('terms-btn');

    let currentUser = null;
    let authHeaders = {};
    let profileOverrides = {};

    // --- Generic modal helper, matching the overlay/modal pattern already
    // used across Marketplace/My APIs/Purchased APIs. ---
    const openModal = ({ title, bodyHtml, actionsHtml }) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <h3>${escapeHtml(title)}</h3>
            <div class="modal-scroll-body">${bodyHtml}</div>
            <div class="modal-actions">${actionsHtml}</div>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        return { overlay, modal };
    };

    const closeModal = (overlay) => overlay.remove();

    // --- Profile ---

    const defaultUsername = (email) => (email || '').split('@')[0] || 'user';

    const renderProfile = () => {
        const name = profileOverrides.name || currentUser?.name || 'Unnamed';
        const username = profileOverrides.username || defaultUsername(currentUser?.email);
        const email = currentUser?.email || 'Log in to see your email';

        if (profileName) profileName.textContent = name;
        if (profileEmail) profileEmail.textContent = email;
        if (profileUsername) profileUsername.textContent = `@${username}`;
        if (profileAvatar) profileAvatar.textContent = (name || '?').trim().charAt(0).toUpperCase() || 'U';
    };

    const openEditProfileModal = () => {
        if (!currentUser) {
            alert('Log in from the ForgeFlow extension popup to edit your profile.');
            return;
        }

        const name = profileOverrides.name || currentUser.name || '';
        const username = profileOverrides.username || defaultUsername(currentUser.email);

        const { overlay, modal } = openModal({
            title: 'Edit Profile',
            bodyHtml: `
                <p>Profile edits are saved on this device for now — full account sync is on the roadmap.</p>
                <div class="modal-field">
                    <label for="edit-profile-name">Full Name</label>
                    <input type="text" id="edit-profile-name" value="${escapeHtml(name)}">
                </div>
                <div class="modal-field">
                    <label for="edit-profile-username">Username</label>
                    <input type="text" id="edit-profile-username" value="${escapeHtml(username)}">
                </div>
            `,
            actionsHtml: `
                <button type="button" class="btn btn-secondary modal-cancel">Cancel</button>
                <button type="button" class="btn btn-primary modal-save">Save Changes</button>
            `
        });

        modal.querySelector('.modal-cancel').addEventListener('click', () => closeModal(overlay));

        modal.querySelector('.modal-save').addEventListener('click', async () => {
            const newName = modal.querySelector('#edit-profile-name').value.trim();
            const newUsername = modal.querySelector('#edit-profile-username').value.trim();

            if (!newName) {
                alert('Full name cannot be empty.');
                return;
            }

            profileOverrides = { ...profileOverrides, name: newName, username: newUsername || defaultUsername(currentUser.email) };
            await setStorageValue(PROFILE_OVERRIDES_KEY, profileOverrides);
            renderProfile();
            closeModal(overlay);
        });
    };

    // --- Appearance ---

    const renderThemeSelection = () => {
        if (!themeToggleGroup || !window.ForgeFlowTheme) return;
        const current = window.ForgeFlowTheme.get();
        themeToggleGroup.querySelectorAll('.theme-option').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.themeValue === current);
            btn.setAttribute('aria-checked', String(btn.dataset.themeValue === current));
        });
    };

    if (themeToggleGroup) {
        themeToggleGroup.querySelectorAll('.theme-option').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (!window.ForgeFlowTheme) return;
                window.ForgeFlowTheme.set(btn.dataset.themeValue);
                renderThemeSelection();
            });
        });
    }

    // --- Role (Creator / Buyer) ---
    // Same account either way — this only ever changes shared/roles.js's
    // stored preference, never any API/purchase data. Dashboard reads the
    // same preference (and the two stay in sync live via
    // ForgeFlowRoles.onRoleChange), so switching here updates the Dashboard
    // instantly without a reload, same as switching from the Dashboard
    // updates here.
    const renderRoleSelection = async () => {
        if (!roleToggleGroup || !window.ForgeFlowRoles || !currentUser) return;
        const current = await window.ForgeFlowRoles.getRole(currentUser.id);
        roleToggleGroup.querySelectorAll('.theme-option').forEach((btn) => {
            const isActive = btn.dataset.roleValue === current;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-checked', String(isActive));
        });
    };

    if (roleToggleGroup) {
        roleToggleGroup.querySelectorAll('.theme-option').forEach((btn) => {
            btn.addEventListener('click', async () => {
                if (!window.ForgeFlowRoles || !currentUser) {
                    alert('Log in from the ForgeFlow extension popup to choose a role.');
                    return;
                }
                await window.ForgeFlowRoles.setRole(currentUser.id, btn.dataset.roleValue);
                await renderRoleSelection();
            });
        });
    }

    // --- Notifications ---

    const renderNotifications = (prefs) => {
        if (!notificationsList) return;
        notificationsList.querySelectorAll('input[data-notif-key]').forEach((input) => {
            input.checked = Boolean(prefs[input.dataset.notifKey]);
        });
    };

    const loadNotifications = async () => {
        const prefs = await getStorageValue(NOTIFICATION_PREFS_KEY, DEFAULT_NOTIFICATION_PREFS);
        renderNotifications({ ...DEFAULT_NOTIFICATION_PREFS, ...prefs });
    };

    if (notificationsList) {
        notificationsList.querySelectorAll('input[data-notif-key]').forEach((input) => {
            input.addEventListener('change', async () => {
                const current = await getStorageValue(NOTIFICATION_PREFS_KEY, DEFAULT_NOTIFICATION_PREFS);
                const next = { ...DEFAULT_NOTIFICATION_PREFS, ...current, [input.dataset.notifKey]: input.checked };
                await setStorageValue(NOTIFICATION_PREFS_KEY, next);
            });
        });
    }

    // --- Preferences ---

    const loadPreferences = async () => {
        if (!window.ForgeFlowPreferences) return;
        const prefs = await window.ForgeFlowPreferences.getPrefs();
        if (prefLandingPage) prefLandingPage.value = prefs.defaultLandingPage;
        if (prefAutoOpenReplay) prefAutoOpenReplay.checked = Boolean(prefs.autoOpenReplayBrowser);
        if (prefRememberLastPage) prefRememberLastPage.checked = Boolean(prefs.rememberLastPage);
    };

    if (prefLandingPage) {
        prefLandingPage.addEventListener('change', () => {
            window.ForgeFlowPreferences?.setPrefs({ defaultLandingPage: prefLandingPage.value });
        });
    }
    if (prefAutoOpenReplay) {
        prefAutoOpenReplay.addEventListener('change', () => {
            window.ForgeFlowPreferences?.setPrefs({ autoOpenReplayBrowser: prefAutoOpenReplay.checked });
        });
    }
    if (prefRememberLastPage) {
        prefRememberLastPage.addEventListener('change', () => {
            window.ForgeFlowPreferences?.setPrefs({ rememberLastPage: prefRememberLastPage.checked });
        });
    }

    // --- Account ---

    const loadAccount = async () => {
        if (!currentUser) {
            if (accountPlan) accountPlan.textContent = '—';
            if (accountGenerations) accountGenerations.textContent = '—';
            if (accountRuns) accountRuns.textContent = '—';
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/subscription`, { headers: authHeaders });
            if (!response.ok) return;
            const sub = await response.json().catch(() => ({}));
            if (accountPlan) accountPlan.textContent = sub.planLabel || 'Free Plan';
            if (accountGenerations) accountGenerations.textContent = `${sub.remaining?.apiGenerations ?? '—'} / ${sub.limits?.apiGenerations ?? '—'}`;
            if (accountRuns) accountRuns.textContent = `${sub.remaining?.apiRuns ?? '—'} / ${sub.limits?.apiRuns ?? '—'}`;
        } catch (err) {
            console.error('[ForgeFlow][settings] failed to load account/subscription info', err);
        }
    };

    if (upgradePlanBtn) {
        upgradePlanBtn.addEventListener('click', () => {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
                window.location.href = chrome.runtime.getURL('plans/plans.html');
            }
        });
    }

    // --- Security ---

    const openChangePasswordModal = () => {
        if (!currentUser) {
            alert('Log in from the ForgeFlow extension popup first.');
            return;
        }

        const { overlay, modal } = openModal({
            title: 'Change Password',
            bodyHtml: `
                <p>Password changes aren't connected to the backend yet — this is a placeholder for now.</p>
                <div class="modal-field">
                    <label for="cp-current">Current Password</label>
                    <input type="password" id="cp-current" autocomplete="current-password">
                </div>
                <div class="modal-field">
                    <label for="cp-new">New Password</label>
                    <input type="password" id="cp-new" autocomplete="new-password">
                </div>
                <div class="modal-field">
                    <label for="cp-confirm">Confirm New Password</label>
                    <input type="password" id="cp-confirm" autocomplete="new-password">
                </div>
            `,
            actionsHtml: `
                <button type="button" class="btn btn-secondary modal-cancel">Cancel</button>
                <button type="button" class="btn btn-primary modal-save">Update Password</button>
            `
        });

        modal.querySelector('.modal-cancel').addEventListener('click', () => closeModal(overlay));
        modal.querySelector('.modal-save').addEventListener('click', () => {
            const newPass = modal.querySelector('#cp-new').value;
            const confirmPass = modal.querySelector('#cp-confirm').value;
            if (!newPass || newPass !== confirmPass) {
                alert('New password and confirmation must match.');
                return;
            }
            closeModal(overlay);
            alert('Password changes are not connected to the backend yet. This screen is a placeholder for now.');
        });
    };

    const updateSecurityGatedUI = () => {
        const loggedIn = Boolean(currentUser);
        if (logoutBtn) logoutBtn.disabled = !loggedIn;
        if (changePasswordBtn) changePasswordBtn.disabled = !loggedIn;
        if (deleteAccountBtn) deleteAccountBtn.disabled = !loggedIn;
        if (editProfileBtn) editProfileBtn.disabled = !loggedIn;
    };

    const handleLogout = async () => {
        if (logoutBtn) logoutBtn.disabled = true;
        const session = await getAuthSession();
        if (session?.token) {
            try {
                await fetch(`${API_BASE}/api/auth/logout`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${session.token}` }
                });
            } catch (err) {
                console.warn('[ForgeFlow][settings] logout request failed, clearing local session anyway', err);
            }
        }

        const loggedOutUserId = session?.user?.id || null;

        // Full teardown: the auth session itself, any locally-cached profile
        // overrides (previously left in place, so the profile card kept
        // showing the old name/username after logout), and this user's
        // Creator/Buyer role choice.
        await clearAuthSession();
        await setStorageValue(PROFILE_OVERRIDES_KEY, {});
        if (loggedOutUserId && window.ForgeFlowRoles) {
            await window.ForgeFlowRoles.clearRole(loggedOutUserId);
        }

        // Settings has no login form of its own — the popup is the only
        // login screen in the app, so send the user there instead of
        // leaving them on a page whose nav/notifications chrome still looks
        // fully signed-in.
        window.location.href = chrome.runtime.getURL('popup/popup.html');
    };

    const openDeleteAccountModal = () => {
        if (!currentUser) {
            alert('Log in from the ForgeFlow extension popup first.');
            return;
        }

        const { overlay, modal } = openModal({
            title: 'Delete Account',
            bodyHtml: `
                <p class="modal-warning">This will permanently delete your account, your APIs, and your Marketplace listings. This action cannot be undone.</p>
                <p>Type <strong>DELETE</strong> below to confirm.</p>
                <div class="modal-field">
                    <label for="delete-confirm-input">Confirmation</label>
                    <input type="text" id="delete-confirm-input" autocomplete="off">
                </div>
            `,
            actionsHtml: `
                <button type="button" class="btn btn-secondary modal-cancel">Cancel</button>
                <button type="button" class="btn btn-danger modal-confirm-delete">Delete Account</button>
            `
        });

        modal.querySelector('.modal-cancel').addEventListener('click', () => closeModal(overlay));
        modal.querySelector('.modal-confirm-delete').addEventListener('click', () => {
            const confirmValue = modal.querySelector('#delete-confirm-input').value.trim();
            if (confirmValue !== 'DELETE') {
                alert('Type DELETE to confirm.');
                return;
            }
            closeModal(overlay);
            alert('Account deletion is not connected to the backend yet. This screen is a placeholder for now — your account has not been deleted.');
        });
    };

    if (changePasswordBtn) changePasswordBtn.addEventListener('click', openChangePasswordModal);
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
    if (deleteAccountBtn) deleteAccountBtn.addEventListener('click', openDeleteAccountModal);
    if (editProfileBtn) editProfileBtn.addEventListener('click', openEditProfileModal);

    // --- About ---

    const renderAbout = () => {
        const manifest = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
            ? chrome.runtime.getManifest()
            : { version: '1.0.0' };
        if (aboutVersion) aboutVersion.textContent = manifest.version || '1.0.0';
        if (aboutBuild) aboutBuild.textContent = BUILD_NUMBER;
    };

    const openPlaceholderDoc = (title, bodyText) => {
        const { overlay, modal } = openModal({
            title,
            bodyHtml: `<p>${escapeHtml(bodyText)}</p>`,
            actionsHtml: `<button type="button" class="btn btn-secondary modal-close">Close</button>`
        });
        modal.querySelector('.modal-close').addEventListener('click', () => closeModal(overlay));
    };

    if (privacyPolicyBtn) {
        privacyPolicyBtn.addEventListener('click', () => openPlaceholderDoc(
            'Privacy Policy',
            "ForgeFlow's full Privacy Policy is coming soon. This is a placeholder while the document is being finalized."
        ));
    }
    if (termsBtn) {
        termsBtn.addEventListener('click', () => openPlaceholderDoc(
            'Terms of Service',
            "ForgeFlow's full Terms of Service is coming soon. This is a placeholder while the document is being finalized."
        ));
    }

    // --- Init ---

    (async () => {
        renderThemeSelection();
        renderAbout();
        await loadNotifications();
        await loadPreferences();

        const session = await getAuthSession();
        if (!session?.token) {
            updateSecurityGatedUI();
            renderProfile();
            await loadAccount();
            if (authNote) {
                authNote.hidden = false;
                authNote.textContent = 'Log in from the ForgeFlow extension popup to see your profile and account details.';
            }
            return;
        }

        authHeaders = { Authorization: `Bearer ${session.token}` };

        try {
            const response = await fetch(`${API_BASE}/api/auth/me`, { headers: authHeaders });
            const data = await response.json().catch(() => ({}));
            if (response.ok && data.success) {
                currentUser = data.user;
                await saveAuthSession(session.token, data.user);
            } else {
                // Server explicitly rejected this token (expired, or logged
                // out from another tab) — don't keep trusting the cached
                // user, discard the stale session like popup.js already does.
                await clearAuthSession();
                currentUser = null;
                authHeaders = {};
            }
        } catch (err) {
            // Couldn't reach the server at all — keep the cached user rather
            // than logging out over a network blip, unlike an explicit 401.
            console.warn('[ForgeFlow][settings] could not verify session, using cached user', err);
            currentUser = session.user || null;
        }

        profileOverrides = await getStorageValue(PROFILE_OVERRIDES_KEY, {});
        renderProfile();
        updateSecurityGatedUI();
        await renderRoleSelection();
        await loadAccount();
    })();
});
