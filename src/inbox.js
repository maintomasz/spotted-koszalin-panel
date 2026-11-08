// Odbiór wiadomości z Messengera i decyzja, dokąd trafiają:
//  1) ta sama osoba pisze dalej (≤10 min) do czekającego zgłoszenia → doklejamy do tej samej karty,
//  2) zgłoszenie czeka w kolejce, a autor coś dopisał → wstrzymujemy publikację, karta wraca do decyzji,
//  3) otwarta rozmowa → wiadomość dopisuje się do rozmowy,
//  4) ≤24 h po decyzji (opublikowane/odrzucone/…) → AI sprawdza: podziękowanie (cicho) / pytanie (rozmowa) / nowe zgłoszenie,
//  5) w pozostałych przypadkach → nowe zgłoszenie do decyzji.
import { db, insertSubmission, getSubmission, updateSubmission, markMidProcessed } from './db.js';
import { downloadImage, getUserName } from './facebook.js';
import { logMessage, getThread, upsertThread, recentDecision, sendAndLog, deleteEverythingAbout } from './threads.js';
import { reflowQueue } from './scheduler.js';
import { getSettings } from './settings.js';
import { refreshPersonFromFacebook } from './mailbox.js';

// Komenda RODO: „usuń moje dane” / „delete my data” – kasuje wszystkie dane nadawcy z panelu.
const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
  .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const DELETE_COMMANDS = ['usun moje dane', 'delete my data'];

async function handleDeleteRequest(psid) {
  const n = deleteEverythingAbout(psid);
  console.log(`[RODO] usunięto dane nadawcy (${n} zgłoszeń)`);
  await sendAndLog(psid, `Twoje dane zostały usunięte z naszego narzędzia do moderacji (usunięte zgłoszenia: ${n}). Jeśli chcesz też usunięcia konkretnego opublikowanego posta, napisz, o który chodzi. – Spotted Koszalin`, { kind: 'system' })
    .catch((e) => console.error('[RODO] nie wysłano potwierdzenia:', e.message));
  // Potwierdzenie też jest już historią tej osoby – usuwamy je, żeby nic po niej nie zostało.
  deleteEverythingAbout(psid);
}

const MERGE_WINDOW_MS = 10 * 60 * 1000;

export async function handleWebhook(body) {
  if (body.object !== 'page') return;
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      try {
        await handleMessagingEvent(ev);
      } catch (err) {
        console.error('[Webhook] błąd przetwarzania wiadomości:', err.message);
      }
    }
  }
}

async function handleMessagingEvent(ev) {
  const msg = ev.message;
  if (!msg || msg.is_echo) return; // echo = nasze własne odpowiedzi
  const psid = ev.sender?.id;
  if (!psid || !msg.mid || !markMidProcessed(msg.mid)) return;

  const text = (msg.text || '').trim();
  if (text && DELETE_COMMANDS.includes(normalize(text))) return handleDeleteRequest(psid);
  const attachments = [];
  let hasVideo = false;
  for (const a of msg.attachments || []) {
    const url = a.payload?.url;
    if (a.type === 'image' && a.payload?.sticker_id) {
      attachments.push({ type: 'sticker' }); // naklejka / „łapka w górę” – liczy się jak „dzięki”
      continue;
    }
    if (a.type === 'image' && url) {
      try {
        const saved = await downloadImage(url);
        attachments.push({ type: 'image', ...saved });
      } catch (err) {
        attachments.push({ type: 'image_error', url, error: err.message });
      }
    } else if (a.type === 'video') {
      hasVideo = true;
      attachments.push({ type: 'video', url });
    } else {
      attachments.push({ type: a.type || 'inny', url });
    }
  }
  if (!text && attachments.length === 0) return;
  routeIncoming({ psid, text, attachments, hasVideo, ts: ev.timestamp || Date.now() });
  // W tle: imię i link do rozmowy na Facebooku (do zakładki „Skrzynka”).
  refreshPersonFromFacebook(psid).catch(() => {});
}

export function routeIncoming({ psid, text, attachments, hasVideo, ts }) {
  const now = Date.now();
  const realAtts = attachments.filter((a) => a.type !== 'sticker');
  const onlySticker = !text && realAtts.length === 0;

  // 1) Dopisanie do czekającego zgłoszenia.
  const open = db.prepare(`SELECT id FROM submissions WHERE sender_id = ? AND status = 'new' AND updated_at > ?
    ORDER BY id DESC LIMIT 1`).get(psid, now - MERGE_WINDOW_MS);
  if (open && !onlySticker) {
    mergeInto(open.id, { text, attachments: realAtts, hasVideo, ts });
    logMessage({ senderId: psid, submissionId: open.id, direction: 'in', text, attachments, ts });
    return { route: 'merged', submissionId: open.id };
  }

  // 2) Autor dopisał coś, gdy post czeka w kolejce → wstrzymujemy publikację.
  const queued = db.prepare("SELECT id FROM submissions WHERE sender_id = ? AND status = 'queued' ORDER BY id DESC LIMIT 1").get(psid);
  if (queued && !onlySticker) {
    mergeInto(queued.id, { text, attachments: realAtts, hasVideo, ts });
    const s = getSubmission(queued.id);
    updateSubmission(queued.id, { status: 'new', scheduled_at: null, flags: addFlag(s.flags, 'author_edit') });
    reflowQueue();
    logMessage({ senderId: psid, submissionId: queued.id, direction: 'in', text, attachments, ts });
    return { route: 'held', submissionId: queued.id };
  }

  // Inteligentne rozmowy wyłączone → każda wiadomość od razu jako zgłoszenie do decyzji.
  if (getSettings().smart_routing !== '1') {
    if (onlySticker) return { route: 'ignored' };
    const id = createSubmission({ psid, text, attachments: realAtts, hasVideo, ts });
    logMessage({ senderId: psid, submissionId: id, direction: 'in', text, attachments, ts });
    return { route: 'new', submissionId: id };
  }

  // 3) Trwająca (otwarta) rozmowa.
  const thread = getThread(psid);
  if (thread?.state === 'open') {
    logMessage({ senderId: psid, submissionId: thread.submission_id, direction: 'in', text, attachments, ts });
    upsertThread(psid, { last_in_at: ts });
    return { route: 'thread' };
  }

  // 4) Odpowiedź w ciągu 24 h po decyzji (albo po zamkniętej rozmowie) → klasyfikacja AI po chwili ciszy.
  const decided = recentDecision(psid);
  const recentThread = thread && thread.updated_at > now - 24 * 3600 * 1000;
  if (decided || recentThread) {
    logMessage({ senderId: psid, submissionId: decided?.id ?? thread?.submission_id ?? null, direction: 'in', text, attachments, pending: 1, ts });
    return { route: 'followup' };
  }

  // 5) Nowe zgłoszenie.
  if (onlySticker) return { route: 'ignored' };
  const id = createSubmission({ psid, text, attachments: realAtts, hasVideo, ts });
  logMessage({ senderId: psid, submissionId: id, direction: 'in', text, attachments, ts });
  return { route: 'new', submissionId: id };
}

function addFlag(flags, f) {
  const set = new Set(String(flags || '').split(',').filter(Boolean));
  set.add(f);
  return [...set].join(',');
}

function mergeInto(id, { text, attachments, hasVideo, ts }) {
  const s = getSubmission(id);
  updateSubmission(id, {
    original_text: [s.original_text, text].filter(Boolean).join('\n\n'),
    attachments: [...(s.attachments || []), ...attachments],
    has_video: s.has_video || hasVideo,
    updated_at: Date.now(),
    last_user_message_at: ts,
    ai_status: 'pending',
  });
}

export function createSubmission({ psid, text, attachments, hasVideo, ts, source = 'facebook', senderName = null }) {
  const id = insertSubmission({
    source, sender_id: psid, sender_name: senderName, original_text: text, attachments, has_video: hasVideo, created_at: ts,
  });
  if (source === 'facebook' && psid && !senderName) {
    const known = db.prepare('SELECT sender_name FROM submissions WHERE sender_id = ? AND sender_name IS NOT NULL ORDER BY id DESC LIMIT 1').get(psid);
    if (known) updateSubmission(id, { sender_name: known.sender_name });
    else getUserName(psid).then((name) => name && updateSubmission(id, { sender_name: name }));
  }
  return id;
}

// Wiadomość testowa z panelu (bez nadawcy) – zawsze nowe zgłoszenie.
export function addToInbox({ psid, text, attachments, hasVideo, ts, source = 'facebook', senderName = null }) {
  if (psid) return routeIncoming({ psid, text, attachments, hasVideo, ts }).submissionId;
  return createSubmission({ psid, text, attachments, hasVideo, ts, source, senderName });
}
