/**
 * popup.js
 * Handles the premium popup interactions for ForgeFlow.
 */

const popupApp = {
    init() {
        const loginView = document.getElementById('login-view');
        const dashboardView = document.getElementById('dashboard-view');
        const recordingView = document.getElementById('recording-view');
        const generationView = document.getElementById('generation-view');
        const generatedView = document.getElementById('generated-view');
        const myApisView = document.getElementById('my-apis-view');
        const marketplaceView = document.getElementById('marketplace-view');

        const loginButton = document.getElementById('login-btn');
        const trialButton = document.getElementById('trial-btn');
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
            dashboardView.hidden = false;
        };

        // Alias used by various back buttons in the DOM
        const showDashboard = navigateToDashboard;

        const handleFreeTrialNavigation = () => {
            navigateToDashboard();
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
            // TODO: Connect to recording service or state store later.
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
                        headers: { 'Content-Type': 'application/json' },
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
                            headers: { 'Content-Type': 'application/json' },
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
                        const resp = await fetch(`http://localhost:5000/api/my-apis/${api.id}`, { method: 'DELETE' });
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
                const { ok, data } = await fetchJson('http://localhost:5000/api/my-apis');
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

        const openApiModal = (api) => {
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
            modal.innerHTML = `
                <h3>${escapeHtml(api.name)}</h3>
                <p><strong>Endpoint:</strong> ${escapeHtml(api.endpoint)}</p>
                <p><strong>Method:</strong> ${escapeHtml(api.method)}</p>
                <p><strong>Version:</strong> ${escapeHtml(api.version || '')}</p>
                <pre style="background:#f6f8fa;padding:8px;border-radius:4px;max-height:240px;overflow:auto">${escapeHtml(api.generatedCode || '')}</pre>
                <div style="text-align:right;margin-top:8px">
                    <button class="btn btn-secondary modal-close">Close</button>
                </div>
            `;

            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
            overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
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
        };

        const handleStartRecording = () => {
            showGenerating();
            generationTimeoutId = window.setTimeout(() => {
                showGenerated();
            }, 2000);
            // TODO: Replace this simulated timeout with real recording and generation events.
        };

        const handleCancelRecording = () => {
            navigateToDashboard();
            // TODO: Reset recording state when the real workflow is implemented.
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

            const payload = {
                email: emailInput.value,
                password: passwordInput.value
            };

            setLoginButtonState(true);
            clearLoginError();

            try {
                const response = await fetch('http://localhost:5000/auth/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                const data = await response.json().catch(() => ({}));

                const isLoginSuccessful = response.ok;

                if (isLoginSuccessful) {
                    clearLoginError();
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

        if (startRecordingButton) {
            startRecordingButton.addEventListener('click', showRecording);
        }

        if (backToDashboardButton) {
            backToDashboardButton.addEventListener('click', navigateToDashboard);
        }

        if (recordStartButton) {
            recordStartButton.addEventListener('click', handleStartRecording);
        }

        if (recordCancelButton) {
            recordCancelButton.addEventListener('click', handleCancelRecording);
        }

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

        if (backToDashboardFromMarketplaceButton) {
            backToDashboardFromMarketplaceButton.addEventListener('click', showDashboard);
        }

        // TODO: Add future marketplace backend integration, ownership verification, publishing, resale, and payment gateway hooks here.
    }
};

document.addEventListener('DOMContentLoaded', () => popupApp.init());
