/**
 * popup.js
 * Handles the premium popup interactions for ForgeFlow.
 */

const popupApp = {
    init() {
        const loginView = document.getElementById('login-view');
        const dashboardView = document.getElementById('dashboard-view');
        const loginButton = document.getElementById('login-btn');
        const trialButton = document.getElementById('trial-btn');
        const startRecordingButton = document.getElementById('start-recording-btn');

        if (!loginView || !dashboardView) {
            return;
        }

        const showDashboard = () => {
            loginView.hidden = true;
            dashboardView.hidden = false;
            // TODO: Add analytics or state tracking for dashboard entry.
        };

        const handleStartRecording = () => {
            // TODO: Implement recording flow and API generation later.
            console.info('Start Recording clicked');
        };

        if (loginButton) {
            loginButton.addEventListener('click', showDashboard);
        }

        if (trialButton) {
            trialButton.addEventListener('click', showDashboard);
        }

        if (startRecordingButton) {
            startRecordingButton.addEventListener('click', handleStartRecording);
        }

        // TODO: Add future popup initialization logic here.
    }
};

document.addEventListener('DOMContentLoaded', () => popupApp.init());
