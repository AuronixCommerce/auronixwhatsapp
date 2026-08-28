require('dotenv').config();

const express = require('express');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const PORT = Number(process.env.PORT || 5016);
const HOST = process.env.HOST || '0.0.0.0';
const SECRET = process.env.WHATSAPP_WORKER_SECRET || '';
const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || '/opt/auronix-whatsapp-web/session';

let status = 'starting';
let qr = null;
let connectedNumber = null;
let connectedAt = null;
let updatedAt = Date.now();
let lastError = null;
let initializing = false;

function authorized(req) {
  return Boolean(SECRET) && req.get('authorization') === `Bearer ${SECRET}`;
}

function state() {
  return {
    success: true,
    status,
    connected: status === 'connected',
    connectedNumber,
    connectedAt,
    updatedAt,
    hasQr: Boolean(qr),
    lastError,
  };
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'auronix-commerce',
    dataPath: SESSION_PATH,
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  },
});

client.on('qr', value => {
  qr = value;
  status = 'qr';
  connectedNumber = null;
  lastError = null;
  updatedAt = Date.now();
  console.log('[Auronix WhatsApp] QR generated');
  qrcode.generate(value, { small: true });
});

client.on('authenticated', () => {
  status = 'authenticated';
  qr = null;
  lastError = null;
  updatedAt = Date.now();
  console.log('[Auronix WhatsApp] authenticated');
});

client.on('ready', () => {
  status = 'connected';
  qr = null;
  lastError = null;
  connectedAt = connectedAt || Date.now();
  updatedAt = Date.now();
  connectedNumber = client.info && client.info.wid ? client.info.wid.user : null;
  console.log('[Auronix WhatsApp] connected', connectedNumber || 'unknown');
});

client.on('auth_failure', error => {
  status = 'auth_failure';
  qr = null;
  connectedNumber = null;
  lastError = String(error || 'Authentication failure');
  updatedAt = Date.now();
  console.error('[Auronix WhatsApp] auth failure', error);
});

client.on('disconnected', reason => {
  status = 'disconnected';
  qr = null;
  connectedNumber = null;
  connectedAt = null;
  lastError = String(reason || 'Disconnected');
  updatedAt = Date.now();
  console.warn('[Auronix WhatsApp] disconnected', reason);
});

client.on('change_state', newState => {
  updatedAt = Date.now();
  console.log('[Auronix WhatsApp] state', newState);
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'auronix-whatsapp-web',
    status,
    timestamp: Date.now(),
  });
});

app.get('/status', (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  return res.json(state());
});

app.get('/qr', (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  return res.json({ success: true, status, qr });
});

app.post('/initialize', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  if (initializing) {
    return res.json({ success: true, status, initializing: true });
  }

  initializing = true;
  try {
    await client.initialize();
    return res.json({ success: true, status });
  } catch (error) {
    status = 'initialization_failed';
    lastError = error instanceof Error ? error.message : String(error);
    updatedAt = Date.now();
    return res.status(500).json({ success: false, error: lastError });
  } finally {
    initializing = false;
  }
});

app.post('/logout', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    await client.logout();
    status = 'logged_out';
    qr = null;
    connectedNumber = null;
    connectedAt = null;
    lastError = null;
    updatedAt = Date.now();
    return res.json({ success: true, status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastError = message;
    updatedAt = Date.now();
    return res.status(500).json({ success: false, error: message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[Auronix WhatsApp] worker listening on ${HOST}:${PORT}`);
  console.log(`[Auronix WhatsApp] session path: ${SESSION_PATH}`);

  client.initialize().catch(error => {
    status = 'initialization_failed';
    lastError = error instanceof Error ? error.message : String(error);
    updatedAt = Date.now();
    console.error('[Auronix WhatsApp] initial initialization failed', error);
  });
});
