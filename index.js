/**
 * Protein Pantry — Subscription Server
 * ──────────────────────────────────────
 * Express.js backend for Cashfree UPI AutoPay Subscription integration.
 *
 * Endpoints:
 *   POST /api/subscription/create         — Create new subscription (returns checkout URL)
 *   GET  /api/subscription/status/:id     — Check subscription status
 *   GET  /api/subscription/customer/:email — Get customer's subscriptions
 *   POST /api/subscription/cancel/:id     — Cancel a subscription
 *   POST /api/webhook/cashfree            — Cashfree webhook receiver
 *   GET  /api/payments/active             — List active subscriptions
 *   GET  /api/payments/status/:id         — Get live status from Cashfree
 *   GET  /api/payments/history/:id        — Get Cashfree payment history
 *   POST /api/payments/reconcile/:id      — Recover missed payment webhooks
 *   GET  /health                          — Health check
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { initDatabase, getDatabaseMode } = require('./db/database');

const app = express();
const PORT = process.env.SERVER_PORT || 3000;

// ── Security Middleware ──
// Default helmet sets Cross-Origin-Resource-Policy: same-origin, which blocks
// the customer-account UI extension (a null-origin Web Worker) from reading our
// API responses — fetch fails with "Failed to fetch". Relax CORP to cross-origin
// so cross-origin callers can read responses (access is still gated by CORS above).
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ── CORS ──
// Allow requests from the Shopify storefront and local development
const allowedOrigins = [
  process.env.SHOPIFY_STORE_URL || 'https://proteinpantry.in',
  'http://localhost:3000',
  'http://localhost:5000',
  'https://proteinpantry.in',
  'https://www.proteinpantry.in',
  'https://0nb9nh-8p.myshopify.com',
  // Customer-account UI extension runs on Shopify-hosted account origins.
  'https://shopify.com',
  'https://account.shopify.com',
  process.env.SHOPIFY_STORE_DOMAIN ? `https://${process.env.SHOPIFY_STORE_DOMAIN}` : '',
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (e.g., Postman, server-to-server, webhooks)
    if (!origin) return callback(null, true);
    // Customer-account UI extensions run in a Web Worker whose requests carry the
    // literal Origin string "null". Allow it so the Subscriptions page can call us.
    if (origin === 'null') return callback(null, true);
    if (allowedOrigins.some(allowed => origin.startsWith(allowed))) {
      return callback(null, true);
    }
    console.warn(`[CORS] Blocked request from origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
}));

// ── Body Parsing ──
// Keep the exact raw JSON string so Cashfree webhook signatures can be verified.
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Request Logging ──
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// ── Routes ──
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/webhook', require('./routes/webhook'));
app.use('/api/payments', require('./routes/presentment'));

// ── Health Check ──
app.get('/health', (req, res) => {
  const env = process.env.CASHFREE_ENV || 'test';
  const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN || '';
  const shopifyClientId = process.env.SHOPIFY_CLIENT_ID || '';
  const cashfreeAppId = process.env.CASHFREE_APP_ID || '';
  const cashfreeWebhookSecret = process.env.CASHFREE_WEBHOOK_SECRET || '';
  res.status(200).json({
    status: 'ok',
    environment: env,
    timestamp: new Date().toISOString(),
    version: '2.6.6',
    gateway: 'cashfree',
    config: {
      shopify_token: shopifyToken ? `${shopifyToken.substring(0, 8)}...` : 'NOT SET',
      shopify_client_id: shopifyClientId ? `${shopifyClientId.substring(0, 8)}...` : 'NOT SET',
      shopify_domain: process.env.SHOPIFY_STORE_DOMAIN || 'NOT SET',
      cashfree_app_id: cashfreeAppId ? `${cashfreeAppId.substring(0, 8)}...` : 'NOT SET',
      cashfree_env: env,
      cashfree_webhook_secret: cashfreeWebhookSecret ? 'SET' : 'NOT SET',
      database: getDatabaseMode(),
      db_path: process.env.DB_PATH || 'default-local-sqlite',
      test_first_charge_delay: process.env.ALLOW_TEST_FIRST_CHARGE_DELAY === 'true' ? 'ENABLED' : 'disabled',
    },
  });
});

// ── Success/Failure redirect pages ──
// These catch the redirect after mandate authorization and show a simple message.
// Replace with Shopify pages once they're created.
app.get('/api/subscription/success', (req, res) => {
  const subId = req.query.sub_id || '';
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Subscription Activated — Protein Pantry</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body {
          font-family: 'Segoe UI', sans-serif;
          background: #FAF7EF;
          color: #212529;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          margin: 0;
          text-align: center;
        }
        .container { max-width: 500px; padding: 40px 20px; }
        .icon { font-size: 64px; margin-bottom: 20px; }
        h1 { color: #28a745; font-size: 24px; margin-bottom: 10px; }
        p { color: #6c757d; line-height: 1.6; }
        .sub-id { font-size: 12px; color: #adb5bd; margin-top: 8px; }
        a {
          display: inline-block;
          margin-top: 20px;
          background: #FA4616;
          color: white;
          text-decoration: none;
          padding: 12px 30px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">✅</div>
        <h1>Subscription Activated!</h1>
        <p>Your UPI AutoPay mandate has been authorized. You'll receive automatic deliveries as scheduled.</p>
        ${subId ? `<p class="sub-id">Subscription ID: ${subId}</p>` : ''}
        <a href="${process.env.SHOPIFY_STORE_URL || 'https://proteinpantry.in'}">Continue Shopping</a>
      </div>
    </body>
    </html>
  `);
});

app.get('/api/subscription/failure', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Subscription Failed — Protein Pantry</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body {
          font-family: 'Segoe UI', sans-serif;
          background: #FAF7EF;
          color: #212529;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          margin: 0;
          text-align: center;
        }
        .container { max-width: 500px; padding: 40px 20px; }
        .icon { font-size: 64px; margin-bottom: 20px; }
        h1 { color: #dc3545; font-size: 24px; margin-bottom: 10px; }
        p { color: #6c757d; line-height: 1.6; }
        a {
          display: inline-block;
          margin-top: 20px;
          background: #FA4616;
          color: white;
          text-decoration: none;
          padding: 12px 30px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">❌</div>
        <h1>Subscription Setup Failed</h1>
        <p>We couldn't authorize your UPI AutoPay mandate. This could be due to insufficient funds, a cancelled request, or a UPI app error. Please try again.</p>
        <a href="${process.env.SHOPIFY_STORE_URL || 'https://proteinpantry.in'}">Try Again</a>
      </div>
    </body>
    </html>
  `);
});

// ── 404 Handler ──
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ── Global Error Handler ──
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start Server ──
async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      const env = process.env.CASHFREE_ENV || 'test';
      console.log('');
      console.log('╔═══════════════════════════════════════════════════╗');
      console.log('║  Protein Pantry Subscription Server v2.5          ║');
      console.log(`║  Gateway: Cashfree Payments                       ║`);
      console.log(`║  Database: ${getDatabaseMode().padEnd(39)}║`);
      console.log(`║  Environment: ${env.padEnd(38)}║`);
      console.log(`║  Port: ${String(PORT).padEnd(44)}║`);
      console.log(`║  Time: ${new Date().toISOString().padEnd(44)}║`);
      console.log('╚═══════════════════════════════════════════════════╝');
      console.log('');
    });
  } catch (error) {
    console.error('[Server] Failed to initialize:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
