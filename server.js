require('dotenv').config();
const path = require('path');
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

app.get('/overlay', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/overlay-likes.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/widget/:type', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN || true }
});

const activeConnections = new Map();
const roomStates = new Map();

function createInitialRoomState(username) {
  return {
    username: '@' + username,
    connected: false,
    roomId: '',
    stats: { likes: 0, viewers: 0, follows: 0, diamonds: 0, shares: 0, subs: 0 },
    topLikes: new Map(),
    topDiamonds: new Map(),
    giftsCatalog: [],
    battle: {
      active: false,
      status: 0,
      duration: 300,
      hostMap: {}, // hostUserId -> { id, name, score, contributors: [{ user, points }] }
      players: [],
      throws: []   // { user, giftName, coins, repeatCount, total, time }
    }
  };
}

function serializeRoomStats(rs) {
  return {
    username: rs.username,
    connected: rs.connected,
    roomId: rs.roomId,
    stats: rs.stats,
    topLikes: Array.from(rs.topLikes.entries()).map(([user, val]) => ({ user, val })).sort((a, b) => b.val - a.val).slice(0, 15),
    topDiamonds: Array.from(rs.topDiamonds.entries()).map(([user, val]) => ({ user, val })).sort((a, b) => b.val - a.val).slice(0, 15)
  };
}

function serializeBattle(rs) {
  return {
    active: rs.battle.active,
    status: rs.battle.status,
    duration: rs.battle.duration,
    players: rs.battle.players,
    throws: rs.battle.throws.slice(0, 25)
  };
}

function disconnectRoom(token) {
  const existing = activeConnections.get(token);
  if (existing) {
    try { existing.disconnect(); } catch (_) {}
    activeConnections.delete(token);
  }
  const rs = roomStates.get(token);
  if (rs) rs.connected = false;
}

function parseUserLabel(u, fallback = 'Usuario') {
  if (!u) return fallback;
  const uid = u.uniqueId || u.displayId || u.user?.uniqueId || u.user?.displayId;
  const nick = u.nickname || u.nickName || u.user?.nickname || u.user?.nickName;
  if (uid) return '@' + String(uid).replace(/^@/, '');
  if (nick) return String(nick);
  return fallback;
}

function parseBattleStart(rs, d) {
  const hostMap = {};
  // v2 protobuf: d.anchorInfo (Array or Map/Object)
  const anchors = d?.anchorInfo;
  if (Array.isArray(anchors)) {
    anchors.forEach((info, idx) => {
      const hid = String(info?.user?.userId || info?.userId || idx);
      hostMap[hid] = {
        id: hid,
        name: parseUserLabel(info?.user || info, `Host ${idx + 1}`),
        score: 0,
        contributors: []
      };
    });
  } else if (anchors && typeof anchors === 'object') {
    Object.entries(anchors).forEach(([k, info], idx) => {
      const hid = String(info?.user?.userId || info?.userId || k || idx);
      hostMap[hid] = {
        id: hid,
        name: parseUserLabel(info?.user || info, `Host ${idx + 1}`),
        score: 0,
        contributors: []
      };
    });
  }
  // v1 compat: d.battleUsers
  if (!Object.keys(hostMap).length && Array.isArray(d?.battleUsers)) {
    d.battleUsers.forEach((u, idx) => {
      const hid = String(u?.userId || idx);
      hostMap[hid] = {
        id: hid,
        name: parseUserLabel(u, `Host ${idx + 1}`),
        score: 0,
        contributors: []
      };
    });
  }
  const dur = Number(d?.battleSetting?.duration || 300);
  rs.battle = {
    active: true,
    status: 1,
    duration: dur > 0 ? dur : 300,
    hostMap,
    players: Object.values(hostMap),
    throws: []
  };
}

function parseBattleArmies(rs, d) {
  const status = Number(d?.battleStatus ?? 1);
  // Collect entries from d.battleItems (Array or Map/Object) or d.battleArmies (Array)
  let rawEntries = [];
  if (Array.isArray(d?.battleItems) && d.battleItems.length) {
    rawEntries = d.battleItems.map((it, i) => [String(it?.hostUserId || i), it]);
  } else if (d?.battleItems && typeof d.battleItems === 'object' && Object.keys(d.battleItems).length) {
    rawEntries = Object.entries(d.battleItems).map(([k, it]) => [String(it?.hostUserId || k), it]);
  } else if (Array.isArray(d?.battleArmies) && d.battleArmies.length) {
    rawEntries = d.battleArmies.map((it, i) => [String(it?.hostUserId || i), it]);
  }

  if (!rawEntries.length) return false;

  rs.battle.active = status !== 2; // status 1 = active, 2 = ended/punishment
  rs.battle.status = status;

  rawEntries.forEach(([hid, item], idx) => {
    const existing = rs.battle.hostMap[hid];
    const hostName = existing?.name || parseUserLabel(item?.hostUser || item?.user, `@host_${hid.slice(-4)}`);

    // Extract real score (prefer explicit hostScore/points, else battleGroups points)
    let score = Number(item?.hostScore ?? item?.points ?? 0);
    const contributors = [];

    if (Array.isArray(item?.battleGroups) && item.battleGroups.length) {
      let groupMax = 0;
      item.battleGroups.forEach((grp) => {
        const gPts = Number(grp?.points || 0);
        if (gPts > groupMax) groupMax = gPts;
        if (Array.isArray(grp?.users)) {
          grp.users.forEach((u) => {
            contributors.push({
              user: parseUserLabel(u, 'Espectador'),
              points: Number(u?.score || u?.points || gPts || 0)
            });
          });
        }
      });
      if (score === 0 && groupMax > 0) score = groupMax;
    }

    const extraLists = [item?.participants, item?.userArmies, item?.users];
    extraLists.forEach((arr) => {
      if (Array.isArray(arr)) {
        arr.forEach((u) => {
          const uname = parseUserLabel(u, 'Espectador');
          const pts = Number(u?.score || u?.points || u?.giftCount || 0);
          if (!contributors.some((c) => c.user === uname)) {
            contributors.push({ user: uname, points: pts });
          }
        });
      }
    });

    contributors.sort((a, b) => b.points - a.points);

    rs.battle.hostMap[hid] = {
      id: hid,
      name: hostName,
      score,
      contributors: contributors.slice(0, 8)
    };
  });

  rs.battle.players = Object.values(rs.battle.hostMap);
  return true;
}

async function startTikTokConnection(socket, cleanUser, cleanToken) {
  socket.join(cleanToken);
  disconnectRoom(cleanToken);

  const rs = createInitialRoomState(cleanUser);
  roomStates.set(cleanToken, rs);

  const options = { enableExtendedGiftInfo: true, fetchRoomInfoOnConnect: true };
  if (process.env.EULER_API_KEY) options.signApiKey = process.env.EULER_API_KEY.trim();

  console.log(`[TikPulse] Conectando a @${cleanUser} (token: ${cleanToken})`);
  const tiktok = new TikTokLiveConnection(cleanUser, options);
  activeConnections.set(cleanToken, tiktok);
  const emitToRoom = (ev, data) => io.to(cleanToken).emit(ev, data);

  tiktok.on(ControlEvent.CONNECTED, (st) => {
    rs.connected = true;
    rs.roomId = st?.roomId || '';
    const rInfo = st?.roomInfo || tiktok.roomInfo || {};
    const initLikes = Number(rInfo?.like_count || rInfo?.stats?.like_count || 0);
    const initViewers = Number(rInfo?.user_count || 0);
    if (initLikes > 0) rs.stats.likes = initLikes;
    if (initViewers > 0) rs.stats.viewers = initViewers;
    console.log(`[TikPulse] Conectado a @${cleanUser} (roomId: ${rs.roomId}, likes: ${rs.stats.likes})`);
    emitToRoom('tiktok:status', { connected: true, username: rs.username, roomId: rs.roomId });
    emitToRoom('tiktok:stats_sync', serializeRoomStats(rs));
    emitToRoom('tiktok:battle_update', serializeBattle(rs));
  });

  tiktok.on(ControlEvent.DISCONNECTED, () => {
    rs.connected = false;
    emitToRoom('tiktok:status', { connected: false, username: rs.username });
  });

  tiktok.on(ControlEvent.ERROR, (err) => {
    console.error(`[TikPulse] Error en @${cleanUser}:`, err?.info || err?.message || err);
  });

  tiktok.on(WebcastEvent.CHAT, (d) => {
    emitToRoom('tiktok:chat', {
      user: parseUserLabel(d.user || d, '@user'),
      text: String(d.comment || '').slice(0, 240)
    });
  });

  tiktok.on(WebcastEvent.GIFT, (d) => {
    const user = parseUserLabel(d.user || d, '@user');
    const giftName = d.giftName || d.extendedGiftInfo?.name || 'Regalo';
    const coins = Number(d.diamondCount || d.extendedGiftInfo?.diamond_count || 1);
    const repeatCount = Number(d.repeatCount || 1);
    const repeatEnd = Boolean(d.repeatEnd);
    const giftType = d.giftType;

    // Count finished combos (or non-streakable gifts)
    if (giftType !== 1 || repeatEnd) {
      const total = Math.max(1, coins) * Math.max(1, repeatCount);
      rs.stats.diamonds += total;
      rs.topDiamonds.set(user, (rs.topDiamonds.get(user) || 0) + total);

      // Record who threw in the current real battle!
      if (rs.battle.active) {
        rs.battle.throws.unshift({
          user,
          giftName,
          coins,
          repeatCount,
          total,
          time: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        });
        if (rs.battle.throws.length > 30) rs.battle.throws.pop();
        emitToRoom('tiktok:battle_update', serializeBattle(rs));
      }
    }

    emitToRoom('tiktok:gift', { user, giftName, coins, repeatCount, repeatEnd, giftType });
  });

  tiktok.on(WebcastEvent.LIKE, (d) => {
    const user = parseUserLabel(d.user || d, '@user');
    const likeCount = Number(d.likeCount || 1);
    const totalLikeCount = Number(d.totalLikeCount || 0);
    if (totalLikeCount > 0) rs.stats.likes = totalLikeCount;
    else rs.stats.likes += likeCount;
    rs.topLikes.set(user, (rs.topLikes.get(user) || 0) + likeCount);
    emitToRoom('tiktok:like', { user, likeCount, totalLikeCount: rs.stats.likes });
  });

  tiktok.on(WebcastEvent.FOLLOW, (d) => {
    const user = parseUserLabel(d.user || d, '@user');
    rs.stats.follows += 1;
    emitToRoom('tiktok:follow', { user });
  });

  tiktok.on(WebcastEvent.SHARE, (d) => {
    const user = parseUserLabel(d.user || d, '@user');
    rs.stats.shares += 1;
    emitToRoom('tiktok:share', { user });
  });

  tiktok.on(WebcastEvent.MEMBER, (d) => {
    emitToRoom('tiktok:join', { user: parseUserLabel(d.user || d, '@user') });
  });

  tiktok.on(WebcastEvent.SUBSCRIBE, (d) => {
    rs.stats.subs += 1;
    emitToRoom('tiktok:sub', { user: parseUserLabel(d.user || d, '@user') });
  });

  tiktok.on(WebcastEvent.ROOM_USER, (d) => {
    rs.stats.viewers = Number(d.viewerCount || 0);
    emitToRoom('tiktok:viewers', { viewerCount: rs.stats.viewers });
  });

  tiktok.on(WebcastEvent.LINK_MIC_BATTLE, (d) => {
    parseBattleStart(rs, d);
    emitToRoom('tiktok:battle_update', serializeBattle(rs));
  });

  tiktok.on(WebcastEvent.LINK_MIC_ARMIES, (d) => {
    if (parseBattleArmies(rs, d)) {
      emitToRoom('tiktok:battle_update', serializeBattle(rs));
    }
  });

  try {
    const st = await tiktok.connect();
    rs.connected = true;
    rs.roomId = st?.roomId || rs.roomId;
    const rInfo = st?.roomInfo || tiktok.roomInfo || {};
    const initLikes = Number(rInfo?.like_count || rInfo?.stats?.like_count || 0);
    const initViewers = Number(rInfo?.user_count || 0);
    if (initLikes > 0) rs.stats.likes = initLikes;
    if (initViewers > 0) rs.stats.viewers = initViewers;
    emitToRoom('tiktok:status', { connected: true, username: rs.username, roomId: rs.roomId });
    emitToRoom('tiktok:stats_sync', serializeRoomStats(rs));
    emitToRoom('tiktok:battle_update', serializeBattle(rs));

    try {
      const rawGifts = await tiktok.fetchAvailableGifts();
      const catalog = (Array.isArray(rawGifts) ? rawGifts : []).map((g) => ({
        id: g.id,
        name: g.name,
        coins: Number(g.diamond_count || 1),
        img: g.image?.url_list?.[0] || ''
      }));
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

io.on('connection', (socket) => {
  const ip = socket.handshake.address || 'unknown';

  socket.on('room:join', ({ token }) => {
    if (TOKEN_RE.test(String(token || ''))) socket.join(String(token));
  });

  // Seamless resume after page refresh (F5) without disconnecting TikTok LIVE!
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
      if (rs.giftsCatalog.length) socket.emit('tiktok:gifts_catalog', rs.giftsCatalog);
      return;
    }
    // If server restarted or dropped while browser had a saved user, reconnect cleanly
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
