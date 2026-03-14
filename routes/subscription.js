/**
 * Subscription API Routes
 * ------------------------
 * Handles subscription creation, status checks, and cancellation.
 * These endpoints are called by the Shopify storefront JavaScript.
 */

const express = require('express');
const router = express.Router();
const { generateAccessKey, getMandateStatus, cancelMandate, generateTransactionId } = require('../utils/easebuzz-api');
const { createSubscription, getSubscriptionByTxnId, getSubscriptionsByEmail, updateSubscriptionStatus } = require('../db/database');

/**
 * POST /api/subscription/create
 * ──────────────────────────────
 * Initiates a new subscription by generating an Easebuzz access key
 * and returning the checkout URL for mandate authorization.
 *
 * Request Body:
 *   - customerName (string, required)
 *   - customerEmail (string, required)
 *   - customerPhone (string, required, 10 digits)
 *   - amount (number, required, the subscription price per cycle)
 *   - frequency (string, optional, default: 'monthly')
 *   - productTitle (string, optional)
 *   - productVariantId (string, optional)
 *
 * Returns:
 *   - checkoutUrl: URL to redirect the customer for mandate approval
 *   - transactionId: unique ID to track this subscription
 */
router.post('/create', async (req, res) => {
  try {
    const { customerName, customerEmail, customerPhone, amount, frequency, productTitle, productVariantId } = req.body;

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
        error: 'Amount must be between ₹1 and ₹15,000 (UPI AutoPay limit without PIN)',
      });
    }

    const validFrequencies = ['daily', 'weekly', 'fortnightly', 'monthly', 'bi_monthly', 'quarterly', 'half_yearly', 'yearly', 'as_presented'];
    const freq = frequency || 'monthly';
    if (!validFrequencies.includes(freq)) {
      return res.status(400).json({ success: false, error: `Invalid frequency. Must be one of: ${validFrequencies.join(', ')}` });
    }

    // ── Generate unique transaction ID ──
    const transactionId = generateTransactionId();

    // ── Call Easebuzz to get access key ──
    const result = await generateAccessKey({
      transactionId,
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim().toLowerCase(),
      customerPhone: customerPhone.trim(),
      amount,
      frequency: freq,
      productInfo: productTitle || 'Protein Pantry Subscription',
    });

    if (!result.success) {
      console.error('[Subscription] Access key generation failed:', result.error);
      return res.status(502).json({ success: false, error: 'Payment gateway error. Please try again.' });
    }

    // ── Calculate mandate start/end dates ──
    const today = new Date();
    const endDate = new Date(today);
    endDate.setFullYear(endDate.getFullYear() + 1);

    // ── Save subscription record ──
    createSubscription({
      transactionId,
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim().toLowerCase(),
      customerPhone: customerPhone.trim(),
      productTitle: productTitle || '',
      productVariantId: productVariantId || '',
      amount,
      frequency: freq,
      accessKey: result.accessKey,
      checkoutUrl: result.checkoutUrl,
      startDate: today.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
    });

    console.log(`[Subscription] Created: ${transactionId} for ${customerEmail} — ₹${amount}/${freq}`);

    // ── Return checkout URL for customer redirect ──
    return res.status(200).json({
      success: true,
      transactionId,
      checkoutUrl: result.checkoutUrl,
    });
  } catch (error) {
    console.error('[Subscription] Create error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/subscription/status/:txnId
 * ─────────────────────────────────────
 * Returns the current status of a subscription by transaction ID.
 */
router.get('/status/:txnId', async (req, res) => {
  try {
    const { txnId } = req.params;

    if (!txnId) {
      return res.status(400).json({ success: false, error: 'Transaction ID is required' });
    }

    // Check local database first
    const subscription = getSubscriptionByTxnId(txnId);
    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    // Optionally fetch live status from Easebuzz for non-terminal states
    if (['pending', 'authorized'].includes(subscription.status)) {
      try {
        const liveStatus = await getMandateStatus(txnId);
        if (liveStatus.success && liveStatus.data) {
          // Return merged data: local record + live status
          return res.status(200).json({
            success: true,
            subscription,
            liveStatus: liveStatus.data,
          });
        }
      } catch (e) {
        // If live fetch fails, fall through to return local data
        console.warn('[Subscription] Live status fetch failed, using local data');
      }
    }

    return res.status(200).json({
      success: true,
      subscription,
    });
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

    return res.status(200).json({
      success: true,
      subscriptions,
    });
  } catch (error) {
    console.error('[Subscription] Customer lookup error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/subscription/cancel/:txnId
 * ──────────────────────────────────────
 * Cancels an active subscription by revoking the UPI mandate.
 */
router.post('/cancel/:txnId', async (req, res) => {
  try {
    const { txnId } = req.params;

    const subscription = getSubscriptionByTxnId(txnId);
    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    if (['cancelled', 'revoked', 'failed'].includes(subscription.status)) {
      return res.status(400).json({ success: false, error: `Subscription is already ${subscription.status}` });
    }

    // Call Easebuzz to revoke the mandate
    const result = await cancelMandate(txnId);

    if (result.success) {
      updateSubscriptionStatus(txnId, 'cancelled');
      console.log(`[Subscription] Cancelled: ${txnId}`);
      return res.status(200).json({ success: true, message: 'Subscription cancelled successfully' });
    }

    // If Easebuzz revoke fails, still mark locally as cancellation-requested
    updateSubscriptionStatus(txnId, 'cancellation_requested');
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
