'use strict';

function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

  // Wildcard is never safe when credentials:true is used
  if (raw === '*') {
    throw new Error(
      'ALLOWED_ORIGIN wildcard (*) is not permitted when credentials:true is enabled. ' +
      'Specify explicit origins instead.'
    );
  }

  const origins = raw.split(',').map((o) => o.trim()).filter(Boolean);

  if (origins.length === 0) {
    throw new Error(
      'ALLOWED_ORIGIN must contain at least one valid origin URL. ' +
      'Example: ALLOWED_ORIGIN=https://app.school.com'
    );
  }

  for (const origin of origins) {
    try { new URL(origin); } catch {
      throw new Error(`ALLOWED_ORIGIN contains invalid URL: "${origin}"`);
    }
  }

  return origins.length === 1 ? origins[0] : origins;
}

module.exports = { parseAllowedOrigins };
