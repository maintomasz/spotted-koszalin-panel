// Panel moderacji – logika w przeglądarce.
const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');
let tab = 'new';
let status = {};
let settingsCache = null;
const cards = new Map(); // id -> { el, sig, dirty }

const VERDICT = {
  publish: '✅ Do publikacji', needs_edit: '✏️ Wymaga poprawek', commercial: '💰 Komercyjne',
  reject: '⛔ Odrzucić', manual_check: '👀 Sprawdź ręcznie', conversation: '💬 Rozmowa',
};
const isInboxTab = () => tab === 'new' || tab === 'conversations';

// ---------- Szybkie odpowiedzi (szablony z wyzwalaczami) ----------
const presetList = () => settingsCache?.presets_list || [];
const presetById = (id) => presetList().find((p) => p.id === id);
const PRESET_ACTION_BTN = { reject: '⛔ Wyślij i odrzuć', commercial: '💰 Wyślij i oznacz jako reklama', conversation: '💬 Wyślij i przenieś do rozmów' };
const PRESET_ACTION_DONE = { reject: 'odrzucono', commercial: 'oznaczono jako reklama', conversation: 'przeniesiono do rozmów' };
const PRESET_ACTION_LABEL = { reject: 'Odrzuć', commercial: 'Oznacz jako reklama', conversation: 'Przenieś do rozmów' };
function quickReplies(suggested, act) {
  const list = presetList();
  if (!list.length) return '';
  const ordered = [...list].sort((a, b) => (b.id === suggested) - (a.id === suggested));
  const sugg = presetById(suggested);
  return `<div class="qr">
    ${sugg ? `<div class="qr-sugg">⭐ AI proponuje odpowiedź: <b>${esc(sugg.name)}</b></div>` : ''}
    <div class="qr-row">${ordered.map((p) => `<button class="chip-btn${p.id === suggested ? ' sugg' : ''}" data-act="${act}" data-preset="${esc(p.id)}">${p.id === suggested ? '⭐ ' : ''}${esc(p.name)}</button>`).join('')}</div>
  </div>`;
}
const inboxUrl = () => `https://business.facebook.com/latest/inbox/all/${status.pageId ? `?asset_id=${encodeURIComponent(status.pageId)}` : ''}`;
const CATEGORY = {
  pytanie_polecenie: 'pytanie / polecenie', zgubione_znalezione: 'zgubione / znalezione', zwierzeta: 'zwierzęta',
  ostrzezenie: 'ostrzeżenie', spotted: 'spotted', podziekowanie: 'podziękowanie', skarga_problem: 'skarga / problem',
  wydarzenie: 'wydarzenie', komercyjne: 'komercyjne', inne: 'inne',
};
const ISSUE = {
  dane_osobowe: 'Dane osobowe', wizerunek_twarz: 'Wizerunek / twarz', tablica_rejestracyjna: 'Tablica rejestracyjna',
  dokument_tozsamosci: 'Dokument tożsamości', pomowienie_znieslawienie: 'Pomówienie', zniewaga_wulgaryzmy: 'Zniewaga / wulgaryzmy',
  mowa_nienawisci: 'Mowa nienawiści', przemoc_grozby: 'Przemoc / groźby', tresci_seksualne: 'Treści seksualne',
  nielegalne: 'Nielegalne', reklama_komercja: 'Reklama', spam_oszustwo: 'Spam / oszustwo', dezinformacja: 'Dezinformacja', inne: 'Inne',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ts) => ts ? new Date(ts).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' });

function toast(msg, opts = {}) {
  const t = $("#toast");
  t.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = msg;
  t.appendChild(span);
  if (opts.undoId) {
    const b = document.createElement("button");
    b.textContent = "Cofnij";
    b.onclick = async () => {
      t.classList.remove("show");
      try { await api(`/api/submissions/${opts.undoId}/restore`, { body: {} }); toast("↩︎ Cofnięto"); tick(); } catch (err) { toast(err.message); }
    };
    t.appendChild(b);
  }
  t.classList.toggle("has-action", !!opts.undoId);
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), opts.undoId ? 6000 : 3000);
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('Wylogowano'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Błąd ${res.status}`);
  return data;
}

// ---------- Status i liczniki ----------
async function refreshStatus() {
  status = await api('/api/status');
  for (const el of document.querySelectorAll('[data-count]')) {
    const n = status.counts[el.dataset.count];
    el.textContent = n ? n : '';
  }
  $('[data-tab="failed"]').hidden = !status.counts.failed;
  const parts = [
    status.fb ? 'Facebook: połączony' : 'Facebook: tryb demo',
    status.ai ? `AI: ${status.model}` : 'AI: tryb demo (brak klucza)',
  ];
  $('#modeInfo').textContent = parts.join(' · ');
}

// ---------- Zakładki ----------
document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  if (tab === "mailbox") mailboxPerson = null;
  for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('active', x === b);
  cards.clear();
  threadCards.clear();
  main.innerHTML = '';
  render();
});

async function render() {
  try {
    if (tab === 'settings') return renderSettings();
    if (tab === 'conversations') return renderThreads(await api('/api/threads'));
    if (tab === 'mailbox') return mailboxPerson ? renderPerson(mailboxPerson) : renderMailbox();
    const items = await api(`/api/submissions?status=${tab}`);
    if (isInboxTab()) return renderInbox(items);
    return renderList(items);
  } catch (err) {
    main.innerHTML = `<div class="empty error-text">${esc(err.message)}</div>`;
  }
}

// ---------- Do decyzji ----------
function renderInbox(items) {
  const ids = new Set(items.map((i) => i.id));
  for (const [id, c] of cards) if (!ids.has(id)) { c.el.remove(); cards.delete(id); }
  if (!items.length) {
    main.innerHTML = tab === 'conversations'
      ? `<div class="empty">Brak rozmów do obsłużenia 💬<br><small>Tu trafiają wiadomości, które nie są postami – pytania do admina, powitania, dalszy ciąg rozmowy.</small></div>`
      : `<div class="empty">Brak nowych wiadomości 🎉<br><small>Nowe pojawią się tu automatycznie.</small></div>`;
    cards.clear();
    return;
  }
  $('.empty', main)?.remove();
  let prev = null;
  for (const s of items) {
    const sig = `${s.ai_status}|${s.updated_at}`;
    let c = cards.get(s.id);
    if (!c) {
      c = { el: document.createElement('div'), sig: null, dirty: false };
      c.el.className = 'card';
      cards.set(s.id, c);
    }
    if (c.sig !== sig) {
      if (!c.dirty) { fillCard(c, s); c.sig = sig; }
      else if (!$('.stale', c.el)) {
        const n = document.createElement('div');
        n.className = 'notice info stale';
        n.innerHTML = 'Zgłoszenie się zmieniło (nowa ocena AI lub dopisana wiadomość). <a href="#">Odśwież kartę</a>';
        n.querySelector('a').onclick = (e) => { e.preventDefault(); c.dirty = false; fillCard(c, s); c.sig = sig; };
        c.el.prepend(n);
      }
    }
    if (prev) prev.after(c.el); else main.prepend(c.el);
    prev = c.el;
  }
}

function windowLeft(s) {
  if (s.source !== 'facebook') return '';
  const left = s.last_user_message_at + 24 * 3600 * 1000 - Date.now();
  if (left <= 0) return '<span class="timer late" title="Minęło 24 h – nie da się już odpisać na Messengerze">⏱ po 24h</span>';
  const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
  return `<span class="timer${h < 3 ? ' late' : ''}" title="Pozostały czas na odpowiedź na Messengerze">⏱ ${h}h${h < 3 ? ` ${m}m` : ''}</span>`;
}

const fmtShort = (ts) => {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? fmtTime(ts) : fmt(ts);
};

function fillCard(c, s) {
  const el = c.el;
  const ai = s.ai_result;
  const images = (s.attachments || []).filter((a) => a.type === 'image' && a.file);
  const otherAtt = (s.attachments || []).filter((a) => a.type !== 'image' && a.type !== 'video');
  const aiPending = s.ai_status === 'pending' || s.ai_status === 'running';
  const verdict = aiPending ? 'pending' : s.ai_status === 'error' ? 'error' : ai?.verdict || 'manual_check';
  const verdictLabel = aiPending ? '<span class="spinner"></span> AI ocenia…' : s.ai_status === 'error' ? '⚠️ Błąd AI' : VERDICT[verdict];
  const suggested = ai && ai.suggested_text ? ai.suggested_text : s.original_text;
  const changed = !!(ai?.suggested_text && ai.suggested_text.trim() !== (s.original_text || '').trim());
  const notes = new Map((ai?.image_notes || []).map((n) => [n.image_number, n]));
  const hideNotes = [...notes.values()].filter((n) => n.needs_anonymization && n.what_to_hide);
  const issues = !aiPending && ai?.issues ? ai.issues : [];
  const who = s.sender_name || (s.source === 'facebook' ? 'Użytkownik FB' : s.source);

  el.innerHTML = `
    <div class="top">
      <span class="badge v-${verdict}">${verdictLabel}</span>
      <span class="meta-r">${esc(who)} · ${fmtShort(s.created_at)} ${windowLeft(s)}</span>
    </div>
    ${ai?.summary && !aiPending ? `<div class="summary">${ai.category ? `<span class="cat">${esc(CATEGORY[ai.category] || ai.category)}</span> ` : ''}${esc(ai.summary.replace(/^\[DEMO – bez AI\]\s*/, ''))}</div>` : ''}
    ${s.ai_status === 'error' ? `<div class="error-text">${esc(s.ai_error)}</div>` : ''}
    ${issues.length ? `<div class="chips">${issues.map((i) =>
      `<span class="chip sev-${esc(i.severity)}" title="${esc(i.description)}">${esc(ISSUE[i.type] || i.type)}</span>`).join('')}</div>` : ''}
    ${String(s.flags || '').includes('author_edit') ? '<div class="notice">⚠️ Autor dopisał coś, gdy post czekał w kolejce – publikacja wstrzymana. Sprawdź tekst i zatwierdź ponownie.</div>' : ''}
    ${s.has_video ? '<div class="notice">🎬 Jest wideo – obejrzyj w skrzynce FB i wrzuć ręcznie. Potem „Odrzuć z powodem” z odznaczonym wysyłaniem, żeby zdjąć kartę.</div>' : ''}
    ${otherAtt.length ? `<div class="notice info">Inne załączniki (${otherAtt.map((a) => esc(a.type)).join(', ')}) – sprawdź w skrzynce FB.</div>` : ''}
    ${images.length ? `<div class="thumbs-row">${images.map((img, i) => {
      const n = notes.get(i + 1);
      const on = !n || n.ok_to_publish !== false;
      return `<div class="thumb${on ? '' : ' off'}${img.redacted ? ' redacted' : ''}" data-img="${esc(img.file)}" data-idx="${i}" data-on="${on ? 1 : 0}" title="Dotknij, aby zakryć dane">
        <img src="/media/${esc(img.file)}" alt="zdjęcie ${i + 1}" loading="lazy">
        <button class="tick" aria-label="W poście / bez">${on ? '✓' : '✕'}</button><span class="num">${i + 1}</span>
        ${img.redacted ? '<span class="shield" title="Zakryte">🛡️</span>' : n?.needs_anonymization ? '<span class="warn">⚠️</span>' : ''}
      </div>`;
    }).join('')}</div>
    <div class="img-hint">Dotknij zdjęcia, żeby zakryć dane · ✓ w rogu = zdjęcie w poście</div>
    ${hideNotes.length ? `<div class="img-notes">⚠️ Zakryj: ${groupNotes(hideNotes)}</div>` : ''}` : ''}
    <div class="post" data-act="edit" title="Dotknij, aby edytować">${suggested ? esc(suggested) : '<i>(bez tekstu)</i>'}</div>
    <textarea class="post-edit" hidden>${esc(suggested)}</textarea>
    ${changed ? `<details class="orig"><summary>Oryginał (AI poprawiło tekst)</summary><div class="original">${esc(s.original_text || '(bez tekstu)')}</div><a data-act="use-original">↩︎ wstaw oryginał</a></details>` : ''}
    ${`
    ${quickReplies(ai?.suggested_preset, 'preset')}
    <div class="actions6">
      <button class="btn primary" data-act="approve" title="Do kolejki publikacji"><span class="i">✅</span><span>Zatwierdź</span></button>
      <button class="btn danger" data-act="reject-quick" title="Odrzuć i wyślij wiadomość z szablonu"><span class="i">⛔</span><span>Odrzuć</span></button>
      <button class="btn money" data-act="commercial" title="Komercyjne – wyślij ofertę reklamy"><span class="i">💰</span><span>Reklama</span></button>
      <button class="btn danger" data-act="reject" title="Odrzuć i dopisz powód"><span class="i">✍️</span><span>Odrzuć z powodem</span></button>
      <button class="btn" data-act="approve-now" title="Opublikuj teraz, z pominięciem kolejki"><span class="i">🚀</span><span>Opublikuj od razu</span></button>
      <button class="btn" data-act="to-thread" title="To pytanie do admina – przenieś do Rozmów"><span class="i">💬</span><span>Rozmowa</span></button>
    </div>`}
    <div class="sub-slot"></div>`;

  const ta = $('.post-edit', el);
  const view = $('.post', el);
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
  const startEdit = () => {
    view.hidden = true; ta.hidden = false; autosize(); ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };
  ta.addEventListener('input', () => { c.dirty = true; autosize(); });
  el.querySelectorAll('.thumb').forEach((t) => t.addEventListener('click', (e) => {
    if (e.target.closest('.tick')) {
      const on = t.dataset.on !== '1';
      t.dataset.on = on ? '1' : '0';
      t.classList.toggle('off', !on);
      $('.tick', t).textContent = on ? '✓' : '✕';
      c.dirty = true;
      return;
    }
    const att = images[Number(t.dataset.idx)];
    const note = notes.get(Number(t.dataset.idx) + 1);
    openRedactor(s, att, note, (newFile, redacted) => {
      // Podmieniamy miniaturę bez przeładowania karty (żeby nie zgubić edycji tekstu).
      att.file = newFile;
      att.redacted = redacted;
      t.dataset.img = newFile;
      $('img', t).src = `/media/${newFile}`;
      t.classList.toggle('redacted', redacted);
      $('.warn', t)?.remove();
      $('.shield', t)?.remove();
      if (redacted) t.insertAdjacentHTML('beforeend', '<span class="shield" title="Zakryte">🛡️</span>');
      c.dirty = true;
    });
  }));
  const selectedImages = () => [...el.querySelectorAll('.thumb[data-on="1"]')].map((x) => x.dataset.img);
  const slot = $('.sub-slot', el);

  const decide = async (btn, path, body, msg) => act1(btn, async () => {
    const r = await api(`/api/submissions/${s.id}/${path}`, { body });
    removeCard(s.id);
    toast(typeof msg === 'function' ? msg(r) : msg, { undoId: s.id });
  });

  el.onclick = async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act;
    if (act === 'edit') return startEdit();
    if (act === 'zoom') return lightbox(a.dataset.src);
    if (act === 'use-original') { ta.value = s.original_text; view.textContent = s.original_text; c.dirty = true; return; }
    if (act === 'approve') {
      return decide(a, 'approve', { text: ta.value, images: selectedImages() }, (r) => `✅ Zaplanowano na ${fmtTime(r.scheduled_at)}`);
    }
    if (act === 'approve-now') {
      return decide(a, 'approve', { text: ta.value, images: selectedImages(), now: true }, '🚀 Publikuję w ciągu kilkunastu sekund');
    }
    const canReply = s.source === 'facebook';
    const openPreset = (p) => {
      slot.innerHTML = `<div class="sub-panel">
        <div class="label"><span>📋 <b>${esc(p.name)}</b> – możesz poprawić treść przed wysłaniem</span></div>
        <label class="row small"><input type="checkbox" class="send" ${canReply ? 'checked' : 'disabled'}>
          Wyślij na Messengerze${canReply ? '' : ' (to nie jest wiadomość z FB)'}</label>
        <textarea class="msg">${esc(p.text)}</textarea>
        <div class="row">
          <button class="btn ${p.action === 'commercial' ? 'money' : p.action === 'reject' ? 'danger' : 'primary'} grow" data-act="preset-go" data-preset="${esc(p.id)}">${PRESET_ACTION_BTN[p.action] || 'Wyślij'}</button>
          <button class="btn" data-act="cancel">Anuluj</button>
        </div></div>`;
      const m = $('.msg', slot);
      m.style.height = Math.min(320, m.scrollHeight + 2) + 'px';
      slot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    if (act === 'preset') {
      const p = presetById(a.dataset.preset);
      if (p) openPreset(p);
      return;
    }
    if (act === 'preset-go') {
      const p = presetById(a.dataset.preset);
      const send = $('.send', slot).checked;
      return decide(a, 'preset', { presetId: p.id, text: $('.msg', slot).value, send },
        (r) => `📋 ${p.name}: ${PRESET_ACTION_DONE[r.action] || 'gotowe'}${r.reply === 'wysłano' ? ' · wysłano wiadomość' : ''}`);
    }
    if (act === 'reject-quick') {
      const st = settingsCache || (settingsCache = await api('/api/settings'));
      return decide(a, 'reject', { message: presetById('odrzucenie')?.text || st.template_reject }, (r) => `⛔ Odrzucono${r.reply === 'wysłano' ? ' · wysłano wiadomość' : ''}`);
    }
    if (act === 'commercial' && presetById('reklama')) return openPreset(presetById('reklama'));
    if (act === 'commercial' || act === 'reject') {
      const st = settingsCache || (settingsCache = await api('/api/settings'));
      const isCom = act === 'commercial';
      const msg = isCom ? st.template_commercial : `${presetById('odrzucenie')?.text || st.template_reject}\n\nPowód: `;
      slot.innerHTML = `<div class="sub-panel">
        <label class="row small"><input type="checkbox" class="send" ${canReply ? 'checked' : 'disabled'}>
          ${isCom ? 'Wyślij ofertę reklamy na Messengerze' : 'Wyślij wiadomość z powodem'}${canReply ? '' : ' (to nie jest wiadomość z FB)'}</label>
        <textarea class="msg">${esc(msg)}</textarea>
        <div class="row">
          <button class="btn ${isCom ? 'money' : 'danger'} grow" data-act="${isCom ? 'commercial-go' : 'reject-go'}">${isCom ? '💰 Oznacz jako komercyjne' : '⛔ Odrzuć'}</button>
          <button class="btn" data-act="cancel">Anuluj</button>
        </div></div>`;
      const m = $('.msg', slot);
      m.focus();
      m.setSelectionRange(m.value.length, m.value.length);
      return;
    }
    if (act === 'commercial-go' || act === 'reject-go') {
      const message = $('.send', slot).checked ? $('.msg', slot).value : '';
      const isCom = act === 'commercial-go';
      return decide(a, isCom ? 'commercial' : 'reject', { message },
        (r) => `${isCom ? '💰 Komercyjne' : '⛔ Odrzucono'}${r.reply === 'wysłano' ? ' · wysłano wiadomość' : ''}`);
    }
    if (act === 'cancel') { slot.innerHTML = ''; return; }
    if (act === 'more') {
      if (slot.innerHTML) { slot.innerHTML = ''; return; }
      slot.innerHTML = `<div class="sub-panel menu">
        <button class="btn" data-act="approve">✅ To jednak post – zatwierdź do kolejki</button>
        <button class="btn" data-act="reject">✍️ Odrzuć z powodem</button></div>`;
      return;
    }
    if (act === 'handled') return decide(a, 'handled', {}, '✋ Oznaczono jako obsłużone');
    if (act === 'to-thread') return decide(a, 'to-thread', {}, '💬 Przeniesiono do „Rozmów”');
  };
}

// Te same uwagi dla kilku zdjęć pokazujemy raz: „1, 2, 3: tablica rejestracyjna”.
function groupNotes(list) {
  const by = new Map();
  for (const n of list) {
    const k = n.what_to_hide.replace(/\s*\(demo nie widzi zdjęć\)\.?/, '').trim();
    by.set(k, [...(by.get(k) || []), n.image_number]);
  }
  return [...by].map(([txt, nums]) => `<b>${nums.join(', ')}</b> ${esc(txt)}`).join(' · ');
}

// ---------- Edytor zakrywania danych na zdjęciu ----------
const SCENARIOS = [
  ['auto', '🤖 Wykryj automatycznie'], ['payment_card', '💳 Karta płatnicza'], ['id_document', '🪪 Dokument (dowód, prawo jazdy)'],
  ['license_plate', '🚗 Tablice rejestracyjne'], ['faces', '🙂 Twarze'],
];

function openRedactor(sub, att, note, onSaved) {
  // Zawsze pracujemy na ORYGINALE – zapisane prostokąty da się potem poprawić.
  const baseFile = att.orig || att.file;
  let boxes = (att.boxes || []).map((b) => ({ ...b }));
  let selected = -1;
  let defaultStyle = 'black';
  const history = [];
  const pushHistory = () => { history.push(JSON.stringify(boxes)); if (history.length > 50) history.shift(); };

  const ov = document.createElement('div');
  ov.className = 'redactor';
  ov.innerHTML = `
    <div class="r-head">
      <select class="r-scen">${SCENARIOS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <button class="btn" data-r="ai">🤖 Zaznacz AI</button>
    </div>
    <div class="r-status"></div>
    <div class="r-stage"><div class="r-wrap"><img class="r-img" alt=""><div class="r-layer"></div></div></div>
    <div class="r-tools">
      <button class="btn" data-r="style">⬛ Czarny</button>
      <button class="btn" data-r="del">🗑 Usuń</button>
      <button class="btn" data-r="undo">↩︎ Cofnij</button>
      <button class="btn" data-r="clear">Wyczyść</button>
    </div>
    <div class="r-foot">
      ${att.orig ? '<button class="btn" data-r="revert">Przywróć oryginał</button>' : ''}
      <button class="btn" data-r="cancel">Anuluj</button>
      <button class="btn primary grow" data-r="save">💾 Zapisz zakrycie</button>
    </div>`;
  document.body.appendChild(ov);
  document.body.style.overflow = 'hidden';
  const img = $('.r-img', ov);
  const wrap = $('.r-wrap', ov);
  const layer = $('.r-layer', ov);
  const status = $('.r-status', ov);
  const scen = $('.r-scen', ov);
  const styleBtn = $('[data-r="style"]', ov);
  const close = () => { ov.remove(); document.body.style.overflow = ''; };
  const setStatus = (t, cls = '') => { status.className = 'r-status ' + cls; status.innerHTML = t; };

  // Dopasowanie obrazka do ekranu (proporcje zachowane, prostokąty w ułamkach 0–1).
  const fit = () => {
    if (!img.naturalWidth) return;
    const st = $('.r-stage', ov).getBoundingClientRect();
    const scale = Math.min(st.width / img.naturalWidth, st.height / img.naturalHeight);
    wrap.style.width = img.naturalWidth * scale + 'px';
    wrap.style.height = img.naturalHeight * scale + 'px';
  };
  img.onload = () => { fit(); draw(); };
  img.src = `/media/${baseFile}`;
  window.addEventListener('resize', fit);

  const draw = () => {
    layer.innerHTML = boxes.map((b, i) => `<div class="r-box ${b.style}${i === selected ? ' sel' : ''}" data-i="${i}"
      style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%">
      ${b.label ? `<span class="r-label">${esc(b.label)}</span>` : ''}${i === selected ? '<span class="r-handle"></span>' : ''}</div>`).join('');
    const st = selected >= 0 ? boxes[selected].style : defaultStyle;
    styleBtn.textContent = st === 'black' ? '⬛ Czarny' : '🌫 Rozmycie';
    $('[data-r="del"]', ov).disabled = selected < 0;
    $('[data-r="undo"]', ov).disabled = !history.length;
  };

  const applySuggestion = (r) => {
    pushHistory();
    boxes = (r.boxes || []).map((b) => ({ x: b.x / 1000, y: b.y / 1000, w: b.w / 1000, h: b.h / 1000, style: b.style, label: b.label }));
    selected = -1;
    draw();
    setStatus(`🤖 ${esc(r.note || 'Gotowe.')}${boxes.length ? ' <b>Sprawdź i popraw palcem, potem zapisz.</b>' : ''}`, boxes.length ? 'ok' : '');
  };

  const askAi = async () => {
    const btn = $('[data-r="ai"]', ov);
    btn.disabled = true;
    setStatus('<span class="spinner"></span> AI szuka danych do zakrycia… (do kilkudziesięciu sekund)');
    try {
      const r = await api(`/api/submissions/${sub.id}/redact-suggest`, { body: { file: att.file, scenario: scen.value } });
      att.suggest = { scenario: scen.value, ...r };
      applySuggestion(r);
    } catch (err) {
      setStatus('⚠️ ' + esc(err.message), 'bad');
    } finally {
      btn.disabled = false;
    }
  };

  // Start: zapisane prostokąty → poprzednia propozycja AI → nowa propozycja AI (gdy zdjęcie oznaczone do zakrycia).
  if (boxes.length) setStatus('Zapisane zakrycie – możesz je poprawić.');
  else if (att.suggest) { scen.value = att.suggest.scenario || 'auto'; applySuggestion(att.suggest); }
  else if (note?.needs_anonymization) askAi();
  else setStatus('Przeciągnij palcem po zdjęciu, żeby zakryć fragment, albo kliknij „🤖 Zaznacz AI”.');

  // --- Rysowanie / przesuwanie / zmiana rozmiaru palcem ---
  let drag = null;
  const pos = (e) => {
    const r = wrap.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  wrap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    const p = pos(e);
    const boxEl = e.target.closest('.r-box');
    pushHistory();
    if (e.target.classList.contains('r-handle')) {
      drag = { mode: 'resize', i: selected, start: p, orig: { ...boxes[selected] } };
    } else if (boxEl) {
      selected = Number(boxEl.dataset.i);
      drag = { mode: 'move', i: selected, start: p, orig: { ...boxes[selected] } };
      draw();
    } else {
      boxes.push({ x: p.x, y: p.y, w: 0, h: 0, style: defaultStyle, label: '' });
      selected = boxes.length - 1;
      drag = { mode: 'new', i: selected, start: p };
      draw();
    }
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pos(e);
    const b = boxes[drag.i];
    if (drag.mode === 'new') {
      b.x = Math.min(p.x, drag.start.x); b.y = Math.min(p.y, drag.start.y);
      b.w = Math.abs(p.x - drag.start.x); b.h = Math.abs(p.y - drag.start.y);
    } else if (drag.mode === 'move') {
      b.x = Math.min(1 - b.w, Math.max(0, drag.orig.x + p.x - drag.start.x));
      b.y = Math.min(1 - b.h, Math.max(0, drag.orig.y + p.y - drag.start.y));
    } else {
      b.w = Math.max(0.01, Math.min(1 - b.x, drag.orig.w + p.x - drag.start.x));
      b.h = Math.max(0.01, Math.min(1 - b.y, drag.orig.h + p.y - drag.start.y));
    }
    draw();
  });
  const endDrag = () => {
    if (!drag) return;
    const b = boxes[drag.i];
    if (drag.mode === 'new' && (b.w < 0.015 || b.h < 0.015)) { boxes.splice(drag.i, 1); selected = -1; history.pop(); }
    else if (drag.mode !== 'new' && JSON.stringify(b) === JSON.stringify(drag.orig)) history.pop(); // samo zaznaczenie
    drag = null;
    draw();
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);

  // --- Zapis: renderujemy zakrycie na pełnej rozdzielczości oryginału ---
  const render = () => {
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    for (const b of boxes) {
      const x = Math.round(b.x * cv.width), y = Math.round(b.y * cv.height);
      const w = Math.max(1, Math.round(b.w * cv.width)), h = Math.max(1, Math.round(b.h * cv.height));
      if (b.style === 'pixelate') {
        const block = Math.max(10, Math.round(Math.max(w, h) / 8));
        const sw = Math.max(1, Math.ceil(w / block)), sh = Math.max(1, Math.ceil(h / block));
        const tmp = document.createElement('canvas');
        tmp.width = sw; tmp.height = sh;
        tmp.getContext('2d').drawImage(cv, x, y, w, h, 0, 0, sw, sh);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, sw, sh, x, y, w, h);
        ctx.imageSmoothingEnabled = true;
      } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(x, y, w, h);
      }
    }
    return cv.toDataURL('image/jpeg', 0.9).split(',')[1];
  };

  ov.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-r]');
    if (!a) return;
    const act = a.dataset.r;
    if (act === 'cancel') return close();
    if (act === 'ai') return askAi();
    if (act === 'style') {
      if (selected >= 0) { pushHistory(); boxes[selected].style = boxes[selected].style === 'black' ? 'pixelate' : 'black'; }
      else defaultStyle = defaultStyle === 'black' ? 'pixelate' : 'black';
      return draw();
    }
    if (act === 'del' && selected >= 0) { pushHistory(); boxes.splice(selected, 1); selected = -1; return draw(); }
    if (act === 'undo' && history.length) { boxes = JSON.parse(history.pop()); selected = -1; return draw(); }
    if (act === 'clear') { pushHistory(); boxes = []; selected = -1; return draw(); }
    if (act === 'revert') {
      return act1(a, async () => {
        const r = await api(`/api/submissions/${sub.id}/redact-revert`, { body: { file: att.file } });
        delete att.orig; att.boxes = [];
        onSaved(r.file, false);
        toast('↩︎ Przywrócono oryginał zdjęcia');
        close();
      });
    }
    if (act === 'save') {
      if (!boxes.length) return setStatus('Nie ma nic do zakrycia – zaznacz fragment albo kliknij „Anuluj”.', 'bad');
      return act1(a, async () => {
        setStatus('<span class="spinner"></span> Zapisuję…');
        const r = await api(`/api/submissions/${sub.id}/redact`, { body: { file: att.file, data: render(), boxes } });
        att.orig = baseFile; att.boxes = boxes;
        onSaved(r.file, true);
        toast('🛡️ Zapisano – do posta pójdzie zakryta wersja');
        close();
      });
    }
  });
}

function lightbox(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<img src="${esc(src)}" alt=""><button class="close" aria-label="Zamknij">✕</button>`;
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

async function act1(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (err) { toast(err.message); } finally { btn.disabled = false; }
}

function removeCard(id) {
  const c = cards.get(id);
  if (c) { c.el.remove(); cards.delete(id); }
  if (!cards.size && isInboxTab()) render();
  refreshStatus();
}

// ---------- Rozmowy (wątki) ----------
const REASON = {
  conversation: '💬 Rozmowa', after_published: '💬 Pytanie po publikacji', after_rejected: '💬 Pytanie po odrzuceniu',
  after_commercial: '💬 Po ofercie reklamy', after_handled: '💬 Pytanie',
};
const STATUS_LABEL = {
  published: '✅ opublikowane', rejected: '⛔ odrzucone', commercial: '💰 komercyjne', handled: '✋ obsłużone',
  queued: '🕒 w kolejce', new: '⏳ czeka na decyzję', conversation: '💬 rozmowa', failed: '⚠️ błąd publikacji',
};
const KIND_LABEL = { auto_published: '🤖 podziękowanie po publikacji', auto_reject: '🤖 odrzucenie', auto_commercial: '🤖 oferta reklamy', system: '⚙️', reply: '' };
const threadCards = new Map();

function postLink(sub) {
  return sub?.fb_post_id && !String(sub.fb_post_id).startsWith('DEMO')
    ? `<a href="https://www.facebook.com/${esc(sub.fb_post_id)}" target="_blank" rel="noopener">zobacz post ↗</a>` : '';
}

function renderThreads(items) {
  if (!items.length) {
    threadCards.clear();
    main.innerHTML = `<div class="empty">Brak otwartych rozmów 💬<br><small>Tu trafiają pytania do admina i prośby po publikacji lub odrzuceniu. Podziękowania („dzięki”, 👍) nie trafiają nigdzie.</small></div>`;
    return;
  }
  $('.empty', main)?.remove();
  const ids = new Set(items.map((t) => t.sender_id));
  for (const [id, c] of threadCards) if (!ids.has(id)) { c.el.remove(); threadCards.delete(id); }
  let prev = null;
  for (const t of items) {
    const sig = `${t.updated_at}|${t.history.length}`;
    let c = threadCards.get(t.sender_id);
    if (!c) {
      c = { el: document.createElement('div'), sig: null };
      c.el.className = 'card thread';
      threadCards.set(t.sender_id, c);
    }
    const typing = $('.reply', c.el)?.value.trim() || $('.sub-slot', c.el)?.innerHTML;
    if (c.sig !== sig && !typing) { fillThread(c, t); c.sig = sig; }
    if (prev) prev.after(c.el); else main.prepend(c.el);
    prev = c.el;
  }
}

function bubble(m) {
  const imgs = (m.attachments || []).filter((a) => a.type === 'image' && a.file);
  const other = (m.attachments || []).filter((a) => a.type !== 'image');
  const kindLabel = String(m.kind || '').startsWith('preset_') ? `📋 ${presetById(m.kind.slice(7))?.name || 'szablon'}` : KIND_LABEL[m.kind];
  const label = m.direction === 'out' && kindLabel ? `<div class="b-label">${esc(kindLabel)}</div>` : '';
  return `<div class="b ${m.direction === 'out' ? 'out' : 'in'}">
    ${label}
    ${m.text ? `<div class="b-text">${esc(m.text)}</div>` : ''}
    ${imgs.length ? `<div class="b-imgs">${imgs.map((a) => `<img src="/media/${esc(a.file)}" data-act="zoom" data-src="/media/${esc(a.file)}" alt="">`).join('')}</div>` : ''}
    ${other.length ? `<div class="b-text muted">${other.map((a) => (a.type === 'sticker' ? '👍' : `[${esc(a.type)}]`)).join(' ')}</div>` : ''}
    <div class="b-time">${fmtShort(m.created_at)}</div>
  </div>`;
}

function fillThread(c, t) {
  const el = c.el;
  const sub = t.submission;
  const canReply = t.last_in_at && Date.now() - t.last_in_at < 24 * 3600 * 1000;
  const left = t.last_in_at ? t.last_in_at + 24 * 3600 * 1000 - Date.now() : 0;
  const timer = canReply
    ? `<span class="timer${left < 3 * 3600000 ? ' late' : ''}">⏱ ${Math.floor(left / 3600000)}h</span>`
    : '<span class="timer late">⏱ po 24h</span>';
  el.innerHTML = `
    <div class="top">
      <span class="badge v-conversation">${REASON[t.reason] || '💬 Rozmowa'}</span>
      <span class="meta-r">${esc(t.sender_name || 'Użytkownik FB')} · ${t.last_in_at ? fmtShort(t.last_in_at) : ''} ${timer}</span>
    </div>
    ${t.summary ? `<div class="summary">🤖 ${esc(t.summary.replace(/^\[DEMO[^\]]*\]\s*/, ''))}</div>` : ''}
    ${sub && sub.status !== 'conversation' ? `<div class="ctx">Dotyczy zgłoszenia: <b>${STATUS_LABEL[sub.status] || esc(sub.status)}</b> ${postLink(sub)}
      <div class="ctx-text">${esc((sub.final_text || sub.original_text || '').slice(0, 160))}${(sub.final_text || sub.original_text || '').length > 160 ? '…' : ''}</div></div>` : ''}
    <div class="chat">${t.history.map(bubble).join('')}</div>
    ${canReply ? `${quickReplies(t.preset, 'tpl')}<textarea class="reply" rows="2" placeholder="Napisz odpowiedź albo wybierz szybką odpowiedź…"></textarea>` : '<div class="notice info">Minęło 24 h od ostatniej wiadomości – Facebook pozwala odpisać już tylko ze skrzynki strony.</div>'}
    <div class="decide">
      ${canReply ? '<button class="btn primary grow" data-act="send">📤 Wyślij</button>' : `<a class="btn primary grow" href="${inboxUrl()}" target="_blank" rel="noopener">💬 Odpowiedz w skrzynce</a>`}
      <button class="btn" data-act="close" title="Sprawa załatwiona">✅ Zamknij</button>
      <button class="btn icon" data-act="more" title="Więcej opcji">⋯</button>
    </div>
    <div class="sub-slot"></div>`;
  const chat = $('.chat', el);
  requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; }); // po wstawieniu karty na stronę
  const ta = $('.reply', el);
  if (ta) ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; });
  const slot = $('.sub-slot', el);
  const psid = encodeURIComponent(t.sender_id);

  el.onclick = async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act;
    if (act === 'zoom') return lightbox(a.dataset.src);
    if (act === 'tpl') {
      const p = presetById(a.dataset.preset);
      if (p && ta) { ta.value = p.text; ta.dispatchEvent(new Event('input')); ta.focus(); }
      return;
    }
    if (act === 'send') {
      return act1(a, async () => {
        await api(`/api/threads/${psid}/reply`, { body: { text: ta.value } });
        ta.value = '';
        toast('📤 Wysłano');
        c.sig = null;
        tick();
      });
    }
    if (act === 'close') {
      return act1(a, async () => {
        await api(`/api/threads/${psid}/close`, { body: {} });
        c.el.remove(); threadCards.delete(t.sender_id);
        if (!threadCards.size) render();
        refreshStatus();
        const tt = $('#toast');
        toast('✅ Rozmowa zamknięta');
        const b = document.createElement('button');
        b.textContent = 'Cofnij';
        b.onclick = async () => { tt.classList.remove('show'); await api(`/api/threads/${psid}/reopen`, { body: {} }); tick(); };
        tt.appendChild(b); tt.classList.add('has-action');
      });
    }
    if (act === 'more') {
      if (slot.innerHTML) { slot.innerHTML = ''; return; }
      slot.innerHTML = `<div class="sub-panel menu">
        <a class="btn" href="${inboxUrl()}" target="_blank" rel="noopener">💬 Otwórz w skrzynce Facebooka</a>
        ${sub?.status === 'published' ? '<button class="btn" data-act="edit-pub">✏️ Popraw opublikowany post</button>' : ''}
        <button class="btn" data-act="to-post">📝 To jednak post – przenieś do decyzji</button></div>`;
      return;
    }
    if (act === 'edit-pub') {
      slot.innerHTML = `<div class="sub-panel">
        <div class="label"><span>Treść opublikowanego posta – po zapisaniu zmieni się na Facebooku</span></div>
        <textarea class="msg">${esc(sub.final_text || '')}</textarea>
        <div class="row"><button class="btn primary grow" data-act="edit-pub-go">💾 Zapisz poprawkę</button><button class="btn" data-act="cancel">Anuluj</button></div></div>`;
      return;
    }
    if (act === 'edit-pub-go') {
      return act1(a, async () => {
        await api(`/api/submissions/${sub.id}/edit-published`, { body: { text: $('.msg', slot).value } });
        slot.innerHTML = '';
        toast('✏️ Post poprawiony na Facebooku');
        c.sig = null;
        tick();
      });
    }
    if (act === 'to-post') {
      return act1(a, async () => {
        await api(`/api/threads/${psid}/to-post`, { body: {} });
        c.el.remove(); threadCards.delete(t.sender_id);
        if (!threadCards.size) render();
        refreshStatus();
        toast('📝 Przeniesiono do „Do decyzji”');
      });
    }
    if (act === 'cancel') slot.innerHTML = '';
  };
}

// ---------- Skrzynka: wszystkie osoby + wyszukiwarka + pełna historia ----------
let mailboxQ = '';
let mailboxPerson = null;
const pageInboxUrl = (psid) => `https://business.facebook.com/latest/inbox/all/?asset_id=${encodeURIComponent(status.pageId || '')}&mailbox_id=${encodeURIComponent(status.pageId || '')}&selected_item_id=${encodeURIComponent(psid)}&thread_type=FB_MESSAGE`;

// Podświetla znalezioną frazę (bez względu na wielkość liter i polskie znaki).
const foldStr = (s) => Array.from(String(s || ''), (ch) => {
  if (ch.length !== 1) return ch;
  const c = ch.toLowerCase();
  if (c.length !== 1) return ch;
  return c === 'ł' ? 'l' : c.normalize('NFD')[0];
}).join('');
function highlight(text, q) {
  const t = String(text || '');
  const needle = foldStr(q.trim());
  if (!needle) return esc(t);
  const f = foldStr(t);
  let out = '', i = 0, idx;
  while ((idx = f.indexOf(needle, i)) >= 0) {
    out += esc(t.slice(i, idx)) + `<mark>${esc(t.slice(idx, idx + needle.length))}</mark>`;
    i = idx + needle.length;
  }
  return out + esc(t.slice(i));
}

async function renderMailbox() {
  const focused = document.activeElement?.id === 'mbq';
  const data = await api(`/api/mailbox?q=${encodeURIComponent(mailboxQ)}`);
  const listHtml = data.people.length ? data.people.map((p) => `
    <button class="person" data-psid="${esc(p.sender_id)}">
      <div class="p-top">
        <b class="p-name">${p.nameHit ? highlight(p.name, mailboxQ) : esc(p.name || 'Użytkownik FB')}</b>
        <span class="p-time">${fmtShort(p.last_at)}</span>
      </div>
      ${p.matches?.length ? p.matches.map((m) => `<div class="p-snip">${m.where === 'out' ? '↩︎ ' : m.where === 'post' ? '📰 ' : ''}${highlight(m.text, mailboxQ)}</div>`).join('')
        : `<div class="p-snip muted">${p.last_dir === 'out' ? 'Ty: ' : ''}${esc(String(p.last_text || '').slice(0, 110))}</div>`}
      <div class="p-meta">${p.count} ${p.count === 1 ? 'wiadomość' : p.count < 5 ? 'wiadomości' : 'wiadomości'}${p.pending ? ` · <span class="tag warn">⏳ ${p.pending} do decyzji</span>` : ''}${p.open ? ' · <span class="tag">💬 otwarta rozmowa</span>' : ''}</div>
    </button>`).join('')
    : `<div class="empty">${mailboxQ ? `Nic nie znaleziono dla „${esc(mailboxQ)}”.` : 'Skrzynka jest pusta – pojawią się tu wszystkie osoby, które napiszą do strony.'}</div>`;
  main.innerHTML = `
    <div class="mb-search">
      <input type="search" id="mbq" placeholder="🔍 Szukaj po treści wiadomości lub imieniu i nazwisku…" value="${esc(mailboxQ)}" autocomplete="off">
      <div class="stat">${mailboxQ ? `Znaleziono osób: <b>${data.total}</b>` : `Wszystkie osoby: <b>${data.total}</b> · od najnowszej aktywności`}</div>
    </div>
    <div class="people">${listHtml}</div>`;
  const inp = $('#mbq');
  if (focused) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  let t;
  inp.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { mailboxQ = inp.value; renderMailbox(); }, 300);
  });
  main.onclick = (e) => {
    const b = e.target.closest('.person');
    if (!b) return;
    mailboxPerson = b.dataset.psid;
    window.scrollTo(0, 0);
    renderPerson(mailboxPerson);
  };
}

async function renderPerson(psid) {
  const d = await api(`/api/mailbox/${encodeURIComponent(psid)}`);
  // Tylko opublikowane posty (bez odrzuconych, rozmów itp.).
  const posts = d.submissions.filter((s) => s.status === 'published');
  const subHtml = posts.length ? posts.map((s) => `
    <div class="sub-row">
      <span class="stat">${fmt(s.published_at || s.created_at)}</span> ${postLink(s)}
      <div class="sub-text">${highlight(String(s.final_text || s.original_text || '(tylko zdjęcia)').slice(0, 220), mailboxQ)}</div>
    </div>`).join('') : '<div class="stat">Brak opublikowanych postów.</div>';
  const fbBtn = (link) => link
    ? `<a class="btn primary" href="${esc(link)}" target="_blank" rel="noopener">👤 Otwórz rozmowę na Facebooku</a>`
    : `<a class="btn primary" href="${pageInboxUrl(psid)}" target="_blank" rel="noopener">👤 Otwórz w skrzynce Meta</a>`;
  main.innerHTML = `
    <button class="ghost small back" data-act="back">← Wróć do skrzynki</button>
    <div class="card person-card">
      <div class="top"><h2 style="margin:0">${esc(d.name || 'Użytkownik FB')}</h2>
        <span class="meta-r">${d.messages.length} wiad. · ${posts.length} post${posts.length === 1 ? '' : posts.length > 1 && posts.length < 5 ? 'y' : 'ów'}</span></div>
      <div class="actions" id="fbLinks">${fbBtn(d.fb_link)}</div>
      <div class="stat" id="fbHint">${d.fb_link ? 'Link prowadzi do rozmowy w skrzynce strony – stamtąd jednym kliknięciem przejdziesz na profil tej osoby.' : '<span class="spinner"></span> Szukam rozmowy na Facebooku…'}</div>
    </div>
    <div class="card"><h2>Historia wiadomości</h2>
      <div class="chat full">${d.messages.map((m) => bubble({ ...m, text: m.text }).replace(/<div class="b-text">([\s\S]*?)<\/div>/, (_, inner) => `<div class="b-text">${mailboxQ ? highlight(m.text, mailboxQ) : inner}</div>`)).join('') || '<div class="stat">Brak wiadomości.</div>'}</div>
    </div>
    <div class="card"><h2>Posty tej osoby</h2>${subHtml}</div>`;
  const chat = $('.chat.full', main);
  const firstMark = $('mark', chat);
  requestAnimationFrame(() => { if (firstMark) firstMark.scrollIntoView({ block: 'center' }); else chat.scrollTop = chat.scrollHeight; });
  main.onclick = (e) => {
    const a = e.target.closest('[data-act]');
    if (a?.dataset.act === 'back') { mailboxPerson = null; renderMailbox(); return; }
    if (a?.dataset.act === 'zoom') lightbox(a.dataset.src);
  };
  if (!d.fb_link) {
    try {
      const p = await api(`/api/mailbox/${encodeURIComponent(psid)}/facebook`, { body: {} });
      if (mailboxPerson !== psid) return;
      $('#fbLinks').innerHTML = fbBtn(p?.fb_link);
      $('#fbHint').innerHTML = p?.fb_link ? 'Link prowadzi do rozmowy w skrzynce strony – stamtąd jednym kliknięciem przejdziesz na profil tej osoby.'
        : 'Nie udało się pobrać linku do rozmowy – przycisk otworzy skrzynkę Meta Business Suite.';
      if (p?.name && !d.name) $('.person-card h2').textContent = p.name;
    } catch {
      $('#fbHint').textContent = 'Nie udało się połączyć z Facebookiem – przycisk otworzy skrzynkę Meta Business Suite.';
    }
  }
}

// ---------- Statystyki zgodności AI ----------
const DECISION_LABEL = { publish: '✅ zatwierdzone', reject: '⛔ odrzucone', commercial: '💰 reklama', conversation: '💬 rozmowa', handled: '✋ obsłużone' };
const VERDICT_SHORT = { publish: '✅ Do publikacji', needs_edit: '✏️ Wymaga poprawek', reject: '⛔ Odrzucić', commercial: '💰 Komercyjne', conversation: '💬 Rozmowa', manual_check: '👀 Sprawdź ręcznie' };
function renderStats(st) {
  if (!st.withAi) return `<div class="stat">Brak danych z ostatnich ${st.days} dni. Statystyki pojawią się po pierwszych decyzjach podjętych od dziś.</div>`;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
  const cols = Object.keys(DECISION_LABEL);
  const rows = Object.keys(VERDICT_SHORT).filter((v) => st.matrix[v]);
  const t = st.auto.textOnly;
  const cats = Object.entries(st.disagreeByCat).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return `
    <div class="kpis">
      <div class="kpi"><div class="kpi-v">${st.agreePct != null ? st.agreePct + '%' : '–'}</div><div class="kpi-l">zgodności (${st.agree} z ${st.judged})</div></div>
      <div class="kpi"><div class="kpi-v">${st.withAi}</div><div class="kpi-l">decyzji z oceną AI</div></div>
      <div class="kpi"><div class="kpi-v">${st.preset.pairs ? pct(st.preset.agree, st.preset.pairs) : '–'}</div><div class="kpi-l">trafnych podpowiedzi szablonu</div></div>
    </div>
    <div class="label">AI proponowało → Ty zrobiłeś</div>
    <div class="table-wrap"><table class="matrix">
      <tr><th></th>${cols.map((c) => `<th>${DECISION_LABEL[c]}</th>`).join('')}</tr>
      ${rows.map((v) => `<tr><th>${VERDICT_SHORT[v]}</th>${cols.map((c) => {
        const n = st.matrix[v][c] || 0;
        const good = { publish: ['publish'], needs_edit: ['publish'], reject: ['reject'], commercial: ['commercial'], conversation: ['conversation', 'handled'] }[v]?.includes(c);
        return `<td class="${n ? (good ? 'ok' : v === 'manual_check' ? '' : 'bad') : 'zero'}">${n || '·'}</td>`;
      }).join('')}</tr>`).join('')}
    </table></div>
    <div class="label">Gdyby automat publikował sam „✅ Do publikacji” bez zdjęć</div>
    <div class="stat">${t.total ? `<b>${t.total}</b> takich wiadomości: <b>${t.ok}</b> zatwierdziłeś bez zmian (${pct(t.ok, t.total)}), <b>${t.edited}</b> poprawiałeś tekst, <b>${t.wrong}</b> ${t.wrong === 1 ? 'nie przeszła' : 'nie przeszło'} (byłby błąd automatu).` : 'Jeszcze brak takich wiadomości.'}
      ${st.auto.withImages.total ? `<br>Ze zdjęciami: ${st.auto.withImages.total}, z czego bez żadnych poprawek: ${st.auto.withImages.ok}.` : ''}</div>
    ${cats.length ? `<div class="label">Najczęstsze rozbieżności – kategorie</div><div class="stat">${cats.map(([k, n]) => `${esc(CATEGORY[k] || k)}: <b>${n}</b>`).join(' · ')}</div>` : ''}
    ${st.manualCheck ? `<div class="stat" style="margin-top:6px">„👀 Sprawdź ręcznie” (nie liczone do zgodności): ${st.manualCheck}</div>` : ''}`;
}

// ---------- Pozostałe listy ----------
function renderList(items) {
  const head = tab === 'queued' && settingsCache
    ? `<div class="card stat">Odstęp między postami: <b>${esc(settingsCache.interval_minutes)} min</b>
       <button class="ghost small" id="reflow" style="float:right">Przelicz kolejkę</button></div>`
    : tab === 'rejected' && items.length
      ? `<div class="card list-head"><span class="stat">Odrzucone i obsłużone: <b>${items.length}</b> · trzymane na serwerze maks. 180 dni</span>
         <button class="btn danger small" id="clearRejected">🗑 Wyczyść odrzucone</button></div>` : '';
  if (!items.length) {
    const msg = { queued: 'Kolejka jest pusta.', published: 'Nic jeszcze nie opublikowano.', commercial: 'Brak zgłoszeń komercyjnych.', rejected: 'Brak odrzuconych.', failed: 'Brak błędów.' }[tab];
    main.innerHTML = head + `<div class="empty">${msg}</div>`;
  } else {
    main.innerHTML = head + items.map(listCard).join('');
  }
  $('#reflow')?.addEventListener('click', async () => { await api('/api/queue/reflow', { body: {} }); toast('Przeliczono kolejkę'); render(); });
  $('#clearRejected')?.addEventListener('click', (e) => {
    if (!confirm(`Usunąć na stałe ${items.length} odrzuconych wiadomości razem ze zdjęciami i historią?\n\nTego nie da się cofnąć.`)) return;
    act1(e.target, async () => {
      const r = await api('/api/submissions/clear-rejected', { body: {} });
      toast(`🗑 Usunięto ${r.deleted} odrzuconych wiadomości`);
      await refreshStatus();
      render();
    });
  });
  main.onclick = async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const id = a.closest('[data-id]').dataset.id;
    const map = { restore: 'restore', now: 'publish-now' };
    const card = a.closest('[data-id]');
    if (a.dataset.act === 'edit-pub') {
      const s = items.find((x) => String(x.id) === id);
      $('.edit-slot', card).innerHTML = `<div class="sub-panel">
        <div class="label"><span>Treść posta – po zapisaniu zmieni się na Facebooku</span></div>
        <textarea class="msg">${esc(s.final_text || '')}</textarea>
        <div class="row"><button class="btn primary grow" data-act="edit-pub-go">💾 Zapisz poprawkę</button><button class="btn" data-act="edit-cancel">Anuluj</button></div></div>`;
      return;
    }
    if (a.dataset.act === 'edit-cancel') { $('.edit-slot', card).innerHTML = ''; return; }
    if (a.dataset.act === 'edit-pub-go') {
      return act1(a, async () => {
        await api(`/api/submissions/${id}/edit-published`, { body: { text: $('.msg', card).value } });
        toast('✏️ Post poprawiony na Facebooku');
        render();
      });
    }
    await act1(a, async () => {
      if (a.dataset.act === 'retry') {
        const s = items.find((x) => String(x.id) === id);
        await api(`/api/submissions/${id}/approve`, { body: { text: s.final_text, images: s.final_images || [], now: true } });
      } else {
        await api(`/api/submissions/${id}/${map[a.dataset.act]}`, { body: {} });
      }
      toast({ restore: 'Przywrócono do „Do decyzji”', now: 'Publikuję w ciągu kilkunastu sekund', retry: 'Ponawiam publikację' }[a.dataset.act]);
      await refreshStatus();
      render();
    });
  };
}

function listCard(s) {
  const imgs = (s.final_images && s.final_images.length ? s.final_images : (s.attachments || []).filter((a) => a.type === 'image' && a.file).map((a) => a.file));
  const text = ['queued', 'published', 'failed'].includes(tab) ? s.final_text : s.original_text;
  let meta = '', actions = '';
  if (tab === 'queued') {
    meta = `<span class="when">🕒 ${s.status === 'publishing' ? 'publikuję…' : fmt(s.scheduled_at)}</span>`;
    actions = `<button class="btn" data-act="now">🚀 Opublikuj teraz</button><button class="btn" data-act="restore">↩︎ Cofnij do decyzji</button>`;
  } else if (tab === 'published') {
    const link = s.fb_post_id && !s.fb_post_id.startsWith('DEMO') ? `<a href="https://www.facebook.com/${esc(s.fb_post_id)}" target="_blank" rel="noopener">zobacz na FB ↗</a>` : '<span>(tryb demo – nie wysłano na FB)</span>';
    meta = `<span>Opublikowano ${fmt(s.published_at)}</span>${link}${s.reply_sent ? `<span>· ${esc(s.reply_sent)}</span>` : ''}`;
    actions = '<button class="btn" data-act="edit-pub">✏️ Popraw post</button>';
  } else if (tab === 'failed') {
    meta = `<span class="error-text">${esc(s.publish_error)}</span>`;
    actions = `<button class="btn primary" data-act="retry">Ponów publikację</button><button class="btn" data-act="restore">↩︎ Cofnij do decyzji</button>`;
  } else {
    meta = `<span>${s.status === 'handled' ? 'Obsłużone ręcznie' : s.status === 'commercial' ? 'Komercyjne' : 'Odrzucone'} ${fmt(s.decided_at)}</span>${s.reply_sent ? `<span>Wiadomość: ${esc(s.reply_sent)}</span>` : ''}`;
    actions = `<button class="btn" data-act="restore">↩︎ Przywróć do decyzji</button>`;
  }
  return `<div class="card" data-id="${s.id}">
    <div class="meta"><b>#${s.id}</b><span>${esc(s.sender_name || '')}</span>${meta}</div>
    <div class="post-text">${esc(text || '(bez tekstu)')}</div>
    ${imgs.length ? `<div class="thumbs">${imgs.map((f) => `<img src="/media/${esc(f)}" alt="">`).join('')}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    <div class="edit-slot"></div>
  </div>`;
}

// ---------- Ustawienia ----------
async function renderSettings() {
  const s = settingsCache = await api('/api/settings');
  main.innerHTML = `
    <div class="card">
      <h2>Stan systemu</h2>
      <div class="stat">Facebook: <b>${status.fb ? 'połączony ✅' : 'niepodłączony (tryb demo – posty nie trafiają na FB)'}</b></div>
      <div class="stat">AI: <b>${status.ai ? esc(status.model) + ' ✅' : 'brak klucza Anthropic (tryb demo – prosta ocena słownikowa)'}</b></div>
      <div class="stat">Koszt AI w ostatnich 30 dniach: <b>${(status.cost30d || 0).toFixed(2)} $</b> za ${status.count30d} zgłoszeń
        ${status.count30d ? `(średnio ${((status.cost30d || 0) / status.count30d * 100).toFixed(2)} centa)` : ''}</div>
      <div class="actions"><button class="btn" id="fbcheck">Sprawdź połączenie z Facebookiem</button></div>
      <div id="fbresult"></div>
    </div>
    <div class="card" id="statsCard">
      <h2>📊 Zgodność AI z Twoimi decyzjami</h2>
      <div class="stat">Panel anonimowo zapisuje, co proponowało AI, a co Ty zdecydowałeś (bez treści i danych osób). Po kilku tygodniach zobaczysz, czy automatyczna publikacja ma sens.</div>
      <div class="row" style="display:flex;gap:6px;margin:10px 0">
        ${[7, 30, 90].map((d) => `<button class="chip-btn" data-days="${d}">${d} dni</button>`).join('')}
      </div>
      <div id="statsBody"><span class="spinner"></span></div>
    </div>
    <div class="card">
      <h2>Publikowanie</h2>
      <div class="label">Odstęp między postami (minuty) – posty wychodzą o każdej porze, także w nocy</div>
      <input type="number" min="1" id="interval" value="${esc(s.interval_minutes)}" style="max-width:160px">
    </div>
    <div class="card">
      <h2>Rozmowy</h2>
      <label class="row" style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
        <input type="checkbox" id="smart" ${s.smart_routing === '1' ? 'checked' : ''} style="margin-top:4px">
        <span><b>Inteligentne rozmowy</b><br><span class="stat">Włączone: wiadomości w ciągu 24 h po decyzji AI rozdziela samo – „dzięki” nigdzie nie trafia, pytania idą do „Rozmów”, a otwarta rozmowa zbiera kolejne wiadomości. Wyłączone: <b>każda wiadomość od razu trafia do „Do decyzji”</b>.</span></span>
      </label>
    </div>
    <div class="card">
      <h2>Zasady strony dla AI</h2>
      <div class="stat">AI bierze je pod uwagę przy każdej ocenie. Pisz zwykłym językiem.</div>
      <textarea id="rules" style="min-height:200px">${esc(s.page_rules)}</textarea>
    </div>
    <div class="card">
      <h2>Szybkie odpowiedzi</h2>
      <div class="stat">Gotowe wiadomości do wysłania jednym dotknięciem. <b>Kiedy pasuje</b> to wskazówka dla AI – na tej podstawie podpowie ⭐ odpowiedni szablon. Szablon „Odrzucenie” wysyła przycisk ⛔ Odrzuć, a „Reklama” – przycisk 💰 Reklama.</div>
      <div id="presets"></div>
      <div class="actions"><button class="btn" id="addPreset">➕ Dodaj szablon</button></div>
    </div>
    <div class="card">
      <h2>Podziękowanie po publikacji</h2>
      <div class="label"><span>Podziękowanie po publikacji – wysyłane, gdy post wyjdzie z kolejki na stronę. Znacznik <b>{link}</b> zamieni się w link do posta. Puste = nie wysyłaj.</span></div><textarea id="tpub">${esc(s.template_published)}</textarea>
      <div class="label">Podgląd – tak zobaczy to autor na Messengerze:</div>
      <div class="msgr"><div class="msgr-head">Spotted Koszalin</div><div class="bubble" id="tpubPreview"></div></div>
      <div class="actions"><button class="btn primary" id="save">Zapisz ustawienia</button></div>
    </div>
    <div class="card">
      <h2>Testowa wiadomość</h2>
      <div class="stat">Udaje wiadomość od użytkownika – przydatne zanim podłączymy Facebooka.</div>
      <textarea id="ttext" placeholder="Treść wiadomości…"></textarea>
      <div class="label">Zdjęcia (opcjonalnie)</div><input type="file" id="tfiles" accept="image/jpeg,image/png,image/webp,image/gif" multiple>
      <div class="actions">
        <button class="btn primary" id="tsend">Wyślij do skrzynki</button>
        <button class="btn" id="seed">Dodaj 8 przykładowych wiadomości</button>
      </div>
    </div>`;
  const previewPub = () => {
    const link = 'https://www.facebook.com/spottedkoszalin/posts/pfbid02Xk…';
    let t = $('#tpub').value.trim();
    if (t && !t.includes('{link}')) { const [first, ...rest] = t.split('\n'); t = [first, `Zobacz: {link}`, ...rest].join('\n'); }
    $('#tpubPreview').innerHTML = t
      ? esc(t).replaceAll('{link}', `<a>${link}</a>`).replace(/(https:\/\/buycoffee\.to\/\S+)/g, '<a>$1</a>')
      : '<i>(wyłączone – nic nie zostanie wysłane)</i>';
  };
  $('#tpub').addEventListener('input', previewPub);
  previewPub();
  const presetRow = (p) => `<details class="preset" data-id="${esc(p.id || '')}" ${p.id ? '' : 'open'}>
    <summary><b class="p-title">${esc(p.name || 'Nowy szablon')}</b> <span class="stat">· ${esc(PRESET_ACTION_LABEL[p.action] || '')}</span></summary>
    <div class="grid2">
      <div><div class="label">Nazwa (na przycisku)</div><input type="text" class="p-name" value="${esc(p.name || '')}" maxlength="40"></div>
      <div><div class="label">Co zrobić z wiadomością po wysłaniu</div>
        <select class="p-action">${Object.entries(PRESET_ACTION_LABEL).map(([v, l]) => `<option value="${v}" ${p.action === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="label">Kiedy pasuje (podpowiedź dla AI)</div><textarea class="p-trigger" rows="2">${esc(p.trigger || '')}</textarea>
    <div class="label">Treść wiadomości</div><textarea class="p-text">${esc(p.text || '')}</textarea>
    <div class="actions"><button class="btn danger small" data-del-preset>🗑 Usuń szablon</button></div>
  </details>`;
  $('#presets').innerHTML = (s.presets_list || []).map(presetRow).join('');
  $('#presets').addEventListener('input', (e) => {
    const el = e.target.closest('.preset');
    if (e.target.classList.contains('p-name')) $('.p-title', el).textContent = e.target.value || 'Nowy szablon';
  });
  $('#presets').addEventListener('click', (e) => {
    if (!e.target.closest('[data-del-preset]')) return;
    e.preventDefault();
    const el = e.target.closest('.preset');
    if (confirm(`Usunąć szablon „${$('.p-name', el).value}”? (zmiana zapisze się po „Zapisz ustawienia”)`)) el.remove();
  });
  $('#addPreset').onclick = () => {
    $('#presets').insertAdjacentHTML('beforeend', presetRow({ name: '', action: 'reject', trigger: '', text: '' }));
    $('#presets .preset:last-child .p-name').focus();
  };
  const loadStats = async (days = 30) => {
    document.querySelectorAll('#statsCard [data-days]').forEach((b) => b.classList.toggle('sugg', Number(b.dataset.days) === days));
    const st = await api(`/api/stats?days=${days}`);
    $('#statsBody').innerHTML = renderStats(st);
  };
  $('#statsCard').addEventListener('click', (e) => { const b = e.target.closest('[data-days]'); if (b) loadStats(Number(b.dataset.days)); });
  loadStats(30).catch(() => { $('#statsBody').textContent = 'Nie udało się wczytać statystyk.'; });
  $('#fbcheck').onclick = (e) => act1(e.target, async () => {
    const d = await api('/api/fb-check');
    const ok = (b) => (b ? '✅' : '❌');
    const rows = [];
    if (d.error) rows.push(`❌ ${esc(d.error)}`);
    if (d.tokenOwner) rows.push(`${ok(d.tokenMatchesPage)} Token należy do: <b>${esc(d.tokenOwner.name)}</b> (${esc(d.tokenOwner.id)})${d.tokenMatchesPage ? '' : ` – a FB_PAGE_ID to ${esc(d.pageIdConfigured)}!`}`);
    if (d.tokenOwnerError) rows.push(`❌ Token: ${esc(d.tokenOwnerError)}`);
    if (d.app) rows.push(`Aplikacja: <b>${esc(d.app.name)}</b> (${esc(d.app.id)})`);
    if (d.tokenType) rows.push(`Typ tokenu: <b>${esc(d.tokenType)}</b> · ważny: ${ok(d.valid)} · wygasa: ${esc(d.expires)}`);
    if (d.scopes) rows.push(`Uprawnienia: ${d.scopes.map(esc).join(', ') || '(brak)'}`);
    if (d.missingScopes) rows.push(d.missingScopes.length ? `❌ <b>Brakuje:</b> ${d.missingScopes.map(esc).join(', ')}` : '✅ Wszystkie potrzebne uprawnienia są');
    if (d.debugError || d.appError) rows.push(`⚠️ ${esc(d.debugError || d.appError)}`);
    rows.push(`App Secret: ${ok(d.appSecretConfigured)} · Verify token: ${ok(d.verifyTokenConfigured)}`);
    if (d.testCalls?.length) {
      rows.push('<b>Testowe wywołania API (do App Review):</b>');
      for (const t of d.testCalls) rows.push(`${ok(t.ok)} ${esc(t.label)}${t.ok ? '' : ` – ${esc(t.error)}`}`);
    }
    $('#fbresult').innerHTML = `<div class="sub-panel stat">${rows.map((r) => `<div>${r}</div>`).join('')}</div>`;
  });
  $('#save').onclick = (e) => act1(e.target, async () => {
    settingsCache = await api('/api/settings', { method: 'PUT', body: {
      interval_minutes: $('#interval').value,
      page_rules: $('#rules').value,
      smart_routing: $('#smart').checked ? '1' : '0',
      template_published: $('#tpub').value,
      presets: [...document.querySelectorAll('#presets .preset')].map((el) => ({
        id: el.dataset.id, name: $('.p-name', el).value.trim(), action: $('.p-action', el).value,
        trigger: $('.p-trigger', el).value.trim(), text: $('.p-text', el).value,
      })),
    } });
    toast('Zapisano');
  });
  $('#tsend').onclick = (e) => act1(e.target, async () => {
    const files = [...$('#tfiles').files];
    const images = await Promise.all(files.map((f) => new Promise((ok, bad) => {
      const r = new FileReader();
      r.onload = () => ok({ mime: f.type, data: String(r.result).split(',')[1] });
      r.onerror = bad;
      r.readAsDataURL(f);
    })));
    await api('/api/test-message', { body: { text: $('#ttext').value, images } });
    $('#ttext').value = ''; $('#tfiles').value = '';
    toast('Dodano – zobacz w „Do decyzji”');
    refreshStatus();
  });
  $('#seed').onclick = (e) => act1(e.target, async () => {
    await api('/api/demo-seed', { body: {} });
    toast('Dodano przykładowe wiadomości');
    refreshStatus();
  });
}

// ---------- Automatyczne odświeżanie ----------
async function tick() {
  try {
    await refreshStatus();
    if (isInboxTab()) render();
  } catch { /* chwilowy brak połączenia */ }
}

(async () => {
  await refreshStatus().catch(() => {});
  // Szablony muszą być znane przed pierwszym narysowaniem kart.
  settingsCache = await api('/api/settings').catch(() => null);
  render();
  setInterval(tick, 8000);
})();
