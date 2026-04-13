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
const { fetchSubscription } = require('../utils/cashfree-api');
const { getSubscriptionById, getActiveSubscriptions } = require('../db/database');

/**
 * GET /api/payments/active
 * ─────────────────────────
 * Lists all active subscriptions.
 * Useful for admin dashboards.
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
    const local = getSubscriptionById(subId);
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

module.exports = router;
