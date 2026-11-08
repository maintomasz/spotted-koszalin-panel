// Kolejka: ocena AI w tle + publikowanie zatwierdzonych postów w odstępach czasu.
import { db, getSubmission, updateSubmission, parseRow, deleteSubmissionsWhere } from './db.js';
import { getSettings, fillPublishedTemplate } from './settings.js';
import { analyzeSubmission, classifyFollowup } from './ai.js';
import { fbEnabled, publishPost, getPermalink, getUserName } from './facebook.js';
import { sendAndLog, upsertThread, getThread, recentDecision, deleteMessagesWhere } from './threads.js';
import { createSubmission } from './inbox.js';

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
        // Kontekst: wcześniejsze zgłoszenia tej osoby z 24 h – żeby AI rozpoznało ciąg dalszy rozmowy.
        const history = sub.sender_id
          ? db.prepare(`SELECT * FROM submissions WHERE sender_id = ? AND id != ? AND created_at > ? ORDER BY created_at DESC LIMIT 5`)
            .all(sub.sender_id, sub.id, Date.now() - 24 * 3600 * 1000).map(parseRow).reverse()
          : [];
        const { result, cost } = await analyzeSubmission(sub, getSettings(), history);
        const fresh = getSubmission(id);
        // Jeśli w trakcie oceny doszła nowa wiadomość od tej osoby – oceniamy jeszcze raz.
        const changed = fresh.updated_at !== startedVersion;
        updateSubmission(id, {
          ai_status: changed ? 'pending' : 'done', ai_result: result, ai_error: null,
          ai_cost_usd: (fresh.ai_cost_usd || 0) + cost,
        });
        // Rozmowa z adminem, a nie post → przenosimy do „Rozmów” jako otwarty wątek.
        if (!changed && result.verdict === 'conversation' && fresh.sender_id) {
          updateSubmission(id, { status: 'conversation', decided_at: Date.now() });
          openThread(fresh.sender_id, { reason: 'conversation', summary: result.summary, submission_id: id, last_in_at: fresh.last_user_message_at, sender_name: fresh.sender_name });
        }
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
  if (Date.now() - sub.last_user_message_at > 24 * 3600 * 1000) return 'nie wysłano podziękowania – minęło 24 h';
  try {
    const link = fbEnabled() ? await getPermalink(postId) : `https://www.facebook.com/${postId}`;
    const st = await sendAndLog(sub.sender_id, fillPublishedTemplate(template, link), { kind: 'auto_published', submissionId: sub.id });
    return st === 'wysłano' ? 'wysłano podziękowanie' : 'DEMO – nie wysłano podziękowania';
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

// Otwiera (albo ponownie otwiera) wątek rozmowy z osobą.
function openThread(senderId, fields) {
  const cur = getThread(senderId);
  const name = fields.sender_name || cur?.sender_name
    || db.prepare('SELECT sender_name FROM submissions WHERE sender_id = ? AND sender_name IS NOT NULL ORDER BY id DESC LIMIT 1').get(senderId)?.sender_name;
  upsertThread(senderId, { ...fields, sender_name: name || null, state: 'open' });
  if (!name) getUserName(senderId).then((n) => n && upsertThread(senderId, { sender_name: n }));
}

// Wiadomości, które przyszły ≤24 h po decyzji: po minucie ciszy AI decyduje – dzięki / pytanie / nowe zgłoszenie.
let followupBusy = false;
async function runFollowups() {
  if (followupBusy) return;
  followupBusy = true;
  try {
    const senders = db.prepare(`SELECT sender_id, MAX(created_at) AS last FROM messages WHERE pending = 1 GROUP BY sender_id
      HAVING last < ?`).all(Date.now() - AI_DEBOUNCE_MS);
    for (const { sender_id: senderId } of senders) {
      const msgs = db.prepare('SELECT * FROM messages WHERE sender_id = ? AND pending = 1 ORDER BY created_at').all(senderId)
        .map((m) => ({ ...m, attachments: JSON.parse(m.attachments || '[]') }));
      if (!msgs.length) continue;
      const text = msgs.map((m) => m.text).filter(Boolean).join('\n\n');
      const atts = msgs.flatMap((m) => m.attachments).filter((a) => a.type !== 'sticker');
      const decision = recentDecision(senderId) || (getThread(senderId)?.submission_id ? getSubmission(getThread(senderId).submission_id) : null);
      let kind = 'question';
      let summary = '';
      try {
        const { result } = await classifyFollowup({ newText: text, hasImages: atts.some((a) => a.type === 'image'), decision });
        kind = result.kind;
        summary = result.summary;
      } catch (err) {
        console.error('[Po decyzji] klasyfikacja nie powiodła się – traktuję jako pytanie:', err.message);
        summary = 'AI nie oceniło – sprawdź wiadomość.';
      }
      const ids = msgs.map((m) => m.id);
      const mark = (submissionId) => db.prepare(`UPDATE messages SET pending = 0${submissionId ? ', submission_id = ?' : ''} WHERE id IN (${ids.map(() => '?').join(',')})`)
        .run(...(submissionId ? [submissionId] : []), ...ids);
      if (kind === 'thanks') {
        mark(null);
        console.log(`[Po decyzji] podziękowanie – pominięto (bez wpisu w panelu)`);
      } else if (kind === 'new_submission') {
        const last = msgs[msgs.length - 1];
        const id = createSubmission({ psid: senderId, text, attachments: atts, hasVideo: atts.some((a) => a.type === 'video'), ts: last.created_at });
        mark(id);
        console.log(`[Po decyzji] nowe zgłoszenie #${id}`);
      } else {
        mark(null);
        const reasonBy = { published: 'after_published', rejected: 'after_rejected', commercial: 'after_commercial', handled: 'after_handled', conversation: 'conversation' };
        openThread(senderId, {
          reason: reasonBy[decision?.status] || 'conversation', summary, submission_id: decision?.id ?? null,
          last_in_at: msgs[msgs.length - 1].created_at,
        });
        console.log(`[Po decyzji] pytanie – otwarto rozmowę`);
      }
    }
  } finally {
    followupBusy = false;
  }
}

// Retencja (RODO): zgłoszenia starsze niż RETENTION_DAYS są trwale usuwane razem ze zdjęciami.
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 180);
function runCleanup() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const n = deleteSubmissionsWhere("created_at < ? AND status NOT IN ('queued','publishing')", cutoff);
  deleteMessagesWhere('created_at < ? AND pending = 0', cutoff);
  db.prepare("DELETE FROM threads WHERE state = 'closed' AND updated_at < ?").run(cutoff);
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
  // Migracja: stare karty „rozmowa” (status new + ocena conversation) → wątki.
  for (const r of db.prepare("SELECT * FROM submissions WHERE status = 'new' AND json_extract(ai_result, '$.verdict') = 'conversation'").all().map(parseRow)) {
    if (!r.sender_id) continue;
    updateSubmission(r.id, { status: 'conversation', decided_at: Date.now() });
    openThread(r.sender_id, { reason: 'conversation', summary: r.ai_result?.summary, submission_id: r.id, last_in_at: r.last_user_message_at, sender_name: r.sender_name });
  }
  setInterval(() => runAi().catch((e) => console.error('[AI]', e)), 5000);
  setInterval(() => runFollowups().catch((e) => console.error('[Po decyzji]', e)), 5000);
  setInterval(() => runPublisher().catch((e) => console.error('[Publikacja]', e)), 15000);
}
