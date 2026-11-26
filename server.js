require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const tiktokConnector = require('tiktok-live-connector');
const { TikTokLiveConnection, WebcastEvent, ControlEvent, SignConfig } = tiktokConnector;

if (process.env.EULER_API_KEY && SignConfig) {
  SignConfig.apiKey = process.env.EULER_API_KEY.trim();
}

const app = express();
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '').trim();
const PANEL_SECRET = (process.env.PANEL_SECRET || '').trim();
const MAX_ACTIVE_ROOMS = Math.max(1, Number(process.env.MAX_ACTIVE_ROOMS) || 5);
const USERNAME_RE = /^[a-zA-Z0-9._]{2,32}$/;
const TOKEN_RE = /^[a-zA-Z0-9_-]{4,64}$/;

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  if (!req.path.startsWith('/overlay') && !req.path.startsWith('/widget') && !req.path.startsWith('/barras-nivel')) {
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
app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const rateBuckets = new Map();
function allowRequest(ip, maxPerMin = 40) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || [];
  const fresh = bucket.filter((ts) => now - ts < 60000);
  if (fresh.length >= maxPerMin) return false;
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  return true;
}

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  hasEulerKey: Boolean(process.env.EULER_API_KEY),
  activeRooms: activeConnections.size
}));
app.get('/api/config', (_req, res) => res.json({
  requiresSecret: Boolean(PANEL_SECRET),
  hasEulerKey: Boolean(process.env.EULER_API_KEY)
}));

app.post('/api/tts/elevenlabs', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!allowRequest(ip, 25)) return res.status(429).json({ error: 'Demasiadas peticiones' });
  if (PANEL_SECRET && req.headers['x-panel-secret'] !== PANEL_SECRET) {
    return res.status(401).json({ error: 'Clave del panel (PANEL_SECRET) incorrecta' });
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


app.post('/api/tts/fish', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!allowRequest(ip, 30)) return res.status(429).json({ error: 'Demasiadas peticiones' });
  if (PANEL_SECRET && req.headers['x-panel-secret'] !== PANEL_SECRET) {
    return res.status(401).json({ error: 'Clave del panel (PANEL_SECRET) incorrecta' });
  }
  const apiKey = String(req.body?.apiKey || process.env.FISH_API_KEY || '').trim();
  if (!apiKey) return res.status(503).json({ error: 'Falta tu Fish Audio API Key (pégala en TTS o configúrala en FISH_API_KEY en Railway)' });

  const text = String(req.body?.text || '').trim().slice(0, 260);
  const referenceId = String(req.body?.referenceId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  const allowedModels = new Set(['s2.1-pro-free', 's2.1-pro', 's2-pro']);
  const reqModel = String(req.body?.model || 's2.1-pro-free').trim();
  const model = allowedModels.has(reqModel) ? reqModel : 's2.1-pro-free';
  if (!text) return res.status(400).json({ error: 'Texto vacío' });

  const payload = { text, format: 'mp3', latency: 'balanced', normalize: true };
  if (referenceId) payload.reference_id = referenceId;

  try {
    const upstream = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model
      },
      body: JSON.stringify(payload)
    });
    if (!upstream.ok) {
      const errTxt = await upstream.text().catch(() => '');
      return res.status(upstream.status).json({ error: `Fish Audio error (${upstream.status}): ${errTxt.slice(0, 120)}` });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buf);
  } catch (_) {
    res.status(502).json({ error: 'No se pudo conectar con Fish Audio' });
  }
});




app.post('/api/tts/tiktok', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!allowRequest(ip, 40)) return res.status(429).json({ error: 'Demasiadas peticiones' });
  const text = String(req.body?.text || '').trim().slice(0, 220);
  const voice = String(req.body?.voice || 'es_mx_002').replace(/[^a-zA-Z0-9_]/g, '') || 'es_mx_002';
  if (!text) return res.status(400).json({ error: 'Texto vacío' });

  const endpoints = [
    'https://tiktok-tts.weilnet.workers.dev/api/generation',
    'https://gesserit.co/api/tiktok-tts'
  ];
  for (const ep of endpoints) {
    try {
      const upstream = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ text, voice }),
        signal: AbortSignal.timeout(4500)
      });
      if (!upstream.ok) continue;
      const data = await upstream.json().catch(() => null);
      const b64 = data?.data || data?.base64 || '';
      if (b64) {
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > 200) {
          res.setHeader('Content-Type', 'audio/mpeg');
          return res.send(buf);
        }
      }
    } catch (_) {}
  }
  res.status(502).json({ error: 'TikTok TTS temporalmente no disponible' });
});

app.post('/api/tts/streamlabs', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!allowRequest(ip, 40)) return res.status(429).json({ error: 'Demasiadas peticiones' });
  const text = String(req.body?.text || '').trim().slice(0, 220);
  const voice = String(req.body?.voice || 'Mia').replace(/[^a-zA-Z]/g, '') || 'Mia';
  if (!text) return res.status(400).json({ error: 'Texto vacío' });
  try {
    const upstream = await fetch('https://streamlabs.com/polly/speak', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://streamlabs.com/'
      },
      body: JSON.stringify({ voice, text }),
      signal: AbortSignal.timeout(4500)
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Streamlabs Polly no disponible' });
    const data = await upstream.json().catch(() => null);
    if (!data?.speak_url) return res.status(502).json({ error: 'Sin audio de Streamlabs' });
    const audioRes = await fetch(data.speak_url, { signal: AbortSignal.timeout(4500) });
    if (!audioRes.ok) return res.status(502).json({ error: 'No se pudo descargar audio Polly' });
    const buf = Buffer.from(await audioRes.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buf);
  } catch (_) {
    res.status(502).json({ error: 'Streamlabs Polly no disponible' });
  }
});

app.post('/api/tts/streamelements', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!allowRequest(ip, 40)) return res.status(429).json({ error: 'Demasiadas peticiones' });
  const text = String(req.body?.text || '').trim().slice(0, 240);
  const voice = String(req.body?.voice || 'Mia').replace(/[^a-zA-Z]/g, '') || 'Mia';
  if (!text) return res.status(400).json({ error: 'Texto vacío' });
  try {
    const url = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}`;
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(4500)
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'StreamElements TTS no disponible' });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buf);
  } catch (_) {
    res.status(502).json({ error: 'Error conectando con StreamElements TTS' });
  }
});

app.post('/api/tts/google', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!allowRequest(ip, 40)) return res.status(429).json({ error: 'Demasiadas peticiones' });
  const text = String(req.body?.text || '').trim().slice(0, 200);
  const lang = String(req.body?.lang || 'es-US').replace(/[^a-zA-Z-]/g, '') || 'es-US';
  if (!text) return res.status(400).json({ error: 'Texto vacío' });
  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(text)}`;
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: 'https://translate.google.com/'
      },
      signal: AbortSignal.timeout(4500)
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Google TTS no disponible' });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buf);
  } catch (_) {
    res.status(502).json({ error: 'Error conectando con Google TTS' });
  }
});

app.post('/api/tts/edge', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!allowRequest(ip, 40)) return res.status(429).json({ error: 'Demasiadas peticiones' });
  const text = String(req.body?.text || '').trim().slice(0, 240);
  const voice = String(req.body?.voice || 'es-PE-CamilaNeural').replace(/[^a-zA-Z0-9-]/g, '') || 'es-PE-CamilaNeural';
  const rateNum = Math.min(2, Math.max(0.5, Number(req.body?.rate || 1)));
  const ratePct = Math.round((rateNum - 1) * 100);
  const rateStr = `${ratePct >= 0 ? '+' : ''}${ratePct}%`;
  if (!text) return res.status(400).json({ error: 'Texto vacío' });

  try {
    const edgeMod = await import('edge-tts-universal');
    const EdgeTTS = edgeMod.EdgeTTS || edgeMod.UniversalEdgeTTS || edgeMod.default?.EdgeTTS;
    const tts = new EdgeTTS(text, voice, { rate: rateStr });
    const result = await Promise.race([tts.synthesize(), new Promise((_, rej) => setTimeout(() => rej(new Error('Edge timeout')), 4500))]);
    const arrBuf = await result.audio.arrayBuffer();
    const buf = Buffer.from(arrBuf);
    if (!buf.length) throw new Error('Audio vacío');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buf);
  } catch (err) {
    // Automatic fallback to Google TTS so free neural TTS never goes silent
    try {
      const lang = voice.split('-').slice(0, 2).join('-') || 'es-US';
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(text)}`;
      const upstream = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://translate.google.com/' }
      });
      if (!upstream.ok) throw new Error('Fallback failed');
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(buf);
    } catch (_) {
      res.status(502).json({ error: 'Edge TTS temporalmente no disponible' });
    }
  }
});


const SOUNDS_DIR = path.join(__dirname, 'public', 'sounds');
try { fs.mkdirSync(SOUNDS_DIR, { recursive: true }); } catch (_) {}

function listSoundLibrary() {
  try {
    const files = fs.readdirSync(SOUNDS_DIR);
    return files
      .filter((fn) => /\.(mp3|wav|ogg|m4a)$/i.test(fn))
      .sort((a, b) => a.localeCompare(b))
      .map((fn) => ({
        name: fn.replace(/\.[^.]+$/, ''),
        filename: fn,
        url: '/sounds/' + encodeURIComponent(fn)
      }));
  } catch (_) {
    return [];
  }
}

app.get('/api/sounds', (_req, res) => {
  res.json({ sounds: listSoundLibrary() });
});

app.post('/api/sounds/upload', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!allowRequest(ip, 15)) return res.status(429).json({ error: 'Demasiadas peticiones' });
  const rawName = String(req.body?.filename || '').trim();
  const b64 = String(req.body?.dataBase64 || '').trim();
  const extMatch = rawName.match(/\.(mp3|wav|ogg|m4a)$/i);
  if (!extMatch || !b64) return res.status(400).json({ error: 'Solo se permiten archivos .mp3, .wav, .ogg o .m4a' });
  const ext = extMatch[0].toLowerCase();
  const stem = rawName.slice(0, -ext.length).replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 48) || ('sonido_' + Date.now());
  const safeName = stem + ext;
  try {
    const cleanB64 = b64.includes(',') ? b64.split(',').pop() : b64;
    const buf = Buffer.from(cleanB64, 'base64');
    if (buf.length > 5.2 * 1024 * 1024) return res.status(413).json({ error: 'El archivo supera los 5 MB' });
    fs.mkdirSync(SOUNDS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SOUNDS_DIR, safeName), buf);
    res.json({ ok: true, file: { name: stem, filename: safeName, url: '/sounds/' + encodeURIComponent(safeName) }, sounds: listSoundLibrary() });
  } catch (_) {
    res.status(500).json({ error: 'No se pudo guardar el audio' });
  }
});

app.get('/overlay', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/overlay-likes.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/widget/:type', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/barras-nivel', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'barras-nivel.html')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN || true }
});

const activeConnections = new Map();
const roomSyncTimers = new Map();
const roomStates = new Map();

function createInitialRoomState(username) {
  return {
    username: '@' + username,
    ownerDisplayName: '@' + username,
    connected: false,
    roomId: '',
    ownerUserId: '',
    knownUsers: new Map(),
    giftPriceById: new Map(),
    giftPriceByName: new Map(),
    giftStreaks: new Map(), // streakKey -> { count, ts }
    recentSocial: new Map(), // dedupe SHARE/FOLLOW vs SOCIAL
    lastRoomRefreshTs: 0,
    stats: { likes: 0, viewers: 0, follows: 0, coins: 0, shares: 0, subs: 0 },
    topLikes: new Map(),
    topCoins: new Map(),
    topViewers: [], // ranked viewers from ROOM_USER (ranksList / topViewers)
    activeViewers: new Map(),
    giftsCatalog: [],
    battle: {
      active: false,
      status: 0,
      battleId: '',
      mode: '',
      hostMap: {},
      players: [],
      individualHosts: new Map(), // userId -> { id, name, score, rank, baseFanTicket }
      fanTicketBaselines: new Map(), // userId -> starting fanTicket when battle started
      matchGifters: new Map(),
      throws: []
    }
  };
}

function safeId(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'bigint') return val.toString();
  if (typeof val === 'object') {
    if (typeof val.low === 'number' && typeof val.high === 'number') {
      try {
        const low = BigInt(val.low >>> 0);
        const high = BigInt(val.high >>> 0);
        return ((high << 32n) | low).toString();
      } catch (_) {}
    }
    if (typeof val.toString === 'function') {
      const s = String(val.toString()).trim();
      if (s && s !== '[object Object]') return s;
    }
    return '';
  }
  const s = String(val).trim();
  return (s && s !== '[object Object]' && s !== 'undefined' && s !== 'null') ? s : '';
}

function deepHarvestUsers(rs, obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length && i < 60; i++) {
      deepHarvestUsers(rs, obj[i], depth + 1);
    }
    return;
  }
  const uid = safeId(obj.userId || obj.UserId || obj.user_id || obj.id_str || obj.id || obj.Id || obj.uid || obj.hostUserId || obj.HostUserId || obj.host_user_id || obj.anchorId || obj.anchor_id);
  const label = parseUserLabel(obj, '');
  if (uid && label && !label.startsWith('Anfitrión #') && !label.startsWith('Equipo #')) {
    rs.knownUsers.set(uid, label);
    if (rs.battle.hostMap[uid] && (rs.battle.hostMap[uid].name.startsWith('Anfitrión #') || rs.battle.hostMap[uid].name.startsWith('Equipo #'))) {
      rs.battle.hostMap[uid].name = label;
    }
    if (rs.battle.individualHosts && rs.battle.individualHosts.has(uid)) {
      const ih = rs.battle.individualHosts.get(uid);
      if (!ih.name || ih.name.startsWith('Anfitrión #')) ih.name = label;
    }
  }
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length && i < 40; i++) {
    const k = keys[i];
    const v = obj[k];
    if (v && typeof v === 'object') {
      // If key itself looks like a numeric TikTok userId, pass it as explicitId
      if (/^\d{6,}$/.test(k)) rememberUser(rs, v, k);
      deepHarvestUsers(rs, v, depth + 1);
    }
  }
}

function parseUserLabel(u, fallback = 'Usuario') {
  if (!u || typeof u !== 'object') return fallback;
  const src = u.user || u.User || u.anchorInfo?.user || u;
  const nick = src.nickname || src.nickName || src.NickName || src.Nickname || '';
  const uid = src.uniqueId || src.UniqueId || src.displayId || src.DisplayId || src.display_id || src.unique_id || '';
  if (nick && uid && nick.toLowerCase() !== String(uid).toLowerCase()) {
    return `${nick} (@${String(uid).replace(/^@/, '')})`;
  }
  if (nick) return String(nick);
  if (uid) return '@' + String(uid).replace(/^@/, '');
  return fallback;
}

function rememberUser(rs, u, explicitId = '') {
  if (!u || typeof u !== 'object') return;
  const src = u.user || u;
  const uid = safeId(explicitId || src.userId || src.id_str || src.id || src.uid || src.hostUserId);
  const label = parseUserLabel(src, '');
  if (uid && label && !label.startsWith('Anfitrión #')) {
    rs.knownUsers.set(uid, label);
    // Also immediately update any existing battle hostMap entry that had a placeholder!
    if (rs.battle.hostMap[uid] && rs.battle.hostMap[uid].name.startsWith('Anfitrión #')) {
      rs.battle.hostMap[uid].name = label;
    }
  }
}

function trackActiveViewer(rs, label, role = 'Espectador') {
  if (!label) return;
  const prev = rs.activeViewers.get(label);
  if (!prev || role !== 'Espectador') rs.activeViewers.set(label, role);
  if (rs.activeViewers.size > 60) {
    const firstKey = rs.activeViewers.keys().next().value;
    if (firstKey) rs.activeViewers.delete(firstKey);
  }
}

function buildTopViewersList(rs) {
  if (Array.isArray(rs.topViewers) && rs.topViewers.length) {
    return rs.topViewers.slice(0, 25);
  }
  // Fallback ranking from live coins + likes + active viewers when TikTok hasn't sent ranksList yet
  const scoreMap = new Map();
  for (const [user, coins] of rs.topCoins.entries()) {
    scoreMap.set(user, { user, coins, likes: rs.topLikes.get(user) || 0, role: 'Donador 🎁' });
  }
  for (const [user, likes] of rs.topLikes.entries()) {
    if (!scoreMap.has(user)) scoreMap.set(user, { user, coins: 0, likes, role: 'Tap Tap ❤️' });
  }
  for (const [user, role] of rs.activeViewers.entries()) {
    if (!scoreMap.has(user)) scoreMap.set(user, { user, coins: 0, likes: 0, role });
  }
  return Array.from(scoreMap.values())
    .sort((a, b) => (b.coins - a.coins) || (b.likes - a.likes))
    .slice(0, 25)
    .map((v, idx) => ({ rank: idx + 1, user: v.user, coins: v.coins, likes: v.likes, role: v.role }));
}

function serializeRoomStats(rs) {
  return {
    username: rs.username,
    ownerDisplayName: rs.ownerDisplayName,
    connected: rs.connected,
    roomId: rs.roomId,
    stats: rs.stats,
    topLikes: Array.from(rs.topLikes.entries()).map(([user, val]) => ({ user, val })).sort((a, b) => b.val - a.val).slice(0, 15),
    topCoins: Array.from(rs.topCoins.entries()).map(([user, val]) => ({ user, val })).sort((a, b) => b.val - a.val).slice(0, 15),
    topViewers: buildTopViewersList(rs),
    activeViewers: Array.from(rs.activeViewers.entries()).slice(-25).reverse().map(([user, role]) => ({ user, role }))
  };
}

function serializeBattle(rs) {
  const matchTopUsers = Array.from(rs.battle.matchGifters.values())
    .filter((u) => Number(u.coins || 0) > 0)
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 20);
  const ownerId = safeId(rs.ownerUserId);
  const ownerName = rs.ownerDisplayName || rs.username;

  // Build unified host list (prefer individualHosts when available, merge with hostMap so no host is lost)
  const rawIndiv = Array.from((rs.battle.individualHosts || new Map()).values()).map((h, i) => {
    const isOwner = Boolean(ownerId && safeId(h.id) === ownerId);
    const resolved = isOwner ? ownerName : resolveHostName(rs, h.id, null, i);
    const name = (resolved && !resolved.startsWith('Anfitrión #')) ? resolved : (h.name || `Rival #${i + 1}`);
    return {
      id: safeId(h.id) || `host_${i}`,
      name,
      score: Number(h.score || 0),
      isOwner
    };
  });

  // Also resolve top-bar hostMap entries (used when individualHosts is empty)
  const rawPlayers = Object.values(rs.battle.hostMap)
    .filter((p) => p && (p.score > 0 || !p.isGhost))
    .map((p, idx) => {
      const isOwner = Boolean(ownerId && safeId(p.id) === ownerId);
      let name = isOwner ? ownerName : p.name;
      if (!isOwner && p.id && name.startsWith('Anfitrión #')) {
        const resolved = resolveHostName(rs, p.id, null, idx);
        if (resolved && !resolved.startsWith('Anfitrión #')) name = resolved;
      }
      if (name.startsWith('Anfitrión #') && rawIndiv.length) {
        const match = rawIndiv.find((h) => h.score === Number(p.score || 0) && !h.name.startsWith('Anfitrión #') && !h.name.startsWith('Rival #'));
        if (match) name = match.name;
      }
      return {
        id: safeId(p.id) || `slot_${idx}`,
        name: name.startsWith('Anfitrión #') ? `Rival #${idx + 1}` : name,
        score: Number(p.score || 0),
        isOwner: isOwner || (ownerName && name === ownerName)
      };
    });

  // Choose the richer host list (individualHosts if >= 2, otherwise rawPlayers)
  const unified = rawIndiv.length >= 3 ? rawIndiv : (rawIndiv.length === 2 && rawIndiv.some((h) => h.score > 0) ? rawIndiv : (rawPlayers.length ? rawPlayers : rawIndiv));

  // FIXED ORDER: Connected streamer (isOwner) ALWAYS index 0, rivals keep stable insertion order (never jump/swap!)
  const orderedHosts = [
    ...unified.filter((h) => h.isOwner),
    ...unified.filter((h) => !h.isOwner)
  ];

  // Clean fallback labels: never say "Anfitrión #1" for a rival
  let rivalCounter = 1;
  orderedHosts.forEach((h, idx) => {
    if (idx === 0 && h.isOwner && ownerName) {
      h.name = ownerName;
    } else if (!h.name || h.name.startsWith('Anfitrión #') || h.name.startsWith('Rival #')) {
      h.name = orderedHosts.length === 2 ? 'Rival en batalla' : `Rival #${rivalCounter}`;
      rivalCounter += 1;
    }
  });

  const players = orderedHosts;
  const individualHosts = orderedHosts;
  const mode = orderedHosts.length === 4 ? '2 vs 2' : (orderedHosts.length === 2 ? '1 vs 1' : (orderedHosts.length > 2 ? `Grupal (${orderedHosts.length})` : ''));

  return {
    active: rs.battle.active,
    status: rs.battle.status,
    battleId: rs.battle.battleId || '',
    mode,
    players,
    individualHosts,
    matchTopUsers,
    throws: rs.battle.throws.slice(0, 35)
  };
}

function disconnectRoom(token) {
  const t = roomSyncTimers.get(token);
  if (t) { clearInterval(t); roomSyncTimers.delete(token); }
  const existing = activeConnections.get(token);
  if (existing) {
    try { existing.disconnect(); } catch (_) {}
    activeConnections.delete(token);
  }
  const rs = roomStates.get(token);
  if (rs) rs.connected = false;
}

function resolveHostName(rs, hid, fallbackObj, idx) {
  const cleanId = safeId(hid);
  if (cleanId && rs.ownerUserId && cleanId === rs.ownerUserId) {
    return rs.ownerDisplayName || rs.username;
  }
  if (cleanId && rs.knownUsers.has(cleanId)) {
    return rs.knownUsers.get(cleanId);
  }
  const parsed = parseUserLabel(fallbackObj, '');
  if (parsed) {
    if (cleanId) rs.knownUsers.set(cleanId, parsed);
    return parsed;
  }
  const existing = rs.battle.hostMap[cleanId];
  if (existing && existing.name && !existing.name.startsWith('Anfitrión #')) {
    return existing.name;
  }
  return `Anfitrión #${idx + 1}`;
}

function hydrateFromRoomInfo(rs, rawInfo) {
  const rInfo = rawInfo?.data || rawInfo;
  if (!rInfo || typeof rInfo !== 'object') return;

  const owner = rInfo.owner || {};
  const ownerId = safeId(rInfo.owner_user_id || owner.id_str || owner.id);
  if (ownerId) {
    rs.ownerUserId = ownerId;
    rememberUser(rs, owner, ownerId);
    rs.ownerDisplayName = parseUserLabel(owner, rs.username);
  }

  // Deep-harvest all linked / co-host / rival host names from roomInfo.link_mic
  const lm = rInfo.link_mic || {};
  const candidateLists = [
    lm.linked_user_list,
    lm.user_list,
    lm.rival_anchor_list,
    lm.audience_list,
    lm.multi_live_user_list,
    lm.channel_info?.linked_user_list,
    rInfo.top_fans,
    rInfo.battle_info?.battle_users,
    rInfo.battle_info?.anchor_info
  ];
  candidateLists.forEach((list) => {
    if (Array.isArray(list)) list.forEach((u) => rememberUser(rs, u));
    else if (list && typeof list === 'object') Object.entries(list).forEach(([k, u]) => rememberUser(rs, u, k));
  });

  // Also check link_mic.battle_settings / rival_anchor_id
  if (lm.rival_anchor_info) rememberUser(rs, lm.rival_anchor_info);

  const likes = Number(rInfo.like_count || rInfo.stats?.like_count || 0);
  const viewers = Number(rInfo.user_count || 0);
  const shares = Number(rInfo.stats?.share_count || rInfo.share_count || 0);
  const follows = Number(rInfo.stats?.follow_count || rInfo.follow_count || 0);
  const initCoins = Number(rInfo.stats?.fan_ticket || rInfo.stats?.diamond_count || rInfo.room_ticket || rInfo.fan_ticket || 0);

  if (likes > rs.stats.likes) rs.stats.likes = likes;
  if (viewers > 0) rs.stats.viewers = viewers;
  if (shares > rs.stats.shares) rs.stats.shares = shares;
  if (follows > rs.stats.follows) rs.stats.follows = follows;
  if (initCoins > rs.stats.coins) rs.stats.coins = initCoins;

  // Deep-harvest all nested userId -> nickname mappings from roomInfo
  deepHarvestUsers(rs, rInfo.link_mic || {}, 0);
  deepHarvestUsers(rs, rInfo.battle_info || {}, 0);

  if (Array.isArray(rInfo.top_fans) && rInfo.top_fans.length && !rs.topViewers.length) {
    rs.topViewers = rInfo.top_fans.slice(0, 25).map((tf, i) => {
      const uObj = tf.user || tf;
      rememberUser(rs, uObj);
      return {
        rank: i + 1,
        user: parseUserLabel(uObj, 'Espectador'),
        coins: Number(tf.fan_ticket || tf.coin_count || tf.score || 0),
        role: i < 3 ? `Top #${i + 1} 👑` : 'Top Espectador'
      };
    });
  }

  // Harvest individual linked hosts from roomInfo.link_mic for 2v2 / multi-host display
  const linkedList = lm.linked_user_list || lm.multi_live_user_list || lm.channel_info?.linked_user_list || [];
  if (Array.isArray(linkedList)) {
    linkedList.forEach((u, idx) => {
      const uid = safeId(u?.id_str || u?.id || u?.userId || u?.user?.id_str || u?.user?.id);
      if (!uid) return;
      rememberUser(rs, u, uid);
      const prev = rs.battle.individualHosts.get(uid) || { id: uid, name: resolveHostName(rs, uid, u, idx), score: 0, rank: 0 };
      const betterName = resolveHostName(rs, uid, u, idx);
      if (!betterName.startsWith('Anfitrión #')) prev.name = betterName;
      rs.battle.individualHosts.set(uid, prev);
    });
  }

  // Only seed battle_scores from roomInfo if we don't already have live LINK_MIC_ARMIES scores
  const bScores = lm.battle_scores || rInfo.battle_info?.battle_scores || [];
  if (Array.isArray(bScores)) {
    bScores.forEach((bs, idx) => {
      const hid = safeId(bs.user_id || bs.host_user_id || bs.id);
      if (!hid) return;
      rememberUser(rs, bs, hid);
      const prev = rs.battle.individualHosts.get(hid) || { id: hid, name: resolveHostName(rs, hid, bs, idx), score: 0, rank: 0 };
      const sc = Number(bs.score || bs.points || 0);
      if (sc > prev.score) prev.score = sc;
      const betterName = resolveHostName(rs, hid, bs, idx);
      if (!betterName.startsWith('Anfitrión #')) prev.name = betterName;
      rs.battle.individualHosts.set(hid, prev);
    });
  }
  if (Array.isArray(bScores) && bScores.length && !Object.keys(rs.battle.hostMap).length) {
    rs.battle.active = true;
    rs.battle.status = 1;
    const nextMap = {};
    bScores.forEach((bs, idx) => {
      const hid = safeId(bs.user_id || bs.host_user_id || bs.id);
      if (!hid) return;
      rememberUser(rs, bs, hid);
      nextMap[hid] = {
        id: hid,
        name: resolveHostName(rs, hid, bs, idx),
        score: Number(bs.score || bs.points || 0),
        contributors: []
      };
    });
    if (Object.keys(nextMap).length) {
      rs.battle.hostMap = nextMap;
      rs.battle.players = Object.values(nextMap);
    }
  }
}

function parseBattleStart(rs, d) {
  deepHarvestUsers(rs, d, 0);
  const newBattleId = safeId(d?.battleId || d?.battleSetting?.battleId || '');
  const hostMap = {};
  const anchors = d?.anchorInfo || d?.anchors;
  if (Array.isArray(anchors)) {
    anchors.forEach((info, idx) => {
      const hid = safeId(info?.user?.userId || info?.userId || info?.anchorId);
      if (!hid) return;
      rememberUser(rs, info?.user || info, hid);
      hostMap[hid] = {
        id: hid,
        name: resolveHostName(rs, hid, info?.user || info, idx),
        score: 0,
        contributors: []
      };
    });
  } else if (anchors && typeof anchors === 'object') {
    Object.entries(anchors).forEach(([k, info], idx) => {
      const hid = safeId(info?.user?.userId || info?.userId || info?.anchorId || k);
      if (!hid) return;
      rememberUser(rs, info?.user || info, hid);
      hostMap[hid] = {
        id: hid,
        name: resolveHostName(rs, hid, info?.user || info, idx),
        score: 0,
        contributors: []
      };
    });
  }
  if (!Object.keys(hostMap).length && Array.isArray(d?.battleUsers)) {
    d.battleUsers.forEach((u, idx) => {
      const hid = safeId(u?.userId || u?.id);
      if (!hid) return;
      rememberUser(rs, u, hid);
      hostMap[hid] = {
        id: hid,
        name: resolveHostName(rs, hid, u, idx),
        score: 0,
        contributors: []
      };
    });
  }
  const indiv = new Map();
  Object.values(hostMap).forEach((h) => {
    indiv.set(h.id, { id: h.id, name: h.name, score: 0, rank: 0 });
  });
  rs.battle = {
    active: true,
    status: 1,
    battleId: newBattleId,
    mode: '',
    hostMap,
    players: Object.values(hostMap),
    individualHosts: indiv,
    fanTicketBaselines: new Map(),
    matchGifters: new Map(),
    throws: []
  };
}

function parseBattleArmies(rs, d) {
  deepHarvestUsers(rs, d, 0);
  const status = Number(d?.battleStatus ?? 1);
  const incomingBattleId = safeId(d?.battleId || d?.battleSetting?.battleId || '');

  // If a new battle started, reset stale gifters & hosts cleanly
  if (incomingBattleId && rs.battle.battleId && incomingBattleId !== rs.battle.battleId) {
    rs.battle.hostMap = {};
    if (rs.battle.individualHosts) {
      for (const [k, h] of rs.battle.individualHosts.entries()) {
        rs.battle.individualHosts.set(k, { ...h, score: 0 });
      }
    }
    rs.battle.fanTicketBaselines = new Map();
    rs.battle.matchGifters = new Map();
    rs.battle.throws = [];
  }
  if (incomingBattleId) rs.battle.battleId = incomingBattleId;

  let rawEntries = [];
  if (Array.isArray(d?.battleItems) && d.battleItems.length) {
    rawEntries = d.battleItems.map((it, i) => [safeId(it?.hostUserId || it?.userId || it?.anchorId || it?.id) || `slot_${i}`, it]);
  } else if (d?.battleItems && typeof d.battleItems === 'object' && Object.keys(d.battleItems).length) {
    rawEntries = Object.entries(d.battleItems).map(([k, it], i) => [safeId(it?.hostUserId || it?.userId || k) || `slot_${i}`, it]);
  } else if (Array.isArray(d?.battleArmies) && d.battleArmies.length) {
    rawEntries = d.battleArmies.map((it, i) => [safeId(it?.hostUserId || it?.userId) || `slot_${i}`, it]);
  } else if (d?.armies && typeof d.armies === 'object' && Object.keys(d.armies).length) {
    rawEntries = Object.entries(d.armies).map(([k, it], i) => [safeId(it?.hostUserId || it?.userId || k) || `slot_${i}`, it]);
  }

  if (!rawEntries.length) return false;

  rs.battle.active = status !== 2;
  rs.battle.status = status;

  // CRITICAL FIX: Build a CLEAN snapshot from the current LINK_MIC_ARMIES packet
  // instead of piling up old/ghost/mismatched-ID hosts (which caused 8 duplicate hosts!)
  const nextHostMap = {};
  let hasUnknownHost = false;

  rawEntries.forEach(([hid, item], idx) => {
    const cleanHid = safeId(hid) || `slot_${idx}`;
    rememberUser(rs, item?.hostUser || item?.user || item?.anchorInfo, cleanHid);
    const hostName = resolveHostName(rs, cleanHid, item?.hostUser || item?.user || item?.anchorInfo, idx);
    if (hostName.startsWith('Anfitrión #')) hasUnknownHost = true;

    let score = Number(item?.hostScore ?? item?.points ?? item?.score ?? 0);
    const contributors = [];

    if (Array.isArray(item?.battleGroups) && item.battleGroups.length) {
      let groupMax = 0;
      item.battleGroups.forEach((grp) => {
        const gPts = Number(grp?.points || 0);
        if (gPts > groupMax) groupMax = gPts;
        if (Array.isArray(grp?.users)) {
          grp.users.forEach((u) => {
            rememberUser(rs, u);
            const uname = parseUserLabel(u, 'Espectador');
            const uPts = Number(u?.score || u?.points || 0);
            contributors.push({ user: uname, points: uPts });
            if (uPts > 0 && uPts !== gPts) {
              const prev = rs.battle.matchGifters.get(uname) || { user: uname, coins: 0, giftsCount: 0, lastGift: 'Batalla PK' };
              if (uPts > prev.coins) prev.coins = uPts;
              rs.battle.matchGifters.set(uname, prev);
            }
          });
        }
      });
      if (groupMax > score) score = groupMax;
    }

    const extraLists = [item?.participants, item?.userArmies, item?.users, item?.armyUsers];
    extraLists.forEach((arr) => {
      if (Array.isArray(arr)) {
        arr.forEach((u) => {
          rememberUser(rs, u);
          const uname = parseUserLabel(u, 'Espectador');
          const uPts = Number(u?.score || u?.points || u?.giftCount || 0);
          if (!contributors.some((c) => c.user === uname)) {
            contributors.push({ user: uname, points: uPts });
          }
          if (uPts > 0 && uPts !== score) {
            const prev = rs.battle.matchGifters.get(uname) || { user: uname, coins: 0, giftsCount: 0, lastGift: 'Batalla PK' };
            if (uPts > prev.coins) prev.coins = uPts;
            rs.battle.matchGifters.set(uname, prev);
          }
        });
      }
    });

    contributors.sort((a, b) => b.points - a.points);

    // Deduplicate if the same hostId appears twice in the same packet (keep higher score & real name)
    const prevInSnap = nextHostMap[cleanHid];
    if (prevInSnap) {
      nextHostMap[cleanHid] = {
        id: cleanHid,
        name: (!hostName.startsWith('Anfitrión #')) ? hostName : prevInSnap.name,
        score: Math.max(prevInSnap.score, score),
        contributors: contributors.length ? contributors.slice(0, 10) : prevInSnap.contributors
      };
    } else {
      nextHostMap[cleanHid] = {
        id: cleanHid,
        name: hostName,
        score,
        contributors: contributors.slice(0, 10)
      };
    }
  });

  // Replace hostMap with ONLY the current live snapshot (never keep phantom 0-pt duplicates!)
  rs.battle.hostMap = nextHostMap;
  rs.battle.players = Object.values(nextHostMap);

  // If LINK_MIC_ARMIES carries 3+ individual hosts directly, sync them into individualHosts too!
  const snapList = Object.values(nextHostMap);
  if (snapList.length >= 3) {
    snapList.forEach((h) => {
      const prev = rs.battle.individualHosts.get(h.id);
      rs.battle.individualHosts.set(h.id, {
        id: h.id,
        name: (!h.name.startsWith('Anfitrión #')) ? h.name : (prev?.name || h.name),
        score: Number(h.score || 0),
        rank: prev?.rank || 0
      });
    });
  }
  return { updated: true, hasUnknownHost };
}

function recordSocialOnce(rs, kind, user) {
  const key = `${kind}:${user}`;
  const now = Date.now();
  const prevTs = rs.recentSocial.get(key) || 0;
  if (now - prevTs < 1500) return false;
  rs.recentSocial.set(key, now);
  if (rs.recentSocial.size > 200) {
    const first = rs.recentSocial.keys().next().value;
    if (first) rs.recentSocial.delete(first);
  }
  return true;
}

async function startTikTokConnection(socket, cleanUser, cleanToken) {
  socket.join(cleanToken);
  disconnectRoom(cleanToken);

  const prevRs = roomStates.get(cleanToken);
  const sameUser = prevRs && prevRs.username.toLowerCase() === ('@' + cleanUser).toLowerCase();
  const rs = createInitialRoomState(cleanUser);
  if (sameUser) {
    rs.stats = { ...prevRs.stats };
    rs.topLikes = new Map(prevRs.topLikes);
    rs.topCoins = new Map(prevRs.topCoins);
    rs.knownUsers = new Map(prevRs.knownUsers);
    rs.activeViewers = new Map(prevRs.activeViewers);
    rs.topViewers = [...(prevRs.topViewers || [])];
  }
  roomStates.set(cleanToken, rs);

  const options = { enableExtendedGiftInfo: true, fetchRoomInfoOnConnect: true };
  if (process.env.EULER_API_KEY) options.signApiKey = process.env.EULER_API_KEY.trim();

  console.log(`[TikPulse] Conectando a @${cleanUser} (token: ${cleanToken})`);
  const tiktok = new TikTokLiveConnection(cleanUser, options);
  activeConnections.set(cleanToken, tiktok);
  const emitToRoom = (ev, data) => io.to(cleanToken).emit(ev, data);

  tiktok.on(ControlEvent.CONNECTED, (st) => {
    rs.connected = true;
    rs.roomId = st?.roomId || rs.roomId;
    hydrateFromRoomInfo(rs, st?.roomInfo || tiktok.roomInfo);
    emitToRoom('tiktok:status', { connected: true, username: rs.username, roomId: rs.roomId });
    emitToRoom('tiktok:stats_sync', serializeRoomStats(rs));
    emitToRoom('tiktok:battle_update', serializeBattle(rs));

    // Periodic 35s sync of roomInfo to keep real coins/shares/follows & battle host names up to date
    const prevTimer = roomSyncTimers.get(cleanToken);
    if (prevTimer) clearInterval(prevTimer);
    roomSyncTimers.set(cleanToken, setInterval(async () => {
      if (!rs.connected) return;
      try {
        const fresh = await tiktok.fetchRoomInfo();
        hydrateFromRoomInfo(rs, fresh);
        emitToRoom('tiktok:stats_sync', serializeRoomStats(rs));
        if (rs.battle.active) emitToRoom('tiktok:battle_update', serializeBattle(rs));
      } catch (_) {}
    }, 35000));
  });

  tiktok.on(ControlEvent.DISCONNECTED, () => {
    rs.connected = false;
    emitToRoom('tiktok:status', { connected: false, username: rs.username });
  });

  tiktok.on(ControlEvent.ERROR, (err) => {
    console.error(`[TikPulse] Error en @${cleanUser}:`, err?.info || err?.message || err);
  });

  tiktok.on(WebcastEvent.CHAT, (d) => {
    rememberUser(rs, d.user || d);
    const user = parseUserLabel(d.user || d, '@user');
    trackActiveViewer(rs, user, d.user?.isModerator ? 'Moderador' : (d.user?.isSubscriber ? 'Suscriptor' : 'Espectador'));
    emitToRoom('tiktok:chat', { user, text: String(d.comment || '').slice(0, 240) });
  });

  tiktok.on(WebcastEvent.GIFT, (d) => {
    rememberUser(rs, d.user || d);
    const user = parseUserLabel(d.user || d, '@user');
    trackActiveViewer(rs, user, 'Donador 🎁');

    const giftId = safeId(d.giftId || d.gift?.id || d.giftDetails?.id || '');
    const giftName = d.giftDetails?.giftName || d.gift?.name || d.giftName || d.extendedGiftInfo?.name || 'Regalo';
    let unitCoins = Number(
      d.giftDetails?.diamondCount ??
      d.gift?.diamond_count ??
      d.diamondCount ??
      d.extendedGiftInfo?.diamond_count ??
      0
    );
    if (!unitCoins && giftId && rs.giftPriceById.has(giftId)) unitCoins = rs.giftPriceById.get(giftId);
    if (!unitCoins && rs.giftPriceByName.has(giftName.toLowerCase())) unitCoins = rs.giftPriceByName.get(giftName.toLowerCase());
    if (!unitCoins) unitCoins = 1;

    const repeatCount = Math.max(1, Number(d.repeatCount || 1));
    const repeatEnd = Boolean(d.repeatEnd);
    const giftType = Number(d.giftDetails?.giftType ?? d.giftType ?? 0);
    const groupId = safeId(d.groupId || d.common?.msgId || '');

    // Real-time delta coin tracker: counts every coin IMMEDIATELY without double-counting combos!
    const streakKey = `${user}:${giftId || giftName}:${groupId || 's'}`;
    const prevStreak = rs.giftStreaks.get(streakKey);
    let deltaCount = repeatCount;
    if (prevStreak && repeatCount >= prevStreak.count && (Date.now() - prevStreak.ts) < 20000) {
      deltaCount = repeatCount - prevStreak.count;
    }
    rs.giftStreaks.set(streakKey, { count: repeatCount, ts: Date.now() });
    if (repeatEnd || giftType !== 1) rs.giftStreaks.delete(streakKey);

    if (deltaCount > 0) {
      const deltaCoins = unitCoins * deltaCount;
      rs.stats.coins += deltaCoins;
      rs.topCoins.set(user, (rs.topCoins.get(user) || 0) + deltaCoins);

      if (rs.battle.active && rs.ownerUserId && rs.battle.individualHosts.has(rs.ownerUserId)) {
        const oh = rs.battle.individualHosts.get(rs.ownerUserId);
        oh.score = Number(oh.score || 0) + deltaCoins;
      }
      const prev = rs.battle.matchGifters.get(user) || { user, coins: 0, giftsCount: 0, lastGift: '' };
      prev.coins += deltaCoins;
      prev.giftsCount += deltaCount;
      prev.lastGift = `${giftName} ×${repeatCount}`;
      rs.battle.matchGifters.set(user, prev);

      emitToRoom('tiktok:stats_sync', serializeRoomStats(rs));
      emitToRoom('tiktok:battle_update', serializeBattle(rs));
    }

    if (giftType !== 1 || repeatEnd) {
      const total = unitCoins * repeatCount;
      rs.battle.throws.unshift({
        user,
        giftName,
        coins: unitCoins,
        repeatCount,
        total,
        time: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      });
      if (rs.battle.throws.length > 40) rs.battle.throws.pop();
      emitToRoom('tiktok:battle_update', serializeBattle(rs));
    }

    emitToRoom('tiktok:gift', { user, giftName, coins: unitCoins, repeatCount, repeatEnd, giftType });
  });

  tiktok.on(WebcastEvent.LIKE, (d) => {
    rememberUser(rs, d.user || d);
    const user = parseUserLabel(d.user || d, '@user');
    const likeCount = Number(d.likeCount || 1);
    const totalLikeCount = Number(d.totalLikeCount || 0);
    if (totalLikeCount > 0) rs.stats.likes = totalLikeCount;
    else rs.stats.likes += likeCount;
    rs.topLikes.set(user, (rs.topLikes.get(user) || 0) + likeCount);
    emitToRoom('tiktok:like', { user, likeCount, totalLikeCount: rs.stats.likes });
  });

  function handleFollow(d) {
    rememberUser(rs, d.user || d);
    const user = parseUserLabel(d.user || d, '@user');
    if (!recordSocialOnce(rs, 'follow', user)) return;
    trackActiveViewer(rs, user, 'Seguidor ⭐');
    rs.stats.follows += 1;
    emitToRoom('tiktok:follow', { user });
    emitToRoom('tiktok:stats_sync', serializeRoomStats(rs));
  }

  function handleShare(d) {
    rememberUser(rs, d.user || d);
    const user = parseUserLabel(d.user || d, '@user');
    if (!recordSocialOnce(rs, 'share', user)) return;
    const totalShare = Number(d.totalShareCount || d.shareCount || d.common?.shareCount || 0);
    if (totalShare > rs.stats.shares) rs.stats.shares = totalShare;
    else rs.stats.shares += 1;
    emitToRoom('tiktok:share', { user, totalShares: rs.stats.shares });
    emitToRoom('tiktok:stats_sync', serializeRoomStats(rs));
  }

  tiktok.on(WebcastEvent.FOLLOW, handleFollow);
  tiktok.on(WebcastEvent.SHARE, handleShare);
  if (WebcastEvent.SOCIAL) {
    tiktok.on(WebcastEvent.SOCIAL, (d) => {
      const dt = String(d.displayType || d.common?.displayText?.key || '').toLowerCase();
      const act = Number(d.action || 0);
      if (dt.includes('share') || act === 3) handleShare(d);
      else if (dt.includes('follow') || act === 1) handleFollow(d);
    });
  }

  tiktok.on(WebcastEvent.MEMBER, (d) => {
    rememberUser(rs, d.user || d);
    const user = parseUserLabel(d.user || d, '@user');
    trackActiveViewer(rs, user, 'Espectador');
    emitToRoom('tiktok:join', { user });
  });

  tiktok.on(WebcastEvent.SUBSCRIBE, (d) => {
    rememberUser(rs, d.user || d);
    const user = parseUserLabel(d.user || d, '@user');
    trackActiveViewer(rs, user, 'Suscriptor 👑');
    rs.stats.subs += 1;
    emitToRoom('tiktok:sub', { user });
    emitToRoom('tiktok:stats_sync', serializeRoomStats(rs));
  });

  tiktok.on(WebcastEvent.ROOM_USER, (d) => {
    rs.stats.viewers = Number(d.viewerCount || d.viewer_count || 0);
    const rawRanks = Array.isArray(d.ranksList) && d.ranksList.length
      ? d.ranksList
      : (Array.isArray(d.topViewers) ? d.topViewers : []);
    if (rawRanks.length) {
      rs.topViewers = rawRanks.slice(0, 25).map((r, idx) => {
        const uObj = r.user || r;
        rememberUser(rs, uObj);
        const label = parseUserLabel(uObj, 'Espectador');
        const coins = Number(r.coinCount ?? r.coin_count ?? r.score ?? r.fanTicket ?? 0);
        const role = idx === 0 ? 'Top #1 👑' : (idx === 1 ? 'Top #2 🥈' : (idx === 2 ? 'Top #3 🥉' : (coins > 0 ? 'Donador 🎁' : 'En sala')));
        trackActiveViewer(rs, label, role);
        if (coins > 0) {
          const prevC = rs.topCoins.get(label) || 0;
          if (coins > prevC) rs.topCoins.set(label, coins);
        }
        return { rank: Number(r.rank || (idx + 1)), user: label, coins, role };
      });
    }
    emitToRoom('tiktok:viewers', {
      viewerCount: rs.stats.viewers,
      topViewers: buildTopViewersList(rs),
      topCoins: Array.from(rs.topCoins.entries()).map(([user, val]) => ({ user, val })).sort((a, b) => b.val - a.val).slice(0, 15),
      activeViewers: Array.from(rs.activeViewers.entries()).slice(-25).reverse().map(([user, role]) => ({ user, role }))
    });
  });

  function harvestFanTicketEntries(obj, out, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return;
    if (Array.isArray(obj)) {
      obj.forEach((el) => harvestFanTicketEntries(el, out, depth + 1));
      return;
    }
    const uid = safeId(obj.UserId || obj.userId || obj.user_id || obj.anchorId || obj.anchor_id || obj.user?.userId || obj.user?.id || obj.User?.UserId);
    const hasScoreKey = ('MatchTotalScore' in obj) || ('matchTotalScore' in obj) || ('FanTicket' in obj) || ('fanTicket' in obj) || ('fan_ticket' in obj) || ('battleScore' in obj);
    if (uid && hasScoreKey) {
      out.push({ uid, obj });
    }
    Object.values(obj).forEach((v) => {
      if (v && typeof v === 'object') harvestFanTicketEntries(v, out, depth + 1);
    });
  }

  if (WebcastEvent.LINK_MIC_FAN_TICKET_METHOD) {
    tiktok.on(WebcastEvent.LINK_MIC_FAN_TICKET_METHOD, async (d) => {
      deepHarvestUsers(rs, d, 0);
      const found = [];
      harvestFanTicketEntries(d, found, 0);
      if (found.length) {
        let missingName = false;
        found.forEach(({ uid, obj: item }, idx) => {
          rememberUser(rs, item?.user || item?.User || item, uid);
          const matchScore = Number(item?.MatchTotalScore ?? item?.matchTotalScore ?? item?.battleScore ?? 0);
          const rawFanTicket = Number(item?.FanTicket ?? item?.fanTicket ?? item?.fan_ticket ?? item?.score ?? 0);
          let score = matchScore;
          if (score <= 0 && rawFanTicket > 0) {
            if (!rs.battle.fanTicketBaselines) rs.battle.fanTicketBaselines = new Map();
            if (!rs.battle.fanTicketBaselines.has(uid)) {
              rs.battle.fanTicketBaselines.set(uid, rawFanTicket);
            }
            const delta = rawFanTicket - (rs.battle.fanTicketBaselines.get(uid) || 0);
            score = delta >= 0 ? delta : rawFanTicket;
          }
          const rank = Number(item?.MatchRank ?? item?.matchRank ?? 0);
          const name = resolveHostName(rs, uid, item?.user || item?.User || item, idx);
          if (name.startsWith('Anfitrión #')) missingName = true;
          const prev = rs.battle.individualHosts.get(uid);
          rs.battle.individualHosts.set(uid, {
            id: uid,
            name: (!name.startsWith('Anfitrión #')) ? name : (prev?.name || name),
            score: Math.max(score, prev?.score || 0),
            rank: rank || prev?.rank || 0
          });
        });
        if (missingName && (Date.now() - rs.lastRoomRefreshTs) > 15000) {
          rs.lastRoomRefreshTs = Date.now();
          try {
            const fresh = await tiktok.fetchRoomInfo();
            hydrateFromRoomInfo(rs, fresh);
          } catch (_) {}
        }
        emitToRoom('tiktok:battle_update', serializeBattle(rs));
      }
    });
  }

  ['LINK_MESSAGE', 'LINK_LAYER', 'LINK_MIC_METHOD', 'LINK_STATE'].forEach((evName) => {
    if (WebcastEvent[evName]) {
      tiktok.on(WebcastEvent[evName], (d) => {
        deepHarvestUsers(rs, d, 0);
        const found = [];
        harvestFanTicketEntries(d, found, 0);
        if (found.length >= 2) {
          found.forEach(({ uid, obj: item }, idx) => {
            const name = resolveHostName(rs, uid, item?.user || item?.User || item, idx);
            const prev = rs.battle.individualHosts.get(uid);
            const sc = Number(item?.MatchTotalScore ?? item?.matchTotalScore ?? item?.battleScore ?? prev?.score ?? 0);
            rs.battle.individualHosts.set(uid, {
              id: uid,
              name: (!name.startsWith('Anfitrión #')) ? name : (prev?.name || name),
              score: Math.max(sc, prev?.score || 0),
              rank: prev?.rank || 0
            });
          });
          if (rs.battle.active) emitToRoom('tiktok:battle_update', serializeBattle(rs));
        }
      });
    }
  });

  tiktok.on(WebcastEvent.LINK_MIC_BATTLE, (d) => {
    parseBattleStart(rs, d);
    emitToRoom('tiktok:battle_update', serializeBattle(rs));
  });

  tiktok.on(WebcastEvent.LINK_MIC_ARMIES, async (d) => {
    const res = parseBattleArmies(rs, d);
    if (res && res.updated) {
      if (res.hasUnknownHost && (Date.now() - rs.lastRoomRefreshTs) > 15000) {
        rs.lastRoomRefreshTs = Date.now();
        try {
          const fresh = await tiktok.fetchRoomInfo();
          hydrateFromRoomInfo(rs, fresh);
        } catch (_) {}
      }
      emitToRoom('tiktok:battle_update', serializeBattle(rs));
    }
  });

  if (WebcastEvent.LINK_MIC_BATTLE_PUNISH_FINISH) {
    tiktok.on(WebcastEvent.LINK_MIC_BATTLE_PUNISH_FINISH, () => {
      rs.battle.active = false;
      rs.battle.status = 2;
      emitToRoom('tiktok:battle_update', serializeBattle(rs));
    });
  }

  try {
    const st = await tiktok.connect();
    rs.connected = true;
    rs.roomId = st?.roomId || rs.roomId;
    hydrateFromRoomInfo(rs, st?.roomInfo || tiktok.roomInfo);
    try {
      const freshInfo = await tiktok.fetchRoomInfo();
      hydrateFromRoomInfo(rs, freshInfo);
    } catch (_) {}

    emitToRoom('tiktok:status', { connected: true, username: rs.username, roomId: rs.roomId });
    emitToRoom('tiktok:stats_sync', serializeRoomStats(rs));
    emitToRoom('tiktok:battle_update', serializeBattle(rs));

    try {
      const rawGifts = await tiktok.fetchAvailableGifts();
      const catalog = (Array.isArray(rawGifts) ? rawGifts : []).map((g) => {
        const coins = Number(g.diamond_count || 1);
        if (g.id) rs.giftPriceById.set(safeId(g.id), coins);
        if (g.name) rs.giftPriceByName.set(String(g.name).toLowerCase(), coins);
        return {
          id: g.id,
          name: g.name,
          coins,
          img: g.image?.url_list?.[0] || ''
        };
      });
      if (catalog.length) {
        rs.giftsCatalog = catalog;
        emitToRoom('tiktok:gifts_catalog', catalog);
      }
    } catch (_) {}
  } catch (err) {
    const rawMsg = err?.message || String(err || '');
    console.error(`[TikPulse] Falló conexión a @${cleanUser}:`, rawMsg);
    let friendly = rawMsg || 'No se pudo conectar. Verifica que el usuario esté EN VIVO ahora mismo.';
    if (/offline|not live|roomId/i.test(rawMsg)) {
      friendly = `El usuario @${cleanUser} no está EN VIVO en este momento (o su cuenta es privada).`;
    } else if (/sign|euler|401|403|api key/i.test(rawMsg)) {
      friendly = `Error de conexión con TikTok (${rawMsg}).`;
    }
    socket.emit('tiktok:error', { message: friendly });
    disconnectRoom(cleanToken);
  }
}


// ==================== MULTI-SALA 2 vs 2 (HASTA 4 ANFITRIONES INDIVIDUALES) ====================
const multiBattleSessions = new Map(); // token -> { active, hosts: [...], matchGifters: Map, throws: [] }

function disconnectMultiBattle(token) {
  const sess = multiBattleSessions.get(token);
  if (!sess) return;
  sess.active = false;
  (sess.hosts || []).forEach((h) => {
    if (h.tiktok) {
      try { h.tiktok.disconnect(); } catch (_) {}
      h.tiktok = null;
    }
    h.connected = false;
  });
  multiBattleSessions.delete(token);
}

function serializeMultiBattle(sess) {
  if (!sess) return { active: false, multiMode: false, players: [], matchTopUsers: [], throws: [] };
  const players = (sess.hosts || []).map((h) => ({
    id: h.ownerUserId || h.username,
    name: h.displayName || h.username,
    username: h.username,
    team: h.team,
    connected: Boolean(h.connected),
    statusText: h.statusText || (h.connected ? 'EN VIVO' : 'Conectando...'),
    score: Number(h.score || 0),
    isOwner: h.slot === 0
  }));
  const team1Total = players.filter((p) => p.team === 1).reduce((s, p) => s + p.score, 0);
  const team2Total = players.filter((p) => p.team === 2).reduce((s, p) => s + p.score, 0);
  const matchTopUsers = Array.from(sess.matchGifters.values())
    .filter((u) => Number(u.coins || 0) > 0)
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 20);
  return {
    active: Boolean(sess.active),
    multiMode: true,
    mode: players.length >= 3 ? `Multi-Sala 2 vs 2 (${players.length} salas)` : `Multi-Sala (${players.length} salas)`,
    team1Total,
    team2Total,
    players,
    matchTopUsers,
    throws: sess.throws.slice(0, 35)
  };
}

async function startMultiBattle(socket, cleanToken, rawUsers) {
  socket.join(cleanToken);
  disconnectMultiBattle(cleanToken);

  const cleaned = (Array.isArray(rawUsers) ? rawUsers : [])
    .slice(0, 4)
    .map((u, idx) => ({
      slot: idx,
      team: idx < 2 ? 1 : 2,
      cleanUser: String(u || '').replace(/^@/, '').trim()
    }))
    .filter((x) => USERNAME_RE.test(x.cleanUser));

  if (cleaned.length < 2) {
    socket.emit('tiktok:error', { message: 'Escribe al menos 2 @usuarios válidos para conectar Multi-Sala.' });
    return;
  }

  const sess = {
    active: true,
    hosts: cleaned.map((x) => ({
      slot: x.slot,
      team: x.team,
      username: '@' + x.cleanUser,
      cleanUser: x.cleanUser,
      displayName: '@' + x.cleanUser,
      ownerUserId: '',
      connected: false,
      statusText: 'Conectando...',
      score: 0,
      giftPriceById: new Map(),
      giftPriceByName: new Map(),
      giftStreaks: new Map(),
      tiktok: null
    })),
    matchGifters: new Map(),
    throws: []
  };
  multiBattleSessions.set(cleanToken, sess);

  const emitMulti = () => io.to(cleanToken).emit('battle:multi_update', serializeMultiBattle(sess));
  emitMulti();

  await Promise.all(sess.hosts.map(async (h) => {
    const options = { enableExtendedGiftInfo: true, fetchRoomInfoOnConnect: true };
    if (process.env.EULER_API_KEY) options.signApiKey = process.env.EULER_API_KEY.trim();
    const conn = new TikTokLiveConnection(h.cleanUser, options);
    h.tiktok = conn;

    conn.on(ControlEvent.CONNECTED, (st) => {
      h.connected = true;
      h.statusText = 'EN VIVO';
      const rInfo = st?.roomInfo?.data || st?.roomInfo || conn.roomInfo?.data || conn.roomInfo;
      if (rInfo?.owner) {
        h.ownerUserId = safeId(rInfo.owner_user_id || rInfo.owner.id_str || rInfo.owner.id);
        h.displayName = rInfo.owner.nickname || rInfo.owner.nickName || h.username;
      }
      emitMulti();
    });

    conn.on(ControlEvent.DISCONNECTED, () => {
      h.connected = false;
      h.statusText = 'Desconectado';
      emitMulti();
    });

    conn.on(WebcastEvent.GIFT, (d) => {
      if (!sess.active) return;
      const sender = parseUserLabel(d.user || d, '@user');
      const giftId = safeId(d.giftId || d.gift?.id || d.giftDetails?.id || '');
      const giftName = d.giftDetails?.giftName || d.gift?.name || d.giftName || d.extendedGiftInfo?.name || 'Regalo';
      let unitCoins = Number(d.giftDetails?.diamondCount ?? d.gift?.diamond_count ?? d.diamondCount ?? d.extendedGiftInfo?.diamond_count ?? 0);
      if (!unitCoins && giftId && h.giftPriceById.has(giftId)) unitCoins = h.giftPriceById.get(giftId);
      if (!unitCoins && h.giftPriceByName.has(giftName.toLowerCase())) unitCoins = h.giftPriceByName.get(giftName.toLowerCase());
      if (!unitCoins) unitCoins = 1;

      const repeatCount = Math.max(1, Number(d.repeatCount || 1));
      const repeatEnd = Boolean(d.repeatEnd);
      const giftType = Number(d.giftDetails?.giftType ?? d.giftType ?? 0);
      const groupId = safeId(d.groupId || d.common?.msgId || '');
      const streakKey = `${sender}:${giftId || giftName}:${groupId || 's'}`;
      const prevStreak = h.giftStreaks.get(streakKey);
      let deltaCount = repeatCount;
      if (prevStreak && repeatCount >= prevStreak.count && (Date.now() - prevStreak.ts) < 20000) {
        deltaCount = repeatCount - prevStreak.count;
      }
      h.giftStreaks.set(streakKey, { count: repeatCount, ts: Date.now() });
      if (repeatEnd || giftType !== 1) h.giftStreaks.delete(streakKey);

      if (deltaCount > 0) {
        const deltaCoins = unitCoins * deltaCount;
        h.score += deltaCoins;
        const prevG = sess.matchGifters.get(sender) || { user: sender, coins: 0, giftsCount: 0, lastGift: '' };
        prevG.coins += deltaCoins;
        prevG.giftsCount += deltaCount;
        prevG.lastGift = `${giftName} → ${h.displayName}`;
        sess.matchGifters.set(sender, prevG);
        emitMulti();
      }

      if (giftType !== 1 || repeatEnd) {
        const total = unitCoins * repeatCount;
        sess.throws.unshift({
          user: sender,
          giftName: `${giftName} (a ${h.displayName})`,
          coins: unitCoins,
          repeatCount,
          total,
          time: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        });
        if (sess.throws.length > 40) sess.throws.pop();
        emitMulti();
      }
    });

    try {
      const st = await conn.connect();
      h.connected = true;
      h.statusText = 'EN VIVO';
      const rInfo = st?.roomInfo?.data || st?.roomInfo || conn.roomInfo?.data || conn.roomInfo;
      if (rInfo?.owner) {
        h.ownerUserId = safeId(rInfo.owner_user_id || rInfo.owner.id_str || rInfo.owner.id);
        h.displayName = rInfo.owner.nickname || rInfo.owner.nickName || h.username;
      }
      emitMulti();
      try {
        const rawGifts = await conn.fetchAvailableGifts();
        (Array.isArray(rawGifts) ? rawGifts : []).forEach((g) => {
          const c = Number(g.diamond_count || 1);
          if (g.id) h.giftPriceById.set(safeId(g.id), c);
          if (g.name) h.giftPriceByName.set(String(g.name).toLowerCase(), c);
        });
      } catch (_) {}
    } catch (err) {
      h.connected = false;
      h.statusText = 'Offline / Error';
      emitMulti();
    }
  }));
}

io.on('connection', (socket) => {
  const ip = socket.handshake.address || 'unknown';

  socket.on('room:join', ({ token }) => {
    if (TOKEN_RE.test(String(token || ''))) socket.join(String(token));
  });

  socket.on('room:resume', async ({ token, username, secret }) => {
    const cleanToken = TOKEN_RE.test(String(token || '')) ? String(token) : '';
    if (!cleanToken) return;
    if (PANEL_SECRET && String(secret || '').trim() !== PANEL_SECRET) return;

    socket.join(cleanToken);
    const rs = roomStates.get(cleanToken);
    if (activeConnections.has(cleanToken) && rs && rs.connected) {
      socket.emit('tiktok:status', { connected: true, username: rs.username, roomId: rs.roomId });
      socket.emit('tiktok:stats_sync', serializeRoomStats(rs));
      socket.emit('tiktok:battle_update', serializeBattle(rs));
      const ms = multiBattleSessions.get(cleanToken);
      if (ms && ms.active) socket.emit('battle:multi_update', serializeMultiBattle(ms));
      if (rs.giftsCatalog.length) socket.emit('tiktok:gifts_catalog', rs.giftsCatalog);
      return;
    }
    const msOnly = multiBattleSessions.get(cleanToken);
    if (msOnly && msOnly.active) socket.emit('battle:multi_update', serializeMultiBattle(msOnly));
    const cleanUser = String(username || '').replace(/^@/, '').trim();
    if (USERNAME_RE.test(cleanUser) && allowRequest(ip, 20)) {
      await startTikTokConnection(socket, cleanUser, cleanToken);
    }
  });

  socket.on('overlay:emit', ({ token, secret, payload }) => {
    if (PANEL_SECRET && String(secret || '').trim() !== PANEL_SECRET) return;
    if (!TOKEN_RE.test(String(token || '')) || !payload) return;
    io.to(token).emit('overlay:event', payload);
  });

  socket.on('tiktok:connect', async ({ username, token, secret }) => {
    if (!allowRequest(ip, 25)) {
      return socket.emit('tiktok:error', { message: 'Límite de intentos alcanzado. Espera 1 minuto.' });
    }
    if (PANEL_SECRET && String(secret || '').trim() !== PANEL_SECRET) {
      return socket.emit('tiktok:error', { message: 'Clave del panel (PANEL_SECRET) incorrecta.' });
    }
    const cleanUser = String(username || '').replace(/^@/, '').trim();
    const cleanToken = TOKEN_RE.test(String(token || '')) ? String(token) : 'tp_default';
    if (!USERNAME_RE.test(cleanUser)) {
      return socket.emit('tiktok:error', { message: 'Usuario inválido. Escribe tu @usuario de TikTok sin espacios.' });
    }
    if (!activeConnections.has(cleanToken) && activeConnections.size >= MAX_ACTIVE_ROOMS) {
      return socket.emit('tiktok:error', { message: 'Límite máximo de salas activas alcanzado.' });
    }
    await startTikTokConnection(socket, cleanUser, cleanToken);
  });


  socket.on('battle:multi_connect', async ({ token, users, secret }) => {
    if (!allowRequest(ip, 15)) return socket.emit('tiktok:error', { message: 'Espera unos segundos antes de reconectar Multi-Sala.' });
    if (PANEL_SECRET && String(secret || '').trim() !== PANEL_SECRET) {
      return socket.emit('tiktok:error', { message: 'Clave del panel (PANEL_SECRET) incorrecta.' });
    }
    const cleanToken = TOKEN_RE.test(String(token || '')) ? String(token) : 'tp_default';
    await startMultiBattle(socket, cleanToken, users);
  });

  socket.on('battle:multi_reset_scores', ({ token }) => {
    const cleanToken = TOKEN_RE.test(String(token || '')) ? String(token) : '';
    const sess = multiBattleSessions.get(cleanToken);
    if (!sess) return;
    sess.hosts.forEach((h) => { h.score = 0; });
    sess.matchGifters = new Map();
    sess.throws = [];
    io.to(cleanToken).emit('battle:multi_update', serializeMultiBattle(sess));
  });

  socket.on('battle:multi_disconnect', ({ token }) => {
    const cleanToken = TOKEN_RE.test(String(token || '')) ? String(token) : '';
    if (cleanToken) {
      disconnectMultiBattle(cleanToken);
      io.to(cleanToken).emit('battle:multi_update', { active: false, multiMode: false, players: [], matchTopUsers: [], throws: [] });
    }
  });

  socket.on('tiktok:disconnect', ({ token, secret }) => {
    if (PANEL_SECRET && String(secret || '').trim() !== PANEL_SECRET) return;
    const cleanToken = String(token || '');
    if (TOKEN_RE.test(cleanToken)) {
      disconnectRoom(cleanToken);
      roomStates.delete(cleanToken);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`TikPulse LIVE corriendo en http://0.0.0.0:${PORT} | EulerKey: ${Boolean(process.env.EULER_API_KEY)} | PanelSecret: ${Boolean(PANEL_SECRET)}`);
});
