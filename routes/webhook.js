/**
 * Webhook Route — Easebuzz Event Handler
 * ----------------------------------------
 * Receives and processes all three Easebuzz webhook event types:
 *   1. MANDATE_STATUS_UPDATE  — mandate authorized/failed
 *   2. NOTIFICATION_STATUS_UPDATE — pre-debit notification delivered
 *   3. PRESENTMENT_STATUS_UPDATE — debit success/failure
 *
 * Security:
 *   - Mandatory hash verification before processing any event
 *   - Idempotency check prevents duplicate webhook processing
 *   - Returns 200 OK quickly to prevent Easebuzz retries
 */

const express = require('express');
const router = express.Router();
const {
  verifyMandateWebhookHash,
  verifyPresentmentWebhookHash,
} = require('../utils/encryption');
const {
  updateSubscriptionStatus,
  incrementDebitCount,
  isWebhookProcessed,
  markWebhookProcessed,
  recordDebit,
  updateDebitStatus,
  getSubscriptionByTxnId,
} = require('../db/database');
const { createShopifyOrder } = require('../utils/shopify-api');

/**
 * Resolves the correct merchant key and salt based on environment.
 */
function getCredentials() {
  const isProduction = process.env.EASEBUZZ_ENV === 'production';
  return {
    key: isProduction ? process.env.EASEBUZZ_PROD_KEY : process.env.EASEBUZZ_TEST_KEY,
    salt: isProduction ? process.env.EASEBUZZ_PROD_SALT : process.env.EASEBUZZ_TEST_SALT,
  };
}

/**
 * POST /api/webhook/easebuzz
 * ───────────────────────────
 * Single endpoint for all Easebuzz auto-debit webhook events.
 */
router.post('/easebuzz', (req, res) => {
  try {
    const { event, data } = req.body;

    if (!event || !data) {
      console.warn('[Webhook] Received malformed payload — missing event or data');
      return res.status(400).json({ error: 'Invalid payload' });
    }

    console.log(`[Webhook] Received event: ${event}`, {
      transaction_id: data.transaction_id || data.mandate?.transaction_id || 'N/A',
      status: data.status || 'N/A',
    });

    const { key, salt } = getCredentials();

    // ── Route to the appropriate handler ──
    switch (event) {
      case 'MANDATE_STATUS_UPDATE':
        return handleMandateUpdate(data, key, salt, res);

      case 'NOTIFICATION_STATUS_UPDATE':
        return handleNotificationUpdate(data, res);

      case 'PRESENTMENT_STATUS_UPDATE':
        return handlePresentmentUpdate(data, key, salt, res);

      default:
        console.warn(`[Webhook] Unknown event type: ${event}`);
        // Still return 200 to prevent retries for unknown events
        return res.status(200).json({ received: true, message: 'Unknown event type' });
    }
  } catch (error) {
    console.error('[Webhook] Processing error:', error);
    // Return 200 even on error to prevent infinite retry loops
    // The error is logged for manual investigation
    return res.status(200).json({ received: true, error: 'Processing error logged' });
  }
});

/**
 * Handles MANDATE_STATUS_UPDATE webhooks.
 * Fired when a customer authorizes or rejects a UPI mandate.
 */
function handleMandateUpdate(data, merchantKey, merchantSalt, res) {
  const txnId = data.transaction_id;
  const eventId = data.id || data.umrn || '';

  // ── Idempotency check ──
  if (isWebhookProcessed('MANDATE_STATUS_UPDATE', eventId, txnId)) {
    console.log(`[Webhook] Mandate update already processed: ${txnId}`);
    return res.status(200).json({ received: true, duplicate: true });
  }

  // ── Hash verification (MANDATORY per Easebuzz docs) ──
  if (!verifyMandateWebhookHash(data, merchantKey, merchantSalt)) {
    console.error(`[Webhook] MANDATE hash verification FAILED for txn: ${txnId}`);
    return res.status(401).json({ error: 'Hash verification failed' });
  }

  // ── Process mandate status ──
  const status = data.status; // 'authorized', 'failed', 'revoked', etc.

  updateSubscriptionStatus(txnId, status, {
    mandateId: data.id || null,
    umrn: data.umrn || null,
    upiHandle: data.customer_upi_handle || null,
  });

  // Mark as processed
  markWebhookProcessed('MANDATE_STATUS_UPDATE', eventId, txnId, data);

  console.log(`[Webhook] Mandate ${txnId} → status: ${status}`);

  return res.status(200).json({ received: true, status });
}

/**
 * Handles NOTIFICATION_STATUS_UPDATE webhooks.
 * Fired when a pre-debit notification is successfully delivered to the customer.
 * No hash verification is needed for notification events per Easebuzz docs.
 */
function handleNotificationUpdate(data, res) {
  const txnId = data.mandate?.transaction_id || '';
  const eventId = data.id || '';

  // ── Idempotency check ──
  if (isWebhookProcessed('NOTIFICATION_STATUS_UPDATE', eventId, txnId)) {
    console.log(`[Webhook] Notification update already processed: ${eventId}`);
    return res.status(200).json({ received: true, duplicate: true });
  }

  const status = data.status; // 'notified', 'failed', etc.

  console.log(`[Webhook] Notification ${eventId} for mandate ${txnId} → ${status}`);

  // Mark as processed
  markWebhookProcessed('NOTIFICATION_STATUS_UPDATE', eventId, txnId, data);

  return res.status(200).json({ received: true, status });
}

/**
 * Handles PRESENTMENT_STATUS_UPDATE webhooks.
 * Fired when a recurring debit succeeds or fails.
 * Only triggered for 'success' or 'failure' — not for 'in_process'.
 */
function handlePresentmentUpdate(data, merchantKey, merchantSalt, res) {
  const txnId = data.mandate?.transaction_id || data.transaction_id || '';
  const eventId = data.id || data.merchant_request_number || '';

  // ── Idempotency check ──
  if (isWebhookProcessed('PRESENTMENT_STATUS_UPDATE', eventId, txnId)) {
    console.log(`[Webhook] Presentment update already processed: ${eventId}`);
    return res.status(200).json({ received: true, duplicate: true });
  }

  // ── Hash verification ──
  if (!verifyPresentmentWebhookHash(data, merchantKey, merchantSalt)) {
    console.error(`[Webhook] PRESENTMENT hash verification FAILED for: ${eventId}`);
    return res.status(401).json({ error: 'Hash verification failed' });
  }

  const status = data.status; // 'success' or 'failure'

  // Record the debit in history
  recordDebit({
    transactionId: txnId,
    merchantRequestNumber: data.merchant_request_number || '',
    amount: data.amount || 0,
    status: status,
    bankReferenceNumber: data.bank_reference_number || null,
    pgTransactionId: data.pg_transaction_id || null,
  });

  // Update subscription based on debit result
  if (status === 'success') {
    incrementDebitCount(txnId);

    // Calculate next debit date based on frequency (simplified)
    const nextDebit = calculateNextDebitDate(new Date());
    updateSubscriptionStatus(txnId, 'active', {
      lastDebitDate: new Date().toISOString().split('T')[0],
      nextDebitDate: nextDebit,
    });

    console.log(`[Webhook] Debit SUCCESS for ${txnId}: ₹${data.amount}`);

    // ── Auto-create Shopify Order (async, non-blocking) ──
    const subscription = getSubscriptionByTxnId(txnId);
    if (subscription) {
      createShopifyOrder({
        customerName: subscription.customer_name,
        customerEmail: subscription.customer_email,
        customerPhone: subscription.customer_phone,
        productTitle: subscription.product_title,
        variantId: subscription.product_variant_id,
        amount: data.amount || subscription.amount,
        transactionId: txnId,
        frequency: subscription.frequency,
      })
      .then(result => {
        if (result.success) {
          console.log(`[Webhook] Shopify order created: #${result.orderNumber} for ${txnId}`);
        } else {
          console.error(`[Webhook] Shopify order FAILED for ${txnId}:`, result.error);
        }
      })
      .catch(err => {
        console.error(`[Webhook] Shopify order error for ${txnId}:`, err.message);
      });
    } else {
      console.warn(`[Webhook] No subscription record found for ${txnId}, skipping Shopify order`);
    }
  } else {
    // Failed debit — Easebuzz will auto-retry up to 3 times per NPCI guidelines
    console.warn(`[Webhook] Debit FAILED for ${txnId}: ₹${data.amount}`);
  }

  // Mark as processed
  markWebhookProcessed('PRESENTMENT_STATUS_UPDATE', eventId, txnId, data);

  return res.status(200).json({ received: true, status });
}

/**
 * Simple next-debit-date calculator.
 * Adds 30 days for monthly subscriptions (default).
 * In production, this should respect the actual mandate frequency.
 */
function calculateNextDebitDate(fromDate) {
  const next = new Date(fromDate);
  next.setDate(next.getDate() + 30); // Default: monthly
  return next.toISOString().split('T')[0];
}

module.exports = router;
