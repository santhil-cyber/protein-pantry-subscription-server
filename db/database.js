/**
 * SQLite Database for Subscription Records
 * ------------------------------------------
 * Tracks subscriptions, mandate statuses, and webhook events.
 * Uses better-sqlite3 for synchronous, zero-config SQLite.
 */

const Database = require('better-sqlite3');
const path = require('path');

// Database file lives alongside the server code
const DB_PATH = path.join(__dirname, '..', 'subscriptions.db');

let db;

/**
 * Initializes the database and creates tables if they don't exist.
 * Called once at server startup.
 */
function initDatabase() {
  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  // --- Subscriptions table ---
  // Stores each customer's subscription with mandate details
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      product_title TEXT,
      product_variant_id TEXT,
      amount REAL NOT NULL,
      frequency TEXT NOT NULL DEFAULT 'monthly',
      status TEXT NOT NULL DEFAULT 'pending',
      mandate_id TEXT,
      umrn TEXT,
      upi_handle TEXT,
      access_key TEXT,
      checkout_url TEXT,
      start_date TEXT,
      end_date TEXT,
      last_debit_date TEXT,
      next_debit_date TEXT,
      total_debits INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // --- Webhook Events table ---
  // Ensures idempotency: each webhook event is processed only once
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      event_id TEXT,
      transaction_id TEXT,
      payload TEXT NOT NULL,
      processed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(event_type, event_id, transaction_id)
    );
  `);

  // --- Debit History table ---
  // Logs every presentment (debit) attempt and its result
  db.exec(`
    CREATE TABLE IF NOT EXISTS debit_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT NOT NULL,
      merchant_request_number TEXT,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      bank_reference_number TEXT,
      pg_transaction_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (transaction_id) REFERENCES subscriptions(transaction_id)
    );
  `);

  console.log('[DB] Database initialized at', DB_PATH);
  return db;
}

// ──────────────────────────────────────
// Subscription CRUD Operations
// ──────────────────────────────────────

/**
 * Creates a new subscription record when a customer initiates the mandate flow.
 * Status starts as 'pending' until the mandate webhook confirms authorization.
 */
function createSubscription(data) {
  const stmt = db.prepare(`
    INSERT INTO subscriptions (
      transaction_id, customer_name, customer_email, customer_phone,
      product_title, product_variant_id, amount, frequency,
      status, access_key, checkout_url, start_date, end_date
    ) VALUES (
      @transactionId, @customerName, @customerEmail, @customerPhone,
      @productTitle, @productVariantId, @amount, @frequency,
      'pending', @accessKey, @checkoutUrl, @startDate, @endDate
    )
  `);

  return stmt.run(data);
}

/**
 * Updates a subscription's status (e.g., pending → authorized → active).
 * Called when mandate webhooks arrive.
 */
function updateSubscriptionStatus(transactionId, status, extraData = {}) {
  let setClause = `status = @status, updated_at = datetime('now')`;
  const params = { transactionId, status };

  if (extraData.mandateId) {
    setClause += ', mandate_id = @mandateId';
    params.mandateId = extraData.mandateId;
  }
  if (extraData.umrn) {
    setClause += ', umrn = @umrn';
    params.umrn = extraData.umrn;
  }
  if (extraData.upiHandle) {
    setClause += ', upi_handle = @upiHandle';
    params.upiHandle = extraData.upiHandle;
  }
  if (extraData.lastDebitDate) {
    setClause += ', last_debit_date = @lastDebitDate';
    params.lastDebitDate = extraData.lastDebitDate;
  }
  if (extraData.nextDebitDate) {
    setClause += ', next_debit_date = @nextDebitDate';
    params.nextDebitDate = extraData.nextDebitDate;
  }

  const stmt = db.prepare(
    `UPDATE subscriptions SET ${setClause} WHERE transaction_id = @transactionId`
  );

  return stmt.run(params);
}

/** Increments the total_debits counter after a successful presentment */
function incrementDebitCount(transactionId) {
  const stmt = db.prepare(`
    UPDATE subscriptions
    SET total_debits = total_debits + 1, updated_at = datetime('now')
    WHERE transaction_id = ?
  `);
  return stmt.run(transactionId);
}

/** Retrieves a subscription by its transaction ID */
function getSubscriptionByTxnId(transactionId) {
  return db.prepare('SELECT * FROM subscriptions WHERE transaction_id = ?').get(transactionId);
}

/** Retrieves all subscriptions for a customer by email */
function getSubscriptionsByEmail(email) {
  return db.prepare('SELECT * FROM subscriptions WHERE customer_email = ? ORDER BY created_at DESC').all(email);
}

/** Retrieves all active subscriptions (for scheduled debit processing) */
function getActiveSubscriptions() {
  return db.prepare("SELECT * FROM subscriptions WHERE status = 'authorized' OR status = 'active'").all();
}

// ──────────────────────────────────────
// Webhook Idempotency
// ──────────────────────────────────────

/**
 * Checks if a webhook event has already been processed.
 * Prevents duplicate processing if Easebuzz retries delivery.
 *
 * @returns {boolean} true if this event was already processed
 */
function isWebhookProcessed(eventType, eventId, transactionId) {
  const row = db.prepare(
    'SELECT id FROM webhook_events WHERE event_type = ? AND event_id = ? AND transaction_id = ?'
  ).get(eventType, eventId || '', transactionId || '');
  return !!row;
}

/** Records a webhook event as processed */
function markWebhookProcessed(eventType, eventId, transactionId, payload) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO webhook_events (event_type, event_id, transaction_id, payload)
    VALUES (?, ?, ?, ?)
  `);
  return stmt.run(eventType, eventId || '', transactionId || '', JSON.stringify(payload));
}

// ──────────────────────────────────────
// Debit History
// ──────────────────────────────────────

/** Logs a debit attempt */
function recordDebit(data) {
  const stmt = db.prepare(`
    INSERT INTO debit_history (
      transaction_id, merchant_request_number, amount, status,
      bank_reference_number, pg_transaction_id
    ) VALUES (
      @transactionId, @merchantRequestNumber, @amount, @status,
      @bankReferenceNumber, @pgTransactionId
    )
  `);
  return stmt.run(data);
}

/** Updates a debit record's status */
function updateDebitStatus(merchantRequestNumber, status, bankRefNumber) {
  const stmt = db.prepare(`
    UPDATE debit_history
    SET status = ?, bank_reference_number = ?
    WHERE merchant_request_number = ?
  `);
  return stmt.run(status, bankRefNumber || null, merchantRequestNumber);
}

module.exports = {
  initDatabase,
  createSubscription,
  updateSubscriptionStatus,
  incrementDebitCount,
  getSubscriptionByTxnId,
  getSubscriptionsByEmail,
  getActiveSubscriptions,
  isWebhookProcessed,
  markWebhookProcessed,
  recordDebit,
  updateDebitStatus,
};
