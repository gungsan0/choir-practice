# 울림 합창 연습실

악보를 보면서 파트별 강조 음원을 듣는 합창 연습 웹앱입니다.
재생 위치에 맞춰 선택한 파트의 마디가 악보 위에서 하이라이트됩니다.

## 기능

- **곡 목록**: 랜딩 페이지에서 곡을 골라 들어갑니다. 검색도 됩니다.
- **파트 강조**: 파트 버튼을 누르면 그 파트의 음원으로 바뀌고(재생 위치 유지), 악보에서도 그 파트 줄만 강조됩니다.
- **겹쳐 듣기**: 버튼을 켜면 두 파트 이상을 **동시에** 재생합니다. 두 음원이 정확히 같은 시각에 시작되도록 Web Audio로 재생하며, 선택한 파트가 모두 하이라이트됩니다. (겹쳐 듣기 중에는 1배속만 지원)
- **마디 클릭 이동 / 구간 반복**: 마디를 클릭하면 그 지점부터, Shift+클릭 두 번이면 A→B 구간 반복.
- **속도 조절**: 0.6 / 0.75 / 0.9 / 1배 (음정은 그대로).
- **확대**: 1 / 1.6 / 2.4배 — 확대해도 현재 마디를 화면 중앙에 따라가게 합니다.
- **오프라인 저장 + 홈 화면 설치(PWA)**: 곡 화면에서 `오프라인 저장`을 누르면 인터넷 없이도 연습할 수 있습니다.

## 폴더 구조

```
index.html            곡 목록(랜딩)
player.html           곡 재생 화면  (player.html?song=<곡id>)
player.js / app.css   앱 코드·스타일
sw.js                 오프라인 지원(서비스 워커)
manifest.webmanifest  홈 화면 설치 정보
logo-badge.png, icon-*.png
songs/
  index.json          곡 목록 데이터  ← 곡을 추가하면 자동 갱신됩니다
  when-you-believe/
    song.json         마디 위치·마디별 시각·파트 정보
    p1.webp …         악보 이미지(쪽별)
    Children.mp3 …    파트별 강조 음원
tools/
  add_song.py         새 곡 추가 도구
```

## 새 곡 추가하기

곡 폴더 하나에 **악보 PDF**, **파트별 음원**(파일명에 `[파트이름]`), 있으면 **MuseScore 파일**을 모아둡니다.

```
새노래/
  새노래.pdf
  새노래.mscz            (있으면 마디·박자·템포를 정확히 읽습니다)
  [Soprano] 새노래.mp3
  [Alto] 새노래.mp3
  [Tenor] 새노래.mp3
  [Bass] 새노래.mp3
```

그리고 앱 폴더에서:

```bash
python3 tools/add_song.py "새노래 폴더 경로" --id new-song --title "새 노래"
```

이 명령 하나로 악보에서 마디선을 찾고, 음원과 대조해 마디별 시각을 계산하고,
이미지·음원을 변환한 뒤 `songs/new-song/` 을 만들고 목록에 추가합니다.
결과가 이상하면 `--dpi`, `--order`, `--tempo`, `--staves-per-system` 옵션으로 조정할 수 있습니다.
(자세한 설명: `python3 tools/add_song.py --help`)

**처음 한 번만 준비**

```bash
pip3 install pillow numpy librosa      # librosa는 템포 자동 추정용(선택)
brew install ffmpeg poppler            # macOS
```

**미리 보기**

```bash
python3 -m http.server 8000    # 앱 폴더에서 실행 → http://localhost:8000/
```

## 배포 (GitHub Pages)

1. 이 폴더의 파일 전체를 새 저장소(public)에 올립니다.
2. Settings → Pages → Source: `Deploy from a branch` → Branch: `main` / `(root)` → Save
3. 1~2분 후 `https://<사용자명>.github.io/<저장소이름>/` 에서 열립니다.

곡을 추가한 뒤에는 바뀐 `songs/` 폴더와 `songs/index.json` 을 다시 올리면 됩니다.

> 저작권이 있는 곡의 악보·음원을 공개 주소에 올릴 때는 권리 관계를 확인해주세요.
