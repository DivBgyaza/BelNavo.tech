const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
require('dotenv').config();
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;
const OWNER_EMAIL = 'belnavo.tech@gmail.com';
const OWNER_WHATSAPP = '+2347037718954';
const BANK_NAME = 'KUDA';
const BANK_ACCOUNT_NUMBER = '2061768688';
const BANK_ACCOUNT_NAME = 'BelNavo tech';
const SITE_URL = String(process.env.SITE_URL || '').trim();
const FLW_PUBLIC_KEY = String(process.env.FLW_PUBLIC_KEY || '').trim();
const FLW_SECRET_KEY = String(process.env.FLW_SECRET_KEY || '').trim();
const FLW_SECRET_HASH = String(process.env.FLW_SECRET_HASH || '').trim();
const CARD_PAYMENT_ENABLED = !!(FLW_PUBLIC_KEY && FLW_SECRET_KEY);
const SESSION_MS = 1000 * 60 * 60 * 24 * 7;
const RESET_MS = 1000 * 60 * 30;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'belnavo-tech.sqlite');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAIL_LOG = path.join(DATA_DIR, 'mail.log');
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || OWNER_EMAIL;
const SMTP_READY = !!(SMTP_USER && SMTP_PASS);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, full_name TEXT NOT NULL, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
  phone TEXT, role TEXT NOT NULL CHECK(role IN ('user','admin')), must_change_password INTEGER NOT NULL DEFAULT 0,
  password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS password_resets(
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pending_registrations(
  id TEXT PRIMARY KEY, full_name TEXT NOT NULL, username TEXT NOT NULL, email TEXT NOT NULL, phone TEXT,
  password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, code_salt TEXT NOT NULL, code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS services(
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL,
  price_ngn INTEGER NOT NULL, duration_days INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY, booking_code TEXT NOT NULL UNIQUE, user_id TEXT, customer_name TEXT NOT NULL, email TEXT NOT NULL,
  phone TEXT, service_id TEXT NOT NULL, brief TEXT, preferred_date TEXT, amount_ngn INTEGER NOT NULL, status TEXT NOT NULL,
  payment_status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(service_id) REFERENCES services(id), FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS payments(
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, provider TEXT NOT NULL, reference TEXT NOT NULL UNIQUE,
  amount_ngn INTEGER NOT NULL, status TEXT NOT NULL, receipt_url TEXT, created_at TEXT NOT NULL, paid_at TEXT,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS transfer_proofs(
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, payer_name TEXT NOT NULL, sender_account TEXT, proof_note TEXT,
  verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, verified_at TEXT,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS notifications(
  id TEXT PRIMARY KEY, user_id TEXT, type TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS audit_logs(
  id TEXT PRIMARY KEY, actor_user_id TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT,
  details_json TEXT, created_at TEXT NOT NULL, FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);
`);

seedServices();
runMigrations();
seedAdmin();
cleanupSessions();
cleanupPendingRegistrations();
autoBackupIfDue();

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(url.pathname, res);
  } catch (error) {
    return sendJson(res, 500, { error: 'Internal server error', details: error.message });
  }
}).listen(PORT, () => console.log(`BelNavo tech app running at http://localhost:${PORT}`));
console.log(SMTP_READY ? 'Email mode: Gmail SMTP enabled.' : 'Email mode: local mail log fallback. Set SMTP_USER and SMTP_PASS in .env to send real email.');

async function handleApi(req, res, url) {
  const session = getSession(req);

  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { status: 'ok' });
  if (req.method === 'GET' && url.pathname === '/api/config') return sendJson(res, 200, { ownerEmail: OWNER_EMAIL, ownerWhatsapp: OWNER_WHATSAPP, mail: { smtpEnabled: SMTP_READY, fromEmail: SMTP_FROM }, payments: { cardEnabled: CARD_PAYMENT_ENABLED, gateway: 'Flutterwave', currency: 'NGN' }, bank: { name: BANK_NAME, accountNumber: BANK_ACCOUNT_NUMBER, accountName: BANK_ACCOUNT_NAME } });

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readBody(req); const out = startRegistration(body);
    if (out.error) return sendJson(res, 400, { error: out.error });
    const token = createSession(out.user.id); setCookie(res, token); addAudit(out.user.id, 'auth_register', 'user', out.user.id, {});
    return sendJson(res, 201, { success: true, user: out.user, message: 'Account created successfully.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/register/verify') {
    return sendJson(res, 410, { error: 'Email verification is no longer required. Please use the main registration form.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/register/resend') {
    return sendJson(res, 410, { error: 'Email verification is no longer required.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req); const out = loginUser(body);
    if (out.error) return sendJson(res, 401, { error: out.error });
    const token = createSession(out.user.id); setCookie(res, token); addAudit(out.user.id, 'auth_login', 'user', out.user.id, {});
    return sendJson(res, 200, { user: out.user });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/forgot-password') {
    const body = await readBody(req); const identifier = String(body?.identifier || '').trim().toLowerCase();
    if (!identifier) return sendJson(res, 400, { error: 'Email or username is required.' });
    const user = db.prepare('SELECT id,email FROM users WHERE LOWER(email)=LOWER(?) OR LOWER(username)=LOWER(?)').get(identifier, identifier);
    if (!user) return sendJson(res, 200, { success: true, message: 'If account exists, reset instructions were created.' });
    const token = crypto.randomUUID(); const now = new Date();
    db.prepare('INSERT INTO password_resets(token,user_id,created_at,expires_at,used) VALUES(?,?,?,?,0)').run(token, user.id, now.toISOString(), new Date(now.getTime() + RESET_MS).toISOString());
    addNotification(user.id, 'password_reset', `Password reset requested. Token: ${token}`);
    sendEmail(user.email, 'Password Reset', `Reset token: ${token}`);
    return sendJson(res, 200, { success: true, message: 'Reset token created.', resetToken: token });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/reset-password') {
    const body = await readBody(req); const token = String(body?.token || '').trim(); const newPassword = String(body?.newPassword || '');
    if (!token || newPassword.length < 6) return sendJson(res, 400, { error: 'Valid token and password are required.' });
    const reset = db.prepare('SELECT user_id AS userId,expires_at AS expiresAt,used FROM password_resets WHERE token=?').get(token);
    if (!reset || reset.used || reset.expiresAt <= new Date().toISOString()) return sendJson(res, 400, { error: 'Invalid or expired token.' });
    const hp = hashPassword(newPassword);
    db.prepare('UPDATE users SET password_salt=?,password_hash=?,must_change_password=0 WHERE id=?').run(hp.salt, hp.hash, reset.userId);
    db.prepare('UPDATE password_resets SET used=1 WHERE token=?').run(token);
    addNotification(reset.userId, 'password_reset_completed', 'Password reset successful.');
    return sendJson(res, 200, { success: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    if (session) { db.prepare('DELETE FROM sessions WHERE token=?').run(session.token); addAudit(session.user.id, 'auth_logout', 'user', session.user.id, {}); }
    clearCookie(res); return sendJson(res, 200, { success: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    if (!session) return sendJson(res, 401, { error: 'Not authenticated' });
    return sendJson(res, 200, { user: session.user });
  }

  if (req.method === 'GET' && url.pathname === '/api/services') return sendJson(res, 200, db.prepare('SELECT id,slug,name,description,price_ngn AS priceNgn,duration_days AS durationDays FROM services WHERE active=1 ORDER BY price_ngn ASC').all());
  if (!session) return sendJson(res, 401, { error: 'Please login first.' });

  if (req.method === 'GET' && url.pathname === '/api/profile') return sendJson(res, 200, { user: session.user });
  if (req.method === 'PUT' && url.pathname === '/api/profile') {
    const body = await readBody(req); const fullName = String(body?.fullName || '').trim(); const phone = String(body?.phone || '').trim();
    if (!fullName) return sendJson(res, 400, { error: 'Full name is required.' });
    db.prepare('UPDATE users SET full_name=?,phone=? WHERE id=?').run(fullName, phone, session.user.id);
    return sendJson(res, 200, { success: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/profile/change-password') {
    const body = await readBody(req); const currentPassword = String(body?.currentPassword || ''); const newPassword = String(body?.newPassword || '');
    if (newPassword.length < 6) return sendJson(res, 400, { error: 'New password must be at least 6 chars.' });
    const row = db.prepare('SELECT password_salt AS salt,password_hash AS hash FROM users WHERE id=?').get(session.user.id);
    if (!row || !verifyPassword(currentPassword, row.salt, row.hash)) return sendJson(res, 401, { error: 'Current password is invalid.' });
    const hp = hashPassword(newPassword);
    db.prepare('UPDATE users SET password_salt=?,password_hash=?,must_change_password=0 WHERE id=?').run(hp.salt, hp.hash, session.user.id);
    return sendJson(res, 200, { success: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/notifications') {
    const rows = session.user.role === 'admin'
      ? db.prepare('SELECT id,type,message,created_at AS createdAt FROM notifications ORDER BY created_at DESC LIMIT 100').all()
      : db.prepare('SELECT id,type,message,created_at AS createdAt FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(session.user.id);
    return sendJson(res, 200, rows);
  }
  if (req.method === 'GET' && url.pathname === '/api/orders') {
    if (session.user.role === 'admin') return sendJson(res, 200, filteredOrders(url));
    return sendJson(res, 200, db.prepare(baseOrderQuery() + ' WHERE o.user_id=? ORDER BY o.created_at DESC').all(session.user.id));
  }
  if (req.method === 'POST' && url.pathname === '/api/orders') {
    const body = await readBody(req); const err = validateOrderPayload(body); if (err) return sendJson(res, 400, { error: err });
    const service = db.prepare('SELECT id,name,price_ngn AS priceNgn FROM services WHERE id=? AND active=1').get(body.serviceId);
    if (!service) return sendJson(res, 404, { error: 'Selected service is unavailable.' });
    const now = new Date().toISOString();
    const order = { id: crypto.randomUUID(), bookingCode: createBookingCode(), userId: session.user.id, customerName: String(body.customerName || '').trim() || session.user.fullName, email: String(body.email || '').trim().toLowerCase() || session.user.email, phone: String(body.phone || session.user.phone || '').trim(), serviceId: service.id, brief: String(body.brief || '').trim(), preferredDate: String(body.preferredDate || '').trim(), amountNgn: service.priceNgn, status: 'new', paymentStatus: 'unpaid', createdAt: now, updatedAt: now };
    db.prepare('INSERT INTO orders(id,booking_code,user_id,customer_name,email,phone,service_id,brief,preferred_date,amount_ngn,status,payment_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(order.id, order.bookingCode, order.userId, order.customerName, order.email, order.phone, order.serviceId, order.brief, order.preferredDate, order.amountNgn, order.status, order.paymentStatus, order.createdAt, order.updatedAt);
    addNotification(order.userId, 'booking_created', `Booking ${order.bookingCode} created.`);
    sendEmail(order.email, 'Booking Created', `Booking code: ${order.bookingCode}`);
    sendEmail(OWNER_EMAIL, 'New Booking Request', `New booking from ${order.customerName} (${order.email}). Service: ${service.name}. Booking code: ${order.bookingCode}. Amount: N${order.amountNgn}. Phone: ${order.phone || 'n/a'}.`);
    return sendJson(res, 201, { orderId: order.id, bookingCode: order.bookingCode, serviceName: service.name, amountNgn: order.amountNgn, status: order.status, paymentStatus: order.paymentStatus });
  }
  if (req.method === 'POST' && url.pathname === '/api/payments/bank-transfer') {
    const body = await readBody(req); const orderId = String(body?.orderId || '').trim(); const payerName = String(body?.payerName || '').trim();
    if (!orderId || !payerName) return sendJson(res, 400, { error: 'orderId and payerName are required.' });
    const order = session.user.role === 'admin'
      ? db.prepare('SELECT id,user_id AS userId,booking_code AS bookingCode,amount_ngn AS amountNgn,payment_status AS paymentStatus,email FROM orders WHERE id=?').get(orderId)
      : db.prepare('SELECT id,user_id AS userId,booking_code AS bookingCode,amount_ngn AS amountNgn,payment_status AS paymentStatus,email FROM orders WHERE id=? AND user_id=?').get(orderId, session.user.id);
    if (!order) return sendJson(res, 404, { error: 'Order not found.' });
    if (order.paymentStatus === 'paid') return sendJson(res, 400, { error: 'Order already marked as paid.' });
    const ref = `TRF-${Date.now()}-${Math.floor(Math.random() * 10000)}`; const now = new Date().toISOString(); const receiptUrl = String(body?.receiptUrl || '').trim();
    db.prepare('INSERT INTO payments(id,order_id,provider,reference,amount_ngn,status,receipt_url,created_at,paid_at) VALUES(?,?,?,?,?,?,?,?,NULL)').run(crypto.randomUUID(), order.id, 'BANK_TRANSFER', ref, order.amountNgn, 'initialized', receiptUrl, now);
    db.prepare('INSERT INTO transfer_proofs(id,order_id,payer_name,sender_account,proof_note,verified,created_at,verified_at) VALUES(?,?,?,?,?,0,?,NULL)').run(crypto.randomUUID(), order.id, payerName, String(body?.senderAccount || '').trim(), String(body?.proofNote || '').trim(), now);
    db.prepare('UPDATE orders SET payment_status=?,status=?,updated_at=? WHERE id=?').run('pending_verification', 'in_progress', now, order.id);
    addNotification(order.userId, 'payment_submitted', `Transfer submitted for ${order.bookingCode}. Ref: ${ref}`);
    sendEmail(OWNER_EMAIL, 'Payment Submitted', `Payment proof submitted for booking ${order.bookingCode}. Ref: ${ref}. Payer: ${payerName}. Sender account: ${String(body?.senderAccount || '').trim() || 'n/a'}.`);
    return sendJson(res, 201, { success: true, reference: ref, bookingCode: order.bookingCode });
  }
  if (req.method === 'POST' && url.pathname === '/api/payments/card/initialize') {
    if (!CARD_PAYMENT_ENABLED) return sendJson(res, 503, { error: 'Card payments are not configured yet. Set FLW_PUBLIC_KEY and FLW_SECRET_KEY in .env.' });
    const body = await readBody(req);
    const orderId = String(body?.orderId || '').trim();
    if (!orderId) return sendJson(res, 400, { error: 'orderId is required.' });
    const order = session.user.role === 'admin'
      ? db.prepare('SELECT o.id,o.user_id AS userId,o.booking_code AS bookingCode,o.customer_name AS customerName,o.email,o.phone,o.amount_ngn AS amountNgn,o.payment_status AS paymentStatus FROM orders o WHERE o.id=?').get(orderId)
      : db.prepare('SELECT o.id,o.user_id AS userId,o.booking_code AS bookingCode,o.customer_name AS customerName,o.email,o.phone,o.amount_ngn AS amountNgn,o.payment_status AS paymentStatus FROM orders o WHERE o.id=? AND o.user_id=?').get(orderId, session.user.id);
    if (!order) return sendJson(res, 404, { error: 'Order not found.' });
    if (order.paymentStatus === 'paid') return sendJson(res, 400, { error: 'Order already marked as paid.' });
    const txRef = `FLW-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const now = new Date().toISOString();
    const origin = getRequestOrigin(req, url);
    const redirectUrl = new URL('/payment-return.html', origin).toString();
    const paymentRow = db.prepare('SELECT id FROM payments WHERE order_id=? AND provider=? LIMIT 1').get(order.id, 'FLUTTERWAVE_CARD');
    if (paymentRow) {
      db.prepare('UPDATE payments SET reference=?,amount_ngn=?,status=?,receipt_url=?,created_at=?,paid_at=NULL WHERE id=?').run(txRef, order.amountNgn, 'initialized', null, now, paymentRow.id);
    } else {
      db.prepare('INSERT INTO payments(id,order_id,provider,reference,amount_ngn,status,receipt_url,created_at,paid_at) VALUES(?,?,?,?,?,?,?,?,NULL)').run(crypto.randomUUID(), order.id, 'FLUTTERWAVE_CARD', txRef, order.amountNgn, 'initialized', null, now);
    }
    db.prepare("UPDATE orders SET payment_status='pending_card',status='in_progress',updated_at=? WHERE id=?").run(now, order.id);
    addNotification(order.userId, 'card_payment_started', `Card checkout started for ${order.bookingCode}.`);
    addAudit(session.user.id, 'card_payment_initialized', 'order', order.id, { txRef });
    const initRes = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        amount: order.amountNgn,
        tx_ref: txRef,
        currency: 'NGN',
        redirect_url: redirectUrl,
        payment_options: 'card',
        customer: {
          name: order.customerName || session.user.fullName,
          email: order.email || session.user.email,
          phone_number: order.phone || session.user.phone || '',
        },
        customizations: {
          title: 'BelNavo tech',
          description: `Payment for ${order.bookingCode}`,
          logo: new URL('/assets/belnavo-logo.png', origin).toString(),
        },
        meta: { orderId: order.id, bookingCode: order.bookingCode },
        configuration: { session_duration: 30 },
      }),
    });
    const initJson = await initRes.json().catch(() => null);
    if (!initRes.ok || !initJson || initJson.status !== 'success' || !initJson.data?.link) {
      db.prepare("UPDATE orders SET payment_status='payment_failed',updated_at=? WHERE id=?").run(new Date().toISOString(), order.id);
      return sendJson(res, 400, { error: initJson?.message || 'Unable to create Flutterwave checkout link.' });
    }
    db.prepare('UPDATE payments SET receipt_url=? WHERE reference=?').run(String(initJson.data.link), txRef);
    return sendJson(res, 200, {
      success: true,
      txRef,
      link: initJson.data.link,
      redirectUrl,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/payments/card/verify') {
    if (!FLW_SECRET_KEY) return sendJson(res, 503, { error: 'Card verification is not configured yet. Set FLW_SECRET_KEY in .env.' });
    const body = await readBody(req);
    const transactionId = Number(body?.transactionId || body?.id || 0);
    const txRef = String(body?.txRef || body?.tx_ref || '').trim();
    if (!transactionId || !txRef) return sendJson(res, 400, { error: 'transactionId and txRef are required.' });
    const payment = db.prepare(`
      SELECT p.id AS paymentId,p.order_id AS orderId,p.reference AS txRef,p.amount_ngn AS expectedAmount,p.status AS paymentStatus,
      o.booking_code AS bookingCode,o.user_id AS userId,o.email,o.customer_name AS customerName
      FROM payments p JOIN orders o ON o.id=p.order_id
      WHERE p.reference=? AND p.provider='FLUTTERWAVE_CARD'
    `).get(txRef);
    if (!payment) return sendJson(res, 404, { error: 'Payment record not found.' });
    const verifyRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
      headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, Accept: 'application/json' },
    });
    const verifyJson = await verifyRes.json().catch(() => null);
    if (!verifyRes.ok || !verifyJson || verifyJson.status !== 'success' || !verifyJson.data) {
      db.prepare("UPDATE payments SET status='failed' WHERE id=?").run(payment.paymentId);
      db.prepare("UPDATE orders SET payment_status='payment_failed',updated_at=? WHERE id=?").run(new Date().toISOString(), payment.orderId);
      return sendJson(res, 400, { error: 'Unable to verify payment.' });
    }
    const tx = verifyJson.data;
    const txCurrency = String(tx.currency || '').toUpperCase();
    const expectedCurrency = 'NGN';
    const amountOk = Number(tx.amount) >= Number(payment.expectedAmount);
    const statusOk = String(tx.status || '').toLowerCase() === 'successful';
    const refOk = String(tx.tx_ref || '').trim() === txRef;
    if (!statusOk || !amountOk || txCurrency !== expectedCurrency || !refOk) {
      db.prepare("UPDATE payments SET status='failed' WHERE id=?").run(payment.paymentId);
      db.prepare("UPDATE orders SET payment_status='payment_failed',updated_at=? WHERE id=?").run(new Date().toISOString(), payment.orderId);
      return sendJson(res, 400, { error: 'Payment did not pass verification checks.' });
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE payments SET status='paid',paid_at=? WHERE id=?").run(now, payment.paymentId);
    db.prepare("UPDATE orders SET payment_status='paid',status='confirmed',updated_at=? WHERE id=?").run(now, payment.orderId);
    addNotification(payment.userId, 'payment_confirmed', `Card payment confirmed for ${payment.bookingCode}.`);
    sendEmail(payment.email, 'Card Payment Confirmed', `Your card payment for booking ${payment.bookingCode} has been confirmed.`);
    sendEmail(OWNER_EMAIL, 'Card Payment Confirmed', `Card payment confirmed for ${payment.bookingCode} (${payment.customerName}).`);
    addAudit(session?.user?.id || null, 'card_payment_verified', 'order', payment.orderId, { txRef, transactionId });
    return sendJson(res, 200, { success: true, bookingCode: payment.bookingCode, amount: payment.expectedAmount });
  }
  if (req.method === 'POST' && url.pathname === '/api/payments/flutterwave/webhook') {
    const signature = String(req.headers['verif-hash'] || req.headers['flutterwave-signature'] || '').trim();
    if (!FLW_SECRET_HASH || !signature || signature !== FLW_SECRET_HASH) return sendJson(res, 401, { error: 'Invalid webhook signature.' });
    const raw = await readRawBody(req);
    let payload = null;
    try { payload = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: 'Invalid webhook payload.' }); }
    const data = payload?.data || {};
    const txRef = String(data.tx_ref || data.txRef || '').trim();
    const transactionId = Number(data.id || 0);
    const eventType = String(payload?.type || '').toLowerCase();
    if (!txRef || !transactionId) return sendJson(res, 200, { success: true, ignored: true });
    if (!['charge.completed', 'transaction.completed', 'payment.completed'].includes(eventType)) return sendJson(res, 200, { success: true, ignored: true });
    const payment = db.prepare(`
      SELECT p.id AS paymentId,p.order_id AS orderId,p.reference AS txRef,p.amount_ngn AS expectedAmount,p.status AS paymentStatus,
      o.booking_code AS bookingCode,o.user_id AS userId,o.email,o.customer_name AS customerName
      FROM payments p JOIN orders o ON o.id=p.order_id
      WHERE p.reference=? AND p.provider='FLUTTERWAVE_CARD'
    `).get(txRef);
    if (!payment) return sendJson(res, 200, { success: true, ignored: true });
    if (String(payment.paymentStatus) === 'paid') return sendJson(res, 200, { success: true, alreadyProcessed: true });
    const verifyRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
      headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, Accept: 'application/json' },
    });
    const verifyJson = await verifyRes.json().catch(() => null);
    if (!verifyRes.ok || !verifyJson || verifyJson.status !== 'success' || !verifyJson.data) return sendJson(res, 200, { success: true, ignored: true });
    const tx = verifyJson.data;
    const txCurrency = String(tx.currency || '').toUpperCase();
    const amountOk = Number(tx.amount) >= Number(payment.expectedAmount);
    const statusOk = String(tx.status || '').toLowerCase() === 'successful';
    const refOk = String(tx.tx_ref || '').trim() === txRef;
    if (!statusOk || !amountOk || txCurrency !== 'NGN' || !refOk) return sendJson(res, 200, { success: true, ignored: true });
    const now = new Date().toISOString();
    db.prepare("UPDATE payments SET status='paid',paid_at=? WHERE id=?").run(now, payment.paymentId);
    db.prepare("UPDATE orders SET payment_status='paid',status='confirmed',updated_at=? WHERE id=?").run(now, payment.orderId);
    addNotification(payment.userId, 'payment_confirmed', `Card payment confirmed for ${payment.bookingCode}.`);
    sendEmail(payment.email, 'Card Payment Confirmed', `Your card payment for booking ${payment.bookingCode} has been confirmed.`);
    sendEmail(OWNER_EMAIL, 'Card Payment Confirmed', `Card payment confirmed for ${payment.bookingCode} (${payment.customerName}).`);
    addAudit(null, 'flutterwave_webhook_verified', 'order', payment.orderId, { txRef, transactionId });
    return sendJson(res, 200, { success: true });
  }

  if (session.user.role !== 'admin') return sendJson(res, 403, { error: 'Admin access required.' });

  if (req.method === 'GET' && url.pathname === '/api/admin/stats') {
    const stats = db.prepare("SELECT (SELECT COUNT(*) FROM orders) AS totalOrders,(SELECT COUNT(*) FROM orders WHERE status='confirmed') AS confirmedOrders,(SELECT COUNT(*) FROM transfer_proofs WHERE verified=0) AS awaitingVerification,(SELECT COUNT(*) FROM orders WHERE payment_status='pending_card') AS pendingCardPayments,(SELECT COALESCE(SUM(amount_ngn),0) FROM orders WHERE payment_status='paid') AS revenueNgn,(SELECT COUNT(*) FROM users WHERE role='user') AS userCount,(SELECT COUNT(*) FROM users WHERE role='user' AND email_verified=1) AS verifiedUserCount,(SELECT COUNT(*) FROM users WHERE role='user' AND created_at>=date('now','start of month')) AS newUserCount").get();
    return sendJson(res, 200, stats);
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/orders') return sendJson(res, 200, filteredOrders(url));
  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const where = [];
    const vals = [];
    if (q) {
      where.push('(LOWER(full_name) LIKE ? OR LOWER(username) LIKE ? OR LOWER(email) LIKE ? OR LOWER(phone) LIKE ?)');
      vals.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const sql = `SELECT u.id,u.full_name AS fullName,u.username,u.email,u.phone,u.role,u.email_verified AS emailVerified,u.created_at AS createdAt,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id) AS totalOrders,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id AND o.payment_status='paid') AS paidOrders
      FROM users u${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY u.created_at DESC`;
    return sendJson(res, 200, db.prepare(sql).all(...vals));
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/analytics') {
    const monthly = db.prepare("SELECT substr(created_at,1,7) AS month, COUNT(*) AS totalOrders, COALESCE(SUM(CASE WHEN payment_status='paid' THEN amount_ngn END),0) AS paidRevenue FROM orders GROUP BY substr(created_at,1,7) ORDER BY month DESC LIMIT 12").all();
    return sendJson(res, 200, { monthly });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/orders/export.csv') {
    const rows = filteredOrders(url);
    const header = 'bookingCode,customerName,email,username,serviceName,amountNgn,status,paymentStatus,createdAt\\n';
    const csv = header + rows.map((r) => [r.bookingCode, r.customerName, r.email, r.username || '', r.serviceName, r.amountNgn, r.status, r.paymentStatus, r.createdAt].map(csvEscape).join(',')).join('\\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=\"orders-export.csv\"' });
    return res.end(csv);
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/admin/orders/') && url.pathname.endsWith('/confirm-payment')) {
    const id = url.pathname.split('/')[4]; const now = new Date().toISOString();
    const order = db.prepare('SELECT user_id AS userId,booking_code AS bookingCode,email FROM orders WHERE id=?').get(id);
    if (!order) return sendJson(res, 404, { error: 'Order not found.' });
    db.prepare("UPDATE orders SET payment_status='paid',status='confirmed',updated_at=? WHERE id=?").run(now, id);
    db.prepare("UPDATE payments SET status='paid',paid_at=? WHERE order_id=?").run(now, id);
    db.prepare('UPDATE transfer_proofs SET verified=1,verified_at=? WHERE order_id=?').run(now, id);
    addNotification(order.userId, 'payment_confirmed', `Payment confirmed for ${order.bookingCode}.`);
    sendEmail(order.email, 'Payment Confirmed', `Booking ${order.bookingCode} payment confirmed.`);
    addAudit(session.user.id, 'admin_confirm_payment', 'order', id, {});
    return sendJson(res, 200, { success: true });
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/admin/orders/') && url.pathname.endsWith('/cancel')) {
    const id = url.pathname.split('/')[4]; const now = new Date().toISOString();
    const order = db.prepare('SELECT user_id AS userId,booking_code AS bookingCode,email FROM orders WHERE id=?').get(id);
    if (!order) return sendJson(res, 404, { error: 'Order not found.' });
    db.prepare("UPDATE orders SET status='cancelled',updated_at=? WHERE id=?").run(now, id);
    addNotification(order.userId, 'booking_cancelled', `Booking ${order.bookingCode} was cancelled.`);
    sendEmail(order.email, 'Booking Cancelled', `Booking ${order.bookingCode} cancelled.`);
    addAudit(session.user.id, 'admin_cancel_order', 'order', id, {});
    return sendJson(res, 200, { success: true });
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/admin/orders/') && url.pathname.endsWith('/status')) {
    const id = url.pathname.split('/')[4]; const body = await readBody(req); const status = String(body?.status || '').trim();
    const allowed = new Set(['new', 'in_progress', 'confirmed', 'delivered', 'closed', 'cancelled']); if (!allowed.has(status)) return sendJson(res, 400, { error: 'Invalid status.' });
    const now = new Date().toISOString(); const order = db.prepare('SELECT user_id AS userId,booking_code AS bookingCode,email FROM orders WHERE id=?').get(id);
    if (!order) return sendJson(res, 404, { error: 'Order not found.' });
    db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(status, now, id);
    addNotification(order.userId, 'order_status_update', `Booking ${order.bookingCode} moved to ${status}.`);
    sendEmail(order.email, 'Order Status Update', `Booking ${order.bookingCode} status: ${status}`);
    addAudit(session.user.id, 'admin_update_status', 'order', id, { status });
    return sendJson(res, 200, { success: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/audit-logs') {
    const rows = db.prepare('SELECT a.id,a.action,a.target_type AS targetType,a.target_id AS targetId,a.details_json AS detailsJson,a.created_at AS createdAt,u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC LIMIT 300').all();
    return sendJson(res, 200, rows);
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/backup-now') {
    const backupPath = createBackup();
    addAudit(session.user.id, 'admin_backup_now', 'system', 'backup', { backupPath });
    return sendJson(res, 200, { success: true, backupPath });
  }

  return sendJson(res, 404, { error: 'Route not found' });
}

function filteredOrders(url) {
  let query = baseOrderQuery(); const where = []; const vals = [];
  const status = String(url.searchParams.get('status') || '').trim();
  const q = String(url.searchParams.get('q') || '').trim();
  const from = String(url.searchParams.get('from') || '').trim();
  const to = String(url.searchParams.get('to') || '').trim();
  if (status) { where.push('(o.status=? OR o.payment_status=?)'); vals.push(status, status); }
  if (q) { where.push('(LOWER(o.booking_code) LIKE ? OR LOWER(o.customer_name) LIKE ? OR LOWER(o.email) LIKE ? OR LOWER(u.username) LIKE ?)'); vals.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`); }
  if (from) { where.push('o.created_at>=?'); vals.push(`${from}T00:00:00.000Z`); }
  if (to) { where.push('o.created_at<=?'); vals.push(`${to}T23:59:59.999Z`); }
  if (where.length) query += ` WHERE ${where.join(' AND ')}`;
  query += ' ORDER BY o.created_at DESC';
  return db.prepare(query).all(...vals);
}

function csvEscape(v) { const s = String(v ?? ''); return /[\",\\n]/.test(s) ? `\"${s.replace(/\"/g, '\"\"')}\"` : s; }
function getRequestOrigin(req, url) {
  if (SITE_URL) return SITE_URL.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || url.protocol.replace(':', '') || 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000');
  return `${proto}://${host}`.replace(/\/$/, '');
}
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.socket.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
async function sendEmail(to, subject, text) {
  const line = `[${new Date().toISOString()}] to=${to} subject=${subject} text=${text}\\n`;
  if (SMTP_USER && SMTP_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      });
      await transporter.sendMail({ from: SMTP_FROM, to, subject, text });
      fs.appendFileSync(MAIL_LOG, line, 'utf8');
      return;
    } catch (error) {
      fs.appendFileSync(MAIL_LOG, `${line.trimEnd()} smtp_error=${error.message}\\n`, 'utf8');
      return;
    }
  }
  fs.appendFileSync(MAIL_LOG, line, 'utf8');
}
 function createBackup() { const f = path.join(BACKUP_DIR, `belnavo-tech-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`); fs.copyFileSync(DB_PATH, f); fs.writeFileSync(path.join(BACKUP_DIR, 'last-backup.txt'), new Date().toISOString(), 'utf8'); return f; }
function autoBackupIfDue() { const m = path.join(BACKUP_DIR, 'last-backup.txt'); if (!fs.existsSync(m)) return void createBackup(); const t = new Date(fs.readFileSync(m, 'utf8').trim()).getTime(); if (!Number.isFinite(t) || Date.now() - t > 86400000) createBackup(); }
function addAudit(actorUserId, action, targetType, targetId, details) { db.prepare('INSERT INTO audit_logs(id,actor_user_id,action,target_type,target_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), actorUserId || null, action, targetType || null, targetId || null, JSON.stringify(details || {}), new Date().toISOString()); }
function addNotification(userId, type, message) { db.prepare('INSERT INTO notifications(id,user_id,type,message,created_at) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), userId || null, type, message, new Date().toISOString()); }
  function startRegistration(body) { const fullName = String(body?.fullName || '').trim(); const username = String(body?.username || '').trim().toLowerCase(); const email = String(body?.email || '').trim().toLowerCase(); const phone = String(body?.phone || '').trim(); const password = String(body?.password || ''); if (!fullName || !username || !email || !password) return { error: 'Full name, username, email and password are required.' }; if (password.length < 6) return { error: 'Password must be at least 6 characters.' }; if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Please provide a valid email.' }; const exists = db.prepare('SELECT id FROM users WHERE username=? OR email=?').get(username, email); if (exists) return { error: 'Username or email already exists.' }; const hp = hashPassword(password); const userId = crypto.randomUUID(); const createdAt = new Date().toISOString(); db.prepare('INSERT INTO users(id,full_name,username,email,phone,role,must_change_password,email_verified,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(userId, fullName, username, email, phone, 'user', 0, 1, hp.salt, hp.hash, createdAt); const user = { id: userId, fullName, username, email, phone, role: 'user', mustChangePassword: false, createdAt }; addNotification(userId, 'account_created', 'Your account has been created successfully.'); sendEmail(email, 'Welcome to BelNavo tech', `Your account has been created successfully. You can now log in.`); sendEmail(OWNER_EMAIL, 'New Account Created', `A user created an account with email ${email} and username ${username}.`); return { user }; }
function verifyRegistration(body) { const verificationId = String(body?.verificationId || '').trim(); const code = String(body?.code || '').trim(); if (!verificationId || !code) return { error: 'Verification code and request id are required.' }; const pending = db.prepare('SELECT * FROM pending_registrations WHERE id=?').get(verificationId); if (!pending) return { error: 'Verification request not found.' }; if (pending.expires_at <= new Date().toISOString()) { db.prepare('DELETE FROM pending_registrations WHERE id=?').run(verificationId); return { error: 'Verification code expired. Please request a new one.' }; } if (!verifyPassword(code, pending.code_salt, pending.code_hash)) return { error: 'Invalid verification code.' }; const exists = db.prepare('SELECT id FROM users WHERE username=? OR email=?').get(pending.username, pending.email); if (exists) return { error: 'Username or email already exists.' }; const userId = crypto.randomUUID(); db.prepare('INSERT INTO users(id,full_name,username,email,phone,role,must_change_password,email_verified,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(userId, pending.full_name, pending.username, pending.email, pending.phone, 'user', 0, 1, pending.password_salt, pending.password_hash, new Date().toISOString()); db.prepare('DELETE FROM pending_registrations WHERE id=?').run(verificationId); const user = { id: userId, fullName: pending.full_name, username: pending.username, email: pending.email, phone: pending.phone, role: 'user', mustChangePassword: false, createdAt: new Date().toISOString() }; addNotification(userId, 'email_verified', 'Your email address has been verified.'); return { user }; }
function resendRegistrationCode(body) { const verificationId = String(body?.verificationId || '').trim(); if (!verificationId) return { error: 'Verification request id is required.' }; const pending = db.prepare('SELECT * FROM pending_registrations WHERE id=?').get(verificationId); if (!pending) return { error: 'Verification request not found.' }; const code = String(Math.floor(100000 + Math.random() * 900000)); const cp = hashPassword(code); db.prepare('UPDATE pending_registrations SET code_salt=?,code_hash=?,expires_at=? WHERE id=?').run(cp.salt, cp.hash, new Date(Date.now() + 1000 * 60 * 15).toISOString(), verificationId); sendEmail(pending.email, 'BelNavo tech verification code', `Your new 6-digit verification code is: ${code}. It expires in 15 minutes.`); return { success: true }; }
  function loginUser(body) { const identifier = String(body?.identifier || '').trim().toLowerCase(); const password = String(body?.password || ''); if (!identifier || !password) return { error: 'Username/email and password are required.' }; const row = db.prepare('SELECT id,full_name AS fullName,username,email,phone,role,must_change_password AS mustChangePassword,password_salt AS salt,password_hash AS hash,created_at AS createdAt FROM users WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?)').get(identifier, identifier); if (!row || !verifyPassword(password, row.salt, row.hash)) return { error: 'Invalid login details.' }; return { user: { id: row.id, fullName: row.fullName, username: row.username, email: row.email, phone: row.phone, role: row.role, mustChangePassword: !!row.mustChangePassword, createdAt: row.createdAt } }; }
function createSession(userId) { const token = crypto.randomUUID(); const now = new Date(); db.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(token, userId, now.toISOString(), new Date(now.getTime() + SESSION_MS).toISOString()); return token; }
function getSession(req) { cleanupSessions(); const token = parseCookies(req.headers.cookie || '').gx_session; if (!token) return null; const row = db.prepare('SELECT s.token,u.id,u.full_name AS fullName,u.username,u.email,u.phone,u.role,u.must_change_password AS mustChangePassword,u.created_at AS createdAt FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?').get(token, new Date().toISOString()); if (!row) return null; return { token, user: { id: row.id, fullName: row.fullName, username: row.username, email: row.email, phone: row.phone, role: row.role, mustChangePassword: !!row.mustChangePassword, createdAt: row.createdAt } }; }
function runMigrations() { ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0'); ensureColumn('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 1'); ensureColumn('orders', 'user_id', 'TEXT'); ensureColumn('payments', 'receipt_url', 'TEXT'); const admin = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get(); if (admin) db.prepare("UPDATE orders SET user_id=? WHERE user_id IS NULL OR user_id=''").run(admin.id); }
function cleanupPendingRegistrations() { db.prepare('DELETE FROM pending_registrations WHERE expires_at<=?').run(new Date().toISOString()); }
function ensureColumn(table, column, definition) { const cols = db.prepare(`PRAGMA table_info(${table})`).all(); if (!cols.some((c) => String(c.name) === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
function cleanupSessions() { db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(new Date().toISOString()); }
 function seedAdmin() { const hp = hashPassword('BelNavo@2100'); const existing = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get(); if (existing) { db.prepare("UPDATE users SET full_name=?, username=?, email=?, phone=?, must_change_password=0, email_verified=1, password_salt=?, password_hash=? WHERE id=?").run('BelNavo tech Admin', 'admin', 'admin@belnavotech.local', '', hp.salt, hp.hash, existing.id); return; } db.prepare('INSERT INTO users(id,full_name,username,email,phone,role,must_change_password,email_verified,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(), 'BelNavo tech Admin', 'admin', 'admin@belnavotech.local', '', 'admin', 0, 1, hp.salt, hp.hash, new Date().toISOString()); }
function hashPassword(password) { const salt = crypto.randomBytes(16).toString('hex'); const hash = crypto.scryptSync(password, salt, 64).toString('hex'); return { salt, hash }; }
function verifyPassword(password, salt, expectedHash) { const actual = crypto.scryptSync(password, salt, 64).toString('hex'); return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHash, 'hex')); }
function baseOrderQuery() { return `SELECT o.id,o.booking_code AS bookingCode,o.customer_name AS customerName,o.email,o.phone,s.name AS serviceName,o.amount_ngn AS amountNgn,o.status,o.payment_status AS paymentStatus,o.preferred_date AS preferredDate,o.brief,o.created_at AS createdAt,o.updated_at AS updatedAt,u.username,p.receipt_url AS receiptUrl FROM orders o JOIN services s ON s.id=o.service_id LEFT JOIN users u ON u.id=o.user_id LEFT JOIN payments p ON p.order_id=o.id`; }
function validateOrderPayload(body) { if (!body || typeof body !== 'object') return 'Invalid request payload.'; if (!String(body.serviceId || '').trim()) return 'Please choose a service.'; return ''; }
function createBookingCode() { return `GYZ-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Date.now().toString().slice(-5)}`; }
function seedServices() { const count = db.prepare('SELECT COUNT(*) AS count FROM services').get().count; if (count > 0) return; const now = new Date().toISOString(); const services = [{ slug: 'starter-site', name: 'Starter Website', description: 'Business website with 3-5 pages, responsive design, and contact setup.', price: 120000, duration: 7 }, { slug: 'ecommerce-store', name: 'E-commerce Store', description: 'Online store with product catalog, order flow, and payment integration.', price: 280000, duration: 14 }, { slug: 'brand-motion', name: 'Branding + Motion Pack', description: 'Logo direction, color system, and motion assets for social launch.', price: 180000, duration: 10 }]; const stmt = db.prepare('INSERT INTO services(id,slug,name,description,price_ngn,duration_days,active,created_at) VALUES(?,?,?,?,?,?,1,?)'); for (const x of services) stmt.run(crypto.randomUUID(), x.slug, x.name, x.description, x.price, x.duration, now); }
function serveStatic(requestPath, res) { const rel = requestPath === '/' ? '/index.html' : requestPath; const safe = path.normalize(rel).replace(/^([.][.][/\\\\])+/, ''); const file = path.join(PUBLIC_DIR, safe); if (!file.startsWith(PUBLIC_DIR)) return sendPlain(res, 403, 'Forbidden'); fs.readFile(file, (err, content) => { if (err) return sendPlain(res, err.code === 'ENOENT' ? 404 : 500, err.code === 'ENOENT' ? 'File not found' : 'Unable to load file'); const ext = path.extname(file).toLowerCase(); const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8' }[ext] || 'application/octet-stream'; res.writeHead(200, { 'Content-Type': type }); res.end(content); }); }
function parseCookies(header) { return header.split(';').reduce((acc, item) => { const [k, ...rest] = item.trim().split('='); if (k) acc[k] = decodeURIComponent(rest.join('=')); return acc; }, {}); }
function setCookie(res, token) { res.setHeader('Set-Cookie', `gx_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`); }
function clearCookie(res) { res.setHeader('Set-Cookie', 'gx_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); }
function sendJson(res, code, payload) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); }
function sendPlain(res, code, message) { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(message); }
function readBody(req) { return new Promise((resolve, reject) => { let body = ''; req.on('data', (chunk) => { body += chunk; if (body.length > 1e6) { req.socket.destroy(); reject(new Error('Request body too large')); } }); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON payload')); } }); req.on('error', reject); }); }
