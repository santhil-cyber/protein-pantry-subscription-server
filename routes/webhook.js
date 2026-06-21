/**
 * Webhook Route - Cashfree Subscription Events
 * ------------------------------------------------
 * Receives Cashfree subscription webhooks and creates Shopify orders for paid
 * subscription payments, including the initial paid UPI mandate authorization.
 */

const express = require('express');
const router = express.Router();
const {
  verifyWebhookSignature,
  fetchSubscription: fetchCashfreeSubscription,
} = require('../utils/cashfree-api');
const {
  updateSubscriptionStatus,
  incrementPaymentCount,
  isWebhookProcessed,
  markWebhookProcessed,
  isPaymentOrderProcessed,
  claimOrderForCycle,
  getPaymentByReference,
  recordPayment,
  getSubscriptionById,
} = require('../db/database');
const { createShopifyOrder } = require('../utils/shopify-api');

const STATUS_EVENTS = new Set([
  'SUBSCRIPTION_STATUS_CHANGED',
  'SUBSCRIPTION_STATUS_UPDATE',
]);

const PAYMENT_EVENTS = new Set([
  'SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED',
  'SUBSCRIPTION_PAYMENT_SUCCESS',
  'SUBSCRIPTION_PAYMENT_FAILED',
  'SUBSCRIPTION_PAYMENT_CANCELLED',
  'SUBSCRIPTION_PAYMENT_CONTROLLED_NOTIFICATION_STATUS',
  'SUBSCRIPTION_PAYMENT_CONTROLLED_EXECUTION_STATUS',
  'PAYMENT_STATUS_UPDATE',
]);

/**
 * POST /api/webhook/cashfree
 */
router.post('/cashfree', async (req, res) => {
  try {
    const body = parseBody(req);
    if (isCashfreeDashboardTest(body)) {
      console.log('[Webhook] Cashfree dashboard test received');
      return res.status(200).json({ received: true, test: true });
    }

    const signature = getHeader(req, ['x-webhook-signature', 'x-cashfree-signature']);
    const timestamp = getHeader(req, ['x-webhook-timestamp', 'x-cashfree-timestamp']);
    const rawBody = getRawBody(req);
    const requireSignature =
      process.env.CASHFREE_ENV === 'production' &&
      process.env.ALLOW_UNSIGNED_WEBHOOKS !== 'true';

    if (signature && timestamp) {
      if (!verifyWebhookSignature(rawBody, timestamp, signature)) {
        console.error('[Webhook] Signature verification FAILED');
        return res.status(401).json({ error: 'Signature verification failed' });
      }
      console.log('[Webhook] Signature verified');
    } else {
      console.warn('[Webhook] Missing signature headers');
      if (requireSignature) {
        return res.status(401).json({ error: 'Missing webhook signature' });
      }
    }

    const { type, data, event_time: eventTime } = body;

    if (!type || !data) {
      console.warn('[Webhook] Received malformed payload - missing type or data');
      return res.status(400).json({ error: 'Invalid payload' });
    }

    console.log(`[Webhook] Received event: ${type}`, getEventSummary(type, data));

    if (STATUS_EVENTS.has(type)) {
      return await handleSubscriptionUpdate(type, data, res);
    }

    if (type === 'SUBSCRIPTION_AUTH_STATUS') {
      return await handleAuthStatus(type, data, eventTime, res);
    }

    if (PAYMENT_EVENTS.has(type)) {
      return await handlePaymentUpdate(type, data, eventTime, res);
    }

    console.warn(`[Webhook] Unknown event type: ${type}`);
    return res.status(200).json({ received: true, message: 'Unknown event type' });
  } catch (error) {
    console.error('[Webhook] Processing error:', error);
    return res.status(500).json({ received: false, error: 'Processing error logged' });
  }
});

async function handleSubscriptionUpdate(eventType, data, res) {
  const subData = getSubscriptionDetails(data);
  const subscriptionId = subData.subscription_id || '';
  const cfSubscriptionId = subData.cf_subscription_id || '';
  const status = subData.subscription_status || '';
  const eventId = cfSubscriptionId || `${subscriptionId}-${status}`;

  if (!subscriptionId) {
    return res.status(400).json({ error: 'Missing subscription_id' });
  }

  if (await isWebhookProcessed(eventType, eventId, subscriptionId)) {
    console.log(`[Webhook] Subscription update already processed: ${subscriptionId}`);
    return res.status(200).json({ received: true, duplicate: true });
  }

  const result = await updateSubscriptionStatus(subscriptionId, status, {
    cfSubscriptionId,
    nextScheduleDate: subData.next_schedule_date || null,
  });

  await markWebhookProcessed(eventType, eventId, subscriptionId, data);

  if (result.changes === 0) {
    console.warn(`[Webhook] Subscription status update had no local row: ${subscriptionId}`);
  }
  console.log(`[Webhook] Subscription ${subscriptionId} status: ${status}`);

  return res.status(200).json({ received: true, status });
}

async function handleAuthStatus(eventType, data, eventTime, res) {
  const paymentData = getPaymentData(data);
  const subscriptionId = paymentData.subscription_id || '';
  const cfSubscriptionId = paymentData.cf_subscription_id || '';
  const authStatus = paymentData.authorization_details?.authorization_status || '';
  const paymentStatus = paymentData.payment_status || authStatus || '';
  const localStatus = authStatus === 'ACTIVE' || paymentStatus === 'SUCCESS'
    ? 'ACTIVE'
    : (authStatus || paymentStatus || 'AUTH_UPDATED');
  const eventId = getPaymentEventId(eventType, paymentData, subscriptionId, eventTime);

  if (!subscriptionId) {
    return res.status(400).json({ error: 'Missing subscription_id' });
  }

  if (await isWebhookProcessed(eventType, eventId, subscriptionId)) {
    console.log(`[Webhook] Auth update already processed: ${eventId}`);
    return res.status(200).json({ received: true, duplicate: true });
  }

  await safeRecordPayment({
    subscriptionId,
    cfPaymentId: paymentData.cf_payment_id || paymentData.payment_id || null,
    paymentAmount: paymentData.payment_amount || 0,
    paymentStatus,
    paymentType: paymentData.payment_type || 'AUTH',
    cfPaymentReference: paymentData.cf_payment_reference_id || paymentData.cf_txn_id || null,
    paymentMethod: getPaymentMethod(paymentData),
    failureReason: getFailureReason(paymentData),
  });

  await updateSubscriptionStatus(subscriptionId, localStatus, {
    cfSubscriptionId,
  });

  if (isPaidInitialAuthorization(paymentData)) {
    const cycleKey = getOrderCycleKey(paymentData, subscriptionId);
    const claimed = await claimOrderForCycle(cycleKey, subscriptionId);
    if (!claimed) {
      console.log(`[Webhook] Initial order already claimed for cycle ${cycleKey} — skipping duplicate`);
      await markWebhookProcessed(eventType, eventId, subscriptionId, data);
      return res.status(200).json({ received: true, status: paymentStatus, duplicateOrder: true });
    }

    await updateSubscriptionStatus(subscriptionId, 'ACTIVE', {
      cfSubscriptionId,
      lastPaymentDate: new Date().toISOString().split('T')[0],
      nextScheduleDate: paymentData.next_schedule_date || paymentData.payment_schedule_date || null,
    });

    const result = await createOrderForPayment(subscriptionId, paymentData, eventId);
    if (!result.success) {
      console.error(`[Webhook] Initial Shopify order FAILED for ${subscriptionId}:`, result.error);
      return res.status(502).json({ received: false, error: 'Shopify order failed' });
    }

    await incrementPaymentCount(subscriptionId);
    await markWebhookProcessed('SHOPIFY_ORDER_CREATED', eventId, subscriptionId, {
      source_event_type: eventType,
      cycle_key: cycleKey,
      order_id: result.orderId,
      order_number: result.orderNumber,
    });
    await markWebhookProcessed(eventType, eventId, subscriptionId, data);
    console.log(`[Webhook] Initial Shopify order created: #${result.orderNumber} for ${subscriptionId} (cycle ${cycleKey})`);
    return res.status(200).json({ received: true, status: paymentStatus, orderCreated: true });
  }

  await markWebhookProcessed(eventType, eventId, subscriptionId, data);

  console.log(`[Webhook] Authorization ${paymentStatus} for ${subscriptionId}; no Shopify order created`);
  return res.status(200).json({ received: true, status: paymentStatus, orderCreated: false });
}

async function handlePaymentUpdate(eventType, data, eventTime, res) {
  const paymentData = getPaymentData(data);
  const subscriptionId =
    data.subscription?.subscription_id ||
    paymentData.subscription_id ||
    '';
  const status = normalizePaymentStatus(eventType, paymentData);
  const eventId = getPaymentEventId(eventType, paymentData, subscriptionId, eventTime);

  if (!subscriptionId) {
    return res.status(400).json({ error: 'Missing subscription_id' });
  }

  if (await isWebhookProcessed(eventType, eventId, subscriptionId)) {
    console.log(`[Webhook] Payment update already processed: ${eventId}`);
    return res.status(200).json({ received: true, duplicate: true });
  }

  await safeRecordPayment({
    subscriptionId,
    cfPaymentId: paymentData.cf_payment_id || paymentData.payment_id || null,
    paymentAmount: paymentData.payment_amount || 0,
    paymentStatus: status,
    paymentType: paymentData.payment_type || 'CHARGE',
    cfPaymentReference: paymentData.cf_payment_reference_id || paymentData.cf_txn_id || null,
    paymentMethod: getPaymentMethod(paymentData),
    failureReason: getFailureReason(paymentData),
  });

  if (status === 'SUCCESS') {
    if (isPaidInitialAuthorization(paymentData) || shouldCreateShopifyOrder(eventType, paymentData)) {
      // Dedupe per billing cycle, not per event. Cashfree sends several event
      // types for one debit; only the first to claim the cycle creates an order.
      const cycleKey = getOrderCycleKey(paymentData, subscriptionId);
      const claimed = await claimOrderForCycle(cycleKey, subscriptionId);
      if (!claimed) {
        console.log(`[Webhook] Order already claimed for cycle ${cycleKey} — skipping duplicate`);
        await markWebhookProcessed(eventType, eventId, subscriptionId, data);
        return res.status(200).json({ received: true, status, duplicateOrder: true });
      }

      await updateSubscriptionStatus(subscriptionId, 'ACTIVE', {
        lastPaymentDate: new Date().toISOString().split('T')[0],
        nextScheduleDate: paymentData.next_schedule_date || paymentData.payment_schedule_date || null,
      });

      const result = await createOrderForPayment(subscriptionId, paymentData, eventId);
      if (!result.success) {
        console.error(`[Webhook] Shopify order FAILED for ${subscriptionId}:`, result.error);
        return res.status(502).json({ received: false, error: 'Shopify order failed' });
      }
      await incrementPaymentCount(subscriptionId);
      await markWebhookProcessed('SHOPIFY_ORDER_CREATED', eventId, subscriptionId, {
        source_event_type: eventType,
        cycle_key: cycleKey,
        order_id: result.orderId,
        order_number: result.orderNumber,
      });
      console.log(`[Webhook] Shopify order created: #${result.orderNumber} for ${subscriptionId} (cycle ${cycleKey})`);
    } else {
      await updateSubscriptionStatus(subscriptionId, 'ACTIVE', {
        nextScheduleDate: paymentData.next_schedule_date || paymentData.payment_schedule_date || null,
      });
      console.log(`[Webhook] Payment SUCCESS for ${subscriptionId}, but it is an authorization event; order skipped`);
    }
  } else if (status === 'FAILED') {
    console.warn(`[Webhook] Payment FAILED for ${subscriptionId}: ${getFailureReason(paymentData) || 'Unknown'}`);
  } else if (status === 'CANCELLED') {
    console.warn(`[Webhook] Payment CANCELLED for ${subscriptionId}`);
  } else {
    console.log(`[Webhook] Payment ${status || 'updated'} for ${subscriptionId}`);
  }

  await markWebhookProcessed(eventType, eventId, subscriptionId, data);

  return res.status(200).json({ received: true, status });
}

async function createOrderForPayment(subscriptionId, paymentData, eventId) {
  const subscription = await getSubscriptionForOrder(subscriptionId, paymentData);
  if (!subscription) {
    return { success: false, error: 'No subscription data available for Shopify order' };
  }

  if (!subscription.shipping_address) {
    console.error(
      `[Webhook] No shipping_address in subscription row for ${subscriptionId} — order will be tagged MISSING-ADDRESS`
    );
  }

  return createShopifyOrder({
    customerName: subscription.customer_name,
    customerEmail: subscription.customer_email,
    customerPhone: subscription.customer_phone,
    productTitle: subscription.product_title,
    variantId: subscription.product_variant_id,
    amount: paymentData.payment_amount || subscription.amount,
    transactionId: eventId,
    subscriptionId,
    frequency: subscription.frequency,
    shippingAddress: subscription.shipping_address ? JSON.parse(subscription.shipping_address) : null,
    items: safeParseItems(subscription.product_items),
  });
}

async function getSubscriptionForOrder(subscriptionId, paymentData) {
  const local = await getSubscriptionById(subscriptionId);
  if (local) return local;

  console.warn(`[Webhook] No local subscription row for ${subscriptionId}; fetching from Cashfree`);
  const live = await fetchCashfreeSubscription(subscriptionId);
  if (!live.success || !live.data) return null;

  const data = live.data;
  const tags = data.subscription_tags || {};
  const customer = data.customer_details || {};
  const plan = data.plan_details || {};

  return {
    customer_name: customer.customer_name || 'Subscriber',
    customer_email: customer.customer_email || '',
    customer_phone: customer.customer_phone || '',
    product_title: tags.product_title || 'Protein Pantry Subscription',
    product_variant_id: tags.product_variant_id || '',
    amount: paymentData.payment_amount || plan.plan_recurring_amount || plan.plan_max_amount || 0,
    frequency: tags.frequency || plan.plan_interval_type || 'subscription',
    shipping_address: null,
  };
}

function shouldCreateShopifyOrder(eventType, paymentData) {
  const paymentType = String(paymentData.payment_type || '').toUpperCase();
  const remarks = String(paymentData.payment_remarks || '').toLowerCase();

  if (eventType === 'SUBSCRIPTION_AUTH_STATUS') return false;
  if (paymentType === 'AUTH') return false;
  if (remarks.includes('auth payment')) return false;
  if (eventType === 'SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED') return false;

  return (
    eventType === 'SUBSCRIPTION_PAYMENT_SUCCESS' ||
    eventType === 'PAYMENT_STATUS_UPDATE' ||
    eventType === 'SUBSCRIPTION_PAYMENT_CONTROLLED_EXECUTION_STATUS'
  );
}

function isPaidInitialAuthorization(paymentData) {
  const paymentType = String(paymentData.payment_type || '').toUpperCase();
  const authStatus = String(paymentData.authorization_details?.authorization_status || '').toUpperCase();
  const paymentStatus = String(paymentData.payment_status || '').toUpperCase();
  const amount = Number(paymentData.payment_amount || paymentData.authorization_details?.authorization_amount || 0);

  if (paymentType && paymentType !== 'AUTH') return false;
  return amount > 1 && (authStatus === 'ACTIVE' || paymentStatus === 'SUCCESS');
}

function safeParseItems(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn('[Webhook] Could not parse product_items JSON for Shopify order');
    return null;
  }
}

function normalizePaymentStatus(eventType, paymentData) {
  if (eventType === 'SUBSCRIPTION_PAYMENT_SUCCESS') return 'SUCCESS';
  if (eventType === 'SUBSCRIPTION_PAYMENT_FAILED') return 'FAILED';
  if (eventType === 'SUBSCRIPTION_PAYMENT_CANCELLED') return 'CANCELLED';
  return paymentData.payment_status || paymentData.execution_status || paymentData.notification_status || 'UPDATED';
}

function getSubscriptionDetails(data) {
  return (
    data.subscription ||
    data.subscription_details ||
    data.subscription_status_webhook?.subscription_details ||
    data
  );
}

function getPaymentData(data) {
  return data.payment || data;
}

function getPaymentEventId(eventType, paymentData, subscriptionId, eventTime) {
  return (
    paymentData.cf_payment_id ||
    paymentData.payment_gateway_details?.gateway_payment_id ||
    paymentData.cf_execution_id ||
    paymentData.execution_id ||
    paymentData.cf_notification_id ||
    paymentData.notification_id ||
    paymentData.payment_id ||
    `${subscriptionId}-${eventType}-${paymentData.payment_schedule_date || eventTime || 'unknown'}`
  );
}

// A key that is STABLE across the multiple event types Cashfree sends for the
// same debit AND across the reconcile path, so we create exactly one Shopify
// order per actual payment. cf_payment_id identifies one money movement and is
// shared by every event/reconcile record for that payment — so it's the primary
// key. Schedule date is the fallback for the rare event with no cf_payment_id.
// This deliberately excludes eventType (which differs per event and caused the
// duplicate orders).
function getOrderCycleKey(paymentData, subscriptionId) {
  if (paymentData.cf_payment_id) return `${subscriptionId}-pay-${paymentData.cf_payment_id}`;
  const schedule =
    paymentData.payment_schedule_date ||
    paymentData.next_schedule_date ||
    null;
  if (schedule) return `${subscriptionId}-cycle-${schedule}`;
  return `${subscriptionId}-cycle-INITIAL`;
}

function getPaymentMethod(paymentData) {
  return (
    paymentData.payment_group ||
    paymentData.authorization_details?.payment_group ||
    paymentData.authorization_details?.payment_method ||
    'upi'
  );
}

function getFailureReason(paymentData) {
  return (
    paymentData.payment_message ||
    paymentData.failure_details?.failure_reason ||
    paymentData.failureDetails?.failureReason ||
    null
  );
}

async function safeRecordPayment(data) {
  try {
    if (data.cfPaymentId && await getPaymentByReference(data.subscriptionId, data.cfPaymentId)) {
      return null;
    }
    return await recordPayment(data);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || error.code === '23503') {
      console.warn(`[Webhook] Payment history skipped; no local subscription row: ${data.subscriptionId}`);
      return null;
    }
    throw error;
  }
}

function getEventSummary(type, data) {
  const paymentData = getPaymentData(data);
  const subData = getSubscriptionDetails(data);
  return {
    subscription_id: subData.subscription_id || paymentData.subscription_id || 'N/A',
    status: subData.subscription_status || paymentData.payment_status || paymentData.authorization_details?.authorization_status || 'N/A',
    payment_type: paymentData.payment_type || 'N/A',
  };
}

function getHeader(req, names) {
  for (const name of names) {
    if (req.headers[name]) return req.headers[name];
  }
  return '';
}

function getRawBody(req) {
  if (req.rawBody) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body || {});
}

function parseBody(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return req.body;
}

function isCashfreeDashboardTest(body) {
  const type = String(body?.type || '').toUpperCase();
  if (['WEBHOOK', 'TEST', 'TEST_WEBHOOK'].includes(type)) return true;
  if (body?.data?.test_object) return true;

  const data = body?.data || {};
  const paymentData = getPaymentData(data);
  const subData = getSubscriptionDetails(data);
  const subscriptionId = subData.subscription_id || paymentData.subscription_id || '';
  const paymentId = paymentData.payment_id || paymentData.cf_payment_id || '';

  return (
    /^test[-_]/i.test(subscriptionId) ||
    subscriptionId === 'test-subscription-id' ||
    /^test[-_]/i.test(paymentId)
  );
}

module.exports = router;
module.exports.getOrderCycleKey = getOrderCycleKey;
