'use strict';

const axios = require('axios');
const crypto = require('crypto');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const WebhookRetry = require('../models/webhookRetryModel');
const { validateWebhookUrl } = require('../utils/validateWebhookUrl');

const WEBHOOK_TIMEOUT_MS = 10000; // 10 second timeout

// ── Replay protection ────────────────────────────────────────────────────────
const REPLAY_WINDOW_S = parseInt(process.env.WEBHOOK_REPLAY_WINDOW_S || '300', 10);

const _localNonces = new Map();

function _evictExpiredNonces() {
  const now = Date.now();
  for (const [id, exp] of _localNonces) {
    if (now > exp) _localNonces.delete(id);
  }
}

async function _isReplay(deliveryId) {
  const { getRedisClient, isRedisReady } = require('../config/redisClient');
  if (isRedisReady()) {
    const redis = getRedisClient();
    const key = `webhook:nonce:${deliveryId}`;
    const result = await redis.set(key, '1', 'EX', REPLAY_WINDOW_S, 'NX');
    return result === null;
  }
  _evictExpiredNonces();
  if (_localNonces.has(deliveryId)) return true;
  _localNonces.set(deliveryId, Date.now() + REPLAY_WINDOW_S * 1000);
  return false;
}

function _resetNonces() { _localNonces.clear(); }

// ── Backoff schedule — Issue #73 ─────────────────────────────────────────────
//
// Defaults: 1 m, 5 m, 15 m, 30 m, 1 h, 2 h, 4 h, 8 h
// Override the schedule with WEBHOOK_RETRY_DELAYS_MS (comma-separated ms values).
// Override the maximum attempts with WEBHOOK_MAX_ATTEMPTS.
//
// Full jitter is applied to every delay to spread thundering-herd retries:
//   jitteredDelay = random(0, baseDelay)   (full-jitter strategy)
// This keeps average latency at ½ × baseDelay while eliminating synchronized waves.

const _defaultDelays = [
  60_000,        // 1 min
  300_000,       // 5 min
  900_000,       // 15 min
  1_800_000,     // 30 min
  3_600_000,     // 1 hour
  7_200_000,     // 2 hours
  14_400_000,    // 4 hours
  28_800_000,    // 8 hours
];

function _parseDelays() {
  const raw = process.env.WEBHOOK_RETRY_DELAYS_MS;
  if (!raw) return _defaultDelays;
  const parsed = raw.split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
  return parsed.length > 0 ? parsed : _defaultDelays;
}

const BACKOFF_DELAYS = _parseDelays();

const DEFAULT_MAX_ATTEMPTS = parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '8', 10);

/**
 * Calculate exponential backoff delay with full jitter (Issue #73).
 *
 * Full jitter picks a random value in [0, baseDelay]. This avoids synchronised
 * retry waves when many deliveries fail in the same window ("thundering herd").
 *
 * @param {number} attemptNumber - 0-indexed attempt number
 * @returns {number} Jittered delay in milliseconds
 */
function getBackoffDelay(attemptNumber) {
  const base = BACKOFF_DELAYS[Math.min(attemptNumber, BACKOFF_DELAYS.length - 1)];
  // Full jitter: uniform random in [0, base]
  return Math.floor(Math.random() * (base + 1));
}

// ── Lease / stuck-recovery — Issue #74 ──────────────────────────────────────
//
// LEASE_TIMEOUT_MS: how long a 'processing' lease is considered valid. After
// this duration, processPendingRetries() will reset the document to 'pending'
// so another worker can pick it up. Must be comfortably larger than
// WEBHOOK_TIMEOUT_MS to avoid false recovery while the HTTP call is in flight.
const LEASE_TIMEOUT_MS = parseInt(
  process.env.WEBHOOK_LEASE_TIMEOUT_MS || String(WEBHOOK_TIMEOUT_MS * 3),
  10,
);

// Stable worker identifier used as leasedBy. Survives across retry ticks
// within the same process; helps ops trace which replica held a lease.
const WORKER_ID = `${os.hostname()}:${process.pid}`;

// ── Signing secret resolution — Issue #75 ────────────────────────────────────
//
// Secrets are no longer stored on the WebhookRetry document. Instead, the
// service looks up the school's (encrypted) webhookSecret from the School
// collection at send time using the schoolId stored on the retry document.
// This ensures a DB read (or backup leak) of the retry queue does not expose
// signing secrets.

/**
 * Resolve the HMAC signing secret for a webhook delivery.
 *
 * If a schoolId is provided, the secret is fetched from the School document.
 * Falls back to the provided `fallbackSecret` argument (used for first-attempt
 * deliveries where the secret is passed in directly but not persisted).
 *
 * @param {string|null} schoolId
 * @param {string|null} fallbackSecret - Only used when no schoolId is known
 * @returns {Promise<string|null>}
 */
async function _resolveSecret(schoolId, fallbackSecret = null) {
  if (!schoolId) return fallbackSecret;
  try {
    const School = require('../models/schoolModel');
    const { decryptWebhookSecret } = require('./webhookSecretEncryption');
    const school = await School.findOne({ schoolId }).select('+webhookSecret').lean();
    if (!school || !school.webhookSecret) return null;
    return decryptWebhookSecret(school.webhookSecret);
  } catch (err) {
    const logger = require('../utils/logger').child('WebhookService');
    logger.warn('Failed to resolve webhook secret from school', { schoolId, error: err.message });
    return null;
  }
}

const logger = require('../utils/logger').child('WebhookService');

/**
 * Generate HMAC-SHA256 signature for a webhook payload.
 */
function generateSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

/**
 * Verify an incoming webhook signature using constant-time comparison.
 */
function verifySignature(payload, providedSignature, secret) {
  const expectedSignature = generateSignature(payload, secret);
  const expectedBuf = Buffer.from(expectedSignature, 'hex');
  const actualBuf = Buffer.from(providedSignature, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Fire a webhook to an external system when a payment event occurs.
 *
 * @param {string} url
 * @param {string} event
 * @param {object} payload
 * @param {string|null} [secret] - Only used for the first-attempt signature; NOT persisted
 * @param {string|null} [deliveryId]
 * @param {string|null} [schoolId] - Required for retry secret resolution (Issue #75)
 */
async function fireWebhook(url, event, payload, secret = null, deliveryId = null, schoolId = null) {
  const correlationId = payload?.correlationId || null;

  if (!url) return { success: false, error: 'No webhook URL configured', deliveryId: null };

  const urlValidation = await validateWebhookUrl(url);
  if (!urlValidation.valid) {
    logger.error('Webhook delivery blocked: URL failed SSRF validation', { url, correlationId, reason: urlValidation.reason });
    return { success: false, error: 'Invalid or disallowed webhook URL', deliveryId: null };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const id = deliveryId || uuidv4();

  if (await _isReplay(id)) {
    logger.warn('Webhook replay detected — delivery already processed', { deliveryId: id, event, url, correlationId });
    return { success: false, error: 'Replay detected: delivery already processed', deliveryId: id };
  }

  const body = {
    event,
    timestamp: new Date().toISOString(),
    data: payload,
  };

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'StellarEduPay-Webhook/1.0',
    'X-Webhook-Event': event,
    'X-StellarEduPay-Timestamp': timestamp.toString(),
    'X-StellarEduPay-Delivery-ID': id,
  };

  if (correlationId) {
    headers['X-StellarEduPay-Correlation-Id'] = correlationId;
  }

  if (secret) {
    headers['X-StellarEduPay-Signature'] = `sha256=${generateSignature(body, secret)}`;
  }

  const startTime = Date.now();
  try {
    const response = await axios.post(url, body, {
      timeout: WEBHOOK_TIMEOUT_MS,
      headers,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    const duration = Date.now() - startTime;
    logger.info(`Webhook fired successfully`, {
      url, event, deliveryId: id, correlationId,
      statusCode: response.status, durationMs: duration,
    });

    return { success: true, statusCode: response.status, deliveryId: id };
  } catch (err) {
    const duration = Date.now() - startTime;
    const errorMessage = err.response
      ? `HTTP ${err.response.status}: ${err.response.statusText}`
      : err.code === 'ECONNABORTED'
        ? 'Connection timeout'
        : err.message;

    logger.error(`Webhook failed, queuing for retry`, {
      url, event, deliveryId: id, correlationId, error: errorMessage, durationMs: duration,
    });

    try {
      // schoolId is passed through so retries can resolve the secret at send
      // time from the School document rather than storing it (Issue #75).
      await queueWebhookRetry(url, event, payload, errorMessage, schoolId, id);
      return { success: false, error: errorMessage, queued: true, deliveryId: id };
    } catch (queueErr) {
      logger.error(`Failed to queue webhook retry`, { url, event, correlationId, error: queueErr.message });
      return { success: false, error: errorMessage, queued: false, deliveryId: id };
    }
  }
}

/**
 * Queue a failed webhook for retry.
 *
 * The secret is NOT stored on the retry document (Issue #75).
 * Instead, schoolId is persisted so the secret can be resolved from the
 * School model at send time.
 *
 * @param {string} url
 * @param {string} event
 * @param {object} payload
 * @param {string} error
 * @param {string|null} [schoolId] - Used to resolve secret at retry time
 * @param {string|null} [deliveryId]
 */
async function queueWebhookRetry(url, event, payload, error, schoolId = null, deliveryId = null) {
  const nextRetryAt = new Date(Date.now() + getBackoffDelay(0));
  const id = deliveryId || uuidv4();

  await WebhookRetry.create({
    url,
    event,
    payload,
    schoolId: schoolId || null,
    // NOTE: 'secret' field intentionally omitted (Issue #75).
    //       The signing secret is resolved from the School document at send time.
    deliveryId: id,
    correlationId: payload?.correlationId || null,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    nextRetryAt,
    lastError: error,
    errorLog: [{ attemptNumber: 0, error, timestamp: new Date() }],
  });
}

/**
 * Recover stuck processing leases — Issue #74.
 *
 * Finds 'processing' documents whose leasedAt is older than LEASE_TIMEOUT_MS
 * and resets them to 'pending' so another worker can pick them up.
 *
 * This runs at the start of each processPendingRetries() tick. Because the
 * recovery itself uses findOneAndUpdate with a filter on { status:'processing',
 * leasedAt:{$lt:cutoff} }, multiple replicas running this concurrently is safe
 * — only one will claim each stuck document.
 */
async function recoverStuckLeases() {
  const cutoff = new Date(Date.now() - LEASE_TIMEOUT_MS);
  let recovered = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const doc = await WebhookRetry.findOneAndUpdate(
      { status: 'processing', leasedAt: { $lt: cutoff } },
      {
        $set: {
          status: 'pending',
          leasedAt: null,
          leasedBy: null,
          // nextRetryAt stays as-is — the retry was already due
        },
      },
      { new: true }
    );
    if (!doc) break;
    logger.warn('Recovered stuck webhook lease', {
      deliveryId: doc.deliveryId,
      url: doc.url,
      leasedBy: doc.leasedBy,
      leasedAt: doc.leasedAt,
    });
    recovered++;
  }

  return recovered;
}

/**
 * Process pending webhook retries — Issue #74 (atomic claiming).
 *
 * Each pending retry is claimed atomically with findOneAndUpdate before
 * sending. Only the process that claims a document (flips status to
 * 'processing') delivers it. Multiple replicas running concurrently will
 * never deliver the same retry.
 *
 * Stuck 'processing' leases (worker crashed mid-delivery) are recovered
 * before picking up new work.
 */
async function processPendingRetries() {
  try {
    // 1. Recover any stuck leases from crashed workers.
    const stuckRecovered = await recoverStuckLeases();
    if (stuckRecovered > 0) {
      logger.info('WEBHOOK_RETRY_STUCK_RECOVERED', { count: stuckRecovered });
    }

    // 2. Atomically claim and process up to 10 pending retries.
    const now = new Date();
    let processed = 0;

    for (let i = 0; i < 10; i++) {
      // Atomic claim: flip one pending+due document to 'processing'.
      // Only the winner of this findOneAndUpdate delivers the webhook.
      const claimed = await WebhookRetry.findOneAndUpdate(
        {
          status: 'pending',
          nextRetryAt: { $lte: now },
        },
        {
          $set: {
            status: 'processing',
            leasedAt: new Date(),
            leasedBy: WORKER_ID,
          },
        },
        {
          new: true,
          sort: { nextRetryAt: 1 }, // process oldest-due first
        }
      );

      if (!claimed) break; // no more pending retries

      await retryWebhook(claimed);
      processed++;
    }

    return { processed };
  } catch (err) {
    logger.error(`Error processing webhook retries`, { error: err.message });
    throw err;
  }
}

/**
 * Retry a single failed webhook — atomically claimed by the caller.
 *
 * The signing secret is resolved from the School document at send time
 * rather than read from the retry document (Issue #75).
 *
 * @param {object} retry - WebhookRetry document (must be in 'processing' state)
 */
async function retryWebhook(retry) {
  const correlationId = retry.correlationId || retry.payload?.correlationId || null;

  const urlValidation = await validateWebhookUrl(retry.url);
  if (!urlValidation.valid) {
    logger.error('Webhook retry blocked: URL failed SSRF validation', {
      url: retry.url, correlationId, reason: urlValidation.reason,
    });
    await WebhookRetry.updateOne(
      { _id: retry._id },
      { $set: { status: 'failed', lastError: 'Invalid or disallowed webhook URL', lastAttemptAt: new Date(), leasedAt: null, leasedBy: null } }
    );
    return;
  }

  const startTime = Date.now();
  const attemptNumber = retry.attemptCount + 1;
  const timestamp = Math.floor(Date.now() / 1000);

  // Resolve signing secret from School document (Issue #75).
  const secret = await _resolveSecret(retry.schoolId, null);

  const body = {
    event: retry.event,
    timestamp: new Date().toISOString(),
    data: retry.payload,
  };

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'StellarEduPay-Webhook/1.0',
    'X-Webhook-Event': retry.event,
    'X-StellarEduPay-Timestamp': timestamp.toString(),
    'X-StellarEduPay-Delivery-ID': retry.deliveryId,
  };

  if (correlationId) {
    headers['X-StellarEduPay-Correlation-Id'] = correlationId;
  }

  if (secret) {
    headers['X-StellarEduPay-Signature'] = `sha256=${generateSignature(body, secret)}`;
  }

  try {
    const response = await axios.post(retry.url, body, {
      timeout: WEBHOOK_TIMEOUT_MS,
      headers,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    const duration = Date.now() - startTime;
    logger.info(`Webhook retry succeeded`, {
      url: retry.url, event: retry.event, deliveryId: retry.deliveryId,
      correlationId, attemptNumber, statusCode: response.status, durationMs: duration,
    });

    await WebhookRetry.updateOne(
      { _id: retry._id },
      {
        $set: {
          status: 'succeeded',
          succeededAt: new Date(),
          lastAttemptAt: new Date(),
          leasedAt: null,
          leasedBy: null,
        },
      }
    );
  } catch (err) {
    const duration = Date.now() - startTime;
    const errorMessage = err.response
      ? `HTTP ${err.response.status}: ${err.response.statusText}`
      : err.code === 'ECONNABORTED'
        ? 'Connection timeout'
        : err.message;

    logger.warn(`Webhook retry failed`, {
      url: retry.url, event: retry.event, deliveryId: retry.deliveryId,
      correlationId, attemptNumber, error: errorMessage, durationMs: duration,
    });

    if (attemptNumber < retry.maxAttempts) {
      // Jittered backoff (Issue #73): random delay in [0, baseDelay]
      const nextRetryAt = new Date(Date.now() + getBackoffDelay(attemptNumber));
      await WebhookRetry.updateOne(
        { _id: retry._id },
        {
          $set: {
            status: 'pending', // release the lease → back to the queue
            attemptCount: attemptNumber,
            nextRetryAt,
            lastError: errorMessage,
            lastAttemptAt: new Date(),
            leasedAt: null,
            leasedBy: null,
          },
          $push: {
            errorLog: { attemptNumber, error: errorMessage, timestamp: new Date() },
          },
        }
      );
    } else {
      logger.error(`Webhook retry exhausted after ${retry.maxAttempts} attempts`, {
        url: retry.url, event: retry.event, deliveryId: retry.deliveryId,
        correlationId, payload: retry.payload, lastError: errorMessage,
      });

      await WebhookRetry.updateOne(
        { _id: retry._id },
        {
          $set: {
            status: 'failed',
            attemptCount: attemptNumber,
            lastError: errorMessage,
            lastAttemptAt: new Date(),
            leasedAt: null,
            leasedBy: null,
          },
          $push: {
            errorLog: { attemptNumber, error: errorMessage, timestamp: new Date() },
          },
        }
      );
    }
  }
}

// ── Notification helpers ─────────────────────────────────────────────────────

async function notifyPaymentConfirmed(webhookUrl, payment, student, secret = null, schoolId = null) {
  return fireWebhook(webhookUrl, 'payment.confirmed', {
    transactionHash: payment.transactionHash || payment.txHash,
    correlationId: payment.correlationId,
    studentId: payment.studentId,
    amount: payment.amount,
    assetCode: payment.assetCode || 'XLM',
    finalFee: payment.finalFee,
    feeValidationStatus: payment.feeValidationStatus,
    confirmedAt: payment.confirmedAt,
    referenceCode: payment.referenceCode,
    schoolId: payment.schoolId,
    senderAddress: payment.senderAddress,
  }, secret, null, schoolId || payment.schoolId);
}

async function notifyPaymentPending(webhookUrl, payment, secret = null, schoolId = null) {
  return fireWebhook(webhookUrl, 'payment.pending', {
    transactionHash: payment.transactionHash || payment.txHash,
    correlationId: payment.correlationId,
    studentId: payment.studentId,
    amount: payment.amount,
    assetCode: payment.assetCode || 'XLM',
    ledgerSequence: payment.ledgerSequence,
    status: 'pending_confirmation',
  }, secret, null, schoolId || payment.schoolId);
}

async function notifyPaymentFailed(webhookUrl, payment, reason, secret = null, schoolId = null) {
  return fireWebhook(webhookUrl, 'payment.failed', {
    transactionHash: payment.transactionHash || payment.txHash,
    correlationId: payment.correlationId,
    studentId: payment.studentId,
    amount: payment.amount || 0,
    reason,
    status: 'FAILED',
  }, secret, null, schoolId || payment.schoolId);
}

async function notifyPaymentRefunded(webhookUrl, refundEvent, student, secret = null, schoolId = null) {
  return fireWebhook(webhookUrl, 'payment.refunded', {
    originalTxHash: refundEvent.originalTxHash,
    refundTxHash: refundEvent.refundTxHash || null,
    studentId: refundEvent.studentId,
    amount: refundEvent.amount,
    reason: refundEvent.reason,
    status: refundEvent.newStatus,
    refundedAt: new Date().toISOString(),
  }, secret, null, schoolId || refundEvent.schoolId);
}

async function notifyPaymentSuspicious(webhookUrl, payment, reason, secret = null, schoolId = null) {
  return fireWebhook(webhookUrl, 'payment.suspicious', {
    transactionHash: payment.transactionHash || payment.txHash,
    correlationId: payment.correlationId,
    studentId: payment.studentId,
    amount: payment.amount,
    reason,
    isSuspicious: true,
    status: payment.status,
  }, secret, null, schoolId || payment.schoolId);
}

function sendPaymentWebhook(url, data, secret = null, schoolId = null) {
  return fireWebhook(url, 'payment.confirmed', data, secret, null, schoolId);
}

module.exports = {
  fireWebhook,
  sendPaymentWebhook,
  notifyPaymentConfirmed,
  notifyPaymentPending,
  notifyPaymentFailed,
  notifyPaymentRefunded,
  notifyPaymentSuspicious,
  generateSignature,
  verifySignature,
  queueWebhookRetry,
  processPendingRetries,
  retryWebhook,
  recoverStuckLeases,
  getBackoffDelay,
  BACKOFF_DELAYS,
  DEFAULT_MAX_ATTEMPTS,
  LEASE_TIMEOUT_MS,
  // Testing internals
  _resetNonces,
  _resolveSecret,
};
