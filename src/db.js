// Baza danych (SQLite wbudowany w Node.js) – jeden plik w katalogu data/.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'spotted.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'facebook',      -- facebook | test | demo
    sender_id TEXT,
    sender_name TEXT,
    status TEXT NOT NULL DEFAULT 'new',           -- new | queued | publishing | published | failed | rejected | commercial | handled
    original_text TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',       -- [{type, file, mime, url}]
    has_video INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_user_message_at INTEGER NOT NULL,
    ai_status TEXT NOT NULL DEFAULT 'pending',    -- pending | running | done | error
    ai_result TEXT,
    ai_error TEXT,
    ai_cost_usd REAL NOT NULL DEFAULT 0,
    final_text TEXT,
    final_images TEXT,
    scheduled_at INTEGER,
    published_at INTEGER,
    fb_post_id TEXT,
    publish_error TEXT,
    decided_at INTEGER,
    reply_sent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions(status);
  CREATE INDEX IF NOT EXISTS idx_sub_sender ON submissions(sender_id, status);
  CREATE TABLE IF NOT EXISTS processed_mids (mid TEXT PRIMARY KEY, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const JSON_FIELDS = ['attachments', 'ai_result', 'final_images'];

export function parseRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of JSON_FIELDS) {
    if (out[f] != null) {
      try { out[f] = JSON.parse(out[f]); } catch { out[f] = null; }
    }
  }
  out.has_video = !!out.has_video;
  return out;
}

export function getSubmission(id) {
  return parseRow(db.prepare('SELECT * FROM submissions WHERE id = ?').get(id));
}

export function updateSubmission(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const vals = keys.map((k) => {
    const v = fields[k];
    if (JSON_FIELDS.includes(k) && v != null && typeof v !== 'string') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
  db.prepare(`UPDATE submissions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
}

export function insertSubmission(s) {
  const now = Date.now();
  const r = db.prepare(`INSERT INTO submissions
    (source, sender_id, sender_name, original_text, attachments, has_video, created_at, updated_at, last_user_message_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    s.source || 'facebook', s.sender_id || null, s.sender_name || null, s.original_text || '',
    JSON.stringify(s.attachments || []), s.has_video ? 1 : 0, s.created_at || now, now, s.created_at || now,
  );
  return Number(r.lastInsertRowid);
}

// Jednorazowe przetworzenie wiadomości z Facebooka (FB czasem wysyła tę samą kilka razy).
export function markMidProcessed(mid) {
  const r = db.prepare('INSERT OR IGNORE INTO processed_mids (mid, at) VALUES (?, ?)').run(mid, Date.now());
  return r.changes > 0;
}
