/**
 * content.js
 * Records real browser workflow events from the active page.
 */

(() => {
    const recorderState = {
        isRecording: false,
        events: []
    };
    let listenersAttached = false;

    const getTimestamp = () => new Date().toISOString();

    const getSelector = (element) => {
        if (!(element instanceof Element)) return null;

        if (element.id) {
            return `#${CSS.escape(element.id)}`;
        }

        const attrs = ['name', 'placeholder', 'aria-label', 'data-testid'];
        for (const attr of attrs) {
            const value = element.getAttribute(attr);
            if (value) {
                return `${element.tagName.toLowerCase()}[${attr}="${value}"]`;
            }
        }

        if (element.className && typeof element.className === 'string') {
            const classes = element.className.split(/\s+/).filter(Boolean);
            if (classes.length) {
                return `${element.tagName.toLowerCase()}.${classes.slice(0, 3).join('.')}`;
            }
        }

        return element.tagName.toLowerCase();
    };

    const getElementValue = (target) => {
        if (target instanceof HTMLInputElement) {
            if (target.type === 'checkbox' || target.type === 'radio') {
                return target.checked;
            }
            return target.value;
        }

        if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
            return target.value;
        }

        if (target instanceof Element && target.isContentEditable) {
            return target.textContent || '';
        }

        return undefined;
    };

    const removeListeners = () => {
        if (!listenersAttached) {
            return;
        }

        document.removeEventListener('click', handleClick, true);
        document.removeEventListener('input', handleInput, true);
        document.removeEventListener('change', handleChange, true);
        document.removeEventListener('keydown', handleKeyDown, true);
        document.removeEventListener('keyup', handleKeyUp, true);
        window.removeEventListener('scroll', handleScroll, true);
        window.removeEventListener('popstate', recordNavigation);
        listenersAttached = false;
        console.log('[ForgeFlow][content] listeners removed');
    };

    const recordEvent = (type, details = {}) => {
        if (!recorderState.isRecording) {
            return;
        }

        const event = {
            type,
            timestamp: getTimestamp(),
            url: window.location.href,
            ...details
        };

        recorderState.events.push(event);
        console.log('[ForgeFlow][content] recorded', type, details);
    };

    const recordNavigation = () => {
        recordEvent('navigate', {
            url: window.location.href
        });
    };

    const handleClick = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        recordEvent('click', {
            selector: getSelector(target),
            tagName: target.tagName.toLowerCase(),
            text: (target.textContent || '').trim().slice(0, 120)
        });
    };

    const handleInput = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        const value = getElementValue(target);
        if (typeof value === 'undefined') {
            return;
        }

        recordEvent('input', {
            selector: getSelector(target),
            tagName: target.tagName.toLowerCase(),
            value,
            inputType: target instanceof HTMLInputElement ? target.type || 'text' : 'text'
        });
    };

    const handleChange = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        const value = getElementValue(target);
        if (typeof value === 'undefined') {
            return;
        }

        recordEvent('change', {
            selector: getSelector(target),
            tagName: target.tagName.toLowerCase(),
            value,
            inputType: target instanceof HTMLInputElement ? target.type || 'text' : 'text'
        });
    };

    const handleKeyDown = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        if (!event.key) {
            return;
        }

        recordEvent('keydown', {
            selector: getSelector(target),
            tagName: target.tagName.toLowerCase(),
            value: event.key
        });
    };

    const handleKeyUp = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        if (!event.key) {
            return;
        }

        recordEvent('keyup', {
            selector: getSelector(target),
            tagName: target.tagName.toLowerCase(),
            value: event.key
        });
    };

    const handleScroll = () => {
        recordEvent('scroll', {
            scrollX: window.scrollX,
            scrollY: window.scrollY
        });
    };

    const attachListeners = () => {
        if (listenersAttached) {
            return;
        }

        document.addEventListener('click', handleClick, true);
        document.addEventListener('input', handleInput, true);
        document.addEventListener('change', handleChange, true);
        document.addEventListener('keydown', handleKeyDown, true);
        document.addEventListener('keyup', handleKeyUp, true);
        window.addEventListener('scroll', handleScroll, true);

        const originalPushState = history.pushState;
        history.pushState = function patchedPushState(...args) {
            const result = originalPushState.apply(this, args);
            recordNavigation();
            return result;
        };

        const originalReplaceState = history.replaceState;
        history.replaceState = function patchedReplaceState(...args) {
            const result = originalReplaceState.apply(this, args);
            recordNavigation();
            return result;
        };

        window.addEventListener('popstate', recordNavigation);
        listenersAttached = true;
        console.log('[ForgeFlow][content] event listeners registered');
    };

    const exposeRecorder = () => {
        window.__forgeflowRecorder = {
            getEvents: () => recorderState.events.slice(),
            clearEvents: () => {
                recorderState.events = [];
            },
            setRecording: (value) => {
                recorderState.isRecording = Boolean(value);
            },
            getRecordingState: () => recorderState.isRecording
        };
    };

    const initialize = () => {
        console.log('[ForgeFlow][content] content script loaded and waiting for recording start');
        exposeRecorder();
    };

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        console.log('[ForgeFlow][content] message received', request);

        if (request && request.type === 'getRecorderState') {
            sendResponse({
                isRecording: recorderState.isRecording,
                events: recorderState.events.slice()
            });
            return true;
        }

        if (request && request.type === 'start-recording') {
            recorderState.events = [];
            recorderState.isRecording = true;
            attachListeners();
            console.log('[ForgeFlow][content] recording started');
            sendResponse({ ok: true, isRecording: recorderState.isRecording, events: recorderState.events.slice() });
            return true;
        }

        if (request && request.type === 'stop-recording') {
            recorderState.isRecording = false;
            removeListeners();
            console.log('[ForgeFlow][content] recording stopped');
            sendResponse({ ok: true, isRecording: recorderState.isRecording, events: recorderState.events.slice() });
            return true;
        }

        if (request && request.type === 'setRecording') {
            recorderState.isRecording = Boolean(request.value);
            sendResponse({ ok: true, isRecording: recorderState.isRecording });
            return true;
        }

        if (request && request.type === 'clearRecorder') {
            recorderState.events = [];
            sendResponse({ ok: true });
            return true;
        }

        sendResponse({ status: 'received' });
        return true;
    });

    void initialize();
})();
