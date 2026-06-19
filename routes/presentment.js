/**
 * Subscription Payment Management Routes
 * ─────────────────────────────────────────
 * Admin-facing endpoints for listing active subscriptions
 * and checking subscription status.
 *
 * NOTE: With Cashfree's PERIODIC plan, charges are handled automatically.
 * No manual presentment/notification needed — Cashfree schedules debits
 * according to the plan_interval_type and plan_intervals.
 */

const express = require('express');
const router = express.Router();
const { fetchSubscription, fetchSubscriptionPayments } = require('../utils/cashfree-api');
const { createShopifyOrder } = require('../utils/shopify-api');
const {
  getSubscriptionById,
  getActiveSubscriptions,
  updateSubscriptionStatus,
  incrementPaymentCount,
  isPaymentOrderProcessed,
  markWebhookProcessed,
  getPaymentByReference,
  recordPayment,
} = require('../db/database');

/**
 * GET /api/payments/active
 * ─────────────────────────
 * Lists all active subscriptions.
 * Useful for admin dashboards.
 */
router.get('/active', async (req, res) => {
  try {
    const active = await getActiveSubscriptions();
    return res.status(200).json({
      success: true,
      count: active.length,
      subscriptions: active,
    });
  } catch (error) {
    console.error('[Payments] Active list error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/payments/status/:subId
 * ────────────────────────────────
 * Fetches live subscription status from Cashfree.
 */
router.get('/status/:subId', async (req, res) => {
  try {
    const { subId } = req.params;

    if (!subId) {
      return res.status(400).json({ success: false, error: 'Subscription ID is required' });
    }

    // Check local DB
    const local = await getSubscriptionById(subId);
    if (!local) {
      return res.status(404).json({ success: false, error: 'Subscription not found in local records' });
    }

    // Fetch live from Cashfree
    const live = await fetchSubscription(subId);

    return res.status(200).json({
      success: true,
      local,
      cashfree: live.success ? live.data : null,
    });
  } catch (error) {
    console.error('[Payments] Status error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/payments/history/:subId
 * ───────────────────────────────────
 * Fetches all Cashfree payments for a subscription.
 */
router.get('/history/:subId', async (req, res) => {
  try {
    const { subId } = req.params;
    if (!subId) {
      return res.status(400).json({ success: false, error: 'Subscription ID is required' });
    }

    const local = await getSubscriptionById(subId);
    if (!local) {
      return res.status(404).json({ success: false, error: 'Subscription not found in local records' });
    }

    const payments = await fetchSubscriptionPayments(subId);
    if (!payments.success) {
      return res.status(502).json({ success: false, error: payments.error || 'Cashfree payment fetch failed' });
    }

    return res.status(200).json({
      success: true,
      count: payments.data.length,
      payments: payments.data.map(summarizePayment),
    });
  } catch (error) {
    console.error('[Payments] History error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET/POST /api/payments/reconcile/:subId
 * ─────────────────────────────────────
 * Pulls Cashfree state directly and creates missing Shopify orders for
 * successful subscription CHARGE payments and the paid initial AUTH.
 * Safe to retry.
 */
router.get('/reconcile/:subId', reconcileHandler);
router.post('/reconcile/:subId', reconcileHandler);

async function reconcileHandler(req, res) {
  try {
    const { subId } = req.params;
    if (!subId) {
      return res.status(400).json({ success: false, error: 'Subscription ID is required' });
    }

    const result = await reconcileSubscription(subId);
    return res.status(result.success ? 200 : 502).json(result);
  } catch (error) {
    console.error('[Payments] Reconcile error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

async function reconcileSubscription(subId) {
  const local = await getSubscriptionById(subId);
  if (!local) {
    return { success: false, error: 'Subscription not found in local records' };
  }

  const [live, paymentList] = await Promise.all([
    fetchSubscription(subId),
    fetchSubscriptionPayments(subId),
  ]);

  if (live.success && live.data?.subscription_status) {
    await updateSubscriptionStatus(subId, live.data.subscription_status, {
      cfSubscriptionId: live.data.cf_subscription_id || null,
      nextScheduleDate: live.data.next_schedule_date || null,
    });
  }

  if (!paymentList.success) {
    return {
      success: false,
      error: paymentList.error || 'Cashfree payment fetch failed',
      cashfreeStatus: live.success ? summarizeSubscription(live.data) : null,
    };
  }

  const createdOrders = [];
  const skipped = [];

  for (const payment of paymentList.data) {
    const paymentId = getPaymentEventId(payment, subId);
    const summary = summarizePayment(payment);

    await recordPaymentOnce(subId, payment, summary);

    if (!isOrderablePayment(payment)) {
      skipped.push({ ...summary, reason: 'not_orderable_payment' });
      continue;
    }

    if (await isPaymentOrderProcessed(paymentId, subId)) {
      skipped.push({ ...summary, reason: 'already_ordered' });
      continue;
    }

    const order = await createOrderForPayment(local, payment, paymentId);
    if (!order.success) {
      return {
        success: false,
        error: `Shopify order failed: ${order.error}`,
        cashfreeStatus: live.success ? summarizeSubscription(live.data) : null,
        payments: paymentList.data.map(summarizePayment),
        createdOrders,
        skipped,
      };
    }

    await incrementPaymentCount(subId);
    await updateSubscriptionStatus(subId, 'ACTIVE', {
      lastPaymentDate: new Date().toISOString().split('T')[0],
      nextScheduleDate: live.success ? live.data.next_schedule_date : null,
    });
    await markWebhookProcessed('RECONCILE_PAYMENT_SUCCESS', paymentId, subId, payment);
    await markWebhookProcessed('SHOPIFY_ORDER_CREATED', paymentId, subId, {
      source_event_type: 'RECONCILE_PAYMENT_SUCCESS',
      order_id: order.orderId,
      order_number: order.orderNumber,
    });

    createdOrders.push({
      payment_id: paymentId,
      order_id: order.orderId,
      order_number: order.orderNumber,
      order_name: order.orderName,
    });
  }

  return {
    success: true,
    cashfreeStatus: live.success ? summarizeSubscription(live.data) : null,
    paymentCount: paymentList.data.length,
    payments: paymentList.data.map(summarizePayment),
    createdOrders,
    skipped,
  };
}

async function recordPaymentOnce(subId, payment, summary) {
  const cfPaymentId = payment.cf_payment_id || payment.payment_id || null;
  if (cfPaymentId && await getPaymentByReference(subId, cfPaymentId)) return;

  await recordPayment({
    subscriptionId: subId,
    cfPaymentId,
    paymentAmount: summary.payment_amount || 0,
    paymentStatus: summary.payment_status || 'UNKNOWN',
    paymentType: summary.payment_type || 'UNKNOWN',
    cfPaymentReference: payment.cf_txn_id || null,
    paymentMethod: payment.authorization_details?.payment_group || payment.payment_group || 'upi',
    failureReason: summary.failure_reason || null,
  });
}

async function createOrderForPayment(subscription, payment, paymentId) {
  return createShopifyOrder({
    customerName: subscription.customer_name,
    customerEmail: subscription.customer_email,
    customerPhone: subscription.customer_phone,
    productTitle: subscription.product_title,
    variantId: subscription.product_variant_id,
    amount: payment.payment_amount || subscription.amount,
    transactionId: paymentId,
    subscriptionId: subscription.subscription_id,
    frequency: subscription.frequency,
    shippingAddress: subscription.shipping_address ? JSON.parse(subscription.shipping_address) : null,
    items: safeParseItems(subscription.product_items),
  });
}

function isOrderablePayment(payment) {
  const paymentType = String(payment.payment_type || '').toUpperCase();
  const paymentStatus = String(payment.payment_status || '').toUpperCase();
  const authStatus = String(payment.authorization_details?.authorization_status || '').toUpperCase();
  const amount = Number(payment.payment_amount || payment.authorization_details?.authorization_amount || 0);

  if (amount <= 1) return false;
  if (paymentType === 'CHARGE') return paymentStatus === 'SUCCESS';
  if (paymentType === 'AUTH') return paymentStatus === 'SUCCESS' || authStatus === 'ACTIVE';
  return false;
}

function getPaymentEventId(payment, subId) {
  return (
    payment.cf_payment_id ||
    payment.payment_gateway_details?.gateway_payment_id ||
    payment.cf_execution_id ||
    payment.execution_id ||
    payment.cf_notification_id ||
    payment.notification_id ||
    payment.payment_id ||
    `${subId}-payment-${payment.payment_schedule_date || payment.payment_initiated_date || 'unknown'}`
  );
}

function summarizeSubscription(sub) {
  return {
    subscription_id: sub.subscription_id,
    cf_subscription_id: sub.cf_subscription_id,
    subscription_status: sub.subscription_status,
    authorization_status: sub.authorization_details?.authorization_status || null,
    first_charge_time: sub.subscription_first_charge_time || null,
    next_schedule_date: sub.next_schedule_date || null,
  };
}

function summarizePayment(payment) {
  return {
    payment_id: payment.payment_id || null,
    cf_payment_id: payment.cf_payment_id || null,
    payment_amount: payment.payment_amount || 0,
    payment_status: payment.payment_status || null,
    payment_type: payment.payment_type || null,
    payment_remarks: payment.payment_remarks || null,
    payment_schedule_date: payment.payment_schedule_date || null,
    payment_initiated_date: payment.payment_initiated_date || null,
    retry_attempts: payment.retry_attempts || 0,
    failure_reason: payment.failure_details?.failure_reason || payment.failureDetails?.failureReason || null,
  };
}

function safeParseItems(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn('[Payments] Could not parse product_items JSON for Shopify order');
    return null;
  }
}

module.exports = router;
