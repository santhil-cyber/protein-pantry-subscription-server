/**
 * Subscription API Routes — Cashfree Integration
 * -------------------------------------------------
 * Handles subscription creation, status checks, and cancellation.
 * These endpoints are called by the Shopify storefront JavaScript.
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

/**
 * POST /api/subscription/create
 * ──────────────────────────────
 * Initiates a new subscription by:
 *   1. Creating a Cashfree Plan (reusable per product+frequency)
 *   2. Creating a Cashfree Subscription linked to that plan
 *   3. Returning the checkout URL for the customer to authorize UPI Autopay
 *
 * Request Body:
 *   - customerName (string, required)
 *   - customerEmail (string, required)
 *   - customerPhone (string, required, 10 digits)
 *   - amount (number, required, the subscription price per cycle)
 *   - frequency (string, required: '1_week', '2_week', '3_week', 'monthly')
 *   - productTitle (string, optional)
 *   - productVariantId (string, optional)
 *   - productHandle (string, optional, used for plan ID generation)
 */
router.post('/create', async (req, res) => {
  try {
    const {
      customerName, customerEmail, customerPhone,
      amount, frequency, productTitle, productVariantId, productHandle,
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

    if (!amount || typeof amount !== 'number' || amount < 1 || amount > 15000) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be between ₹1 and ₹15,000 (UPI AutoPay limit)',
      });
    }

    const validFrequencies = ['1_week', '2_week', '3_week', 'monthly'];
    if (!frequency || !validFrequencies.includes(frequency)) {
      return res.status(400).json({
        success: false,
        error: `Invalid frequency. Must be one of: ${validFrequencies.join(', ')}`,
      });
    }

    // ── Map frequency to Cashfree plan parameters ──
    const freq = mapFrequency(frequency);

    // ── Step 1: Create or reuse a Cashfree Plan ──
    const planId = generatePlanId(productHandle, freq.intervalType, freq.intervals);

    const planResult = await createPlan({
      planId,
      planName: `${(productTitle || 'Protein Pantry').replace(/[^a-zA-Z0-9 _-]/g, '')} - ${freq.label}`,
      amount,
      maxAmount: amount,
      intervalType: freq.intervalType,
      intervals: freq.intervals,
      maxCycles: freq.intervalType === 'MONTH' ? 12 : 52, // 1 year
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
      amount,
      maxAmount: amount,
      intervalType: freq.intervalType,
      intervals: freq.intervals,
      productTitle: productTitle || 'Protein Pantry Subscription',
      productVariantId: productVariantId || '',
    });

    if (!subResult.success) {
      console.error('[Subscription] Cashfree subscription creation failed:', subResult.error);
      return res.status(502).json({ success: false, error: 'Payment gateway error. Please try again.' });
    }

    // ── Step 3: Save to local database ──
    const today = new Date();
    const endDate = new Date(today);
    endDate.setFullYear(endDate.getFullYear() + 1);

    const firstCharge = new Date(today);
    firstCharge.setDate(firstCharge.getDate() + 5);

    createSubscription({
      subscriptionId,
      cfSubscriptionId: subResult.cfSubscriptionId || '',
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim().toLowerCase(),
      customerPhone: customerPhone.trim(),
      productTitle: productTitle || '',
      productVariantId: productVariantId || '',
      amount,
      frequency,
      planId,
      planIntervalType: freq.intervalType,
      planIntervals: freq.intervals,
      sessionId: subResult.sessionId || '',
      checkoutUrl: subResult.checkoutUrl || '',
      startDate: today.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      firstChargeDate: firstCharge.toISOString().split('T')[0],
    });

    console.log(`[Subscription] Created: ${subscriptionId} for ${customerEmail} — ₹${amount}/${frequency}`);

    // ── Return checkout data ──
    const cashfreeEnv = (process.env.CASHFREE_ENV || 'test') === 'production' ? 'production' : 'sandbox';
    return res.status(200).json({
      success: true,
      subscriptionId,
      checkoutUrl: subResult.checkoutUrl,
      sessionId: subResult.sessionId,
      cashfreeEnv,
    });
  } catch (error) {
    console.error('[Subscription] Create error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/subscription/status/:subId
 * ─────────────────────────────────────
 * Returns the current status of a subscription.
 */
router.get('/status/:subId', async (req, res) => {
  try {
    const { subId } = req.params;

    if (!subId) {
      return res.status(400).json({ success: false, error: 'Subscription ID is required' });
    }

    // Check local database first
    const subscription = getSubscriptionById(subId);
    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    // For non-terminal states, also fetch live status from Cashfree
    if (['INITIALIZED', 'BANK_APPROVAL_PENDING', 'ACTIVE'].includes(subscription.status)) {
      try {
        const liveStatus = await fetchCashfreeSubscription(subId);
        if (liveStatus.success && liveStatus.data) {
          return res.status(200).json({
            success: true,
            subscription,
            liveStatus: liveStatus.data,
          });
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
 * ──────────────────────────────────────
 * Returns all subscriptions for a customer by email.
 */
router.get('/customer/:email', (req, res) => {
  try {
    const { email } = req.params;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }

    const subscriptions = getSubscriptionsByEmail(email.toLowerCase());
    return res.status(200).json({ success: true, subscriptions });
  } catch (error) {
    console.error('[Subscription] Customer lookup error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/subscription/cancel/:subId
 * ──────────────────────────────────────
 * Cancels an active subscription.
 */
router.post('/cancel/:subId', async (req, res) => {
  try {
    const { subId } = req.params;

    const subscription = getSubscriptionById(subId);
    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    if (['CANCELLED', 'COMPLETED'].includes(subscription.status)) {
      return res.status(400).json({ success: false, error: `Subscription is already ${subscription.status}` });
    }

    // Call Cashfree to cancel
    const result = await manageSubscription(subId, 'CANCEL');

    if (result.success) {
      updateSubscriptionStatus(subId, 'CANCELLED');
      console.log(`[Subscription] Cancelled: ${subId}`);
      return res.status(200).json({ success: true, message: 'Subscription cancelled successfully' });
    }

    // If Cashfree cancel fails, still mark locally
    updateSubscriptionStatus(subId, 'CANCEL_REQUESTED');
    return res.status(200).json({
      success: true,
      message: 'Cancellation request submitted. May take a few minutes to process.',
    });
  } catch (error) {
    console.error('[Subscription] Cancel error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
