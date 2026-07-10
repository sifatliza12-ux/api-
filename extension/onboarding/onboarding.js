/**
 * onboarding.js
 * First-time role choice. dashboard.js redirects here whenever a logged-in
 * user has no role saved yet (shared/roles.js hasChosenRole); picking a card
 * here just calls ForgeFlowRoles.setRole and sends the user back to the
 * Dashboard, which will now render in that mode. No API/workflow/purchase
 * data is read or written here — this only ever touches the role
 * preference.
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

    const goToDashboard = () => {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
            window.location.href = chrome.runtime.getURL('dashboard/dashboard.html');
        }
    };

    const chooseRole = async (role, userId) => {
        if (window.ForgeFlowRoles) {
            await window.ForgeFlowRoles.setRole(userId, role);
        }
        goToDashboard();
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
    })();
});
