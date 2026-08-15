/* 울림 합창 연습실 — 오프라인 지원 */
const SHELL = 'shell-2026.08.14-g';
const FILES = ['./', 'index.html', 'player.html', 'player.js', 'app.css',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable.png', 'logo-badge.png',
  'add.html', 'add.js', 'vendor/fflate.min.js', 'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs'];

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

  // 곡 목록과 곡 정보는 최신을 먼저 시도(새 곡·고친 악보가 바로 보이도록), 실패하면 캐시
  if (url.pathname.endsWith('songs/index.json') || url.pathname.endsWith('song.json')) {
    e.respondWith(
      fetch(req).then(r => {
        if (!r || r.status !== 200)                     // 404 응답을 캐시에 덮어쓰지 않는다
          return caches.match(req).then(hit => hit || r);
        const cp = r.clone();
        caches.open(cacheNameFor(url)).then(c => c.put(req, cp)).catch(() => { });
        return r;
      }).catch(() => caches.match(req))
    );
    return;
  }

  const isSong = url.pathname.includes('/songs/');

  // 앱 파일(html·js·css·아이콘)은 '최신 먼저' — 고친 내용이 바로 반영되도록.
  //  (실패하면 캐시로 넘어가므로 오프라인에서도 그대로 열립니다)
  if (!isSong) {
    e.respondWith(
      fetch(req).then(r => {
        if (r && r.status === 200) {
          const cp = r.clone();
          caches.open(SHELL).then(c => c.put(req, cp)).catch(() => { });
        }
        return r;
      }).catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || caches.match('index.html', { ignoreSearch: true })))
    );
    return;
  }

  // 곡 파일(악보 이미지·음원)은 캐시 우선 — 크고 잘 바뀌지 않습니다.
  e.respondWith(
    caches.match(req, { ignoreSearch: false }).then(hit => hit || fetch(req).then(r => {
      if (r.ok && r.status === 200) {
        const cp = r.clone();
        caches.open(cacheNameFor(url)).then(c => c.put(req, cp)).catch(() => { });
      }
      return r;
    }))
  );
});
