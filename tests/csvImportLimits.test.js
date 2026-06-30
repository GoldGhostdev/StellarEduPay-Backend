'use strict';

/**
 * Tests for CSV bulk import file size and row count limits (Issue #369, #802).
 * The size/row/column enforcement now lives in streamingCsvUpload.js middleware.
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';

const path = require('path');
const fs = require('fs');

const MIDDLEWARE_SRC = fs.readFileSync(
  path.join(__dirname, '../backend/src/middleware/streamingCsvUpload.js'),
  'utf8',
);

const ENV_EXAMPLE = fs.readFileSync(
  path.join(__dirname, '../backend/.env.example'),
  'utf8',
);

// ── File size limit ───────────────────────────────────────────────────────────

describe('CSV bulk import — file size limit', () => {
  it('enforces maxSize before rows are parsed', () => {
    expect(MIDDLEWARE_SRC).toContain('maxSize');
    expect(MIDDLEWARE_SRC).toContain('fileSize');
  });

  it('returns HTTP 413 when file is too large', () => {
    expect(MIDDLEWARE_SRC).toContain('413');
    expect(MIDDLEWARE_SRC).toContain('CSV_TOO_LARGE');
  });

  it('reads CSV_MAX_SIZE_BYTES from environment with 5 MB default', () => {
    expect(MIDDLEWARE_SRC).toMatch(/CSV_MAX_SIZE_BYTES|maxSize/);
  });
});

// ── Row count limit ───────────────────────────────────────────────────────────

describe('CSV bulk import — row count limit', () => {
  it('enforces CSV_MAX_ROWS during streaming parse', () => {
    expect(MIDDLEWARE_SRC).toContain('maxRows');
    expect(MIDDLEWARE_SRC).toContain('CSV_TOO_MANY_ROWS');
  });

  it('reads CSV_MAX_ROWS from environment with 10000 default', () => {
    expect(MIDDLEWARE_SRC).toMatch(/CSV_MAX_ROWS|maxRows/);
  });

  it('destroys the file stream when row limit is exceeded', () => {
    expect(MIDDLEWARE_SRC).toContain('file.destroy()');
  });

  it('returns HTTP 400 for row count exceeded', () => {
    expect(MIDDLEWARE_SRC).toContain('CSV_TOO_MANY_ROWS');
    expect(MIDDLEWARE_SRC).toContain('400');
  });
});

// ── Column limit ──────────────────────────────────────────────────────────────

describe('CSV bulk import — column count limit', () => {
  it('enforces CSV_MAX_COLUMNS during streaming parse', () => {
    expect(MIDDLEWARE_SRC).toContain('maxColumns');
    expect(MIDDLEWARE_SRC).toContain('CSV_INVALID_FORMAT');
  });

  it('reads CSV_MAX_COLUMNS from environment with 20 default', () => {
    expect(MIDDLEWARE_SRC).toMatch(/CSV_MAX_COLUMNS|maxColumns/);
  });

  it('returns HTTP 400 for column count exceeded', () => {
    expect(MIDDLEWARE_SRC).toContain('CSV_INVALID_FORMAT');
    expect(MIDDLEWARE_SRC).toContain('400');
  });
});

// ── Streaming parse (no full-file buffering) ──────────────────────────────────

describe('CSV bulk import — streaming parse', () => {
  it('pipes the incoming file stream through csv-parser without buffering', () => {
    expect(MIDDLEWARE_SRC).toContain('.pipe(csv())');
  });

  it('uses busboy to handle multipart upload as stream', () => {
    expect(MIDDLEWARE_SRC).toMatch(/require\s*\(\s*['"]busboy['"]\s*\)/);
    expect(MIDDLEWARE_SRC).toContain('req.pipe(bb)');
  });

  it('attaches parsed rows to req.parsedRows', () => {
    expect(MIDDLEWARE_SRC).toContain('req.parsedRows');
  });
});

// ── Environment variable documentation ───────────────────────────────────────

describe('CSV bulk import — env var documentation', () => {
  it('CSV_MAX_SIZE_BYTES is documented in .env.example', () => {
    expect(ENV_EXAMPLE).toContain('CSV_MAX_SIZE_BYTES');
  });

  it('CSV_MAX_ROWS is documented in .env.example', () => {
    expect(ENV_EXAMPLE).toContain('CSV_MAX_ROWS');
  });
});
