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
    ${s.has_video ? '<div class="notice">🎬 Jest wideo – obejrzyj w skrzynce FB, wrzuć ręcznie i daj ⋯ → „Obsłużone ręcznie”.</div>' : ''}
    ${otherAtt.length ? `<div class="notice info">Inne załączniki (${otherAtt.map((a) => esc(a.type)).join(', ')}) – sprawdź w skrzynce FB.</div>` : ''}
    ${images.length ? `<div class="thumbs-row">${images.map((img, i) => {
      const n = notes.get(i + 1);
      const on = !n || n.ok_to_publish !== false;
      return `<div class="thumb${on ? '' : ' off'}" data-img="${esc(img.file)}" data-on="${on ? 1 : 0}" title="Dotknij, aby dodać/usunąć z posta">
        <img src="/media/${esc(img.file)}" alt="zdjęcie ${i + 1}" loading="lazy">
        <span class="tick">${on ? '✓' : '✕'}</span><span class="num">${i + 1}</span>
        ${n?.needs_anonymization ? '<span class="warn">⚠️</span>' : ''}
        <button class="zoom" data-act="zoom" data-src="/media/${esc(img.file)}" aria-label="Powiększ">⤢</button>
      </div>`;
    }).join('')}</div>
    ${hideNotes.length ? `<div class="img-notes">⚠️ Zakryj: ${groupNotes(hideNotes)}</div>` : ''}` : ''}
    <div class="post" data-act="edit" title="Dotknij, aby edytować">${suggested ? esc(suggested) : '<i>(bez tekstu)</i>'}</div>
    <textarea class="post-edit" hidden>${esc(suggested)}</textarea>
    ${changed ? `<details class="orig"><summary>Oryginał (AI poprawiło tekst)</summary><div class="original">${esc(s.original_text || '(bez tekstu)')}</div><a data-act="use-original">↩︎ wstaw oryginał</a></details>` : ''}
    ${verdict === 'conversation' ? `
    <div class="decide">
      <a class="btn primary grow" href="${inboxUrl()}" target="_blank" rel="noopener">💬 Odpowiedz</a>
      <button class="btn" data-act="handled" title="Odpisałem – usuń z listy">✋ Obsłużone</button>
      <button class="btn icon" data-act="more" title="Więcej opcji">⋯</button>
    </div>` : `
    <div class="decide">
      <button class="btn primary grow" data-act="approve">✅ Zatwierdź</button>
      <button class="btn icon danger" data-act="reject-quick" title="Odrzuć (z wiadomością z szablonu)">⛔</button>
      <button class="btn icon money" data-act="commercial" title="Komercyjne – oferta reklamy">💰</button>
      <button class="btn icon" data-act="more" title="Więcej opcji">⋯</button>
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
    if (e.target.closest('.zoom')) return;
    const on = t.dataset.on !== '1';
    t.dataset.on = on ? '1' : '0';
    t.classList.toggle('off', !on);
    $('.tick', t).textContent = on ? '✓' : '✕';
    c.dirty = true;
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
    if (act === 'reject-quick') {
      const st = settingsCache || (settingsCache = await api('/api/settings'));
      return decide(a, 'reject', { message: st.template_reject }, (r) => `⛔ Odrzucono${r.reply === 'wysłano' ? ' · wysłano wiadomość' : ''}`);
    }
    if (act === 'commercial' || act === 'reject') {
      const st = settingsCache || (settingsCache = await api('/api/settings'));
      const isCom = act === 'commercial';
      const canReply = s.source === 'facebook';
      const msg = isCom ? st.template_commercial : `${st.template_reject}\n\nPowód: `;
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
        ${verdict === 'conversation' ? '<button class="btn" data-act="approve">✅ To jednak post – zatwierdź do kolejki</button>' : ''}
        <button class="btn" data-act="reject">⛔ Odrzuć z powodem</button>
        <button class="btn" data-act="approve-now">🚀 Opublikuj od razu (bez kolejki)</button>
        <button class="btn" data-act="edit">✏️ Edytuj tekst</button>
        <button class="btn" data-act="handled">✋ Obsłużone ręcznie</button>
        <button class="btn" data-act="reanalyze">🔄 Oceń ponownie AI</button></div>`;
      return;
    }
    if (act === 'handled') return decide(a, 'handled', {}, '✋ Oznaczono jako obsłużone');
    if (act === 'reanalyze') {
      await act1(a, async () => { await api(`/api/submissions/${s.id}/reanalyze`, { body: {} }); c.dirty = false; toast('🔄 AI oceni ponownie'); tick(); });
    }
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
  const label = m.direction === 'out' && KIND_LABEL[m.kind] ? `<div class="b-label">${KIND_LABEL[m.kind]}</div>` : '';
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
    ${canReply ? '<textarea class="reply" rows="2" placeholder="Napisz odpowiedź…"></textarea>' : '<div class="notice info">Minęło 24 h od ostatniej wiadomości – Facebook pozwala odpisać już tylko ze skrzynki strony.</div>'}
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

// ---------- Pozostałe listy ----------
function renderList(items) {
  const head = tab === 'queued' && settingsCache
    ? `<div class="card stat">Odstęp między postami: <b>${esc(settingsCache.interval_minutes)} min</b> · cisza nocna: <b>${esc(settingsCache.quiet_from)}–${esc(settingsCache.quiet_to)}</b>
       <button class="ghost small" id="reflow" style="float:right">Przelicz kolejkę</button></div>` : '';
  if (!items.length) {
    const msg = { queued: 'Kolejka jest pusta.', published: 'Nic jeszcze nie opublikowano.', commercial: 'Brak zgłoszeń komercyjnych.', rejected: 'Brak odrzuconych.', failed: 'Brak błędów.' }[tab];
    main.innerHTML = head + `<div class="empty">${msg}</div>`;
  } else {
    main.innerHTML = head + items.map(listCard).join('');
  }
  $('#reflow')?.addEventListener('click', async () => { await api('/api/queue/reflow', { body: {} }); toast('Przeliczono kolejkę'); render(); });
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
    <div class="card">
      <h2>Publikowanie</h2>
      <div class="grid2">
        <div><div class="label">Odstęp między postami (minuty)</div><input type="number" min="1" id="interval" value="${esc(s.interval_minutes)}"></div>
        <div><div class="label">Cisza nocna (bez publikacji)</div>
          <div style="display:flex;gap:8px;align-items:center"><input type="time" id="qfrom" value="${esc(s.quiet_from)}"> – <input type="time" id="qto" value="${esc(s.quiet_to)}"></div></div>
      </div>
    </div>
    <div class="card">
      <h2>Zasady strony dla AI</h2>
      <div class="stat">AI bierze je pod uwagę przy każdej ocenie. Pisz zwykłym językiem.</div>
      <textarea id="rules" style="min-height:200px">${esc(s.page_rules)}</textarea>
    </div>
    <div class="card">
      <h2>Szablony wiadomości</h2>
      <div class="label">Odpowiedź na treść komercyjną</div><textarea id="tcom">${esc(s.template_commercial)}</textarea>
      <div class="label">Odpowiedź przy odrzuceniu (wysyłana od razu po kliknięciu „Odrzuć”; przy „Odrzuć + dlaczego” dopisujesz powód)</div><textarea id="trej">${esc(s.template_reject)}</textarea>
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
    $('#fbresult').innerHTML = `<div class="sub-panel stat">${rows.map((r) => `<div>${r}</div>`).join('')}</div>`;
  });
  $('#save').onclick = (e) => act1(e.target, async () => {
    settingsCache = await api('/api/settings', { method: 'PUT', body: {
      interval_minutes: $('#interval').value, quiet_from: $('#qfrom').value, quiet_to: $('#qto').value,
      page_rules: $('#rules').value, template_commercial: $('#tcom').value, template_reject: $('#trej').value,
      template_published: $('#tpub').value,
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
  api('/api/settings').then((s) => { settingsCache = s; }).catch(() => {});
  render();
  setInterval(tick, 8000);
})();
