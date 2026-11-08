// Przykładowe wiadomości do przetestowania panelu (przycisk „Dodaj przykładowe wiadomości”).
import { insertSubmission } from './db.js';

const SAMPLES = [
  'Hej, czy ktoś może polecić dobrego mechanika w Koszalinie, najlepiej okolice Rokosowa? Coś stuka w zawieszeniu i nie chcę przepłacić',
  'Zgubiłem wczoraj portfel na Zwycięstwa koło Kauflandu, czarny skórzany, w środku dowód na nazwisko Marek Kowalczyk i karty. Proszę o kontakt 601 234 567, dla znalazcy nagroda!',
  'SPRZEDAM iPhone 14 Pro 128GB stan idealny cena 2800 zł do negocjacji, odbiór Koszalin centrum, pisać na priv',
  'Do tego idioty w czarnym audi który dziś o 7:40 wyprzedzał na pasach przy szkole na Orlich Gniazd - kurwa człowieku tam są dzieci!!! Rejestracja ZKO 12345',
  'Znaleziono pieska na Morskiej, mały, rudy, bez obroży, bardzo przestraszony. Jest u nas w domu, właściciel niech pisze 🙏',
  'Uwaga! Dzisiaj na osiedlu Unii Lubelskiej dwóch facetów chodzi po klatkach i podaje się za pracowników gazowni. To oszuści, nie wpuszczajcie ich!',
  'Zapraszamy na otwarcie naszego nowego salonu kosmetycznego Bella na ul. Jedności! Pierwsze 20 klientek -30% na wszystkie zabiegi 💅',
  'Spotted: dziewczyna w zielonej kurtce w autobusie linii 6 dziś ok 16:00, czytałaś książkę Tokarczuk. Uśmiechnęłaś się do mnie przy wysiadaniu na Dworcu – może kawa? :)',
];

export function seedDemo() {
  const now = Date.now();
  SAMPLES.forEach((text, i) => insertSubmission({
    source: 'demo', sender_name: `Przykład ${i + 1}`, original_text: text, attachments: [], created_at: now - (SAMPLES.length - i) * 60000,
  }));
  return SAMPLES.length;
}
