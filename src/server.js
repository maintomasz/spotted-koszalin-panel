// Spotted Koszalin – panel moderacji. Start: npm start
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, MEDIA_DIR, getSubmission, updateSubmission, parseRow } from './db.js';
import { getSettings, saveSettings } from './settings.js';
import { aiEnabled, AI_MODEL } from './ai.js';
import { fbEnabled, verifySignature, sendMessage, saveMedia, diagnose } from './facebook.js';
import { handleWebhook, addToInbox } from './inbox.js';
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

const IS_CONV = "json_extract(ai_result, '$.verdict') = 'conversation'";
const LISTS = {
  new: `status = 'new' AND NOT COALESCE(${IS_CONV}, 0) ORDER BY created_at ASC`,
  conversations: `status = 'new' AND ${IS_CONV} ORDER BY created_at ASC`,
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
    counts: Object.fromEntries(Object.keys(LISTS).map((k) => [k,
      db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE ${LISTS[k].split(' ORDER BY')[0]}`).get().n])),
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

async function reply(sub, text) {
  if (!text || !sub.sender_id || sub.source !== 'facebook') return 'pominięto (brak nadawcy z Facebooka)';
  if (!fbEnabled()) return 'DEMO – nie wysłano (Facebook niepodłączony)';
  await sendMessage(sub.sender_id, text);
  return 'wysłano';
}

app.post('/api/submissions/:id/approve', (req, res) => {
  const sub = load(req, res, ['new', 'failed']);
  if (!sub) return;
  const text = String(req.body.text ?? '').trim();
  const images = Array.isArray(req.body.images) ? req.body.images.map(String) : [];
  const valid = images.filter((f) => (sub.attachments || []).some((a) => a.file === f));
  if (!text && valid.length === 0) return res.status(400).json({ error: 'Post nie może być pusty.' });
  const when = req.body.now ? Date.now() : nextSlot();
  updateSubmission(sub.id, {
    status: 'queued', final_text: text, final_images: valid, scheduled_at: when, decided_at: Date.now(), publish_error: null,
  });
  res.json({ ok: true, scheduled_at: when });
});

app.post('/api/submissions/:id/reject', async (req, res) => {
  const sub = load(req, res, ['new', 'failed']);
  if (!sub) return;
  let replyStatus = null;
  try {
    if (req.body.message) replyStatus = await reply(sub, String(req.body.message));
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
    if (req.body.message) replyStatus = await reply(sub, String(req.body.message));
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

app.post('/api/submissions/:id/restore', (req, res) => {
  const sub = load(req, res, ['queued', 'rejected', 'handled', 'commercial', 'failed']);
  if (!sub) return;
  updateSubmission(sub.id, { status: 'new', scheduled_at: null });
  if (sub.status === 'queued') reflowQueue();
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

app.get('/api/settings', (_req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => {
  const s = saveSettings(req.body || {});
  reflowQueue();
  res.json(s);
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

app.get('/api/fb-check', async (_req, res) => {
  try { res.json(await diagnose()); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/demo-seed', (_req, res) => res.json({ ok: true, added: seedDemo() }));

app.listen(PORT, () => {
  console.log(`Panel Spotted Koszalin działa: http://localhost:${PORT}`);
  console.log(`Facebook: ${fbEnabled() ? 'podłączony' : 'NIE podłączony (tryb demo)'} | AI: ${aiEnabled() ? AI_MODEL : 'brak klucza (tryb demo)'}`);
  startWorkers();
});
