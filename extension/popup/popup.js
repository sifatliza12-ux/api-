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
                marketplace: marketplaceView
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
            // TODO: Persist the generated API metadata when the backend is available.
        };

        const showMyApis = () => {
            showView('myApis');
            // TODO: Load generated APIs from backend when the API service is available.
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

        if (publishMarketplaceButton) {
            publishMarketplaceButton.addEventListener('click', () => handlePlaceholderAction('Publish to Marketplace'));
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
