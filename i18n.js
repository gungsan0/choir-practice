/* 한/영 전환
   · HTML : data-i18n(글자) · data-i18n-html(태그 포함) · data-i18n-title · data-i18n-aria ·
            data-i18n-ph(placeholder) · data-i18n-alt · data-i18n-content(<meta content>)
            값에 {n} 같은 자리가 있으면 data-i18n-args='{"n":1}' 로 채운다.
   · JS   : I18N.t('키', {n: 3})   — 영어 값이 배열이면 [단수, 복수] (vars.n === 1 이면 단수)
   · 곡 데이터(부제·반주 이름 등)는 I18N.data(글자) — 사전에 없으면 원문 그대로.
   · 선택한 언어는 이 브라우저(localStorage)에 저장. 기본은 한국어.
   값은 직접 쓴 문구만 들어 있으므로 innerHTML 로 넣어도 안전하다. 곡 제목 같은 외부 글자는
   vars 로 넘기기 전에 I18N.esc() 로 감싼다. */
(function () {
  const DICT = {
    /* ── 공통 ── */
    'app.name': { ko: '울림 합창 연습실', en: 'Woolim Choir Practice' },
    'app.tagline': { ko: '악보를 따라가며 파트별로 연습하세요', en: 'Follow the score and practice your part' },
    'app.desc': { ko: '악보를 따라가며 파트별로 연습하는 합창 연습 앱', en: 'A choir practice app that follows the score, part by part' },
    'logo.alt': { ko: '울림 어린이합창단', en: "Woolim Children's Choir" },
    'lang.label': { ko: 'EN', en: '한국어' },
    'lang.aria': { ko: 'Switch to English', en: '한국어로 전환' },
    'fmt.dur': { ko: '{m}분 {s}초', en: '{m}m {s}s' },
    'bars': { ko: '{n}마디', en: ['{n} bar', '{n} bars'] },
    'pages': { ko: '{n}쪽', en: ['{n} page', '{n} pages'] },

    /* ── 곡 목록 ── */
    'q.ph': { ko: '곡 검색', en: 'Search songs' },
    'add.btn': { ko: '＋ 곡 추가', en: '＋ Add song' },
    'empty.search': { ko: '검색 결과가 없습니다.', en: 'No songs match your search.' },
    'empty.none': { ko: '아직 등록된 곡이 없습니다.', en: 'No songs yet.' },
    'empty.owner': {
      ko: '아직 등록된 곡이 없습니다.<br><b>＋ 곡 추가</b> 를 눌러 악보 PDF와 파트별 음원을 올려보세요.',
      en: 'No songs yet.<br>Tap <b>＋ Add song</b> to upload a score PDF and the part recordings.'
    },
    'scope.only': { ko: '📱 이 기기에만 있음', en: '📱 Only on this device' },
    'scope.only.tip': {
      ko: '아직 공개하지 않아 이 기기에서만 보입니다. 다른 사람에게도 보이게 하려면 다시 만들기 → 모두에게 공개를 눌러주세요.',
      en: 'Not published yet, so it is only visible on this device. To share it, choose Rebuild → Publish to everyone.'
    },
    'scope.pub': { ko: '🌐 모두에게 공개', en: '🌐 Public' },
    'scope.pub.tip': { ko: '저장소에 올라가 있어 모든 사람에게 보입니다.', en: 'Published in the repository, so everyone can see it.' },
    'saved.offline': { ko: '● 오프라인 저장됨', en: '● Saved offline' },
    'fix.btn': { ko: '다시 만들기', en: 'Rebuild' },
    'fix.tip': { ko: '악보 인식을 다시 해서 이 곡을 덮어씁니다', en: 'Re-analyze the score and overwrite this song' },
    'del.btn': { ko: '삭제', en: 'Delete' },
    'del.tip.local': { ko: '이 기기에서 삭제', en: 'Delete from this device' },
    'del.tip.pub': { ko: '모두에게서 삭제 (GitHub)', en: 'Delete for everyone (GitHub)' },
    'del.confirm.local': { ko: '"{title}" 을(를) 이 기기에서 삭제할까요?', en: 'Delete "{title}" from this device?' },
    'del.confirm.pub': {
      ko: '"{title}" 을(를) GitHub에서 완전히 삭제할까요?\n모든 사람의 목록에서 사라집니다. (1~2분 뒤 반영)',
      en: 'Permanently delete "{title}" from GitHub?\nIt will disappear from everyone\'s list. (Takes 1–2 minutes to apply.)'
    },
    'del.fail': { ko: '삭제 실패: {msg}', en: 'Delete failed: {msg}' },
    'del.needgh': {
      ko: '공개된 곡을 지우려면 GitHub 연결이 필요합니다.\n＋ 곡 추가 → GitHub 연결 설정에서 저장소와 토큰을 먼저 입력해주세요.',
      en: 'Deleting a public song requires a GitHub connection.\nFirst enter the repository and token under ＋ Add song → GitHub setup (the admin page is in Korean).'
    },
    'del.progress': { ko: '삭제 중… ({i}/{n}) {name}', en: 'Deleting… ({i}/{n}) {name}' },
    'del.updating': { ko: '곡 목록 갱신 중…', en: 'Updating song list…' },
    'note.owner': {
      ko: '<b>＋ 곡 추가</b>에서 악보 PDF와 파트별 음원을 올리면 앱이 마디를 찾아 자동으로 맞춰줍니다. ' +
        '<b class="scope pub">🌐 모두에게 공개</b> 는 저장소에 올라가 모든 사람이 볼 수 있는 곡, ' +
        '<b class="scope only">📱 이 기기에만 있음</b> 은 아직 공개하지 않아 이 기기에서만 보이는 곡입니다. ',
      en: 'Upload a score PDF and the part recordings with <b>＋ Add song</b> and the app finds the bars and syncs them automatically. ' +
        '<b class="scope pub">🌐 Public</b> songs are published in the repository and visible to everyone; ' +
        '<b class="scope only">📱 Only on this device</b> songs are not published yet and only show up here. '
    },
    'note.guest': {
      ko: '곡 추가·수정·삭제는 이 앱을 관리하는 사람만 할 수 있습니다. ',
      en: 'Only the app administrator can add, edit or delete songs. '
    },
    'note.common': {
      ko: '곡 하나를 열어 <b>오프라인 저장</b>을 누르면 인터넷 없이도 연습할 수 있어요. 휴대폰에서는 공유 → 홈 화면에 추가하면 앱처럼 열립니다.',
      en: 'Open a song and tap <b>Save offline</b> to practice without internet. On a phone, use Share → Add to Home Screen to open it like an app.'
    },
    'note.version': { ko: '앱 버전 {v}', en: 'App version {v}' },
    'note.reload': { ko: '앱 새로고침', en: 'Reload app' },
    'note.admin': { ko: '관리자', en: 'Admin' },

    /* ── 플레이어 ── */
    'back': { ko: '곡 목록', en: 'Song list' },
    'back.link': { ko: '← 곡 목록', en: '← Song list' },
    'mix': { ko: '겹쳐 듣기', en: 'Layer parts' },
    'mix.on': { ko: '겹쳐 듣기 ON', en: 'Layer parts ON' },
    'mix.tip': { ko: '두 파트 이상 겹쳐서 함께 듣기', en: 'Listen to two or more parts together' },
    'acc': { ko: '🎹 반주', en: '🎹 Accompaniment' },
    'acc.tip': { ko: '반주를 함께 깔기', en: 'Play the accompaniment underneath' },
    'acc.vol': { ko: '반주 음량', en: 'Accompaniment volume' },
    'play': { ko: '재생', en: 'Play' },
    'pos': { ko: '재생 위치', en: 'Playback position' },
    'bar.n': { ko: '마디 {n}', en: 'Bar {n}' },
    'zoom': { ko: '확대', en: 'Zoom' },
    'loop': { ko: '🔁 구간 반복', en: '🔁 Loop section' },
    'loop.set': { ko: '🔁 {a}~{b} 마디 ✕', en: '🔁 Bars {a}–{b} ✕' },
    'loop.pickEnd': { ko: '🔁 끝 마디 선택', en: '🔁 Pick end bar' },
    'loop.pickStart': { ko: '🔁 시작 마디 선택', en: '🔁 Pick start bar' },
    'loop.hintEnd': { ko: '시작 {a}마디 — 끝 마디를 누르세요', en: 'Start: bar {a} — now tap the end bar' },
    'loop.hintStart': { ko: '반복할 시작 마디를 누르세요', en: 'Tap the bar to start the loop from' },
    'sync.earlier': { ko: '악보를 0.2초 빠르게', en: 'Move the score 0.2 s earlier' },
    'sync.later': { ko: '악보를 0.2초 늦게', en: 'Move the score 0.2 s later' },
    'sync.reset': { ko: '누르면 0으로 되돌립니다', en: 'Tap to reset to 0' },
    'sync.label': { ko: '싱크 {v}초', en: 'Sync {v} s' },
    'dl.save': { ko: '오프라인 저장', en: 'Save offline' },
    'dl.local': { ko: '✓ 이 기기에 저장됨', en: '✓ Saved on this device' },
    'dl.unsupported': { ko: '이 브라우저는 미지원', en: 'Not supported in this browser' },
    'dl.saving': { ko: '저장 중…', en: 'Saving…' },
    'dl.done': { ko: '✓ 저장됨', en: '✓ Saved' },
    'dl.fail': { ko: '저장 실패', en: 'Save failed' },
    'rf.tip': { ko: '이 곡의 악보·음원을 최신으로 다시 받기', en: "Re-download this song's score and audio" },
    'rf.local': {
      ko: '이 곡은 이 기기에서 추가한 곡이라 다시 받을 원본이 없습니다.\n곡 목록에서 “다시 만들기”를 눌러주세요.',
      en: 'This song was added on this device, so there is no original to re-download.\nUse "Rebuild" in the song list.'
    },
    'rf.confirm': { ko: '이 곡의 악보·음원을 최신으로 다시 받을까요?', en: "Re-download this song's score and audio?" },
    'hint': {
      ko: '마디를 <b>클릭</b>하면 그 지점부터 재생 · <b>Shift+클릭</b> 두 번으로 구간 반복(A→B) 설정 · ' +
        '<kbd>Space</kbd> 재생/정지 · <kbd>&larr;</kbd><kbd>&rarr;</kbd> 한 마디 이동 · ' +
        '<b>🔁 구간 반복</b>을 누른 뒤 시작·끝 마디를 차례로 누르면 그 구간만 반복됩니다 · ' +
        '<b>🎹 반주</b>를 켜면 반주가 함께 깔립니다(옆 슬라이더로 음량 조절) · ' +
        '<b>겹쳐 듣기</b>를 켜면 두 파트 이상을 동시에 들을 수 있어요',
      en: '<b>Click</b> a bar to play from there · <b>Shift+click</b> two bars to set a loop (A→B) · ' +
        '<kbd>Space</kbd> play/pause · <kbd>&larr;</kbd><kbd>&rarr;</kbd> move one bar · ' +
        'Tap <b>🔁 Loop section</b>, then tap the start and end bars to repeat just that section · ' +
        'Turn on <b>🎹 Accompaniment</b> to play it underneath (use the slider for volume) · ' +
        'Turn on <b>Layer parts</b> to hear two or more parts at once'
    },
    'status.loading': { ko: '음원 준비 중…', en: 'Preparing audio…' },
    'speed.limit': {
      ko: '반주를 깔거나 여러 파트를 겹쳐 들을 때는 1배속만 지원합니다',
      en: 'Only 1× speed is supported when playing the accompaniment or layering parts'
    },
    'foot': { ko: '파트별 강조 음원 {n}종', en: ['{n} part recording', '{n} part recordings'] },
    'score.alt': { ko: '악보 {n}쪽', en: 'Score page {n}' },
    'err.title': { ko: '곡을 불러오지 못했습니다.', en: "Couldn't load the song." },
    'err.local': {
      ko: '이 기기에 추가한 곡인데 저장된 파일을 찾을 수 없습니다. 곡 목록에서 <b>다시 만들기</b>로 파일을 다시 올려주세요.',
      en: "This song was added on this device, but its saved files can't be found. Re-upload them with <b>Rebuild</b> in the song list."
    },
    'err.remote': {
      ko: '서버에 <code>songs/{id}/song.json</code> 이 없습니다. 곡 폴더가 지워졌을 수 있어요 — ' +
        '<b>＋ 곡 추가 → GitHub 연결 설정 → 저장소에서 곡 목록 복구</b>를 눌러 목록을 맞춰보세요.',
      en: '<code>songs/{id}/song.json</code> was not found on the server. The song folder may have been deleted — ' +
        'try <b>＋ Add song → GitHub setup → Restore song list from repository</b> (the admin page is in Korean).'
    },

    /* ── 곡 데이터(song.json·index.json 에 적힌 글자) ── */
    'data:울림 어린이 합창단': { ko: '울림 어린이 합창단', en: "Woolim Children's Choir" },
    'data:울림 어린이합창단': { ko: '울림 어린이합창단', en: "Woolim Children's Choir" },
    'data:반주': { ko: '반주', en: 'Accompaniment' }
  };

  const KEY = 'lang';
  let lang = 'ko';
  try { const s = localStorage.getItem(KEY); if (s === 'en' || s === 'ko') lang = s; } catch (e) { }
  const listeners = [];

  function t(key, vars) {
    const e = DICT[key];
    if (!e) { if (window.console) console.warn('i18n: missing key', key); return key; }
    let s = e[lang];
    if (Array.isArray(s)) s = (vars && vars.n === 1) ? s[0] : s[1];
    if (s == null) s = Array.isArray(e.ko) ? e.ko[0] : e.ko;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
  }
  const data = s => { const e = s != null && DICT['data:' + s]; return e && e[lang] != null ? e[lang] : s; };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function apply(root) {
    root = root || document;
    const args = el => { try { return el.dataset.i18nArgs ? JSON.parse(el.dataset.i18nArgs) : undefined; } catch (e) { return undefined; } };
    const each = (attr, fn) => root.querySelectorAll('[' + attr + ']').forEach(el => fn(el, t(el.getAttribute(attr), args(el))));
    each('data-i18n', (el, v) => { el.textContent = v; });
    each('data-i18n-html', (el, v) => { el.innerHTML = v; });
    each('data-i18n-title', (el, v) => { el.title = v; });
    each('data-i18n-aria', (el, v) => { el.setAttribute('aria-label', v); });
    each('data-i18n-ph', (el, v) => { el.placeholder = v; });
    each('data-i18n-alt', (el, v) => { el.alt = v; });
    each('data-i18n-content', (el, v) => { el.setAttribute('content', v); });
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-lang-toggle]').forEach(b => {
      b.textContent = t('lang.label'); b.setAttribute('aria-label', t('lang.aria')); b.title = t('lang.aria');
    });
  }

  function setLang(l) {
    if (l !== 'ko' && l !== 'en') return;
    lang = l;
    try { localStorage.setItem(KEY, l); } catch (e) { }
    apply();
    listeners.forEach(fn => { try { fn(l); } catch (e) { if (window.console) console.error(e); } });
  }

  window.I18N = {
    get lang() { return lang; },
    t, data, esc, apply, setLang,
    toggle() { setLang(lang === 'ko' ? 'en' : 'ko'); },
    onChange(fn) { listeners.push(fn); }
  };

  /* 다른 탭에서 언어를 바꿔도 따라가기 */
  addEventListener('storage', e => {
    if (e.key === KEY && (e.newValue === 'ko' || e.newValue === 'en') && e.newValue !== lang) {
      lang = e.newValue; apply(); listeners.forEach(fn => { try { fn(lang); } catch (err) { } });
    }
  });

  /* 이 파일은 </body> 바로 앞에서 불러온다 — 그때는 화면 요소가 이미 있으니 곧바로 적용해서,
     뒤따르는 스크립트가 만드는 글자와 순서가 엇갈리지 않게 한다. */
  function boot() {
    apply();
    document.querySelectorAll('[data-lang-toggle]').forEach(b => { b.onclick = () => window.I18N.toggle(); });
  }
  boot();
})();
