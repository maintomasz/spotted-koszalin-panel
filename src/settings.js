// Ustawienia edytowalne w panelu (zakładka „Ustawienia”).
import { db } from './db.js';

export const DEFAULT_SETTINGS = {
  interval_minutes: '10',
  quiet_from: '23:00',
  quiet_to: '07:00',
  page_rules: `- Publikujemy lokalne sprawy Koszalina i okolic: pytania, prośby o polecenie, zgubione/znalezione, zwierzęta, ostrzeżenia, „spotted”, podziękowania, skargi na sprawy publiczne.
- NIE publikujemy bezpłatnie: reklam firm i usług, promocji wydarzeń biletowanych, ofert pracy od firm, zbiórek bez wiarygodnego źródła.
- Prywatne ogłoszenia drobne (sprzedam/kupię/oddam, mieszkania, praca dorywcza) odsyłamy na naszą grupę.
- Prywatnych ogłoszeń o adopcji/oddaniu/sprzedaży zwierząt nie publikujemy (ryzyko blokady strony przez Facebooka).
- Prośba o polecenie (np. „polećcie dobrego mechanika”) to zwykłe pytanie – NIE jest reklamą.
- Wpisy z nazwiskami, numerami telefonów, adresami prywatnych osób – anonimizujemy.
- Ostrzeżenia przed złodziejami/oszustami publikujemy bez danych osobowych i bez rozpoznawalnych twarzy.
- Na zdjęciach zakrywamy tablice rejestracyjne i twarze osób postronnych.
- Zgubione dokumenty: zostaje tylko imię i pierwsza litera nazwiska, reszta danych zakryta.`,
  template_commercial: `Cześć! Dzięki za wiadomość 🙂 Twoja treść ma charakter komercyjny (reklama / sprzedaż / promocja), a takich wpisów nie publikujemy bezpłatnie. Chętnie przedstawimy ofertę płatnej publikacji na Spotted Koszalin – daj znać, jeśli chcesz poznać szczegóły!`,
  template_reject: `Cześć! Dziękujemy za wiadomość, niestety nie możemy jej opublikować, ponieważ nie spełnia zasad naszej strony.`,
  template_published: `Twój post został opublikowany! 🎉
Zobacz: {link}

Pozdrawiam, Spotted Koszalin

Jeśli podoba Ci się nasza praca, możesz postawić nam kawę: https://buycoffee.to/spottedkoszalin ☕ Dzięki!`,
  presets: '', // JSON z listą szybkich odpowiedzi (pusty = domyślne, patrz DEFAULT_PRESETS)
};

// Szybkie odpowiedzi: treść + wyzwalacz (kiedy AI ma zaproponować) + akcja po wysłaniu.
// Akcje: reject (odrzuć), commercial (oznacz jako reklama), conversation (przenieś do rozmów).
export const DEFAULT_PRESETS = [
  {
    id: 'grupa', name: 'Do grupy', action: 'reject',
    trigger: 'Prywatne ogłoszenie drobne, które nie pasuje na główny profil, ale pasuje do grupy: sprzedam / kupię / oddam / zamienię przedmioty (osoba prywatna, nie firma), wynajem lub szukanie mieszkania/pokoju, praca dorywcza, korepetycje, podwózki i przewozy, drobne usługi osób prywatnych. NIE dotyczy zgubionych/znalezionych rzeczy i zwierząt – te publikujemy na profilu.',
    text: `Hej, takich postów nie wrzucamy na główny profil, ale idealnie pasują na naszą grupę.
Dodaj swoje ogłoszenie bezpośrednio tutaj: 👉 https://www.facebook.com/groups/grupaspottedkoszalin/`,
  },
  {
    id: 'reklama', name: 'Reklama', action: 'commercial',
    trigger: 'Firma, sklep, salon, lokal lub osoba prowadząca działalność chce za darmo wypromować biznes, usługę, produkt, otwarcie, promocję, płatne wydarzenie albo ofertę pracy.',
    text: `Hej!
Przesłana przez Ciebie wiadomość ma charakter komercyjny/reklamowy, a takich treści nie publikujemy bezpłatnie na naszej stronie.
Jeśli jednak zależy Ci na dotarciu ze swoją ofertą do naszych odbiorców, chętnie podeślemy nasz cennik reklamowy. Daj znać, czy jesteś zainteresowany!`,
  },
  {
    id: 'cennik', name: 'Cennik', action: 'conversation',
    trigger: 'Ktoś pyta o cenę, cennik lub możliwość wykupienia reklamy na Spotted Koszalin albo odpowiada, że jest zainteresowany (np. „tak, poproszę cennik”) po wcześniejszej wiadomości o treści reklamowej.',
    text: `Dzień dobry! 🙋🏻‍♂️
Chcesz dotrzeć ze swoją ofertą do szerokiego grona mieszkańców? Poznaj nasze aktualne opcje reklamowe na Spotted Koszalin (https://www.facebook.com/spottedkoszalinplus2/):

🚀 POSTY I RELACJE•
1 post: 45 zł | 5 postów: 200 zł | 10 postów: 350 zł
1x Stories: 30 zł | 5x Stories: 120 zł | 10x Stories: 220 zł

🔥 NOWE PAKIETY (Najbardziej opłacalne)•
3 posty + 3x Stories: 180 zł
5 postów + 5x Stories: 280 zł

📌 POSTY PRZYPIĘTE NA GÓRZE STRONY•
1. miejsce: 150 zł/tydz. lub 350 zł/m-c
2. miejsce: 100 zł/tydz. lub 250 zł/m-c

🌟 GRUPA SPOTTED KOSZALIN (https://www.facebook.com/groups/grupaspottedkoszalin)
Reklama - zdjęcie w tle: 400 zł/m-c

Podane ceny to kwoty brutto. Oczywiście wystawiamy fakturę.

🤔 Planujesz dłuższą kampanię? Z chęcią wynegocjujemy indywidualne warunki!
W razie pytań jestem do dyspozycji.

Pozdrawiamy! Spotted Koszalin 👋🏻`,
  },
  {
    id: 'zwierzeta', name: 'Zwierzęta', action: 'reject',
    trigger: 'Prywatne ogłoszenie o adopcji, oddaniu, sprzedaży lub rozmnażaniu zwierząt (np. „oddam kotki”, „szukam domu dla psa”, „sprzedam szczeniaki”, „szukam samca do krycia”). NIE dotyczy zgubionych ani znalezionych zwierząt oraz ostrzeżeń – te publikujemy.',
    text: `Cześć,
Niestety nie możemy opublikować Twojej wiadomości na naszej tablicy.
Algorytmy Facebooka traktują prywatne ogłoszenia o adopcji zwierząt jako naruszenie regulaminu i bardzo surowo za to karzą (zablokowaniem, a nawet usunięciem strony).
Mimo najszczerszych chęci nie możemy podjąć takiego ryzyka.

Zachęcamy do zamieszczenia ogłoszenia na dedykowanych portalach lub kontaktu z lokalnymi organizacjami pomagającymi zwierzętom.`,
  },
  {
    id: 'timeout', name: 'Time out', action: 'reject',
    trigger: 'Sprawa jest już nieaktualna, bo wiadomość czekała zbyt długo (wydarzenie już minęło, „dziś wieczorem…” sprzed kilku dni, zgubę już pewnie znaleziono) albo autor pyta, dlaczego jego post się nie pojawił, a publikacja nie ma już sensu.',
    text: `Cześć!
Przepraszamy, że Twój post nie pojawił się w oczekiwanym przez Ciebie czasie.
Zachęcamy do podsyłania wiadomości w przyszłości – do usłyszenia! 👋`,
  },
  {
    id: 'odrzucenie', name: 'Odrzucenie', action: 'reject',
    trigger: 'Ogólne odrzucenie – treść łamie prawo, standardy Facebooka lub zasady strony, a żaden inny szablon nie pasuje.',
    text: `Cześć! Dziękujemy za wiadomość, niestety nie możemy jej opublikować, ponieważ nie spełnia zasad naszej strony.`,
  },
];
export const PRESET_ACTIONS = ['reject', 'commercial', 'conversation'];

export function getPresets(settings = getSettings()) {
  try {
    const list = JSON.parse(settings.presets || '');
    if (Array.isArray(list) && list.length) return list;
  } catch { /* domyślne */ }
  // Pierwsze uruchomienie: domyślne szablony; ogólne odrzucenie przejmuje wcześniej zapisaną treść.
  return DEFAULT_PRESETS.map((p) => (p.id === 'odrzucenie' && settings.template_reject ? { ...p, text: settings.template_reject } : { ...p }));
}

export function sanitizePresets(list) {
  if (!Array.isArray(list)) throw new Error('Nieprawidłowa lista szablonów');
  const used = new Set();
  return list.map((p, i) => {
    let id = String(p.id || p.name || `szablon${i}`).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `szablon${i}`;
    while (used.has(id)) id += '_';
    used.add(id);
    return {
      id, name: String(p.name || id).slice(0, 40), action: PRESET_ACTIONS.includes(p.action) ? p.action : 'reject',
      trigger: String(p.trigger || '').slice(0, 1000), text: String(p.text || '').slice(0, 2000),
    };
  }).filter((p) => p.text.trim());
}

// Wstawia link do posta w miejsce {link}; gdy znacznika brak – dodaje link pod pierwszą linijką.
export function fillPublishedTemplate(template, link) {
  const t = String(template || '').trim();
  if (!t) return '';
  if (t.includes('{link}')) return t.replaceAll('{link}', link);
  const [first, ...rest] = t.split('\n');
  return [first, `Zobacz: ${link}`, ...rest].join('\n');
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

export function saveSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, k === 'presets' ? JSON.stringify(sanitizePresets(typeof v === 'string' ? JSON.parse(v) : v)) : String(v));
  }
  return getSettings();
}
