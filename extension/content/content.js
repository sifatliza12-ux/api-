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
        widgetRoot: null,
        widgetTimer: null,
        startTime: null,
        dragState: null,
        savedConfirmationActive: false
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
            runtime.widgetRoot = null;
        }

        if (runtime.widgetTimer) {
            window.clearInterval(runtime.widgetTimer);
            runtime.widgetTimer = null;
        }

        runtime.savedConfirmationActive = false;
    };

    const updateWidget = () => {
        if (!runtime.widgetRoot) {
            return;
        }

        const timer = runtime.widgetRoot.querySelector('[data-role="timer"]');
        const counter = runtime.widgetRoot.querySelector('[data-role="counter"]');

        if (timer) {
            const elapsed = runtime.startTime ? Date.now() - runtime.startTime : 0;
            timer.textContent = formatTimer(elapsed);
        }

        if (counter) {
            const count = runtime.eventCount;
            counter.textContent = `${count} action${count === 1 ? '' : 's'} captured ✓`;
        }
    };

    const showSavedConfirmation = () => {
        if (!runtime.widgetRoot) {
            return;
        }

        runtime.savedConfirmationActive = true;

        if (runtime.widgetTimer) {
            window.clearInterval(runtime.widgetTimer);
            runtime.widgetTimer = null;
        }

        const dot = runtime.widgetRoot.querySelector('[data-role="dot"]');
        const title = runtime.widgetRoot.querySelector('[data-role="title"]');
        const subtitle = runtime.widgetRoot.querySelector('[data-role="subtitle"]');
        const counter = runtime.widgetRoot.querySelector('[data-role="counter"]');
        const stopButton = runtime.widgetRoot.querySelector('[data-role="stop"]');

        if (dot) {
            dot.classList.add('is-idle');
        }

        if (title) {
            title.textContent = 'API Maker — Saved';
        }

        if (subtitle) {
            subtitle.textContent = 'Your workflow has been saved.';
        }

        if (counter) {
            counter.textContent = `${runtime.eventCount} action${runtime.eventCount === 1 ? '' : 's'} captured ✓`;
        }

        if (stopButton) {
            stopButton.remove();
        }

        window.setTimeout(() => {
            runtime.savedConfirmationActive = false;
            removeWidget();
        }, 1600);
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

        const host = document.createElement('div');
        host.id = 'forgeflow-recorder-widget';
        host.setAttribute('aria-live', 'polite');
        host.style.cssText = 'all:initial; position:fixed; right:16px; bottom:16px; z-index:2147483647; pointer-events:auto;';

        const shadow = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            .card {
                box-sizing: border-box;
                width: 260px;
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 14px 16px;
                border-radius: 16px;
                background: rgba(17, 24, 39, 0.97);
                color: #f9fafb;
                box-shadow: 0 20px 45px rgba(0, 0, 0, 0.4);
                border: 1px solid rgba(255, 255, 255, 0.12);
                backdrop-filter: blur(14px);
                font-family: Inter, system-ui, -apple-system, sans-serif;
                user-select: none;
                cursor: default;
            }
            .title-row {
                display: flex;
                align-items: center;
                gap: 8px;
                font-weight: 700;
                font-size: 13px;
            }
            .dot {
                width: 9px;
                height: 9px;
                border-radius: 50%;
                flex-shrink: 0;
                background: #ff5a5f;
                animation: pulse 1.4s infinite;
            }
            .dot.is-idle {
                background: #9ca3af;
                animation: none;
                box-shadow: none;
            }
            .subtitle {
                font-size: 11.5px;
                line-height: 1.5;
                color: #b8acd0;
            }
            .timer {
                font-size: 11px;
                color: #9ca3af;
                font-variant-numeric: tabular-nums;
            }
            .pill {
                box-sizing: border-box;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                width: 100%;
                padding: 9px 10px;
                border-radius: 999px;
                font-size: 12px;
                font-weight: 600;
                text-align: center;
                font-family: inherit;
            }
            .pill-status {
                background: rgba(34, 197, 94, 0.16);
                color: #86efac;
            }
            .pill-stop {
                background: #ef4444;
                color: #fff;
                border: none;
                cursor: pointer;
            }
            .pill-stop:hover {
                filter: brightness(1.08);
            }
            @keyframes pulse {
                0% { box-shadow: 0 0 0 0 rgba(255, 90, 95, 0.45); }
                70% { box-shadow: 0 0 0 8px rgba(255, 90, 95, 0); }
                100% { box-shadow: 0 0 0 0 rgba(255, 90, 95, 0); }
            }
        `;

        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
            <div class="title-row">
                <span class="dot" data-role="dot"></span>
                <span data-role="title">API Maker — Recording</span>
            </div>
            <div class="subtitle" data-role="subtitle">Use the site normally. Every click/type is captured.</div>
            <div class="timer" data-role="timer">00:00</div>
            <div class="pill pill-status" data-role="counter">0 actions captured ✓</div>
            <button type="button" class="pill pill-stop" data-role="stop">Stop &amp; Save Recording</button>
        `;

        shadow.appendChild(style);
        shadow.appendChild(card);
        document.documentElement.appendChild(host);

        const stopButton = shadow.querySelector('[data-role="stop"]');
        stopButton?.addEventListener('click', (event) => {
            console.log('[Recorder] Widget stop clicked');
            event.preventDefault();
            event.stopPropagation();
            showSavedConfirmation();
            void chrome.runtime.sendMessage({ type: 'stop-recording' });
        });

        card.addEventListener('pointerdown', (event) => {
            if (event.target instanceof Element && event.target.closest('[data-role="stop"]')) {
                return;
            }

            runtime.dragState = {
                offsetX: event.clientX - host.getBoundingClientRect().left,
                offsetY: event.clientY - host.getBoundingClientRect().top
            };
            card.setPointerCapture(event.pointerId);
        });

        card.addEventListener('pointermove', (event) => {
            if (!runtime.dragState) {
                return;
            }

            const nextX = event.clientX - runtime.dragState.offsetX;
            const nextY = event.clientY - runtime.dragState.offsetY;
            host.style.left = `${Math.max(12, Math.min(window.innerWidth - 272, nextX))}px`;
            host.style.right = 'auto';
            host.style.top = `${Math.max(12, Math.min(window.innerHeight - 60, nextY))}px`;
            host.style.bottom = 'auto';
        });

        card.addEventListener('pointerup', () => {
            runtime.dragState = null;
        });

        card.addEventListener('pointercancel', () => {
            runtime.dragState = null;
        });

        runtime.widget = host;
        runtime.widgetRoot = shadow;
        updateWidget();
        runtime.widgetTimer = window.setInterval(updateWidget, 1000);
        return host;
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
        if (!runtime.savedConfirmationActive) {
            removeWidget();
        }
        console.log('[Recorder][content] recording stopped');
    };

    const startRecording = () => {
        if (runtime.isRecording) {
            updateWidget();
            return;
        }

        runtime.isRecording = true;
        // Preserve any count/start time already learned from the service worker
        // (e.g. when resuming on a fresh page after navigation) instead of
        // resetting the session back to zero.
        runtime.eventCount = runtime.eventCount || 0;
        runtime.startTime = runtime.startTime || Date.now();
        attachListeners();
        createWidget();
        recordEvent('navigation', { value: window.location.href });
        console.log('[Recorder][content] recording started', {
            eventCount: runtime.eventCount,
            startTime: runtime.startTime
        });
    };

    const syncWithServiceWorker = (state) => {
        // TEMPORARY DEBUG (Milestone 3 timer-reset investigation): confirm what
        // startedAt actually looks like when the content script receives it.
        console.log('[Recorder][content][DEBUG] syncWithServiceWorker received', {
            url: window.location.href,
            isRecording: state?.isRecording,
            startedAt: state?.startedAt,
            eventCount: state?.events?.length,
            existingRuntimeStartTime: runtime.startTime
        });

        if (state?.isRecording) {
            runtime.eventCount = Number(state.events?.length || 0);
            // Use the service worker's authoritative session start time so the
            // timer keeps counting up across navigations instead of resetting.
            runtime.startTime = state.startedAt
                ? new Date(state.startedAt).getTime()
                : (runtime.startTime || Date.now());
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
