/**
 * Shopify Admin API Client
 * ─────────────────────────
 * Creates orders in Shopify when a UPI AutoPay debit (presentment) succeeds.
 * This ensures subscribers automatically receive their orders each billing cycle.
 *
 * Environment Variables Required:
 *   SHOPIFY_STORE_DOMAIN  — e.g. "proteinpantry.myshopify.com"
 *   SHOPIFY_ADMIN_TOKEN   — Admin API access token (starts with shpat_)
 */

const axios = require('axios');

/**
 * Gets Shopify Admin API configuration from environment.
 */
function getShopifyConfig() {
  return {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN || 'proteinpantry.myshopify.com',
    accessToken: process.env.SHOPIFY_ADMIN_TOKEN || '',
    apiVersion: '2024-01',
  };
}

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
 * @param {string} params.transactionId  – UPI mandate transaction ID (for reference)
 * @param {string} [params.frequency]    – Subscription frequency
 * @returns {Promise<object>} – { success, orderId, orderNumber, error }
 */
async function createShopifyOrder(params) {
  const config = getShopifyConfig();

  if (!config.accessToken) {
    console.error('[Shopify] Admin API token not configured. Set SHOPIFY_ADMIN_TOKEN env var.');
    return { success: false, error: 'Shopify Admin API token not configured' };
  }

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
      tags: 'subscription-order, autopay, upi-mandate',
      // Note for staff reference
      note: `Subscription auto-order via UPI AutoPay.\nMandate ID: ${params.transactionId}\nFrequency: ${params.frequency || 'monthly'}`,
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
          gateway: 'UPI AutoPay (Easebuzz)',
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
        'X-Shopify-Access-Token': config.accessToken,
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
};
