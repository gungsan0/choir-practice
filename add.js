/* 곡 추가 — 브라우저에서 악보 분석 · 음원 대조 · 저장/공개까지 */
import * as pdfjs from './vendor/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const $ = id => document.getElementById(id);
const PALETTE = ["#e0483c", "#1f9d55", "#2f6fe0", "#8b5cf6", "#e08a1e", "#0d9488", "#d6336c", "#4b5563"];
const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|flac|aif|aiff)$/i;
const SCALE = 150 / 72;                       // 150dpi 상당

const F = { pdf: null, score: null, audio: {} };   // 올린 파일
let SC = null;                                     // mscz 해석 결과
let PAGES = [];                                    // {canvas, w, h}
let LAY = null;                                    // 분석 결과
let SONG = null;                                   // 완성된 song.json
let detOnsets = null;                              // 음원에서 찾은 음 시작점

const prog = t => { $('prog').textContent = t; };
const slug = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'song';

/* ───────────────────────── 파일 받기 */
const drop = $('drop'), input = $('files');
drop.onclick = () => input.click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); take([...e.dataTransfer.files]); };
input.onchange = () => take([...input.files]);

function take(list) {
  for (const f of list) {
    if (/\.pdf$/i.test(f.name)) F.pdf = f;
    else if (/\.(mscz|mscx)$/i.test(f.name)) F.score = f;
    else if (AUDIO_RE.test(f.name)) {
      const m = f.name.match(/\[([^\]]+)\]/);
      F.audio[m ? m[1].trim() : f.name.replace(AUDIO_RE, '')] = f;
    }
  }
  paintFiles();
}

function paintFiles() {
  const rows = [];
  if (F.pdf) rows.push(['악보', F.pdf.name]);
  if (F.score) rows.push(['MuseScore', F.score.name]);
  for (const k in F.audio) rows.push(['음원 · ' + k, F.audio[k].name]);
  $('filelist').innerHTML = rows.map(r => `<div class="f"><b>${r[0]}</b><span>${r[1]}</span></div>`).join('');
  const names = Object.keys(F.audio);
  const ok = F.pdf && names.length;
  $('s2').hidden = $('s3').hidden = !ok;
  if (!ok) return;
  if (!$('title').value) $('title').value = F.pdf.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ');
  if (!$('sid').value) $('sid').value = slug($('title').value);
  if (!$('order').value) $('order').value = names.join(',');
  $('title').oninput = () => { $('sid').value = slug($('title').value); };
}

/* ───────────────────────── MuseScore 파일 해석 */
const DUR = { measure: 4, breve: 8, whole: 4, half: 2, quarter: 1, eighth: .5, '16th': .25, '32nd': .125, '64th': 1 / 16, '128th': 1 / 32 };

async function readScore(file) {
  let xml;
  const buf = new Uint8Array(await file.arrayBuffer());
  if (/\.mscz$/i.test(file.name)) {
    const z = fflate.unzipSync(buf);
    const key = Object.keys(z).find(k => /\.mscx$/i.test(k));
    if (!key) return null;
    xml = new TextDecoder().decode(z[key]);
  } else xml = new TextDecoder().decode(buf);

  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const score = doc.querySelector('Score'); if (!score) return null;
  const parts = [...score.querySelectorAll(':scope > Part')].map(p =>
    (p.querySelector(':scope > trackName') || p.querySelector('Instrument > longName') || {}).textContent || 'Part');
  const staves = [...score.querySelectorAll(':scope > Staff')];
  if (!staves.length) return null;
  const measures0 = [...staves[0].querySelectorAll(':scope > Measure')];

  let sig = 4, beats = [];
  measures0.forEach(m => {
    const ts = m.querySelector('TimeSig');
    if (ts) sig = (+ts.querySelector('sigN').textContent) * 4 / (+ts.querySelector('sigD').textContent);
    const ln = m.getAttribute('len');
    beats.push(ln ? (+ln.split('/')[0]) * 4 / (+ln.split('/')[1]) : sig);
  });

  const tempo = {};
  staves.forEach(st => [...st.querySelectorAll(':scope > Measure')].forEach((m, i) => {
    const t = m.querySelector('Tempo > tempo');
    if (t && !(i + 1 in tempo)) tempo[i + 1] = Math.round(+t.textContent * 60 * 1e4) / 1e4;
  }));

  const onsets = new Set();
  staves.forEach(st => [...st.querySelectorAll(':scope > Measure')].forEach((m, i) => {
    const start = beats.slice(0, i).reduce((a, b) => a + b, 0);
    m.querySelectorAll(':scope > voice').forEach(v => {
      let pos = 0;
      [...v.children].forEach(e => {
        if (e.tagName !== 'Chord' && e.tagName !== 'Rest') return;
        const dt = (e.querySelector(':scope > durationType') || {}).textContent;
        let d = DUR[dt] || 0;
        const dots = e.querySelector(':scope > dots');
        if (dots) d *= 2 - Math.pow(.5, +dots.textContent);
        if (e.tagName === 'Chord') onsets.add(+(start + pos).toFixed(4));
        pos += d;
      });
    });
  }));
  return { parts, measures: measures0.length, beats, tempo, onsets: [...onsets].sort((a, b) => a - b) };
}

/* ───────────────────────── 악보 → 이미지 → 마디 찾기 */
async function renderPdf(file) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    prog(`악보 ${i}/${doc.numPages}쪽 그리는 중…`);
    const pg = await doc.getPage(i);
    const vp = pg.getViewport({ scale: SCALE });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: cx, viewport: vp }).promise;
    out.push(cv);
    await new Promise(r => setTimeout(r));
  }
  return out;
}

function pageData(cv) {                       // 검은 픽셀 여부 비트맵
  const { width: W, height: H } = cv;
  const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const bin = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < d.length; i += 4, p++)
    bin[p] = (d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) < 128 ? 1 : 0;
  return { bin, W, H };
}

function staffLines({ bin, W, H }) {
  const rows = [];
  for (let y = 0; y < H; y++) {
    let s = 0, o = y * W;
    for (let x = 0; x < W; x++) s += bin[o + x];
    if (s > W * .4) rows.push(y);
  }
  const groups = [];
  let cur = [];
  rows.forEach(y => {
    if (!cur.length || y - cur[cur.length - 1] <= 2) cur.push(y);
    else { groups.push(cur); cur = [y]; }
  });
  if (cur.length) groups.push(cur);
  const centers = groups.map(g => Math.round(g.reduce((a, b) => a + b) / g.length));
  if (centers.length % 5) return null;
  const staves = [];
  for (let i = 0; i < centers.length; i += 5) staves.push(centers.slice(i, i + 5));
  return staves;
}

function colSets({ bin, W }, staff) {
  const y0 = staff[0], y1 = staff[4], h = y1 - y0 + 1, out = new Uint8Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = y0; y <= y1; y++) s += bin[y * W + x];
    out[x] = s >= h * .95 ? 1 : 0;
  }
  return out;
}

function barsOf(cols, W) {
  const common = [];
  for (let x = 0; x < W; x++) { if (cols.every(c => c[x])) common.push(x); }
  if (common.length < 2) return [];
  const tol = Math.max(4, Math.floor(W / 90)), bars = [];
  let c = [common[0]];
  for (let i = 1; i < common.length; i++) {
    if (common[i] - c[c.length - 1] <= tol) c.push(common[i]);
    else { bars.push(Math.round(c.reduce((a, b) => a + b) / c.length)); c = [common[i]]; }
  }
  bars.push(Math.round(c.reduce((a, b) => a + b) / c.length));
  return bars;
}

function groupSystems(staves, k) {
  if (k) { const o = []; for (let i = 0; i < staves.length; i += k) o.push(staves.slice(i, i + k)); return o; }
  const gaps = staves.slice(1).map((s, i) => s[0] - staves[i][4]);
  if (!gaps.length) return [staves];
  const srt = [...gaps].sort((a, b) => a - b);
  let best = -1, thr = srt[0] + 1;
  for (let i = 0; i < srt.length - 1; i++) if (srt[i + 1] - srt[i] > best) { best = srt[i + 1] - srt[i]; thr = (srt[i] + srt[i + 1]) / 2; }
  const out = []; let cur = [staves[0]];
  gaps.forEach((g, i) => { if (g > thr) { out.push(cur); cur = [staves[i + 1]]; } else cur.push(staves[i + 1]); });
  out.push(cur);
  return out;
}

function analyzeLayout(pages, expect, forceK) {
  const data = pages.map(cv => {
    const pd = pageData(cv);
    const staves = staffLines(pd);
    if (!staves) throw new Error('오선을 찾지 못했습니다. 악보 PDF가 맞는지 확인해주세요.');
    return { pd, staves, cols: staves.map(s => colSets(pd, s)) };
  });

  const build = k => {
    const out = []; let total = 0;
    for (const p of data) {
      const ps = [];
      for (const sysv of groupSystems(p.staves, k)) {
        const bars = barsOf(sysv.map(s => p.cols[p.staves.indexOf(s)]), p.pd.W);
        if (bars.length < 2) return null;
        total += bars.length - 1;
        ps.push({ staves: sysv.map(s => [s[0], s[4]]), bars });
      }
      out.push(ps);
    }
    return { pages: out, total, k: k || (data[0].staves.length / out[0].length) };
  };

  let chosen = null;
  const ks = forceK ? [forceK] : [...Array(8).keys()].map(i => i + 1)
    .filter(k => data.every(p => p.staves.length % k === 0)).concat([null]);
  for (const k of ks) {
    const r = build(k);
    if (!r) continue;
    if (expect && r.total === expect) { chosen = r; break; }
    if (!chosen) chosen = r;
  }
  if (!chosen) throw new Error('마디선을 찾지 못했습니다.');
  chosen.W = data[0].pd.W; chosen.H = data[0].pd.H;
  return chosen;
}

function measuresFrom(lay) {
  const { W, H } = lay, out = [];
  let n = 0;
  lay.pages.forEach((page, pi) => page.forEach(s => {
    const st = s.staves, bands = st.map(([y0, y1], i) => {
      let top = y0 - 22, bot = y1 + 42;
      if (i < st.length - 1) bot = Math.min(bot, st[i + 1][0] - 12);
      return [top, bot];
    });
    for (let i = 0; i < s.bars.length - 1; i++) {
      n++;
      out.push({
        m: n, pg: pi,
        x: +(s.bars[i] / W * 100).toFixed(4), w: +((s.bars[i + 1] - s.bars[i]) / W * 100).toFixed(4),
        b: bands.map(([t, b]) => [+(t / H * 100).toFixed(4), +((b - t) / H * 100).toFixed(4)]),
        sy: [+((st[0][0] - 30) / H * 100).toFixed(4), +((st[st.length - 1][1] + 45 - st[0][0] + 30) / H * 100).toFixed(4)]
      });
    }
  }));
  return out;
}

/* ───────────────────────── 음원에서 음 시작점 찾기 (spectral flux) */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]];[im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

function onsetTimes(buf) {
  const sr = buf.sampleRate, x = buf.getChannelData(0);
  const N = 1024, hop = 512, frames = Math.floor((x.length - N) / hop);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = .5 - .5 * Math.cos(2 * Math.PI * i / N);
  let prev = new Float32Array(N / 2), flux = new Float32Array(Math.max(0, frames));
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let s = 0;
    for (let i = 0; i < N / 2; i++) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      const d = mag - prev[i]; if (d > 0) s += d;
      prev[i] = mag;
    }
    flux[f] = s;
  }
  // 정규화 + 피크 뽑기
  const times = [], w = 12;
  for (let f = 2; f < frames - 2; f++) {
    let mean = 0, cnt = 0;
    for (let k = Math.max(0, f - w); k <= Math.min(frames - 1, f + w); k++) { mean += flux[k]; cnt++; }
    mean /= cnt;
    if (flux[f] > mean * 1.6 && flux[f] >= flux[f - 1] && flux[f] > flux[f + 1] && flux[f] > 0) {
      const t = (f * hop + N / 2) / sr;
      if (!times.length || t - times[times.length - 1] > 0.05) times.push(t);
    }
  }
  return times;
}

function measureStarts(beats, tempoMap, firstBpm, offset) {
  let bpm = firstBpm, t = offset, out = [];
  for (let m = 1; m <= beats.length; m++) {
    if (tempoMap[m]) bpm = tempoMap[m];
    out.push(t); t += beats[m - 1] * 60 / bpm;
  }
  out.push(t);
  return out;
}

function fitTempo(score, det) {
  const beats = score.beats, cum = [0];
  beats.forEach(b => cum.push(cum[cum.length - 1] + b));
  const near = t => {                       // 가장 가까운 실제 음 시작점과의 차이
    let lo = 0, hi = det.length - 1;
    if (!det.length) return 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (det[mid] < t) lo = mid + 1; else hi = mid; }
    let best = Math.abs(det[lo] - t);
    if (lo > 0) best = Math.min(best, Math.abs(det[lo - 1] - t));
    return best;
  };
  let best = null;
  for (let bpm = 40; bpm <= 160; bpm += 0.25) {
    const st = measureStarts(beats, score.tempo, bpm, 0);
    for (let off = 0; off < 0.5; off += 0.02) {
      let sum = 0;
      for (const b of score.onsets) {
        let i = 0, lo = 0, hi = beats.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= b) lo = mid; else hi = mid - 1; }
        i = lo;
        const fr = (b - cum[i]) / beats[i];
        sum += Math.min(near(st[i] + fr * (st[i + 1] - st[i]) + off), 0.3);
      }
      const sc = sum / score.onsets.length;
      if (!best || sc < best.score) best = { score: sc, bpm, off };
    }
  }
  return best;
}

/* ───────────────────────── 분석 실행 */
$('analyze').onclick = () => run(true);
$('redo').onclick = () => run(false);

async function run(fresh) {
  try {
    $('analyze').disabled = true;
    if (fresh) {
      prog('악보를 여는 중…');
      PAGES = await renderPdf(F.pdf);
      SC = F.score ? await readScore(F.score) : null;
      detOnsets = null;
    }
    const order = $('order').value.split(',').map(s => s.trim()).filter(Boolean);
    const missing = order.filter(p => !F.audio[p]);
    if (missing.length) throw new Error('음원이 없는 파트: ' + missing.join(', '));

    prog('마디선을 찾는 중…');
    await new Promise(r => setTimeout(r, 20));
    LAY = analyzeLayout(PAGES, SC && SC.measures, +$('sps').value || null);
    const meas = measuresFrom(LAY);

    // 템포
    let bpm = +$('bpm').value || null, off = $('off').value === '' ? null : +$('off').value;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const abuf = await ctx.decodeAudioData(await F.audio[order[0]].arrayBuffer());
    const duration = abuf.duration;
    if (SC && (bpm === null || off === null)) {
      if (!detOnsets) { prog('음원의 음 시작점을 찾는 중…'); await new Promise(r => setTimeout(r, 20)); detOnsets = onsetTimes(abuf); }
      prog('악보와 음원을 맞춰보는 중…');
      await new Promise(r => setTimeout(r, 20));
      const fit = fitTempo(SC, detOnsets);
      if (fit) { bpm = bpm ?? fit.bpm; off = off ?? fit.off; LAY.fit = fit; }
    }
    if (bpm === null) bpm = (SC && SC.tempo[1]) || 120;
    if (off === null) off = 0;
    ctx.close();

    const beats = (SC ? [...SC.beats] : []);
    while (beats.length < meas.length) beats.push(beats.length ? beats[beats.length - 1] : 4);
    const times = measureStarts(beats.slice(0, meas.length), SC ? SC.tempo : {}, bpm, off).map(t => +t.toFixed(4));
    times[times.length - 1] = Math.max(times[times.length - 1], duration);

    SONG = {
      id: slug($('sid').value), title: $('title').value.trim() || '제목 없음',
      subtitle: $('subtitle').value.trim(),
      parts: order.map((p, i) => ({ id: p, name: p, color: PALETTE[i % PALETTE.length] })),
      pages: PAGES.length, duration: +duration.toFixed(2), measures: meas, times
    };

    $('sps').value = LAY.k; $('bpm').value = bpm; $('off').value = +off.toFixed(2);
    $('result').hidden = false; $('s4').hidden = false;
    $('stats').innerHTML = [
      ['악보', PAGES.length + '쪽 · 한 단에 오선 ' + LAY.k + '개'],
      ['마디', meas.length + '개' + (SC ? (meas.length === SC.measures ? ' <b class="ok">✓ 악보 파일과 일치</b>'
        : ` <b class="warn">⚠ MuseScore 파일은 ${SC.measures}개</b>`) : '')],
      ['파트', order.join(' → ')],
      ['길이', Math.floor(duration / 60) + '분 ' + Math.round(duration % 60) + '초'],
      ['템포', bpm + ' BPM 시작' + (LAY.fit ? ` · 음원 대조 오차 ${LAY.fit.score.toFixed(3)}초` : ' (직접 지정)')]
    ].map(r => `<div><span>${r[0]}</span>${r[1]}</div>`).join('');
    drawPreview();
    prog('완료');
  } catch (e) {
    prog('');
    alert('분석 실패: ' + (e.message || e));
    console.error(e);
  } finally { $('analyze').disabled = false; }
}

function drawPreview() {
  const box = $('preview'); box.innerHTML = '';
  PAGES.slice(0, 2).forEach((cv, pi) => {
    const wrap = document.createElement('div'); wrap.className = 'pv';
    const img = new Image(); img.src = cv.toDataURL('image/webp', .8); wrap.appendChild(img);
    SONG.measures.filter(m => m.pg === pi).forEach(m => {
      m.b.forEach((b, i) => {
        const d = document.createElement('i');
        d.style.cssText = `left:${m.x}%;width:${m.w}%;top:${b[0]}%;height:${b[1]}%;background:${PALETTE[i % PALETTE.length]}33;outline:1px solid ${PALETTE[i % PALETTE.length]}99`;
        wrap.appendChild(d);
      });
      const n = document.createElement('span');
      n.textContent = m.m; n.style.cssText = `left:${m.x}%;top:${Math.max(0, m.sy[0] - 1.4)}%`;
      wrap.appendChild(n);
    });
    box.appendChild(wrap);
  });
}

/* 30초 미리 듣기 — 하이라이트가 소리와 맞는지 확인 */
let testAudio = null, raf = 0;
$('ptest').onclick = () => {
  if (testAudio) { testAudio.pause(); testAudio = null; cancelAnimationFrame(raf); $('ptest').textContent = '▶ 30초 들으며 확인'; $('ptxt').textContent = ''; return; }
  const first = SONG.parts[0].id;
  testAudio = new Audio(URL.createObjectURL(F.audio[first]));
  testAudio.currentTime = Math.max(0, SONG.times[0]);
  testAudio.play();
  $('ptest').textContent = '■ 정지';
  const tick = () => {
    const t = testAudio.currentTime;
    let m = 1;
    for (let i = 0; i < SONG.measures.length; i++) if (SONG.times[i] <= t) m = i + 1;
    $('ptxt').textContent = `${t.toFixed(1)}초 · 지금 ${m}마디`;
    [...$('preview').querySelectorAll('.pv')].forEach(w => w.classList.remove('cue'));
    const box = $('preview').children[SONG.measures[m - 1].pg];
    if (box) {
      box.classList.add('cue');
      box.style.setProperty('--x', SONG.measures[m - 1].x + '%');
      box.style.setProperty('--w', SONG.measures[m - 1].w + '%');
      box.style.setProperty('--y', SONG.measures[m - 1].sy[0] + '%');
      box.style.setProperty('--h', SONG.measures[m - 1].sy[1] + '%');
    }
    if (t > SONG.times[0] + 30) { $('ptest').click(); return; }
    raf = requestAnimationFrame(tick);
  };
  tick();
};

/* ───────────────────────── 결과 만들기 (webp 이미지 + 원본 음원) */
async function buildFiles() {
  const out = {};
  out['song.json'] = new Blob([JSON.stringify(SONG)], { type: 'application/json' });
  for (let i = 0; i < PAGES.length; i++)
    out['p' + (i + 1) + '.webp'] = await new Promise(r => PAGES[i].toBlob(r, 'image/webp', .88));
  for (const p of SONG.parts) out[p.id + '.mp3'] = F.audio[p.id];
  return out;
}

/* 이 기기에 저장 — 플레이어가 그대로 읽을 수 있도록 캐시에 넣는다 */
$('save').onclick = async () => {
  const btn = $('save'); btn.disabled = true; $('savemsg').textContent = '저장 중…';
  try {
    const files = await buildFiles();
    const c = await caches.open('songs-' + SONG.id);
    const root = new URL('.', location.href).href;
    for (const name in files) {
      const body = files[name];
      await c.put(root + 'songs/' + SONG.id + '/' + name,
        new Response(body, { status: 200, headers: { 'Content-Type': body.type || 'application/octet-stream', 'Content-Length': String(body.size) } }));
    }
    const local = JSON.parse(localStorage.getItem('localSongs') || '[]').filter(s => s.id !== SONG.id);
    local.push({ id: SONG.id, title: SONG.title, subtitle: SONG.subtitle, parts: SONG.parts.map(p => p.id), pages: SONG.pages, duration: SONG.duration, measures: SONG.measures.length, local: true });
    localStorage.setItem('localSongs', JSON.stringify(local));
    $('savemsg').innerHTML = `저장했습니다. <a href="player.html?song=${SONG.id}">바로 연습하기 →</a>`;
  } catch (e) { $('savemsg').textContent = '저장 실패: ' + e.message; }
  btn.disabled = false;
};

/* zip 내려받기 */
$('zip').onclick = async () => {
  $('savemsg').textContent = 'zip 만드는 중…';
  const files = await buildFiles(), z = {};
  for (const name in files) z['songs/' + SONG.id + '/' + name] = new Uint8Array(await files[name].arrayBuffer());
  z['songs/' + SONG.id + '/README.txt'] = new TextEncoder().encode(
    'songs/ 폴더를 앱 폴더에 그대로 넣고, songs/index.json 에 이 곡을 추가하세요.\n' + JSON.stringify(entry(), null, 2));
  const blob = new Blob([fflate.zipSync(z)], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = SONG.id + '.zip'; a.click();
  $('savemsg').textContent = '내려받았습니다.';
};

const entry = () => ({ id: SONG.id, title: SONG.title, subtitle: SONG.subtitle, parts: SONG.parts.map(p => p.id), pages: SONG.pages, duration: SONG.duration, measures: SONG.measures.length });

/* ───────────────────────── GitHub 공개 */
const GH = {
  get cfg() { return JSON.parse(localStorage.getItem('gh') || '{}'); },
  set cfg(v) { localStorage.setItem('gh', JSON.stringify(v)); },
  async api(path, opt = {}) {
    const c = GH.cfg;
    const r = await fetch('https://api.github.com/repos/' + c.repo + path, {
      ...opt, headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github+json', ...(opt.headers || {}) }
    });
    if (!r.ok && r.status !== 404) throw new Error('GitHub ' + r.status + ' — ' + (await r.text()).slice(0, 160));
    return r.status === 404 ? null : r.json();
  },
  async put(path, blob, msg) {
    const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
    const cur = await GH.api('/contents/' + path + '?ref=' + (GH.cfg.branch || 'main'));
    return GH.api('/contents/' + path, {
      method: 'PUT',
      body: JSON.stringify({ message: msg, content: b64, branch: GH.cfg.branch || 'main', ...(cur && cur.sha ? { sha: cur.sha } : {}) })
    });
  }
};

for (const [k, el] of Object.entries({ repo: 'ghrepo', branch: 'ghbranch', token: 'ghtoken' })) {
  $(el).value = GH.cfg[k] || (k === 'branch' ? 'main' : '');
  $(el).oninput = () => { GH.cfg = { ...GH.cfg, [k]: $(el).value.trim() }; };
}
$('ghtest').onclick = async () => {
  try { const r = await GH.api(''); $('savemsg').textContent = r ? `연결됨: ${r.full_name}` : '저장소를 찾을 수 없습니다.'; }
  catch (e) { $('savemsg').textContent = e.message; }
};
$('pub').onclick = async () => {
  if (!GH.cfg.repo || !GH.cfg.token) { $('ghbox').open = true; $('savemsg').textContent = '먼저 GitHub 저장소와 토큰을 입력해주세요.'; return; }
  const btn = $('pub'); btn.disabled = true;
  try {
    const files = await buildFiles();
    let i = 0;
    for (const name in files) {
      i++; $('savemsg').textContent = `업로드 중… (${i}/${Object.keys(files).length + 1}) ${name}`;
      await GH.put('songs/' + SONG.id + '/' + name, files[name], 'add ' + SONG.id + '/' + name);
    }
    $('savemsg').textContent = '곡 목록 갱신 중…';
    const cur = await GH.api('/contents/songs/index.json?ref=' + (GH.cfg.branch || 'main'));
    let idx = { songs: [] };
    if (cur && cur.content) { try { idx = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cur.content.replace(/\n/g, '')), ch => ch.charCodeAt(0)))); } catch (e) { } }
    idx.songs = (idx.songs || []).filter(s => s.id !== SONG.id).concat([entry()]).sort((a, b) => a.title.localeCompare(b.title));
    await GH.put('songs/index.json', new Blob([JSON.stringify(idx, null, 2)], { type: 'application/json' }), 'update song list');
    $('savemsg').innerHTML = '공개했습니다. 1~2분 뒤 사이트에 반영됩니다. <a href="index.html">곡 목록 →</a>';
  } catch (e) { $('savemsg').textContent = '공개 실패: ' + e.message; }
  btn.disabled = false;
};

/* 기존 곡 다시 만들기 — 같은 아이디로 저장하면 덮어써집니다 */
(async () => {
  const id = new URLSearchParams(location.search).get('redo');
  if (!id) return;
  let info = null;
  try { info = await (await fetch('songs/' + id + '/song.json')).json(); } catch (e) { }
  if (!info) { try { info = (JSON.parse(localStorage.getItem('localSongs') || '[]')).find(s => s.id === id); } catch (e) { } }
  if (!info) return;
  $('title').value = info.title || id;
  $('subtitle').value = info.subtitle || '';
  $('sid').value = id;
  $('order').value = (info.parts || []).map(p => p.id || p).join(',');
  $('title').oninput = null;                       // 아이디가 바뀌지 않도록 고정
  const note = document.createElement('p');
  note.className = 'dim';
  note.innerHTML = `<b>「${info.title || id}」 다시 만들기</b> — 같은 파일을 다시 올리고 분석한 뒤 저장하면 이 곡을 덮어씁니다. 아이디(${id})는 그대로 두세요.`;
  $('s2').hidden = false; $('s2').appendChild(note);
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
