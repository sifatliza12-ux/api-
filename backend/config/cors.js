// Restricts cross-origin requests to an explicit allowlist in production,
// read from CORS_ORIGIN — a comma-separated list of origins (e.g. the
// extension's own chrome-extension://<id> origin once its id is known).
// Local development keeps the previous unrestricted default so an unpacked
// extension's ephemeral id never needs configuring just to develop against
// the backend.
const NODE_ENV = process.env.NODE_ENV || 'development';

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

let origin;
if (allowedOrigins.length > 0) {
  origin = allowedOrigins;
} else if (NODE_ENV === 'production') {
  // No CORS_ORIGIN configured in production — fail closed (reject every
  // cross-origin request) rather than silently falling back to wide open.
  console.error('[Backend] WARNING: CORS_ORIGIN is not set in production — all cross-origin requests will be rejected until it is configured with your extension\'s chrome-extension://<id> origin.');
  origin = false;
} else {
  origin = true;
}

const corsOptions = {
  origin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

module.exports = corsOptions;
