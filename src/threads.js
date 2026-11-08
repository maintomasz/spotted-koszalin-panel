// Wątki rozmów z autorami + pełna historia wiadomości (przychodzących i wysłanych).
import fs from 'node:fs';
import path from 'node:path';
import { db, MEDIA_DIR, getSubmission, parseRow, deleteSubmissionsWhere } from './db.js';
import { sendMessage, fbEnabled } from './facebook.js';

const DAY = 24 * 3600 * 1000;

export function logMessage({ senderId, submissionId = null, direction, kind = 'user', text = '', attachments = [], pending = 0, ts = Date.now() }) {
  const r = db.prepare(`INSERT INTO messages (sender_id, submission_id, direction, kind, text, attachments, pending, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(senderId, submissionId, direction, kind, text || '', JSON.stringify(attachments || []), pending ? 1 : 0, ts);
  return Number(r.lastInsertRowid);
}

export function getThread(senderId) {
  return db.prepare('SELECT * FROM threads WHERE sender_id = ?').get(senderId) || null;
}

export function upsertThread(senderId, fields) {
  const now = Date.now();
  const cur = getThread(senderId);
  const next = { sender_name: null, state: 'closed', reason: null, summary: null, submission_id: null, last_in_at: null, last_out_at: null, ...(cur || {}), ...fields, sender_id: senderId, updated_at: now };
  db.prepare(`INSERT INTO threads (sender_id, sender_name, state, reason, summary, submission_id, last_in_at, last_out_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sender_id) DO UPDATE SET sender_name = excluded.sender_name, state = excluded.state, reason = excluded.reason,
      summary = excluded.summary, submission_id = excluded.submission_id, last_in_at = excluded.last_in_at,
      last_out_at = excluded.last_out_at, updated_at = excluded.updated_at`)
    .run(next.sender_id, next.sender_name, next.state, next.reason, next.summary, next.submission_id, next.last_in_at, next.last_out_at, next.updated_at);
  return getThread(senderId);
}

// Najnowsza decyzja wobec tej osoby (opublikowane/odrzucone/komercyjne/obsłużone) z ostatnich 24 h.
export function recentDecision(senderId) {
  return parseRow(db.prepare(`SELECT * FROM submissions WHERE sender_id = ?
    AND status IN ('published','rejected','commercial','handled','conversation')
    AND COALESCE(published_at, decided_at, updated_at) > ? ORDER BY COALESCE(published_at, decided_at, updated_at) DESC LIMIT 1`)
    .get(senderId, Date.now() - DAY)) || null;
}

// Wysyła wiadomość na Messengerze i zapisuje ją w historii. Zwraca status tekstowy.
export async function sendAndLog(senderId, text, { kind = 'reply', submissionId = null } = {}) {
  if (!text || !senderId) return null;
  if (!fbEnabled()) {
    logMessage({ senderId, submissionId, direction: 'out', kind, text: `[DEMO – nie wysłano] ${text}` });
    return 'DEMO – nie wysłano';
  }
  await sendMessage(senderId, text);
  logMessage({ senderId, submissionId, direction: 'out', kind, text });
  const t = getThread(senderId);
  if (t) upsertThread(senderId, { last_out_at: Date.now() });
  return 'wysłano';
}

export function listOpenThreads() {
  const rows = db.prepare("SELECT * FROM threads WHERE state = 'open' ORDER BY last_in_at ASC").all();
  return rows.map((t) => ({
    ...t,
    submission: t.submission_id ? getSubmission(t.submission_id) : null,
    history: threadHistory(t.sender_id),
  }));
}

export function threadHistory(senderId, limit = 40) {
  return db.prepare(`SELECT id, submission_id, direction, kind, text, attachments, created_at FROM messages
    WHERE sender_id = ? AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(senderId, Date.now() - 30 * DAY, limit).reverse()
    .map((m) => ({ ...m, attachments: JSON.parse(m.attachments || '[]') }));
}

function removeFiles(rows) {
  for (const r of rows) {
    let atts = [];
    try { atts = JSON.parse(r.attachments || '[]'); } catch { /* ignore */ }
    for (const a of atts) if (a.file) fs.rmSync(path.join(MEDIA_DIR, path.basename(a.file)), { force: true });
  }
}

export function deleteMessagesWhere(whereSql, ...params) {
  const rows = db.prepare(`SELECT attachments FROM messages WHERE ${whereSql}`).all(...params);
  removeFiles(rows);
  return db.prepare(`DELETE FROM messages WHERE ${whereSql}`).run(...params).changes;
}

// RODO: wszystko o danej osobie – zgłoszenia, historia, wątek, zdjęcia.
export function deleteEverythingAbout(senderId) {
  const n = deleteSubmissionsWhere('sender_id = ?', senderId);
  deleteMessagesWhere('sender_id = ?', senderId);
  db.prepare('DELETE FROM threads WHERE sender_id = ?').run(senderId);
  return n;
}
