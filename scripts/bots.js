// Simuliert Bot-Spieler.
//   node scripts/bots.js 12                 → erstellt ein Spiel, Bot 1 ist Spielleiter und startet automatisch
//   node scripts/bots.js 8 ABCD             → 8 Bots treten Spiel ABCD bei (du bist Spielleiter)
//   URL=https://… node scripts/bots.js 5 ABCD
import { io } from 'socket.io-client';
import { randomUUID } from 'node:crypto';

const URL = process.env.URL || 'http://localhost:3000';
const N = Number(process.argv[2] || 6);
let code = (process.argv[3] || '').toUpperCase();
const hostMode = !code;

const NAMES = ['Resi-Tant', 'Onkel Ferdl', 'Poidl', 'Mitzi', 'Gusti', 'Hansi', 'Franzl', 'Opa Sepp', 'Vroni', 'Leni', 'Wastl', 'Burgi', 'Hias', 'Loisi', 'Fritzi', 'Kathi', 'Toni', 'Rosi', 'Schorschi', 'Lisi'];
const ANSWERS = ['jo eh, wie immer', 'heast, frag ned so vü', 'des woar sicher da Wind', 'zerst a Achterl, dann red ma weida', 'in Patzenthal is des eh anders', 'mehr schlaf bitte', 'wo is die fernbedienung', 'i hob nix gmacht!', 'lego. überall lego.', 'frag an Herrn Pfarrer'];
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const delay = (min, max) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

let finished = 0;

function bot(i, onCreated) {
  const id = randomUUID();
  const name = NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${i}` : '');
  const s = io(URL, { transports: ['websocket'] });
  const seen = new Set();
  let started = false;

  const call = (ev, payload) => new Promise((res) => s.emit(ev, payload, res));

  s.on('connect', async () => {
    if (i === 0 && hostMode && !code) {
      const res = await call('create', { playerId: id, name });
      code = res.code;
      console.log(`🎲 Spiel erstellt: ${code}  → ${URL}/?r=${code}`);
      onCreated?.();
    } else {
      const res = await call('join', { code, playerId: id, name });
      if (!res.ok) console.log(`❌ ${name}: ${res.error}`);
    }
  });

  s.on('state', async (st) => {
    const key = `${st.phase}:${st.round}`;
    if (st.phase === 'lobby' && st.isHost && hostMode && !started && st.players.filter((p) => p.connected).length >= N) {
      started = true;
      await delay(500, 800);
      call('start', {});
      return;
    }
    if (seen.has(key + (st.phase === 'mom_vote' ? `:${!!st.myAiVote}${!!st.myFunnyVote}` : ''))) return;
    seen.add(key + (st.phase === 'mom_vote' ? `:${!!st.myAiVote}${!!st.myFunnyVote}` : ''));

    switch (st.phase) {
      case 'who_vote':
        await delay(300, 2500);
        call('whoVote', { target: rnd(st.players).id });
        break;
      case 'mom_write':
        if (!st.myAnswer && !st.waitingForAi) {
          await delay(500, 3000);
          call('answer', { text: rnd(ANSWERS) });
        }
        break;
      case 'mom_vote': {
        const others = st.entries.filter((e) => !e.mine);
        if (!others.length) break;
        await delay(300, 2000);
        if (!st.myAiVote) await call('momVote', { kind: 'ai', entryId: rnd(others).id });
        if (!st.myFunnyVote) await call('momVote', { kind: 'funny', entryId: rnd(others).id });
        break;
      }
      case 'mom_result':
        if (i === 0) {
          const ai = st.result.entries.find((e) => e.isAi);
          console.log(`🤖 KI (${st.result.aiSource}): „${ai.text}“ – erkannt von ${st.result.detected}/${st.result.voters}`);
        }
        break;
      case 'final':
        if (i === 0) {
          console.log('🏆 Endstand:');
          st.summary.ranking.forEach((p, k) => console.log(`   ${k + 1}. ${p.name} – ${p.score}`));
        }
        if (++finished === N && process.env.EXIT_ON_FINAL === '1') process.exit(0);
        break;
      default:
        if (i === 0 && (st.phase.endsWith('_result') || st.phase.startsWith('intro'))) {
          console.log(`… ${st.phase} ${st.round}/${st.rounds}`);
        }
    }
  });

  s.on('connect_error', (e) => console.log(`⚠️ ${name}: ${e.message}`));
  return s;
}

if (hostMode) {
  bot(0, () => { for (let i = 1; i < N; i++) setTimeout(() => bot(i), i * 100); });
} else {
  for (let i = 1; i <= N; i++) setTimeout(() => bot(i), i * 100);
}
