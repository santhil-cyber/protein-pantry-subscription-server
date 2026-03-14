/**
 * Easebuzz AES Encryption & Hash Utilities
 * -----------------------------------------
 * Implements the exact encryption spec from Easebuzz subscription.txt:
 * - AES-256-CBC with SHA-256 derived key (first 32 chars) and IV (first 16 chars)
 * - SHA-512 hash generation for API authentication
 * - Webhook authorization hash verification
 */

const crypto = require('crypto');

/**
 * Derives the AES key from the merchant key using SHA-256.
 * Takes the first 32 hex characters of the SHA-256 digest.
 * This matches the Python reference: hashlib.sha256(key).hexdigest()[:32]
 */
function deriveKey(merchantKey) {
  return crypto
    .createHash('sha256')
    .update(merchantKey, 'utf8')
    .digest('hex')
    .substring(0, 32);
}

/**
 * Derives the AES IV from the merchant salt using SHA-256.
 * Takes the first 16 hex characters of the SHA-256 digest.
 * This matches the Python reference: hashlib.sha256(salt).hexdigest()[:16]
 */
function deriveIV(merchantSalt) {
  return crypto
    .createHash('sha256')
    .update(merchantSalt, 'utf8')
    .digest('hex')
    .substring(0, 16);
}

/**
 * Encrypts plaintext using AES-256-CBC with PKCS7 padding.
 * Mirrors the Python `get_encrypted_details` from subscription.txt exactly.
 *
 * @param {string} merchantKey - Easebuzz merchant key (pg_key)
 * @param {string} merchantSalt - Easebuzz merchant salt (pg_salt)
 * @param {string} plainText - The text to encrypt
 * @returns {string} Base64-encoded ciphertext
 */
function encrypt(merchantKey, merchantSalt, plainText) {
  const key = deriveKey(merchantKey);
  const iv = deriveIV(merchantSalt);

  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  return encrypted;
}

/**
 * Decrypts AES-256-CBC encrypted text.
 * Mirrors the Python `get_decrypt_details` from subscription.txt exactly.
 *
 * @param {string} merchantKey - Easebuzz merchant key (pg_key)
 * @param {string} merchantSalt - Easebuzz merchant salt (pg_salt)
 * @param {string} encryptedText - Base64-encoded ciphertext
 * @returns {string} Decrypted plaintext
 */
function decrypt(merchantKey, merchantSalt, encryptedText) {
  const key = deriveKey(merchantKey);
  const iv = deriveIV(merchantSalt);

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedText, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Generates SHA-512 hash for Easebuzz API authentication.
 * The hash sequence varies by API call — the caller must pass the
 * pipe-delimited string in the correct order.
 *
 * @param {string} hashString - Pipe-delimited string to hash (e.g., "key|txnid|amount|...")
 * @returns {string} SHA-512 hex digest
 */
function generateHash(hashString) {
  return crypto
    .createHash('sha512')
    .update(hashString, 'utf8')
    .digest('hex');
}

/**
 * Verifies the authorization hash in a mandate webhook payload.
 * Hash sequence: {merchant_key}|{transaction_id}|{amount}|{customer_account_number}|
 *                {customer_ifsc}|{customer_upi_handle}|{merchant_salt}
 *
 * @param {object} data - The webhook payload `data` object
 * @param {string} merchantKey - Easebuzz merchant key
 * @param {string} merchantSalt - Easebuzz merchant salt
 * @returns {boolean} Whether the hash is valid
 */
function verifyMandateWebhookHash(data, merchantKey, merchantSalt) {
  const hashSequence = [
    merchantKey,
    data.transaction_id || '',
    data.amount || '',
    data.customer_account_number || '',
    data.customer_ifsc || '',
    data.customer_upi_handle || '',
    merchantSalt,
  ].join('|');

  const computedHash = generateHash(hashSequence);
  return computedHash === data.authorization;
}

/**
 * Verifies the authorization hash in a presentment webhook payload.
 * Hash sequence: {merchant_key}|{transaction_id}|{merchant_request_number}|{status}|{merchant_salt}
 *
 * @param {object} data - The webhook payload `data` object
 * @param {string} merchantKey - Easebuzz merchant key
 * @param {string} merchantSalt - Easebuzz merchant salt
 * @returns {boolean} Whether the hash is valid
 */
function verifyPresentmentWebhookHash(data, merchantKey, merchantSalt) {
  const hashSequence = [
    merchantKey,
    data.mandate?.transaction_id || data.transaction_id || '',
    data.merchant_request_number || '',
    data.status || '',
    merchantSalt,
  ].join('|');

  const computedHash = generateHash(hashSequence);
  return computedHash === data.authorization;
}

module.exports = {
  encrypt,
  decrypt,
  generateHash,
  verifyMandateWebhookHash,
  verifyPresentmentWebhookHash,
};
