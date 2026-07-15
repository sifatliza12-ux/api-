/**
 * mode-select.js
 * The gateway screen between login and the two dashboards. Shown every time
 * the Dashboard entry point is reached (see popup.js's openDashboardTab),
 * not just on first login — a previously-chosen mode is indicated with a
 * "Last used" badge, but picking a card (even the same one again) is always
 * a deliberate click. Only ever reads/writes the role preference via
 * shared/roles.js; no API/workflow/purchase data is touched here.
 */

const AUTH_STORAGE_KEY = 'forgeflow.auth';

const getAuthSession = () => new Promise((resolve) => {
    chrome.storage.local.get(AUTH_STORAGE_KEY, (result) => {
        resolve(result?.[AUTH_STORAGE_KEY] || null);
    });
});

document.addEventListener('DOMContentLoaded', () => {
    const authNote = document.getElementById('auth-note');
    const roleButtons = document.querySelectorAll('[data-role-choice]');

    const DASHBOARD_PATH_BY_ROLE = {
        creator: 'dashboard/creator-dashboard.html',
        buyer: 'dashboard/buyer-dashboard.html'
    };

    const goToDashboard = (role) => {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
            window.location.href = chrome.runtime.getURL(DASHBOARD_PATH_BY_ROLE[role] || DASHBOARD_PATH_BY_ROLE.creator);
        }
    };

    const chooseRole = async (role, userId) => {
        if (window.ForgeFlowRoles) {
            await window.ForgeFlowRoles.setRole(userId, role);
        }
        goToDashboard(role);
    };

    const markLastUsed = (role) => {
        if (!role) return;
        const card = document.querySelector(`.role-card[data-role="${role}"]`);
        if (!card) return;
        card.classList.add('role-card--last-used');
        const badge = card.querySelector('[data-last-used-badge]');
        if (badge) badge.hidden = false;
    };

    (async () => {
        const session = await getAuthSession();
        if (!session?.token || !session?.user?.id) {
            if (authNote) {
                authNote.hidden = false;
                authNote.textContent = 'Log in from the ForgeFlow extension popup first, then reopen the Dashboard to choose Creator or Buyer.';
            }
            roleButtons.forEach((btn) => { btn.disabled = true; });
            return;
        }

        roleButtons.forEach((btn) => {
            btn.addEventListener('click', () => chooseRole(btn.dataset.roleChoice, session.user.id));
        });

        if (window.ForgeFlowRoles) {
            const currentRole = await window.ForgeFlowRoles.getRole(session.user.id);
            markLastUsed(currentRole);
        }
    })();
});
