/**
 * Shared notification bell — included by every ForgeFlow tab page next to
 * roles.js/nav.js. Finds the page's existing .topbar-actions (present on
 * every page already, no per-page HTML changes needed) and injects a bell
 * button + unread badge, backed by GET/POST /notifications/*. Polls on a
 * plain interval since there's no push/websocket transport in this app —
 * same "reload on demand" tradeoff every other stat on these pages makes.
 */
(function () {
    const AUTH_STORAGE_KEY = 'forgeflow.auth';
    const POLL_INTERVAL_MS = 30000;

    const escapeHtml = (str) => {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    const formatRelativeTime = (iso) => {
        if (!iso) return '';
        try {
            const diff = Date.now() - new Date(iso).getTime();
            const mins = Math.floor(diff / 60000);
            if (mins < 1) return 'just now';
            if (mins < 60) return `${mins}m ago`;
            const hours = Math.floor(mins / 60);
            if (hours < 24) return `${hours}h ago`;
            return `${Math.floor(hours / 24)}d ago`;
        } catch (e) {
            return '';
        }
    };

    const getAuthSession = () => new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.storage) { resolve(null); return; }
        chrome.storage.local.get(AUTH_STORAGE_KEY, (result) => resolve(result?.[AUTH_STORAGE_KEY] || null));
    });

    const fetchJson = async (url, opts = {}) => {
        const response = await fetch(url, opts);
        const data = await response.json().catch(() => ({}));
        return { ok: response.ok, data };
    };

    const init = async () => {
        const topbarActions = document.querySelector('.topbar-actions');
        if (!topbarActions) return;

        const session = await getAuthSession();
        if (!session?.token) return;

        const apiBase = window.FORGEFLOW_API_BASE;
        const authHeaders = { Authorization: `Bearer ${session.token}` };

        const wrap = document.createElement('div');
        wrap.className = 'notif-bell-wrap';
        wrap.innerHTML = `
            <button type="button" class="notif-bell-btn" id="notif-bell-btn" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">
                🔔
                <span class="notif-bell-badge" id="notif-bell-badge" hidden>0</span>
            </button>
        `;
        topbarActions.appendChild(wrap);

        const bellBtn = wrap.querySelector('#notif-bell-btn');
        const badge = wrap.querySelector('#notif-bell-badge');
        let dropdown = null;

        const setUnreadCount = (count) => {
            if (count > 0) {
                badge.hidden = false;
                badge.textContent = count > 99 ? '99+' : String(count);
            } else {
                badge.hidden = true;
            }
        };

        const closeDropdown = () => {
            if (dropdown) {
                dropdown.remove();
                dropdown = null;
                bellBtn.setAttribute('aria-expanded', 'false');
                document.removeEventListener('click', onDocumentClick, true);
            }
        };

        const onDocumentClick = (e) => {
            if (dropdown && !wrap.contains(e.target)) closeDropdown();
        };

        const openDropdown = (notifications) => {
            dropdown = document.createElement('div');
            dropdown.className = 'notif-dropdown';

            if (!notifications.length) {
                dropdown.innerHTML = '<div class="notif-dropdown-empty">No notifications yet.</div>';
            } else {
                dropdown.innerHTML = notifications.map((n) => `
                    <button type="button" class="notif-item${n.read ? '' : ' unread'}" data-id="${n.id}" data-link="${escapeHtml(n.link || '')}">
                        <div class="notif-item-title">${escapeHtml(n.title)}</div>
                        ${n.body ? `<div class="notif-item-body">${escapeHtml(n.body)}</div>` : ''}
                        <div class="notif-item-time">${formatRelativeTime(n.createdAt)}</div>
                    </button>
                `).join('');
            }

            wrap.appendChild(dropdown);
            bellBtn.setAttribute('aria-expanded', 'true');

            dropdown.querySelectorAll('.notif-item').forEach((item) => {
                item.addEventListener('click', async () => {
                    const id = item.dataset.id;
                    const link = item.dataset.link;
                    fetchJson(`${apiBase}/notifications/${id}/read`, { method: 'POST', headers: authHeaders }).catch(() => {});
                    if (link && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
                        window.location.href = chrome.runtime.getURL(link);
                    }
                    closeDropdown();
                    refresh();
                });
            });

            // Deferred so the click that opened the dropdown doesn't
            // immediately close it via the same listener.
            setTimeout(() => document.addEventListener('click', onDocumentClick, true), 0);
        };

        const refresh = async () => {
            try {
                const { ok, data } = await fetchJson(`${apiBase}/notifications/mine`, { headers: authHeaders });
                if (!ok) return;
                setUnreadCount(data.unreadCount || 0);
                bellBtn.dataset.notifications = JSON.stringify(data.notifications || []);
            } catch (err) {
                console.error('[ForgeFlow][notifications] refresh failed', err);
            }
        };

        bellBtn.addEventListener('click', async () => {
            if (dropdown) { closeDropdown(); return; }
            const notifications = JSON.parse(bellBtn.dataset.notifications || '[]');
            openDropdown(notifications);
        });

        refresh();
        setInterval(refresh, POLL_INTERVAL_MS);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
