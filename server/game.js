import { randomBytes } from 'node:crypto';
import { WHO_WOULD, HUMAN_OR_MACHINE, pick } from './questions.js';

export const DEFAULT_CONFIG = {
  whoRounds: 3,
  momRounds: 2,
  minPlayers: 3,
  maxPlayers: 24,
  maxAnswerLength: 80,
  // Zeiten in Millisekunden
  introMs: 8000,
  whoVoteMs: 20000,
  whoResultMs: 15000,
  momWriteMs: 60000,
  momVoteMs: 40000,
  momResultMs: 25000,
  aiGraceMs: 8000, // so lange wird nach dem Schreiben max. zusätzlich auf die KI gewartet
  hostTransferMs: 30000,
};

export const POINTS = {
  whoMajority: 50, // für die Person gestimmt, die die meisten Stimmen bekam
  aiDetected: 100, // KI-Antwort richtig erkannt
  funnyVote: 50, // pro „lustigste Antwort“-Stimme
  suspectedAsAi: 50, // pro Person, die die eigene Antwort für die KI hielt
};

export const AVATARS = ['🦊', '🐼', '🐸', '🦁', '🐙', '🦄', '🐝', '🐧', '🐢', '🦉', '🐳', '🐨', '🦖', '🐞', '🐯', '🦩', '🐮', '🐷', '🐵', '🦔', '🐰', '🦦', '🐲', '🦜'];

const AI_ID = '__ai__';

function shortId() {
  return randomBytes(4).toString('hex');
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function countBy(map) {
  const counts = new Map();
  for (const v of map.values()) counts.set(v, (counts.get(v) || 0) + 1);
  return counts;
}

/**
 * Eine Spielrunde (ein Raum). Reine Logik; Netzwerk liegt in index.js.
 * Phasen: lobby → intro_who → (who_vote → who_result)×n → intro_mom
 *         → (mom_write → mom_vote → mom_result)×m → final
 */
export class Game {
  constructor(code, { config = {}, generateAnswer, onChange = () => {}, now = () => Date.now() } = {}) {
    this.code = code;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.generateAnswer = generateAnswer;
    this.onChange = onChange;
    this.now = now;

    this.players = new Map(); // id -> {id,name,avatar,score,connected,joinedAt}
    this.hostId = null;
    this.usedQuestions = new Set();
    this.styleExamples = [];
    this.timer = null;
    this.hostTimer = null;
    this.lastActivity = now();
    this.resetGame();
  }

  // ---------- Spieler ----------

  addPlayer(id, name, avatar) {
    name = String(name || '').trim().slice(0, 16);
    if (!name) return { ok: false, error: 'Bitte gib einen Namen ein.' };
    const existing = this.players.get(id);
    if (existing) {
      existing.name = name;
      if (avatar) existing.avatar = avatar;
      existing.connected = true;
      this.touch();
      return { ok: true };
    }
    if (this.players.size >= this.config.maxPlayers) return { ok: false, error: 'Das Spiel ist voll.' };
    const taken = [...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return { ok: false, error: 'Dieser Name ist schon vergeben.' };
    if (!AVATARS.includes(avatar)) avatar = this.freeAvatar();
    this.players.set(id, { id, name, avatar, score: 0, connected: true, joinedAt: this.now() });
    if (!this.hostId) this.hostId = id;
    this.touch();
    return { ok: true };
  }

  freeAvatar() {
    const used = new Set([...this.players.values()].map((p) => p.avatar));
    return AVATARS.find((a) => !used.has(a)) || AVATARS[Math.floor(Math.random() * AVATARS.length)];
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = connected;
    if (id === this.hostId) {
      clearTimeout(this.hostTimer);
      if (!connected) {
        this.hostTimer = setTimeout(() => this.transferHostIfGone(), this.config.hostTransferMs);
      }
    }
    if (connected) this.touch();
    this.checkEarlyAdvance();
    this.emit();
  }

  transferHostIfGone() {
    const host = this.players.get(this.hostId);
    if (host && host.connected) return;
    const next = [...this.players.values()].filter((p) => p.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) {
      this.hostId = next.id;
      this.emit();
    }
  }

  removePlayer(id) {
    if (!this.players.delete(id)) return;
    if (this.hostId === id) {
      this.hostId = null;
      const next = [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (next) this.hostId = next.id;
    }
    this.checkEarlyAdvance();
    this.emit();
  }

  activePlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  isHost(id) {
    return id === this.hostId;
  }

  touch() {
    this.lastActivity = this.now();
  }

  // ---------- Ablauf ----------

  resetGame() {
    clearTimeout(this.timer);
    this.phase = 'lobby';
    this.deadline = null;
    this.whoQuestions = [];
    this.momQuestions = [];
    this.round = 0;
    this.who = null;
    this.mom = null;
    this.history = { who: [], mom: [] };
    this.lastGain = new Map();
    for (const p of this.players.values()) p.score = 0;
  }

  start(byId) {
    if (!this.isHost(byId)) return { ok: false, error: 'Nur der Spielleiter kann starten.' };
    if (this.phase !== 'lobby') return { ok: false, error: 'Das Spiel läuft bereits.' };
    if (this.activePlayers().length < this.config.minPlayers) {
      return { ok: false, error: `Mindestens ${this.config.minPlayers} Spieler nötig.` };
    }
    this.whoQuestions = pick(WHO_WOULD, this.config.whoRounds, this.usedQuestions);
    this.momQuestions = pick(HUMAN_OR_MACHINE, this.config.momRounds, this.usedQuestions);
    [...this.whoQuestions, ...this.momQuestions].forEach((q) => this.usedQuestions.add(q));
    this.setPhase('intro_who', this.config.introMs);
    return { ok: true };
  }

  /** Spielleiter überspringt den aktuellen Timer. */
  next(byId) {
    if (!this.isHost(byId)) return { ok: false, error: 'Nur der Spielleiter kann weiterschalten.' };
    if (this.phase === 'lobby' || this.phase === 'final') return { ok: false };
    this.advance();
    return { ok: true };
  }

  restart(byId) {
    if (!this.isHost(byId)) return { ok: false, error: 'Nur der Spielleiter kann neu starten.' };
    this.resetGame();
    this.emit();
    return { ok: true };
  }

  setPhase(phase, durationMs) {
    clearTimeout(this.timer);
    this.phase = phase;
    this.deadline = durationMs ? this.now() + durationMs : null;
    if (durationMs) this.timer = setTimeout(() => this.advance(), durationMs);
    this.touch();
    this.emit();
  }

  advance() {
    switch (this.phase) {
      case 'intro_who':
        this.round = 0;
        return this.startWhoVote();
      case 'who_vote':
        return this.finishWhoVote();
      case 'who_result':
        if (this.round + 1 < this.whoQuestions.length) {
          this.round++;
          return this.startWhoVote();
        }
        return this.setPhase('intro_mom', this.config.introMs);
      case 'intro_mom':
        this.round = 0;
        return this.startMomWrite();
      case 'mom_write':
        return this.finishMomWrite();
      case 'mom_vote':
        return this.finishMomVote();
      case 'mom_result':
        if (this.round + 1 < this.momQuestions.length) {
          this.round++;
          return this.startMomWrite();
        }
        return this.setPhase('final', null);
      default:
        return undefined;
    }
  }

  checkEarlyAdvance() {
    const active = this.activePlayers();
    if (!active.length) return;
    if (this.phase === 'who_vote' && active.every((p) => this.who.votes.has(p.id))) {
      this.finishWhoVote();
    } else if (this.phase === 'mom_write' && active.every((p) => this.mom.answers.has(p.id))) {
      this.finishMomWrite();
    } else if (
      this.phase === 'mom_vote' &&
      active.every((p) => this.mom.aiVotes.has(p.id) && this.mom.funnyVotes.has(p.id))
    ) {
      this.finishMomVote();
    }
  }

  // ---------- Teil 1: Wer würde am ehesten …? ----------

  startWhoVote() {
    this.who = { question: this.whoQuestions[this.round], votes: new Map(), result: null };
    this.setPhase('who_vote', this.config.whoVoteMs);
  }

  voteWho(voterId, targetId) {
    if (this.phase !== 'who_vote') return { ok: false };
    if (!this.players.has(voterId) || !this.players.has(targetId)) return { ok: false };
    this.who.votes.set(voterId, targetId);
    this.emit();
    this.checkEarlyAdvance();
    return { ok: true };
  }

  finishWhoVote() {
    if (this.phase !== 'who_vote') return;
    const counts = countBy(this.who.votes);
    const max = Math.max(0, ...counts.values());
    const winners = max > 0 ? [...counts.entries()].filter(([, c]) => c === max).map(([id]) => id) : [];
    const gain = new Map();
    for (const [voter, target] of this.who.votes) {
      if (winners.includes(target)) gain.set(voter, (gain.get(voter) || 0) + POINTS.whoMajority);
    }
    this.applyGain(gain);
    const tally = [...counts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count);
    this.who.result = { tally, winners, totalVotes: this.who.votes.size };
    this.history.who.push({ question: this.who.question, winners: winners.map((id) => this.nameOf(id)) });
    this.setPhase('who_result', this.config.whoResultMs);
  }

  // ---------- Teil 2: Mensch oder Maschine ----------

  startMomWrite() {
    const question = this.momQuestions[this.round];
    this.mom = {
      question,
      answers: new Map(),
      ai: null,
      aiPromise: null,
      entries: [],
      aiVotes: new Map(),
      funnyVotes: new Map(),
      result: null,
      waitingForAi: false,
    };
    const mom = this.mom;
    const gen = this.generateAnswer
      ? Promise.resolve(this.generateAnswer(question, this.styleExamples)).catch(() => null)
      : Promise.resolve(null);
    mom.aiPromise = gen.then((res) => {
      mom.ai = res && res.text ? res : { text: 'hauptsache es gibt danach pizza', source: 'fallback' };
      return mom.ai;
    });
    this.setPhase('mom_write', this.config.momWriteMs);
  }

  submitAnswer(playerId, text) {
    if (this.phase !== 'mom_write') return { ok: false, error: 'Gerade nicht möglich.' };
    if (!this.players.has(playerId)) return { ok: false };
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, this.config.maxAnswerLength);
    if (!text) return { ok: false, error: 'Die Antwort ist leer.' };
    this.mom.answers.set(playerId, text);
    this.emit();
    this.checkEarlyAdvance();
    return { ok: true };
  }

  async finishMomWrite() {
    if (this.phase !== 'mom_write' || this.mom.waitingForAi) return;
    const mom = this.mom;
    mom.waitingForAi = true;
    clearTimeout(this.timer);
    this.deadline = null;
    this.emit();
    if (!mom.ai) {
      await Promise.race([mom.aiPromise, new Promise((r) => setTimeout(r, this.config.aiGraceMs))]);
    }
    if (this.mom !== mom || this.phase !== 'mom_write') return; // inzwischen neu gestartet
    if (!mom.ai) mom.ai = { text: 'hauptsache es gibt danach pizza', source: 'fallback' };
    const entries = [...mom.answers.entries()].map(([authorId, text]) => ({ id: shortId(), authorId, text }));
    entries.push({ id: shortId(), authorId: AI_ID, text: mom.ai.text });
    mom.entries = shuffle(entries);
    for (const text of mom.answers.values()) this.styleExamples.push(text);
    this.styleExamples = this.styleExamples.slice(-12);
    mom.waitingForAi = false;
    this.setPhase('mom_vote', this.config.momVoteMs);
  }

  voteMom(voterId, kind, entryId) {
    if (this.phase !== 'mom_vote') return { ok: false };
    if (!this.players.has(voterId)) return { ok: false };
    const entry = this.mom.entries.find((e) => e.id === entryId);
    if (!entry) return { ok: false };
    if (entry.authorId === voterId) return { ok: false, error: 'Das ist deine eigene Antwort 😉' };
    if (kind === 'ai') this.mom.aiVotes.set(voterId, entryId);
    else if (kind === 'funny') this.mom.funnyVotes.set(voterId, entryId);
    else return { ok: false };
    this.emit();
    this.checkEarlyAdvance();
    return { ok: true };
  }

  finishMomVote() {
    if (this.phase !== 'mom_vote') return;
    const mom = this.mom;
    const aiEntry = mom.entries.find((e) => e.authorId === AI_ID);
    const aiCounts = countBy(mom.aiVotes);
    const funnyCounts = countBy(mom.funnyVotes);
    const gain = new Map();
    const add = (id, pts) => {
      if (id !== AI_ID && this.players.has(id)) gain.set(id, (gain.get(id) || 0) + pts);
    };

    const detectives = [];
    for (const [voter, entryId] of mom.aiVotes) {
      if (entryId === aiEntry.id) {
        add(voter, POINTS.aiDetected);
        detectives.push(voter);
      }
    }
    for (const e of mom.entries) {
      add(e.authorId, (funnyCounts.get(e.id) || 0) * POINTS.funnyVote);
      if (e.authorId !== AI_ID) add(e.authorId, (aiCounts.get(e.id) || 0) * POINTS.suspectedAsAi);
    }
    this.applyGain(gain);

    const entries = mom.entries.map((e) => ({
      id: e.id,
      text: e.text,
      authorId: e.authorId,
      isAi: e.authorId === AI_ID,
      aiVotes: aiCounts.get(e.id) || 0,
      funnyVotes: funnyCounts.get(e.id) || 0,
    }));
    const humans = entries.filter((e) => !e.isAi);
    const maxSuspect = Math.max(0, ...humans.map((e) => e.aiVotes));
    const robotLike = maxSuspect > 0 ? humans.filter((e) => e.aiVotes === maxSuspect) : [];
    const maxFunny = Math.max(0, ...entries.map((e) => e.funnyVotes));
    const funniest = maxFunny > 0 ? entries.filter((e) => e.funnyVotes === maxFunny) : [];

    mom.result = {
      aiEntryId: aiEntry.id,
      aiSource: mom.ai.source,
      detected: detectives.length,
      voters: mom.aiVotes.size,
      detectives,
      robotLike: robotLike.map((e) => e.id),
      funniest: funniest.map((e) => e.id),
      entries: entries.sort((a, b) => b.funnyVotes - a.funnyVotes || b.aiVotes - a.aiVotes),
    };
    this.history.mom.push({
      question: mom.question,
      aiText: aiEntry.text,
      detected: detectives.length,
      voters: mom.aiVotes.size,
      detectives,
      robotLike: robotLike.map((e) => e.authorId),
      funniest: funniest.map((e) => ({ authorId: e.authorId, text: e.text })),
      suspectCounts: Object.fromEntries(humans.map((e) => [e.authorId, e.aiVotes])),
      funnyCounts: Object.fromEntries(entries.map((e) => [e.authorId, e.funnyVotes])),
    });
    this.setPhase('mom_result', this.config.momResultMs);
  }

  applyGain(gain) {
    this.lastGain = gain;
    for (const [id, pts] of gain) {
      const p = this.players.get(id);
      if (p) p.score += pts;
    }
  }

  nameOf(id) {
    if (id === AI_ID) return 'KI';
    return this.players.get(id)?.name ?? '???';
  }

  // ---------- Auswertung am Ende ----------

  finalSummary() {
    const ranking = [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score }));

    const sum = (key) => {
      const totals = new Map();
      for (const h of this.history.mom) {
        for (const [id, n] of Object.entries(h[key])) {
          if (id === AI_ID) continue;
          totals.set(id, (totals.get(id) || 0) + n);
        }
      }
      return totals;
    };
    const best = (totals) => {
      const max = Math.max(0, ...totals.values());
      if (max === 0) return null;
      const ids = [...totals.entries()].filter(([id, n]) => n === max && this.players.has(id)).map(([id]) => id);
      return ids.length ? { ids, names: ids.map((id) => this.nameOf(id)), count: max } : null;
    };
    const detectiveCounts = new Map();
    for (const h of this.history.mom) for (const id of h.detectives) detectiveCounts.set(id, (detectiveCounts.get(id) || 0) + 1);

    const aiFunny = this.history.mom.reduce((s, h) => s + (h.funnyCounts[AI_ID] || 0), 0);
    return {
      ranking,
      robot: best(sum('suspectCounts')),
      comedian: best(sum('funnyCounts')),
      detective: best(detectiveCounts),
      ai: {
        detected: this.history.mom.reduce((s, h) => s + h.detected, 0),
        votes: this.history.mom.reduce((s, h) => s + h.voters, 0),
        funnyVotes: aiFunny,
        answers: this.history.mom.map((h) => ({ question: h.question, text: h.aiText })),
      },
      who: this.history.who,
    };
  }

  // ---------- Sicht pro Spieler ----------

  view(playerId) {
    const me = this.players.get(playerId);
    const base = {
      code: this.code,
      phase: this.phase,
      remainingMs: this.deadline ? Math.max(0, this.deadline - this.now()) : null,
      totalMs: this.phaseDuration(),
      round: this.round + 1,
      rounds: this.phase.includes('who') ? this.whoQuestions.length : this.momQuestions.length,
      hostId: this.hostId,
      isHost: this.isHost(playerId),
      minPlayers: this.config.minPlayers,
      maxAnswerLength: this.config.maxAnswerLength,
      me: me ? { id: me.id, name: me.name, avatar: me.avatar, score: me.score, gain: this.lastGain.get(me.id) || 0 } : null,
      players: [...this.players.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, connected: p.connected })),
    };

    switch (this.phase) {
      case 'who_vote':
        return {
          ...base,
          question: this.who.question,
          myVote: this.who.votes.get(playerId) || null,
          done: this.who.votes.size,
          total: this.activePlayers().length,
        };
      case 'who_result':
        return { ...base, question: this.who.question, result: this.who.result, myVote: this.who.votes.get(playerId) || null };
      case 'mom_write':
        return {
          ...base,
          question: this.mom.question,
          myAnswer: this.mom.answers.get(playerId) || null,
          done: this.mom.answers.size,
          total: this.activePlayers().length,
          waitingForAi: this.mom.waitingForAi,
        };
      case 'mom_vote':
        return {
          ...base,
          question: this.mom.question,
          entries: this.mom.entries.map((e) => ({ id: e.id, text: e.text, mine: e.authorId === playerId })),
          myAiVote: this.mom.aiVotes.get(playerId) || null,
          myFunnyVote: this.mom.funnyVotes.get(playerId) || null,
          done: [...this.activePlayers()].filter((p) => this.mom.aiVotes.has(p.id) && this.mom.funnyVotes.has(p.id)).length,
          total: this.activePlayers().length,
        };
      case 'mom_result': {
        const r = this.mom.result;
        return {
          ...base,
          question: this.mom.question,
          result: {
            ...r,
            iDetected: r.detectives.includes(playerId),
            detectives: undefined,
            entries: r.entries.map((e) => ({
              ...e,
              author: e.isAi ? null : { name: this.nameOf(e.authorId), avatar: this.players.get(e.authorId)?.avatar || '❔' },
              mine: e.authorId === playerId,
              authorId: undefined,
            })),
          },
        };
      }
      case 'final':
        return { ...base, summary: this.finalSummary() };
      default:
        return base;
    }
  }

  phaseDuration() {
    const c = this.config;
    return (
      {
        intro_who: c.introMs,
        intro_mom: c.introMs,
        who_vote: c.whoVoteMs,
        who_result: c.whoResultMs,
        mom_write: c.momWriteMs,
        mom_vote: c.momVoteMs,
        mom_result: c.momResultMs,
      }[this.phase] || null
    );
  }

  emit() {
    this.onChange(this);
  }

  dispose() {
    clearTimeout(this.timer);
    clearTimeout(this.hostTimer);
  }
}
