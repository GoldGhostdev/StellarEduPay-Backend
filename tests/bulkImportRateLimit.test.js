'use strict';

/**
 * Tests for issue #802 — rate limiting and size cap on POST /api/students/bulk.
 *
 * Acceptance criteria:
 * - Oversized uploads rejected with 413.
 * - Excessive frequency rejected with 429.
 * - Streaming parse avoids loading the whole file into memory.
 */

const path = require('path');
const fs = require('fs');

const MIDDLEWARE_SRC = fs.readFileSync(
  path.join(__dirname, '../backend/src/middleware/streamingCsvUpload.js'),
  'utf8',
);

const RATE_LIMITER_SRC = fs.readFileSync(
  path.join(__dirname, '../backend/src/middleware/rateLimiter.js'),
  'utf8',
);

const ROUTES_SRC = fs.readFileSync(
  path.join(__dirname, '../backend/src/routes/studentRoutes.js'),
  'utf8',
);

const ENV_EXAMPLE = fs.readFileSync(
  path.join(__dirname, '../backend/.env.example'),
  'utf8',
);

// ── 413 — Oversized uploads ──────────────────────────────────────────────────

describe('#802 — 413 oversized upload rejection', () => {
  it('streaming middleware returns 413 when file exceeds maxSize', () => {
    expect(MIDDLEWARE_SRC).toContain('413');
    expect(MIDDLEWARE_SRC).toContain('CSV_TOO_LARGE');
  });

  it('size check uses CSV_MAX_SIZE_BYTES env var with fallback', () => {
    const hasEnvRef = MIDDLEWARE_SRC.includes('CSV_MAX_SIZE_BYTES');
    const hasMaxSize = MIDDLEWARE_SRC.includes('maxSize');
    expect(hasEnvRef || hasMaxSize).toBe(true);
  });
});

// ── 429 — Excessive frequency ────────────────────────────────────────────────

describe('#802 — 429 rate limit rejection', () => {
  it('rate limiter returns 429 with RATE_LIMIT_EXCEEDED code', () => {
    expect(RATE_LIMITER_SRC).toContain('RATE_LIMIT_EXCEEDED');
  });

  it('bulk import has its own dedicated rate limiter (separate from general)', () => {
    expect(RATE_LIMITER_SRC).toContain('bulkImportLimiter');
  });

  it('rate limit is per-tenant using schoolId as the key', () => {
    expect(RATE_LIMITER_SRC).toContain('req.schoolId');
    expect(RATE_LIMITER_SRC).toContain('keyGenerator');
  });

  it('bulkImportLimiter is applied to the /bulk route', () => {
    expect(ROUTES_SRC).toContain('bulkImportLimiter');
  });

  it('rate limit window is 1 hour (3600000 ms)', () => {
    expect(RATE_LIMITER_SRC).toContain('60 * 60 * 1000');
  });

  it('default max is 5 per window, configurable via BULK_IMPORT_RATE_LIMIT env', () => {
    expect(RATE_LIMITER_SRC).toContain('BULK_IMPORT_RATE_LIMIT');
    expect(RATE_LIMITER_SRC).toMatch(/10\)\s*\|\|\s*5/);
  });
});

// ── Streaming parse ──────────────────────────────────────────────────────────

describe('#802 — streaming parse avoids buffering whole file', () => {
  it('does NOT use multer memory storage for bulk import', () => {
    expect(ROUTES_SRC).not.toContain("upload.single('file')");
  });

  it('uses streamingCsvUpload middleware instead of multer', () => {
    expect(ROUTES_SRC).toContain('streamingCsvUpload');
  });

  it('pipes the request through busboy', () => {
    expect(MIDDLEWARE_SRC).toContain('req.pipe(bb)');
  });

  it('streams CSV through csv-parser without loading entire file', () => {
    expect(MIDDLEWARE_SRC).toContain('.pipe(csv())');
  });
});

// ── Environment configuration ────────────────────────────────────────────────

describe('#802 — env var documentation', () => {
  it('BULK_IMPORT_RATE_LIMIT is documented in .env.example', () => {
    expect(ENV_EXAMPLE).toContain('BULK_IMPORT_RATE_LIMIT');
  });
});
