/**
 * popup.js
 * ForgeFlow's popup is now a lightweight control panel, not the main
 * application — login/session handling stays here, but Marketplace, My
 * APIs, Plans & Pricing, and Settings all live in the Dashboard tab
 * (extension/dashboard/) and the other app pages it links to. The popup's
 * own job is just: recording status, a Start/Stop toggle, and a way to open
 * the Dashboard. Recording itself talks directly to the background service
 * worker over the same message API the Dashboard uses, so starting a
 * recording here and stopping it from the Dashboard (or vice versa) both
 * work correctly.
 */

const popupApp = {
    init() {
        console.log('[ForgeFlow][popup] popup script initialized');
        const loginView = document.getElementById('login-view');
        const signupView = document.getElementById('signup-view');
        const dashboardView = document.getElementById('dashboard-view');

        const loginButton = document.getElementById('login-btn');
        const trialButton = document.getElementById('trial-btn');
        const showSignupButton = document.getElementById('show-signup-btn');
        const showLoginButton = document.getElementById('show-login-btn');
        const signupButton = document.getElementById('signup-btn');
        const logoutButton = document.getElementById('logout-btn');
        const popupRecordIndicator = document.getElementById('popup-record-indicator');
        const popupRecordStatus = document.getElementById('popup-record-status');
        const popupRecordToggleBtn = document.getElementById('popup-record-toggle-btn');
        const openDashboardButton = document.getElementById('open-dashboard-btn');

        if (!loginView || !dashboardView) {
            console.error('[ForgeFlow] required views missing');
            return;
        }

        let loginErrorMessage = null;

        const AUTH_BASE_URL = `${window.FORGEFLOW_API_BASE}/api/auth`;
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

        const navigateToDashboard = () => {
            loginView.hidden = true;
            signupView.hidden = true;
            dashboardView.hidden = false;
            void refreshRecordingState();
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

        // Same launcher pattern Marketplace/Plans/My APIs/Settings already
        // used before they moved out of the popup entirely — the Dashboard
        // is now the one remaining destination the popup opens. Where
        // exactly it opens is driven by Settings > Preferences: "Remember
        // last visited page" (if on and something was visited) wins,
        // otherwise it falls back to the configured "Default Landing Page".
        const openDashboardTab = async () => {
            let target = 'mode-select/mode-select.html';

            if (window.ForgeFlowPreferences) {
                try {
                    const prefs = await window.ForgeFlowPreferences.getPrefs();
                    const lastPage = prefs.rememberLastPage
                        ? await window.ForgeFlowPreferences.getLastVisitedPage()
                        : null;
                    target = lastPage || prefs.defaultLandingPage || target;
                } catch (error) {
                    console.warn('[ForgeFlow][popup] could not read preferences, opening Dashboard', error);
                }
            }

            const dashboardUrl = chrome.runtime.getURL(target);
            chrome.tabs.create({ url: dashboardUrl });
        };

        // First-time role choice, triggered right at the moment of a
        // successful login/signup — not on every popup open (see the silent
        // session-restore at the bottom of this file, which deliberately
        // does NOT call this). shared/roles.js remembers the choice per
        // user id, so this only ever auto-opens once per account; Mode
        // Selection itself is also reachable any time the user opens the
        // Dashboard via openDashboardTab() above, so this is just a
        // first-login convenience, not the only path to it.
        const maybeOpenModeSelection = async (user) => {
            if (!user?.id || !window.ForgeFlowRoles || typeof chrome === 'undefined' || !chrome.tabs) {
                return;
            }
            try {
                const alreadyChosen = await window.ForgeFlowRoles.hasChosenRole(user.id);
                if (alreadyChosen) {
                    return;
                }
                chrome.tabs.create({ url: chrome.runtime.getURL('mode-select/mode-select.html') });
            } catch (error) {
                console.warn('[ForgeFlow][popup] could not check role, skipping mode-selection redirect', error);
            }
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

        const updatePopupRecordingUI = (state) => {
            const isRecording = Boolean(state?.isRecording);

            if (popupRecordIndicator) {
                popupRecordIndicator.classList.toggle('is-recording', isRecording);
            }
            if (popupRecordStatus) {
                popupRecordStatus.textContent = isRecording ? 'Recording…' : 'Not Recording';
            }
            if (popupRecordToggleBtn) {
                popupRecordToggleBtn.textContent = isRecording ? 'Stop Recording' : 'Start Recording';
                popupRecordToggleBtn.classList.toggle('is-recording', isRecording);
            }
        };

        const refreshRecordingState = async () => {
            try {
                const response = await sendRuntimeMessage({ type: 'get-recorder-state' });
                updatePopupRecordingUI(response?.state);
            } catch (error) {
                console.error('[ForgeFlow][popup] unable to refresh recording state', error);
            }
        };

        const handleStartRecording = async () => {
            console.log('[ForgeFlow][popup] start recording requested');
            if (popupRecordToggleBtn) popupRecordToggleBtn.disabled = true;
            const response = await sendRuntimeMessage({ type: 'start-recording', source: 'popup' });
            if (popupRecordToggleBtn) popupRecordToggleBtn.disabled = false;
            if (!response?.ok) {
                console.error('[ForgeFlow][popup] failed to start recording', response);
            }
            updatePopupRecordingUI(response?.state);
        };

        const handleStopRecording = async () => {
            const input = window.prompt('Name this workflow:', defaultWorkflowName());
            const name = (input || '').trim() || defaultWorkflowName();

            if (popupRecordToggleBtn) popupRecordToggleBtn.disabled = true;
            const response = await sendRuntimeMessage({ type: 'stop-recording', source: 'popup', save: true, name });
            if (popupRecordToggleBtn) popupRecordToggleBtn.disabled = false;
            updatePopupRecordingUI(response?.state);

            if (response?.save?.ok) {
                alert('Workflow saved! Open the Dashboard to see it under My APIs.');
            } else if (response?.save) {
                alert(`Could not save workflow: ${response.save.error || 'Unknown error'}`);
            }
        };

        const handleToggleRecording = async () => {
            const response = await sendRuntimeMessage({ type: 'get-recorder-state' });
            if (response?.state?.isRecording) {
                await handleStopRecording();
            } else {
                await handleStartRecording();
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
                    await maybeOpenModeSelection(data.user);
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
                    await maybeOpenModeSelection(data.user);
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

        if (popupRecordToggleBtn) {
            popupRecordToggleBtn.addEventListener('click', handleToggleRecording);
        }

        if (openDashboardButton) {
            openDashboardButton.addEventListener('click', openDashboardTab);
        }

        void refreshRecordingState();

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
