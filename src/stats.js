// Pomiar zgodności AI z decyzjami moderatora – ANONIMOWO (bez treści, nazwisk i identyfikatorów osób).
// Służy do oceny, czy w przyszłości można włączyć automatyczną publikację bezpiecznych postów.
import { db } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS decisions (
  submission_id INTEGER PRIMARY KEY,   -- tylko do nadpisania/cofnięcia decyzji; po usunięciu zgłoszenia nic nie znaczy
  at INTEGER NOT NULL,
  ai_verdict TEXT,
  ai_category TEXT,
  ai_preset TEXT,
  decision TEXT NOT NULL,              -- publish | reject | commercial | conversation | handled
  used_preset TEXT,
  text_changed INTEGER NOT NULL DEFAULT 0,
  had_images INTEGER NOT NULL DEFAULT 0,
  redacted INTEGER NOT NULL DEFAULT 0
)`);

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function logDecision(sub, decision, { usedPreset = null, finalText = null } = {}) {
  try {
    const ai = sub.ai_result || {};
    const images = (sub.attachments || []).filter((a) => a.type === 'image');
    const aiText = ai.suggested_text || sub.original_text || '';
    const textChanged = decision === 'publish' && finalText != null && norm(finalText) !== norm(aiText);
    db.prepare(`INSERT INTO decisions (submission_id, at, ai_verdict, ai_category, ai_preset, decision, used_preset, text_changed, had_images, redacted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(submission_id) DO UPDATE SET at = excluded.at, ai_verdict = excluded.ai_verdict, ai_category = excluded.ai_category,
        ai_preset = excluded.ai_preset, decision = excluded.decision, used_preset = excluded.used_preset,
        text_changed = excluded.text_changed, had_images = excluded.had_images, redacted = excluded.redacted`)
      .run(sub.id, Date.now(), sub.ai_status === 'done' ? ai.verdict || null : null, ai.category || null, ai.suggested_preset || null,
        decision, usedPreset, textChanged ? 1 : 0, images.length ? 1 : 0, images.some((a) => a.redacted) ? 1 : 0);
  } catch (err) {
    console.warn('[Statystyki] nie zapisano decyzji:', err.message);
  }
}

export function forgetDecision(submissionId) {
  db.prepare('DELETE FROM decisions WHERE submission_id = ?').run(submissionId);
}

// Czego moderator „oczekuje” przy danej ocenie AI.
const EXPECTED = { publish: 'publish', needs_edit: 'publish', reject: 'reject', commercial: 'commercial', conversation: 'conversation' };
const sameFamily = (expected, decision) => expected === decision
  || (expected === 'conversation' && decision === 'handled');

export function getStats(days = 30) {
  const since = Date.now() - days * 24 * 3600 * 1000;
  const rows = db.prepare('SELECT * FROM decisions WHERE at > ? ORDER BY at DESC').all(since);
  const withAi = rows.filter((r) => r.ai_verdict);
  const judged = withAi.filter((r) => EXPECTED[r.ai_verdict]); // bez „sprawdź ręcznie”
  const agree = judged.filter((r) => sameFamily(EXPECTED[r.ai_verdict], r.decision));

  // Tabela: AI proponowało (wiersze) → moderator zrobił (kolumny)
  const matrix = {};
  for (const r of withAi) {
    matrix[r.ai_verdict] ??= {};
    matrix[r.ai_verdict][r.decision] = (matrix[r.ai_verdict][r.decision] || 0) + 1;
  }

  // Szablony: gdy AI coś zaproponowało, a moderator użył szablonu – czy tego samego?
  const presetPairs = rows.filter((r) => r.ai_preset && r.used_preset);
  const presetAgree = presetPairs.filter((r) => r.ai_preset === r.used_preset).length;

  // Symulacja automatu: AI „✅ Do publikacji”, bez zdjęć.
  const autoTextOnly = withAi.filter((r) => r.ai_verdict === 'publish' && !r.had_images);
  const autoOk = autoTextOnly.filter((r) => r.decision === 'publish' && !r.text_changed).length;
  const autoEdited = autoTextOnly.filter((r) => r.decision === 'publish' && r.text_changed).length;
  const autoWrong = autoTextOnly.filter((r) => r.decision !== 'publish').length;
  // …i ze zdjęciami
  const autoImg = withAi.filter((r) => r.ai_verdict === 'publish' && r.had_images);
  const autoImgOk = autoImg.filter((r) => r.decision === 'publish' && !r.text_changed && !r.redacted).length;

  // Najczęstsze rozbieżności per kategoria
  const disagreeByCat = {};
  for (const r of judged) {
    if (sameFamily(EXPECTED[r.ai_verdict], r.decision)) continue;
    const k = r.ai_category || 'inne';
    disagreeByCat[k] = (disagreeByCat[k] || 0) + 1;
  }

  return {
    days, total: rows.length, withAi: withAi.length, judged: judged.length, agree: agree.length,
    agreePct: judged.length ? Math.round((agree.length / judged.length) * 1000) / 10 : null,
    manualCheck: withAi.filter((r) => r.ai_verdict === 'manual_check').length,
    matrix,
    preset: { pairs: presetPairs.length, agree: presetAgree },
    auto: {
      textOnly: { total: autoTextOnly.length, ok: autoOk, edited: autoEdited, wrong: autoWrong },
      withImages: { total: autoImg.length, ok: autoImgOk },
    },
    disagreeByCat,
  };
}
