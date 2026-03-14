/**
 * Presentment (Debit) Management Routes
 * ───────────────────────────────────────
 * Handles pre-debit notifications and manual debit execution.
 * These are admin-facing endpoints for managing recurring debits.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { sendNotification, executePresentment } = require('../utils/easebuzz-api');
const { getSubscriptionByTxnId, getActiveSubscriptions } = require('../db/database');

/**
 * POST /api/presentment/notify
 * ─────────────────────────────
 * Sends a pre-debit notification for a specific subscription.
 * Must be called at least 24 hours before executing the debit.
 *
 * Body: { transactionId, amount }
 */
router.post('/notify', async (req, res) => {
  try {
    const { transactionId, amount } = req.body;

    if (!transactionId) {
      return res.status(400).json({ success: false, error: 'Transaction ID is required' });
    }

    const subscription = getSubscriptionByTxnId(transactionId);
    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    if (!['authorized', 'active'].includes(subscription.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot notify: subscription is ${subscription.status} (must be authorized or active)`,
      });
    }

    // Generate a unique notification request number
    const notificationRequestNumber = `ntf${crypto.randomBytes(6).toString('hex')}`;

    const result = await sendNotification({
      transactionId,
      notificationRequestNumber,
      amount: amount || subscription.amount,
      schedulePresentment: true, // Auto-execute debit after 24h
    });

    console.log(`[Presentment] Notification sent for ${transactionId}: ${result.success ? 'OK' : 'FAILED'}`);

    return res.status(result.success ? 200 : 502).json({
      success: result.success,
      notificationRequestNumber,
      data: result.data,
      error: result.error,
    });
  } catch (error) {
    console.error('[Presentment] Notify error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/presentment/execute
 * ──────────────────────────────
 * Manually executes a debit against an active mandate.
 * Only use this if schedule_presentment was set to false during notification.
 *
 * Body: { transactionId, amount }
 */
router.post('/execute', async (req, res) => {
  try {
    const { transactionId, amount } = req.body;

    if (!transactionId) {
      return res.status(400).json({ success: false, error: 'Transaction ID is required' });
    }

    const subscription = getSubscriptionByTxnId(transactionId);
    if (!subscription) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    // Generate unique merchant request number for this debit
    const merchantRequestNumber = `dbt${crypto.randomBytes(6).toString('hex')}`;

    const result = await executePresentment({
      transactionId,
      merchantRequestNumber,
      amount: amount || subscription.amount,
    });

    console.log(`[Presentment] Debit executed for ${transactionId}: ${result.success ? 'OK' : 'FAILED'}`);

    return res.status(result.success ? 200 : 502).json({
      success: result.success,
      merchantRequestNumber,
      data: result.data,
      error: result.error,
    });
  } catch (error) {
    console.error('[Presentment] Execute error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/presentment/active
 * ────────────────────────────
 * Lists all active subscriptions that are eligible for debiting.
 * Useful for admin dashboards and cron-based debit scheduling.
 */
router.get('/active', (req, res) => {
  try {
    const active = getActiveSubscriptions();
    return res.status(200).json({
      success: true,
      count: active.length,
      subscriptions: active,
    });
  } catch (error) {
    console.error('[Presentment] Active list error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
