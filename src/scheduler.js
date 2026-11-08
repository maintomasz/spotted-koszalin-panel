// Kolejka: ocena AI w tle + publikowanie zatwierdzonych postów w odstępach czasu.
import { db, getSubmission, updateSubmission, parseRow, deleteSubmissionsWhere } from './db.js';
import { getSettings, fillPublishedTemplate } from './settings.js';
import { analyzeSubmission } from './ai.js';
import { fbEnabled, publishPost, sendMessage, getPermalink } from './facebook.js';

const TZ = 'Europe/Warsaw';
const MIN = 60 * 1000;
// Ludzie często wysyłają tekst i zdjęcia w kilku osobnych wiadomościach – czekamy chwilę, aż skończą.
const AI_DEBOUNCE_MS = Number(process.env.AI_DEBOUNCE_SECONDS || 60) * 1000;

function warsawMinutes(ts) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ts));
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}
const toMin = (hhmm) => {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function isQuiet(ts, settings) {
  const from = toMin(settings.quiet_from);
  const to = toMin(settings.quiet_to);
  if (from === to) return false;
  const now = warsawMinutes(ts);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

function skipQuiet(ts, settings) {
  let t = ts;
  for (let i = 0; i < 24 * 12 && isQuiet(t, settings); i++) t += 5 * MIN;
  return t;
}

// Wyznacza godzinę publikacji dla nowo zatwierdzonego posta.
export function nextSlot(settings = getSettings()) {
  const interval = Math.max(1, Number(settings.interval_minutes) || 10) * MIN;
  const now = Date.now();
  const lastQueued = db.prepare("SELECT MAX(scheduled_at) AS t FROM submissions WHERE status IN ('queued','publishing')").get().t;
  const lastPublished = db.prepare("SELECT MAX(published_at) AS t FROM submissions WHERE status = 'published'").get().t;
  let slot = now + 30 * 1000;
  if (lastQueued) slot = Math.max(slot, lastQueued + interval);
  else if (lastPublished) slot = Math.max(slot, lastPublished + interval);
  return skipQuiet(slot, settings);
}

// Przelicza całą kolejkę od nowa (np. po wycofaniu posta lub zmianie odstępu).
export function reflowQueue() {
  const settings = getSettings();
  const interval = Math.max(1, Number(settings.interval_minutes) || 10) * MIN;
  const items = db.prepare("SELECT id FROM submissions WHERE status = 'queued' ORDER BY scheduled_at, id").all();
  const lastPublished = db.prepare("SELECT MAX(published_at) AS t FROM submissions WHERE status = 'published'").get().t;
  let slot = Math.max(Date.now() + 30 * 1000, lastPublished ? lastPublished + interval : 0);
  for (const { id } of items) {
    slot = skipQuiet(slot, settings);
    updateSubmission(id, { scheduled_at: slot });
    slot += interval;
  }
}

let aiBusy = 0;
const AI_CONCURRENCY = 2;

async function runAi() {
  const cutoff = Date.now() - AI_DEBOUNCE_MS;
  const rows = db.prepare(`SELECT id FROM submissions WHERE ai_status = 'pending' AND status = 'new'
    AND (updated_at < ? OR source != 'facebook') ORDER BY id LIMIT ?`).all(cutoff, AI_CONCURRENCY - aiBusy);
  for (const { id } of rows) {
    aiBusy++;
    updateSubmission(id, { ai_status: 'running' });
    (async () => {
      const sub = getSubmission(id);
      const startedVersion = sub.updated_at;
      try {
        const { result, cost } = await analyzeSubmission(sub, getSettings());
        const fresh = getSubmission(id);
        // Jeśli w trakcie oceny doszła nowa wiadomość od tej osoby – oceniamy jeszcze raz.
        const changed = fresh.updated_at !== startedVersion;
        updateSubmission(id, {
          ai_status: changed ? 'pending' : 'done', ai_result: result, ai_error: null,
          ai_cost_usd: (fresh.ai_cost_usd || 0) + cost,
        });
      } catch (err) {
        console.error(`[AI] zgłoszenie #${id}:`, err.message);
        updateSubmission(id, { ai_status: 'error', ai_error: String(err.message).slice(0, 500) });
      } finally {
        aiBusy--;
      }
    })();
  }
}

// Podziękowanie dla autora po publikacji (szablon „template_published”; pusty = nie wysyłamy).
async function notifyPublished(sub, postId) {
  const template = (getSettings().template_published || '').trim();
  if (!template) return null;
  if (sub.source !== 'facebook' || !sub.sender_id) return null;
  if (!fbEnabled()) return 'DEMO – nie wysłano podziękowania';
  if (Date.now() - sub.last_user_message_at > 24 * 3600 * 1000) return 'nie wysłano podziękowania – minęło 24 h';
  try {
    const link = await getPermalink(postId);
    await sendMessage(sub.sender_id, fillPublishedTemplate(template, link));
    return 'wysłano podziękowanie';
  } catch (err) {
    console.error(`[Publikacja] #${sub.id} podziękowanie nie wysłane:`, err.message);
    return 'błąd podziękowania: ' + String(err.message).slice(0, 200);
  }
}

let publishing = false;
async function runPublisher() {
  if (publishing) return;
  publishing = true;
  try {
    const row = db.prepare("SELECT * FROM submissions WHERE status = 'queued' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 1").get(Date.now());
    if (!row) return;
    const sub = parseRow(row);
    updateSubmission(sub.id, { status: 'publishing' });
    try {
      const images = (sub.attachments || []).filter((a) => a.type === 'image' && (sub.final_images || []).includes(a.file));
      let postId;
      if (fbEnabled()) postId = await publishPost({ text: sub.final_text || '', images });
      else postId = 'DEMO-' + sub.id;
      updateSubmission(sub.id, { status: 'published', published_at: Date.now(), fb_post_id: postId, publish_error: null });
      console.log(`[Publikacja] #${sub.id} opublikowano (${postId})`);
      updateSubmission(sub.id, { reply_sent: await notifyPublished(sub, postId) });
    } catch (err) {
      console.error(`[Publikacja] #${sub.id} błąd:`, err.message);
      updateSubmission(sub.id, { status: 'failed', publish_error: String(err.message).slice(0, 500) });
    }
  } finally {
    publishing = false;
  }
}

// Retencja (RODO): zgłoszenia starsze niż RETENTION_DAYS są trwale usuwane razem ze zdjęciami.
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 180);
function runCleanup() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const n = deleteSubmissionsWhere("created_at < ? AND status NOT IN ('queued','publishing')", cutoff);
  db.prepare('DELETE FROM processed_mids WHERE at < ?').run(Date.now() - 30 * 24 * 3600 * 1000);
  if (n) console.log(`[Retencja] usunięto ${n} zgłoszeń starszych niż ${RETENTION_DAYS} dni`);
}

export function startWorkers() {
  runCleanup();
  setInterval(runCleanup, 6 * 3600 * 1000);
  // Po restarcie serwera: dokończ przerwane oceny i publikacje.
  db.prepare("UPDATE submissions SET ai_status = 'pending' WHERE ai_status = 'running'").run();
  // Publikacja przerwana restartem: nie ponawiamy automatycznie (ryzyko podwójnego posta) – do sprawdzenia ręcznie.
  db.prepare("UPDATE submissions SET status = 'failed', publish_error = 'Publikacja przerwana restartem serwera – sprawdź na Facebooku, czy post się pojawił.' WHERE status = 'publishing'").run();
  setInterval(() => runAi().catch((e) => console.error('[AI]', e)), 5000);
  setInterval(() => runPublisher().catch((e) => console.error('[Publikacja]', e)), 15000);
}
