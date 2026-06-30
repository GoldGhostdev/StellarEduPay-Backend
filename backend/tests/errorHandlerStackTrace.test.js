'use strict';

jest.mock('../src/utils/logger', () => ({
  child: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}));

const { globalErrorHandler } = require('../src/middleware/errorHandler');

function makeReq() {
  return { path: '/test', method: 'GET', requestId: 'req-1', schoolId: null };
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { status, _json: json };
}

function captureBody(res) {
  return res.status.mock.results[0].value.json.mock.calls[0][0];
}

describe('globalErrorHandler — stack trace exposure', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test('does not include stack in response when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('something broke');
    err.stack = 'Error: something broke\n    at /app/src/server.js:10:5';

    const res = makeRes();
    globalErrorHandler(err, makeReq(), res, jest.fn());

    const body = captureBody(res);
    expect(body).not.toHaveProperty('stack');
    expect(body.error).not.toHaveProperty('stack');
  });

  test('does not include stack in response when NODE_ENV is staging', () => {
    process.env.NODE_ENV = 'staging';
    const err = new Error('something broke');
    err.stack = 'Error: something broke\n    at /app/src/server.js:10:5';

    const res = makeRes();
    globalErrorHandler(err, makeReq(), res, jest.fn());

    const body = captureBody(res);
    expect(body).not.toHaveProperty('stack');
    expect(body.error).not.toHaveProperty('stack');
  });

  test('does not include stack when NODE_ENV is not set', () => {
    delete process.env.NODE_ENV;
    const err = new Error('something broke');
    err.stack = 'Error: something broke\n    at /app/src/server.js:10:5';

    const res = makeRes();
    globalErrorHandler(err, makeReq(), res, jest.fn());

    const body = captureBody(res);
    expect(body).not.toHaveProperty('stack');
    expect(body.error).not.toHaveProperty('stack');
  });

  test('includes stack in response when NODE_ENV is development', () => {
    process.env.NODE_ENV = 'development';
    const err = new Error('something broke');
    err.stack = 'Error: something broke\n    at /app/src/server.js:10:5';

    const res = makeRes();
    globalErrorHandler(err, makeReq(), res, jest.fn());

    const body = captureBody(res);
    expect(body.error.stack).toBe(err.stack);
  });

  test('masks internal 5xx error message in production', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('DB connection string: mongodb://admin:secret@host/db');

    const res = makeRes();
    globalErrorHandler(err, makeReq(), res, jest.fn());

    const body = captureBody(res);
    expect(body.error.message).toBe('An internal server error occurred.');
    expect(body.error.message).not.toContain('mongodb://');
  });

  test('preserves 4xx error message in production (client errors are safe to echo)', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('Validation failed: amount must be positive');
    err.code = 'VALIDATION_ERROR'; // maps to 400

    const res = makeRes();
    globalErrorHandler(err, makeReq(), res, jest.fn());

    const body = captureBody(res);
    expect(body.error.message).toBe('Validation failed: amount must be positive');
  });
});
