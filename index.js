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
 *   GET  /health                          — Health check
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { initDatabase } = require('./db/database');

const app = express();
const PORT = process.env.SERVER_PORT || 3000;

// ── Security Middleware ──
app.use(helmet());

// ── CORS ──
// Allow requests from the Shopify storefront and local development
const allowedOrigins = [
  process.env.SHOPIFY_STORE_URL || 'https://proteinpantry.in',
  'http://localhost:3000',
  'http://localhost:5000',
  'https://proteinpantry.in',
  'https://www.proteinpantry.in',
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (e.g., Postman, server-to-server, webhooks)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(allowed => origin.startsWith(allowed))) {
      return callback(null, true);
    }
    console.warn(`[CORS] Blocked request from origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
}));

// ── Body Parsing ──
// JSON for API calls and Cashfree webhooks
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Request Logging ──
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// ── Initialize Database ──
initDatabase();

// ── Routes ──
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/webhook', require('./routes/webhook'));
app.use('/api/payments', require('./routes/presentment'));

// ── Health Check ──
app.get('/health', (req, res) => {
  const env = process.env.CASHFREE_ENV || 'test';
  res.status(200).json({
    status: 'ok',
    environment: env,
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    gateway: 'cashfree',
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
app.listen(PORT, () => {
  const env = process.env.CASHFREE_ENV || 'test';
  console.log('');
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║  Protein Pantry Subscription Server v2.0          ║');
  console.log(`║  Gateway: Cashfree Payments                       ║`);
  console.log(`║  Environment: ${env.padEnd(38)}║`);
  console.log(`║  Port: ${String(PORT).padEnd(44)}║`);
  console.log(`║  Time: ${new Date().toISOString().padEnd(44)}║`);
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
