const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const P = require('pino');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let filteredMessages = [];
let settings = { keywords: ['Kocaeli'], soundEnabled: true, ttsEnabled: false };
let qrCodeData = null;
let isReady = false;
let sock = null;
let reconnectTimeout = null;

async function connectWhatsApp() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log('Baileys version:', version);

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: P({ level: 'silent' }),
      browser: ['NakliyeBot', 'Chrome', '120.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 5,
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('QR oluşturuldu');
        try {
          qrCodeData = await qrcode.toDataURL(qr);
          isReady = false;
          io.emit('qr', qrCodeData);
          io.emit('status', { connected: false, message: 'QR kodu okutun' });
        } catch(e) {
          console.error('QR oluşturma hatası:', e.message);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : null;

        console.log('Bağlantı kesildi, kod:', statusCode);
        isReady = false;
        io.emit('status', { connected: false, message: 'Yeniden bağlanıyor...' });

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          if (reconnectTimeout) clearTimeout(reconnectTimeout);
          reconnectTimeout = setTimeout(connectWhatsApp, 5000);
        } else {
          try { fs.rmSync('auth_info', { recursive: true, force: true }); } catch(e) {}
          reconnectTimeout = setTimeout(connectWhatsApp, 5000);
        }
      }

      if (connection === 'open') {
        console.log('WhatsApp bağlandı!');
        isReady = true;
        qrCodeData = null;
        io.emit('status', { connected: true, message: 'WhatsApp bağlı ✓' });
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
      if (type !== 'notify') return;

      for (const msg of msgs) {
        try {
          if (!msg.message) continue;

          const body =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';

          if (!body) continue;

          const lowerBody = body.toLowerCase();
          const matchedKeyword = settings.keywords.find(kw =>
            lowerBody.includes(kw.toLowerCase())
          );
          if (!matchedKeyword) continue;

          const phoneRegex = /(\+90[\s\-]?)?(\(0\d{3}\)[\s\-]?|\b0?\d{3}[\s\-]?)(\d{3}[\s\-]?\d{2}[\s\-]?\d{2}|\d{7})\b/g;
          const phones = [...body.matchAll(phoneRegex)].map(m =>
            m[0].replace(/[\s\-\(\)]/g, '')
          );

          const senderId = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || senderId.split('@')[0] || 'Bilinmiyor';

          const isGroup = msg.key.remoteJid?.endsWith('@g.us');
          let groupName = '';
          if (isGroup) {
            try {
              const meta = await sock.groupMetadata(msg.key.remoteJid);
              groupName = meta.subject || '';
            } catch(e) {}
          }

          const newMessage = {
            id: Date.now().toString(),
            body,
            sender: senderName,
            group: groupName,
            phones,
            keyword: matchedKeyword,
            timestamp: new Date().toISOString(),
            read: false
          };

          filteredMessages.unshift(newMessage);
          if (filteredMessages.length > 200) filteredMessages = filteredMessages.slice(0, 200);

          console.log(`[${matchedKeyword}] ${senderName}: ${body.substring(0, 60)}`);
          io.emit('new_message', newMessage);

        } catch (err) {
          console.error('Mesaj hatası:', err.message);
        }
      }
    });

  } catch(err) {
    console.error('Bağlantı başlatma hatası:', err.message);
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connectWhatsApp, 5000);
  }
}

// --- API ---
app.get('/api/status', (req, res) => res.json({ connected: isReady, qr: qrCodeData }));
app.get('/api/messages', (req, res) => res.json(filteredMessages));
app.get('/api/settings', (req, res) => res.json(settings));

app.post('/api/settings', (req, res) => {
  const { keywords, soundEnabled, ttsEnabled } = req.body;
  if (keywords && Array.isArray(keywords)) settings.keywords = keywords.map(k => k.trim()).filter(Boolean);
  if (typeof soundEnabled === 'boolean') settings.soundEnabled = soundEnabled;
  if (typeof ttsEnabled === 'boolean') settings.ttsEnabled = ttsEnabled;
  io.emit('settings_updated', settings);
  res.json({ success: true, settings });
});

app.post('/api/messages/:id/read', (req, res) => {
  const msg = filteredMessages.find(m => m.id === req.params.id);
  if (msg) msg.read = true;
  res.json({ success: true });
});

app.delete('/api/messages', (req, res) => {
  filteredMessages = [];
  io.emit('messages_cleared');
  res.json({ success: true });
});

io.on('connection', (socket) => {
  console.log('Panel bağlandı');
  socket.emit('status', {
    connected: isReady,
    message: isReady ? 'WhatsApp bağlı ✓' : 'Bağlantı bekleniyor...'
  });
  if (qrCodeData && !isReady) {
    socket.emit('qr', qrCodeData);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sunucu: http://localhost:${PORT}`);
  connectWhatsApp();
});
