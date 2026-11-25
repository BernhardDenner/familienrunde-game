import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, POINTS } from '../server/game.js';

const LONG = 1e9; // Timer sollen in Tests nicht von selbst feuern

function makeGame(aiText = 'ki antwort', extra = {}) {
  const g = new Game('TEST', {
    config: {
      whoRounds: 1, momRounds: 1, introMs: LONG, whoVoteMs: LONG, whoResultMs: LONG,
      momWriteMs: LONG, momVoteMs: LONG, momResultMs: LONG, aiGraceMs: 50, hostTransferMs: LONG,
      ...extra,
    },
    generateAnswer: async () => ({ text: aiText, source: 'claude' }),
  });
  for (const [id, name] of [['a', 'Anna'], ['b', 'Ben'], ['c', 'Cleo']]) {
    assert.equal(g.addPlayer(id, name, '🦊').ok, true);
  }
  return g;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('Spieler beitreten: erster wird Host, doppelte Namen abgelehnt', (t) => {
  const g = makeGame();
  t.after(() => g.dispose());
  assert.equal(g.hostId, 'a');
  assert.equal(g.addPlayer('d', 'anna', '🐼').ok, false);
  assert.equal(g.addPlayer('d', '   ', '🐼').ok, false);
  // Wiederbeitritt mit gleicher ID ist erlaubt
  assert.equal(g.addPlayer('a', 'Anna', '🦊').ok, true);
  assert.equal(g.players.size, 3);
});

test('Nur Host startet, Mindestanzahl wird geprüft', (t) => {
  const g = makeGame();
  t.after(() => g.dispose());
  assert.equal(g.start('b').ok, false);
  g.setConnected('c', false);
  assert.equal(g.start('a').ok, false);
  g.setConnected('c', true);
  assert.equal(g.start('a').ok, true);
  assert.equal(g.phase, 'intro_who');
});

test('Komplette Partie mit Punktevergabe', async (t) => {
  const g = makeGame('hauptsache pizza');
  t.after(() => g.dispose());
  g.start('a');
  g.next('a');
  assert.equal(g.phase, 'who_vote');

  // Wer würde eher: alle stimmen, früher Wechsel zur Auflösung
  g.voteWho('a', 'b');
  g.voteWho('b', 'b');
  assert.equal(g.phase, 'who_vote');
  g.voteWho('c', 'a');
  assert.equal(g.phase, 'who_result');
  assert.deepEqual(g.who.result.winners, ['b']);
  assert.equal(g.players.get('a').score, POINTS.whoMajority);
  assert.equal(g.players.get('b').score, POINTS.whoMajority);
  assert.equal(g.players.get('c').score, 0);

  g.next('a'); // -> intro_mom
  assert.equal(g.phase, 'intro_mom');
  g.next('a'); // -> mom_write
  assert.equal(g.phase, 'mom_write');

  assert.equal(g.submitAnswer('a', '').ok, false);
  g.submitAnswer('a', 'Antwort A');
  g.submitAnswer('b', 'Antwort B');
  g.submitAnswer('c', 'Antwort C');
  await tick(10);
  assert.equal(g.phase, 'mom_vote');
  assert.equal(g.mom.entries.length, 4);

  const entry = (author) => g.mom.entries.find((e) => e.authorId === author).id;
  const aiId = entry('__ai__');
  // eigene Antwort darf nicht gewählt werden
  assert.equal(g.voteMom('a', 'ai', entry('a')).ok, false);

  g.voteMom('a', 'ai', aiId); // a erkennt KI
  g.voteMom('a', 'funny', entry('b'));
  g.voteMom('b', 'ai', entry('c')); // b hält c für KI
  g.voteMom('b', 'funny', entry('c'));
  g.voteMom('c', 'ai', aiId); // c erkennt KI
  assert.equal(g.phase, 'mom_vote');
  g.voteMom('c', 'funny', entry('b'));
  assert.equal(g.phase, 'mom_result');

  const r = g.mom.result;
  assert.equal(r.detected, 2);
  assert.deepEqual(r.funniest, [entry('b')]);
  assert.deepEqual(r.robotLike, [entry('c')]);

  // a: 50 (who) + 100 (KI erkannt)
  assert.equal(g.players.get('a').score, 50 + POINTS.aiDetected);
  // b: 50 (who) + 2 Lacher
  assert.equal(g.players.get('b').score, 50 + 2 * POINTS.funnyVote);
  // c: 100 (KI erkannt) + 1 Lacher + 1 KI-Verdacht
  assert.equal(g.players.get('c').score, POINTS.aiDetected + POINTS.funnyVote + POINTS.suspectedAsAi);

  g.next('a');
  assert.equal(g.phase, 'final');
  const sum = g.view('a').summary;
  assert.equal(sum.ranking[0].id, 'c');
  assert.deepEqual(sum.comedian.ids, ['b']);
  assert.deepEqual(sum.robot.ids, ['c']);
  assert.equal(sum.ai.detected, 2);
  assert.equal(sum.ai.answers[0].text, 'hauptsache pizza');

  g.restart('a');
  assert.equal(g.phase, 'lobby');
  assert.equal(g.players.get('c').score, 0);
});

test('KI-Ausfall: Fallback-Antwort nach Wartezeit', async (t) => {
  const g = new Game('X', {
    config: { whoRounds: 1, momRounds: 1, aiGraceMs: 30, momWriteMs: LONG, introMs: LONG, whoVoteMs: LONG, whoResultMs: LONG },
    generateAnswer: () => new Promise(() => {}), // hängt für immer
  });
  t.after(() => g.dispose());
  ['a', 'b', 'c'].forEach((id) => g.addPlayer(id, id.toUpperCase(), '🦊'));
  g.start('a');
  g.next('a'); g.next('a'); g.next('a'); g.next('a');
  assert.equal(g.phase, 'mom_write');
  g.next('a');
  assert.equal(g.view('a').waitingForAi, true);
  await tick(60);
  assert.equal(g.phase, 'mom_vote');
  assert.equal(g.mom.ai.source, 'fallback');
  assert.equal(g.mom.entries.length, 1); // niemand hat geschrieben – nur KI
});

test('Getrennte Spieler blockieren den frühen Wechsel nicht', (t) => {
  const g = makeGame();
  t.after(() => g.dispose());
  g.start('a');
  g.next('a');
  g.voteWho('a', 'b');
  g.voteWho('b', 'a');
  assert.equal(g.phase, 'who_vote');
  g.setConnected('c', false);
  assert.equal(g.phase, 'who_result');
});

test('Host-Übergabe, wenn der Host verschwindet', async (t) => {
  const g = makeGame('x', { hostTransferMs: 20 });
  t.after(() => g.dispose());
  g.setConnected('a', false);
  await tick(40);
  assert.equal(g.hostId, 'b');
  g.removePlayer('b');
  assert.equal(g.hostId, 'a');
});

test('Ansicht verrät keine Autoren während der Abstimmung', async (t) => {
  const g = makeGame();
  t.after(() => g.dispose());
  g.start('a'); g.next('a'); g.next('a'); g.next('a'); g.next('a');
  g.submitAnswer('a', 'A'); g.submitAnswer('b', 'B'); g.submitAnswer('c', 'C');
  await tick(10);
  const v = g.view('b');
  assert.equal(v.phase, 'mom_vote');
  for (const e of v.entries) {
    assert.deepEqual(Object.keys(e).sort(), ['id', 'mine', 'text']);
  }
  assert.equal(v.entries.filter((e) => e.mine).length, 1);
});
