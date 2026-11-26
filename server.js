require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

const app = express();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const PANEL_SECRET = process.env.PANEL_SECRET || '';
const MAX_ACTIVE_ROOMS = Math.max(1, Number(process.env.MAX_ACTIVE_ROOMS) || 5);
const USERNAME_RE = /^[a-zA-Z0-9._]{2,32}$/;
const TOKEN_RE = /^[a-zA-Z0-9_-]{6,64}$/;

// Security headers (no extra dependency needed)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  if (!req.path.startsWith('/overlay') && !req.path.startsWith('/widget')) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  next();
});

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || !ALLOWED_ORIGIN || origin === ALLOWED_ORIGIN) return cb(null, true);
    return cb(new Error('Origin no permitido'));
  }
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory IP rate limiter
const rateBuckets = new Map();
function allowRequest(ip, maxPerMin = 30) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || [];
  const fresh = bucket.filter((ts) => now - ts < 60000);
  if (fresh.length >= maxPerMin) return false;
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  return true;
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Secure server-side proxy for ElevenLabs (keeps ELEVENLABS_API_KEY out of the browser!)
app.post('/api/tts/elevenlabs', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!allowRequest(ip, 25)) return res.status(429).json({ error: 'Demasiadas peticiones' });
  if (PANEL_SECRET && req.headers['x-panel-secret'] !== PANEL_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ELEVENLABS_API_KEY no configurada en el servidor' });

  const text = String(req.body?.text || '').trim().slice(0, 220);
  const voiceId = String(req.body?.voiceId || 'EXAVITQu4vr4xnSDxMaL').replace(/[^a-zA-Z0-9]/g, '');
  if (!text || !voiceId) return res.status(400).json({ error: 'Texto o voiceId inválido' });

  try {
    const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' })
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Error en ElevenLabs' });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buf);
  } catch (_) {
    res.status(502).json({ error: 'No se pudo conectar con ElevenLabs' });
  }
});

app.get('/overlay', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/overlay-likes.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/widget/:type', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN || true }
});

const activeConnections = new Map();
function disconnectRoom(token) {
  const existing = activeConnections.get(token);
  if (existing) {
    try { existing.disconnect(); } catch (_) {}
    activeConnections.delete(token);
  }
}

io.on('connection', (socket) => {
  const ip = socket.handshake.address || 'unknown';

  socket.on('room:join', ({ token }) => {
    if (TOKEN_RE.test(String(token || ''))) socket.join(token);
  });

  socket.on('overlay:emit', ({ token, secret, payload }) => {
    if (PANEL_SECRET && secret !== PANEL_SECRET) return;
    if (!TOKEN_RE.test(String(token || '')) || !payload) return;
    io.to(token).emit('overlay:event', payload);
  });

  socket.on('tiktok:connect', async ({ username, token, secret }) => {
    if (!allowRequest(ip, 15)) {
      return socket.emit('tiktok:error', { message: 'Límite de intentos alcanzado. Espera 1 minuto.' });
    }
    if (PANEL_SECRET && secret !== PANEL_SECRET) {
      return socket.emit('tiktok:error', { message: 'Clave del panel incorrecta.' });
    }
    const cleanUser = String(username || '').replace(/^@/, '').trim();
    if (!USERNAME_RE.test(cleanUser) || !TOKEN_RE.test(String(token || ''))) {
      return socket.emit('tiktok:error', { message: 'Usuario o token inválido.' });
    }
    if (!activeConnections.has(token) && activeConnections.size >= MAX_ACTIVE_ROOMS) {
      return socket.emit('tiktok:error', { message: 'Límite máximo de salas activas alcanzado.' });
    }

    socket.join(token);
    disconnectRoom(token);

    const options = { enableExtendedGiftInfo: true };
    if (process.env.EULER_API_KEY) options.signApiKey = process.env.EULER_API_KEY;

    const tiktok = new TikTokLiveConnection(cleanUser, options);
    activeConnections.set(token, tiktok);
    const emitToRoom = (ev, data) => io.to(token).emit(ev, data);

    tiktok.on(ControlEvent.CONNECTED, (st) => emitToRoom('tiktok:status', { connected: true, username: '@' + cleanUser, roomId: st?.roomId || '' }));
    tiktok.on(ControlEvent.DISCONNECTED, () => emitToRoom('tiktok:status', { connected: false, username: '@' + cleanUser }));
    tiktok.on(WebcastEvent.CHAT, (d) => emitToRoom('tiktok:chat', { user: '@' + (d.user?.uniqueId || d.uniqueId || 'user'), text: String(d.comment || '').slice(0, 240) }));
    tiktok.on(WebcastEvent.GIFT, (d) => emitToRoom('tiktok:gift', { user: '@' + (d.user?.uniqueId || d.uniqueId || 'user'), giftName: d.giftName || d.extendedGiftInfo?.name || 'Regalo', coins: Number(d.diamondCount || 1), repeatCount: Number(d.repeatCount || 1), repeatEnd: Boolean(d.repeatEnd), giftType: d.giftType }));
    tiktok.on(WebcastEvent.LIKE, (d) => emitToRoom('tiktok:like', { user: '@' + (d.user?.uniqueId || d.uniqueId || 'user'), likeCount: Number(d.likeCount || 1), totalLikeCount: Number(d.totalLikeCount || 0) }));
    tiktok.on(WebcastEvent.FOLLOW, (d) => emitToRoom('tiktok:follow', { user: '@' + (d.user?.uniqueId || d.uniqueId || 'user') }));
    tiktok.on(WebcastEvent.SHARE, (d) => emitToRoom('tiktok:share', { user: '@' + (d.user?.uniqueId || d.uniqueId || 'user') }));
    tiktok.on(WebcastEvent.MEMBER, (d) => emitToRoom('tiktok:join', { user: '@' + (d.user?.uniqueId || d.uniqueId || 'user') }));
    tiktok.on(WebcastEvent.SUBSCRIBE, (d) => emitToRoom('tiktok:sub', { user: '@' + (d.user?.uniqueId || d.uniqueId || 'user') }));
    tiktok.on(WebcastEvent.ROOM_USER, (d) => emitToRoom('tiktok:viewers', { viewerCount: Number(d.viewerCount || 0) }));
    tiktok.on(WebcastEvent.LINK_MIC_BATTLE, (d) => emitToRoom('tiktok:pk_start', d));
    tiktok.on(WebcastEvent.LINK_MIC_ARMIES, (d) => {
      emitToRoom('tiktok:pk_armies', d);
      const items = d?.battleItems || d?.battleArmies || [];
      if (Array.isArray(items) && items.length) {
        const players = items.map((it, i) => ({
          name: it?.hostUserId ? `@host_${String(it.hostUserId).slice(-4)}` : `@jugador_${i + 1}`,
          score: Number(it?.points || it?.hostScore || 0)
        }));
        emitToRoom('tiktok:battle_update', players);
      }
    });

    try {
      await tiktok.connect();
      try {
        const rawGifts = await tiktok.fetchAvailableGifts();
        const catalog = (Array.isArray(rawGifts) ? rawGifts : []).map((g) => ({
          id: g.id,
          name: g.name,
          coins: Number(g.diamond_count || 1),
          img: g.image?.url_list?.[0] || ''
        }));
        if (catalog.length) emitToRoom('tiktok:gifts_catalog', catalog);
      } catch (_) {}
    } catch (err) {
      emitToRoom('tiktok:error', { message: err?.message || 'No se pudo conectar (verifica que el usuario esté EN VIVO).' });
      disconnectRoom(token);
    }
  });

  socket.on('tiktok:disconnect', ({ token, secret }) => {
    if (PANEL_SECRET && secret !== PANEL_SECRET) return;
    if (TOKEN_RE.test(String(token || ''))) disconnectRoom(token);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`TikPanel Pro seguro corriendo en puerto ${PORT}`));
