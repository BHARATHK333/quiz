/**
 * QuizMaster Live — a lightweight self-hosted quiz app.
 * Features:
 * - Up to ~150 players per game (single Node process w/ Socket.IO)
 * - Host creates a game PIN + builds a quiz in the browser
 * - Players join by name, answer on timer, and see leaderboards
 * - Speed-based scoring and confetti for winners 🎉
 *
 * RUN:
 *   npm install
 *   npm run dev
 *   open http://localhost:3000/host.html (host)
 *   open http://localhost:3000 (players)
 */

const express = require('express');
const http = require('http');
const compression = require('compression');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');

const app = express();
app.use(helmet({
  contentSecurityPolicy: false, // keep simple for local use
}));
app.use(compression());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || null;

// ===== Simple in-memory store (ephemeral) =====

/**
 * games: Map<PIN, Game>
 * Game = {
 *   code,
 *   hostId,
 *   players: Map<socketId, { id, name, score, answered, answerIndex, answerTime }>
 *   questions: Array<{ prompt, options[4], correctIndex, timeLimitSec }>
 *   state: 'lobby' | 'question' | 'reveal' | 'ended'
 *   currentIndex,
 *   questionStart,
 *   answersSubmitted
 * }
 */
const games = new Map();
const nanoid = customAlphabet('0123456789', 6);
const makePIN = () => nanoid();

const getGameByHost = (socketId) => {
  for (const g of games.values()) if (g.hostId === socketId) return g;
  return null;
};

function sanitizeName(name) {
  if (!name || typeof name !== 'string') return 'Player';
  name = name.trim().slice(0, 24);
  if (!name) return 'Player';
  return name.replace(/\s+/g, ' ');
}

function ensureUniqueName(game, desired) {
  const names = new Set(Array.from(game.players.values()).map(p => p.name.toLowerCase()));
  let base = sanitizeName(desired);
  let candidate = base;
  let i = 2;
  while (names.has(candidate.toLowerCase())) {
    candidate = `${base} #${i++}`;
  }
  return candidate;
}

function currentPlayersArray(game) {
  return Array.from(game.players.values()).map(p => ({ id: p.id, name: p.name, score: p.score }));
}

function rankPlayers(game) {
  const arr = currentPlayersArray(game).sort((a,b) => b.score - a.score);
  arr.forEach((p, idx) => p.rank = idx + 1);
  return arr;
}

function safeQuestion(q) {
  return { prompt: q.prompt, options: q.options, timeLimitSec: q.timeLimitSec, total: null, index: null };
}

function nowMs() { return Date.now(); }

function buildLeaderboard(game, topN=10) {
  return rankPlayers(game).slice(0, topN);
}

function broadcastLobby(game) {
  io.to(game.code).emit('lobby:update', {
    players: currentPlayersArray(game),
    count: game.players.size,
    code: game.code,
  });
  // send to host UI too
  if (game.hostId) {
    io.to(game.hostId).emit('host:lobby:update', {
      players: currentPlayersArray(game),
      count: game.players.size,
      code: game.code,
    });
  }
}

function startQuestion(game) {
  const idx = game.currentIndex;
  const q = game.questions[idx];
  game.state = 'question';
  game.questionStart = nowMs();
  game.answersSubmitted = 0;
  for (const p of game.players.values()) {
    p.answered = false;
    p.answerIndex = null;
    p.answerTime = null;
  }
  const payload = {
    index: idx + 1,
    total: game.questions.length,
    prompt: q.prompt,
    options: q.options,
    timeLimitSec: q.timeLimitSec,
    code: game.code,
  };
  io.to(game.code).emit('question:show', payload);
  io.to(game.hostId).emit('host:question:show', { ...payload });
  // end question after time limit
  setTimeout(() => {
    if (game.state === 'question' && game.currentIndex === idx) {
      revealAnswer(game);
    }
  }, q.timeLimitSec * 1000 + 50);
}

function revealAnswer(game) {
  const idx = game.currentIndex;
  const q = game.questions[idx];
  game.state = 'reveal';

  // score
  const start = game.questionStart;
  for (const p of game.players.values()) {
    if (p.answered && p.answerIndex === q.correctIndex) {
      const elapsed = Math.max(0, (p.answerTime - start) / 1000);
      const rem = Math.max(0, q.timeLimitSec - elapsed);
      const speedBonus = Math.round(1000 * (rem / q.timeLimitSec));
      const base = 500;
      p.score += base + speedBonus;
    }
  }

  const counts = [0,0,0,0];
  for (const p of game.players.values()) {
    if (typeof p.answerIndex === 'number') counts[p.answerIndex]++;
  }

  const leaderboard = buildLeaderboard(game, 10);

  // Broadcast generic reveal
  io.to(game.code).emit('question:reveal', {
    index: idx + 1,
    total: game.questions.length,
    correctIndex: q.correctIndex,
    counts,
    leaderboard,
  });

  // Send personal rank to each player
  const ranked = rankPlayers(game);
  const rankById = new Map(ranked.map(r => [r.id, { rank: r.rank, score: r.score }]));
  for (const p of game.players.values()) {
    const me = rankById.get(p.id);
    io.to(p.id).emit('question:reveal:me', {
      correct: p.answerIndex === q.correctIndex,
      yourScore: me?.score ?? p.score,
      yourRank: me?.rank ?? null,
      gained: (p.answered && p.answerIndex === q.correctIndex) ? 'yes' : 'no'
    });
  }

  io.to(game.hostId).emit('host:question:reveal', {
    index: idx + 1,
    total: game.questions.length,
    correctIndex: q.correctIndex,
    counts,
    leaderboard,
  });
}

function endGame(game) {
  game.state = 'ended';
  const leaderboard = rankPlayers(game).slice(0, 20);
  io.to(game.code).emit('game:over', { leaderboard });
  io.to(game.hostId).emit('host:game:over', { leaderboard });
}

io.on('connection', (socket) => {
  const providedKey = socket.handshake?.auth?.hostKey;
  socket.data = socket.data || {};
  socket.data.isHost = !!(HOST_KEY && providedKey && HOST_KEY === String(providedKey));

  // Host creates a game
  socket.on('host:createGame', () => {
    if (!socket.data.isHost) { socket.emit('host:error', { message: 'Not authorized (HOST_KEY required).' }); return; }
    const code = makePIN();
    const game = {
      code,
      hostId: socket.id,
      players: new Map(),
      questions: [],
      state: 'lobby',
      currentIndex: 0,
      questionStart: null,
      answersSubmitted: 0,
    };
    games.set(code, game);
    socket.join(code); // host also joins room
    socket.emit('host:gameCreated', { code });
  });

  // Host starts game with quiz payload
  socket.on('host:startGame', ({ code, questions }) => {
    if (!socket.data.isHost) { socket.emit('host:error', { message: 'Not authorized (HOST_KEY required).' }); return; }
    const game = games.get(code);
    if (!game || game.hostId !== socket.id) return;
    // sanitize questions
    const qs = Array.isArray(questions) ? questions : [];
    game.questions = qs.map(q => ({
      prompt: String(q.prompt || '').slice(0, 300),
      options: Array.isArray(q.options) ? q.options.slice(0,4).map(o => String(o).slice(0,120)) : ['A','B','C','D'],
      correctIndex: Math.min(3, Math.max(0, Number(q.correctIndex) || 0)),
      timeLimitSec: Math.min(120, Math.max(5, Number(q.timeLimitSec) || 20)),
    }));
    if (game.questions.length === 0) return;
    game.state = 'question';
    game.currentIndex = 0;
    startQuestion(game);
  });

  // Host next
  socket.on('host:next', ({ code }) => {
    if (!socket.data.isHost) { socket.emit('host:error', { message: 'Not authorized (HOST_KEY required).' }); return; }
    const game = games.get(code);
    if (!game || game.hostId !== socket.id) return;
    if (game.state === 'question') return; // wait till reveal
    const idx = game.currentIndex + 1;
    if (idx >= game.questions.length) return endGame(game);
    game.currentIndex = idx;
    startQuestion(game);
  });

  // Host end early
  socket.on('host:end', ({ code }) => {
    if (!socket.data.isHost) { socket.emit('host:error', { message: 'Not authorized (HOST_KEY required).' }); return; }
    const game = games.get(code);
    if (!game || game.hostId !== socket.id) return;
    endGame(game);
  });

  // Player joins lobby
  socket.on('player:join', ({ code, name }) => {
    const game = games.get(code);
    if (!game) {
      socket.emit('player:error', { message: 'Game not found. Check the PIN.' });
      return;
    }
    if (game.state !== 'lobby') {
      socket.emit('player:error', { message: 'Game already started.' });
      return;
    }
    const finalName = ensureUniqueName(game, name);
    game.players.set(socket.id, {
      id: socket.id,
      name: finalName,
      score: 0,
      answered: false,
      answerIndex: null,
      answerTime: null,
    });
    socket.join(code);
    socket.emit('player:joined', { code, name: finalName });
    broadcastLobby(game);
  });

  // Player answers
  socket.on('player:answer', ({ code, index }) => {
    const game = games.get(code);
    if (!game) return;
    const player = game.players.get(socket.id);
    if (!player) return;
    if (game.state !== 'question') return;
    const q = game.questions[game.currentIndex];
    const elapsed = (nowMs() - game.questionStart) / 1000;
    if (elapsed > q.timeLimitSec) return; // too late
    if (player.answered) return; // only once
    const idx = Math.max(0, Math.min(3, Number(index)||0));
    player.answered = true;
    player.answerIndex = idx;
    player.answerTime = nowMs();
    game.answersSubmitted++;
    // Notify host about progress
    io.to(game.hostId).emit('host:answerProgress', {
      answered: game.answersSubmitted,
      total: game.players.size
    });
    // Optionally, notify player of lock
    socket.emit('player:answerLocked', { index: idx });
  });

  // Join host room for updates (host page)
  socket.on('host:join', ({ code }) => {
    if (!socket.data.isHost) { socket.emit('host:error', { message: 'Not authorized (HOST_KEY required).' }); return; }
    const game = games.get(code);
    if (!game || game.hostId !== socket.id) return;
    socket.join(code);
    broadcastLobby(game);
  });

  socket.on('disconnect', () => {
    // If host disconnected, leave game active for 2 minutes? For simplicity, we remove host ownership.
    let foundGame = null;
    for (const [code, g] of games.entries()) {
      if (g.hostId === socket.id) {
        foundGame = g;
        // notify players
        io.to(code).emit('game:hostDisconnected');
        // we keep game for a while; here we just delete
        games.delete(code);
        break;
      }
    }
    if (!foundGame) {
      // remove player
      for (const g of games.values()) {
        if (g.players.has(socket.id)) {
          g.players.delete(socket.id);
          broadcastLobby(g);
          break;
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`QuizMaster Live on http://localhost:${PORT}`);
});
