/**
 * service-worker.js
 * Background service worker for the API Builder extension
 * Handles background tasks and messaging
 */

/**
 * Initialize the service worker
 */
console.log('API Builder service worker initialized');

/**
 * Listen for messages from popup and content scripts
 * TODO: Implement message handling logic
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Message received in service worker:', request);
    // TODO: Add message handling logic here
    sendResponse({ status: 'received' });
});

/**
 * Listen for extension installation or update
 * TODO: Implement installation logic
 */
chrome.runtime.onInstalled.addListener(() => {
    console.log('API Builder extension installed/updated');
    // TODO: Add setup logic here
});
