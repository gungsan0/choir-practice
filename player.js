/* 울림 합창 연습실 — 악보 따라가기 플레이어
   · 한 파트만 들을 때  : <audio> 사용 (속도 조절 시 음정 유지)
   · 두 파트 이상 겹칠 때: Web Audio 로 완전히 같은 시각에 재생 (밀림 없음)      */
(function () {
  const $ = id => document.getElementById(id);
  const tr = I18N.t;                               // 한/영 문구 (T 는 재생 시각 함수라 이름을 달리함)
  const songId = new URLSearchParams(location.search).get('song');
  const main = $('main'), hdr = document.querySelector('header'), spacer = $('spacer');
  if (!songId) { location.replace('index.html'); return; }
  const base = 'songs/' + songId + '/';

  let D = null, parts = [], sel = [], els = {}, cur = -1, rate = 1;
  let loopA = null, loopB = null, multi = false, loopMode = false;
  let accId = null, accOn = false, accVol = 0.6;   // 반주
  let syncOff = 0;                                 // 악보 싱크 미세조정(초)
  let loadErr = null, dlState = null, statusKey = '';              // 언어를 바꿔도 같은 문구를 다시 그리려고 상태를 기억
  const pageImgs = [], hitEls = [];
  const ovs = [], sys = div('sys'), lmk = div('loopmark'), hls = {};

  function div(c) { const d = document.createElement('div'); d.className = c; return d; }
  const dur = () => D.times[D.times.length - 1];
  const fmt = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
  const rgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(','); };
  const partOf = id => parts.find(p => p.id === id) || parts[0];

  /* ── 재생 엔진 ───────────────────────────────────────────── */
  const EL = {                                   // 단일 파트: HTMLAudioElement
    a: null,
    use(id) { this.a = els[id]; },
    get time() { return (EL.pendFor === this.a && EL.pend !== null) ? EL.pend : this.a.currentTime; },
    set time(t) {
      const a = this.a; EL.pend = t; EL.pendFor = a;
      const apply = () => { if (EL.pendFor === a && EL.pend !== null) { try { a.currentTime = EL.pend; } catch (e) { } EL.pend = null; EL.pendFor = null; } };
      if (a.readyState > 0) apply();
      else { a.addEventListener('loadedmetadata', apply, { once: true }); if (a.networkState === 0) a.load(); }
    },
    get paused() { return !this.a || this.a.paused; },
    play() { this.a.playbackRate = rate; this.a.preservesPitch = true; return this.a.play().catch(() => { }); },
    pause() { this.a && this.a.pause(); },
    stop() { this.pause(); },
    setRate(r) { parts.forEach(p => { const a = els[p.id]; a.playbackRate = r; a.preservesPitch = a.mozPreservesPitch = a.webkitPreservesPitch = true; }); },
    pend: null, pendFor: null
  };

  const WA = {                                   // 여러 파트: Web Audio
    ctx: null, buf: {}, src: [], gain: null, gacc: null, at: 0, off: 0, on: false,
    async ready(ids) {
      if (!this.ctx) {
        const C = window.AudioContext || window.webkitAudioContext;
        try { this.ctx = new C({ sampleRate: 32000 }); } catch (e) { this.ctx = new C(); }
        this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination);
        this.gacc = this.ctx.createGain(); this.gacc.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const need = ids.filter(id => !this.buf[id]);
      if (need.length) {
        setStatus('status.loading');
        await Promise.all(need.map(async id => {
          const r = await getAsset(base + id + '.mp3');
          const ab = await r.arrayBuffer();
          this.buf[id] = await new Promise((res, rej) => {
            const p = this.ctx.decodeAudioData(ab, res, rej);
            if (p && p.then) p.then(res, rej);
          });
        }));
        setStatus('');
      }
    },
    get time() { return this.on ? Math.min(dur(), this.off + (this.ctx.currentTime - this.at) * rate) : this.off; },
    set time(t) { const was = this.on; this.stop(); this.off = Math.max(0, t); if (was) this.start(); },
    get paused() { return !this.on; },
    start() {
      const ids = sel.filter(id => this.buf[id]);
      if (!ids.length) return;
      this.gain.gain.value = 1 / Math.sqrt(ids.length);
      this.gacc.gain.value = accVol;
      const t0 = this.ctx.currentTime + 0.06;
      const mk = (id, node) => {
        const s = this.ctx.createBufferSource();
        s.buffer = this.buf[id]; s.playbackRate.value = rate;
        s.connect(node); s.start(t0, Math.min(this.off, s.buffer.duration - .01));
        return s;
      };
      this.src = ids.map(id => mk(id, this.gain));
      if (accOn && accId && this.buf[accId]) this.src.push(mk(accId, this.gacc));
      this.at = t0; this.on = true;
    },
    async play() { await this.ready(accOn && accId ? sel.concat([accId]) : sel); this.start(); },
    pause() { if (this.on) { const t = this.time; this.stop(); this.off = t; } },
    stop() { this.src.forEach(s => { try { s.stop(); } catch (e) { } }); this.src = []; this.on = false; },
    setRate(r) { if (this.on) { const t = this.time; this.stop(); this.off = t; rate = r; this.start(); } }
  };

  let E = EL;                                    // 현재 엔진
  const T = () => E.time;
  const setT = t => { E.time = Math.max(0, Math.min(t, dur())); };

  const needsWA = () => sel.length > 1 || (accOn && !!accId);
  async function useEngine(next) {
    if (E === next) return;
    const t = T(), playing = !E.paused;
    E.stop(); E = next;
    if (next === WA) { await WA.ready(accOn && accId ? sel.concat([accId]) : sel); }
    else EL.use(sel[0]);
    E.time = t;
    if (playing) await E.play();
    upd();
  }

  /* ── 초기화 ───────────────────────────────────────────────
     파일은 ① 서버 ② 브라우저 저장소(오프라인·이 기기에 추가한 곡) 순서로 찾는다.
     서비스워커가 아직 페이지를 맡기 전이어도 곡이 열리도록 하기 위함. */
  let fromCache = false;
  const abs = u => new URL(u, location.href).href;

  /* 한글 파일명은 자모가 합쳐진 형태(NFC)와 분리된 형태(NFD)가 있고,
     맥에서 올린 파일은 분리된 형태로 저장됩니다. song.json 에 적힌 파트 이름과
     형태가 달라도 곡이 열리도록, 안 되면 반대 형태로 한 번 더 찾아봅니다. */
  const altForm = u => { const a = u.normalize('NFC'), b = u.normalize('NFD'); return u === a ? (b === a ? null : b) : a; };
  const forms = u => { const alt = altForm(u); return alt ? [u, alt] : [u]; };
  const fixed = new Map();                       // 원래 주소 → 실제로 열리는 주소
  async function realURL(url) {                  // 통째로 받지 않고 주소만 확인
    if (fixed.has(url)) return fixed.get(url);
    const cands = forms(url);
    let out = url;
    if (cands.length > 1) {
      const ok = async u => { try { const r = await fetch(u, { method: 'HEAD' }); return !!(r && r.ok); } catch (e) { return false; } };
      if (!(await ok(url)) && await ok(cands[1])) out = cands[1];
    }
    fixed.set(url, out);
    return out;
  }
  async function getAsset(url) {
    const cands = forms(url);
    const opt = /song\.json$/.test(url) ? { cache: 'no-cache' } : undefined;   // 마디 시각은 늘 최신으로(HTTP 캐시 10분 방지)
    for (const u of cands) { try { const r = await fetch(u, opt); if (r && r.ok) return r; } catch (e) { } }
    for (const u of cands) {
      try {
        const hit = await caches.match(abs(u));
        if (hit) { fromCache = true; return hit; }
      } catch (e) { }
    }
    return null;
  }
  async function assetURL(url) {                 // <img>·<audio> 에 넣을 주소
    if (!fromCache) return realURL(url);
    const r = await getAsset(url);
    return r ? URL.createObjectURL(await r.blob()) : url;
  }

  /* 곡 파일(악보·음원)은 캐시 우선이라, 같은 이름으로 덮어쓴 곡(다시 만들기)은 옛 파일이 계속 보인다.
     song.json 의 rev 가 이 기기에서 마지막으로 본 값과 다르면 그 곡의 저장분을 비우고 새로 받는다.
     (이 기기에서 추가한 곡은 원본이 없으니 건드리지 않는다) */
  async function dropStaleFiles(song, res) {
    if (!song.rev || fromCache || isLocal()) return;
    let seen = null;
    try { seen = localStorage.getItem('rev-' + songId); } catch (e) { }
    if (seen === song.rev) return;
    try {
      await caches.delete('songs-' + songId);
      await (await caches.open('songs-' + songId)).put(abs(base + 'song.json'), res);
      localStorage.setItem('rev-' + songId, song.rev);
    } catch (e) { }
  }

  getAsset(base + 'song.json')
    .then(async r => {
      if (!r) throw 0;
      const copy = r.clone(), song = await r.json();
      await dropStaleFiles(song, copy);
      return song;
    })
    .then(init)
    .catch(() => { loadErr = isLocal() ? 'local' : 'remote'; paintLoadError(); });

  function paintLoadError() {
    if (!loadErr) return;
    main.innerHTML = '<div class="hint" style="display:block">' + tr('err.title') + '<br>' +
      (loadErr === 'local' ? tr('err.local') : tr('err.remote', { id: I18N.esc(songId) })) +
      '<br><a href="index.html" style="text-decoration:underline">' + tr('back.link') + '</a></div>';
  }

  function init(song) {
    D = song; parts = song.parts; sel = [parts[0].id];
    $('ttl').textContent = song.title;

    $('parts').innerHTML = parts.map((p, i) =>
      `<button class="part${i === 0 ? ' on' : ''}" data-p="${I18N.esc(p.id)}"${i === 0 ? ` style="background:${I18N.esc(p.color)}"` : ''}>${I18N.esc(p.name)}</button>`).join('');

    for (let i = 0; i < song.pages; i++) {
      const d = div('page'), img = new Image();
      pageImgs.push(img);
      img.loading = i < 2 ? 'eager' : 'lazy';
      assetURL(base + 'p' + (i + 1) + '.webp').then(u => { img.src = u; });
      const ov = div('ov'); d.append(img, ov); main.appendChild(d); ovs.push(ov);
    }
    D.measures.forEach(m => {
      const h = div('hit');
      h.style.cssText = `left:${m.x}%;width:${m.w}%;top:${m.sy[0]}%;height:${m.sy[1]}%`;
      hitEls.push([h, m.m]);
      h.onclick = e => (loopMode || e.shiftKey) ? setLoop(m.m) : seekM(m.m);
      ovs[m.pg].appendChild(h);
    });
    parts.forEach(p => { hls[p.id] = div('hl'); });
    accId = song.accomp || null;
    if (accId) { $('acc').hidden = false; $('accvol').hidden = false; }

    parts.forEach((p, i) => {
      const a = new Audio(); a.preload = i === 0 ? 'auto' : 'metadata'; els[p.id] = a;
      assetURL(base + p.id + '.mp3').then(u => { a.src = u; });
    });
    EL.use(sel[0]);
    addEventListener('load', () => setTimeout(() => {
      if (!fromCache) parts.slice(1).forEach(p => realURL(base + p.id + '.mp3').then(u => fetch(u)).catch(() => { }));
    }, 2000));

    labelSong();
    wire(); fit(); render(true);
    if ('ResizeObserver' in window) new ResizeObserver(fit).observe(hdr);
    dlState = isLocal() ? 'local' : null; paintDl();
    (function loop() { render(false); requestAnimationFrame(loop); })();
  }

  /* 곡 제목 밑 글자·악보 대체글·마디 툴팁 — 언어를 바꾸면 다시 단다 */
  function labelSong() {
    document.title = D.title + ' — ' + tr('app.name');
    $('foot').textContent = (D.subtitle ? I18N.data(D.subtitle) + ' · ' : '') + tr('foot', { n: parts.length });
    pageImgs.forEach((img, i) => { img.alt = tr('score.alt', { n: i + 1 }); });
    hitEls.forEach(([h, m]) => { h.title = tr('bar.n', { n: m }); });
  }
  function paintDl() {
    const key = { local: 'dl.local', unsupported: 'dl.unsupported', saving: 'dl.saving', done: 'dl.done', fail: 'dl.fail' }[dlState] || 'dl.save';
    $('dl').textContent = tr(key);
    $('dl').classList.toggle('act', dlState === 'local' || dlState === 'done');
  }
  const showSync = () => {
    $('sync').textContent = tr('sync.label', { v: (syncOff >= 0 ? '+' : '') + syncOff.toFixed(1) });
    $('sync').classList.toggle('act', syncOff !== 0);
  };
  I18N.onChange(() => {                          // I18N.apply() 가 정적 문구를 바꾼 뒤, 상태에 따라 달라지는 글자를 다시 단다
    if (!D) { paintLoadError(); return; }
    labelSong(); paintLoop(); paintParts(); showSync(); paintDl(); paintStatus();
    fit();                                       // 영어 글자가 더 길어 헤더가 두 줄이 되면 높이를 다시 맞춘다
  });

  const fit = () => { spacer.style.height = hdr.offsetHeight + 'px'; };
  const paintStatus = () => { $('st').textContent = statusKey ? tr(statusKey) : ''; };
  const setStatus = key => { statusKey = key; paintStatus(); };

  function mAt(t) {
    if (t < D.times[0]) return 1;
    let lo = 0, hi = D.measures.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (D.times[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo + 1;
  }
  const EPS = 0.02;                       // mp3 탐색이 프레임 경계로 밀리는 것 보정
  const mt = () => T() + syncOff;                  // 악보 기준 시각
  const seekM = m => { setT(D.times[m - 1] - syncOff + EPS); render(true); };
  const upd = () => { $('play').innerHTML = E.paused ? '&#9654;' : '&#10074;&#10074;'; };

  function setLoop(m) {
    if (loopA === null || loopB !== null) { loopA = m; loopB = null; }
    else { loopB = Math.max(m, loopA); loopMode = false; setT(D.times[loopA - 1] - syncOff + EPS); }
    paintLoop();
  }
  function clearLoop() { loopA = loopB = null; loopMode = false; lmk.remove(); paintLoop(); }
  function paintLoop() {
    const btn = $('loop');
    btn.classList.toggle('act', loopMode || loopA !== null);
    if (loopB !== null) {
      btn.textContent = tr('loop.set', { a: loopA, b: loopB });
      $('lp').textContent = '';
    } else if (loopA !== null) {
      btn.textContent = tr('loop.pickEnd');
      $('lp').textContent = tr('loop.hintEnd', { a: loopA });
    } else if (loopMode) {
      btn.textContent = tr('loop.pickStart');
      $('lp').textContent = tr('loop.hintStart');
    } else {
      btn.textContent = tr('loop');
      $('lp').textContent = '';
    }
    lmk.remove();
    if (loopA === null) return;
    const a = D.measures[loopA - 1], b = D.measures[(loopB || loopA) - 1];
    if (a.pg === b.pg) {
      ovs[a.pg].appendChild(lmk);
      lmk.style.cssText = `left:${a.x}%;width:${b.x + b.w - a.x}%;top:${a.sy[0]}%;height:${a.sy[1]}%`;
    }
  }

  function paintParts() {
    document.querySelectorAll('.part').forEach(x => {
      const on = sel.includes(x.dataset.p);
      x.classList.toggle('on', on);
      x.style.background = on ? partOf(x.dataset.p).color : '';
    });
    $('mix').classList.toggle('act', multi);
    $('mix').textContent = multi ? tr('mix.on') : tr('mix');
    document.querySelectorAll('[data-sp]').forEach(b => {
      const off = needsWA() && b.dataset.sp !== '1';
      b.disabled = off; b.style.opacity = off ? .35 : 1;
      b.title = off ? tr('speed.limit') : '';
    });
    if (needsWA() && rate !== 1) setRate(1);
    $('acc').classList.toggle('act', accOn);
  }

  async function pickPart(id) {
    if (multi) {
      if (sel.includes(id)) { if (sel.length > 1) sel = sel.filter(x => x !== id); }
      else sel = parts.map(p => p.id).filter(p => sel.includes(p) || p === id);   // 악보 순서 유지
    } else sel = [id];
    paintParts();
    if (needsWA()) { await useEngine(WA); if (!E.paused) { E.pause(); await E.play(); } }
    else {
      if (E === WA) await useEngine(EL);
      else { const t = T(), playing = !E.paused; E.pause(); EL.use(id); EL.time = t; if (playing) EL.play(); }
    }
    render(true);
  }

  function setRate(r) {
    rate = r; EL.setRate(r); if (E === WA) WA.setRate(r);
    document.querySelectorAll('[data-sp]').forEach(x => x.classList.toggle('act', parseFloat(x.dataset.sp) === r));
  }

  function wire() {
    $('parts').onclick = e => { const b = e.target.closest('.part'); if (b) pickPart(b.dataset.p); };
    $('mix').onclick = () => {
      multi = !multi;
      if (!multi && sel.length > 1) { sel = [sel[0]]; pickPart(sel[0]); }
      paintParts();
    };
    $('play').onclick = async () => { E.paused ? await E.play() : E.pause(); upd(); };
    document.querySelectorAll('[data-sp]').forEach(b => b.onclick = () => { if (!b.disabled) setRate(parseFloat(b.dataset.sp)); });
    document.querySelectorAll('.zm').forEach(b => b.onclick = () => {
      document.querySelectorAll('.zm').forEach(x => x.classList.toggle('act', x === b));
      const z = parseFloat(b.dataset.z);
      if (z === 1) { main.style.width = ''; main.style.maxWidth = ''; }
      else { main.style.maxWidth = 'none'; main.style.width = Math.round(Math.max(innerWidth, 940) * z) + 'px'; }
      requestAnimationFrame(() => sys.scrollIntoView({ block: 'center', inline: 'center' }));
    });
    $('bar').oninput = () => { setT($('bar').value / 1000 * dur()); render(true); };
    $('loop').onclick = () => {
      if (loopB !== null || (loopA !== null && loopMode === false)) clearLoop();
      else if (loopMode) clearLoop();
      else { loopMode = true; paintLoop(); }
    };
    $('acc').onclick = async () => {
      accOn = !accOn;
      paintParts();
      if (needsWA()) { await useEngine(WA); if (!E.paused) { E.pause(); await E.play(); } }
      else if (E === WA) await useEngine(EL);
    };
    $('accvol').oninput = () => {
      accVol = +$('accvol').value / 100;
      if (WA.gacc) WA.gacc.gain.value = accVol;
    };
    const bump = v => { syncOff = Math.round((syncOff + v) * 10) / 10; localStorage.setItem('sync-' + songId, syncOff); showSync(); render(true); };
    $('syncm').onclick = () => bump(-0.2);
    $('syncp').onclick = () => bump(0.2);
    $('sync').onclick = () => { syncOff = 0; localStorage.setItem('sync-' + songId, 0); showSync(); render(true); };
    try { syncOff = +(localStorage.getItem('sync-' + songId) || 0) || 0; } catch (e) { }
    showSync();
    $('dl').onclick = saveOffline;
    $('rf').onclick = async () => {
      if (isLocal()) { alert(tr('rf.local')); return; }
      if (!confirm(tr('rf.confirm'))) return;
      try { await caches.delete('songs-' + songId); } catch (e) { }
      location.reload();
    };
    addEventListener('resize', fit);
    addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); seekM(Math.min(D.measures.length, mAt(T()) + 1)); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); seekM(Math.max(1, mAt(T()) - 1)); }
    });
    paintParts();
  }

  function isLocal() {
    try { return JSON.parse(localStorage.getItem('localSongs') || '[]').some(s => s.id === songId); }
    catch (e) { return false; }
  }
  async function saveOffline() {
    const btn = $('dl');
    if (!('caches' in window)) { dlState = 'unsupported'; paintDl(); return; }
    if (isLocal()) { dlState = 'local'; paintDl(); return; }
    btn.disabled = true; dlState = 'saving'; paintDl();
    try {
      const urls = await Promise.all(
        [base + 'song.json', 'player.html', 'player.js', 'i18n.js', 'app.css', 'index.html']
          .concat(Array.from({ length: D.pages }, (_, i) => base + 'p' + (i + 1) + '.webp'))
          .concat(parts.map(p => base + p.id + '.mp3'))
          .concat(accId ? [base + accId + '.mp3'] : [])
          .map(u => realURL(u)));
      await (await caches.open('songs-' + songId)).addAll(urls);
      dlState = 'done';
    } catch (e) { dlState = 'fail'; }
    paintDl();
    btn.disabled = false;
  }

  function render(force) {
    if (!D) return;
    const t = mt();
    if (loopB !== null && (t >= D.times[loopB] || t < D.times[loopA - 1] - 0.6)) { setT(D.times[loopA - 1] - syncOff + EPS); return; }
    const m = mAt(t), o = D.measures[m - 1];
    $('bar').value = Math.min(1000, T() / dur() * 1000);
    $('tm').textContent = fmt(T()) + ' / ' + fmt(dur());
    $('mn').textContent = tr('bar.n', { n: m });
    if (m !== cur || force) {
      cur = m;
      ovs[o.pg].append(sys);
      sys.style.cssText = `left:${o.x}%;width:${o.w}%;top:${o.sy[0]}%;height:${o.sy[1]}%`;
      parts.forEach((p, i) => {
        const el = hls[p.id];
        if (!sel.includes(p.id)) { el.remove(); return; }
        const b = (D.band === 'system') ? [o.sy[0], o.sy[1]] : o.b[Math.min(i, o.b.length - 1)];
        const c = rgb(p.color);
        ovs[o.pg].appendChild(el);
        el.style.cssText = `left:${o.x}%;width:${o.w}%;top:${b[0]}%;height:${b[1]}%;` +
          `background:rgba(${c},.30);box-shadow:0 0 0 2px rgba(${c},.75) inset`;
      });
      const r = sys.getBoundingClientRect();
      if (r.top < 90 || r.bottom > innerHeight - 16 || r.left < 0 || r.right > innerWidth)
        sys.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }
    upd();
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
