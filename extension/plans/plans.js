/**
 * plans.js
 * Dedicated Plans & Pricing extension tab. Shows real per-user usage
 * against the Free plan's limits (read from the backend's /subscription
 * endpoint) and explains how Marketplace pricing works — ForgeFlow prices
 * individual APIs by workflow complexity rather than gating the
 * Marketplace itself behind a subscription tier.
 */

const API_BASE = window.FORGEFLOW_API_BASE;
const AUTH_STORAGE_KEY = 'forgeflow.auth';

// Same storage key/shape popup.js writes on login — read-only here since
// this page never signs a user in or out itself.
const getAuthSession = () => new Promise((resolve) => {
    chrome.storage.local.get(AUTH_STORAGE_KEY, (result) => {
        resolve(result?.[AUTH_STORAGE_KEY] || null);
    });
});

document.addEventListener('DOMContentLoaded', () => {
    const planPill = document.getElementById('plan-pill');
    const usageNote = document.getElementById('usage-note');
    const generationsValue = document.getElementById('usage-generations-value');
    const generationsFill = document.getElementById('usage-generations-fill');
    const generationsBar = document.getElementById('usage-generations-bar');
    const runsValue = document.getElementById('usage-runs-value');
    const runsFill = document.getElementById('usage-runs-fill');
    const runsBar = document.getElementById('usage-runs-bar');
    const upgradeBtn = document.getElementById('upgrade-btn');

    const setUsageNote = (message) => {
        if (!usageNote) return;
        if (!message) {
            usageNote.hidden = true;
            usageNote.textContent = '';
            return;
        }
        usageNote.hidden = false;
        usageNote.textContent = message;
    };

    const renderBar = (fillEl, barEl, valueEl, used, limit) => {
        const remaining = Math.max(0, limit - used);
        const pct = limit > 0 ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : 0;
        if (valueEl) valueEl.textContent = `${remaining} / ${limit}`;
        if (fillEl) {
            fillEl.style.width = `${pct}%`;
            fillEl.classList.toggle('is-depleted', remaining === 0);
        }
        if (barEl) {
            barEl.setAttribute('aria-valuenow', String(Math.round(pct)));
        }
    };

    const loadUsage = async () => {
        const session = await getAuthSession();

        if (!session?.token) {
            setUsageNote('Log in from the ForgeFlow extension popup to see your live usage.');
            renderBar(generationsFill, generationsBar, generationsValue, 0, 2);
            renderBar(runsFill, runsBar, runsValue, 0, 2);
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/subscription`, {
                headers: { Authorization: `Bearer ${session.token}` }
            });
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                setUsageNote('Unable to load your usage right now. Try refreshing this page.');
                return;
            }

            if (planPill) planPill.textContent = data.planLabel || 'Free Plan';
            renderBar(
                generationsFill, generationsBar, generationsValue,
                data.usage?.apiGenerations ?? 0,
                data.limits?.apiGenerations ?? 2
            );
            renderBar(
                runsFill, runsBar, runsValue,
                data.usage?.apiRuns ?? 0,
                data.limits?.apiRuns ?? 2
            );
            setUsageNote(null);
        } catch (err) {
            console.error('[ForgeFlow][plans] failed to load usage', err);
            setUsageNote(`Unable to reach the ForgeFlow backend. Is it running at ${API_BASE}?`);
        }
    };

    if (upgradeBtn) {
        upgradeBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('plans/upgrade.html') });
        });
    }

    loadUsage();
});
