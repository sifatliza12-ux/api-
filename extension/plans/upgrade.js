document.addEventListener('DOMContentLoaded', () => {
    const backBtn = document.getElementById('back-to-plans-btn');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            window.location.href = chrome.runtime.getURL('plans/plans.html');
        });
    }
});
