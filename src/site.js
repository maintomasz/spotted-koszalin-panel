// Połączenie ze stroną spottedkoszalin.pl – ogłoszenia o pracę (zakładka „Praca” w panelu).
// Dane ogłoszeń są na stronie; panel tylko je pobiera i wysyła decyzje.
// Konfiguracja: SITE_API_URL (np. https://spottedkoszalin.pl) i SITE_API_TOKEN (ten sam co PANEL_API_TOKEN na stronie).

const BASE = () => (process.env.SITE_API_URL || '').replace(/\/+$/, '');
const TOKEN = () => process.env.SITE_API_TOKEN || '';
export const siteEnabled = () => !!(BASE() && TOKEN());

let cachedPending = null;

export async function siteRequest(path, { method = 'GET', body } = {}) {
  if (!siteEnabled()) {
    const e = new Error('Strona nie jest podłączona – ustaw SITE_API_URL i SITE_API_TOKEN w ustawieniach serwera panelu.');
    e.status = 503;
    throw e;
  }
  // Klucz idzie w X-Panel-Token; Authorization zostaje wolne na hasło katalogu z Hostido (SITE_BASIC_AUTH="login:hasło"),
  // dopóki strona jest zabezpieczona hasłem.
  const headers = { 'X-Panel-Token': TOKEN(), Accept: 'application/json' };
  if (process.env.SITE_BASIC_AUTH) headers.Authorization = `Basic ${Buffer.from(process.env.SITE_BASIC_AUTH).toString('base64')}`;
  else headers.Authorization = `Bearer ${TOKEN()}`;
  if (body) headers['Content-Type'] = 'application/json';
  const url = `${BASE()}/api/panel/jobs${path}`;
  const init = { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) };
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const e = new Error(`Nie udało się połączyć ze stroną (${err.name === 'TimeoutError' ? 'brak odpowiedzi' : err.message}).`);
    e.status = 502;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || data.message || (res.status === 401 ? 'Strona odrzuciła klucz – sprawdź SITE_API_TOKEN.' : `Błąd strony ${res.status}`);
    const e = new Error(msg);
    e.status = res.status === 422 ? 422 : 502;
    throw e;
  }
  return data;
}

export async function listJobs(status) {
  const data = await siteRequest(`/?status=${encodeURIComponent(status || 'pending')}`);
  cachedPending = data.counts?.pending ?? cachedPending;
  return data;
}

// Licznik czekających ogłoszeń do zakładki (odświeżany w tle, żeby nie spowalniać panelu)
export const pendingJobsCount = () => cachedPending;
export function startSitePolling() {
  if (!siteEnabled()) return;
  const tick = () => listJobs('pending').catch(() => {});
  tick();
  setInterval(tick, 60_000).unref();
}

const ACTIONS = new Set(['approve', 'reject', 'extend', 'unpublish']);
export async function jobAction(id, action, body = {}) {
  if (!ACTIONS.has(action)) throw Object.assign(new Error('Nieznana akcja'), { status: 400 });
  const out = await siteRequest(`/${Number(id)}/${action}`, { method: 'POST', body });
  listJobs('pending').catch(() => {});
  return out;
}

export async function updateJob(id, fields) {
  return siteRequest(`/${Number(id)}`, { method: 'PATCH', body: fields });
}
