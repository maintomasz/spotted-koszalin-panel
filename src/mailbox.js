// „Skrzynka” – wszystkie osoby piszące do strony, przeszukiwanie po treści i nazwisku, pełna historia osoby.
import { db, parseRow } from './db.js';
import { fbEnabled, getConversationInfo, getUserName } from './facebook.js';

// Porównanie bez wielkości liter i polskich znaków, z zachowaniem pozycji znaków (do wycinków).
// Każdy znak zamieniamy na dokładnie jeden znak tej samej długości – pozycje w tekście się zgadzają.
const foldChar = (ch) => {
  if (ch.length !== 1) return ch; // emoji itp. bez zmian
  const c = ch.toLowerCase();
  if (c.length !== 1) return ch;
  if (c === 'ł') return 'l';
  return c.normalize('NFD')[0];
};
const fold = (s) => Array.from(String(s || ''), foldChar).join('');

function snippet(text, idx, len) {
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + len + 70);
  const pre = start > 0 ? '…' : '';
  return { text: pre + text.slice(start, end) + (end < text.length ? '…' : ''), matchAt: idx - start + pre.length, matchLen: len };
}

function namesMap() {
  const m = new Map();
  for (const r of db.prepare('SELECT sender_id, sender_name FROM submissions WHERE sender_id IS NOT NULL AND sender_name IS NOT NULL ORDER BY id').all()) m.set(r.sender_id, r.sender_name);
  for (const r of db.prepare('SELECT sender_id, sender_name FROM threads WHERE sender_name IS NOT NULL').all()) m.set(r.sender_id, r.sender_name);
  for (const r of db.prepare('SELECT sender_id, name FROM people WHERE name IS NOT NULL').all()) m.set(r.sender_id, r.name);
  return m;
}

export function searchMailbox(q = '', limit = 200) {
  const people = new Map();
  const touch = (psid, at, text, dir) => {
    let p = people.get(psid);
    if (!p) { p = { sender_id: psid, last_at: 0, last_text: '', last_dir: 'in', count: 0, matches: [] }; people.set(psid, p); }
    p.count++;
    if (at >= p.last_at) { p.last_at = at; p.last_text = text; p.last_dir = dir; }
  };
  const msgs = db.prepare('SELECT sender_id, submission_id, direction, text, created_at FROM messages ORDER BY created_at').all();
  const loggedSubs = new Set(msgs.map((m) => m.submission_id).filter(Boolean));
  for (const m of msgs) touch(m.sender_id, m.created_at, m.text || '(załącznik)', m.direction);
  // Starsze zgłoszenia sprzed historii wiadomości – też są w skrzynce.
  const subs = db.prepare("SELECT id, sender_id, original_text, final_text, created_at, status FROM submissions WHERE sender_id IS NOT NULL AND source = 'facebook'").all();
  for (const s of subs) if (!loggedSubs.has(s.id)) touch(s.sender_id, s.created_at, s.original_text || '(załącznik)', 'in');

  const names = namesMap();
  const pending = new Map(db.prepare("SELECT sender_id, COUNT(*) n FROM submissions WHERE status = 'new' AND sender_id IS NOT NULL GROUP BY sender_id").all().map((r) => [r.sender_id, r.n]));
  const openThreads = new Set(db.prepare("SELECT sender_id FROM threads WHERE state = 'open'").all().map((r) => r.sender_id));

  const needle = fold(q.trim());
  let list = [...people.values()].map((p) => ({ ...p, name: names.get(p.sender_id) || null, pending: pending.get(p.sender_id) || 0, open: openThreads.has(p.sender_id) }));

  if (needle) {
    const addMatch = (psid, text, at, where) => {
      const p = people.get(psid);
      if (!p || !text) return;
      const idx = fold(text).indexOf(needle);
      if (idx < 0) return;
      // Ta sama treść bywa i w historii, i w zgłoszeniu – pokazujemy ją raz.
      if (p.matches.length < 3 && !p.matches.some((m) => m.full === text)) p.matches.push({ ...snippet(text, idx, needle.length), at, where, full: text });
      p.hit = true;
    };
    for (const m of msgs) addMatch(m.sender_id, m.text, m.created_at, m.direction === 'out' ? 'out' : 'in');
    for (const s of subs) {
      // Treść zgłoszenia jest już w historii wiadomości – szukamy w niej tylko dla starszych zgłoszeń.
      if (!loggedSubs.has(s.id)) addMatch(s.sender_id, s.original_text, s.created_at, 'in');
      if (s.final_text && s.final_text !== s.original_text) addMatch(s.sender_id, s.final_text, s.created_at, 'post');
    }
    list = list.filter((p) => people.get(p.sender_id).hit || fold(p.name || '').includes(needle))
      .map((p) => ({ ...p, matches: people.get(p.sender_id).matches, nameHit: fold(p.name || '').includes(needle) }));
  }
  list.sort((a, b) => b.last_at - a.last_at);
  return { total: list.length, people: list.slice(0, limit) };
}

export function personDetail(psid) {
  const messages = db.prepare('SELECT id, submission_id, direction, kind, text, attachments, created_at FROM messages WHERE sender_id = ? ORDER BY created_at, id LIMIT 1000')
    .all(psid).map((m) => ({ ...m, attachments: JSON.parse(m.attachments || '[]') }));
  const submissions = db.prepare('SELECT * FROM submissions WHERE sender_id = ? ORDER BY created_at DESC LIMIT 200').all(psid).map(parseRow);
  // Zgłoszenia sprzed historii wiadomości dokładamy jako wiadomości przychodzące.
  const logged = new Set(messages.map((m) => m.submission_id).filter(Boolean));
  for (const s of submissions) {
    if (!logged.has(s.id)) messages.push({ id: `s${s.id}`, submission_id: s.id, direction: 'in', kind: 'user', text: s.original_text, attachments: s.attachments || [], created_at: s.created_at });
  }
  messages.sort((a, b) => a.created_at - b.created_at);
  const person = db.prepare('SELECT * FROM people WHERE sender_id = ?').get(psid) || null;
  const thread = db.prepare('SELECT * FROM threads WHERE sender_id = ?').get(psid) || null;
  return { sender_id: psid, name: person?.name || namesMap().get(psid) || null, fb_link: person?.fb_link || null, messages, submissions, thread };
}

// Pobiera z Facebooka link do rozmowy i imię (zapamiętuje na 7 dni).
export async function refreshPersonFromFacebook(psid, force = false) {
  const cur = db.prepare('SELECT * FROM people WHERE sender_id = ?').get(psid);
  if (!force && cur?.fb_link && cur.checked_at > Date.now() - 7 * 24 * 3600 * 1000) return cur;
  if (!fbEnabled()) return cur || { sender_id: psid, name: null, fb_link: null };
  let info = { link: null, name: null };
  try { info = await getConversationInfo(psid); } catch (err) { console.warn('[Skrzynka] rozmowa FB:', err.message); }
  const name = info.name || cur?.name || (await getUserName(psid)) || null;
  db.prepare(`INSERT INTO people (sender_id, name, fb_link, checked_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(sender_id) DO UPDATE SET name = COALESCE(excluded.name, people.name), fb_link = COALESCE(excluded.fb_link, people.fb_link), checked_at = excluded.checked_at`)
    .run(psid, name, info.link, Date.now());
  return db.prepare('SELECT * FROM people WHERE sender_id = ?').get(psid);
}
