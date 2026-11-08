// Ustawienia edytowalne w panelu (zakładka „Ustawienia”).
import { db } from './db.js';

export const DEFAULT_SETTINGS = {
  interval_minutes: '10',
  quiet_from: '23:00',
  quiet_to: '07:00',
  page_rules: `- Publikujemy lokalne sprawy Koszalina i okolic: pytania, prośby o polecenie, zgubione/znalezione, zwierzęta, ostrzeżenia, „spotted”, podziękowania, skargi na sprawy publiczne.
- NIE publikujemy bezpłatnie: ofert sprzedaży, reklam firm i usług, promocji wydarzeń biletowanych, ofert pracy od firm, zbiórek bez wiarygodnego źródła.
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
};

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
    if (k in DEFAULT_SETTINGS) stmt.run(k, String(v));
  }
  return getSettings();
}
