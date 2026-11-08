// Panel moderacji – logika w przeglądarce.
const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');
let tab = 'new';
let status = {};
let settingsCache = null;
const cards = new Map(); // id -> { el, sig, dirty }

const VERDICT = {
  publish: '✅ Do publikacji', needs_edit: '✏️ Wymaga poprawek', commercial: '💰 Komercyjne',
  reject: '⛔ Odrzucić', manual_check: '👀 Sprawdź ręcznie',
};
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

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3000);
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
  main.innerHTML = '';
  render();
});

async function render() {
  try {
    if (tab === 'settings') return renderSettings();
    const items = await api(`/api/submissions?status=${tab}`);
    if (tab === 'new') return renderInbox(items);
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
    main.innerHTML = `<div class="empty">Brak nowych wiadomości 🎉<br><small>Nowe pojawią się tu automatycznie.</small></div>`;
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
  if (left <= 0) return '<span class="timer late">⏱ minęło 24 h – nie da się już odpisać</span>';
  const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
  return `<span class="timer${h < 3 ? ' late' : ''}">⏱ na odpowiedź: ${h} h ${m} min</span>`;
}

function fillCard(c, s) {
  const el = c.el;
  const ai = s.ai_result;
  const images = (s.attachments || []).filter((a) => a.type === 'image' && a.file);
  const otherAtt = (s.attachments || []).filter((a) => a.type !== 'image');
  const aiPending = s.ai_status === 'pending' || s.ai_status === 'running';
  const verdict = aiPending ? 'pending' : s.ai_status === 'error' ? 'error' : ai?.verdict || 'manual_check';
  const verdictLabel = aiPending ? '<span class="spinner"></span> AI ocenia…' : s.ai_status === 'error' ? '⚠️ Błąd oceny AI' : VERDICT[verdict];
  const suggested = ai && ai.suggested_text ? ai.suggested_text : s.original_text;
  const notes = new Map((ai?.image_notes || []).map((n) => [n.image_number, n]));

  el.innerHTML = `
    <div class="meta">
      <b>#${s.id}</b><span>${esc(s.sender_name || (s.source === 'facebook' ? 'Użytkownik FB' : s.source))}</span>
      <span>${fmt(s.created_at)}</span>${windowLeft(s)}
    </div>
    <div class="ai">
      <span class="badge v-${verdict}">${verdictLabel}</span>
      ${ai?.category ? `<span class="stat"> · ${esc(CATEGORY[ai.category] || ai.category)}</span>` : ''}
      ${ai?.summary && !aiPending ? `<div class="summary">${esc(ai.summary)}</div>` : ''}
      ${s.ai_status === 'error' ? `<div class="error-text">${esc(s.ai_error)}</div>` : ''}
      ${ai?.commercial_reason && !aiPending ? `<div class="stat">💰 ${esc(ai.commercial_reason)}</div>` : ''}
      ${ai?.issues?.length && !aiPending ? `<ul class="issues">${ai.issues.map((i) =>
        `<li class="sev-${esc(i.severity)}"><b>${esc(ISSUE[i.type] || i.type)}</b> – ${esc(i.description)}</li>`).join('')}</ul>` : ''}
    </div>
    ${s.has_video ? '<div class="notice">🎬 Wiadomość zawiera wideo – obejrzyj je w skrzynce na Facebooku. Panel nie publikuje filmów: wrzuć je ręcznie i kliknij „Obsłużone ręcznie”.</div>' : ''}
    ${otherAtt.filter((a) => a.type !== 'video').length ? `<div class="notice info">Inne załączniki: ${otherAtt.filter((a) => a.type !== 'video').map((a) => esc(a.type)).join(', ')} – sprawdź w skrzynce FB.</div>` : ''}
    ${images.length ? `<div class="images">${images.map((img, i) => {
      const n = notes.get(i + 1);
      const on = !n || n.ok_to_publish !== false;
      return `<div class="img${on ? '' : ' off'}">
        <img src="/media/${esc(img.file)}" alt="zdjęcie ${i + 1}" loading="lazy" data-full="/media/${esc(img.file)}">
        <label><input type="checkbox" data-img="${esc(img.file)}" ${on ? 'checked' : ''}> Zdjęcie ${i + 1} w poście</label>
        ${n?.needs_anonymization || n?.what_to_hide ? `<div class="note">⚠️ Zakryj: ${esc(n.what_to_hide || 'sprawdź')}</div>` : ''}
      </div>`;
    }).join('')}</div>
      ${[...notes.values()].some((n) => n.needs_anonymization) ? '<div class="notice">Na razie zakrywanie robisz ręcznie (np. w Zdjęciach na Macu) – narzędzie do zamazywania dodamy w kolejnym etapie. Możesz też odznaczyć zdjęcie, żeby nie weszło do posta.</div>' : ''}` : ''}
    <details ${ai?.suggested_text && ai.suggested_text !== s.original_text ? '' : 'open'}>
      <summary>Oryginalna wiadomość</summary>
      <div class="original">${esc(s.original_text || '(bez tekstu)')}</div>
    </details>
    <div class="label"><span>Treść posta${ai?.suggested_text && ai.suggested_text !== s.original_text ? ' (propozycja AI – możesz edytować)' : ''}</span>
      <span><a data-act="use-original">wstaw oryginał</a>${ai?.suggested_text ? ' · <a data-act="use-ai">wstaw propozycję AI</a>' : ''}</span></div>
    <textarea>${esc(suggested)}</textarea>
    <div class="actions">
      <button class="btn primary" data-act="approve">✅ Zatwierdź do kolejki</button>
      <button class="btn money" data-act="commercial">💰 Komercyjne</button>
      <button class="btn danger" data-act="reject">⛔ Odrzuć</button>
      <button class="btn" data-act="more">⋯</button>
    </div>
    <div class="sub-slot"></div>`;

  const ta = $('textarea', el);
  ta.addEventListener('input', () => { c.dirty = true; });
  el.querySelectorAll('input[data-img]').forEach((cb) => cb.addEventListener('change', () => {
    c.dirty = true;
    cb.closest('.img').classList.toggle('off', !cb.checked);
  }));
  el.querySelectorAll('img[data-full]').forEach((img) => img.addEventListener('click', () => window.open(img.dataset.full, '_blank')));
  const slot = $('.sub-slot', el);

  el.onclick = async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act;
    if (act === 'use-original') { ta.value = s.original_text; c.dirty = true; return; }
    if (act === 'use-ai') { ta.value = ai.suggested_text; c.dirty = true; return; }
    if (act === 'approve') {
      const imgs = [...el.querySelectorAll('input[data-img]:checked')].map((x) => x.dataset.img);
      await act1(a, async () => {
        const r = await api(`/api/submissions/${s.id}/approve`, { body: { text: ta.value, images: imgs } });
        toast(`Zaplanowano na ${fmtTime(r.scheduled_at)}`);
        removeCard(s.id);
      });
      return;
    }
    if (act === 'commercial' || act === 'reject') {
      const st = settingsCache || (settingsCache = await api('/api/settings'));
      const isCom = act === 'commercial';
      const canReply = s.source === 'facebook';
      slot.innerHTML = `<div class="sub-panel">
        <div class="label"><span>${isCom ? 'Wiadomość do autora (oferta reklamy)' : 'Wiadomość do autora (opcjonalnie)'}</span></div>
        <label class="row"><input type="checkbox" class="send" ${isCom && canReply ? 'checked' : ''} ${canReply ? '' : 'disabled'}>
          Wyślij wiadomość na Messengerze${canReply ? '' : ' (niedostępne – to nie jest wiadomość z FB)'}</label>
        <textarea class="msg">${esc(isCom ? st.template_commercial : st.template_reject)}</textarea>
        <div class="row">
          <button class="btn ${isCom ? 'money' : 'danger'}" data-act="${isCom ? 'commercial-go' : 'reject-go'}">${isCom ? 'Oznacz jako komercyjne' : 'Odrzuć'}</button>
          <button class="btn" data-act="cancel">Anuluj</button>
        </div></div>`;
      return;
    }
    if (act === 'commercial-go' || act === 'reject-go') {
      const send = $('.send', slot).checked;
      const message = send ? $('.msg', slot).value : '';
      await act1(a, async () => {
        const r = await api(`/api/submissions/${s.id}/${act === 'commercial-go' ? 'commercial' : 'reject'}`, { body: { message } });
        toast(act === 'commercial-go' ? `Oznaczono jako komercyjne${r.reply ? ' · wiadomość: ' + r.reply : ''}` : `Odrzucono${r.reply ? ' · wiadomość: ' + r.reply : ''}`);
        removeCard(s.id);
      });
      return;
    }
    if (act === 'cancel') { slot.innerHTML = ''; return; }
    if (act === 'more') {
      slot.innerHTML = `<div class="sub-panel"><div class="row">
        <button class="btn" data-act="handled">Obsłużone ręcznie</button>
        <button class="btn" data-act="reanalyze">🔄 Oceń ponownie AI</button>
        <button class="btn" data-act="approve-now">🚀 Opublikuj od razu (pomiń kolejkę)</button>
        <button class="btn" data-act="cancel">Zamknij</button></div></div>`;
      return;
    }
    if (act === 'handled') {
      await act1(a, async () => { await api(`/api/submissions/${s.id}/handled`, { body: {} }); toast('Oznaczono jako obsłużone'); removeCard(s.id); });
      return;
    }
    if (act === 'reanalyze') {
      await act1(a, async () => { await api(`/api/submissions/${s.id}/reanalyze`, { body: {} }); c.dirty = false; toast('AI oceni ponownie'); tick(); });
      return;
    }
    if (act === 'approve-now') {
      const imgs = [...el.querySelectorAll('input[data-img]:checked')].map((x) => x.dataset.img);
      await act1(a, async () => {
        await api(`/api/submissions/${s.id}/approve`, { body: { text: ta.value, images: imgs, now: true } });
        toast('Publikuję w ciągu kilkunastu sekund');
        removeCard(s.id);
      });
    }
  };
}

async function act1(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (err) { toast(err.message); } finally { btn.disabled = false; }
}

function removeCard(id) {
  const c = cards.get(id);
  if (c) { c.el.remove(); cards.delete(id); }
  if (!cards.size && tab === 'new') render();
  refreshStatus();
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
    meta = `<span>Opublikowano ${fmt(s.published_at)}</span>${link}`;
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
      <div class="label">Odpowiedź przy odrzuceniu</div><textarea id="trej">${esc(s.template_reject)}</textarea>
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
  $('#save').onclick = (e) => act1(e.target, async () => {
    settingsCache = await api('/api/settings', { method: 'PUT', body: {
      interval_minutes: $('#interval').value, quiet_from: $('#qfrom').value, quiet_to: $('#qto').value,
      page_rules: $('#rules').value, template_commercial: $('#tcom').value, template_reject: $('#trej').value,
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
    if (tab === 'new') render();
  } catch { /* chwilowy brak połączenia */ }
}

(async () => {
  await refreshStatus().catch(() => {});
  api('/api/settings').then((s) => { settingsCache = s; }).catch(() => {});
  render();
  setInterval(tick, 8000);
})();
