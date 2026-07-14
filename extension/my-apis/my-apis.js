/**
 * my-apis.js
 * Dedicated My APIs / Published APIs tab — same backend contract the old
 * in-popup view used (GET/POST/DELETE /api/my-apis, POST /marketplace/publish,
 * POST /api/my-apis/:id/publish), just with room to breathe. "Published
 * APIs" is the same page filtered to published-only via ?filter=published,
 * so the two nav destinations never drift out of sync with each other.
 */

const API_BASE = window.FORGEFLOW_API_BASE;
const AUTH_STORAGE_KEY = 'forgeflow.auth';

const escapeHtml = (str) => {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const formatRelativeDate = (iso) => {
    if (!iso) return 'Unknown';
    try {
        const d = new Date(iso);
        const diff = Date.now() - d.getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    } catch (e) {
        return 'Unknown';
    }
};

const getAuthSession = () => new Promise((resolve) => {
    chrome.storage.local.get(AUTH_STORAGE_KEY, (result) => {
        resolve(result?.[AUTH_STORAGE_KEY] || null);
    });
});

const prettifyFieldName = (key) => String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());

const formatDuration = (ms) => {
    if (typeof ms !== 'number' || Number.isNaN(ms)) return '';
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
};

document.addEventListener('DOMContentLoaded', () => {
    const pageTitle = document.getElementById('page-title');
    const pageSubtitle = document.getElementById('page-subtitle');
    const sectionHeadingTitle = document.getElementById('section-heading-title');
    const authNote = document.getElementById('auth-note');
    const refreshBtn = document.getElementById('refresh-btn');
    const searchInput = document.getElementById('my-apis-search');
    const statusChipsRow = document.getElementById('status-filter-chips');
    const statTotal = document.getElementById('stat-total');
    const statPublished = document.getElementById('stat-published');
    const statDrafts = document.getElementById('stat-drafts');
    const resultCount = document.getElementById('result-count');
    const grid = document.getElementById('my-apis-grid');

    let apis = [];
    let authHeaders = {};

    const params = new URLSearchParams(window.location.search);
    let activeStatus = params.get('filter') === 'published' ? 'published' : 'all';

    const syncPageChrome = () => {
        const isPublishedView = activeStatus === 'published';
        if (pageTitle) pageTitle.textContent = isPublishedView ? 'Published APIs' : 'My APIs';
        if (pageSubtitle) {
            pageSubtitle.textContent = isPublishedView
                ? 'APIs you have published to the Marketplace for others to purchase.'
                : "Every workflow you've generated, ready to run or publish.";
        }
        if (sectionHeadingTitle) sectionHeadingTitle.textContent = isPublishedView ? 'Published APIs' : 'Your APIs';
        document.title = isPublishedView ? 'ForgeFlow — Published APIs' : 'ForgeFlow — My APIs';

        if (statusChipsRow) {
            statusChipsRow.querySelectorAll('.chip').forEach((chip) => {
                chip.classList.toggle('active', chip.dataset.status === activeStatus);
            });
        }
    };

    const setActiveStatus = (status) => {
        activeStatus = status;

        // Keeping the URL in sync is a nice-to-have (bookmarkable, matches
        // the nav bar's Published-APIs link) — it must never block actually
        // switching the visible list, so a history API failure here (some
        // embedding contexts restrict it) can't leave the UI stuck showing
        // the wrong filter.
        try {
            const url = new URL(window.location.href);
            if (status === 'published') {
                url.searchParams.set('filter', 'published');
            } else {
                url.searchParams.delete('filter');
            }
            window.history.replaceState({}, '', url);
        } catch (err) {
            console.warn('[ForgeFlow][my-apis] could not update URL for filter state', err);
        }

        syncPageChrome();
        render();
    };

    const renderSkeleton = () => {
        if (!grid) return;
        grid.innerHTML = Array.from({ length: 6 }).map(() => `
            <div class="api-card api-card--skeleton" aria-hidden="true">
                <div class="skeleton-line skeleton-line--title"></div>
                <div class="skeleton-line skeleton-line--desc"></div>
                <div class="skeleton-line skeleton-line--desc" style="width:60%"></div>
                <div class="skeleton-line skeleton-line--pill"></div>
            </div>
        `).join('');
    };

    const updateStats = (list) => {
        const total = list.length;
        const published = list.filter((a) => a.published).length;
        const drafts = total - published;
        if (statTotal) statTotal.textContent = String(total);
        if (statPublished) statPublished.textContent = String(published);
        if (statDrafts) statDrafts.textContent = String(drafts);
    };

    // --- View/Run modal (parameters + Run API), ported from the popup ---

    const collectParameterValues = (modal) => {
        const values = {};
        modal.querySelectorAll('[data-param-name]').forEach((input) => {
            const name = input.dataset.paramName;
            const type = input.dataset.paramType;
            if (type === 'boolean') {
                values[name] = input.checked;
            } else if (type === 'number') {
                values[name] = input.value === '' ? null : Number(input.value);
            } else {
                values[name] = input.value;
            }
        });
        return values;
    };

    const buildParamFieldHtml = (param) => {
        const inputId = `param-input-${param.name}`;
        const safeName = escapeHtml(param.name);

        if (param.type === 'boolean') {
            const checked = param.defaultValue ? 'checked' : '';
            return `
                <div class="param-field">
                    <label class="param-field-checkbox-row" for="${inputId}">
                        <input type="checkbox" id="${inputId}" data-param-name="${safeName}" data-param-type="boolean" ${checked}>
                        <span class="param-field-label">${escapeHtml(param.label)}</span>
                    </label>
                    ${param.description ? `<p class="param-field-description">${escapeHtml(param.description)}</p>` : ''}
                </div>
            `;
        }

        const inputType = param.type === 'number' ? 'number' : (param.type === 'date' ? 'date' : 'text');
        const value = escapeHtml(String(param.defaultValue ?? ''));

        return `
            <div class="param-field">
                <label class="param-field-label" for="${inputId}">${escapeHtml(param.label)}</label>
                <input type="${inputType}" id="${inputId}" class="param-field-input" data-param-name="${safeName}" data-param-type="${param.type || 'text'}" value="${value}">
                ${param.description ? `<p class="param-field-description">${escapeHtml(param.description)}</p>` : ''}
            </div>
        `;
    };

    const buildParamsUsedHtml = (parametersApplied) => {
        const entries = Object.entries(parametersApplied || {});
        if (!entries.length) return '';
        const parts = entries.map(([key, value]) => (
            `${escapeHtml(key)} = ${escapeHtml(value === null || value === undefined || value === '' ? '—' : String(value))}`
        ));
        return `<p class="run-params-used">Ran with: ${parts.join(', ')}</p>`;
    };

    const buildResultCardsHtml = (items) => items.map((item) => {
        const rows = Object.entries(item || {}).map(([key, value]) => `
            <div class="result-row">
                <span class="result-row-label">${escapeHtml(prettifyFieldName(key))}</span>
                <span class="result-row-value">${escapeHtml(value === null || value === undefined || value === '' ? '—' : String(value))}</span>
            </div>
        `).join('');
        return `<div class="result-card">${rows}</div>`;
    }).join('');

    const buildRunResultHtml = (data) => {
        const durationSuffix = data.execution && typeof data.execution.durationMs === 'number'
            ? ` in ${formatDuration(data.execution.durationMs)}`
            : '';
        const statusLine = `<p class="run-status">✓ ${escapeHtml(data.message || 'Run succeeded.')}${durationSuffix}</p>`;
        const paramsLine = buildParamsUsedHtml(data.parametersApplied);

        const items = Array.isArray(data.data) ? data.data : [];
        const resultsHtml = items.length
            ? `<div class="result-cards">${buildResultCardsHtml(items)}</div>`
            : '<p class="run-empty-note">Workflow ran successfully, but no results were extracted from the final page.</p>';

        const rawToggle = `
            <details class="raw-response-toggle">
                <summary>View raw response</summary>
                <pre class="raw-response-pre">${escapeHtml(JSON.stringify(data, null, 2))}</pre>
            </details>
        `;

        return `${statusLine}${paramsLine}${resultsHtml}${rawToggle}`;
    };

    const openApiModal = (api) => {
        const parameters = Array.isArray(api.parameters) ? api.parameters : [];

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal';

        const paramsHtml = parameters.length
            ? `
                <h4>Parameters</h4>
                <p class="param-field-hint">Pre-filled with the values captured while recording — edit any of them before running.</p>
                ${parameters.map(buildParamFieldHtml).join('')}
            `
            : '';

        modal.innerHTML = `
            <h3>${escapeHtml(api.name)}</h3>
            <div class="modal-scroll-body">
                <p><strong>Endpoint:</strong> ${escapeHtml(api.endpoint)}</p>
                <p><strong>Method:</strong> ${escapeHtml(api.method)}</p>
                <p><strong>Version:</strong> ${escapeHtml(api.version || '')}</p>
                <pre>${escapeHtml(api.generatedCode || '')}</pre>
                ${paramsHtml}
                <div class="run-result" style="display:none"></div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-primary modal-run-api">Run API</button>
                <button class="btn btn-secondary modal-close">Close</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        const runBtn = overlay.querySelector('.modal-run-api');
        const resultEl = overlay.querySelector('.run-result');

        runBtn.addEventListener('click', async () => {
            runBtn.disabled = true;
            runBtn.textContent = 'Running…';
            resultEl.style.display = 'none';
            resultEl.className = 'run-result';
            resultEl.innerHTML = '';

            try {
                const body = collectParameterValues(modal);
                const response = await fetch(`${API_BASE}${api.endpoint}`, {
                    method: api.method || 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify(body)
                });
                const data = await response.json().catch(() => ({}));

                if (response.ok && data.success) {
                    resultEl.classList.add('run-result--success');
                    resultEl.innerHTML = buildRunResultHtml(data);
                } else {
                    resultEl.classList.add('run-result--error');
                    resultEl.textContent = `✗ ${data.message || `Run failed (HTTP ${response.status}).`}`;
                }
            } catch (err) {
                resultEl.classList.add('run-result--error');
                resultEl.textContent = `✗ Could not reach the backend: ${err.message}`;
            } finally {
                resultEl.style.display = 'block';
                runBtn.disabled = false;
                runBtn.textContent = 'Run API';
            }
        });
    };

    // --- Card rendering ---

    const buildApiCardHtml = (api) => {
        const statusClass = api.published ? 'badge-published' : (api.status === 'Draft' ? 'badge-draft' : 'badge-active');
        const statusText = api.published ? 'Published' : (api.status || 'Draft');

        return `
            <div class="api-card-top">
                <div>
                    <h3>${escapeHtml(api.name)}</h3>
                    <p class="api-meta-line">${escapeHtml(api.method)} • ${escapeHtml(api.version || '')} • ${formatRelativeDate(api.createdAt)}</p>
                </div>
                <span class="badge ${statusClass}">${statusText}</span>
            </div>
            <div class="api-details">
                <span>Endpoint: ${escapeHtml(api.endpoint)}</span>
                <span>Last Updated: ${formatRelativeDate(api.updatedAt)}</span>
            </div>
            <div class="api-actions">
                <button type="button" class="btn btn-secondary btn-sm api-action-btn view-api-btn">View API</button>
                <button type="button" class="btn btn-secondary btn-sm api-action-btn copy-endpoint-btn" data-original-text="Copy Endpoint">Copy Endpoint</button>
                <button type="button" class="btn btn-secondary btn-sm api-action-btn publish-api-btn">${api.published ? 'Unpublish' : 'Publish to Marketplace'}</button>
                <button type="button" class="btn btn-secondary btn-sm api-action-btn download-api-btn">Download</button>
                <button type="button" class="btn btn-danger btn-sm api-action-btn delete-api-btn">Delete</button>
            </div>
        `;
    };

    const attachApiCardHandlers = (card, api) => {
        card.querySelector('.view-api-btn').addEventListener('click', () => openApiModal(api));

        const copyBtn = card.querySelector('.copy-endpoint-btn');
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(api.endpoint || '');
                const original = copyBtn.dataset.originalText || 'Copy Endpoint';
                copyBtn.textContent = 'Copied!';
                copyBtn.classList.add('is-copied');
                setTimeout(() => {
                    copyBtn.textContent = original;
                    copyBtn.classList.remove('is-copied');
                }, 1200);
            } catch (err) {
                console.error('[ForgeFlow][my-apis] copy failed', err);
                alert('Unable to copy endpoint.');
            }
        });

        const publishBtn = card.querySelector('.publish-api-btn');
        publishBtn.addEventListener('click', async () => {
            const willPublish = !api.published;
            publishBtn.disabled = true;
            publishBtn.textContent = willPublish ? 'Publishing...' : 'Unpublishing...';
            try {
                if (willPublish) {
                    const mp = await fetch(`${API_BASE}/marketplace/publish`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: api.name,
                            version: api.version,
                            method: api.method,
                            endpoint: api.endpoint,
                            price: api.price || 10,
                            publisher: 'Demo User'
                        })
                    });
                    const mpData = await mp.json().catch(() => ({}));
                    if (!mp.ok) {
                        alert(mpData.message || 'Publishing to marketplace failed.');
                        publishBtn.disabled = false;
                        publishBtn.textContent = willPublish ? 'Publish to Marketplace' : 'Unpublish';
                        return;
                    }
                }

                const mark = await fetch(`${API_BASE}/api/my-apis/${api.id}/publish`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ published: willPublish })
                });

                if (!mark.ok) {
                    const d = await mark.json().catch(() => ({}));
                    console.warn('[ForgeFlow][my-apis] failed to toggle publish state', d);
                }

                loadApis();
            } catch (err) {
                console.error('[ForgeFlow][my-apis] publish toggle failed', err);
                alert('Unable to change publish state.');
                publishBtn.disabled = false;
                publishBtn.textContent = api.published ? 'Unpublish' : 'Publish to Marketplace';
            }
        });

        card.querySelector('.download-api-btn').addEventListener('click', () => {
            try {
                const content = api.generatedCode || JSON.stringify({ name: api.name, endpoint: api.endpoint, method: api.method, version: api.version }, null, 2);
                const blob = new Blob([content], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${(api.name || 'api').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-api.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 100);
            } catch (err) {
                console.error('[ForgeFlow][my-apis] download failed', err);
                alert('Unable to download API.');
            }
        });

        card.querySelector('.delete-api-btn').addEventListener('click', async () => {
            if (!confirm('Delete this API? This action cannot be undone.')) return;
            try {
                const resp = await fetch(`${API_BASE}/api/my-apis/${api.id}`, { method: 'DELETE', headers: authHeaders });
                if (!resp.ok) {
                    const d = await resp.json().catch(() => ({}));
                    console.warn('[ForgeFlow][my-apis] delete failed', d);
                    alert(d.message || 'Unable to delete API.');
                    return;
                }
                loadApis();
            } catch (err) {
                console.error('[ForgeFlow][my-apis] delete failed', err);
                alert('Unable to delete API.');
            }
        });
    };

    const render = () => {
        if (!grid) return;

        const q = (searchInput && searchInput.value || '').trim().toLowerCase();
        let list = apis.slice();

        if (activeStatus === 'published') list = list.filter((a) => a.published);
        if (activeStatus === 'draft') list = list.filter((a) => !a.published);

        if (q) {
            list = list.filter((a) => `${a.name} ${a.endpoint || ''}`.toLowerCase().includes(q));
        }

        list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        if (resultCount) {
            resultCount.textContent = list.length ? `${list.length} API${list.length === 1 ? '' : 's'}` : '';
        }

        if (list.length === 0) {
            const emptyCopy = apis.length === 0
                ? { title: 'No APIs generated yet.', body: 'Click the ForgeFlow icon in your browser toolbar to record a workflow and generate your first API.' }
                : { title: 'No APIs found.', body: 'Try a different search term or status filter.' };
            grid.innerHTML = `
                <div class="marketplace-empty">
                    <div class="marketplace-empty-icon" aria-hidden="true">${apis.length === 0 ? '✦' : '🔍'}</div>
                    <h3>${emptyCopy.title}</h3>
                    <p>${emptyCopy.body}</p>
                </div>
            `;
            return;
        }

        grid.innerHTML = '';
        list.forEach((api) => {
            const card = document.createElement('article');
            card.className = 'api-card';
            card.dataset.id = api.id;
            card.innerHTML = buildApiCardHtml(api);
            attachApiCardHandlers(card, api);
            grid.appendChild(card);
        });
    };

    const loadApis = async () => {
        renderSkeleton();
        try {
            const response = await fetch(`${API_BASE}/api/my-apis`, { headers: authHeaders });
            const data = await response.json().catch(() => ([]));
            if (!response.ok) {
                console.warn('[ForgeFlow][my-apis] failed to load', data);
                apis = [];
                render();
                return;
            }
            apis = Array.isArray(data) ? data : [];
            updateStats(apis);
            render();
        } catch (err) {
            console.error('[ForgeFlow][my-apis] load error', err);
            apis = [];
            render();
        }
    };

    const init = async () => {
        syncPageChrome();

        const session = await getAuthSession();
        if (!session?.token) {
            if (authNote) {
                authNote.hidden = false;
                authNote.textContent = 'Log in from the ForgeFlow extension popup to view and manage your APIs.';
            }
            if (grid) {
                grid.innerHTML = `
                    <div class="marketplace-empty">
                        <div class="marketplace-empty-icon" aria-hidden="true">🔒</div>
                        <h3>Log in required</h3>
                        <p>Log in from the ForgeFlow extension popup, then refresh this page.</p>
                    </div>
                `;
            }
            return;
        }

        authHeaders = { Authorization: `Bearer ${session.token}` };
        loadApis();
    };

    if (refreshBtn) refreshBtn.addEventListener('click', loadApis);
    if (searchInput) searchInput.addEventListener('input', () => render());
    if (statusChipsRow) {
        statusChipsRow.querySelectorAll('.chip').forEach((chip) => {
            chip.addEventListener('click', () => setActiveStatus(chip.dataset.status || 'all'));
        });
    }

    init();
});
