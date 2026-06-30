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

        if (!loginView || !dashboardView || !recordingView || !generationView || !generatedView) {
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
                generated: generatedView
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

        const handleCopyEndpoint = () => {
            if (copyEndpointButton) {
                copyEndpointButton.textContent = 'Copied!';
                copyEndpointButton.classList.add('is-copied');
                window.setTimeout(() => {
                    copyEndpointButton.textContent = 'Copy Endpoint';
                    copyEndpointButton.classList.remove('is-copied');
                }, 1200);
            }
            // TODO: Replace this UI-only feedback with actual clipboard integration.
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

        // TODO: Add future popup initialization logic here.
    }
};

document.addEventListener('DOMContentLoaded', () => popupApp.init());
