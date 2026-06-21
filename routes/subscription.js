/**
 * Subscription API Routes — Cashfree Integration
 * -------------------------------------------------
 * Handles subscription creation, status checks, and cancellation.
 *
 * Flow:
 *   1. Frontend calls POST /create with customer + product + frequency
 *   2. Server creates a Cashfree Plan (if not exists) + Subscription
 *   3. Returns checkout URL for UPI Autopay mandate authorization
 *   4. Customer authorizes on Cashfree checkout → webhooks update status
 */

const express = require('express');
const router = express.Router();
const {
  createPlan,
  createSubscription: createCashfreeSubscription,
  fetchSubscription: fetchCashfreeSubscription,
  manageSubscription,
  generateSubscriptionId,
  generatePlanId,
  mapFrequency,
} = require('../utils/cashfree-api');
const {
  createSubscription,
  getSubscriptionById,
  getSubscriptionsByEmail,
  updateSubscriptionStatus,
} = require('../db/database');
const { lookupCustomerAddress, getVariantCurrentPrice } = require('../utils/shopify-api');

/**
 * GET /api/subscription/address-lookup/:phone
 */
router.get('/address-lookup/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone || !/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Valid 10-digit phone is required' });
    }
    const address = await lookupCustomerAddress(phone);
    return res.status(200).json({ success: true, address });
  } catch (error) {
    console.error('[Subscription] Address lookup error:', error);
    return res.status(200).json({ success: true, address: null });
  }
});

const FREQUENCY_DISCOUNTS = {
  '1_day': 0,
  '2_day': 3,
  '1_week': 5,
  '2_week': 8,
  '3_week': 10,
  monthly: 12,
};

async function resolveCurrentAmount(items, productVariantId, requestedAmount, frequency) {
  const discountMultiplier = 1 - ((FREQUENCY_DISCOUNTS[frequency] || 0) / 100);
  const selectedItems = normalizeSelectedItems(items);
  if (selectedItems.length > 0) {
    const pricedItems = [];
    let total = 0;

    for (const item of selectedItems) {
      const priceResult = await getVariantCurrentPrice(item.variantId);
      if (!priceResult.success) {
        return {
          error: 'Could not verify current Shopify product price. Please try again.',
          status: 502,
        };
      }

      pricedItems.push({
        variantId: item.variantId,
        quantity: item.quantity,
        title: item.title,
        handle: item.handle,
        price: roundMoney(priceResult.price * discountMultiplier),
      });
      total += roundMoney(priceResult.price * discountMultiplier) * item.quantity;
    }

    return { value: Math.round(total), items: pricedItems };
  }

  if (productVariantId) {
    const priceResult = await getVariantCurrentPrice(productVariantId);
    if (!priceResult.success) {
      return {
        error: 'Could not verify current Shopify product price. Please try again.',
        status: 502,
      };
    }
    return {
      value: Math.round(priceResult.price * discountMultiplier),
      items: [{
        variantId: String(productVariantId),
        quantity: 1,
        title: '',
        handle: '',
        price: roundMoney(priceResult.price * discountMultiplier),
      }],
    };
  }

  if (typeof requestedAmount !== 'number' || !Number.isFinite(requestedAmount)) {
    return { error: 'Valid amount is required' };
  }

  return { value: requestedAmount, items: [] };
}

function normalizeSelectedItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      variantId: String(item.variantId || item.vid || '').trim(),
      quantity: Math.max(0, parseInt(item.quantity || item.qty || 0, 10)),
      title: String(item.title || '').trim().substring(0, 100),
      handle: String(item.handle || '').trim().substring(0, 100),
    }))
    .filter((item) => /^\d+$/.test(item.variantId) && item.quantity > 0);
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

/**
 * POST /api/subscription/create
 * ──────────────────────────────
 * Body: { customerName, customerEmail, customerPhone, amount, frequency,
 *         productTitle, productVariantId, productHandle, items, shippingAddress,
 *         firstChargeDelayHours }
 */
router.post('/create', async (req, res) => {
  try {
    const {
      customerName, customerEmail, customerPhone,
      amount: requestedAmount, frequency, productTitle, productVariantId, productHandle,
      items, shippingAddress, firstChargeDelayHours,
    } = req.body;

    // ── Input Validation ──
    if (!customerName || typeof customerName !== 'string' || customerName.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'Valid customer name is required (min 2 characters)' });
    }
    if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      return res.status(400).json({ success: false, error: 'Valid email address is required' });
    }
    if (!customerPhone || !/^[6-9]\d{9}$/.test(customerPhone)) {
      return res.status(400).json({ success: false, error: 'Valid 10-digit Indian phone number is required' });
    }

    const validFrequencies = ['1_day', '2_day', '1_week', '2_week', '3_week', 'monthly'];
    if (!frequency || !validFrequencies.includes(frequency)) {
      return res.status(400).json({
        success: false,
        error: `Invalid frequency. Must be one of: ${validFrequencies.join(', ')}`,
      });
    }

    const amount = await resolveCurrentAmount(items, productVariantId, requestedAmount, frequency);
    if (amount.error) {
      return res.status(amount.status || 400).json({ success: false, error: amount.error });
    }

    if (!amount.value || amount.value < 1 || amount.value > 15000) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be between ₹1 and ₹15,000 (UPI AutoPay limit)',
      });
    }
    if (typeof requestedAmount === 'number' && Math.abs(requestedAmount - amount.value) >= 0.01) {
      console.warn(
        `[Subscription] Client amount ₹${requestedAmount} overridden by Shopify current price ₹${amount.value}`
      );
    }

    // ── Map frequency to Cashfree plan parameters ──
    const freq = mapFrequency(frequency);
    const firstChargeTime = getFirstChargeTimeOverride(firstChargeDelayHours);
    if (firstChargeTime?.error) {
      return res.status(400).json({ success: false, error: firstChargeTime.error });
    }

    // ── Step 1: Create or reuse a Cashfree Plan ──
    const planId = generatePlanId(productHandle, freq.intervalType, freq.intervals, amount.value);

    const planResult = await createPlan({
      planId,
      planName: `${(productTitle || 'Protein Pantry').replace(/[^a-zA-Z0-9 _-]/g, '')} - ${freq.label}`.substring(0, 40),
      amount: amount.value,
      maxAmount: amount.value,
      intervalType: freq.intervalType,
      intervals: freq.intervals,
      maxCycles: freq.intervalType === 'MONTH' ? 12 : 52,
      planNote: `Subscribe & Save: ${freq.label} delivery`,
    });

    if (!planResult.success) {
      console.error('[Subscription] Plan creation failed:', planResult.error);
      return res.status(502).json({ success: false, error: 'Failed to create subscription plan' });
    }

    // ── Step 2: Create Cashfree Subscription ──
    const subscriptionId = generateSubscriptionId();

    const subResult = await createCashfreeSubscription({
      subscriptionId,
      planId,
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim().toLowerCase(),
      customerPhone: customerPhone.trim(),
      amount: amount.value,
      maxAmount: amount.value,
      intervalType: freq.intervalType,
      intervals: freq.intervals,
      productTitle: productTitle || 'Protein Pantry Subscription',
      productVariantId: productVariantId || '',
      frequency, // Pass frequency so Cashfree API can set correct firstChargeTime
      firstChargeTime: firstChargeTime?.iso || null,
    });

    if (!subResult.success) {
      console.error('[Subscription] Cashfree subscription creation failed:', subResult.error);
      return res.status(502).json({ success: false, error: 'Payment gateway error. Please try again.' });
    }

    // ── Step 3: Save to local database ──
    const today = new Date();
    const endDate = new Date(today);
    endDate.setFullYear(endDate.getFullYear() + 1);
    // Initial payment is collected during UPI mandate authorization.
    // Cashfree firstChargeTime is the next automatic renewal debit.
    const nextRecurringCharge = new Date(subResult.firstChargeTime);

    await createSubscription({
      subscriptionId,
      cfSubscriptionId: subResult.cfSubscriptionId || '',
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim().toLowerCase(),
      customerPhone: customerPhone.trim(),
      productTitle: productTitle || '',
      productVariantId: productVariantId || '',
      productItems: amount.items.length > 0 ? JSON.stringify(amount.items) : null,
      amount: amount.value,
      frequency,
      planId,
      planIntervalType: freq.intervalType,
      planIntervals: freq.intervals,
      sessionId: subResult.sessionId || '',
      checkoutUrl: subResult.checkoutUrl || '',
      startDate: today.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      firstChargeDate: today.toISOString().split('T')[0],
      nextScheduleDate: nextRecurringCharge.toISOString(),
      shippingAddress: shippingAddress ? JSON.stringify(shippingAddress) : null,
    });

    console.log(`[Subscription] Created: ${subscriptionId} for ${customerEmail} — ₹${amount.value}/${frequency}`);

    return res.status(200).json({
      success: true,
      subscriptionId,
      checkoutUrl: subResult.checkoutUrl,
      sessionId: subResult.sessionId,
      amount: amount.value,
      firstChargeTime: today.toISOString(),
      nextScheduleDate: nextRecurringCharge.toISOString(),
    });
  } catch (error) {
    console.error('[Subscription] Create error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/subscription/status/:subId
 */
router.get('/status/:subId', async (req, res) => {
  try {
    const { subId } = req.params;
    if (!subId) return res.status(400).json({ success: false, error: 'Subscription ID is required' });

    const subscription = await getSubscriptionById(subId);
    if (!subscription) return res.status(404).json({ success: false, error: 'Subscription not found' });

    if (['INITIALIZED', 'BANK_APPROVAL_PENDING', 'ACTIVE'].includes(subscription.status)) {
      try {
        const liveStatus = await fetchCashfreeSubscription(subId);
        if (liveStatus.success && liveStatus.data) {
          return res.status(200).json({ success: true, subscription, liveStatus: liveStatus.data });
        }
      } catch (e) {
        console.warn('[Subscription] Live status fetch failed, using local data');
      }
    }

    return res.status(200).json({ success: true, subscription });
  } catch (error) {
    console.error('[Subscription] Status error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/subscription/customer/:email
 */
router.get('/customer/:email', async (req, res) => {
  try {
    const { email } = req.params;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }
    const subscriptions = await getSubscriptionsByEmail(email.toLowerCase());
    return res.status(200).json({ success: true, subscriptions });
  } catch (error) {
    console.error('[Subscription] Customer lookup error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/subscription/cancel/:subId
 */
router.post('/cancel/:subId', async (req, res) => {
  try {
    const { subId } = req.params;
    const subscription = await getSubscriptionById(subId);
    if (!subscription) return res.status(404).json({ success: false, error: 'Subscription not found' });

    if (['CANCELLED', 'COMPLETED'].includes(subscription.status)) {
      return res.status(400).json({ success: false, error: `Subscription is already ${subscription.status}` });
    }

    const result = await manageSubscription(subId, 'CANCEL');
    if (result.success) {
      await updateSubscriptionStatus(subId, 'CANCELLED');
      return res.status(200).json({ success: true, message: 'Subscription cancelled successfully' });
    }

    await updateSubscriptionStatus(subId, 'CANCEL_REQUESTED');
    return res.status(200).json({
      success: true,
      message: 'Cancellation request submitted. May take a few minutes to process.',
    });
  } catch (error) {
    console.error('[Subscription] Cancel error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/subscription/pause/:subId
 * ───────────────────────────────────
 * Pauses an ACTIVE subscription via Cashfree. Recurring debits stop until resumed.
 */
router.post('/pause/:subId', async (req, res) => {
  try {
    const { subId } = req.params;
    const subscription = await getSubscriptionById(subId);
    if (!subscription) return res.status(404).json({ success: false, error: 'Subscription not found' });

    if (subscription.status !== 'ACTIVE') {
      return res.status(400).json({ success: false, error: `Only ACTIVE subscriptions can be paused (current: ${subscription.status})` });
    }

    const result = await manageSubscription(subId, 'PAUSE');
    if (result.success) {
      await updateSubscriptionStatus(subId, 'PAUSED');
      return res.status(200).json({ success: true, message: 'Subscription paused' });
    }
    return res.status(502).json({ success: false, error: 'Could not pause subscription. Please try again.' });
  } catch (error) {
    console.error('[Subscription] Pause error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/subscription/resume/:subId
 * ────────────────────────────────────
 * Resumes a PAUSED subscription via Cashfree. Recurring debits continue.
 */
router.post('/resume/:subId', async (req, res) => {
  try {
    const { subId } = req.params;
    const subscription = await getSubscriptionById(subId);
    if (!subscription) return res.status(404).json({ success: false, error: 'Subscription not found' });

    if (subscription.status !== 'PAUSED') {
      return res.status(400).json({ success: false, error: `Only PAUSED subscriptions can be resumed (current: ${subscription.status})` });
    }

    const result = await manageSubscription(subId, 'RESUME');
    if (result.success) {
      await updateSubscriptionStatus(subId, 'ACTIVE');
      return res.status(200).json({ success: true, message: 'Subscription resumed' });
    }
    return res.status(502).json({ success: false, error: 'Could not resume subscription. Please try again.' });
  } catch (error) {
    console.error('[Subscription] Resume error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

function getFirstChargeTimeOverride(firstChargeDelayHours) {
  if (firstChargeDelayHours === undefined || firstChargeDelayHours === null || firstChargeDelayHours === '') {
    return null;
  }

  if (process.env.ALLOW_TEST_FIRST_CHARGE_DELAY !== 'true') {
    return { error: 'First charge delay override is disabled' };
  }

  const hours = Number(firstChargeDelayHours);
  if (!Number.isFinite(hours) || hours < 24 || hours > 48) {
    return { error: 'UPI AutoPay first charge cannot be scheduled within 2 hours. Use firstChargeDelayHours between 24 and 48.' };
  }

  return { iso: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() };
}

module.exports = router;
