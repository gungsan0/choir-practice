/* 울림 합창 연습실 — 악보 따라가기 플레이어
   · 한 파트만 들을 때  : <audio> 사용 (속도 조절 시 음정 유지)
   · 두 파트 이상 겹칠 때: Web Audio 로 완전히 같은 시각에 재생 (밀림 없음)      */
(function () {
  const $ = id => document.getElementById(id);
  const songId = new URLSearchParams(location.search).get('song');
  const main = $('main'), hdr = document.querySelector('header'), spacer = $('spacer');
  if (!songId) { location.replace('index.html'); return; }
  const base = 'songs/' + songId + '/';

  let D = null, parts = [], sel = [], els = {}, cur = -1, rate = 1;
  let loopA = null, loopB = null, multi = false;
  const ovs = [], sys = div('sys'), ph = div('ph'), lmk = div('loopmark'), hls = {};

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
    ctx: null, buf: {}, src: [], gain: null, at: 0, off: 0, on: false,
    async ready(ids) {
      if (!this.ctx) {
        const C = window.AudioContext || window.webkitAudioContext;
        try { this.ctx = new C({ sampleRate: 32000 }); } catch (e) { this.ctx = new C(); }
        this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const need = ids.filter(id => !this.buf[id]);
      if (need.length) {
        setStatus('음원 준비 중…');
        await Promise.all(need.map(async id => {
          const r = await fetch(base + id + '.mp3');
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
      const t0 = this.ctx.currentTime + 0.06;
      this.src = ids.map(id => {
        const s = this.ctx.createBufferSource();
        s.buffer = this.buf[id]; s.playbackRate.value = rate;
        s.connect(this.gain); s.start(t0, Math.min(this.off, s.buffer.duration - .01));
        return s;
      });
      this.at = t0; this.on = true;
    },
    async play() { await this.ready(sel); this.start(); },
    pause() { if (this.on) { const t = this.time; this.stop(); this.off = t; } },
    stop() { this.src.forEach(s => { try { s.stop(); } catch (e) { } }); this.src = []; this.on = false; },
    setRate(r) { if (this.on) { const t = this.time; this.stop(); this.off = t; rate = r; this.start(); } }
  };

  let E = EL;                                    // 현재 엔진
  const T = () => E.time;
  const setT = t => { E.time = Math.max(0, Math.min(t, dur())); };

  async function useEngine(next) {
    if (E === next) return;
    const t = T(), playing = !E.paused;
    E.stop(); E = next;
    if (next === WA) { await WA.ready(sel); }
    else EL.use(sel[0]);
    E.time = t;
    if (playing) await E.play();
    upd();
  }

  /* ── 초기화 ─────────────────────────────────────────────── */
  fetch(base + 'song.json').then(r => { if (!r.ok) throw 0; return r.json(); }).then(init)
    .catch(() => { main.innerHTML = '<div class="hint" style="display:block">곡을 불러오지 못했습니다. <a href="index.html" style="text-decoration:underline">목록으로</a></div>'; });

  function init(song) {
    D = song; parts = song.parts; sel = [parts[0].id];
    document.title = song.title + ' — 울림 합창 연습실';
    $('ttl').textContent = song.title;
    $('foot').textContent = (song.subtitle ? song.subtitle + ' · ' : '') + '파트별 강조 음원 ' + parts.length + '종';

    $('parts').innerHTML = parts.map((p, i) =>
      `<button class="part${i === 0 ? ' on' : ''}" data-p="${p.id}"${i === 0 ? ` style="background:${p.color}"` : ''}>${p.name}</button>`).join('');

    for (let i = 0; i < song.pages; i++) {
      const d = div('page'), img = new Image();
      img.src = base + 'p' + (i + 1) + '.webp'; img.alt = '악보 ' + (i + 1) + '쪽';
      img.loading = i < 2 ? 'eager' : 'lazy';
      const ov = div('ov'); d.append(img, ov); main.appendChild(d); ovs.push(ov);
    }
    D.measures.forEach(m => {
      const h = div('hit');
      h.style.cssText = `left:${m.x}%;width:${m.w}%;top:${m.sy[0]}%;height:${m.sy[1]}%`;
      h.title = '마디 ' + m.m;
      h.onclick = e => e.shiftKey ? setLoop(m.m) : seekM(m.m);
      ovs[m.pg].appendChild(h);
    });
    parts.forEach(p => { hls[p.id] = div('hl'); });

    parts.forEach((p, i) => { const a = new Audio(); a.src = base + p.id + '.mp3'; a.preload = i === 0 ? 'auto' : 'metadata'; els[p.id] = a; });
    EL.use(sel[0]);
    addEventListener('load', () => setTimeout(() => parts.slice(1).forEach(p => fetch(base + p.id + '.mp3').catch(() => { })), 2000));

    wire(); fit(); render(true);
    if (isLocal()) { $('dl').textContent = '✓ 이 기기에 저장됨'; $('dl').classList.add('act'); }
    (function loop() { render(false); requestAnimationFrame(loop); })();
  }

  const fit = () => { spacer.style.height = hdr.offsetHeight + 'px'; };
  const setStatus = s => { $('st').textContent = s; };

  function mAt(t) {
    if (t < D.times[0]) return 1;
    let lo = 0, hi = D.measures.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (D.times[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo + 1;
  }
  const seekM = m => { setT(D.times[m - 1]); render(true); };
  const upd = () => { $('play').innerHTML = E.paused ? '&#9654;' : '&#10074;&#10074;'; };

  function setLoop(m) {
    if (loopA === null || loopB !== null) { loopA = m; loopB = null; } else { loopB = Math.max(m, loopA); }
    $('lp').textContent = loopB !== null ? ('🔁 ' + loopA + '~' + loopB + ' 마디') : ('🔁 시작 ' + loopA + ' 마디 — 끝 마디를 Shift+클릭');
    const a = D.measures[loopA - 1], b = D.measures[(loopB || loopA) - 1];
    lmk.remove();
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
    $('mix').textContent = multi ? '겹쳐 듣기 ON' : '겹쳐 듣기';
    document.querySelectorAll('[data-sp]').forEach(b => {
      const off = sel.length > 1 && b.dataset.sp !== '1';
      b.disabled = off; b.style.opacity = off ? .35 : 1;
      b.title = off ? '여러 파트를 겹쳐 들을 때는 1배속만 지원합니다' : '';
    });
    if (sel.length > 1 && rate !== 1) setRate(1);
  }

  async function pickPart(id) {
    if (multi) {
      if (sel.includes(id)) { if (sel.length > 1) sel = sel.filter(x => x !== id); }
      else sel = parts.map(p => p.id).filter(p => sel.includes(p) || p === id);   // 악보 순서 유지
    } else sel = [id];
    paintParts();
    if (sel.length > 1) { await useEngine(WA); if (!E.paused) { E.pause(); await E.play(); } }
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
    $('clr').onclick = () => { loopA = loopB = null; lmk.remove(); $('lp').textContent = ''; };
    $('dl').onclick = saveOffline;
    $('rf').onclick = async () => {
      if (isLocal()) { alert('이 곡은 이 기기에서 추가한 곡이라 다시 받을 원본이 없습니다.\n곡 목록에서 “다시 만들기”를 눌러주세요.'); return; }
      if (!confirm('이 곡의 악보·음원을 최신으로 다시 받을까요?')) return;
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
    if (!('caches' in window)) { btn.textContent = '이 브라우저는 미지원'; return; }
    if (isLocal()) { btn.textContent = '✓ 이 기기에 저장됨'; btn.classList.add('act'); return; }
    btn.disabled = true; btn.textContent = '저장 중…';
    try {
      const urls = [base + 'song.json', 'player.html', 'player.js', 'app.css', 'index.html']
        .concat(Array.from({ length: D.pages }, (_, i) => base + 'p' + (i + 1) + '.webp'))
        .concat(parts.map(p => base + p.id + '.mp3'));
      await (await caches.open('songs-' + songId)).addAll(urls);
      btn.textContent = '✓ 저장됨'; btn.classList.add('act');
    } catch (e) { btn.textContent = '저장 실패'; }
    btn.disabled = false;
  }

  function render(force) {
    if (!D) return;
    const t = T();
    if (loopB !== null && (t >= D.times[loopB] || t < D.times[loopA - 1] - 0.6)) { setT(D.times[loopA - 1]); return; }
    const m = mAt(t), o = D.measures[m - 1];
    $('bar').value = Math.min(1000, t / dur() * 1000);
    $('tm').textContent = fmt(t) + ' / ' + fmt(dur());
    $('mn').textContent = '마디 ' + m;
    if (m !== cur || force) {
      cur = m;
      ovs[o.pg].append(sys, ph);
      sys.style.cssText = `left:${o.x}%;width:${o.w}%;top:${o.sy[0]}%;height:${o.sy[1]}%`;
      parts.forEach((p, i) => {
        const el = hls[p.id];
        if (!sel.includes(p.id)) { el.remove(); return; }
        const b = o.b[Math.min(i, o.b.length - 1)], c = rgb(p.color);
        ovs[o.pg].appendChild(el);
        el.style.cssText = `left:${o.x}%;width:${o.w}%;top:${b[0]}%;height:${b[1]}%;` +
          `background:rgba(${c},.30);box-shadow:0 0 0 2px rgba(${c},.75) inset`;
      });
      ph.style.top = o.sy[0] + '%'; ph.style.height = o.sy[1] + '%';
      const r = sys.getBoundingClientRect();
      if (r.top < 90 || r.bottom > innerHeight - 16 || r.left < 0 || r.right > innerWidth)
        sys.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }
    const f = Math.min(1, Math.max(0, (t - D.times[m - 1]) / (D.times[m] - D.times[m - 1])));
    ph.style.left = (o.x + o.w * f) + '%';
    upd();
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
