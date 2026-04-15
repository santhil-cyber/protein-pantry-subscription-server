/**
 * Shopify Admin API Client — OAuth 2.0 Client Credentials Grant
 * ──────────────────────────────────────────────────────────────
 * Creates orders in Shopify when a UPI AutoPay charge succeeds.
 *
 * Uses the NEW Shopify Client Credentials grant flow:
 *   - Tokens are short-lived (24 hours)
 *   - Server auto-fetches and caches tokens
 *   - Auto-refreshes before expiry
 *
 * Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 *
 * Environment Variables Required:
 *   SHOPIFY_STORE_DOMAIN  — e.g. "proteinpantry.myshopify.com"
 *   SHOPIFY_CLIENT_ID     — App Client ID from Dev Dashboard
 *   SHOPIFY_CLIENT_SECRET — App Client Secret from Dev Dashboard
 *
 * Legacy Support (optional):
 *   SHOPIFY_ADMIN_TOKEN   — If set, uses static token instead of OAuth
 */

const axios = require('axios');

// ──────────────────────────────────────
// Token Cache (in-memory)
// ──────────────────────────────────────

let cachedToken = {
  accessToken: null,
  expiresAt: 0,        // Unix timestamp (ms) when token expires
  scopes: null,
};

/**
 * Gets Shopify configuration from environment.
 */
function getShopifyConfig() {
  return {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN || 'proteinpantry.myshopify.com',
    clientId: process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
    // Legacy: static admin token (fallback if client credentials not configured)
    staticToken: process.env.SHOPIFY_ADMIN_TOKEN || '',
    apiVersion: '2024-01',
  };
}

// ──────────────────────────────────────
// OAuth 2.0 Client Credentials Grant
// ──────────────────────────────────────

/**
 * Fetches a new access token using the Client Credentials grant.
 *
 * POST https://{store}.myshopify.com/admin/oauth/access_token
 * Body: { client_id, client_secret, grant_type: "client_credentials" }
 *
 * Response: { access_token, scope, expires_in }
 * - expires_in is in seconds (typically 86400 = 24 hours)
 *
 * @returns {Promise<string>} The access token
 */
async function fetchAccessToken() {
  const config = getShopifyConfig();

  const url = `https://${config.storeDomain}/admin/oauth/access_token`;

  try {
    const response = await axios.post(url, {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'client_credentials',
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    const { access_token, expires_in, scope } = response.data;

    if (!access_token) {
      throw new Error('No access_token in response');
    }

    // Cache the token with expiry buffer (refresh 1 hour before expiry)
    const expiresInMs = (expires_in || 86400) * 1000; // default 24h
    const bufferMs = 60 * 60 * 1000; // 1 hour buffer

    cachedToken = {
      accessToken: access_token,
      expiresAt: Date.now() + expiresInMs - bufferMs,
      scopes: scope,
    };

    console.log(`[Shopify] Access token fetched (expires in ${Math.round(expiresInMs / 3600000)}h, scopes: ${scope})`);
    return access_token;
  } catch (error) {
    const errData = error.response?.data || error.message;
    console.error('[Shopify] Token fetch failed:', errData);
    throw new Error(`Failed to fetch Shopify access token: ${typeof errData === 'object' ? JSON.stringify(errData) : errData}`);
  }
}

/**
 * Gets a valid access token — from cache if still valid, otherwise fetches a new one.
 * Supports both:
 *   1. New OAuth Client Credentials flow (SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)
 *   2. Legacy static token (SHOPIFY_ADMIN_TOKEN)
 *
 * @returns {Promise<string>} A valid access token
 */
async function getAccessToken() {
  const config = getShopifyConfig();

  // Legacy mode: static admin token
  if (config.staticToken) {
    return config.staticToken;
  }

  // Client credentials mode
  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      'Shopify auth not configured. Set either SHOPIFY_ADMIN_TOKEN (legacy) ' +
      'or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (OAuth 2.0)'
    );
  }

  // Return cached token if still valid
  if (cachedToken.accessToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.accessToken;
  }

  // Fetch new token
  console.log('[Shopify] Token expired or missing, fetching new one...');
  return await fetchAccessToken();
}

// ──────────────────────────────────────
// Order Creation
// ──────────────────────────────────────

/**
 * Creates an order in Shopify for a successful subscription debit.
 *
 * @param {object} params
 * @param {string} params.customerName   – Customer's full name
 * @param {string} params.customerEmail  – Customer's email
 * @param {string} params.customerPhone  – Customer's phone number
 * @param {string} params.productTitle   – Product name
 * @param {string} params.variantId      – Shopify variant ID
 * @param {number} params.amount         – Amount charged (in ₹)
 * @param {string} params.transactionId  – Subscription ID (for reference)
 * @param {string} [params.frequency]    – Subscription frequency
 * @returns {Promise<object>} – { success, orderId, orderNumber, error }
 */
async function createShopifyOrder(params) {
  let accessToken;

  try {
    accessToken = await getAccessToken();
  } catch (authError) {
    console.error('[Shopify] Auth error:', authError.message);
    return { success: false, error: authError.message };
  }

  const config = getShopifyConfig();

  // Split customer name into first/last
  const nameParts = (params.customerName || 'Subscriber').trim().split(' ');
  const firstName = nameParts[0] || 'Subscriber';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Build the order payload
  const orderPayload = {
    order: {
      // Line items — using variant ID if available, otherwise product title + price
      line_items: [],
      // Customer info
      customer: {
        first_name: firstName,
        last_name: lastName,
        email: params.customerEmail || '',
      },
      // Financial status — already paid via UPI AutoPay
      financial_status: 'paid',
      // Fulfillment status — ready for fulfillment
      fulfillment_status: null,
      // Tags for easy filtering in Shopify Admin
      tags: 'subscription-order, autopay, upi-mandate, cashfree',
      // Note for staff reference
      note: `Subscription auto-order via UPI AutoPay.\nSubscription ID: ${params.transactionId}\nFrequency: ${params.frequency || 'monthly'}`,
      // Don't send order confirmation email (optional — set to true if you want emails)
      send_receipt: true,
      send_fulfillment_receipt: true,
      // Phone
      phone: params.customerPhone ? `+91${params.customerPhone}` : undefined,
      // Billing address (minimal)
      billing_address: {
        first_name: firstName,
        last_name: lastName,
        phone: params.customerPhone ? `+91${params.customerPhone}` : '',
        country: 'India',
        country_code: 'IN',
      },
      // Source name for tracking
      source_name: 'subscription-server',
      // Transactions — record the UPI payment
      transactions: [
        {
          kind: 'sale',
          status: 'success',
          amount: params.amount.toString(),
          gateway: 'UPI AutoPay (Cashfree)',
        },
      ],
    },
  };

  // Add line item: prefer variant_id, fallback to custom line item
  if (params.variantId && params.variantId !== '') {
    orderPayload.order.line_items.push({
      variant_id: parseInt(params.variantId, 10),
      quantity: 1,
    });
  } else {
    // Fallback: custom line item with title and price
    orderPayload.order.line_items.push({
      title: params.productTitle || 'Protein Pantry Subscription',
      quantity: 1,
      price: params.amount.toString(),
      requires_shipping: true,
    });
  }

  try {
    const url = `https://${config.storeDomain}/admin/api/${config.apiVersion}/orders.json`;

    console.log(`[Shopify] Creating order for ${params.customerEmail} — ₹${params.amount}`);

    const response = await axios.post(url, orderPayload, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    if (response.data && response.data.order) {
      const order = response.data.order;
      console.log(`[Shopify] Order created: #${order.order_number} (ID: ${order.id})`);
      return {
        success: true,
        orderId: order.id.toString(),
        orderNumber: order.order_number.toString(),
        orderName: order.name, // e.g., "#1042"
      };
    }

    console.error('[Shopify] Unexpected response:', JSON.stringify(response.data));
    return { success: false, error: 'Unexpected Shopify response' };
  } catch (error) {
    // If token expired mid-request (401), retry once with a fresh token
    if (error.response?.status === 401 && cachedToken.accessToken) {
      console.warn('[Shopify] Token rejected (401), retrying with fresh token...');
      cachedToken = { accessToken: null, expiresAt: 0, scopes: null };
      return createShopifyOrder(params); // Retry once
    }

    const errMsg = error.response?.data?.errors || error.message;
    console.error('[Shopify] Order creation failed:', JSON.stringify(errMsg));
    return {
      success: false,
      error: typeof errMsg === 'object' ? JSON.stringify(errMsg) : errMsg,
    };
  }
}

module.exports = {
  createShopifyOrder,
  getShopifyConfig,
  getAccessToken,
  fetchAccessToken,
};
