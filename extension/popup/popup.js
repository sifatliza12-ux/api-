/**
 * popup.js
 * Handles the premium popup interactions for ForgeFlow.
 */

const popupApp = {
    init() {
        const loginView = document.getElementById('login-view');
        const dashboardView = document.getElementById('dashboard-view');
        const recordingView = document.getElementById('recording-view');

        const loginButton = document.getElementById('login-btn');
        const trialButton = document.getElementById('trial-btn');
        const startRecordingButton = document.getElementById('start-recording-btn');
        const backToDashboardButton = document.getElementById('back-to-dashboard-btn');
        const recordStartButton = document.getElementById('record-start-btn');
        const recordCancelButton = document.getElementById('record-cancel-btn');

        if (!loginView || !dashboardView || !recordingView) {
            return;
        }

        const showView = (viewName) => {
            const views = {
                login: loginView,
                dashboard: dashboardView,
                recording: recordingView
            };

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

        const handleStartRecording = () => {
            // TODO: Implement actual recording workflow once the capture layer is ready.
            console.info('Recording start placeholder clicked.');
        };

        const handleCancelRecording = () => {
            showDashboard();
            // TODO: Reset recording state when the real workflow is implemented.
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

        // TODO: Add future popup initialization logic here.
    }
};

document.addEventListener('DOMContentLoaded', () => popupApp.init());
