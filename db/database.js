/**
 * Subscription persistence layer.
 * Uses Supabase/Postgres when DATABASE_URL (or SUPABASE_DATABASE_URL) is set,
 * and falls back to local SQLite for development.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'subscriptions.db');
const POSTGRES_URL = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL || process.env.POSTGRES_URL || '';

let sqliteDb;
let pgPool;
let dbMode = POSTGRES_URL ? 'postgres' : 'sqlite';

async function initDatabase() {
  if (dbMode === 'postgres') {
    pgPool = new Pool({
      connectionString: POSTGRES_URL,
      ssl: shouldUseSsl(POSTGRES_URL) ? { rejectUnauthorized: false } : false,
      max: Number(process.env.DB_POOL_MAX || 5),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    await initPostgres();
    console.log('[DB] Postgres initialized');
    return pgPool;
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  sqliteDb = new Database(DB_PATH);
  sqliteDb.pragma('journal_mode = WAL');
  initSqlite();
  console.log('[DB] SQLite initialized at', DB_PATH);
  return sqliteDb;
}

function shouldUseSsl(url) {
  return process.env.DB_SSL !== 'false' && !/localhost|127\.0\.0\.1/.test(url);
}

async function initPostgres() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id BIGSERIAL PRIMARY KEY,
      subscription_id TEXT UNIQUE NOT NULL,
      cf_subscription_id TEXT,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      product_title TEXT,
      product_variant_id TEXT,
      product_items TEXT,
      amount DOUBLE PRECISION NOT NULL,
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
      shipping_address TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      event_id TEXT,
      subscription_id TEXT,
      payload TEXT NOT NULL,
      processed_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(event_type, event_id, subscription_id)
    );

    CREATE TABLE IF NOT EXISTS payment_history (
      id BIGSERIAL PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      cf_payment_id TEXT,
      payment_amount DOUBLE PRECISION NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'PENDING',
      payment_type TEXT DEFAULT 'PERIODIC',
      cf_payment_reference TEXT,
      payment_method TEXT,
      failure_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(subscription_id)
    );
  `);

  const subscriptionColumns = [
    ['cf_subscription_id', 'TEXT'],
    ['session_id', 'TEXT'],
    ['plan_id', 'TEXT'],
    ['plan_interval_type', 'TEXT'],
    ['plan_intervals', 'INTEGER DEFAULT 1'],
    ['first_charge_date', 'TEXT'],
    ['next_schedule_date', 'TEXT'],
    ['shipping_address', 'TEXT'],
    ['product_items', 'TEXT'],
  ];

  for (const [name, type] of subscriptionColumns) {
    await pgPool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }
}

function initSqlite() {
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id TEXT UNIQUE NOT NULL,
      cf_subscription_id TEXT,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      product_title TEXT,
      product_variant_id TEXT,
      product_items TEXT,
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

    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      event_id TEXT,
      subscription_id TEXT,
      payload TEXT NOT NULL,
      processed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(event_type, event_id, subscription_id)
    );

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

  const columns = sqliteDb.pragma('table_info(subscriptions)').map(c => c.name);
  const addColumn = (name, definition) => {
    if (!columns.includes(name)) sqliteDb.exec(`ALTER TABLE subscriptions ADD COLUMN ${definition}`);
  };

  addColumn('cf_subscription_id', 'cf_subscription_id TEXT');
  addColumn('session_id', 'session_id TEXT');
  addColumn('plan_id', 'plan_id TEXT');
  addColumn('plan_interval_type', 'plan_interval_type TEXT');
  addColumn('plan_intervals', 'plan_intervals INTEGER DEFAULT 1');
  addColumn('first_charge_date', 'first_charge_date TEXT');
  addColumn('next_schedule_date', 'next_schedule_date TEXT');
  addColumn('shipping_address', 'shipping_address TEXT');
  addColumn('product_items', 'product_items TEXT');
}

async function createSubscription(data) {
  if (dbMode === 'postgres') {
    return pgExec(`
      INSERT INTO subscriptions (
        subscription_id, cf_subscription_id, customer_name, customer_email,
        customer_phone, product_title, product_variant_id, product_items, amount, frequency,
        plan_id, plan_interval_type, plan_intervals, status, session_id,
        checkout_url, start_date, end_date, first_charge_date, next_schedule_date, shipping_address
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, 'INITIALIZED', $14,
        $15, $16, $17, $18, $19, $20
      )
    `, [
      data.subscriptionId, data.cfSubscriptionId, data.customerName, data.customerEmail,
      data.customerPhone, data.productTitle, data.productVariantId, data.productItems, data.amount, data.frequency,
      data.planId, data.planIntervalType, data.planIntervals, data.sessionId,
      data.checkoutUrl, data.startDate, data.endDate, data.firstChargeDate, data.nextScheduleDate, data.shippingAddress,
    ]);
  }

  return sqliteDb.prepare(`
    INSERT INTO subscriptions (
      subscription_id, cf_subscription_id, customer_name, customer_email,
      customer_phone, product_title, product_variant_id, product_items, amount, frequency,
      plan_id, plan_interval_type, plan_intervals, status, session_id,
      checkout_url, start_date, end_date, first_charge_date, next_schedule_date, shipping_address
    ) VALUES (
      @subscriptionId, @cfSubscriptionId, @customerName, @customerEmail,
      @customerPhone, @productTitle, @productVariantId, @productItems, @amount, @frequency,
      @planId, @planIntervalType, @planIntervals, 'INITIALIZED', @sessionId,
      @checkoutUrl, @startDate, @endDate, @firstChargeDate, @nextScheduleDate, @shippingAddress
    )
  `).run(data);
}

async function updateSubscriptionStatus(subscriptionId, status, extraData = {}) {
  if (dbMode === 'postgres') {
    const assignments = ['status = $2', 'updated_at = now()'];
    const params = [subscriptionId, status];

    addOptionalAssignment(assignments, params, extraData.cfSubscriptionId, 'cf_subscription_id');
    addOptionalAssignment(assignments, params, extraData.lastPaymentDate, 'last_payment_date');
    addOptionalAssignment(assignments, params, extraData.nextScheduleDate, 'next_schedule_date');

    return pgExec(
      `UPDATE subscriptions SET ${assignments.join(', ')} WHERE subscription_id = $1`,
      params
    );
  }

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

  return sqliteDb.prepare(
    `UPDATE subscriptions SET ${setClause} WHERE subscription_id = @subscriptionId`
  ).run(params);
}

function addOptionalAssignment(assignments, params, value, columnName) {
  if (!value) return;
  params.push(value);
  assignments.push(`${columnName} = $${params.length}`);
}

async function incrementPaymentCount(subscriptionId) {
  if (dbMode === 'postgres') {
    return pgExec(`
      UPDATE subscriptions
      SET total_payments = total_payments + 1, updated_at = now()
      WHERE subscription_id = $1
    `, [subscriptionId]);
  }

  return sqliteDb.prepare(`
    UPDATE subscriptions
    SET total_payments = total_payments + 1, updated_at = datetime('now')
    WHERE subscription_id = ?
  `).run(subscriptionId);
}

async function getSubscriptionById(subscriptionId) {
  if (dbMode === 'postgres') {
    return pgOne('SELECT * FROM subscriptions WHERE subscription_id = $1', [subscriptionId]);
  }

  return sqliteDb.prepare('SELECT * FROM subscriptions WHERE subscription_id = ?').get(subscriptionId);
}

async function getSubscriptionsByEmail(email) {
  if (dbMode === 'postgres') {
    return pgAll('SELECT * FROM subscriptions WHERE customer_email = $1 ORDER BY created_at DESC', [email]);
  }

  return sqliteDb.prepare('SELECT * FROM subscriptions WHERE customer_email = ? ORDER BY created_at DESC').all(email);
}

async function getActiveSubscriptions() {
  if (dbMode === 'postgres') {
    return pgAll("SELECT * FROM subscriptions WHERE status = 'ACTIVE' OR status = 'BANK_APPROVAL_PENDING'");
  }

  return sqliteDb.prepare("SELECT * FROM subscriptions WHERE status = 'ACTIVE' OR status = 'BANK_APPROVAL_PENDING'").all();
}

async function isWebhookProcessed(eventType, eventId, subscriptionId) {
  const params = [eventType, eventId || '', subscriptionId || ''];

  if (dbMode === 'postgres') {
    const row = await pgOne(
      'SELECT id FROM webhook_events WHERE event_type = $1 AND event_id = $2 AND subscription_id = $3',
      params
    );
    return !!row;
  }

  const row = sqliteDb.prepare(
    'SELECT id FROM webhook_events WHERE event_type = ? AND event_id = ? AND subscription_id = ?'
  ).get(...params);
  return !!row;
}

async function markWebhookProcessed(eventType, eventId, subscriptionId, payload) {
  const params = [eventType, eventId || '', subscriptionId || '', JSON.stringify(payload)];

  if (dbMode === 'postgres') {
    return pgExec(`
      INSERT INTO webhook_events (event_type, event_id, subscription_id, payload)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (event_type, event_id, subscription_id) DO NOTHING
    `, params);
  }

  return sqliteDb.prepare(`
    INSERT OR IGNORE INTO webhook_events (event_type, event_id, subscription_id, payload)
    VALUES (?, ?, ?, ?)
  `).run(...params);
}

async function claimOrderForCycle(cycleKey, subscriptionId) {
  const params = ['SHOPIFY_ORDER_CLAIM', cycleKey || '', subscriptionId || '', '{}'];

  if (dbMode === 'postgres') {
    const result = await pgExec(`
      INSERT INTO webhook_events (event_type, event_id, subscription_id, payload)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (event_type, event_id, subscription_id) DO NOTHING
    `, params);
    return result.changes > 0;
  }

  const result = sqliteDb.prepare(`
    INSERT OR IGNORE INTO webhook_events (event_type, event_id, subscription_id, payload)
    VALUES (?, ?, ?, ?)
  `).run(...params);
  return result.changes > 0;
}

async function isPaymentOrderProcessed(eventId, subscriptionId) {
  const params = [eventId || '', subscriptionId || ''];

  if (dbMode === 'postgres') {
    const row = await pgOne(`
      SELECT id FROM webhook_events
      WHERE event_id = $1
        AND subscription_id = $2
        AND event_type IN (
          'SHOPIFY_ORDER_CREATED',
          'SUBSCRIPTION_PAYMENT_SUCCESS',
          'PAYMENT_STATUS_UPDATE',
          'SUBSCRIPTION_PAYMENT_CONTROLLED_EXECUTION_STATUS',
          'RECONCILE_PAYMENT_SUCCESS'
        )
      LIMIT 1
    `, params);
    return !!row;
  }

  const row = sqliteDb.prepare(`
    SELECT id FROM webhook_events
    WHERE event_id = ?
      AND subscription_id = ?
      AND event_type IN (
        'SHOPIFY_ORDER_CREATED',
        'SUBSCRIPTION_PAYMENT_SUCCESS',
        'PAYMENT_STATUS_UPDATE',
        'SUBSCRIPTION_PAYMENT_CONTROLLED_EXECUTION_STATUS',
        'RECONCILE_PAYMENT_SUCCESS'
      )
    LIMIT 1
  `).get(...params);
  return !!row;
}

async function getPaymentByReference(subscriptionId, cfPaymentId) {
  if (!cfPaymentId) return null;

  if (dbMode === 'postgres') {
    return pgOne(
      'SELECT * FROM payment_history WHERE subscription_id = $1 AND cf_payment_id = $2 LIMIT 1',
      [subscriptionId, cfPaymentId]
    );
  }

  return sqliteDb.prepare(
    'SELECT * FROM payment_history WHERE subscription_id = ? AND cf_payment_id = ? LIMIT 1'
  ).get(subscriptionId, cfPaymentId);
}

async function recordPayment(data) {
  const params = [
    data.subscriptionId,
    data.cfPaymentId,
    data.paymentAmount,
    data.paymentStatus,
    data.paymentType,
    data.cfPaymentReference,
    data.paymentMethod,
    data.failureReason,
  ];

  if (dbMode === 'postgres') {
    return pgExec(`
      INSERT INTO payment_history (
        subscription_id, cf_payment_id, payment_amount, payment_status,
        payment_type, cf_payment_reference, payment_method, failure_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, params);
  }

  return sqliteDb.prepare(`
    INSERT INTO payment_history (
      subscription_id, cf_payment_id, payment_amount, payment_status,
      payment_type, cf_payment_reference, payment_method, failure_reason
    ) VALUES (
      @subscriptionId, @cfPaymentId, @paymentAmount, @paymentStatus,
      @paymentType, @cfPaymentReference, @paymentMethod, @failureReason
    )
  `).run(data);
}

async function updatePaymentStatus(cfPaymentId, status, failureReason) {
  if (dbMode === 'postgres') {
    return pgExec(
      'UPDATE payment_history SET payment_status = $1, failure_reason = $2 WHERE cf_payment_id = $3',
      [status, failureReason || null, cfPaymentId]
    );
  }

  return sqliteDb.prepare(`
    UPDATE payment_history
    SET payment_status = ?, failure_reason = ?
    WHERE cf_payment_id = ?
  `).run(status, failureReason || null, cfPaymentId);
}

async function pgExec(query, params = []) {
  const result = await pgPool.query(query, params);
  return { changes: result.rowCount, rowCount: result.rowCount };
}

async function pgOne(query, params = []) {
  const result = await pgPool.query(query, params);
  return result.rows[0] || null;
}

async function pgAll(query, params = []) {
  const result = await pgPool.query(query, params);
  return result.rows;
}

function getDatabaseMode() {
  return dbMode;
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
  isPaymentOrderProcessed,
  claimOrderForCycle,
  getPaymentByReference,
  recordPayment,
  updatePaymentStatus,
  getDatabaseMode,
};
