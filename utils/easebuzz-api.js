/**
 * Easebuzz UPI AutoPay API Client
 * --------------------------------
 * Wraps all HTTP calls to the Easebuzz Auto-Collect APIs.
 * Handles environment switching (test/production), hash generation,
 * and encryption automatically.
 */

const axios = require('axios');
const crypto = require('crypto');
const { encrypt, generateHash } = require('./encryption');

// Resolve environment-specific base URLs and credentials
function getConfig() {
  const env = process.env.EASEBUZZ_ENV || 'test';
  const isProduction = env === 'production';

  return {
    key: isProduction ? process.env.EASEBUZZ_PROD_KEY : process.env.EASEBUZZ_TEST_KEY,
    salt: isProduction ? process.env.EASEBUZZ_PROD_SALT : process.env.EASEBUZZ_TEST_SALT,
    // Auto-collect API base (for mandate/presentment APIs)
    apiBase: isProduction
      ? 'https://dashboard.easebuzz.in/api/v1'
      : 'https://testdashboard.easebuzz.in/api/v1',
    // Payment checkout base (for redirect flow)
    payBase: isProduction
      ? 'https://pay.easebuzz.in'
      : 'https://testpay.easebuzz.in',
  };
}

/**
 * Generate a unique transaction ID for each mandate.
 * Format: PP-{timestamp}-{random4} to keep it short and traceable.
 */
function generateTransactionId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `PP${ts}${rand}`;
}

/**
 * Step 1: Generate Access Key
 * ----------------------------
 * Creates an access key required before mandate registration.
 * This is the first API call in the subscription flow.
 *
 * @param {object} params - Mandate parameters
 * @param {string} params.customerName - Customer's full name
 * @param {string} params.customerEmail - Customer's email
 * @param {string} params.customerPhone - Customer's phone (10 digits)
 * @param {number} params.amount - Mandate max amount
 * @param {string} params.frequency - Billing cycle (monthly/quarterly/as_presented)
 * @param {string} params.transactionId - Unique transaction identifier
 * @param {string} [params.productInfo] - Product description
 * @returns {Promise<object>} Response with access_key
 */
async function generateAccessKey(params) {
  const config = getConfig();

  // Calculate mandate validity: start today, end 1 year from now
  const today = new Date();
  const endDate = new Date(today);
  endDate.setFullYear(endDate.getFullYear() + 1);

  const startDateStr = formatDate(today);
  const endDateStr = formatDate(endDate);

  // Build the hash string per Easebuzz specification
  // Sequence: key|txnid|amount|productinfo|firstname|email|||||||||||salt
  const hashString = [
    config.key,
    params.transactionId,
    params.amount.toFixed(1),
    params.productInfo || 'Protein Pantry Subscription',
    params.customerName,
    params.customerEmail,
    '', '', '', '', '', '', '', '', '', '', // udf1-udf10 empty
    config.salt,
  ].join('|');

  const hash = generateHash(hashString);

  const payload = {
    key: config.key,
    txnid: params.transactionId,
    amount: params.amount.toFixed(1),
    productinfo: params.productInfo || 'Protein Pantry Subscription',
    firstname: params.customerName,
    email: params.customerEmail,
    phone: params.customerPhone,
    surl: process.env.SUCCESS_URL || `${process.env.WEBHOOK_BASE_URL}/api/subscription/success`,
    furl: process.env.FAILURE_URL || `${process.env.WEBHOOK_BASE_URL}/api/subscription/failure`,
    hash: hash,
    // UPI AutoPay specific fields
    sub_merchant_id: '',
    // Mandate configuration
    recurring_payment_start_date: startDateStr,
    recurring_payment_end_date: endDateStr,
    recurring_payment_amount: params.amount.toFixed(1),
    recurring_payment_frequency: params.frequency || 'monthly',
    recurring_payment_amount_rule: 'max',
    block_fund: 'false', // Always false for recurring mandates
  };

  try {
    const response = await axios.post(
      `${config.payBase}/payment/initiateLink`,
      new URLSearchParams(payload).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
      }
    );

    if (response.data && response.data.status === 1) {
      return {
        success: true,
        accessKey: response.data.data,
        checkoutUrl: `${config.payBase}/pay/${response.data.data}`,
      };
    }

    return {
      success: false,
      error: response.data?.error_desc || response.data?.data || 'Failed to generate access key',
    };
  } catch (error) {
    console.error('[Easebuzz] Access key generation failed:', error.message);
    return {
      success: false,
      error: error.response?.data?.error_desc || error.message,
    };
  }
}

/**
 * Send Pre-Debit Notification
 * ----------------------------
 * Must be sent at least 24 hours before executing a debit.
 * Required by NPCI/RBI regulations for all UPI AutoPay transactions.
 *
 * @param {object} params
 * @param {string} params.transactionId - The mandate's transaction ID
 * @param {string} params.notificationRequestNumber - Unique notification ID
 * @param {number} params.amount - Amount to be debited
 * @param {boolean} [params.schedulePresentment=true] - Auto-execute debit after 24h
 * @returns {Promise<object>} Notification response
 */
async function sendNotification(params) {
  const config = getConfig();

  // Build hash for notification API
  const hashString = [
    config.key,
    params.transactionId,
    params.amount.toFixed(1),
    params.notificationRequestNumber,
    config.salt,
  ].join('|');

  const hash = generateHash(hashString);

  // Encrypt sensitive fields
  const encryptedTxnId = encrypt(config.key, config.salt, params.transactionId);
  const encryptedAmount = encrypt(config.key, config.salt, params.amount.toFixed(1));

  const payload = {
    key: config.key,
    transaction_id: encryptedTxnId,
    notification_request_number: params.notificationRequestNumber,
    amount: encryptedAmount,
    schedule_presentment: params.schedulePresentment !== false ? 'true' : 'false',
    hash: hash,
  };

  try {
    const response = await axios.post(
      `${config.apiBase}/recurring-payment/notify`,
      payload,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    return {
      success: response.data?.success || false,
      data: response.data,
    };
  } catch (error) {
    console.error('[Easebuzz] Notification failed:', error.message);
    return {
      success: false,
      error: error.response?.data || error.message,
    };
  }
}

/**
 * Execute Presentment (Debit)
 * ----------------------------
 * Executes the actual debit against the customer's UPI mandate.
 * Only call this after a successful notification (24h wait for as_presented,
 * 48h for other frequencies).
 *
 * @param {object} params
 * @param {string} params.transactionId - The mandate's transaction ID
 * @param {string} params.merchantRequestNumber - Unique debit request ID
 * @param {number} params.amount - Amount to debit
 * @returns {Promise<object>} Presentment response
 */
async function executePresentment(params) {
  const config = getConfig();

  const hashString = [
    config.key,
    params.transactionId,
    params.amount.toFixed(1),
    params.merchantRequestNumber,
    config.salt,
  ].join('|');

  const hash = generateHash(hashString);

  const encryptedTxnId = encrypt(config.key, config.salt, params.transactionId);
  const encryptedAmount = encrypt(config.key, config.salt, params.amount.toFixed(1));

  const payload = {
    key: config.key,
    transaction_id: encryptedTxnId,
    merchant_request_number: params.merchantRequestNumber,
    amount: encryptedAmount,
    hash: hash,
  };

  try {
    const response = await axios.post(
      `${config.apiBase}/recurring-payment/execute`,
      payload,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    return {
      success: response.data?.success || false,
      data: response.data,
    };
  } catch (error) {
    console.error('[Easebuzz] Presentment execution failed:', error.message);
    return {
      success: false,
      error: error.response?.data || error.message,
    };
  }
}

/**
 * Get Mandate Status
 * -------------------
 * Fetches the current status of a mandate by transaction ID.
 *
 * @param {string} transactionId - The mandate's transaction ID
 * @returns {Promise<object>} Mandate details
 */
async function getMandateStatus(transactionId) {
  const config = getConfig();

  const hashString = [config.key, transactionId, config.salt].join('|');
  const hash = generateHash(hashString);

  const encryptedTxnId = encrypt(config.key, config.salt, transactionId);

  try {
    const response = await axios.get(
      `${config.apiBase}/recurring-payment/mandate`,
      {
        params: {
          key: config.key,
          transaction_id: encryptedTxnId,
          hash: hash,
        },
        timeout: 30000,
      }
    );

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    console.error('[Easebuzz] Mandate status fetch failed:', error.message);
    return {
      success: false,
      error: error.response?.data || error.message,
    };
  }
}

/**
 * Cancel/Revoke Mandate
 * ----------------------
 * Revokes an active mandate so no further debits can occur.
 *
 * @param {string} transactionId - The mandate's transaction ID
 * @returns {Promise<object>} Cancellation result
 */
async function cancelMandate(transactionId) {
  const config = getConfig();

  const hashString = [config.key, transactionId, config.salt].join('|');
  const hash = generateHash(hashString);

  const encryptedTxnId = encrypt(config.key, config.salt, transactionId);

  try {
    const response = await axios.post(
      `${config.apiBase}/recurring-payment/mandate/revoke`,
      {
        key: config.key,
        transaction_id: encryptedTxnId,
        hash: hash,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    return {
      success: response.data?.success || false,
      data: response.data,
    };
  } catch (error) {
    console.error('[Easebuzz] Mandate cancellation failed:', error.message);
    return {
      success: false,
      error: error.response?.data || error.message,
    };
  }
}

/** Formats a Date object as YYYY-MM-DD */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = {
  generateAccessKey,
  sendNotification,
  executePresentment,
  getMandateStatus,
  cancelMandate,
  generateTransactionId,
  getConfig,
};
