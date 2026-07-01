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
            return;
        }

        let generationTimeoutId = null;

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

        const showDashboard = () => {
            showView('dashboard');
            // TODO: Add analytics or state tracking for dashboard entry.
        };

        const showRecording = () => {
            showView('recording');
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
            showDashboard();
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

        const handlePlaceholderAction = (label) => {
            console.info(`${label} button pressed (placeholder only).`);
            // TODO: Connect this placeholder to the real API action later.
        };

        if (loginButton) {
            loginButton.addEventListener('click', showDashboard);
        }

        if (trialButton) {
            trialButton.addEventListener('click', showDashboard);
        }

        if (startRecordingButton) {
            startRecordingButton.addEventListener('click', showRecording);
        }

        if (backToDashboardButton) {
            backToDashboardButton.addEventListener('click', showDashboard);
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
            downloadApiButton.addEventListener('click', () => handlePlaceholderAction('Download API'));
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
