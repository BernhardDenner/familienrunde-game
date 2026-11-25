/* global io */
(() => {
  'use strict';

  const AVATARS = ['🦊', '🐼', '🐸', '🦁', '🐙', '🦄', '🐝', '🐧', '🐢', '🦉', '🐳', '🐨', '🦖', '🐞', '🐯', '🦩', '🐮', '🐷', '🐵', '🦔', '🐰', '🦦', '🐲', '🦜'];

  // ---------- Speicher ----------
  const store = {
    get(k) { try { return localStorage.getItem('mom.' + k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem('mom.' + k) : localStorage.setItem('mom.' + k, v); } catch { /* egal */ } },
  };
  let playerId = store.get('id');
  if (!playerId) {
    playerId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    store.set('id', playerId);
  }


  const PLACE = '<p class="place">📍 Pfarrhaus Patzmannsdorf · mit Patzenthal · Weinviertel</p>';
  const CREDIT = `<p class="credit">Hintergrundfotos (Wikimedia Commons):
    <a href="https://commons.wikimedia.org/wiki/File:Patzmannsdorf_-_K%C3%BCrbisfeld_mit_Pfarrkirche_und_Raiffeisen-Silo_in_Stronsdorf.jpg" target="_blank" rel="noopener">Kürbisfeld mit Pfarrkirche Patzmannsdorf</a> – Haeferl, CC BY-SA 4.0 ·
    <a href="https://commons.wikimedia.org/wiki/File:Kapelle_Patzenthal_umgeben_von_Naturdenkm%C3%A4lern.JPG" target="_blank" rel="noopener">Kapelle Patzenthal</a> – Herbert Nowak, CC BY-SA 3.0 AT</p>`;
  // Teil 1 vor dem Pfarrkirchen-Feld in Patzmannsdorf, Teil 2 und Finale vor der Kapelle Patzenthal
  const setBackground = (phase) => {
    document.body.dataset.bg = /^(intro_mom|mom_|final)/.test(phase) ? 'patzenthal' : 'patzmannsdorf';
  };

  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const socket = io({ transports: ['websocket', 'polling'] });
  let state = null;
  let lastKey = null;
  let deadlineAt = null;
  let totalMs = null;
  let editing = false;
  let draft = '';
  let homeAvatar = store.get('avatar') || AVATARS[Math.floor(Math.random() * AVATARS.length)];
  let busy = false;

  const params = new URLSearchParams(location.search);
  const linkCode = (params.get('r') || '').toUpperCase();

  // ---------- Hilfen ----------
  function toast(msg, ms = 2500) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.h);
    toast.h = setTimeout(() => { t.hidden = true; }, ms);
  }

  function emit(ev, payload = {}) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(ev, payload, (err, res) => {
        if (err) { toast('Verbindung hakt… nochmal versuchen'); return resolve({ ok: false }); }
        if (res && !res.ok && res.error) toast(res.error);
        resolve(res || { ok: false });
      });
    });
  }

  function buzz(pattern = 30) {
    try { navigator.vibrate && navigator.vibrate(pattern); } catch { /* egal */ }
  }

  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* nicht unterstützt */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state) keepAwake(); });

  function joinUrl(code) {
    return `${location.origin}/?r=${code}`;
  }

  function playerById(id) {
    return state.players.find((p) => p.id === id);
  }

  // ---------- Startseite ----------
  let onHome = false;
  function renderHome(errorMsg) {
    onHome = true;
    setBackground('lobby');
    state = null;
    lastKey = null;
    $('#topbar').hidden = true;
    $('#timer').hidden = true;
    $('#hostbar').hidden = true;
    const name = store.get('name') || '';
    app.innerHTML = `
      <h1 style="margin-top:18px">🧑 Mensch<br>oder<br>Maschine? 🤖</h1>
      <p class="center white" style="margin-top:-4px">Das Partyspiel der Familienrunde, bei dem eine echte KI mitspielt.</p>
      ${PLACE}
      <div class="card stack">
        <label for="name"><b>Dein Name</b></label>
        <input id="name" type="text" maxlength="16" autocomplete="nickname" placeholder="z.&nbsp;B. Da Poidl" value="${esc(name)}">
        <div><b>Dein Tier</b></div>
        <div class="avatars">${AVATARS.map((a) => `<button type="button" data-av="${a}" class="${a === homeAvatar ? 'sel' : ''}">${a}</button>`).join('')}</div>
      </div>
      <div class="card stack">
        <label for="code"><b>Spiel beitreten</b></label>
        <input id="code" class="code" type="text" maxlength="4" placeholder="CODE" value="${esc(linkCode)}" autocapitalize="characters" autocomplete="off">
        <button id="join" class="btn">Mitspielen 🎉</button>
      </div>
      ${linkCode ? '' : `<div class="card stack">
        <div><b>Du bist Spielleiter?</b></div>
        <button id="create" class="btn secondary">Neues Spiel erstellen</button>
      </div>`}
      ${linkCode ? '<p class="center"><button id="showcreate" class="linkbtn">Stattdessen ein neues Spiel erstellen</button></p>' : ''}
      ${CREDIT}
    `;
    if (errorMsg) toast(errorMsg);
    app.querySelectorAll('[data-av]').forEach((b) => b.addEventListener('click', () => {
      homeAvatar = b.dataset.av;
      app.querySelectorAll('[data-av]').forEach((x) => x.classList.toggle('sel', x === b));
    }));
    const nameIn = $('#name');
    const getName = () => {
      const n = nameIn.value.trim();
      if (!n) { toast('Bitte gib zuerst deinen Namen ein 🙂'); nameIn.focus(); return null; }
      store.set('name', n);
      store.set('avatar', homeAvatar);
      return n;
    };
    $('#join').addEventListener('click', async () => {
      const n = getName(); if (!n || busy) return;
      const code = $('#code').value.trim().toUpperCase();
      if (code.length !== 4) { toast('Der Code hat 4 Buchstaben.'); return; }
      busy = true;
      const res = await emit('join', { code, playerId, name: n, avatar: homeAvatar });
      busy = false;
      if (res.ok) { store.set('code', res.code); keepAwake(); history.replaceState(null, '', '/'); }
    });
    const create = async () => {
      const n = getName(); if (!n || busy) return;
      busy = true;
      const res = await emit('create', { playerId, name: n, avatar: homeAvatar });
      busy = false;
      if (res.ok) { store.set('code', res.code); keepAwake(); history.replaceState(null, '', '/'); }
    };
    $('#create')?.addEventListener('click', create);
    $('#showcreate')?.addEventListener('click', create);
  }

  // ---------- Spiel-Rendering ----------
  function screenKey(s) {
    const parts = [s.phase, s.round, s.isHost];
    switch (s.phase) {
      case 'lobby': parts.push(JSON.stringify(s.players)); break;
      case 'who_vote': parts.push(s.myVote, s.players.length); break;
      case 'mom_write': parts.push(!!s.myAnswer && !editing, s.waitingForAi); break;
      case 'mom_vote': parts.push(s.myAiVote, s.myFunnyVote); break;
      case 'final': parts.push(JSON.stringify(s.summary.ranking)); break;
      default: break;
    }
    return parts.join('|');
  }

  function render(s) {
    const prevPhase = state?.phase;
    onHome = false;
    state = s;
    setBackground(s.phase);
    if (!s.me) { store.set('code', null); renderHome('Du bist nicht mehr im Spiel.'); return; }

    // Kopfzeile
    $('#topbar').hidden = false;
    $('#me-avatar').textContent = s.me.avatar;
    $('#me-name').textContent = s.me.name + (s.isHost ? ' ⭐' : '');
    $('#me-score').textContent = s.me.score;

    // Timer
    if (s.remainingMs != null && s.totalMs) {
      deadlineAt = Date.now() + s.remainingMs;
      totalMs = s.totalMs;
      $('#timer').hidden = false;
    } else {
      deadlineAt = null;
      $('#timer').hidden = true;
    }

    // Spielleiter-Leiste
    const timed = !['lobby', 'final'].includes(s.phase);
    $('#hostbar').hidden = !(s.isHost && timed);
    $('#host-next').textContent = s.phase.endsWith('_result') || s.phase.startsWith('intro') ? '⏭ Weiter' : '⏭ Zeit beenden';

    if (!prevPhase) window.scrollTo(0, 0); // von der Startseite kommend
    if (prevPhase && prevPhase !== s.phase) {
      buzz(s.phase.endsWith('_result') ? [40, 60, 40] : 30);
      if (s.phase === 'mom_write') { editing = false; draft = ''; }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    const key = screenKey(s);
    if (key === lastKey) { updateDynamic(s); return; }
    lastKey = key;

    const fn = {
      lobby: renderLobby,
      intro_who: renderIntroWho,
      who_vote: renderWhoVote,
      who_result: renderWhoResult,
      intro_mom: renderIntroMom,
      mom_write: renderMomWrite,
      mom_vote: renderMomVote,
      mom_result: renderMomResult,
      final: renderFinal,
    }[s.phase];
    app.innerHTML = fn ? fn(s) : '';
    bind(s);
    updateDynamic(s);
  }

  function updateDynamic(s) {
    const done = app.querySelector('[data-done]');
    if (done && s.total != null) done.textContent = `${s.done} von ${s.total} fertig`;
  }

  function tag(s, label) {
    return `<div class="center"><span class="tag">${label} · Runde ${s.round}/${s.rounds}</span></div>`;
  }

  function renderLobby(s) {
    const url = joinUrl(s.code);
    const enough = s.players.filter((p) => p.connected).length >= s.minPlayers;
    return `
      ${PLACE}
      <div class="card center">
        <div class="muted">Spiel-Code · Familienrunde Patzmannsdorf</div>
        <div class="roomcode">${esc(s.code)}</div>
        <img class="qr" src="/qr.svg?url=${encodeURIComponent(url)}" alt="QR-Code zum Beitreten">
        <div class="small muted">Scannen oder auf <b>${esc(location.host)}</b> den Code eingeben</div>
        ${navigator.share ? '<button id="share" class="btn small secondary" style="margin-top:10px">🔗 Link teilen</button>' : ''}
      </div>
      <div class="card">
        <h2>Dabei sind (${s.players.length})</h2>
        <div class="players">
          ${s.players.map((p) => `<span class="chip ${p.connected ? '' : 'off'}">${p.avatar} ${esc(p.name)}${p.id === s.hostId ? ' <span class="host">⭐</span>' : ''}</span>`).join('')}
        </div>
      </div>
      ${s.isHost
        ? `<button id="start" class="btn" ${enough ? '' : 'disabled'}>🚀 Los geht's!</button>
           ${enough ? '' : `<p class="center white small">Noch auf Mitspieler warten (mind. ${s.minPlayers})…</p>`}`
        : '<p class="center white"><b>Gleich geht\'s los!</b><br>Der Spielleiter ⭐ startet das Spiel.</p>'}
      <p class="center"><button id="leave" class="linkbtn">Spiel verlassen</button></p>
    `;
  }

  function renderIntroWho() {
    return `
      <div class="big-emoji">🤔👉</div>
      <h1>Teil 1<br>Wer würde am ehesten …?</h1>
      <div class="card center">
        <p>Gleich erscheint eine Frage. Tippe auf die Person aus der Runde, die <b>am ehesten</b> passt.</p>
        <p class="muted small">Tippst du auf die Person, die die meisten Stimmen bekommt, gibt es <b>+50 Punkte</b> als Gedankenleser.</p>
      </div>
    `;
  }

  function renderWhoVote(s) {
    return `
      ${tag(s, 'Wer würde eher?')}
      <div class="question">${esc(s.question)}</div>
      <div class="pgrid">
        ${s.players.map((p) => `
          <button class="pbtn ${s.myVote === p.id ? 'sel' : ''}" data-target="${esc(p.id)}">
            <span class="av">${p.avatar}</span><span class="nm">${esc(p.name)}${p.id === s.me.id ? ' (ich)' : ''}</span>
          </button>`).join('')}
      </div>
      <div class="progress" data-done></div>
    `;
  }

  function renderWhoResult(s) {
    const r = s.result;
    const winners = r.winners.map(playerById).filter(Boolean);
    const max = r.tally[0]?.count || 1;
    let head;
    if (!winners.length) {
      head = '<div class="card center"><div class="big-emoji">🦗</div><b>Niemand hat abgestimmt…</b></div>';
    } else {
      head = `<div class="card winner">
        <span class="crown">👑</span>
        ${winners.map((w) => `<span class="av">${w.avatar}</span><div class="nm">${esc(w.name)}</div>`).join('')}
        <div class="muted" style="margin-top:6px">${winners.length > 1 ? 'Unentschieden!' : `${r.tally[0].count} von ${r.totalVotes} Stimmen`}</div>
      </div>`;
    }
    return `
      ${tag(s, 'Wer würde eher?')}
      <div class="question">${esc(s.question)}</div>
      ${s.me.gain ? `<div class="gain">🧠 Gedankenleser! +${s.me.gain}</div>` : ''}
      ${head}
      <div class="card">
        ${r.tally.map((t) => {
          const p = playerById(t.id);
          return `<div class="bar"><div class="lbl"><span>${p ? p.avatar + ' ' + esc(p.name) : '???'}</span><span>${t.count}</span></div>
            <div class="track"><div class="fill" style="width:${(t.count / max) * 100}%"></div></div></div>`;
        }).join('')}
      </div>
    `;
  }

  function renderIntroMom() {
    return `
      <div class="big-emoji">🧑 vs 🤖</div>
      <h1>Teil 2<br>Mensch oder Maschine?</h1>
      <div class="card stack">
        <p><b>1.</b> Alle schreiben eine kurze, witzige Antwort auf eine Frage.</p>
        <p><b>2.</b> Eine echte KI schreibt heimlich <b>auch eine Antwort</b> und versucht, wie ein Mensch aus dem Weinviertel zu klingen. Ob sie Patzmannsdorf und Patzenthal täuschen kann? 😏</p>
        <p><b>3.</b> Findet die KI-Antwort 🤖 und wählt die lustigste 😂.</p>
        <p class="muted small">KI erkannt: +100 · pro Lacher: +50 · Hält dich jemand für die KI? +50 pro Stimme 😏</p>
      </div>
    `;
  }

  function renderMomWrite(s) {
    if (s.waitingForAi) {
      return `
        ${tag(s, 'Mensch oder Maschine')}
        <div class="question">${esc(s.question)}</div>
        <div class="card center">
          <div class="big-emoji">🤖⌨️</div>
          <b>Die KI tippt noch …</b>
          <div class="typing"><span>●</span><span>●</span><span>●</span></div>
        </div>`;
    }
    if (s.myAnswer && !editing) {
      return `
        ${tag(s, 'Mensch oder Maschine')}
        <div class="question">${esc(s.question)}</div>
        <div class="card center stack">
          <div class="big-emoji">✅</div>
          <div><b>Deine Antwort:</b></div>
          <div style="font-size:1.15rem">„${esc(s.myAnswer)}“</div>
          <button id="edit" class="btn small secondary">✏️ Ändern</button>
        </div>
        <div class="progress" data-done></div>
      `;
    }
    return `
      ${tag(s, 'Mensch oder Maschine')}
      <div class="question">${esc(s.question)}</div>
      <div class="card stack">
        <textarea id="answer" maxlength="${s.maxAnswerLength}" placeholder="Deine Antwort … (kurz & lustig, gern a bissl Mundart)" enterkeyhint="send"></textarea>
        <div class="row"><span class="grow muted small" id="chars"></span><button id="send" class="btn small">Abschicken ✈️</button></div>
        <p class="muted small">Tipp: Schreib so, dass die anderen denken, <b>du</b> wärst die KI 😉</p>
      </div>
      <div class="progress" data-done></div>
    `;
  }

  function renderMomVote(s) {
    return `
      ${tag(s, 'Mensch oder Maschine')}
      <div class="question">${esc(s.question)}</div>
      <div class="status">
        <span class="${s.myAiVote ? 'ok' : ''}">🤖 KI ${s.myAiVote ? '✓' : '?'}</span>
        <span class="${s.myFunnyVote ? 'ok' : ''}">😂 Lustigste ${s.myFunnyVote ? '✓' : '?'}</span>
      </div>
      ${s.entries.map((e) => `
        <div class="entry ${e.mine ? 'mine' : ''} ${s.myAiVote === e.id ? 'sel-ai' : ''} ${s.myFunnyVote === e.id ? 'sel-funny' : ''}">
          <div class="txt">${esc(e.text)}</div>
          ${e.mine ? '<div class="muted small">Das ist deine Antwort</div>' : `
          <div class="acts">
            <button class="ai ${s.myAiVote === e.id ? 'sel' : ''}" data-vote="ai" data-id="${esc(e.id)}">🤖 KI!</button>
            <button class="funny ${s.myFunnyVote === e.id ? 'sel' : ''}" data-vote="funny" data-id="${esc(e.id)}">😂 Lustig</button>
          </div>`}
        </div>`).join('')}
      <div class="progress" data-done></div>
    `;
  }

  function renderMomResult(s) {
    const r = s.result;
    const ai = r.entries.find((e) => e.isAi);
    const robot = r.entries.filter((e) => r.robotLike.includes(e.id));
    const funniest = r.entries.filter((e) => r.funniest.includes(e.id));
    const fooled = r.voters - r.detected;
    let verdict;
    if (r.voters === 0) verdict = 'Niemand hat getippt 🙈';
    else if (r.detected === 0) verdict = 'Weder Patzmannsdorf noch Patzenthal hat die KI erkannt! 😱';
    else if (fooled === 0) verdict = 'Alle haben die KI entlarvt! 🕵️';
    else verdict = `${r.detected} von ${r.voters} haben die KI erkannt`;
    return `
      ${tag(s, 'Mensch oder Maschine')}
      <div class="reveal">
        <div>🤖 Das hat die KI geschrieben:</div>
        <div class="ai-text">„${esc(ai.text)}“</div>
        <div><b>${verdict}</b></div>
        ${r.aiSource === 'fallback' ? '<div class="small" style="opacity:.8">(Ersatzantwort – die KI war gerade nicht erreichbar)</div>' : ''}
      </div>
      <div class="gain">${r.iDetected ? '🕵️ Du hast sie erkannt! ' : ''}${s.me.gain ? `+${s.me.gain} Punkte` : (r.iDetected ? '' : 'Diesmal keine Punkte 🙃')}</div>
      ${robot.length ? `<div class="card award"><div class="ico">🤖</div><div>
        <div class="t">Verdächtig maschinell</div>
        <div>${robot.map((e) => `${e.author.avatar} <b>${esc(e.author.name)}</b>`).join(', ')} wurde für die KI gehalten (${robot[0].aiVotes}×)</div>
        <div class="muted small">„${esc(robot[0].text)}“</div></div></div>` : ''}
      ${funniest.length ? `<div class="card award"><div class="ico">😂</div><div>
        <div class="t">Lacher der Runde</div>
        <div>${funniest.map((e) => e.isAi ? '🤖 <b>die KI</b> (ups!)' : `${e.author.avatar} <b>${esc(e.author.name)}</b>`).join(', ')} mit ${funniest[0].funnyVotes} Stimme${funniest[0].funnyVotes > 1 ? 'n' : ''}</div>
        <div class="muted small">„${esc(funniest[0].text)}“</div></div></div>` : ''}
      <h2 class="white" style="margin-top:18px">Alle Antworten</h2>
      ${r.entries.map((e) => `
        <div class="entry ${e.isAi ? 'reveal-ai' : ''}">
          <div class="txt">${esc(e.text)}</div>
          <div class="who">
            <span class="author">${e.isAi ? '🤖 KI' : `${e.author.avatar} ${esc(e.author.name)}`}${e.mine ? ' (du)' : ''}</span>
            <span class="badges"><span>🤖 ${e.aiVotes}</span><span>😂 ${e.funnyVotes}</span></span>
          </div>
        </div>`).join('')}
    `;
  }

  function renderFinal(s) {
    const sum = s.summary;
    const top = sum.ranking.slice(0, 3);
    const order = [top[1], top[0], top[2]];
    const cls = ['p2', 'p1', 'p3'];
    const award = (ico, title, a, text) => a ? `<div class="card award"><div class="ico">${ico}</div><div><div class="t">${title}</div><div>${a.names.map(esc).join(', ')} ${text(a.count)}</div></div></div>` : '';
    return `
      <h1>🏆 Endstand</h1>
      ${PLACE}
      <div class="podium">
        ${order.map((p, i) => p ? `<div class="p ${cls[i]}"><div class="av">${p.avatar}</div><div class="nm">${esc(p.name)}</div><div class="blk">${p.score}</div></div>` : '<div class="p"></div>').join('')}
      </div>
      <div class="card">
        ${sum.ranking.map((p, i) => `<div class="rank"><span>${i + 1}. ${p.avatar} ${esc(p.name)}${p.id === s.me.id ? ' (du)' : ''}</span><span>${p.score}</span></div>`).join('')}
      </div>
      <div class="reveal">
        <div class="big-emoji" style="margin:0">🤖</div>
        <div class="ai-text">Die KI wurde ${sum.ai.detected} von ${sum.ai.votes} Mal erkannt</div>
        <div>${sum.ai.votes && sum.ai.detected / sum.ai.votes < 0.5 ? 'Die Maschine hat die meisten von euch ordentlich eing\'legt …' : 'Ihr seid der KI noch einen Schritt voraus!'}</div>
        ${sum.ai.funnyVotes ? `<div class="small" style="margin-top:6px">Und sie bekam ${sum.ai.funnyVotes} Lacher-Stimme${sum.ai.funnyVotes > 1 ? 'n' : ''} 😅</div>` : ''}
      </div>
      ${award('😂', 'Kellergassen-Kabarettist:in', sum.comedian, (n) => `– ${n} Lacher-Stimmen`)}
      ${award('🤖', 'Heimlicher Roboter aus dem Weinviertel', sum.robot, (n) => `– ${n}× für die KI gehalten`)}
      ${award('🕵️', 'KI-Gendarm des Abends', sum.detective, (n) => `– KI ${n}× entlarvt`)}
      <div class="card">
        <h2>Die Antworten der KI</h2>
        ${sum.ai.answers.map((a) => `<p><span class="muted small">${esc(a.question)}</span><br><b>„${esc(a.text)}“</b></p>`).join('')}
      </div>
      <div class="card">
        <h2>Wer würde eher …?</h2>
        ${sum.who.map((w) => `<p><span class="muted small">${esc(w.question)}</span><br>👑 <b>${w.winners.length ? w.winners.map(esc).join(', ') : '–'}</b></p>`).join('')}
      </div>
      ${s.isHost ? '<button id="restart" class="btn">🔁 Nochmal spielen</button>' : '<p class="center white">Danke fürs Mitspielen – no an schönen Abend im Pfarrhaus! 🍇</p>'}
      <p class="center"><button id="leave" class="linkbtn">Spiel verlassen</button></p>
      ${CREDIT}
    `;
  }

  // ---------- Event-Bindings ----------
  function bind(s) {
    $('#start')?.addEventListener('click', () => emit('start'));
    $('#restart')?.addEventListener('click', () => emit('restart'));
    $('#share')?.addEventListener('click', () => {
      navigator.share({ title: 'Mensch oder Maschine?', text: `Spiel mit bei der Familienrunde in Patzmannsdorf! Code: ${s.code}`, url: joinUrl(s.code) }).catch(() => {});
    });
    $('#leave')?.addEventListener('click', async () => {
      await emit('leave');
      store.set('code', null);
      renderHome();
    });

    app.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () => {
      buzz(15);
      emit('whoVote', { target: b.dataset.target });
    }));

    app.querySelectorAll('[data-vote]').forEach((b) => b.addEventListener('click', () => {
      buzz(15);
      emit('momVote', { kind: b.dataset.vote, entryId: b.dataset.id });
    }));

    const ta = $('#answer');
    if (ta) {
      ta.value = draft || (editing ? s.myAnswer || '' : '');
      const chars = $('#chars');
      const upd = () => { draft = ta.value; chars.textContent = `${ta.value.length}/${s.maxAnswerLength}`; };
      upd();
      ta.addEventListener('input', upd);
      const send = async () => {
        const text = ta.value.trim();
        if (!text) { toast('Schreib erst etwas 🙂'); return; }
        const res = await emit('answer', { text });
        if (res.ok) { editing = false; draft = ''; lastKey = null; if (state) render(state); }
      };
      $('#send').addEventListener('click', send);
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      if (!('ontouchstart' in window)) ta.focus();
    }
    $('#edit')?.addEventListener('click', () => {
      editing = true;
      draft = s.myAnswer || '';
      lastKey = null;
      render(state);
    });
  }

  $('#host-next').addEventListener('click', () => emit('next'));

  // ---------- Timer-Animation ----------
  setInterval(() => {
    if (!deadlineAt || !totalMs) return;
    const left = Math.max(0, deadlineAt - Date.now());
    $('#timer-fill').style.width = `${(left / totalMs) * 100}%`;
    $('#timer').classList.toggle('urgent', left < 5000);
  }, 250);

  // ---------- Verbindung ----------
  socket.on('state', render);

  socket.on('connect', async () => {
    const code = store.get('code');
    if (code && (!linkCode || linkCode === code)) {
      const res = await emit('resume', { code, playerId });
      if (res.ok) return;
      store.set('code', null);
    }
    if (!state && !onHome) renderHome();
  });

  socket.on('disconnect', () => {
    if (state) toast('Verbindung verloren – verbinde neu …', 4000);
  });

  // Erste Anzeige, bevor die Verbindung steht
  if (!store.get('code') || linkCode) renderHome();
  else app.innerHTML = '<p class="center white" style="margin-top:40vh">Verbinde …</p>';
})();
