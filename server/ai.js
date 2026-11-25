import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const TIMEOUT_MS = 20000;

const FALLBACKS = [
  'jo eh, da hund wars 🐶',
  'hauptsach nachher gibts a achterl',
  'des frag ma am besten den herrn pfarrer',
  'kommt drauf an wie vü kaffee scho drin is ☕',
  'frag mi nach da weinlese nomoi',
  'irgendwas mit nudeln, wie immer',
  'in patzenthal wissens des sicher besser 😅',
];

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 1 });
  return client;
}

export function aiAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const SYSTEM = `Du spielst bei einem Partyspiel mit. Die Runde sind Eltern aus Patzmannsdorf und Patzenthal im Weinviertel (Niederösterreich), die im Pfarrhaus Patzmannsdorf zusammensitzen. Alle bekommen dieselbe Frage und tippen am Handy eine kurze, witzige Antwort. Danach versuchen alle zu erraten, welche Antwort von der KI stammt. Dein Ziel: Schreib eine Antwort, die nicht nach KI klingt und trotzdem lustig ist.

So tippen die Leute in dieser Runde:
- kurz: 3 bis 12 Wörter, maximal 80 Zeichen
- locker, österreichisches Umgangsdeutsch, gern mit einem einzelnen Weinviertler Mundartwort („jo eh“, „a bissl“, „heast“, „vü“), aber nicht in jedem Wort und ohne Mundart-Klischee-Feuerwerk
- gern komplett kleingeschrieben, Satzzeichen eher sparsam
- manchmal ein Emoji, aber nicht immer
- konkret und alltäglich statt clever und ausgefeilt; kein Wortspiel-Feuerwerk
- lokale Anspielungen (Heuriger, Kellergasse, Wind, Kirtag, Nachbarort) nur, wenn sie zur Frage passen; erfinde keine konkreten Fakten über die Orte oder Personen
- keine Anführungszeichen um die Antwort, keine Erklärung

Antworte nur mit der Antwort selbst, sonst nichts.`;

/**
 * Erzeugt eine menschlich klingende Antwort. Löst nie mit Fehler auf.
 * @param {string} question
 * @param {string[]} examples bisherige Antworten echter Spieler (für den Stil)
 * @returns {Promise<{text:string, source:'claude'|'fallback'}>}
 */
export async function generateAnswer(question, examples = []) {
  const c = getClient();
  if (!c) return fallback();

  let user = `Frage: ${question}`;
  if (examples.length) {
    user += `\n\nSo haben andere Spieler in früheren Runden geschrieben (nur als Stil-Beispiel, nicht kopieren):\n${examples
      .slice(-6)
      .map((e) => `- ${e}`)
      .join('\n')}`;
  }

  try {
    const response = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 1000,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
    });
    if (response.stop_reason === 'refusal') {
      console.warn('[ai] Refusal, nutze Fallback');
      return fallback();
    }
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
      .replace(/^["„“”']+|["„“”']+$/g, '')
      .split('\n')[0]
      .slice(0, 80);
    if (!text) return fallback();
    return { text, source: 'claude' };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('[ai] Ungültiger API-Key');
    } else if (err instanceof Anthropic.RateLimitError) {
      console.error('[ai] Rate limit');
    } else if (err instanceof Anthropic.APIError) {
      console.error('[ai] API-Fehler', err.status, err.message);
    } else {
      console.error('[ai] Fehler', err?.message || err);
    }
    return fallback();
  }
}

function fallback() {
  return { text: FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)], source: 'fallback' };
}
