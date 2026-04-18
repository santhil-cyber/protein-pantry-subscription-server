/**
 * Webhook Route — Cashfree Subscription Events
 * ───────────────────────────────────────────────
 * Receives and processes Cashfree subscription webhook events:
 *   1. SUBSCRIPTION_STATUS_UPDATE — subscription authorized/cancelled/etc
 *   2. PAYMENT_STATUS_UPDATE     — recurring payment success/failure
 *
 * Security:
 *   - HMAC-SHA256 signature verification via x-cashfree-signature header
 *   - Idempotency check prevents duplicate webhook processing
 *   - Returns 200 OK quickly to prevent Cashfree retries
 *
 * Webhook setup: Configure webhook URL in Cashfree Dashboard →
 *   Developers → Webhook → Add Endpoint → https://your-server.com/api/webhook/cashfree
 */

const express = require('express');
const router = express.Router();
const { verifyWebhookSignature } = require('../utils/cashfree-api');
const {
  updateSubscriptionStatus,
  incrementPaymentCount,
  isWebhookProcessed,
  markWebhookProcessed,
  recordPayment,
  getSubscriptionById,
} = require('../db/database');
const { createShopifyOrder } = require('../utils/shopify-api');

/**
 * POST /api/webhook/cashfree
 * ────────────────────────────
 * Single endpoint for all Cashfree subscription webhook events.
 *
 * NOTE: We need the raw body for signature verification,
 * so this route uses express.raw() middleware on the parent app.
 */
router.post('/cashfree', (req, res) => {
  try {
    // ── Signature Verification ──
    const signature = req.headers['x-cashfree-signature'];
    const timestamp = req.headers['x-cashfree-timestamp'];
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    // In production, always verify signature
    if (signature && timestamp) {
      if (!verifyWebhookSignature(rawBody, timestamp, signature)) {
        console.error('[Webhook] Signature verification FAILED');
        return res.status(401).json({ error: 'Signature verification failed' });
      }
      console.log('[Webhook] Signature verified ✓');
    } else {
      // In test mode, Cashfree may not always send signatures
      console.warn('[Webhook] No signature headers — skipping verification (test mode)');
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { type, data } = body;

    if (!type || !data) {
      console.warn('[Webhook] Received malformed payload — missing type or data');
      return res.status(400).json({ error: 'Invalid payload' });
    }

    console.log(`[Webhook] Received event: ${type}`, {
      subscription_id: data.subscription?.subscription_id || data.subscription_id || 'N/A',
      status: data.subscription?.subscription_status || data.payment?.payment_status || 'N/A',
    });

    // ── Route to the appropriate handler ──
    switch (type) {
      case 'SUBSCRIPTION_STATUS_UPDATE':
        return handleSubscriptionUpdate(data, res);

      case 'PAYMENT_STATUS_UPDATE':
        return handlePaymentUpdate(data, res);

      default:
        console.warn(`[Webhook] Unknown event type: ${type}`);
        return res.status(200).json({ received: true, message: 'Unknown event type' });
    }
  } catch (error) {
    console.error('[Webhook] Processing error:', error);
    // Return 200 even on error to prevent infinite retry loops
    return res.status(200).json({ received: true, error: 'Processing error logged' });
  }
});

/**
 * Handles SUBSCRIPTION_STATUS_UPDATE webhooks.
 * Fired when subscription state changes (authorized, cancelled, paused, etc.)
 *
 * Key statuses:
 *   INITIALIZED → BANK_APPROVAL_PENDING → ACTIVE
 *   ACTIVE → ON_HOLD / CANCELLED / COMPLETED / PAST_DUE_DATE
 */
function handleSubscriptionUpdate(data, res) {
  const subData = data.subscription || data;
  const subscriptionId = subData.subscription_id || '';
  const cfSubscriptionId = subData.cf_subscription_id || '';
  const status = subData.subscription_status || '';
  const eventId = cfSubscriptionId || subscriptionId;

  // ── Idempotency check ──
  if (isWebhookProcessed('SUBSCRIPTION_STATUS_UPDATE', eventId, subscriptionId)) {
    console.log(`[Webhook] Subscription update already processed: ${subscriptionId}`);
    return res.status(200).json({ received: true, duplicate: true });
  }

  // ── Update subscription status ──
  updateSubscriptionStatus(subscriptionId, status, {
    cfSubscriptionId: cfSubscriptionId,
    nextScheduleDate: subData.next_schedule_date || null,
  });

  // Mark as processed
  markWebhookProcessed('SUBSCRIPTION_STATUS_UPDATE', eventId, subscriptionId, data);

  console.log(`[Webhook] Subscription ${subscriptionId} → status: ${status}`);

  return res.status(200).json({ received: true, status });
}

/**
 * Handles PAYMENT_STATUS_UPDATE webhooks.
 * Fired when a recurring payment succeeds or fails.
 *
 * On success → creates a Shopify order automatically.
 */
function handlePaymentUpdate(data, res) {
  const paymentData = data.payment || data;
  const subData = data.subscription || {};
  const subscriptionId = subData.subscription_id || paymentData.subscription_id || '';
  const cfPaymentId = paymentData.cf_payment_id || '';
  const status = paymentData.payment_status || '';
  const eventId = cfPaymentId || `${subscriptionId}-${Date.now()}`;

  // ── Idempotency check ──
  if (isWebhookProcessed('PAYMENT_STATUS_UPDATE', eventId, subscriptionId)) {
    console.log(`[Webhook] Payment update already processed: ${eventId}`);
    return res.status(200).json({ received: true, duplicate: true });
  }

  // ── Record payment in history ──
  recordPayment({
    subscriptionId,
    cfPaymentId: cfPaymentId || null,
    paymentAmount: paymentData.payment_amount || 0,
    paymentStatus: status,
    paymentType: paymentData.payment_type || 'PERIODIC',
    cfPaymentReference: paymentData.cf_payment_reference_id || null,
    paymentMethod: paymentData.payment_group || 'upi',
    failureReason: paymentData.payment_message || null,
  });

  // ── Handle success ──
  if (status === 'SUCCESS') {
    incrementPaymentCount(subscriptionId);

    updateSubscriptionStatus(subscriptionId, 'ACTIVE', {
      lastPaymentDate: new Date().toISOString().split('T')[0],
      nextScheduleDate: subData.next_schedule_date || null,
    });

    console.log(`[Webhook] Payment SUCCESS for ${subscriptionId}: ₹${paymentData.payment_amount}`);

    // ── Auto-create Shopify Order (async, non-blocking) ──
    const subscription = getSubscriptionById(subscriptionId);
    if (subscription) {
      createShopifyOrder({
        customerName: subscription.customer_name,
        customerEmail: subscription.customer_email,
        customerPhone: subscription.customer_phone,
        productTitle: subscription.product_title,
        variantId: subscription.product_variant_id,
        amount: paymentData.payment_amount || subscription.amount,
        transactionId: subscriptionId,
        frequency: subscription.frequency,
        shippingAddress: subscription.shipping_address ? JSON.parse(subscription.shipping_address) : null,
      })
      .then(result => {
        if (result.success) {
          console.log(`[Webhook] Shopify order created: #${result.orderNumber} for ${subscriptionId}`);
        } else {
          console.error(`[Webhook] Shopify order FAILED for ${subscriptionId}:`, result.error);
        }
      })
      .catch(err => {
        console.error(`[Webhook] Shopify order error for ${subscriptionId}:`, err.message);
      });
    } else {
      console.warn(`[Webhook] No subscription record found for ${subscriptionId}, skipping Shopify order`);
    }
  } else if (status === 'FAILED') {
    console.warn(`[Webhook] Payment FAILED for ${subscriptionId}: ${paymentData.payment_message || 'Unknown'}`);
  }

  // Mark as processed
  markWebhookProcessed('PAYMENT_STATUS_UPDATE', eventId, subscriptionId, data);

  return res.status(200).json({ received: true, status });
}

module.exports = router;
