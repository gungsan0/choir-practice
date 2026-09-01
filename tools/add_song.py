#!/usr/bin/env python3
"""
add_song.py — 합창 연습실 앱에 새 곡을 추가하는 변환 도구

준비물 (곡 폴더 하나에 모아두면 됩니다)
  * 악보 PDF                      : 필수
  * 파트별 강조 음원 mp3/wav/m4a  : 필수, 파일명에 [파트이름] 을 넣어주세요
                                    예) [Soprano] 나의 노래.mp3
  * 반주 음원                     : 선택, [반주] 처럼 이름 붙이면 자동 인식 (--accomp 로 지정 가능)
  * MuseScore 파일(.mscz/.mscx)   : 선택. 있으면 마디 수·박자·템포를 정확히 읽어옵니다.

사용법
  python3 tools/add_song.py "곡 폴더 경로" --id my-song --title "곡 제목"

자주 쓰는 옵션
  --order "Soprano,Alto,Tenor,Bass"  악보에서 위→아래 순서로 보이는 파트 이름
                                     (mscz가 있으면 자동. 없으면 지정 권장)
  --tempo 72                         첫 구간 BPM 직접 지정 (자동 추정을 끄고 싶을 때)
  --offset 0.08                      음원에서 1마디가 시작하는 시각(초)
  --dpi 150                          악보 이미지 해상도
  --bitrate 96k                      음원 변환 비트레이트
  --dry-run                          파일을 쓰지 않고 인식 결과만 확인

필요한 프로그램
  ffmpeg, pdftoppm(poppler)  : 필수
  python 패키지 pillow, numpy: 필수
  python 패키지 librosa      : 선택(첫 구간 템포 자동 추정에 사용)
"""

import argparse, json, os, re, shutil, subprocess, sys, tempfile, zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

# ─────────────────────────────────────────────────────────── 유틸

PALETTE = ["#e0483c", "#1f9d55", "#2f6fe0", "#8b5cf6", "#e08a1e", "#0d9488", "#d6336c", "#4b5563"]
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".aiff", ".aif"}


def die(msg):
    print("✗ " + msg, file=sys.stderr)
    sys.exit(1)


def need(cmd):
    if shutil.which(cmd) is None:
        die(f"'{cmd}' 명령을 찾을 수 없습니다. 설치 후 다시 실행해주세요.")


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        die(f"명령 실패: {' '.join(map(str, cmd))}\n{p.stderr[:800]}")
    return p.stdout


def audio_duration(path):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", str(path)])
    return float(out.strip())


# ─────────────────────────────────────────────── 1. MuseScore 파일 읽기

DUR = {"measure": 4, "breve": 8, "whole": 4, "half": 2, "quarter": 1, "eighth": .5,
       "16th": .25, "32nd": .125, "64th": 1 / 16, "128th": 1 / 32}


def read_mscore(path):
    """마디 수 / 박자 / 템포 변화 / 파트 이름 / 음표 시작 위치(박)를 뽑아낸다."""
    path = Path(path)
    if path.suffix.lower() == ".mscz":
        with zipfile.ZipFile(path) as z:
            name = [n for n in z.namelist() if n.endswith(".mscx") and "/" not in n]
            if not name:
                name = [n for n in z.namelist() if n.endswith(".mscx")]
            xml = z.read(name[0]).decode("utf-8", "replace")
    else:
        xml = path.read_text(encoding="utf-8", errors="replace")

    try:
        score = ET.fromstring(xml).find("Score")
    except ET.ParseError as e:
        die(f"MuseScore 파일을 읽지 못했습니다: {e}")

    parts = [p.findtext("trackName") or (p.findtext("Instrument/longName") or "Part")
             for p in score.findall("Part")]
    staves = score.findall("Staff")
    if not staves:
        die("MuseScore 파일에 오선(Staff) 정보가 없습니다.")

    n_meas = len(staves[0].findall("Measure"))

    # 박자표: 마디별 길이(박)
    beats = [4.0] * n_meas
    sig = 4.0
    for i, m in enumerate(staves[0].findall("Measure")):
        ts = m.find(".//TimeSig")
        if ts is not None:
            n, d = float(ts.findtext("sigN", 4)), float(ts.findtext("sigD", 4))
            sig = n * 4 / d
        ln = m.get("len")  # 못갖춘마디
        if ln:
            a, b = ln.split("/")
            beats[i] = float(a) * 4 / float(b)
        else:
            beats[i] = sig

    # 템포 변화: {마디번호(1부터): bpm}
    tempo = {}
    for st in staves:
        for i, m in enumerate(st.findall("Measure")):
            for t in m.iter("Tempo"):
                v = t.findtext("tempo")
                if v:
                    tempo.setdefault(i + 1, round(float(v) * 60, 4))

    # 음표 시작 위치(전체 박) — 음원과 맞춰볼 때 사용
    onsets = set()
    for st in staves:
        for i, m in enumerate(st.findall("Measure")):
            start = sum(beats[:i])
            for voice in m.findall("voice"):
                pos = 0.0
                for e in voice:
                    if e.tag in ("Chord", "Rest"):
                        d = DUR.get(e.findtext("durationType") or "", 0)
                        dots = e.findtext("dots")
                        if dots:
                            d *= 2 - 0.5 ** int(dots)
                        if e.tag == "Chord":
                            onsets.add(round(start + pos, 4))
                        pos += d
    return dict(parts=parts, measures=n_meas, beats=beats, tempo=tempo,
                onsets=sorted(onsets))


# ─────────────────────────────────────────────── 2. 악보 PDF에서 마디 찾기

def detect_layout(pdf, workdir, dpi, staves_per_system=None, expect_measures=None):
    """PDF를 이미지로 만든 뒤 오선·단(system)·마디선을 찾아낸다."""
    import numpy as np
    from PIL import Image

    need("pdftoppm")
    run(["pdftoppm", "-r", str(dpi), "-png", str(pdf), str(workdir / "pg")])
    pages = sorted(workdir.glob("pg-*.png"))
    if not pages:
        die("PDF를 이미지로 변환하지 못했습니다.")

    pages_data, sizes = [], None
    for f in pages:
        a = np.array(Image.open(f).convert("L")) < 128
        H, W = a.shape
        sizes = (W, H)
        rows = a.sum(1)
        lines = [i for i, v in enumerate(rows) if v > W * 0.4]
        if not lines:
            die(f"{f.name} 에서 오선을 찾지 못했습니다. --dpi 를 바꿔보세요.")
        groups, cur = [], [lines[0]]
        for i in lines[1:]:
            if i - cur[-1] <= 2:
                cur.append(i)
            else:
                groups.append(cur)
                cur = [i]
        groups.append(cur)
        # 오선은 가느다란 한 줄이다. 16분음표 같은 빠른 리듬이 이어질 때 겹빔(beam)이
        # 오선 위에서 페이지 폭의 40%를 넘게 뭉치면, 두께가 여러 줄에 걸친 "굵은 띠"인데도
        # 오선으로 오인될 수 있다. 굵은 띠는 제외하고 가느다란 줄만 남긴다.
        thickness = sorted(len(g) for g in groups)
        median = thickness[len(thickness) // 2] if thickness else 1
        cap = max(2, median + 2)
        groups = [g for g in groups if len(g) <= cap]
        centers = [int(sum(g) / len(g)) for g in groups]
        if len(centers) % 5:
            die(f"{f.name}: 오선 줄 수가 5의 배수가 아닙니다({len(centers)}줄). --dpi 를 조정해보세요.")
        staff_list = [centers[i:i + 5] for i in range(0, len(centers), 5)]
        pages_data.append(dict(staves=staff_list, W=W, H=H, bin=a))

    def by_bracket(page):
        """단 시작의 세로선(괄호/첫 마디선)이 그 단의 오선을 통째로 잇는 것을 이용해 단을 나눈다."""
        a, sl, W, H = page["bin"], page["staves"], page["W"], page["H"]
        h = sl[0][-1] - sl[0][0]
        xs = set()
        for st in sl:
            nz = np.nonzero(a[st[0]])[0]
            if len(nz):
                xs.add(int(nz[0]))
        cand = sorted({x for x0 in xs for x in range(max(0, x0 - 6), x0 + 12)})
        runs = []
        for x in cand:
            col = a[:, x]
            y = 0
            while y < H:
                if col[y]:
                    s0 = y
                    while y < H and col[y]:
                        y += 1
                    if (y - 1 - s0) > h * 1.4:
                        runs.append([s0, y - 1])
                else:
                    y += 1
        runs.sort()
        merged = []
        for r in runs:
            if merged and r[0] <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], r[1])
            else:
                merged.append(list(r))
        out, used = [], set()
        for s0, e0 in merged:
            grp = [i for i, st in enumerate(sl) if st[0] >= s0 - 8 and st[-1] <= e0 + 8 and i not in used]
            if grp:
                used.update(grp)
                out.append([sl[i] for i in grp])
        out += [[st] for i, st in enumerate(sl) if i not in used]
        out.sort(key=lambda g: g[0][0])
        return out

    def by_gaps(sl):
        gaps = [sl[i + 1][0] - sl[i][-1] for i in range(len(sl) - 1)]
        if not gaps:
            return [sl]
        srt = sorted(gaps)
        jumps = [(srt[i + 1] - srt[i], (srt[i + 1] + srt[i]) / 2) for i in range(len(srt) - 1)]
        thr = max(jumps)[1] if jumps else srt[0] + 1
        out, cur_sys = [], [sl[0]]
        for g, st in zip(gaps, sl[1:]):
            if g > thr:
                out.append(cur_sys); cur_sys = [st]
            else:
                cur_sys.append(st)
        out.append(cur_sys)
        return out

    def group(page, k=None):
        """staff 목록을 '단'으로 묶는다. k가 주어지면 k개씩, 아니면 자동."""
        sl = page["staves"]
        if k:
            return [sl[i:i + k] for i in range(0, len(sl), k)]
        b = by_bracket(page)
        if b and len({len(g) for g in b}) <= 2:
            return b
        return by_gaps(sl)

    def drop_ghost_bars(bars):
        """겹세로줄(더블 바라인)·종지선처럼 마디선 두 개가 아주 가깝게 그려진 경우,
        앞의 클러스터링(tol)만으로는 한 마디선으로 합쳐지지 않아 그 사이에 폭이 거의 0인
        "가짜 마디"가 하나 더 생긴다. 이웃 마디 폭에 비해 지나치게 좁은 간격은
        진짜 마디 경계가 아니라고 보고 앞쪽 마디선에 흡수시킨다."""
        if len(bars) < 3:
            return bars
        widths = [b - a for a, b in zip(bars, bars[1:])]
        median = sorted(widths)[len(widths) // 2]
        min_w = median * 0.3  # 정상 마디 폭의 30% 미만이면 유령 마디선으로 간주
        out = [bars[0]]
        for x in bars[1:]:
            if x - out[-1] < min_w:
                continue
            out.append(x)
        return out if len(out) >= 2 else bars

    def barline_cols(page, sysv):
        """마디선은 그 단(system)에 속한 오선을 전부 -- 오선과 오선 사이 빈 칸까지 -- 위에서
        아래로 끊김없이 이어야 진짜다. 예전에는 오선마다 따로 마디선 후보를 찾고 x가 겹치는
        것만 골랐는데, 우연히 여러 오선에서 같은 x에 음표 기둥·기호가 걸리면 마디선으로
        잘못 인식했다. 그래서 단 전체 높이를 한 번에 검사해, 실제로 위에서 아래까지
        이어진 세로줄만 인정한다."""
        a, W = page["bin"], page["W"]
        top, bot = sysv[0][0], sysv[-1][-1]
        h = sysv[0][-1] - sysv[0][0]
        need = bot - top + 1
        dens = a[top:bot + 1, :].sum(0) / need
        full = dens >= 0.95
        gap = max(3, int(round(h / 9)))
        keep = set()
        x = 0
        while x < W:
            if not full[x]:
                x += 1
                continue
            l = x
            while x < W and full[x]:
                x += 1
            r = x - 1
            if r - l > max(6, h / 4):
                continue
            if dens[max(0, l - gap)] <= 0.4 and dens[min(W - 1, r + gap)] <= 0.4:
                keep.update(range(l, r + 1))
        return keep

    def bars_of(page, sysv):
        common = sorted(barline_cols(page, sysv))
        if len(common) < 2:
            return []
        tol = max(4, page["W"] // 90)
        bars, c = [], [common[0]]
        for x in common[1:]:
            if x - c[-1] <= tol:
                c.append(x)
            else:
                bars.append(round(sum(c) / len(c)))
                c = [x]
        bars.append(round(sum(c) / len(c)))
        return drop_ghost_bars(bars)

    def assemble(k):
        out, total = [], 0
        for page in pages_data:
            ps = []
            for sysv in group(page, k):
                bars = bars_of(page, sysv)
                if len(bars) < 2:
                    return None, -1
                total += len(bars) - 1
                ps.append(dict(staves=[[s[0], s[-1]] for s in sysv], bars=bars))
            out.append(ps)
        return out, total

    # 한 단에 몇 오선인지: 지정값 → (마디 수가 악보와 맞는 값) → 간격 자동판단
    chosen, layout, total = None, None, -1
    if staves_per_system:
        layout, total = assemble(staves_per_system)
        chosen = staves_per_system
    else:
        layout, total = assemble(None)
        if expect_measures and total != expect_measures:
            for k in [k for k in range(1, 9) if all(len(p["staves"]) % k == 0 for p in pages_data)]:
                lay, n = assemble(k)
                if lay is not None and n == expect_measures:
                    chosen, layout, total = k, lay, n
                    break
    if layout is None:
        die("마디선을 찾지 못했습니다. --dpi 를 조정하거나 --staves-per-system 을 지정해보세요.")
    return layout, sizes, pages


def build_measures(layout, size, n_expected=None):
    W, H = size
    out, n = [], 0
    for pi, page in enumerate(layout):
        for s in page:
            st, bars = s["staves"], s["bars"]
            bands = []
            for i, (y0, y1) in enumerate(st):
                top, bot = y0 - 22, y1 + 42
                if i < len(st) - 1:
                    bot = min(bot, st[i + 1][0] - 12)
                bands.append([top, bot])
            for i in range(len(bars) - 1):
                n += 1
                out.append(dict(
                    m=n, pg=pi,
                    x=round(bars[i] / W * 100, 4), w=round((bars[i + 1] - bars[i]) / W * 100, 4),
                    b=[[round(t / H * 100, 4), round((b - t) / H * 100, 4)] for t, b in bands],
                    sy=[round((st[0][0] - 30) / H * 100, 4),
                        round((st[-1][-1] + 45 - st[0][0] + 30) / H * 100, 4)]))
    if n_expected and n != n_expected:
        print(f"⚠ 악보에서 찾은 마디 수({n})가 MuseScore 파일의 마디 수({n_expected})와 다릅니다.")
        print("  → --dpi 를 바꾸거나 --staves-per-system 을 지정해보세요. (계속 진행합니다)")
    return out


# ─────────────────────────────────────────────── 3. 마디별 시각 계산

def build_times(score, n_meas, first_bpm, offset, audio_len):
    beats = list((score or {}).get("beats") or [])
    while len(beats) < n_meas:
        beats.append(beats[-1] if beats else 4.0)
    tempo = (score or {}).get("tempo") or {}
    bpm, times, t = first_bpm, [], offset
    for m in range(1, n_meas + 1):
        bpm = tempo.get(m, bpm)
        times.append(round(t, 4))
        t += beats[m - 1] * 60 / bpm
    times.append(round(max(t, audio_len), 4))  # 마지막 마디는 늘임표까지 포함
    return times


def fit_first_tempo(audio, score, offset_hint=None, lo=40, hi=160):
    """첫 구간 템포와 시작 오프셋을 음원의 음 시작점에 맞춰 추정한다 (librosa 필요)."""
    try:
        import librosa, numpy as np
    except ImportError:
        return None
    y, sr = librosa.load(str(audio), sr=22050)
    det = librosa.onset.onset_detect(y=y, sr=sr, units="time")
    if len(det) < 8:
        return None
    beats, tempo = score["beats"], score["tempo"]
    onsets = np.array(score["onsets"])
    if not len(onsets):
        return None

    import numpy as np
    best = None
    offs = [offset_hint] if offset_hint is not None else np.arange(0, 0.5, 0.02)
    for bpm in np.arange(lo, hi, 0.25):
        # 마디 시작 시각
        cur, t, starts = bpm, 0.0, []
        for m in range(1, len(beats) + 1):
            cur = tempo.get(m, cur)
            starts.append(t)
            t += beats[m - 1] * 60 / cur
        starts.append(t)
        starts = np.array(starts)
        # 박 → 시각
        cum = np.concatenate([[0], np.cumsum(beats)])
        idx = np.searchsorted(cum, onsets, "right") - 1
        idx = np.clip(idx, 0, len(beats) - 1)
        frac = (onsets - cum[idx]) / np.array(beats)[idx]
        pred0 = starts[idx] + frac * (starts[idx + 1] - starts[idx])
        for off in offs:
            err = np.abs(det[:, None] - (pred0 + off)[None, :]).min(0)
            sc = float(np.mean(np.minimum(err, 0.3)))
            if best is None or sc < best[0]:
                best = (sc, float(bpm), float(off), float(np.median(err)))
    return best


# ─────────────────────────────────────────────── 4. 변환 & 저장

def main():
    ap = argparse.ArgumentParser(description="합창 연습실 앱에 새 곡을 추가합니다.")
    ap.add_argument("folder", help="PDF·음원·(mscz)가 들어있는 폴더")
    ap.add_argument("--id", help="곡 주소용 영문 아이디 (예: when-you-believe)")
    ap.add_argument("--title", help="화면에 보일 곡 제목")
    ap.add_argument("--subtitle", default="", help="부제/편곡자 등")
    ap.add_argument("--order", help="악보 위→아래 파트 순서 (쉼표로 구분)")
    ap.add_argument("--accomp", help="반주 음원의 이름 (예: 반주). 파트가 아니라 배경으로 깔립니다")
    ap.add_argument("--tempo", type=float, help="첫 구간 BPM 직접 지정")
    ap.add_argument("--offset", type=float, help="1마디 시작 시각(초)")
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--bitrate", default="96k")
    ap.add_argument("--staves-per-system", type=int, help="한 단에 보이는 오선 수")
    ap.add_argument("--site", default=str(Path(__file__).resolve().parent.parent),
                    help="앱 폴더 (기본: 이 스크립트의 상위 폴더)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    need("ffmpeg"); need("ffprobe")
    try:
        import numpy, PIL  # noqa
    except ImportError:
        die("python 패키지가 필요합니다:  pip3 install pillow numpy librosa")

    src = Path(a.folder).expanduser()
    if not src.is_dir():
        die(f"폴더를 찾을 수 없습니다: {src}")

    pdfs = sorted(src.glob("*.pdf"))
    if not pdfs:
        die("폴더에 PDF 악보가 없습니다.")
    pdf = pdfs[0]

    audios = sorted([f for f in src.iterdir() if f.suffix.lower() in AUDIO_EXT])
    tracks = {}
    for f in audios:
        m = re.search(r"\[([^\]]+)\]", f.name)
        if m:
            tracks[m.group(1).strip()] = f
    if not tracks:
        die("파트 음원을 찾지 못했습니다. 파일명에 [파트이름] 을 넣어주세요. 예) [Soprano] song.mp3")

    mscore = next((f for f in sorted(src.iterdir()) if f.suffix.lower() in (".mscz", ".mscx")), None)
    score = read_mscore(mscore) if mscore else None

    # 파트 순서 정하기 (악보에서 위 → 아래)
    ACC = ("반주", "연주", "mr", "ar", "acc", "piano", "inst", "backing", "karaoke")
    accomp = a.accomp or next((k for k in tracks if k.strip().lower() in ACC or k.strip() in ACC), None)
    if accomp and accomp not in tracks:
        die(f"반주 음원을 찾지 못했습니다: {accomp}")
    if a.order:
        order = [s.strip() for s in a.order.split(",") if s.strip()]
    elif score:
        order = [p for p in score["parts"] if p in tracks]
    else:
        order = list(tracks)
    order = [p for p in order if p != accomp]
    missing = [p for p in order if p not in tracks]
    if missing:
        die(f"음원이 없는 파트: {', '.join(missing)}  (--order 를 확인해주세요)")
    extra = [p for p in tracks if p not in order and p != accomp]
    if extra:
        print(f"⚠ 순서에 없는 음원은 건너뜁니다: {', '.join(extra)}")

    song_id = a.id or re.sub(r"[^a-z0-9]+", "-", pdf.stem.lower()).strip("-")
    title = a.title or (score and score.get("title")) or pdf.stem.replace("_", " ")
    dur = audio_duration(tracks[order[0]])

    print(f"• 곡: {title}  (id: {song_id})")
    print(f"• 파트: {' → '.join(order)}" + (f"  (+ 반주: {accomp})" if accomp else ""))
    print(f"• 음원 길이: {dur:.1f}초")

    work = Path(tempfile.mkdtemp())
    try:
        n_expect = score["measures"] if score else None
        layout, size, pages = detect_layout(pdf, work, a.dpi, a.staves_per_system, n_expect)
        n_staff = len(layout[0][0]["staves"])
        print(f"• 악보: {len(pages)}쪽, 한 단에 오선 {n_staff}개")
        if n_staff != len(order):
            print(f"⚠ 악보의 오선 수({n_staff})와 파트 수({len(order)})가 다릅니다. "
                  f"--order 로 실제로 보이는 파트만 순서대로 지정해주세요.")
        measures = build_measures(layout, size, n_expect)
        n_meas = len(measures)
        print(f"• 마디: {n_meas}개")

        # 템포
        first_bpm, offset = a.tempo, a.offset
        if score and (first_bpm is None or offset is None):
            fit = fit_first_tempo(tracks[order[0]], score, offset_hint=a.offset)
            if fit:
                sc, bpm, off, med = fit
                print(f"• 음원과 대조한 결과: 첫 구간 {bpm:g} BPM, 시작 {off:.2f}초 "
                      f"(음 시작점 오차 중앙값 {med:.3f}초)")
                first_bpm = first_bpm if first_bpm is not None else bpm
                offset = offset if offset is not None else off
            else:
                print("• (librosa 없음/실패) 템포 자동 추정을 건너뜁니다.")
        if first_bpm is None:
            first_bpm = (score or {}).get("tempo", {}).get(1, 120)
            print(f"• 첫 구간 템포를 {first_bpm:g} BPM 으로 가정합니다. 어긋나면 --tempo 로 지정해주세요.")
        if offset is None:
            offset = 0.0
        times = build_times(score, n_meas, first_bpm, offset, dur)

        song = dict(
            id=song_id, title=title, subtitle=a.subtitle,
            parts=[dict(id=p, name=p, color=PALETTE[i % len(PALETTE)]) for i, p in enumerate(order)],
            accomp=accomp,
            pages=len(pages), duration=round(dur, 2),
            measures=measures, times=times,
        )

        if a.dry_run:
            print("\n(--dry-run) 파일을 쓰지 않고 종료합니다.")
            print(json.dumps({k: v for k, v in song.items() if k not in ("measures", "times")},
                             ensure_ascii=False, indent=2))
            return

        # 저장
        from PIL import Image
        site = Path(a.site).resolve()
        out = site / "songs" / song_id
        out.mkdir(parents=True, exist_ok=True)
        for i, f in enumerate(pages, 1):
            Image.open(f).convert("L").save(out / f"p{i}.webp", quality=88, method=6)
        for p in (order + ([accomp] if accomp else [])):
            run(["ffmpeg", "-y", "-v", "error", "-i", str(tracks[p]),
                 "-ac", "1", "-c:a", "libmp3lame", "-b:a", a.bitrate, str(out / f"{p}.mp3")])
        (out / "song.json").write_text(json.dumps(song, ensure_ascii=False, separators=(",", ":")),
                                       encoding="utf-8")

        # 목록 갱신
        idx_path = site / "songs" / "index.json"
        idx = json.loads(idx_path.read_text(encoding="utf-8")) if idx_path.exists() else {"songs": []}
        entry = dict(id=song_id, title=title, subtitle=a.subtitle,
                     parts=order, accomp=accomp, pages=len(pages), duration=round(dur, 2), measures=n_meas)
        idx["songs"] = [s for s in idx["songs"] if s["id"] != song_id] + [entry]
        idx["songs"].sort(key=lambda s: s["title"])
        idx_path.write_text(json.dumps(idx, ensure_ascii=False, indent=2), encoding="utf-8")

        size_mb = sum(f.stat().st_size for f in out.iterdir()) / 1e6
        print(f"\n✓ 완료: songs/{song_id}/  ({size_mb:.1f}MB)")
        print(f"  목록에 추가됨 → songs/index.json")
        print(f"  확인:  cd {site} && python3 -m http.server 8000  →  http://localhost:8000/")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
