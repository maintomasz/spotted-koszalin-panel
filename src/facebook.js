// Integracja z Facebookiem (Graph API): odbiór wiadomości, publikacja postów, odpowiedzi do nadawców.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_DIR } from './db.js';

const GRAPH = () => `https://graph.facebook.com/${process.env.FB_GRAPH_VERSION || 'v24.0'}`;
const TOKEN = () => process.env.FB_PAGE_ACCESS_TOKEN;
const PAGE_ID = () => process.env.FB_PAGE_ID;

export const fbEnabled = () => !!(TOKEN() && PAGE_ID());

// Sprawdza, że webhook naprawdę przyszedł od Facebooka (podpis HMAC kluczem App Secret).
export function verifySignature(rawBody, header) {
  const secret = process.env.FB_APP_SECRET;
  if (!secret) return false;
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

async function graph(method, endpoint, { params = {}, body } = {}) {
  const url = new URL(`${GRAPH()}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', TOKEN());
  const res = await fetch(url, { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const msg = json.error?.message || `HTTP ${res.status}`;
    throw new Error(`Facebook: ${msg}`);
  }
  return json;
}

export async function getUserName(psid) {
  try {
    const u = await graph('GET', psid, { params: { fields: 'first_name,last_name,name' } });
    return u.name || [u.first_name, u.last_name].filter(Boolean).join(' ') || null;
  } catch {
    return null;
  }
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

// Pobiera zdjęcie z Facebooka na dysk (linki FB wygasają, więc trzymamy kopię).
export async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nie udało się pobrać zdjęcia (HTTP ${res.status})`);
  const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  return saveMedia(buf, mime);
}

export function saveMedia(buf, mime) {
  const file = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${EXT[mime] || 'jpg'}`;
  fs.writeFileSync(path.join(MEDIA_DIR, file), buf);
  return { file, mime };
}

export async function sendMessage(psid, text) {
  return graph('POST', 'me/messages', {
    body: new URLSearchParams({
      recipient: JSON.stringify({ id: psid }),
      messaging_type: 'RESPONSE',
      message: JSON.stringify({ text }),
    }),
  });
}

async function uploadPhoto(file, mime, { published, caption } = {}) {
  const form = new FormData();
  const buf = fs.readFileSync(path.join(MEDIA_DIR, file));
  form.append('source', new Blob([buf], { type: mime || 'image/jpeg' }), file);
  form.append('published', published ? 'true' : 'false');
  if (caption) form.append('message', caption);
  return graph('POST', `${PAGE_ID()}/photos`, { body: form });
}

// Publikuje post na stronie: sam tekst, jedno zdjęcie z opisem albo kilka zdjęć w jednym poście.
export async function publishPost({ text, images }) {
  if (!images || images.length === 0) {
    const r = await graph('POST', `${PAGE_ID()}/feed`, { body: new URLSearchParams({ message: text }) });
    return r.id;
  }
  if (images.length === 1) {
    const r = await uploadPhoto(images[0].file, images[0].mime, { published: true, caption: text });
    return r.post_id || r.id;
  }
  const ids = [];
  for (const img of images) {
    const r = await uploadPhoto(img.file, img.mime, { published: false });
    ids.push(r.id);
  }
  const body = new URLSearchParams({ message: text });
  ids.forEach((id, i) => body.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
  const r = await graph('POST', `${PAGE_ID()}/feed`, { body });
  return r.id;
}
