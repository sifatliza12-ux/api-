/**
 * popup.js
 * Handles the premium popup interactions for ForgeFlow.
 */

const popupApp = {
    init() {
        console.log('[ForgeFlow][popup] popup script initialized');
        const loginView = document.getElementById('login-view');
        const signupView = document.getElementById('signup-view');
        const dashboardView = document.getElementById('dashboard-view');
        const recordingView = document.getElementById('recording-view');
        const generationView = document.getElementById('generation-view');
        const generatedView = document.getElementById('generated-view');
        const myApisView = document.getElementById('my-apis-view');
        const marketplaceView = document.getElementById('marketplace-view');

        const loginButton = document.getElementById('login-btn');
        const trialButton = document.getElementById('trial-btn');
        const showSignupButton = document.getElementById('show-signup-btn');
        const showLoginButton = document.getElementById('show-login-btn');
        const signupButton = document.getElementById('signup-btn');
        const logoutButton = document.getElementById('logout-btn');
        const startRecordingButton = document.getElementById('start-recording-btn');
        const backToDashboardButton = document.getElementById('back-to-dashboard-btn');
        const recordStartButton = document.getElementById('record-start-btn');
        const recordPauseButton = document.getElementById('record-pause-btn');
        const recordStopButton = document.getElementById('record-stop-btn');
        const recordCancelButton = document.getElementById('record-cancel-btn');
        const copyEndpointButton = document.getElementById('copy-endpoint-btn');
        const downloadApiButton = document.getElementById('download-api-btn');
        const publishMarketplaceButton = document.getElementById('publish-marketplace-btn');
        const backToDashboardGeneratedButton = document.getElementById('back-to-dashboard-generated-btn');
        const myApisCard = document.getElementById('my-apis-card');
        const backToDashboardFromMyApisButton = document.getElementById('back-to-dashboard-from-my-apis-btn');
        const subscriptionCard = document.getElementById('subscription-card');
        const settingsCard = document.getElementById('settings-card');
        const backToDashboardFromSubscriptionButton = document.getElementById('back-to-dashboard-from-subscription-btn');
        const backToDashboardFromSettingsButton = document.getElementById('back-to-dashboard-from-settings-btn');
        const backToDashboardFromProfileButton = document.getElementById('back-to-dashboard-from-profile-btn');
        const navHome = document.getElementById('nav-home');
        const navApis = document.getElementById('nav-apis');
        const navMarketplace = document.getElementById('nav-marketplace');
        const navProfile = document.getElementById('nav-profile');
        const marketplaceCard = document.getElementById('marketplace-card');
        const backToDashboardFromMarketplaceButton = document.getElementById('back-to-dashboard-from-marketplace-btn');
        const marketplaceSearch = document.getElementById('marketplace-search');
        const marketplaceList = document.getElementById('marketplace-list');
        const marketplaceFilter = document.getElementById('marketplace-filter');
        const marketplaceSort = document.getElementById('marketplace-sort');
        const editPriceButton = document.getElementById('edit-price-btn');
        const removeListingButton = document.getElementById('remove-listing-btn');

        if (!loginView || !dashboardView || !recordingView || !generationView || !generatedView || !myApisView || !marketplaceView) {
            console.error('[ForgeFlow] required views missing');
            return;
        }

        console.log('[ForgeFlow] popup init', {
            startRecordingButton: !!startRecordingButton,
            recordStartButton: !!recordStartButton,
            recordPauseButton: !!recordPauseButton,
            recordStopButton: !!recordStopButton,
            recordCancelButton: !!recordCancelButton
        });

        let generationTimeoutId = null;
        let loginErrorMessage = null;
        let lastGeneratedApi = null;

        const AUTH_BASE_URL = 'http://localhost:5000/api/auth';
        const AUTH_STORAGE_KEY = 'forgeflow.auth';

        // chrome.storage.local (not .session) so a login survives closing and
        // reopening the browser, not just the popup — that's what "session
        // persistence" means from a user's point of view.
        const saveAuthSession = (token, user) => new Promise((resolve) => {
            chrome.storage.local.set({ [AUTH_STORAGE_KEY]: { token, user } }, resolve);
        });

        const clearAuthSession = () => new Promise((resolve) => {
            chrome.storage.local.remove(AUTH_STORAGE_KEY, resolve);
        });

        const getAuthSession = () => new Promise((resolve) => {
            chrome.storage.local.get(AUTH_STORAGE_KEY, (result) => {
                resolve(result?.[AUTH_STORAGE_KEY] || null);
            });
        });

        // Confirms the stored token is still valid (not expired, not for a
        // deleted user) rather than trusting whatever is in local storage.
        const verifyAuthSession = async (token) => {
            try {
                const response = await fetch(`${AUTH_BASE_URL}/me`, {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (!response.ok) {
                    return null;
                }
                const data = await response.json().catch(() => ({}));
                return data.success ? data.user : null;
            } catch (error) {
                console.warn('[ForgeFlow][popup] session verification failed', error);
                return null;
            }
        };

        // Workflows/My APIs are now owned per-user and their routes require
        // a valid token — every fetch to those endpoints needs this attached.
        const authHeaders = async () => {
            const session = await getAuthSession();
            return session?.token ? { Authorization: `Bearer ${session.token}` } : {};
        };

        const clearGenerationTimeout = () => {
            if (generationTimeoutId) {
                window.clearTimeout(generationTimeoutId);
                generationTimeoutId = null;
            }
        };

        const showView = (viewName) => {
            const views = {
                login: loginView,
                dashboard: dashboardView,
                recording: recordingView,
                generation: generationView,
                generated: generatedView,
                myApis: myApisView,
                marketplace: marketplaceView,
                subscription: document.getElementById('subscription-view'),
                settings: document.getElementById('settings-view'),
                profile: document.getElementById('profile-view')
            };

            clearGenerationTimeout();

            Object.entries(views).forEach(([name, view]) => {
                view.hidden = name !== viewName;
            });
        };

        const navigateToDashboard = () => {
            loginView.hidden = true;
            signupView.hidden = true;
            dashboardView.hidden = false;
        };

        // Alias used by various back buttons in the DOM
        const showDashboard = navigateToDashboard;

        const handleFreeTrialNavigation = () => {
            navigateToDashboard();
        };

        const showSignup = () => {
            clearLoginError();
            loginView.hidden = true;
            signupView.hidden = false;
        };

        const showLogin = () => {
            clearSignupError();
            signupView.hidden = true;
            loginView.hidden = false;
        };

        const navigateToRecording = () => {
            clearGenerationTimeout();
            loginView.hidden = true;
            dashboardView.hidden = true;
            recordingView.hidden = false;
            generationView.hidden = true;
            generatedView.hidden = true;
            myApisView.hidden = true;
            marketplaceView.hidden = true;
        };

        const showRecording = () => {
            navigateToRecording();
            console.log('[ForgeFlow] showRecording executed');
            void updateRecordingView();
        };

        const showGenerating = () => {
            showView('generation');
            // TODO: Hook this screen up to the real workflow analysis pipeline later.
        };

        const showGenerated = () => {
            showView('generated');
            // Persist the generated API metadata when the backend is available.
            // Create a record on the backend so it appears under My APIs.
            (async () => {
                try {
                    const payload = {
                        name: 'User Workflow API',
                        version: 'v1.0',
                        method: 'POST',
                        endpoint: '/api/v1/workflow',
                        generatedCode: '// Example generated code for User Workflow API',
                        published: false
                    };

                    const resp = await fetch('http://localhost:5000/api/my-apis', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
                        body: JSON.stringify(payload)
                    });

                    if (resp.ok) {
                        lastGeneratedApi = await resp.json().catch(() => null);
                        // Also persist locally for offline support
                        try {
                            if (lastGeneratedApi) addLocalApi(lastGeneratedApi);
                        } catch (e) { /* ignore */ }
                    } else {
                        console.warn('[ForgeFlow] failed to save generated API', resp.status);
                        // Fallback: save locally so it appears in My APIs
                        try {
                            const localApi = Object.assign({}, payload, { id: Date.now(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
                            addLocalApi(localApi);
                            lastGeneratedApi = localApi;
                        } catch (e) { /* ignore */ }
                    }
                } catch (err) {
                    console.error('[ForgeFlow] error saving generated API', err);
                    // Fallback: save locally so it appears in My APIs
                    try {
                        const localApi = Object.assign({}, payload, { id: Date.now(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
                        addLocalApi(localApi);
                        lastGeneratedApi = localApi;
                    } catch (e) { /* ignore */ }
                }
            })();
        };

        const showMyApis = () => {
            showView('myApis');
            // Load generated APIs from backend
            loadMyApis();
        };

        const fetchJson = async (url, opts = {}) => {
            const response = await fetch(url, opts);
            const data = await response.json().catch(() => ({}));
            return { ok: response.ok, status: response.status, data };
        };

        const LOCAL_KEY = 'forgeflow_my_apis';

        const getLocalApis = () => {
            try {
                const raw = localStorage.getItem(LOCAL_KEY);
                return raw ? JSON.parse(raw) : [];
            } catch (e) {
                return [];
            }
        };

        const saveLocalApis = (arr) => {
            try {
                localStorage.setItem(LOCAL_KEY, JSON.stringify(arr || []));
            } catch (e) {
                console.warn('[ForgeFlow] unable to save local apis', e);
            }
        };

        const addLocalApi = (api) => {
            const arr = getLocalApis();
            arr.unshift(api);
            saveLocalApis(arr);
        };

        const toggleLocalPublished = (id, flag) => {
            const arr = getLocalApis();
            const idx = arr.findIndex(a => a.id === id);
            if (idx !== -1) {
                arr[idx].published = flag;
                arr[idx].updatedAt = new Date().toISOString();
                saveLocalApis(arr);
            }
        };

        const myApisSection = myApisView.querySelector('.my-apis-section');
        const statsCards = myApisView.querySelectorAll('.stat-card--compact strong');

        const updateStats = (apis) => {
            const total = apis.length;
            const published = apis.filter(a => a.published).length;
            const drafts = total - published;

            if (statsCards && statsCards.length >= 3) {
                statsCards[0].textContent = String(total);
                statsCards[1].textContent = String(published);
                statsCards[2].textContent = String(drafts);
            }
        };

        const renderEmptyState = () => {
            myApisSection.innerHTML = `
                <div class="empty-state">
                    <h3>No APIs generated yet.</h3>
                    <p>Create a workflow and generate an API to see it here.</p>
                    <div style="margin-top:12px"><button id="generate-first-api-btn" class="btn btn-primary">Generate your first API</button></div>
                </div>
            `;
            const genBtn = document.getElementById('generate-first-api-btn');
            if (genBtn) genBtn.addEventListener('click', () => showRecording());
        };

        const renderApis = (apis) => {
            if (!myApisSection) return;
            if (!apis || apis.length === 0) {
                updateStats([]);
                renderEmptyState();
                return;
            }

            updateStats(apis);

            myApisSection.innerHTML = '';

            apis.forEach((api) => {
                const article = document.createElement('article');
                article.className = 'api-card';
                article.dataset.id = api.id;

                const statusClass = api.published ? 'status-badge--published' : (api.status === 'Draft' ? 'status-badge--draft' : 'status-badge--active');
                const statusText = api.published ? 'Published' : (api.status || 'Draft');

                article.innerHTML = `
                    <div class="api-card-top">
                        <div>
                            <h3>${escapeHtml(api.name)}</h3>
                            <p class="api-meta-line">${escapeHtml(api.method)} • ${escapeHtml(api.version || '')} • ${formatRelativeDate(api.createdAt)}</p>
                        </div>
                        <span class="status-badge ${statusClass}">${statusText}</span>
                    </div>
                    <div class="api-details">
                        <span>Endpoint: ${escapeHtml(api.endpoint)}</span>
                        <span>Last Updated: ${formatRelativeDate(api.updatedAt)}</span>
                    </div>
                    <div class="api-actions">
                        <button type="button" class="btn btn-secondary api-action-btn view-api-btn">View API</button>
                        <button type="button" class="btn btn-secondary api-action-btn copy-endpoint-btn" data-original-text="Copy Endpoint">Copy Endpoint</button>
                                <button type="button" class="btn btn-secondary api-action-btn publish-api-btn">${api.published ? 'Unpublish' : 'Publish to Marketplace'}</button>
                                <button type="button" class="btn btn-secondary api-action-btn download-api-card-btn">Download API</button>
                                <button type="button" class="btn btn-danger api-action-btn delete-api-btn">Delete</button>
                    </div>
                `;

                myApisSection.appendChild(article);

                // Attach handlers
                const viewBtn = article.querySelector('.view-api-btn');
                const copyBtn = article.querySelector('.copy-endpoint-btn');
                const publishBtn = article.querySelector('.publish-api-btn');
                const deleteBtn = article.querySelector('.delete-api-btn');

                viewBtn.addEventListener('click', () => openApiModal(api));

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
                        console.error('[ForgeFlow] copy failed', err);
                        alert('Unable to copy endpoint.');
                    }
                });

                // Publish or Unpublish handler
                publishBtn.addEventListener('click', async () => {
                    const willPublish = !api.published;
                    publishBtn.disabled = true;
                    publishBtn.textContent = willPublish ? 'Publishing...' : 'Unpublishing...';
                    try {
                        if (willPublish) {
                            // Publish to marketplace first
                            const mp = await fetch('http://localhost:5000/marketplace/publish', {
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

                        // Toggle published state in our store (backend preferred)
                        const mark = await fetch(`http://localhost:5000/api/my-apis/${api.id}/publish`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
                            body: JSON.stringify({ published: willPublish })
                        });

                        if (!mark.ok) {
                            // Fallback: try to update localStorage if backend unavailable
                            const d = await mark.json().catch(() => ({}));
                            console.warn('[ForgeFlow] failed to toggle publish state', d);
                            // update local storage fallback
                            toggleLocalPublished(api.id, willPublish);
                        }

                        // Refresh UI
                        loadMyApis();
                    } catch (err) {
                        console.error('[ForgeFlow] publish toggle failed', err);
                        alert('Unable to change publish state.');
                        publishBtn.disabled = false;
                        publishBtn.textContent = api.published ? 'Unpublish' : 'Publish to Marketplace';
                    }
                });

                // Download API from card
                const downloadCardBtn = article.querySelector('.download-api-card-btn');
                if (downloadCardBtn) {
                    downloadCardBtn.addEventListener('click', async () => {
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
                            console.error('[ForgeFlow] download card api failed', err);
                            alert('Unable to download API.');
                        }
                    });
                }

                deleteBtn.addEventListener('click', async () => {
                    if (!confirm('Delete this API? This action cannot be undone.')) return;
                    try {
                        const resp = await fetch(`http://localhost:5000/api/my-apis/${api.id}`, { method: 'DELETE', headers: await authHeaders() });
                        if (resp.ok) {
                            article.remove();
                            // update stats
                            loadMyApis();
                        } else {
                            // Fallback to local removal
                            const d = await resp.json().catch(() => ({}));
                            console.warn('[ForgeFlow] delete failed on server', d);
                            const locals = getLocalApis().filter(a => a.id !== api.id);
                            saveLocalApis(locals);
                            article.remove();
                            loadMyApis();
                        }
                    } catch (err) {
                        console.error('[ForgeFlow] delete failed', err);
                        // Fallback: remove from local storage
                        try {
                            const locals = getLocalApis().filter(a => a.id !== api.id);
                            saveLocalApis(locals);
                            article.remove();
                            loadMyApis();
                        } catch (e) {
                            console.error('[ForgeFlow] local delete failed', e);
                            alert('Unable to delete API.');
                        }
                    }
                });
            });
        };

        const loadMyApis = async () => {
            try {
                const { ok, data } = await fetchJson('http://localhost:5000/api/my-apis', { headers: await authHeaders() });
                if (!ok) {
                    console.warn('[ForgeFlow] failed to load My APIs', data);
                    const local = getLocalApis();
                    if (!local || local.length === 0) {
                        renderEmptyState();
                    } else {
                        renderApis(local);
                    }
                    return;
                }
                // Merge any locally-saved APIs that are not present on the server
                try {
                    const local = getLocalApis();
                    const merged = (data || []).slice();
                    (local || []).forEach((l) => {
                        if (!merged.find(m => m.id === l.id)) merged.unshift(l);
                    });
                    renderApis(merged);
                } catch (e) {
                    renderApis(data || []);
                }
            } catch (err) {
                console.error('[ForgeFlow] loadMyApis error', err);
                const local = getLocalApis();
                if (!local || local.length === 0) {
                    renderEmptyState();
                } else {
                    renderApis(local);
                }
            }
        };

        // One editable field per extracted parameter, pre-filled with the
        // value captured while recording — this is what lets the owner's
        // own Run API click use different values than the recording
        // without needing to know the raw POST body shape. Every field
        // carries data-param-name/data-param-type so collectParameterValues
        // can read them back into the right JS type generically, for
        // whatever parameters THIS workflow happens to have — no
        // per-workflow or per-site-specific field handling.
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

        // Reads the current (possibly edited) value out of each rendered
        // field, converting back to the JS type the backend expects —
        // generic across whatever parameter set a given workflow has.
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

        // "hotel_name" / "hotelName" -> "Hotel Name" — keys are whatever the
        // backend's extraction pipeline settled on (see
        // backend/services/extraction/semanticNaming.js), so this only needs
        // to handle snake_case and camelCase, not arbitrary strings.
        const prettifyFieldName = (key) => String(key)
            .replace(/_/g, ' ')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/\b\w/g, (c) => c.toUpperCase());

        const formatDuration = (ms) => {
            if (typeof ms !== 'number' || Number.isNaN(ms)) return '';
            return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
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

        const buildParamsUsedHtml = (parametersApplied) => {
            const entries = Object.entries(parametersApplied || {});
            if (!entries.length) return '';
            const parts = entries.map(([key, value]) => (
                `${escapeHtml(key)} = ${escapeHtml(value === null || value === undefined || value === '' ? '—' : String(value))}`
            ));
            return `<p class="run-params-used">Ran with: ${parts.join(', ')}</p>`;
        };

        // Builds the full success-state body: status line, what parameters
        // were actually used, the extracted results (or an explicit "found
        // nothing" note — never raw JSON by default), and a collapsed raw
        // response for anyone who does want it. See requirements 1-4 of the
        // run-results feature.
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

            // Create a simple modal showing API details and generated code
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.position = 'fixed';
            overlay.style.inset = 0;
            overlay.style.background = 'rgba(0,0,0,0.5)';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
            overlay.style.zIndex = 1000;

            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.style.background = '#fff';
            modal.style.borderRadius = '6px';
            modal.style.padding = '16px';
            modal.style.maxWidth = '600px';
            modal.style.width = '100%';

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
                    <pre style="background:#f6f8fa;padding:8px;border-radius:4px;max-height:240px;overflow:auto">${escapeHtml(api.generatedCode || '')}</pre>
                    ${paramsHtml}
                    <div class="run-result" style="margin-top:10px;font-size:13px;display:none"></div>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
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
                    // Whatever is currently in the fields — pre-filled with
                    // recorded defaults, but the user may have edited any of
                    // them. The backend falls back to its own stored default
                    // for any parameter not present in the body, so this is
                    // safe to send even for a workflow with no parameters.
                    const body = collectParameterValues(modal);
                    const response = await fetch(`http://localhost:5000${api.endpoint}`, {
                        method: api.method || 'POST',
                        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
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

        const showMarketplace = () => {
            showView('marketplace');
            // TODO: Connect the marketplace screen to backend marketplace data later.
            loadMarketplaceItems();
        };

        let marketplaceItems = [];
        let activeCategory = 'all';

        const renderMarketplace = (items) => {
            if (!marketplaceList) return;
            if (!items || items.length === 0) {
                marketplaceList.innerHTML = '<p class="empty-state">No marketplace items found.</p>';
                return;
            }

            marketplaceList.innerHTML = '';
            items.forEach((it) => {
                const card = document.createElement('article');
                card.className = 'market-card';
                card.dataset.id = it.id;
                card.innerHTML = `
                    <div class="market-card-top">
                        <div>
                            <h4>${escapeHtml(it.name)}</h4>
                            <p>${escapeHtml(it.description || '')}</p>
                        </div>
                        <span class="market-price">${it.price && it.price > 0 ? '$' + it.price : 'Free'}</span>
                    </div>
                    <div class="market-meta">
                        <span>${escapeHtml(it.version || '')}</span>
                        <span>${escapeHtml(it.publisher || '')}</span>
                    </div>
                `;

                card.addEventListener('click', () => openMarketModal(it));
                marketplaceList.appendChild(card);
            });
        };

        const applyMarketplaceFilters = () => {
            const q = (marketplaceSearch && marketplaceSearch.value || '').trim().toLowerCase();
            const filter = (marketplaceFilter && marketplaceFilter.value) || 'all';
            const sort = (marketplaceSort && marketplaceSort.value) || 'newest';

            let result = (marketplaceItems || []).slice();
            if (q) {
                result = result.filter(i => (i.name + ' ' + (i.description||'')).toLowerCase().includes(q));
            }
            if (filter === 'free') result = result.filter(i => !!i.free);
            if (filter === 'paid') result = result.filter(i => !i.free);

            if (activeCategory && activeCategory !== 'all') {
                result = result.filter(i => (i.category || 'all') === activeCategory);
            }

            if (sort === 'price-asc') result.sort((a,b)=> (a.price||0)-(b.price||0));
            if (sort === 'price-desc') result.sort((a,b)=> (b.price||0)-(a.price||0));
            if (sort === 'newest') result.sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));

            renderMarketplace(result);
        };

        const loadMarketplaceItems = async () => {
            try {
                const { ok, data } = await fetchJson('http://localhost:5000/marketplace');
                if (!ok) {
                    console.warn('[ForgeFlow] failed to load marketplace items', data);
                    marketplaceItems = [];
                    applyMarketplaceFilters();
                    return;
                }
                marketplaceItems = data || [];
                applyMarketplaceFilters();
            } catch (err) {
                console.error('[ForgeFlow] loadMarketplaceItems error', err);
                marketplaceItems = [];
                applyMarketplaceFilters();
            }
        };

        const updateMarketplaceListingPrice = (newPrice) => {
            const listingCard = document.querySelector('.market-card--listing');
            const priceLine = listingCard?.querySelector('p');
            if (!listingCard || !priceLine) return;

            priceLine.textContent = newPrice > 0
                ? `Original purchase price: $10 • Selling price: $${newPrice}`
                : 'Original purchase price: $10 • Selling price: Free';
        };

        const handleEditPriceButton = () => {
            const listingCard = document.querySelector('.market-card--listing');
            const priceLine = listingCard?.querySelector('p');
            const currentPriceMatch = priceLine?.textContent?.match(/Selling price: \$(\d+)/);
            const currentPrice = currentPriceMatch ? Number(currentPriceMatch[1]) : 15;
            const val = prompt('Enter new price (0 for Free):', String(currentPrice));
            if (val === null) return;

            const num = Number(val);
            if (Number.isNaN(num) || num < 0) {
                alert('Please enter a valid non-negative number for price.');
                return;
            }

            updateMarketplaceListingPrice(num);
            alert('Listing price updated.');
        };

        const handleRemoveListingButton = () => {
            if (!confirm('Remove this listing from the marketplace? This will not delete your API.')) return;

            const listingCard = document.querySelector('.market-card--listing');
            if (listingCard) {
                listingCard.remove();
            }

            alert('Listing removed.');
        };

        const openMarketModal = (item) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.position = 'fixed';
            overlay.style.inset = 0;
            overlay.style.background = 'rgba(0,0,0,0.5)';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
            overlay.style.zIndex = 1000;

            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.style.background = '#fff';
            modal.style.borderRadius = '6px';
            modal.style.padding = '16px';
            modal.style.maxWidth = '700px';
            modal.style.width = '100%';
            modal.innerHTML = `
                <h3>${escapeHtml(item.name)}</h3>
                <div class="modal-scroll-body">
                    <p>${escapeHtml(item.description || '')}</p>
                    <p><strong>Method:</strong> ${escapeHtml(item.method || '')} • <strong>Version:</strong> ${escapeHtml(item.version || '')}</p>
                    <p><strong>Creator:</strong> ${escapeHtml(item.publisher || '')} • <strong>Price:</strong> <span id="market-price-${item.id}">${item.price && item.price>0? '$'+item.price : 'Free'}</span></p>
                    <p><strong>Published:</strong> ${formatRelativeDate(item.createdAt)}</p>
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
                    <button class="btn btn-secondary edit-price">Edit Price</button>
                    <button class="btn btn-secondary remove-listing">Remove Listing</button>
                    <button class="btn btn-primary market-buy">Buy</button>
                    <button class="btn btn-secondary modal-close">Close</button>
                </div>
            `;

            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
            overlay.querySelector('.market-buy').addEventListener('click', () => {
                alert('Purchase flow is not implemented in this demo.');
            });

            // Edit Price handler
            const editBtn = overlay.querySelector('.edit-price');
            editBtn.addEventListener('click', async () => {
                const val = prompt('Enter new price (0 for Free):', String(typeof item.price !== 'undefined' ? item.price : '0'));
                if (val === null) return; // cancelled
                const num = Number(val);
                if (Number.isNaN(num) || num < 0) {
                    alert('Please enter a valid non-negative number for price.');
                    return;
                }

                try {
                    const resp = await fetch(`http://localhost:5000/marketplace/${item.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ price: num })
                    });

                    if (resp.ok) {
                        const res = await resp.json().catch(() => ({}));
                        // Update local list and UI
                        const idx = marketplaceItems.findIndex(m => m.id === item.id);
                        if (idx !== -1) {
                            marketplaceItems[idx].price = num;
                            marketplaceItems[idx].free = num === 0;
                        }
                        const priceSpan = document.getElementById(`market-price-${item.id}`);
                        if (priceSpan) priceSpan.textContent = num > 0 ? '$' + num : 'Free';
                        applyMarketplaceFilters();
                        alert('Price updated.');
                    } else {
                        const d = await resp.json().catch(() => ({}));
                        alert(d.message || 'Failed to update price.');
                    }
                } catch (err) {
                    console.error('[ForgeFlow] update price failed', err);
                    // Fallback to local update
                    const idx = marketplaceItems.findIndex(m => m.id === item.id);
                    if (idx !== -1) {
                        marketplaceItems[idx].price = num;
                        marketplaceItems[idx].free = num === 0;
                    }
                    const priceSpan = document.getElementById(`market-price-${item.id}`);
                    if (priceSpan) priceSpan.textContent = num > 0 ? '$' + num : 'Free';
                    applyMarketplaceFilters();
                    alert('Price updated locally (backend unavailable).');
                }
            });

            // Remove Listing handler
            const removeBtn = overlay.querySelector('.remove-listing');
            removeBtn.addEventListener('click', async () => {
                if (!confirm('Remove this listing from the marketplace? This will not delete your API.')) return;
                try {
                    const resp = await fetch(`http://localhost:5000/marketplace/${item.id}`, { method: 'DELETE' });
                    if (resp.ok) {
                        // Remove from local list and UI
                        marketplaceItems = (marketplaceItems || []).filter(m => m.id !== item.id);
                        applyMarketplaceFilters();
                        overlay.remove();
                    } else {
                        const d = await resp.json().catch(() => ({}));
                        alert(d.message || 'Failed to remove listing.');
                    }
                } catch (err) {
                    console.error('[ForgeFlow] remove listing failed', err);
                    // Fallback: remove locally
                    marketplaceItems = (marketplaceItems || []).filter(m => m.id !== item.id);
                    applyMarketplaceFilters();
                    overlay.remove();
                    alert('Listing removed locally (backend unavailable).');
                }
            });

            overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        };

        const defaultWorkflowName = () => `Workflow - ${new Date().toLocaleString()}`;

        const sendRuntimeMessage = (message) => new Promise((resolve) => {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    resolve({ ok: false, error: chrome.runtime.lastError.message });
                    return;
                }

                resolve(response || { ok: true });
            });
        });

        const updateRecordingView = async () => {
            try {
                const response = await sendRuntimeMessage({ type: 'get-recorder-state' });
                const state = response?.state || {};
                const isRecording = Boolean(state.isRecording);
                const statusValue = recordingView.querySelector('.status-value');
                const indicator = recordingView.querySelector('.recording-indicator');
                const metrics = recordingView.querySelectorAll('.metric-item strong');
                const activityText = recordingView.querySelector('.activity-log p');

                if (statusValue) {
                    statusValue.textContent = isRecording ? 'Recording Active' : 'Ready to Record';
                }

                if (indicator) {
                    indicator.classList.toggle('is-recording', isRecording);
                }

                if (metrics[0]) {
                    metrics[0].textContent = String(state.events?.length || 0);
                }

                if (metrics[1]) {
                    metrics[1].textContent = isRecording ? 'Live' : '00:00';
                }

                if (activityText) {
                    activityText.textContent = isRecording
                        ? `${state.events?.length || 0} event(s) captured. Continue browsing to keep recording.`
                        : 'No activity yet.';
                }

                if (recordStartButton) {
                    recordStartButton.disabled = isRecording;
                }

                if (recordStopButton) {
                    recordStopButton.disabled = !isRecording;
                }

                if (recordPauseButton) {
                    recordPauseButton.disabled = !isRecording;
                }
            } catch (error) {
                console.error('[ForgeFlow][popup] unable to refresh recording view', error);
            }
        };

        const startRecordingSession = async () => {
            console.log('[ForgeFlow][popup] start recording requested');
            const response = await sendRuntimeMessage({ type: 'start-recording', source: 'popup' });
            if (response?.ok) {
                await updateRecordingView();
                return true;
            }

            console.error('[ForgeFlow][popup] failed to start recording', response);
            return false;
        };

        const handleStartRecording = async () => {
            await startRecordingSession();
            showRecording();
        };

        const handleStopRecording = async () => {
            const input = window.prompt('Name this workflow:', defaultWorkflowName());
            const name = (input || '').trim() || defaultWorkflowName();

            const response = await sendRuntimeMessage({ type: 'stop-recording', source: 'popup', save: true, name });
            if (response?.ok) {
                await updateRecordingView();
            }

            if (response?.save?.ok) {
                alert('Saved! View in My APIs.');
            } else if (response?.save) {
                alert(`Could not save workflow: ${response.save.error || 'Unknown error'}`);
            }

            showRecording();
        };

        const handleCancelRecording = async () => {
            await sendRuntimeMessage({ type: 'stop-recording', source: 'popup' });
            navigateToDashboard();
        };

        const handleCopyEndpoint = (eventOrButton = copyEndpointButton) => {
            const targetButton = eventOrButton && typeof eventOrButton === 'object' && 'currentTarget' in eventOrButton
                ? eventOrButton.currentTarget
                : eventOrButton || copyEndpointButton;

            if (!targetButton || !(targetButton instanceof HTMLElement)) {
                return;
            }

            const originalText = targetButton.dataset ? (targetButton.dataset.originalText || 'Copy Endpoint') : 'Copy Endpoint';
            targetButton.textContent = 'Copied!';
            targetButton.classList.add('is-copied');

            window.setTimeout(() => {
                targetButton.textContent = originalText;
                targetButton.classList.remove('is-copied');
            }, 1200);

            // TODO: Replace this visual-only feedback with actual clipboard integration.
        };

        const handleDownloadApi = async () => {
            // Generates a sample API JSON file and triggers a download.
            // TODO: Support downloading real generated APIs from the backend (fetch and auth).
            try {
                const payload = {
                    name: 'User Workflow API',
                    version: '1.0.0',
                    method: 'POST',
                    endpoint: '/api/v1/workflow',
                    generatedBy: 'ForgeFlow',
                    createdAt: new Date().toISOString()
                };

                const json = JSON.stringify(payload, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const objectUrl = URL.createObjectURL(blob);

                try {
                    const anchor = document.createElement('a');
                    anchor.href = objectUrl;
                    anchor.download = 'workflow-api.json';
                    // Append to DOM to make the click work in all browsers
                    document.body.appendChild(anchor);
                    anchor.click();
                    anchor.remove();
                } finally {
                    // Revoke the object URL shortly after the download starts
                    setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
                }
            } catch (err) {
                console.error('[ForgeFlow] download API failed', err);
                // Friendly user-facing error only on failure
                try {
                    alert('Unable to download the API file. Please try again.');
                } catch (e) {
                    // If alert is not available, silently fail (UI shouldn't break)
                    console.error('[ForgeFlow] alert failed', e);
                }
            }
        };

        const updateLoginError = (message) => {
            if (!loginErrorMessage) {
                loginErrorMessage = document.createElement('p');
                loginErrorMessage.className = 'login-error';
                loginErrorMessage.setAttribute('role', 'alert');
                loginButton?.parentNode?.insertBefore(loginErrorMessage, loginButton.nextSibling);
            }

            loginErrorMessage.textContent = message;
        };

        const clearLoginError = () => {
            if (loginErrorMessage) {
                loginErrorMessage.textContent = '';
            }
        };

        const setLoginButtonState = (isLoading) => {
            if (!loginButton) {
                return;
            }

            loginButton.disabled = isLoading;
            loginButton.textContent = isLoading ? 'Logging in...' : 'Login';
        };

        const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        const handleLogin = async () => {
            if (!loginButton) {
                return;
            }

            const emailInput = document.getElementById('email');
            const passwordInput = document.getElementById('password');

            if (!emailInput || !passwordInput) {
                updateLoginError('Unable to access login form.');
                return;
            }

            const email = emailInput.value.trim();
            const password = passwordInput.value;

            clearLoginError();

            // Client-side validation first — no network call for something
            // the form can already tell is wrong.
            if (!email || !password) {
                updateLoginError('Email and password are required.');
                return;
            }
            if (!EMAIL_PATTERN.test(email)) {
                updateLoginError('Enter a valid email address.');
                return;
            }

            setLoginButtonState(true);

            try {
                const response = await fetch(`${AUTH_BASE_URL}/login`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ email, password })
                });

                const data = await response.json().catch(() => ({}));

                if (response.ok && data.success && data.token) {
                    clearLoginError();
                    await saveAuthSession(data.token, data.user);
                    passwordInput.value = '';
                    handleFreeTrialNavigation();
                    return;
                }

                updateLoginError(data.message || 'Login failed. Please try again.');
            } catch (error) {
                console.error('Login request failed:', error);
                updateLoginError('Unable to reach the ForgeFlow server. Please try again.');
            } finally {
                setLoginButtonState(false);
            }
        };

        const handleLogout = async () => {
            const session = await getAuthSession();
            if (session?.token) {
                try {
                    await fetch(`${AUTH_BASE_URL}/logout`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${session.token}` }
                    });
                } catch (error) {
                    console.warn('[ForgeFlow][popup] logout request failed, clearing local session anyway', error);
                }
            }

            await clearAuthSession();
            signupView.hidden = true;
            dashboardView.hidden = true;
            loginView.hidden = false;
        };

        let signupErrorMessage = null;

        const updateSignupError = (message) => {
            if (!signupErrorMessage) {
                signupErrorMessage = document.createElement('p');
                signupErrorMessage.className = 'login-error';
                signupErrorMessage.setAttribute('role', 'alert');
                signupButton?.parentNode?.insertBefore(signupErrorMessage, signupButton.nextSibling);
            }

            signupErrorMessage.textContent = message;
        };

        const clearSignupError = () => {
            if (signupErrorMessage) {
                signupErrorMessage.textContent = '';
            }
        };

        const setSignupButtonState = (isLoading) => {
            if (!signupButton) {
                return;
            }

            signupButton.disabled = isLoading;
            signupButton.textContent = isLoading ? 'Signing up...' : 'Sign Up';
        };

        const handleSignup = async () => {
            if (!signupButton) {
                return;
            }

            const nameInput = document.getElementById('signup-name');
            const emailInput = document.getElementById('signup-email');
            const passwordInput = document.getElementById('signup-password');
            const confirmPasswordInput = document.getElementById('signup-confirm-password');

            if (!nameInput || !emailInput || !passwordInput || !confirmPasswordInput) {
                updateSignupError('Unable to access sign up form.');
                return;
            }

            const name = nameInput.value.trim();
            const email = emailInput.value.trim();
            const password = passwordInput.value;
            const confirmPassword = confirmPasswordInput.value;

            clearSignupError();

            if (!name || !email || !password || !confirmPassword) {
                updateSignupError('All fields are required.');
                return;
            }
            if (!EMAIL_PATTERN.test(email)) {
                updateSignupError('Enter a valid email address.');
                return;
            }
            if (password.length < 8) {
                updateSignupError('Password must be at least 8 characters.');
                return;
            }
            if (password !== confirmPassword) {
                updateSignupError('Passwords do not match.');
                return;
            }

            setSignupButtonState(true);

            try {
                const response = await fetch(`${AUTH_BASE_URL}/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, email, password })
                });

                const data = await response.json().catch(() => ({}));

                if (response.ok && data.success && data.token) {
                    clearSignupError();
                    await saveAuthSession(data.token, data.user);
                    passwordInput.value = '';
                    confirmPasswordInput.value = '';
                    navigateToDashboard();
                    return;
                }

                updateSignupError(data.message || 'Sign up failed. Please try again.');
            } catch (error) {
                console.error('Sign up request failed:', error);
                updateSignupError('Unable to reach the ForgeFlow server. Please try again.');
            } finally {
                setSignupButtonState(false);
            }
        };

        const handlePlaceholderAction = (label) => {
            console.info(`${label} button pressed (placeholder only).`);
            // TODO: Connect this placeholder to the real API action later.
        };

        if (loginButton) {
            loginButton.addEventListener('click', handleLogin);
        } else {
            console.error('[ForgeFlow] login button not found');
        }

        if (trialButton) {
            trialButton.addEventListener('click', handleFreeTrialNavigation);
        }

        if (showSignupButton) {
            showSignupButton.addEventListener('click', showSignup);
        }

        if (showLoginButton) {
            showLoginButton.addEventListener('click', showLogin);
        }

        if (signupButton) {
            signupButton.addEventListener('click', handleSignup);
        }

        if (logoutButton) {
            logoutButton.addEventListener('click', handleLogout);
        }

        if (startRecordingButton) {
            startRecordingButton.addEventListener('click', async () => {
                console.log('[Recorder] Start clicked');
                console.log('[ForgeFlow][popup] Start Recording button clicked');
                await handleStartRecording();
            });
        }

        if (backToDashboardButton) {
            backToDashboardButton.addEventListener('click', navigateToDashboard);
        }

        if (recordStartButton) {
            recordStartButton.addEventListener('click', async () => {
                console.log('[Recorder] Record start clicked');
                console.log('[ForgeFlow][popup] Record Start button clicked');
                await handleStartRecording();
            });
        }

        if (recordStopButton) {
            recordStopButton.addEventListener('click', async () => {
                console.log('[Recorder] Record stop clicked');
                console.log('[ForgeFlow][popup] Stop Recording button clicked');
                await handleStopRecording();
            });
        }

        if (recordCancelButton) {
            recordCancelButton.addEventListener('click', async () => {
                console.log('[Recorder] Record cancel clicked');
                console.log('[ForgeFlow][popup] Cancel Recording button clicked');
                await handleCancelRecording();
            });
        }

        void updateRecordingView();

        if (copyEndpointButton) {
            copyEndpointButton.addEventListener('click', handleCopyEndpoint);
        }

        if (downloadApiButton) {
            downloadApiButton.addEventListener('click', handleDownloadApi);
        }

        const handlePublishMarketplace = async () => {
            // TODO: Replace sample payload with real API metadata and include authentication headers.
            if (!publishMarketplaceButton) return;

            const originalText = publishMarketplaceButton.dataset ? (publishMarketplaceButton.dataset.originalText || publishMarketplaceButton.textContent) : publishMarketplaceButton.textContent;

            try {
                publishMarketplaceButton.disabled = true;
                publishMarketplaceButton.textContent = 'Publishing...';

                const payload = {
                    name: 'User Workflow API',
                    version: '1.0.0',
                    method: 'POST',
                    endpoint: '/api/v1/workflow',
                    price: 10,
                    publisher: 'Demo User'
                };

                const response = await fetch('http://localhost:5000/marketplace/publish', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                const data = await response.json().catch(() => ({}));

                if (response.ok) {
                    try {
                        alert('API published successfully.');
                    } catch (e) {
                        console.log('[ForgeFlow] publish success (alert failed)');
                    }
                } else {
                    const msg = data.message || 'Publishing failed. Please try again.';
                    try {
                        alert(msg);
                    } catch (e) {
                        console.error('[ForgeFlow] publish error', msg);
                    }
                }
            } catch (err) {
                console.error('[ForgeFlow] publish to marketplace failed', err);
                try {
                    alert('Unable to publish the API. Please try again.');
                } catch (e) {
                    console.error('[ForgeFlow] alert failed', e);
                }
            } finally {
                publishMarketplaceButton.disabled = false;
                publishMarketplaceButton.textContent = originalText;
            }
        };

        if (publishMarketplaceButton) {
            publishMarketplaceButton.addEventListener('click', handlePublishMarketplace);
        }

        if (backToDashboardGeneratedButton) {
            backToDashboardGeneratedButton.addEventListener('click', showDashboard);
        }

        if (myApisCard) {
            myApisCard.addEventListener('click', showMyApis);
            myApisCard.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    showMyApis();
                }
            });
        }

        if (subscriptionCard) {
            subscriptionCard.addEventListener('click', () => showView('subscription'));
            subscriptionCard.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    showView('subscription');
                }
            });
        }

        if (settingsCard) {
            settingsCard.addEventListener('click', () => showView('settings'));
            settingsCard.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    showView('settings');
                }
            });
        }

        if (navHome) navHome.addEventListener('click', navigateToDashboard);
        if (navApis) navApis.addEventListener('click', showMyApis);
        if (navMarketplace) navMarketplace.addEventListener('click', showMarketplace);
        if (navProfile) navProfile.addEventListener('click', () => showView('profile'));

        if (backToDashboardFromSubscriptionButton) backToDashboardFromSubscriptionButton.addEventListener('click', showDashboard);
        if (backToDashboardFromSettingsButton) backToDashboardFromSettingsButton.addEventListener('click', showDashboard);
        if (backToDashboardFromProfileButton) backToDashboardFromProfileButton.addEventListener('click', showDashboard);

        if (backToDashboardFromMyApisButton) {
            backToDashboardFromMyApisButton.addEventListener('click', showDashboard);
        }

        document.querySelectorAll('.copy-endpoint-btn').forEach((button) => {
            button.addEventListener('click', () => handleCopyEndpoint(button));
        });

        if (marketplaceCard) {
            marketplaceCard.addEventListener('click', showMarketplace);
            marketplaceCard.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    showMarketplace();
                }
            });
        }

        if (marketplaceSearch) {
            marketplaceSearch.addEventListener('input', () => applyMarketplaceFilters());
        }

        if (marketplaceFilter) {
            marketplaceFilter.addEventListener('change', () => applyMarketplaceFilters());
        }

        if (marketplaceSort) {
            marketplaceSort.addEventListener('change', () => applyMarketplaceFilters());
        }

        if (marketplaceView) {
            marketplaceView.addEventListener('click', (event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return;

                if (target.closest('#edit-price-btn')) {
                    event.preventDefault();
                    handleEditPriceButton();
                }

                if (target.closest('#remove-listing-btn')) {
                    event.preventDefault();
                    handleRemoveListingButton();
                }
            });
        }

        // Category chips
        const categoryChips = document.querySelectorAll('.chip-row .chip');
        if (categoryChips && categoryChips.length) {
            categoryChips.forEach((chip) => {
                chip.addEventListener('click', (e) => {
                    e.preventDefault();
                    const cat = chip.dataset ? (chip.dataset.category || 'all') : 'all';
                    activeCategory = cat;
                    // Visual highlight
                    categoryChips.forEach(c => c.classList.remove('active'));
                    chip.classList.add('active');
                    // Also sync the filter select if applicable
                    if (marketplaceFilter) marketplaceFilter.value = 'all';
                    applyMarketplaceFilters();
                });
            });
        }

        if (backToDashboardFromMarketplaceButton) {
            backToDashboardFromMarketplaceButton.addEventListener('click', showDashboard);
        }

        // TODO: Add future marketplace backend integration, ownership verification, publishing, resale, and payment gateway hooks here.

        // On popup open: if a stored session's token still verifies against
        // the backend, skip straight to the dashboard; otherwise (missing,
        // expired, or the backend rejects it) clear it and leave the login
        // screen showing, which is already the default state of the page.
        (async () => {
            const session = await getAuthSession();
            if (!session?.token) {
                return;
            }

            const user = await verifyAuthSession(session.token);
            if (user) {
                await saveAuthSession(session.token, user);
                navigateToDashboard();
            } else {
                await clearAuthSession();
            }
        })();
    }
};

document.addEventListener('DOMContentLoaded', () => popupApp.init());
