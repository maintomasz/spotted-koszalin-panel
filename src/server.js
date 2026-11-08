// Spotted Koszalin – panel moderacji. Start: npm start
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, MEDIA_DIR, getSubmission, updateSubmission, parseRow, deleteSubmissionsWhere } from './db.js';
import { getSettings, saveSettings, getPresets } from './settings.js';
import { aiEnabled, AI_MODEL, suggestRedactions } from './ai.js';
import { fbEnabled, verifySignature, saveMedia, diagnose, editPost } from './facebook.js';
import { listOpenThreads, getThread, upsertThread, sendAndLog, logMessage, deleteMessagesWhere } from './threads.js';
import { handleWebhook, addToInbox, createSubmission } from './inbox.js';
import { nextSlot, reflowQueue, startWorkers } from './scheduler.js';
import { seedDemo } from './demo-seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

// ---------- Hasło i sesja ----------
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  if (IS_PROD) {
    console.error('BŁĄD: ustaw zmienną ADMIN_PASSWORD (hasło do panelu).');
    process.exit(1);
  }
  ADMIN_PASSWORD = 'spotted';
  console.warn('UWAGA: brak ADMIN_PASSWORD – lokalnie używam hasła „spotted”.');
}
const secretFile = path.join(DATA_DIR, '.session-secret');
const SESSION_SECRET = process.env.SESSION_SECRET || (fs.existsSync(secretFile)
  ? fs.readFileSync(secretFile, 'utf8')
  : (() => { const s = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(secretFile, s); return s; })());

const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
function makeToken() {
  const exp = String(Date.now() + 30 * 24 * 3600 * 1000);
  return `${exp}.${sign(exp)}`;
}
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || sig.length !== 64) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(exp)))) return false;
  return Number(exp) > Date.now();
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
const requireAuth = (req, res, next) => {
  if (validToken(getCookie(req, 'sk_session'))) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) return res.status(401).json({ error: 'Zaloguj się' });
  return res.redirect('/login');
};

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ---------- Webhook Facebooka (publiczny) ----------
app.get('/webhook', (req, res) => {
  const ok = req.query['hub.mode'] === 'subscribe' && process.env.FB_VERIFY_TOKEN
    && req.query['hub.verify_token'] === process.env.FB_VERIFY_TOKEN;
  if (ok) return res.status(200).send(req.query['hub.challenge']);
  return res.sendStatus(403);
});
app.post('/webhook', express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
  if (!verifySignature(req.body, req.get('x-hub-signature-256'))) {
    console.warn('[Webhook] odrzucono – zły podpis');
    return res.sendStatus(403);
  }
  res.sendStatus(200); // Facebook wymaga szybkiej odpowiedzi, przetwarzamy po fakcie
  let body;
  try { body = JSON.parse(req.body.toString('utf8')); } catch { return; }
  handleWebhook(body).catch((e) => console.error('[Webhook]', e));
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Publiczne strony (wymagane przez Meta) ----------
const PAGES_DIR = path.join(here, '..', 'public-pages');
const publicPage = (file) => (_req, res) => res.sendFile(path.join(PAGES_DIR, file));
app.get(['/polityka-prywatnosci', '/privacy'], publicPage('polityka-prywatnosci.html'));
app.get(['/usuwanie-danych', '/data-deletion'], publicPage('usuwanie-danych.html'));
app.get('/strony.css', publicPage('strony.css'));
app.get('/logo.jpg', publicPage('logo.jpg'));
app.get('/logo-white.svg', publicPage('logo-white.svg'));
app.get('/favicon.png', publicPage('favicon.png'));
app.get(['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'], publicPage('apple-touch-icon.png'));

// ---------- Logowanie ----------
app.get('/login', (_req, res) => res.sendFile(path.join(here, '..', 'public', 'login.html')));
app.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  const given = Buffer.from(String(req.body.password || ''));
  const real = Buffer.from(ADMIN_PASSWORD);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 1000));
    return res.redirect('/login?error=1');
  }
  res.setHeader('Set-Cookie', `sk_session=${makeToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 24 * 3600}${IS_PROD ? '; Secure' : ''}`);
  res.redirect('/');
});
app.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'sk_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.redirect('/login');
});

// ---------- Wszystko poniżej wymaga zalogowania ----------
app.use(requireAuth);
app.use(express.json({ limit: '40mb' }));
app.use('/media', express.static(MEDIA_DIR, { maxAge: '7d' }));
app.use(express.static(path.join(here, '..', 'public')));

const LISTS = {
  new: "status = 'new' ORDER BY created_at ASC",
  queued: "status IN ('queued','publishing') ORDER BY scheduled_at ASC",
  published: "status = 'published' ORDER BY published_at DESC LIMIT 100",
  failed: "status = 'failed' ORDER BY id DESC",
  rejected: "status IN ('rejected','handled') ORDER BY decided_at DESC LIMIT 100",
  commercial: "status = 'commercial' ORDER BY decided_at DESC LIMIT 200",
};

app.get('/api/status', (_req, res) => {
  const since = Date.now() - 30 * 24 * 3600 * 1000;
  const cost = db.prepare('SELECT COALESCE(SUM(ai_cost_usd),0) AS c, COUNT(*) AS n FROM submissions WHERE created_at > ?').get(since);
  res.json({
    fb: fbEnabled(), ai: aiEnabled(), model: AI_MODEL, pageId: process.env.FB_PAGE_ID || null,
    cost30d: cost.c, count30d: cost.n,
    counts: {
      ...Object.fromEntries(Object.keys(LISTS).map((k) => [k,
        db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE ${LISTS[k].split(' ORDER BY')[0]}`).get().n])),
      conversations: db.prepare("SELECT COUNT(*) AS n FROM threads WHERE state = 'open'").get().n,
    },
  });
});

app.get('/api/submissions', (req, res) => {
  const where = LISTS[req.query.status] || LISTS.new;
  res.json(db.prepare(`SELECT * FROM submissions WHERE ${where}`).all().map(parseRow));
});

function load(req, res, allowed) {
  const sub = getSubmission(Number(req.params.id));
  if (!sub) { res.status(404).json({ error: 'Nie ma takiego zgłoszenia' }); return null; }
  if (allowed && !allowed.includes(sub.status)) {
    res.status(409).json({ error: `Zgłoszenie ma już status „${sub.status}” – odśwież panel.` });
    return null;
  }
  return sub;
}

async function reply(sub, text, kind = 'reply') {
  if (!text || !sub.sender_id || sub.source !== 'facebook') return 'pominięto (brak nadawcy z Facebooka)';
  const st = await sendAndLog(sub.sender_id, text, { kind, submissionId: sub.id });
  return st === 'wysłano' ? 'wysłano' : 'DEMO – nie wysłano (Facebook niepodłączony)';
}

app.post('/api/submissions/:id/approve', (req, res) => {
  const sub = load(req, res, ['new', 'failed']);
  if (!sub) return;
  const text = String(req.body.text ?? '').trim();
  const images = Array.isArray(req.body.images) ? req.body.images.map(String) : [];
  // Zawsze bierzemy AKTUALNY plik (np. zakrytą wersję), nawet jeśli przeglądarka podała nazwę oryginału.
  const valid = [...new Set(images.map((f) => findAttachment(sub, f)?.att.file).filter(Boolean))];
  if (images.length && valid.length < images.length) {
    return res.status(409).json({ error: 'Nie znaleziono zaznaczonego zdjęcia – odśwież panel i zatwierdź jeszcze raz. Nic nie zostało opublikowane.' });
  }
  if (!text && valid.length === 0) return res.status(400).json({ error: 'Post nie może być pusty.' });
  const when = req.body.now ? Date.now() : nextSlot();
  updateSubmission(sub.id, {
    status: 'queued', final_text: text, final_images: valid, scheduled_at: when, decided_at: Date.now(), publish_error: null,
    flags: String(sub.flags || '').split(',').filter((f) => f && f !== 'author_edit').join(','),
  });
  res.json({ ok: true, scheduled_at: when });
});

app.post('/api/submissions/:id/reject', async (req, res) => {
  const sub = load(req, res, ['new', 'failed']);
  if (!sub) return;
  let replyStatus = null;
  try {
    if (req.body.message) replyStatus = await reply(sub, String(req.body.message), 'auto_reject');
  } catch (err) {
    replyStatus = 'błąd: ' + err.message;
  }
  updateSubmission(sub.id, { status: 'rejected', decided_at: Date.now(), reply_sent: replyStatus });
  res.json({ ok: true, reply: replyStatus });
});

app.post('/api/submissions/:id/commercial', async (req, res) => {
  const sub = load(req, res, ['new']);
  if (!sub) return;
  let replyStatus = null;
  try {
    if (req.body.message) replyStatus = await reply(sub, String(req.body.message), 'auto_commercial');
  } catch (err) {
    return res.status(502).json({ error: 'Nie udało się wysłać wiadomości: ' + err.message });
  }
  updateSubmission(sub.id, { status: 'commercial', decided_at: Date.now(), reply_sent: replyStatus });
  res.json({ ok: true, reply: replyStatus });
});

app.post('/api/submissions/:id/handled', (req, res) => {
  const sub = load(req, res, ['new', 'failed']);
  if (!sub) return;
  updateSubmission(sub.id, { status: 'handled', decided_at: Date.now() });
  res.json({ ok: true });
});

// „Rozmowa” – to nie post, tylko pytanie do admina → przenosimy do zakładki Rozmowy.
app.post('/api/submissions/:id/to-thread', (req, res) => {
  const sub = load(req, res, ['new', 'failed']);
  if (!sub) return;
  if (!sub.sender_id) return res.status(400).json({ error: 'To nie jest wiadomość z Facebooka – nie ma z kim rozmawiać.' });
  moveToThread(sub);
  res.json({ ok: true });
});

function moveToThread(sub, preset = null) {
  updateSubmission(sub.id, { status: 'conversation', decided_at: Date.now() });
  const cur = getThread(sub.sender_id);
  upsertThread(sub.sender_id, {
    state: 'open', reason: 'conversation', submission_id: sub.id, sender_name: sub.sender_name || cur?.sender_name || null,
    summary: sub.ai_result?.summary || null, last_in_at: sub.last_user_message_at,
    preset: preset || sub.ai_result?.suggested_preset || null,
  });
}

// Szybka odpowiedź: wysyła szablon (po ewentualnej edycji) i wykonuje jego akcję.
app.post('/api/submissions/:id/preset', async (req, res) => {
  const sub = load(req, res, ['new', 'failed']);
  if (!sub) return;
  const preset = getPresets().find((p) => p.id === String(req.body.presetId || ''));
  if (!preset) return res.status(404).json({ error: 'Nie ma takiego szablonu – odśwież panel.' });
  const text = String(req.body.text ?? preset.text).trim();
  const send = req.body.send !== false;
  let replyStatus = null;
  if (send && text) {
    if (sub.source === 'facebook' && sub.sender_id && Date.now() - sub.last_user_message_at > 24 * 3600 * 1000) {
      return res.status(409).json({ error: 'Minęło 24 h od wiadomości – Facebook nie pozwala już odpisać. Odznacz wysyłanie albo odpowiedz ze skrzynki.' });
    }
    try {
      replyStatus = await reply(sub, text, `preset_${preset.id}`);
    } catch (err) {
      return res.status(502).json({ error: 'Nie udało się wysłać: ' + err.message });
    }
  }
  if (preset.action === 'conversation') {
    if (!sub.sender_id) return res.status(400).json({ error: 'To nie jest wiadomość z Facebooka – nie ma z kim rozmawiać.' });
    moveToThread(sub, preset.id);
    updateSubmission(sub.id, { reply_sent: replyStatus });
  } else {
    updateSubmission(sub.id, { status: preset.action === 'commercial' ? 'commercial' : 'rejected', decided_at: Date.now(), reply_sent: replyStatus });
  }
  res.json({ ok: true, reply: replyStatus, action: preset.action });
});

app.post('/api/submissions/:id/restore', (req, res) => {
  const sub = load(req, res, ['queued', 'rejected', 'handled', 'commercial', 'failed', 'conversation']);
  if (!sub) return;
  updateSubmission(sub.id, { status: 'new', scheduled_at: null });
  if (sub.status === 'queued') reflowQueue();
  if (sub.status === 'conversation' && sub.sender_id) upsertThread(sub.sender_id, { state: 'closed' });
  res.json({ ok: true });
});

app.post('/api/submissions/:id/publish-now', (req, res) => {
  const sub = load(req, res, ['queued']);
  if (!sub) return;
  updateSubmission(sub.id, { scheduled_at: Date.now() });
  res.json({ ok: true });
});

app.post('/api/submissions/:id/reanalyze', (req, res) => {
  const sub = load(req, res, ['new']);
  if (!sub) return;
  updateSubmission(sub.id, { ai_status: 'pending', ai_error: null });
  res.json({ ok: true });
});

app.post('/api/queue/reflow', (_req, res) => { reflowQueue(); res.json({ ok: true }); });

// Trwałe wyczyszczenie listy „Odrzucone” (odrzucone + obsłużone ręcznie): zgłoszenia, zdjęcia i powiązana historia.
app.post('/api/submissions/clear-rejected', (_req, res) => {
  const ids = db.prepare("SELECT id FROM submissions WHERE status IN ('rejected','handled')").all().map((r) => r.id);
  if (!ids.length) return res.json({ ok: true, deleted: 0 });
  const ph = ids.map(() => '?').join(',');
  deleteMessagesWhere(`submission_id IN (${ph})`, ...ids);
  const n = deleteSubmissionsWhere(`id IN (${ph})`, ...ids);
  db.prepare(`UPDATE threads SET submission_id = NULL WHERE submission_id IN (${ph})`).run(...ids);
  console.log(`[Czyszczenie] usunięto ${n} odrzuconych zgłoszeń`);
  res.json({ ok: true, deleted: n });
});

const settingsForClient = () => { const s = getSettings(); return { ...s, presets_list: getPresets(s) }; };
app.get('/api/settings', (_req, res) => res.json(settingsForClient()));
app.put('/api/settings', (req, res) => {
  try {
    saveSettings(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'Nie zapisano: ' + err.message });
  }
  reflowQueue();
  res.json(settingsForClient());
});

// Testowa wiadomość z panelu (zanim podłączymy Facebooka).
app.post('/api/test-message', (req, res) => {
  const text = String(req.body.text || '').trim();
  const attachments = [];
  for (const img of (req.body.images || []).slice(0, 10)) {
    const mime = String(img.mime || '');
    if (!/^image\/(jpeg|png|gif|webp)$/.test(mime)) continue;
    attachments.push({ type: 'image', ...saveMedia(Buffer.from(String(img.data || ''), 'base64'), mime) });
  }
  if (!text && !attachments.length) return res.status(400).json({ error: 'Wpisz tekst lub dodaj zdjęcie.' });
  const id = addToInbox({ psid: null, text, attachments, hasVideo: false, ts: Date.now(), source: 'test', senderName: 'Test z panelu' });
  res.json({ ok: true, id });
});

// ---------- Rozmowy (wątki) ----------
app.get('/api/threads', (_req, res) => res.json(listOpenThreads()));

function loadThread(req, res) {
  const t = getThread(String(req.params.psid));
  if (!t) { res.status(404).json({ error: 'Nie ma takiej rozmowy' }); return null; }
  return t;
}

app.post('/api/threads/:psid/reply', async (req, res) => {
  const t = loadThread(req, res);
  if (!t) return;
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Wpisz treść odpowiedzi.' });
  if (!t.last_in_at || Date.now() - t.last_in_at > 24 * 3600 * 1000) {
    return res.status(409).json({ error: 'Minęło 24 h od ostatniej wiadomości tej osoby – Facebook nie pozwala już odpisać z panelu. Odpowiedz ze skrzynki strony.' });
  }
  try {
    const st = await sendAndLog(t.sender_id, text, { kind: 'reply', submissionId: t.submission_id });
    upsertThread(t.sender_id, { last_out_at: Date.now() });
    res.json({ ok: true, status: st });
  } catch (err) {
    res.status(502).json({ error: 'Nie udało się wysłać: ' + err.message });
  }
});

app.post('/api/threads/:psid/close', (req, res) => {
  const t = loadThread(req, res);
  if (!t) return;
  upsertThread(t.sender_id, { state: 'closed' });
  res.json({ ok: true });
});

app.post('/api/threads/:psid/reopen', (req, res) => {
  const t = loadThread(req, res);
  if (!t) return;
  upsertThread(t.sender_id, { state: 'open' });
  res.json({ ok: true });
});

// „To jednak post” – zamienia rozmowę w zgłoszenie do decyzji.
app.post('/api/threads/:psid/to-post', (req, res) => {
  const t = loadThread(req, res);
  if (!t) return;
  const linked = t.submission_id ? getSubmission(t.submission_id) : null;
  let id;
  if (linked && linked.status === 'conversation') {
    id = linked.id;
    const ai = { ...(linked.ai_result || {}), verdict: 'manual_check' };
    updateSubmission(id, { status: 'new', ai_result: ai, decided_at: null });
  } else {
    const since = linked ? Math.max(linked.decided_at || 0, linked.published_at || 0) : 0;
    const msgs = db.prepare("SELECT * FROM messages WHERE sender_id = ? AND direction = 'in' AND created_at > ? ORDER BY created_at")
      .all(t.sender_id, since).map((m) => ({ ...m, attachments: JSON.parse(m.attachments || '[]') }));
    if (!msgs.length) return res.status(400).json({ error: 'Brak nowych wiadomości od tej osoby.' });
    const atts = msgs.flatMap((m) => m.attachments).filter((a) => a.type !== 'sticker');
    id = createSubmission({
      psid: t.sender_id, text: msgs.map((m) => m.text).filter(Boolean).join('\n\n'), attachments: atts,
      hasVideo: atts.some((a) => a.type === 'video'), ts: msgs[msgs.length - 1].created_at, senderName: t.sender_name,
    });
  }
  upsertThread(t.sender_id, { state: 'closed', submission_id: id });
  res.json({ ok: true, id });
});

// ---------- Zakrywanie danych na zdjęciach ----------
// Zdjęcie szukamy po aktualnym pliku ALBO po oryginale (po zakryciu nazwa pliku się zmienia).
function findAttachment(sub, file) {
  const atts = sub.attachments || [];
  const i = atts.findIndex((a) => a.type === 'image' && (a.file === file || a.orig === file));
  return i < 0 ? null : { atts, i, att: atts[i] };
}

// AI proponuje prostokąty do zakrycia (zawsze liczone na ORYGINALE zdjęcia).
app.post('/api/submissions/:id/redact-suggest', async (req, res) => {
  const sub = load(req, res, ['new', 'failed']);
  if (!sub) return;
  const f = findAttachment(sub, String(req.body.file || ''));
  if (!f) return res.status(404).json({ error: 'Nie ma takiego zdjęcia.' });
  const scenario = String(req.body.scenario || 'auto');
  try {
    const { result, cost } = await suggestRedactions({
      file: f.att.orig || f.att.file, mime: f.att.origMime || f.att.mime, scenario, context: sub.original_text,
    });
    // AI odpowiada kilkanaście sekund – w tym czasie zdjęcie mogło zostać zakryte i zapisane.
    // Dlatego czytamy ŚWIEŻY stan i dopisujemy tylko podpowiedź, nie ruszając pliku.
    const fresh = getSubmission(sub.id);
    const g = fresh && findAttachment(fresh, f.att.orig || f.att.file);
    if (g) {
      g.atts[g.i] = { ...g.att, suggest: { scenario, ...result } };
      updateSubmission(fresh.id, { attachments: g.atts, ai_cost_usd: (fresh.ai_cost_usd || 0) + cost });
    }
    res.json(result);
  } catch (err) {
    console.error('[Zakrywanie] AI:', err.message);
    res.status(502).json({ error: 'AI nie dało rady: ' + err.message });
  }
});

// Zapis zakrytej wersji (obraz wyrenderowany w przeglądarce). Oryginał zostaje do cofnięcia.
app.post('/api/submissions/:id/redact', (req, res) => {
  const sub = load(req, res, ['new', 'failed']);
  if (!sub) return;
  const f = findAttachment(sub, String(req.body.file || ''));
  if (!f) return res.status(404).json({ error: 'Nie ma takiego zdjęcia.' });
  const buf = Buffer.from(String(req.body.data || ''), 'base64');
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: 'Nieprawidłowy obraz.' });
  const saved = saveMedia(buf, 'image/jpeg');
  const orig = f.att.orig || f.att.file;
  const origMime = f.att.origMime || f.att.mime;
  // Poprzednia zakryta wersja (nie oryginał) nie jest już potrzebna.
  if (f.att.orig && f.att.file !== f.att.orig) fs.rmSync(path.join(MEDIA_DIR, path.basename(f.att.file)), { force: true });
  f.atts[f.i] = { ...f.att, file: saved.file, mime: 'image/jpeg', orig, origMime, redacted: true, boxes: req.body.boxes || [] };
  updateSubmission(sub.id, { attachments: f.atts });
  res.json({ ok: true, file: saved.file });
});

app.post('/api/submissions/:id/redact-revert', (req, res) => {
  const sub = load(req, res, ['new', 'failed']);
  if (!sub) return;
  const f = findAttachment(sub, String(req.body.file || ''));
  if (!f || !f.att.orig) return res.status(404).json({ error: 'To zdjęcie nie było zakrywane.' });
  fs.rmSync(path.join(MEDIA_DIR, path.basename(f.att.file)), { force: true });
  const { orig, origMime, redacted, boxes, ...rest } = f.att;
  f.atts[f.i] = { ...rest, file: orig, mime: origMime || 'image/jpeg' };
  updateSubmission(sub.id, { attachments: f.atts });
  res.json({ ok: true, file: orig });
});

// Poprawa treści już opublikowanego posta.
app.post('/api/submissions/:id/edit-published', async (req, res) => {
  const sub = load(req, res, ['published']);
  if (!sub) return;
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Treść nie może być pusta.' });
  try {
    if (fbEnabled() && !String(sub.fb_post_id).startsWith('DEMO')) await editPost(sub.fb_post_id, text);
    updateSubmission(sub.id, { final_text: text });
    if (sub.sender_id) logMessage({ senderId: sub.sender_id, submissionId: sub.id, direction: 'out', kind: 'system', text: `✏️ Poprawiono opublikowany post:\n${text}` });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'Facebook nie przyjął poprawki: ' + err.message });
  }
});

app.get('/api/fb-check', async (_req, res) => {
  try { res.json(await diagnose()); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/demo-seed', (_req, res) => res.json({ ok: true, added: seedDemo() }));

app.listen(PORT, () => {
  console.log(`Panel Spotted Koszalin działa: http://localhost:${PORT}`);
  console.log(`Facebook: ${fbEnabled() ? 'podłączony' : 'NIE podłączony (tryb demo)'} | AI: ${aiEnabled() ? AI_MODEL : 'brak klucza (tryb demo)'}`);
  startWorkers();
});
