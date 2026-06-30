'use strict';

/**
 * Tests for Issue #826 — JSON depth/array-bomb guard and query-param de-pollution.
 *
 * Acceptance criteria:
 *  - Deeply-nested JSON is rejected with 400.
 *  - Over-wide arrays are rejected with 400.
 *  - Valid payloads pass through.
 *  - Duplicate scalar query params are collapsed to the last value.
 */

const { jsonDepthGuard, deduplicateQueryParams } = require('../backend/src/middleware/sanitizeRequest');

// ── Helpers to call middleware directly ───────────────────────────────────────

function makeReqRes(body, query = {}) {
  const req = { body, path: '/test', query };
  const res = {
    _status: null, _body: null,
    status(code) { this._status = code; return this; },
    json(obj)    { this._body  = obj;   return this; },
  };
  return { req, res };
}

describe('Issue #826 — jsonDepthGuard', () => {
  test('accepts a shallow object', () => {
    const { req, res } = makeReqRes({ a: 1, b: 'two' });
    const next = jest.fn();
    jsonDepthGuard(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res._status).toBeNull();
  });

  test('accepts a nested object within limits', () => {
    const body = { a: { b: { c: { d: { e: 1 } } } } };
    const { req, res } = makeReqRes(body);
    const next = jest.fn();
    jsonDepthGuard(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('rejects an over-deep object with 400', () => {
    // Build a 12-level deep object (default MAX_DEPTH=10)
    let deep = { v: 1 };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    const { req, res } = makeReqRes(deep);
    const next = jest.fn();
    jsonDepthGuard(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    expect(res._body.code).toBe('PAYLOAD_TOO_COMPLEX');
  });

  test('rejects an array with more than MAX_ARRAY_LENGTH items with 400', () => {
    const body = { items: new Array(200).fill(1) }; // default MAX_ARRAY_LENGTH=100
    const { req, res } = makeReqRes(body);
    const next = jest.fn();
    jsonDepthGuard(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
  });

  test('skips check when body is null/undefined', () => {
    const { req, res } = makeReqRes(null);
    const next = jest.fn();
    jsonDepthGuard(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('Issue #826 — deduplicateQueryParams', () => {
  test('passes through non-duplicate params unchanged', () => {
    const { req, res } = makeReqRes({}, { status: 'paid', page: '1' });
    const next = jest.fn();
    deduplicateQueryParams(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.query.status).toBe('paid');
    expect(req.query.page).toBe('1');
  });

  test('collapses duplicated scalar param to last value', () => {
    const { req, res } = makeReqRes({}, { status: ['paid', 'pending'] });
    const next = jest.fn();
    deduplicateQueryParams(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.query.status).toBe('pending');
  });

  test('handles empty query object', () => {
    const { req, res } = makeReqRes({}, {});
    const next = jest.fn();
    deduplicateQueryParams(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
