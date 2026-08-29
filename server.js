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
const CHROME_PATH = process.env.CHROME_PATH || '/root/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome';

let status = 'starting';
let qr = null;
let connectedNumber = null;
let connectedAt = null;
let updatedAt = Date.now();
let lastError = null;
let initializing = false;

const processedIncomingMessages = new Map();
const DEDUPE_TTL_MS = 5 * 60 * 1000;

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
    verificationConfigured: Boolean(VERIFY_SECRET && VERIFY_URL),
  };
}

function pruneDedupe(now = Date.now()) {
  for (const [id, timestamp] of processedIncomingMessages.entries()) {
    if (now - timestamp > DEDUPE_TTL_MS) processedIncomingMessages.delete(id);
  }
}

function markMessageOnce(messageId) {
  const now = Date.now();
  pruneDedupe(now);
  if (processedIncomingMessages.has(messageId)) return false;
  processedIncomingMessages.set(messageId, now);
  return true;
}

function whatsappId(value) {
  if (value && typeof value === 'object' && value._serialized) {
    return String(value._serialized);
  }
  return typeof value === 'string' ? value : '';
}

function phoneFromPnIdentity(value) {
  const id = whatsappId(value);
  const [user, server = ''] = id.split('@');
  const digits = String(user || '').replace(/\D/g, '');
  const isPhoneServer = ['c.us', 's.whatsapp.net', 'pn'].includes(server.toLowerCase());
  return isPhoneServer && /^\d{8,15}$/.test(digits) ? digits : null;
}

function idType(value) {
  const id = whatsappId(value);
  return id.includes('@') ? id.split('@').pop() : 'unknown';
}

async function resolveLidWithClient(whatsappClient, lid) {
  if (!lid.endsWith('@lid') || typeof whatsappClient.getContactLidAndPhone !== 'function') {
    return null;
  }

  try {
    const mappings = await whatsappClient.getContactLidAndPhone([lid]);
    const phone = phoneFromPnIdentity(mappings && mappings[0] && mappings[0].pn);
    if (phone) return phone;
  } catch (error) {
    console.warn('[Auronix WhatsApp] LID-to-phone lookup failed', {
      idType: 'lid',
      errorType: error instanceof Error ? error.name : 'unknown',
    });
  }

  return null;
}

async function resolveSenderPhone(message, whatsappClient = client) {
  const rawFrom = whatsappId(message && message.from);
  const rawAuthor = whatsappId(message && message.author);
  const metadataIds = [
    rawAuthor,
    rawFrom,
    whatsappId(message && message.id && message.id.participant),
    whatsappId(message && message.rawData && message.rawData.author),
    whatsappId(message && message.rawData && message.rawData.id && message.rawData.id.participant),
  ].filter(Boolean);

  // A LID is an opaque WhatsApp identifier, not a phone number. Only trust
  // identifiers explicitly marked as phone-number identities.
  for (const candidate of metadataIds) {
    const phone = phoneFromPnIdentity(candidate);
    if (phone) return { phone, source: 'message-pn' };
  }

  for (const candidate of new Set(metadataIds.filter(id => id.endsWith('@lid')))) {
    const phone = await resolveLidWithClient(whatsappClient, candidate);
    if (phone) return { phone, source: 'lid-map' };
  }

  try {
    const contact = await message.getContact();
    const contactId = whatsappId(contact && contact.id);
    const directContactPhone = phoneFromPnIdentity(contactId);
    if (directContactPhone) return { phone: directContactPhone, source: 'contact-pn' };

    const mappedContactPhone = await resolveLidWithClient(whatsappClient, contactId);
    if (mappedContactPhone) return { phone: mappedContactPhone, source: 'contact-lid-map' };

    // In some WhatsApp Web builds the contact keeps a PN-backed `number`
    // even when its ID is a LID. Only accept it when it differs from the LID.
    const contactNumber = String(contact && contact.number || '').replace(/\D/g, '');
    const lidDigits = contactId.endsWith('@lid') ? contactId.split('@')[0].replace(/\D/g, '') : '';
    if (/^\d{8,15}$/.test(contactNumber) && contactNumber !== lidDigits) {
      return { phone: contactNumber, source: 'contact-number' };
    }

    if (contact && typeof contact.getFormattedNumber === 'function') {
      const formatted = String(await contact.getFormattedNumber() || '');
      const formattedDigits = formatted.replace(/\D/g, '');
      if (formatted.includes('+') && /^\d{8,15}$/.test(formattedDigits) && formattedDigits !== lidDigits) {
        return { phone: formattedDigits, source: 'contact-formatted' };
      }
    }
  } catch (error) {
    console.warn(
      '[Auronix WhatsApp] sender contact lookup failed',
      { errorType: error instanceof Error ? error.name : 'unknown' }
    );
  }

  throw new Error(`Unable to resolve sender phone from WhatsApp ID type ${idType(rawAuthor || rawFrom)}`);
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'auronix-commerce',
    dataPath: SESSION_PATH,
  }),
  puppeteer: {
    headless: true,
    executablePath: CHROME_PATH,
    timeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-default-browser-check',
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
  console.log('[Auronix WhatsApp] connected', {
    numberLast4: connectedNumber ? connectedNumber.slice(-4) : 'unknown',
  });
  console.log('[Auronix WhatsApp] seller OTP verification enabled:', Boolean(VERIFY_SECRET && VERIFY_URL));
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

async function processIncomingOtpRequest(message, eventName) {
  try {
    if (!message || message.fromMe) return;

    const body = String(message.body || '').trim();
    if (!/^OTP$/i.test(body)) return;

    const rawMessageId = message.id && message.id._serialized
      ? String(message.id._serialized)
      : `${String(message.from || 'unknown')}-${message.timestamp || Date.now()}`;

    if (!markMessageOnce(rawMessageId)) {
      console.log('[Auronix WhatsApp] duplicate OTP event ignored', { event: eventName });
      return;
    }

    console.log('[Auronix WhatsApp] incoming OTP request detected', {
      event: eventName,
      idType: String(message.from || '').includes('@')
        ? String(message.from || '').split('@')[1]
        : 'unknown',
    });

    if (!VERIFY_SECRET || !VERIFY_URL) {
      console.error('[Auronix WhatsApp] OTP verification is not configured');
      return;
    }

    const resolvedSender = await resolveSenderPhone(message);
    const from = resolvedSender.phone;

    console.log('[Auronix WhatsApp] forwarding OTP request to Auronix website', {
      fromLast4: from.slice(-4),
      resolution: resolvedSender.source,
    });

    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${VERIFY_SECRET}`,
      },
      body: JSON.stringify({
        from,
        messageId: rawMessageId,
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
      return;
    }

    if (result && typeof result.reply === 'string' && result.reply.trim()) {
      await client.sendMessage(message.from, result.reply.trim());
      console.log('[Auronix WhatsApp] OTP reply sent', {
        toLast4: from.slice(-4),
      });
    } else {
      console.warn('[Auronix WhatsApp] verification API returned no WhatsApp reply');
    }

    console.log('[Auronix WhatsApp] seller OTP request processed', {
      fromLast4: from.slice(-4),
      otpIssued: result.otpIssued === true,
    });
  } catch (error) {
    console.error(
      '[Auronix WhatsApp] seller OTP request failed',
      error instanceof Error ? error.message : String(error)
    );
  }
}

client.on('message', message => {
  processIncomingOtpRequest(message, 'message');
});

client.on('message_create', message => {
  processIncomingOtpRequest(message, 'message_create');
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'auronix-whatsapp-web',
    status,
    connected: status === 'connected',
    connectedNumber,
    verificationConfigured: Boolean(VERIFY_SECRET && VERIFY_URL),
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

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`[Auronix WhatsApp] worker listening on ${HOST}:${PORT}`);
    console.log(`[Auronix WhatsApp] session path: ${SESSION_PATH}`);
    console.log(`[Auronix WhatsApp] Chrome path: ${CHROME_PATH}`);
    console.log(`[Auronix WhatsApp] verification API: ${VERIFY_URL}`);
    console.log(`[Auronix WhatsApp] verification secret configured: ${Boolean(VERIFY_SECRET)}`);

    client.initialize().catch(error => {
      status = 'initialization_failed';
      lastError = error instanceof Error ? error.message : String(error);
      updatedAt = Date.now();
      console.error('[Auronix WhatsApp] initial initialization failed', error);
    });
  });
}

module.exports = {
  idType,
  phoneFromPnIdentity,
  resolveSenderPhone,
};
