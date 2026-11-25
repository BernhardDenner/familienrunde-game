import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { Game, AVATARS } from './game.js';
import { generateAnswer, aiAvailable } from './ai.js';

const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const FAST = process.env.FAST_TIMERS === '1'; // für Tests: kurze Timer

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { pingInterval: 10000, pingTimeout: 8000 });

/** @type {Map<string, Game>} */
const rooms = new Map();

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size, ai: aiAvailable() }));

app.get('/qr.svg', async (req, res) => {
  const url = String(req.query.url || '').slice(0, 300);
  if (!/^https?:\/\//.test(url)) return res.status(400).end();
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
});

app.get('/api/avatars', (_req, res) => res.json(AVATARS));

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // ohne I und O
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const fastConfig = FAST
  ? { introMs: 500, whoVoteMs: 3000, whoResultMs: 1000, momWriteMs: 4000, momVoteMs: 4000, momResultMs: 1500, aiGraceMs: 2000 }
  : {};

function createRoom() {
  const code = newCode();
  const game = new Game(code, { config: fastConfig, generateAnswer, onChange: broadcast });
  rooms.set(code, game);
  console.log(`[room] ${code} erstellt (${rooms.size} aktiv)`);
  return game;
}

function broadcast(game) {
  const sockets = io.sockets.adapter.rooms.get(game.code);
  if (!sockets) return;
  for (const sid of sockets) {
    const s = io.sockets.sockets.get(sid);
    if (s?.data.playerId) s.emit('state', game.view(s.data.playerId));
  }
}

function normCode(code) {
  return String(code || '').trim().toUpperCase();
}

io.on('connection', (socket) => {
  const attach = (game, playerId) => {
    if (socket.data.code && socket.data.code !== game.code) socket.leave(socket.data.code);
    socket.data.code = game.code;
    socket.data.playerId = playerId;
    socket.join(game.code);
    game.setConnected(playerId, true);
  };

  const current = () => {
    const game = rooms.get(socket.data.code);
    return game && game.players.has(socket.data.playerId) ? game : null;
  };

  const safe = (fn) => (payload = {}, ack = () => {}) => {
    try {
      const res = fn(payload || {});
      if (typeof ack === 'function') ack(res || { ok: true });
    } catch (err) {
      console.error('[socket]', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'Interner Fehler' });
    }
  };

  socket.on('create', safe(({ playerId, name, avatar }) => {
    if (!playerId) return { ok: false, error: 'Fehlende ID' };
    const game = createRoom();
    const res = game.addPlayer(String(playerId), name, avatar);
    if (!res.ok) {
      rooms.delete(game.code);
      return res;
    }
    attach(game, String(playerId));
    return { ok: true, code: game.code };
  }));

  socket.on('join', safe(({ code, playerId, name, avatar }) => {
    const game = rooms.get(normCode(code));
    if (!game) return { ok: false, error: 'Spiel nicht gefunden. Code prüfen?' };
    const res = game.addPlayer(String(playerId), name, avatar);
    if (!res.ok) return res;
    attach(game, String(playerId));
    return { ok: true, code: game.code };
  }));

  socket.on('resume', safe(({ code, playerId }) => {
    const game = rooms.get(normCode(code));
    if (!game || !game.players.has(String(playerId))) return { ok: false };
    attach(game, String(playerId));
    return { ok: true, code: game.code };
  }));

  socket.on('leave', safe(() => {
    const game = current();
    if (!game) return { ok: true };
    socket.leave(game.code);
    game.removePlayer(socket.data.playerId);
    socket.data.code = null;
    return { ok: true };
  }));

  const action = (name, fn) =>
    socket.on(name, safe((payload) => {
      const game = current();
      if (!game) return { ok: false, error: 'Nicht im Spiel' };
      return fn(game, socket.data.playerId, payload);
    }));

  action('start', (g, id) => g.start(id));
  action('next', (g, id) => g.next(id));
  action('restart', (g, id) => g.restart(id));
  action('whoVote', (g, id, { target }) => g.voteWho(id, String(target)));
  action('answer', (g, id, { text }) => g.submitAnswer(id, text));
  action('momVote', (g, id, { kind, entryId }) => g.voteMom(id, kind, String(entryId)));

  socket.on('disconnect', () => {
    const game = current();
    if (!game) return;
    // Nur als getrennt markieren, wenn kein anderer Socket dieses Spielers verbunden ist
    const sockets = io.sockets.adapter.rooms.get(game.code) || new Set();
    const stillThere = [...sockets].some((sid) => io.sockets.sockets.get(sid)?.data.playerId === socket.data.playerId);
    if (!stillThere) game.setConnected(socket.data.playerId, false);
  });
});

// Alte Räume aufräumen
setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, game] of rooms) {
    if (game.lastActivity < cutoff) {
      game.dispose();
      rooms.delete(code);
      console.log(`[room] ${code} aufgeräumt`);
    }
  }
}, 10 * 60 * 1000).unref();

httpServer.listen(PORT, () => {
  console.log(`🎉 Spiel läuft auf http://localhost:${PORT}  (KI: ${aiAvailable() ? 'Claude live' : 'Fallback-Antworten – ANTHROPIC_API_KEY fehlt'})`);
});
