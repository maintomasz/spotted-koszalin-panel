// Zamienia wiadomości z Messengera na „zgłoszenia” do moderacji.
import { db, insertSubmission, getSubmission, updateSubmission, markMidProcessed, deleteSubmissionsWhere } from './db.js';
import { downloadImage, getUserName, sendMessage, fbEnabled } from './facebook.js';

// Komenda RODO: „usuń moje dane” / „delete my data” – kasuje wszystkie dane nadawcy z panelu.
const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
  .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const DELETE_COMMANDS = ['usun moje dane', 'delete my data'];

async function handleDeleteRequest(psid) {
  const n = deleteSubmissionsWhere('sender_id = ?', psid);
  console.log(`[RODO] usunięto dane nadawcy (${n} zgłoszeń)`);
  if (fbEnabled()) {
    await sendMessage(psid, `Twoje dane zostały usunięte z naszego narzędzia do moderacji (usunięte zgłoszenia: ${n}). Jeśli chcesz też usunięcia konkretnego opublikowanego posta, napisz, o który chodzi. – Spotted Koszalin`)
      .catch((e) => console.error('[RODO] nie wysłano potwierdzenia:', e.message));
  }
}

// Kolejne wiadomości od tej samej osoby w tym oknie czasu doklejamy do jednego zgłoszenia.
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
    if (a.type === 'image' && a.payload?.sticker_id) continue; // naklejki / „łapki w górę”
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

  const ts = ev.timestamp || Date.now();
  addToInbox({ psid, text, attachments, hasVideo, ts });
}

export function addToInbox({ psid, text, attachments, hasVideo, ts, source = 'facebook', senderName = null }) {
  const now = Date.now();
  const open = psid ? db.prepare(`SELECT id FROM submissions WHERE sender_id = ? AND status = 'new' AND updated_at > ?
    ORDER BY id DESC LIMIT 1`).get(psid, now - MERGE_WINDOW_MS) : null;

  if (open) {
    const s = getSubmission(open.id);
    updateSubmission(s.id, {
      original_text: [s.original_text, text].filter(Boolean).join('\n\n'),
      attachments: [...(s.attachments || []), ...attachments],
      has_video: s.has_video || hasVideo,
      updated_at: now,
      last_user_message_at: ts,
      ai_status: 'pending',
    });
    return s.id;
  }
  const id = insertSubmission({
    source, sender_id: psid, sender_name: senderName, original_text: text, attachments, has_video: hasVideo, created_at: ts,
  });
  if (source === 'facebook' && psid && !senderName) {
    getUserName(psid).then((name) => name && updateSubmission(id, { sender_name: name }));
  }
  return id;
}
