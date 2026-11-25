# 🧑 Mensch oder Maschine? 🤖

Ein Handy-Partyspiel für die **Familienrunde im Pfarrhaus Patzmannsdorf** (mit Patzenthal, Weinviertel) für 5–20 Personen (ca. 6–10 Minuten), bei dem eine echte KI (Claude) mitspielt.
Keine App und kein Login: Code eingeben oder QR-Code scannen, dann kann es losgehen.

## Ablauf

1. **Lobby**: Der Spielleiter erstellt ein Spiel und zeigt den QR-Code bzw. den 4-stelligen Code. Alle treten mit Namen und Tier bei.
2. **Teil 1: „Wer würde am ehesten …?“** (3 Fragen à 40 s): Jeder tippt auf eine Person aus der Runde. Wer für die Mehrheits-Person gestimmt hat, bekommt +50 (Gedankenleser).
3. **Teil 2: „Mensch oder Maschine“** (2 Runden):
   - Alle schreiben eine kurze, witzige Antwort (120 s). **Claude schreibt heimlich mit** und versucht, wie ein Mensch zu klingen.
   - Alle Antworten erscheinen anonym. Jeder wählt 🤖 „Das war die KI“ und 😂 „Am lustigsten“.
   - Auflösung: KI erkannt = +100, pro Lacher-Stimme +50, pro Person, die dich für die KI hielt, +50.
4. **Finale**: Podium, Kellergassen-Kabarettist:in, heimlicher Roboter aus dem Weinviertel, KI-Gendarm sowie alle Antworten der KI.

Die Timer laufen automatisch. Der Spielleiter (⭐) kann mit „Weiter“ früher umschalten. Haben alle abgestimmt, geht es sofort weiter.
Wer das Handy sperrt oder die Seite neu lädt, landet automatisch wieder im Spiel.

## Lokal starten

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # optional, ohne Key gibt es vorbereitete Ersatzantworten
npm start                             # http://localhost:3000
```

Handys im selben WLAN erreichen das Spiel über `http://<IP-des-Laptops>:3000`.

### Testen

```bash
npm test                              # Unit-Tests der Spiellogik
npm run bots -- 12                    # 12 Bots spielen eine komplette Partie
npm run bots -- 6 ABCD                # 6 Bots treten deinem Spiel ABCD bei (zum Ausprobieren allein)
URL=https://… npm run bots -- 6 ABCD  # dasselbe gegen die Online-Version
FAST_TIMERS=1 npm start               # Server mit sehr kurzen Timern (für Tests)
```

## Online stellen (Render.com, kostenlos)

1. Dieses Repo auf GitHub pushen.
2. Auf [render.com](https://render.com) einloggen, dann **New → Blueprint** wählen und das Repo auswählen. Render liest `render.yaml`.
3. Bei `ANTHROPIC_API_KEY` den API-Key eintragen (aus der [Claude Console](https://platform.claude.com/)).
4. Nach dem Deploy ist das Spiel unter `https://mensch-oder-maschine-xxxx.onrender.com` erreichbar.
5. `https://…/healthz` zeigt `"ai": true`, wenn der Key gesetzt ist.

> ⚠️ Im Free-Tier schläft der Dienst nach 15 Minuten ohne Besucher ein und braucht dann ~30–60 s zum Aufwachen.
> **Die Seite deshalb ein paar Minuten vor dem Spiel einmal öffnen.**

## Für den Abend: Spickzettel

- Vorher: Render-URL öffnen (aufwecken), optional mit `npm run bots` kurz testen.
- Du erstellst das Spiel. Die anderen scannen den QR-Code auf deinem Handy, oder du teilst den Link per WhatsApp („🔗 Link teilen“).
- Das Spiel lohnt sich ab 3 Spielern, ideal sind 6–15.
- Kosten der KI: pro Partie zwei kurze Anfragen an Claude, also wenige Cent.

## Technik

- Node.js, Express, Socket.IO (Echtzeit); Frontend in Vanilla HTML/CSS/JS ohne Build-Schritt
- `server/game.js`: Spiellogik als Zustandsautomat (getestet in `test/game.test.js`)
- `server/ai.js`: Claude-Anbindung (`claude-opus-5-5`, niedriger Aufwand, serverseitiger Fallback bei Ablehnung, Ersatzantwort bei Fehlern)
- `server/questions.js`: Fragenpools zum Anpassen. Die `*_LOCAL`-Listen enthalten die Weinviertel-, Patzmannsdorf- und Patzenthal-Fragen. Jede Partie bekommt garantiert 2 regionale „Wer würde eher?“-Fragen und 1 regionale KI-Frage.
- Spielstände liegen nur im Arbeitsspeicher, es gibt keine Datenbank.

## Bildnachweis

Hintergrundfotos von Wikimedia Commons (auch im Spiel auf der Startseite und im Finale genannt):

- Teil 1 & Lobby: [Patzmannsdorf – Kürbisfeld mit Pfarrkirche](https://commons.wikimedia.org/wiki/File:Patzmannsdorf_-_K%C3%BCrbisfeld_mit_Pfarrkirche_und_Raiffeisen-Silo_in_Stronsdorf.jpg), Foto: Haeferl, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- Teil 2 & Finale: [Kapelle Patzenthal umgeben von Naturdenkmälern](https://commons.wikimedia.org/wiki/File:Kapelle_Patzenthal_umgeben_von_Naturdenkm%C3%A4lern.JPG), Foto: Herbert Nowak, [CC BY-SA 3.0 AT](https://creativecommons.org/licenses/by-sa/3.0/at/)

Für die Web-Ansicht wurden die Bilder verkleinert (`public/img/`). Eigene Fotos können einfach unter denselben Dateinamen abgelegt werden.
