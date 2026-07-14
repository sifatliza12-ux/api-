/**
 * Single source of truth for the backend base URL. This is an unbundled
 * Chrome extension (no webpack/vite build step), so there's no real
 * process.env available in browser JS — this file is the practical
 * equivalent of an environment variable for this codebase: to point the
 * whole extension at a deployed backend instead of local development,
 * change the one line below and nothing else.
 */
// `self` (not `window`) so this same file loads unmodified both as a page
// <script> tag (where self === window) and via importScripts() in the
// background service worker (background/service-worker.js), which has no
// `window` global at all.
self.FORGEFLOW_API_BASE = 'http://localhost:5000';
