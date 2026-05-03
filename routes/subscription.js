/**
 * Subscription API Routes — Easebuzz UPI AutoPay
 * -------------------------------------------------
 * Handles subscription creation, status checks, and cancellation.
 * Uses Easebuzz Auto-Collect (UPI 2.0) for mandate-based recurring payments.
 *
 * Flow:
 *   1. Frontend calls POST /create with customer + product + frequency
 *   2. Server calls Easebuzz generateAccessKey → returns checkout URL
 *   3. Customer authorizes UPI mandate on Easebuzz checkout page
 *   4. Easebuzz webhook fires → updateSubscriptionStatus
 */

const express = require('express');
const router = express.Router();
const {
  generateAccessKey,
  generateTransactionId,
} = require('../utils/easebuzz-api');
const {
  createSubscription,
  getSubscriptionById,
  getSubscriptionsByEmail,
  updateSubscriptionStatus,
} = require('../db/database');
const { lookupCustomerAddress } = require('../utils/shopify-api');

/**
 * Maps frontend frequency strings to Easebuzz frequency values.
 * Easebuzz supports: daily, weekly, fortnightly, monthly, bimonthly,
 *                    quarterly, halfyearly, yearly, as_presented
 */
function mapFrequencyToEasebuzz(frequency) {
  const map = {
    '1_week':  { freq: 'weekly',       label: 'Every Week' },
    '2_week':  { freq: 'fortnightly',  label: 'Every 2 Weeks' },
    '3_week':  { freq: 'as_presented', label: 'Every 3 Weeks' },
    'monthly': { freq: 'monthly',      label: 'Monthly' },
  };
  return map[frequency] || map['monthly'];
}

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

/**
 * POST /api/subscription/create
 * ──────────────────────────────
 * Body: { customerName, customerEmail, customerPhone, amount, frequency,
 *         productTitle, productVariantId, productHandle, shippingAddress }
 */
router.post('/create', async (req, res) => {
  try {
    const {
      customerName, customerEmail, customerPhone,
      amount, frequency, productTitle, productVariantId, productHandle,
      shippingAddress,
    } = req.body;

    // ── Validation ──
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
      return res.status(400).json({ success: false, error: 'Amount must be between ₹1 and ₹15,000' });
    }

    const validFrequencies = ['1_week', '2_week', '3_week', 'monthly'];
    if (!frequency || !validFrequencies.includes(frequency)) {
      return res.status(400).json({
        success: false,
        error: `Invalid frequency. Must be one of: ${validFrequencies.join(', ')}`,
      });
    }

    // ── Map frequency ──
    const freqMap = mapFrequencyToEasebuzz(frequency);

    // ── Generate Easebuzz Access Key (mandate checkout URL) ──
    const transactionId = generateTransactionId();

    const accessKeyResult = await generateAccessKey({
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim().toLowerCase(),
      customerPhone: customerPhone.trim(),
      amount,
      frequency: freqMap.freq,
      productInfo: (productTitle || 'Protein Pantry Subscription').replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 100),
      transactionId,
    });

    if (!accessKeyResult.success) {
      console.error('[Subscription] Easebuzz access key failed:', accessKeyResult.error);
      return res.status(502).json({ success: false, error: 'Payment gateway error. Please try again.' });
    }

    // ── Save to local database ──
    const today = new Date();
    const endDate = new Date(today);
    endDate.setFullYear(endDate.getFullYear() + 1);
    const firstCharge = new Date(today);
    firstCharge.setDate(firstCharge.getDate() + 5);

    try {
      createSubscription({
        subscriptionId: transactionId,
        cfSubscriptionId: accessKeyResult.accessKey || '',
        customerName: customerName.trim(),
        customerEmail: customerEmail.trim().toLowerCase(),
        customerPhone: customerPhone.trim(),
        productTitle: productTitle || '',
        productVariantId: productVariantId || '',
        amount,
        frequency,
        planId: freqMap.freq,
        planIntervalType: freqMap.freq,
        planIntervals: 1,
        sessionId: accessKeyResult.accessKey || '',
        checkoutUrl: accessKeyResult.checkoutUrl || '',
        startDate: today.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        firstChargeDate: firstCharge.toISOString().split('T')[0],
        shippingAddress: shippingAddress ? JSON.stringify(shippingAddress) : null,
      });
    } catch (dbErr) {
      // Don't fail the request if DB save fails — the checkout URL is the important part
      console.warn('[Subscription] DB save warning:', dbErr.message);
    }

    console.log(`[Subscription] Created: ${transactionId} for ${customerEmail} — ₹${amount}/${frequency}`);

    return res.status(200).json({
      success: true,
      subscriptionId: transactionId,
      checkoutUrl: accessKeyResult.checkoutUrl,
      accessKey: accessKeyResult.accessKey,
    });
  } catch (error) {
    console.error('[Subscription] Create error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/subscription/status/:subId
 */
router.get('/status/:subId', (req, res) => {
  try {
    const { subId } = req.params;
    if (!subId) return res.status(400).json({ success: false, error: 'Subscription ID is required' });
    const subscription = getSubscriptionById(subId);
    if (!subscription) return res.status(404).json({ success: false, error: 'Subscription not found' });
    return res.status(200).json({ success: true, subscription });
  } catch (error) {
    console.error('[Subscription] Status error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/subscription/customer/:email
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
 */
router.post('/cancel/:subId', (req, res) => {
  try {
    const { subId } = req.params;
    const subscription = getSubscriptionById(subId);
    if (!subscription) return res.status(404).json({ success: false, error: 'Subscription not found' });
    if (['CANCELLED', 'COMPLETED'].includes(subscription.status)) {
      return res.status(400).json({ success: false, error: `Subscription is already ${subscription.status}` });
    }
    updateSubscriptionStatus(subId, 'CANCELLED');
    return res.status(200).json({ success: true, message: 'Subscription cancelled successfully' });
  } catch (error) {
    console.error('[Subscription] Cancel error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
