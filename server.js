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
const VERIFY_SECRET = process.env.AURONIX_VERIFY_SECRET || '';
const VERIFY_URL = process.env.AURONIX_VERIFY_URL || 'https://auronixcommerce.com/api/seller/whatsapp/inbound';
const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || '/opt/auronix-whatsapp-web/session';

let status = 'starting';
let qr = null;
let connectedNumber = null;
let connectedAt = null;
let updatedAt = Date.now();
let lastError = null;
let initializing = false;

function authorized(req) {
  const supplied = req.get('authorization') || '';
  return (
    (Boolean(SECRET) && supplied === `Bearer ${SECRET}`) ||
    (Boolean(VERIFY_SECRET) && supplied === `Bearer ${VERIFY_SECRET}`)
  );
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!/^\d{8,15}$/.test(digits)) {
    throw new Error('Invalid WhatsApp phone number');
  }
  return digits;
}

function tryNormalizePhone(value) {
  try {
    return normalizePhone(value);
  } catch {
    return null;
  }
}

async function resolveSenderPhone(message) {
  const candidates = [];

  try {
    const contact = await message.getContact();
    if (contact) {
      if (contact.number) candidates.push(contact.number);
      if (contact.id && contact.id.user) candidates.push(contact.id.user);
      if (contact.id && contact.id._serialized) candidates.push(contact.id._serialized.split('@')[0]);
    }
  } catch (error) {
    console.warn(
      '[Auronix WhatsApp] unable to resolve contact metadata',
      error instanceof Error ? error.message : String(error)
    );
  }

  if (message.author) candidates.push(String(message.author).split('@')[0]);
  if (message.from) candidates.push(String(message.from).split('@')[0]);

  for (const candidate of candidates) {
    const phone = tryNormalizePhone(candidate);
    if (phone) return phone;
  }

  throw new Error('Unable to resolve sender WhatsApp phone number');
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
    otpVerificationConfigured: Boolean(VERIFY_SECRET && VERIFY_URL),
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
  console.log('[Auronix WhatsApp] seller OTP verification', VERIFY_SECRET && VERIFY_URL ? 'enabled' : 'DISABLED');
  if (!VERIFY_SECRET) {
    console.error('[Auronix WhatsApp] AURONIX_VERIFY_SECRET is missing from .env');
  }
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

client.on('message', async message => {
  try {
    if (!message || message.fromMe) return;

    const body = String(message.body || '').trim();
    if (!/^OTP$/i.test(body)) return;

    console.log('[Auronix WhatsApp] incoming OTP request detected', {
      senderType: String(message.from || '').split('@')[1] || 'unknown',
    });

    if (!VERIFY_SECRET || !VERIFY_URL) {
      console.error('[Auronix WhatsApp] OTP request ignored because verification API is not configured');
      try {
        await client.sendMessage(
          message.from,
          'Auronix Commerce verification is temporarily unavailable. Please try again shortly.'
        );
      } catch {}
      return;
    }

    const from = await resolveSenderPhone(message);
    const messageId = message.id && message.id._serialized
      ? message.id._serialized
      : `${from}-${message.timestamp || Date.now()}`;

    console.log('[Auronix WhatsApp] forwarding OTP request to Auronix website', {
      fromLast4: from.slice(-4),
    });

    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${VERIFY_SECRET}`,
      },
      body: JSON.stringify({
        from,
        messageId,
        body: 'OTP',
      }),
      signal: AbortSignal.timeout(15000),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('[Auronix WhatsApp] OTP request API error', {
        status: response.status,
        error: typeof result.error === 'string' ? result.error : 'unknown',
      });
      try {
        await client.sendMessage(
          message.from,
          'Auronix Commerce could not generate your verification code right now. Please return to the seller application and create a new verification request.'
        );
      } catch {}
      return;
    }

    if (result && typeof result.reply === 'string' && result.reply.trim()) {
      await client.sendMessage(message.from, result.reply.trim());
    }

    console.log('[Auronix WhatsApp] seller OTP request processed', {
      fromLast4: from.slice(-4),
      otpIssued: result.otpIssued === true,
      handled: result.handled === true,
    });
  } catch (error) {
    console.error(
      '[Auronix WhatsApp] seller OTP request failed',
      error instanceof Error ? error.message : String(error)
    );
  }
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'auronix-whatsapp-web',
    status,
    otpVerificationConfigured: Boolean(VERIFY_SECRET && VERIFY_URL),
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

app.post('/send-otp', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    if (status !== 'connected') {
      return res.status(503).json({
        success: false,
        error: 'Auronix WhatsApp is not connected. Please reconnect the worker.',
      });
    }

    const phone = normalizePhone(req.body && req.body.phone);
    const code = String(req.body && req.body.code || '').trim();

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, error: 'Invalid OTP code' });
    }

    const chatId = `${phone}@c.us`;
    const registered = await client.isRegisteredUser(chatId);

    if (!registered) {
      return res.status(400).json({
        success: false,
        error: 'That phone number is not registered on WhatsApp.',
      });
    }

    const messageText = [
      'Auronix Commerce seller verification',
      '',
      `Your one-time verification code is: ${code}`,
      '',
      'This code expires in 10 minutes.',
      'Do not share this code with anyone.',
    ].join('\n');

    const sent = await client.sendMessage(chatId, messageText);
    const messageId = sent && sent.id && sent.id._serialized ? sent.id._serialized : null;

    return res.json({ success: true, sent: true, messageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Auronix WhatsApp] OTP send failed', message);
    return res.status(500).json({ success: false, error: message });
  }
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
  console.log(`[Auronix WhatsApp] verification API: ${VERIFY_URL}`);
  console.log(`[Auronix WhatsApp] verification secret configured: ${Boolean(VERIFY_SECRET)}`);

  client.initialize().catch(error => {
    status = 'initialization_failed';
    lastError = error instanceof Error ? error.message : String(error);
    updatedAt = Date.now();
    console.error('[Auronix WhatsApp] initial initialization failed', error);
  });
});
