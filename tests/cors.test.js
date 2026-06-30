'use strict';

/**
 * Tests for Issue #824 — CORS credentials + origin allowlist audit.
 *
 * parseAllowedOrigins() must:
 *  - Reject wildcard (*) unconditionally (credentials:true makes it unsafe)
 *  - Reject an empty/blank origin list
 *  - Accept a single valid origin
 *  - Accept a comma-separated list of valid origins
 *  - Trim whitespace around each entry
 *  - Reject invalid URLs
 */

const { parseAllowedOrigins } = require('../backend/src/utils/corsOrigins');

function parse(envOverrides = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let result, error;
  try {
    result = parseAllowedOrigins();
  } catch (e) {
    error = e;
  }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (error) throw error;
  return result;
}

describe('Issue #824 — CORS origin allowlist', () => {
  // ── Wildcard rejection (credentials:true makes * unsafe) ─────────────────

  test('wildcard (*) is rejected in development', () => {
    expect(() =>
      parse({ NODE_ENV: 'development', ALLOWED_ORIGIN: '*' })
    ).toThrow(/wildcard.*not permitted/i);
  });

  test('wildcard (*) is rejected in production', () => {
    expect(() =>
      parse({ NODE_ENV: 'production', ALLOWED_ORIGIN: '*' })
    ).toThrow(/wildcard.*not permitted/i);
  });

  // ── Empty / blank origin list ─────────────────────────────────────────────

  test('empty ALLOWED_ORIGIN string throws a descriptive error', () => {
    expect(() =>
      parse({ ALLOWED_ORIGIN: '   ' })
    ).toThrow(/at least one valid origin/i);
  });

  // ── Valid configurations ──────────────────────────────────────────────────

  test('single valid origin returns the origin string', () => {
    expect(parse({ ALLOWED_ORIGIN: 'https://app.school.com' }))
      .toBe('https://app.school.com');
  });

  test('comma-separated valid origins return an array', () => {
    expect(
      parse({ ALLOWED_ORIGIN: 'https://app.school.com,https://admin.school.com' })
    ).toEqual(['https://app.school.com', 'https://admin.school.com']);
  });

  test('whitespace around origins is trimmed', () => {
    expect(
      parse({ ALLOWED_ORIGIN: '  https://app.school.com  ,  https://admin.school.com  ' })
    ).toEqual(['https://app.school.com', 'https://admin.school.com']);
  });

  test('missing ALLOWED_ORIGIN falls back to http://localhost:3000', () => {
    expect(parse({ ALLOWED_ORIGIN: undefined })).toBe('http://localhost:3000');
  });

  // ── Invalid URL rejection ─────────────────────────────────────────────────

  test('invalid URL throws a descriptive error', () => {
    expect(() =>
      parse({ ALLOWED_ORIGIN: 'not-a-url' })
    ).toThrow(/invalid URL/i);
  });

  test('one invalid URL in a comma-separated list throws', () => {
    expect(() =>
      parse({ ALLOWED_ORIGIN: 'https://app.school.com,bad-url' })
    ).toThrow(/invalid URL/i);
  });
});
