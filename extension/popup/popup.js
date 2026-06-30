/**
 * popup.js
 * Handles the popup UI interactions for the API Builder extension.
 */

function initPopup() {
    const loginButton = document.getElementById('login-btn');
    const trialButton = document.getElementById('trial-btn');

    if (loginButton) {
        loginButton.addEventListener('click', () => {
            // TODO: Add login logic here.
        });
    }

    if (trialButton) {
        trialButton.addEventListener('click', () => {
            // TODO: Add free trial flow here.
        });
    }

    // TODO: Add any future popup initialization logic here.
}

// Initialize on popup load.
document.addEventListener('DOMContentLoaded', initPopup);
