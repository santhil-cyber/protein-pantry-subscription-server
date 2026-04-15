/**
 * Cashfree Payments Subscription API Client
 * ───────────────────────────────────────────
 * REST API client for Cashfree's Subscription product.
 * Uses the v2025-01-01 API with header-based authentication.
 *
 * Docs: https://www.cashfree.com/docs/payments/subscription/introduction
 * API Ref: https://www.cashfree.com/docs/api-reference/payments/latest/subscription/overview
 */

const axios = require('axios');
const crypto = require('crypto');

// ──────────────────────────────────────
// Configuration
// ──────────────────────────────────────

function getConfig() {
  const env = process.env.CASHFREE_ENV || 'test';
  const isProduction = env === 'production';

  return {
    appId: process.env.CASHFREE_APP_ID || '',
    secretKey: process.env.CASHFREE_SECRET_KEY || '',
    apiVersion: process.env.CASHFREE_API_VERSION || '2025-01-01',
    baseUrl: isProduction
      ? 'https://api.cashfree.com/pg'
      : 'https://sandbox.cashfree.com/pg',
    // Cashfree checkout page for subscription authorization
    checkoutBase: isProduction
      ? 'https://payments.cashfree.com/subscription'
      : 'https://payments-test.cashfree.com/subscription',
    env,
  };
}

/**
 * Returns standard headers for all Cashfree API calls.
 */
function getHeaders() {
  const config = getConfig();
  return {
    'Content-Type': 'application/json',
    'x-api-version': config.apiVersion,
    'x-client-id': config.appId,
    'x-client-secret': config.secretKey,
  };
}

// ──────────────────────────────────────
// Helpers
// ──────────────────────────────────────

/**
 * Generate a unique subscription ID.
 * Format: PP-SUB-{timestamp36}-{random4hex}
 */
function generateSubscriptionId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `PP-SUB-${ts}-${rand}`;
}

/**
 * Generate a unique plan ID based on product + frequency.
 * Plans are reusable — we create one per product+frequency combination.
 */
function generatePlanId(productHandle, intervalType, intervals) {
  // Sanitize product handle for use in plan ID
  const cleanHandle = (productHandle || 'general')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .substring(0, 20);
  return `PP-${cleanHandle}-${intervals}${intervalType.charAt(0)}`;
}

/**
 * Maps user-facing frequency names to Cashfree plan parameters.
 *
 * @param {string} frequency - One of: '1_week', '2_week', '3_week', 'monthly'
 * @returns {{ intervalType: string, intervals: number, label: string }}
 */
function mapFrequency(frequency) {
  const frequencyMap = {
    '1_week': { intervalType: 'WEEK', intervals: 1, label: 'Every Week' },
    '2_week': { intervalType: 'WEEK', intervals: 2, label: 'Every 2 Weeks' },
    '3_week': { intervalType: 'WEEK', intervals: 3, label: 'Every 3 Weeks' },
    'monthly': { intervalType: 'MONTH', intervals: 1, label: 'Monthly' },
  };

  return frequencyMap[frequency] || frequencyMap['monthly'];
}

// ──────────────────────────────────────
// Plans API
// ──────────────────────────────────────

/**
 * Creates a subscription plan in Cashfree.
 * Plans define the billing frequency and amount template.
 * A plan can be reused across multiple subscriptions.
 *
 * @param {object} params
 * @param {string} params.planId        - Unique plan identifier
 * @param {string} params.planName      - Human-readable plan name
 * @param {number} params.amount        - Recurring charge amount (in ₹)
 * @param {number} params.maxAmount     - Maximum amount per charge
 * @param {string} params.intervalType  - DAY, WEEK, MONTH, or YEAR
 * @param {number} params.intervals     - Number of intervals between charges
 * @param {number} [params.maxCycles]   - Max billing cycles (0 = unlimited)
 * @returns {Promise<object>}
 */
async function createPlan(params) {
  const config = getConfig();

  // Debug: log which credentials are being used (masked)
  console.log(`[Cashfree] Using appId: ${config.appId.substring(0, 8)}..., env: ${config.env}, baseUrl: ${config.baseUrl}`);

  const payload = {
    plan_id: params.planId,
    plan_name: params.planName,
    plan_type: 'PERIODIC',
    plan_currency: 'INR',
    plan_recurring_amount: params.amount,
    plan_max_amount: params.maxAmount || params.amount,
    plan_max_cycles: params.maxCycles || 52, // ~1 year of weekly
    plan_intervals: params.intervals,
    plan_interval_type: params.intervalType,
    plan_note: (params.planNote || 'Protein Pantry Subscribe and Save').replace(/[^a-zA-Z0-9 _.-]/g, ''),
  };

  // Retry up to 2 times on internal server errors
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await axios.post(
        `${config.baseUrl}/plans`,
        payload,
        { headers: getHeaders(), timeout: 30000 }
      );

      console.log(`[Cashfree] Plan created: ${params.planId}`);
      return { success: true, data: response.data };
    } catch (error) {
      // Plan already exists is fine (409 Conflict)
      if (error.response?.status === 409) {
        console.log(`[Cashfree] Plan already exists: ${params.planId}`);
        return { success: true, data: { plan_id: params.planId }, alreadyExists: true };
      }

      // Retry on 500 internal server error
      if (error.response?.status === 500 && attempt < 2) {
        console.warn(`[Cashfree] Plan creation got 500, retrying (attempt ${attempt + 1})...`);
        await new Promise(r => setTimeout(r, 2000)); // Wait 2s before retry
        continue;
      }

      console.error('[Cashfree] Plan creation failed:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
        headers: error.response?.headers,
      });
      return {
        success: false,
        error: error.response?.data?.message || error.message,
        details: error.response?.data,
      };
    }
  }
}

/**
 * Fetches an existing plan by ID.
 */
async function fetchPlan(planId) {
  const config = getConfig();

  try {
    const response = await axios.get(
      `${config.baseUrl}/plans/${planId}`,
      { headers: getHeaders(), timeout: 15000 }
    );
    return { success: true, data: response.data };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}

// ──────────────────────────────────────
// Subscriptions API
// ──────────────────────────────────────

/**
 * Creates a new subscription for a customer.
 * Returns a session ID that is used to construct the payment authorization link.
 *
 * @param {object} params
 * @param {string} params.subscriptionId        - Unique subscription ID
 * @param {string} params.planId                - Plan ID (must already exist)
 * @param {string} params.customerName          - Customer name
 * @param {string} params.customerEmail         - Customer email
 * @param {string} params.customerPhone         - Customer phone (10 digits)
 * @param {number} params.amount                - Recurring amount
 * @param {number} params.maxAmount             - Max amount per debit
 * @param {string} params.intervalType          - WEEK/MONTH/etc
 * @param {number} params.intervals             - Number of intervals
 * @param {string} [params.expiryTime]          - When subscription expires (ISO 8601)
 * @param {string} [params.firstChargeTime]     - When first charge happens (ISO 8601)
 * @param {string} [params.returnUrl]           - URL to redirect after auth
 * @param {string} [params.productTitle]        - Product name for reference
 * @param {string} [params.productVariantId]    - Shopify variant ID
 * @returns {Promise<object>}
 */
async function createSubscription(params) {
  const config = getConfig();

  // First charge: at least T+4 days from now (NPCI rule)
  const now = new Date();
  const firstCharge = new Date(now);
  firstCharge.setDate(firstCharge.getDate() + 5); // T+5 for safety margin
  const firstChargeISO = params.firstChargeTime || firstCharge.toISOString();

  // Expiry: 1 year from now by default
  const expiry = new Date(now);
  expiry.setFullYear(expiry.getFullYear() + 1);
  const expiryISO = params.expiryTime || expiry.toISOString();

  // Session expiry: 30 min from now
  const sessionExpiry = new Date(now);
  sessionExpiry.setMinutes(sessionExpiry.getMinutes() + 30);

  const returnUrl = params.returnUrl
    || process.env.SUCCESS_RETURN_URL
    || `${process.env.WEBHOOK_BASE_URL}/api/subscription/success`;

  const payload = {
    subscription_id: params.subscriptionId,
    customer_details: {
      customer_name: params.customerName,
      customer_email: params.customerEmail,
      customer_phone: params.customerPhone,
    },
    plan_details: {
      plan_id: params.planId,
    },
    authorization_details: {
      authorization_amount: 1, // ₹1 auth amount (refunded automatically)
      authorization_amount_refund: true,
      payment_methods: ['upi'], // ← UPI AUTOPAY ONLY
    },
    subscription_meta: {
      return_url: `${returnUrl}?sub_id=${params.subscriptionId}`,
      notification_channel: ['EMAIL', 'SMS'],
      session_id_expiry: sessionExpiry.toISOString(),
    },
    subscription_expiry_time: expiryISO,
    subscription_first_charge_time: firstChargeISO,
    subscription_tags: {
      product_title: params.productTitle || '',
      product_variant_id: params.productVariantId || '',
      source: 'protein-pantry-pdp',
    },
  };

  try {
    const response = await axios.post(
      `${config.baseUrl}/subscriptions`,
      payload,
      { headers: getHeaders(), timeout: 30000 }
    );

    const data = response.data;
    const sessionId = data.subscription_session_id;

    // Construct the checkout URL for UPI mandate authorization
    const checkoutUrl = sessionId
      ? `${config.checkoutBase}?session_id=${sessionId}`
      : null;

    console.log(`[Cashfree] Subscription created: ${params.subscriptionId} → session: ${sessionId}`);

    return {
      success: true,
      data,
      subscriptionId: data.subscription_id,
      cfSubscriptionId: data.cf_subscription_id,
      sessionId,
      checkoutUrl,
    };
  } catch (error) {
    console.error('[Cashfree] Subscription creation failed:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
      details: error.response?.data,
    };
  }
}

/**
 * Fetches subscription details from Cashfree.
 *
 * @param {string} subscriptionId - The subscription ID
 * @returns {Promise<object>}
 */
async function fetchSubscription(subscriptionId) {
  const config = getConfig();

  try {
    const response = await axios.get(
      `${config.baseUrl}/subscriptions/${subscriptionId}`,
      { headers: getHeaders(), timeout: 15000 }
    );

    return { success: true, data: response.data };
  } catch (error) {
    console.error('[Cashfree] Fetch subscription failed:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}

/**
 * Manages a subscription (cancel, pause, resume, change plan).
 *
 * @param {string} subscriptionId - The subscription to manage
 * @param {string} action - CANCEL, PAUSE, RESUME, CHANGE_PLAN
 * @returns {Promise<object>}
 */
async function manageSubscription(subscriptionId, action) {
  const config = getConfig();

  const payload = {
    subscription_id: subscriptionId,
    action: action, // 'CANCEL', 'PAUSE', 'RESUME'
  };

  try {
    const response = await axios.post(
      `${config.baseUrl}/subscriptions/${subscriptionId}/manage`,
      payload,
      { headers: getHeaders(), timeout: 30000 }
    );

    console.log(`[Cashfree] Subscription ${subscriptionId} → ${action}: OK`);
    return { success: true, data: response.data };
  } catch (error) {
    console.error(`[Cashfree] Manage subscription (${action}) failed:`, error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message,
    };
  }
}

// ──────────────────────────────────────
// Webhook Verification
// ──────────────────────────────────────

/**
 * Verifies a Cashfree webhook signature.
 * Cashfree sends the signature in the `x-cashfree-signature` header.
 * The signature is computed as HMAC-SHA256(timestamp + rawBody, secretKey).
 *
 * @param {string} rawBody - Raw request body string
 * @param {string} timestamp - The `x-cashfree-timestamp` header value
 * @param {string} signature - The `x-cashfree-signature` header value
 * @returns {boolean} Whether the signature is valid
 */
function verifyWebhookSignature(rawBody, timestamp, signature) {
  const config = getConfig();

  const signatureData = timestamp + rawBody;
  const computedSignature = crypto
    .createHmac('sha256', config.secretKey)
    .update(signatureData)
    .digest('base64');

  return computedSignature === signature;
}

module.exports = {
  getConfig,
  generateSubscriptionId,
  generatePlanId,
  mapFrequency,
  createPlan,
  fetchPlan,
  createSubscription,
  fetchSubscription,
  manageSubscription,
  verifyWebhookSignature,
};
