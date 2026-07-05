/**
 * content.js
 * Handles all recording UI and event capture for the active page.
 */

(() => {
    if (window.__forgeflowRecorderRuntime?.initialized) {
        return;
    }

    const runtime = window.__forgeflowRecorderRuntime || (window.__forgeflowRecorderRuntime = {
        initialized: false,
        isRecording: false,
        eventCount: 0,
        listenersAttached: false,
        widget: null,
        widgetTimer: null,
        startTime: null,
        dragState: null
    });

    runtime.initialized = true;

    const getTimestamp = () => new Date().toISOString();

    const getSelector = (element) => {
        if (!(element instanceof Element)) {
            return null;
        }

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

    const formatTimer = (elapsedMs) => {
        const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
        const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
        const seconds = String(totalSeconds % 60).padStart(2, '0');
        return `${minutes}:${seconds}`;
    };

    const removeWidget = () => {
        if (runtime.widget) {
            runtime.widget.remove();
            runtime.widget = null;
        }

        if (runtime.widgetTimer) {
            window.clearInterval(runtime.widgetTimer);
            runtime.widgetTimer = null;
        }
    };

    const updateWidget = () => {
        if (!runtime.widget) {
            return;
        }

        const indicator = runtime.widget.querySelector('[data-role="indicator"]');
        const timer = runtime.widget.querySelector('[data-role="timer"]');
        const counter = runtime.widget.querySelector('[data-role="counter"]');
        const stopButton = runtime.widget.querySelector('[data-role="stop"]');

        if (indicator) {
            indicator.textContent = runtime.isRecording ? '● Recording' : '● Stopped';
            indicator.style.color = runtime.isRecording ? '#ff5a5f' : '#9ca3af';
        }

        if (timer) {
            const elapsed = runtime.startTime ? Date.now() - runtime.startTime : 0;
            timer.textContent = formatTimer(elapsed);
        }

        if (counter) {
            counter.textContent = `Events: ${runtime.eventCount}`;
        }

        if (stopButton) {
            stopButton.disabled = !runtime.isRecording;
        }
    };

    const createWidget = () => {
        if (runtime.widget) {
            updateWidget();
            return runtime.widget;
        }

        if (!document.body) {
            window.setTimeout(createWidget, 0);
            return null;
        }

        const widget = document.createElement('div');
        widget.id = 'forgeflow-recorder-widget';
        widget.setAttribute('aria-live', 'polite');
        widget.style.cssText = [
            'position:fixed',
            'right:16px',
            'bottom:16px',
            'z-index:2147483647',
            'display:flex',
            'align-items:center',
            'gap:8px',
            'padding:10px 12px',
            'border-radius:14px',
            'background:rgba(17, 24, 39, 0.96)',
            'color:#f9fafb',
            'box-shadow:0 16px 40px rgba(0, 0, 0, 0.35)',
            'font-family:Inter, system-ui, sans-serif',
            'font-size:12px',
            'pointer-events:auto',
            'user-select:none',
            'backdrop-filter:blur(14px)',
            'border:1px solid rgba(255,255,255,0.12)'
        ].join(';');

        widget.innerHTML = `
            <span data-role="indicator" style="color:#ff5a5f; font-weight:700;">● Recording</span>
            <span data-role="timer" style="font-variant-numeric:tabular-nums;">00:00</span>
            <span data-role="counter">Events: 0</span>
            <button type="button" data-role="stop" style="border:none; border-radius:999px; padding:6px 10px; background:#ef4444; color:white; cursor:pointer;">Stop</button>
        `;

        const stopButton = widget.querySelector('[data-role="stop"]');
        stopButton?.addEventListener('click', (event) => {
            console.log('[Recorder] Widget stop clicked');
            event.preventDefault();
            event.stopPropagation();
            void chrome.runtime.sendMessage({ type: 'stop-recording' });
        });

        widget.addEventListener('pointerdown', (event) => {
            if (event.target instanceof HTMLElement && event.target.closest('[data-role="stop"]')) {
                return;
            }

            runtime.dragState = {
                offsetX: event.clientX - widget.getBoundingClientRect().left,
                offsetY: event.clientY - widget.getBoundingClientRect().top
            };
            widget.setPointerCapture(event.pointerId);
        });

        widget.addEventListener('pointermove', (event) => {
            if (!runtime.dragState) {
                return;
            }

            const nextX = event.clientX - runtime.dragState.offsetX;
            const nextY = event.clientY - runtime.dragState.offsetY;
            widget.style.left = `${Math.max(12, Math.min(window.innerWidth - 260, nextX))}px`;
            widget.style.right = 'auto';
            widget.style.top = `${Math.max(12, Math.min(window.innerHeight - 60, nextY))}px`;
            widget.style.bottom = 'auto';
        });

        widget.addEventListener('pointerup', () => {
            runtime.dragState = null;
        });

        widget.addEventListener('pointercancel', () => {
            runtime.dragState = null;
        });

        document.documentElement.appendChild(widget);
        runtime.widget = widget;
        updateWidget();
        runtime.widgetTimer = window.setInterval(updateWidget, 1000);
        return widget;
    };

    const removeListeners = () => {
        if (!runtime.listenersAttached) {
            return;
        }

        document.removeEventListener('click', handleClick, true);
        document.removeEventListener('input', handleInput, true);
        document.removeEventListener('change', handleChange, true);
        document.removeEventListener('keydown', handleKeyDown, true);
        document.removeEventListener('keyup', handleKeyUp, true);
        window.removeEventListener('scroll', handleScroll, true);
        window.removeEventListener('popstate', handlePopState);
        runtime.listenersAttached = false;
        console.log('[Recorder][content] listeners removed');
    };

    const sendEventToServiceWorker = (type, details = {}) => {
        const payload = {
            type,
            selector: details.selector || null,
            url: window.location.href,
            pageTitle: document.title,
            value: details.value ?? null
        };

        chrome.runtime.sendMessage({ type: 'recorder-event', event: payload }, () => {
            if (chrome.runtime.lastError) {
                console.warn('[Recorder][content] failed to sync event', chrome.runtime.lastError.message);
            }
        });
    };

    const recordEvent = (type, details = {}) => {
        if (!runtime.isRecording) {
            return;
        }

        runtime.eventCount += 1;
        updateWidget();
        console.log('[Recorder][content] recorded', type, details);
        sendEventToServiceWorker(type, details);
    };

    const handlePopState = () => {
        recordEvent('navigation', { value: window.location.href });
    };

    const handleClick = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        if (target.closest('#forgeflow-recorder-widget')) {
            return;
        }

        recordEvent('click', {
            selector: getSelector(target),
            value: (target.textContent || '').trim().slice(0, 120)
        });
    };

    const handleInput = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        if (target.closest('#forgeflow-recorder-widget')) {
            return;
        }

        const value = getElementValue(target);
        if (typeof value === 'undefined') {
            return;
        }

        recordEvent('input', {
            selector: getSelector(target),
            value
        });
    };

    const handleChange = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        if (target.closest('#forgeflow-recorder-widget')) {
            return;
        }

        const value = getElementValue(target);
        if (typeof value === 'undefined') {
            return;
        }

        recordEvent('change', {
            selector: getSelector(target),
            value
        });
    };

    const handleKeyDown = (event) => {
        const target = event.target;
        if (!(target instanceof Element) || !event.key) {
            return;
        }

        if (target.closest('#forgeflow-recorder-widget')) {
            return;
        }

        recordEvent('keydown', {
            selector: getSelector(target),
            value: event.key
        });
    };

    const handleKeyUp = (event) => {
        const target = event.target;
        if (!(target instanceof Element) || !event.key) {
            return;
        }

        if (target.closest('#forgeflow-recorder-widget')) {
            return;
        }

        recordEvent('keyup', {
            selector: getSelector(target),
            value: event.key
        });
    };

    const handleScroll = () => {
        recordEvent('scroll', {
            value: `${window.scrollX},${window.scrollY}`
        });
    };

    const attachListeners = () => {
        if (runtime.listenersAttached) {
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
            handlePopState();
            return result;
        };

        const originalReplaceState = history.replaceState;
        history.replaceState = function patchedReplaceState(...args) {
            const result = originalReplaceState.apply(this, args);
            handlePopState();
            return result;
        };

        window.addEventListener('popstate', handlePopState);
        runtime.listenersAttached = true;
        console.log('[Recorder][content] listeners attached');
    };

    const stopRecording = () => {
        runtime.isRecording = false;
        removeListeners();
        removeWidget();
        console.log('[Recorder][content] recording stopped');
    };

    const startRecording = () => {
        if (runtime.isRecording) {
            updateWidget();
            return;
        }

        runtime.isRecording = true;
        runtime.eventCount = 0;
        runtime.startTime = Date.now();
        attachListeners();
        createWidget();
        recordEvent('navigation', { value: window.location.href });
        console.log('[Recorder][content] recording started');
    };

    const syncWithServiceWorker = (state) => {
        if (state?.isRecording) {
            runtime.eventCount = Number(state.events?.length || 0);
            runtime.startTime = runtime.startTime || Date.now();
            startRecording();
            return;
        }

        stopRecording();
    };

    const initialize = () => {
        console.log('[Recorder][content] loaded');
        chrome.runtime.sendMessage({ type: 'recorder:ready' }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('[Recorder][content] unable to sync with service worker', chrome.runtime.lastError.message);
                return;
            }

            if (response?.state) {
                syncWithServiceWorker(response.state);
            }
        });
    };

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        console.log('[Recorder][content] message received', request);

        if (request?.type === 'recorder:sync') {
            syncWithServiceWorker(request.state);
            sendResponse({ ok: true, isRecording: runtime.isRecording });
            return true;
        }

        if (request?.type === 'start-recording') {
            startRecording();
            sendResponse({ ok: true, isRecording: runtime.isRecording, eventCount: runtime.eventCount });
            return true;
        }

        if (request?.type === 'stop-recording') {
            stopRecording();
            sendResponse({ ok: true, isRecording: runtime.isRecording, eventCount: runtime.eventCount });
            return true;
        }

        sendResponse({ ok: true, status: 'received' });
        return true;
    });

    initialize();
})();
