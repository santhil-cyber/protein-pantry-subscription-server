/**
 * SQLite Database for Subscription Records
 * ------------------------------------------
 * Tracks subscriptions, mandate statuses, and webhook events.
 * Updated for Cashfree Payments Subscription API.
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
  // Stores each customer's subscription with Cashfree mandate details
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id TEXT UNIQUE NOT NULL,
      cf_subscription_id TEXT,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      product_title TEXT,
      product_variant_id TEXT,
      amount REAL NOT NULL,
      frequency TEXT NOT NULL DEFAULT 'monthly',
      plan_id TEXT,
      plan_interval_type TEXT,
      plan_intervals INTEGER DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'INITIALIZED',
      session_id TEXT,
      checkout_url TEXT,
      start_date TEXT,
      end_date TEXT,
      first_charge_date TEXT,
      last_payment_date TEXT,
      next_schedule_date TEXT,
      total_payments INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Add new columns if upgrading from old schema (graceful migration)
  const columns = db.pragma('table_info(subscriptions)').map(c => c.name);
  
  if (!columns.includes('cf_subscription_id')) {
    db.exec(`ALTER TABLE subscriptions ADD COLUMN cf_subscription_id TEXT;`);
  }
  if (!columns.includes('session_id')) {
    db.exec(`ALTER TABLE subscriptions ADD COLUMN session_id TEXT;`);
  }
  if (!columns.includes('plan_id')) {
    db.exec(`ALTER TABLE subscriptions ADD COLUMN plan_id TEXT;`);
  }
  if (!columns.includes('plan_interval_type')) {
    db.exec(`ALTER TABLE subscriptions ADD COLUMN plan_interval_type TEXT;`);
  }
  if (!columns.includes('plan_intervals')) {
    db.exec(`ALTER TABLE subscriptions ADD COLUMN plan_intervals INTEGER DEFAULT 1;`);
  }
  if (!columns.includes('first_charge_date')) {
    db.exec(`ALTER TABLE subscriptions ADD COLUMN first_charge_date TEXT;`);
  }
  if (!columns.includes('next_schedule_date')) {
    db.exec(`ALTER TABLE subscriptions ADD COLUMN next_schedule_date TEXT;`);
  }
  if (!columns.includes('shipping_address')) {
    db.exec(`ALTER TABLE subscriptions ADD COLUMN shipping_address TEXT;`);
  }

  // --- Webhook Events table ---
  // Ensures idempotency: each webhook event is processed only once
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      event_id TEXT,
      subscription_id TEXT,
      payload TEXT NOT NULL,
      processed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(event_type, event_id, subscription_id)
    );
  `);

  // --- Payment History table ---
  // Logs every payment (charge) attempt and its result
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id TEXT NOT NULL,
      cf_payment_id TEXT,
      payment_amount REAL NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'PENDING',
      payment_type TEXT DEFAULT 'PERIODIC',
      cf_payment_reference TEXT,
      payment_method TEXT,
      failure_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(subscription_id)
    );
  `);

  console.log('[DB] Database initialized at', DB_PATH);
  return db;
}

// ──────────────────────────────────────
// Subscription CRUD Operations
// ──────────────────────────────────────

/**
 * Creates a new subscription record when a customer initiates the flow.
 * Status starts as 'INITIALIZED' until Cashfree confirms authorization.
 */
function createSubscription(data) {
  const stmt = db.prepare(`
    INSERT INTO subscriptions (
      subscription_id, cf_subscription_id, customer_name, customer_email,
      customer_phone, product_title, product_variant_id, amount, frequency,
      plan_id, plan_interval_type, plan_intervals, status, session_id,
      checkout_url, start_date, end_date, first_charge_date, shipping_address
    ) VALUES (
      @subscriptionId, @cfSubscriptionId, @customerName, @customerEmail,
      @customerPhone, @productTitle, @productVariantId, @amount, @frequency,
      @planId, @planIntervalType, @planIntervals, 'INITIALIZED', @sessionId,
      @checkoutUrl, @startDate, @endDate, @firstChargeDate, @shippingAddress
    )
  `);

  return stmt.run(data);
}

/**
 * Updates a subscription's status.
 * Called when Cashfree webhooks arrive.
 *
 * Cashfree statuses: INITIALIZED, BANK_APPROVAL_PENDING, ACTIVE, ON_HOLD,
 *                    CANCELLED, COMPLETED, PAST_DUE_DATE
 */
function updateSubscriptionStatus(subscriptionId, status, extraData = {}) {
  let setClause = `status = @status, updated_at = datetime('now')`;
  const params = { subscriptionId, status };

  if (extraData.cfSubscriptionId) {
    setClause += ', cf_subscription_id = @cfSubscriptionId';
    params.cfSubscriptionId = extraData.cfSubscriptionId;
  }
  if (extraData.lastPaymentDate) {
    setClause += ', last_payment_date = @lastPaymentDate';
    params.lastPaymentDate = extraData.lastPaymentDate;
  }
  if (extraData.nextScheduleDate) {
    setClause += ', next_schedule_date = @nextScheduleDate';
    params.nextScheduleDate = extraData.nextScheduleDate;
  }

  const stmt = db.prepare(
    `UPDATE subscriptions SET ${setClause} WHERE subscription_id = @subscriptionId`
  );

  return stmt.run(params);
}

/** Increments the total_payments counter after a successful charge */
function incrementPaymentCount(subscriptionId) {
  const stmt = db.prepare(`
    UPDATE subscriptions
    SET total_payments = total_payments + 1, updated_at = datetime('now')
    WHERE subscription_id = ?
  `);
  return stmt.run(subscriptionId);
}

/** Retrieves a subscription by its subscription ID */
function getSubscriptionById(subscriptionId) {
  return db.prepare('SELECT * FROM subscriptions WHERE subscription_id = ?').get(subscriptionId);
}

/** Retrieves all subscriptions for a customer by email */
function getSubscriptionsByEmail(email) {
  return db.prepare('SELECT * FROM subscriptions WHERE customer_email = ? ORDER BY created_at DESC').all(email);
}

/** Retrieves all active subscriptions (for admin dashboard) */
function getActiveSubscriptions() {
  return db.prepare("SELECT * FROM subscriptions WHERE status = 'ACTIVE' OR status = 'BANK_APPROVAL_PENDING'").all();
}

// ──────────────────────────────────────
// Webhook Idempotency
// ──────────────────────────────────────

/**
 * Checks if a webhook event has already been processed.
 * Prevents duplicate processing if Cashfree retries delivery.
 */
function isWebhookProcessed(eventType, eventId, subscriptionId) {
  const row = db.prepare(
    'SELECT id FROM webhook_events WHERE event_type = ? AND event_id = ? AND subscription_id = ?'
  ).get(eventType, eventId || '', subscriptionId || '');
  return !!row;
}

/** Records a webhook event as processed */
function markWebhookProcessed(eventType, eventId, subscriptionId, payload) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO webhook_events (event_type, event_id, subscription_id, payload)
    VALUES (?, ?, ?, ?)
  `);
  return stmt.run(eventType, eventId || '', subscriptionId || '', JSON.stringify(payload));
}

// ──────────────────────────────────────
// Payment History
// ──────────────────────────────────────

/** Logs a payment attempt */
function recordPayment(data) {
  const stmt = db.prepare(`
    INSERT INTO payment_history (
      subscription_id, cf_payment_id, payment_amount, payment_status,
      payment_type, cf_payment_reference, payment_method, failure_reason
    ) VALUES (
      @subscriptionId, @cfPaymentId, @paymentAmount, @paymentStatus,
      @paymentType, @cfPaymentReference, @paymentMethod, @failureReason
    )
  `);
  return stmt.run(data);
}

/** Updates a payment record's status */
function updatePaymentStatus(cfPaymentId, status, failureReason) {
  const stmt = db.prepare(`
    UPDATE payment_history
    SET payment_status = ?, failure_reason = ?
    WHERE cf_payment_id = ?
  `);
  return stmt.run(status, failureReason || null, cfPaymentId);
}

module.exports = {
  initDatabase,
  createSubscription,
  updateSubscriptionStatus,
  incrementPaymentCount,
  getSubscriptionById,
  getSubscriptionsByEmail,
  getActiveSubscriptions,
  isWebhookProcessed,
  markWebhookProcessed,
  recordPayment,
  updatePaymentStatus,
};
