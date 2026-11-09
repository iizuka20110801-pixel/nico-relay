let jar = {};
let jarAt = 0;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-max-age': '86400'
};

async function warm() {
  if (Object.keys(jar).length && Date.now() - jarAt < 600000) return;
  try {
    const r = await fetch('https://www.nicovideo.jp/', {
      headers: { 'user-agent': UA, 'accept': '*/*', 'accept-language': 'ja-JP,ja;q=0.9' },
      redirect: 'follow'
    });
    const list = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    jar = {};
    list.forEach((c) => {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1);
    });
    jarAt = Date.now();
  } catch (e) {}
}

function baseHeaders(extraKey) {
  const h = new Headers();
  h.set('user-agent', UA);
  h.set('accept', '*/*');
  h.set('accept-language', 'ja-JP,ja;q=0.9');
  h.set('x-frontend-id', '6');
  h.set('x-frontend-version', '0');
  h.set('x-request-with', 'https://www.nicovideo.jp');
  h.set('origin', 'https://www.nicovideo.jp');
  h.set('referer', 'https://www.nicovideo.jp/');
  const cookies = Object.keys(jar).map((k) => k + '=' + jar[k]).join('; ');
  if (cookies) h.set('cookie', cookies);
  if (extraKey) h.set('x-access-right-key', extraKey);
  return h;
}

const track = () => 'AAAAAAAAAA_' + Date.now();
const abs = (p, base) => { try { return new URL(p, base).href; } catch (e) { return p; } };

async function fetchComments(d, id) {
  const c = d.comment || {};
  const targets = [];
  (c.layers || []).forEach((l) => {
    (l.threadIds || []).forEach((t) => {
      if (t.id) targets.push({ id: t.id, fork: t.fork || 0 });
    });
  });
  if (!targets.length) return [];

  let threadKey = c.threadKey || '';
  if (!threadKey) {
    const k = await fetch('https://nvapi.nicovideo.jp/v1/comment/keys/thread?videoId=' + id, { headers: baseHeaders() });
    if (k.ok) {
      const kj = await k.json().catch(() => ({}));
      threadKey = (kj.data && kj.data.threadKey) || '';
    }
  }
  if (!threadKey) return [];

  const server = ((c.server || {}).url || 'https://public.nvcomment.nicovideo.jp').replace(/\/$/, '');
  const h = baseHeaders();
  h.set('content-type', 'application/json');

  const r = await fetch(server + '/v1/threads?_frontendId=6', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      params: { targets, language: 'ja-jp', videoId: id, userId: (c.keys || {}).userKey || '' },
      threadKey,
      additionals: {}
    })
  });
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  const out = [];
  (((j.data || {}).threads) || []).forEach((th) => {
    (th.comments || []).forEach((cm) => {
      if (cm.body) out.push({ v: (cm.vposMs || 0) / 1000, body: cm.body, cmd: cm.commands || [] });
    });
  });
  out.sort((a, b) => a.v - b.v);
  return out;
}

async function resolve(id) {
  await warm();
  const g = await fetch('https://www.nicovideo.jp/api/watch/v3_guest/' + id +
    '?actionTrackId=' + track() + '&t=' + Date.now(), { headers: baseHeaders() });
  if (!g.ok) {
    const body = await g.text().catch(() => '');
    return { url: null, key: null, error: 'guest ' + g.status + ' ' + body.slice(0, 90), comments: [] };
  }
  const j = await g.json().catch(() => ({}));
  const d = j.data || {};

  let comments = [];
  try { comments = await fetchComments(d, id); } catch (e) {}

  const domand = (d.media || {}).domand || {};
  const key = domand.accessRightKey;
  const vids = (domand.videos || []).filter((v) => v.isAvailable !== false)
    .sort((a, b) => (a.height || 0) - (b.height || 0));
  const auds = (domand.audios || []).filter((a) => a.isAvailable !== false)
    .sort((a, b) => (a.bitRate || 0) - (b.bitRate || 0));
  if (!key || !vids.length) return { url: null, key: null, error: 'no access-right', comments };

  const v = vids[0];
  const a = auds[0];
  const outputs = a ? [[v.id, a.id]] : [[v.id]];
  const t = (d.client || {}).watchTrackId || track();

  const h = baseHeaders(key);
  h.set('content-type', 'application/json');
  const r = await fetch('https://nvapi.nicovideo.jp/v1/watch/' + id +
    '/access-rights/hls?actionTrackId=' + t, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ outputs })
  });
  if (r.status !== 200 && r.status !== 201) {
    return { url: null, key, error: 'hls ' + r.status, comments };
  }
  const rj = await r.json().catch(() => ({}));
  const url = (rj.data || {}).contentUrl || null;
  return { url, key, error: url ? null : 'no contentUrl', comments };
}

export default async function handler(req, res) {
  Object.keys(CORS).forEach((k) => res.setHeader(k, CORS[k]));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const raw = req.url || '';
  const host = req.headers.host;
  const qIndex = raw.indexOf('?');
  let path = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const search = qIndex >= 0 ? raw.slice(qIndex + 1) : '';

  if (path.startsWith('/api/')) path = path.slice(4);
  else if (path === '/api') path = '/';

  if (path.startsWith('/v/')) {
    const id = decodeURIComponent(path.slice(3)).replace(/[^A-Za-z0-9_]/g, '');
    if (!id) return res.status(400).json({ url: null });
    const out = await resolve(id);
    out.colo = process.env.VERCEL_REGION || 'vercel';
    return res.status(200).json(out);
  }

  let target = null;
  if (path.startsWith('/p/')) target = decodeURIComponent(path.slice(3));
  if (!target) {
    const sp = new URLSearchParams(search);
    target = sp.get('u');
  }
  if (!target) return res.status(400).send('u required');

  const params = new URLSearchParams(search);
  const key = params.get('k') || req.headers['x-access-right-key'] || '';
  params.delete('k');
  params.delete('u');
  const rest = params.toString();
  if (rest) target += (target.indexOf('?') >= 0 ? '&' : '?') + rest;

  await warm();
  const h = baseHeaders(key);
  if (req.headers['content-type']) h.set('content-type', req.headers['content-type']);
  const init = { method: req.method, headers: h, redirect: 'follow' };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  }

  let r;
  try { r = await fetch(target, init); }
  catch (e) { return res.status(502).send('fetch error: ' + e.message); }

  const ct = r.headers.get('content-type') || '';
  const isPlaylist = ct.indexOf('mpegurl') >= 0 || target.split('?')[0].indexOf('.m3u8') >= 0;

  if (isPlaylist && r.ok) {
    const text = await r.text();
    const suffix = key ? '?k=' + encodeURIComponent(key) : '';
    const out = text.split('\n').map((line) => {
      if (!line) return line;
      if (line.charAt(0) === '#') {
        return line.replace(/URI="([^"]+)"/g, (m, p) =>
          'URI="https://' + host + '/api/p/' + encodeURIComponent(abs(p, target)) + suffix + '"');
      }
      return 'https://' + host + '/api/p/' + encodeURIComponent(abs(line, target)) + suffix;
    }).join('\n');
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.setHeader('cache-control', 'no-store');
    return res.status(200).send(out);
  }

  const buf = Buffer.from(await r.arrayBuffer());
  res.setHeader('content-type', ct || 'video/mp2t');
  res.setHeader('cache-control', 'public, max-age=3600');
  return res.status(r.status).send(buf);
  }
