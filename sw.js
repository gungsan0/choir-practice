/* 울림 합창 연습실 — 오프라인 지원 */
const SHELL = 'shell-v2';
const FILES = ['./', 'index.html', 'player.html', 'player.js', 'app.css',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable.png', 'logo-badge.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

const cacheNameFor = url => {
  const m = url.pathname.match(/songs\/([^/]+)\//);
  return m ? 'songs-' + m[1] : SHELL;
};

/* 음원은 브라우저가 구간(Range) 요청을 보내므로 직접 206 응답을 만들어준다.
   (그래야 오프라인에서도 탐색·구간반복이 정상 동작) */
async function audio(req, url) {
  const plain = new Request(url.href, { credentials: 'same-origin' });
  let res = await caches.match(plain);
  if (!res) {
    try {
      res = await fetch(plain);
      if (res && res.status === 200) {
        const cp = res.clone();
        caches.open(cacheNameFor(url)).then(c => c.put(plain, cp)).catch(() => { });
      }
    } catch (e) {
      return new Response('offline', { status: 504 });
    }
  }
  const range = req.headers.get('range');
  if (!range || !res || res.status !== 200) return res;
  const buf = await res.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  const start = m[1] ? parseInt(m[1]) : 0;
  const end = Math.min(m[2] ? parseInt(m[2]) : buf.byteLength - 1, buf.byteLength - 1);
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.endsWith('.mp3')) { e.respondWith(audio(req, url)); return; }

  // 곡 목록은 최신을 먼저 시도(새 곡이 바로 보이도록), 실패하면 캐시
  if (url.pathname.endsWith('songs/index.json')) {
    e.respondWith(
      fetch(req).then(r => {
        const cp = r.clone();
        caches.open(SHELL).then(c => c.put(req, cp)).catch(() => { });
        return r;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // 그 외에는 캐시 우선 (?song=... 같은 주소는 물음표 뒤를 무시하고 찾는다)
  const opts = { ignoreSearch: url.pathname.endsWith('.html') || url.pathname.endsWith('/') };
  e.respondWith(
    caches.match(req, opts).then(hit => hit || fetch(req).then(r => {
      if (r.ok && r.status === 200 &&
        (url.pathname.includes('/songs/') || FILES.some(f => url.pathname.endsWith(f)))) {
        const cp = r.clone();
        caches.open(cacheNameFor(url)).then(c => c.put(req, cp)).catch(() => { });
      }
      return r;
    }).catch(() => caches.match('index.html')))
  );
});
