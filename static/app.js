/* ===== AUDIO ENGINE ===== */
let audioCtx = null;

/* ===== WAKE LOCK ===== */
let _wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { _wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWakeLock() {
  if (_wakeLock) { _wakeLock.release(); _wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && timer && timer.phase && timer.phase !== 'idle' && timer.phase !== 'done') {
    requestWakeLock();
  }
});

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// AudioBuffers for beeps — decoded once, played via BufferSource for sample-accurate timing
// fetch + decodeAudioData do NOT require a user gesture — load immediately at page start
const _beepBuffers = {};
let _beepBuffersReady = false;
let _beepBuffersPromise = null;

function loadBeepBuffers() {
  if (_beepBuffersPromise) return _beepBuffersPromise;
  const ctx = getAudioCtx();
  const files = {
    tick: 'sounds/beep_tick.m4a',
    go:   'sounds/beep_go.m4a',
    warn: 'sounds/beep_warn.m4a',
    end:  'sounds/beep_end.m4a',
  };
  _beepBuffersPromise = Promise.all(
    Object.entries(files).map(async ([key, url]) => {
      try {
        const resp = await fetch(url);
        const ab = await resp.arrayBuffer();
        _beepBuffers[key] = await ctx.decodeAudioData(ab);
      } catch (e) { console.warn('beep load failed:', key, e); }
    })
  ).then(() => { _beepBuffersReady = true; });
  return _beepBuffersPromise;
}

function playBeepBuffer(key) {
  const ctx = getAudioCtx();
  const buf = _beepBuffers[key];
  if (!buf || ctx.state !== 'running') return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.value = 0.85;
  src.connect(gain);
  gain.connect(ctx.destination);
  src.start(ctx.currentTime);
}

let _ctxResumePromise = null;

function unlockAudioSync() {
  const ctx = getAudioCtx();
  // Play silent buffer synchronously (iOS Safari requirement)
  const buf = ctx.createBuffer(1, 1, 22050);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  _ctxResumePromise = ctx.resume();
}

// Pre-unlock on first touch anywhere on page
['touchend', 'click'].forEach(evt => {
  document.addEventListener(evt, function preUnlock() {
    unlockAudioSync();
    document.removeEventListener('touchend', preUnlock);
    document.removeEventListener('click', preUnlock);
  }, { passive: true });
});

function flashTick() {
  const el = document.getElementById('tick-flash');
  if (!el) return;
  el.classList.remove('active');
  void el.offsetWidth;
  el.classList.add('active');
}

function beepTick()  { flashTick(); playBeepBuffer('tick'); }
function beepGo()    { playBeepBuffer('go'); }
function beepWarn()  { playBeepBuffer('warn'); }
function beepEnd()   { playBeepBuffer('end'); }

/* ===== DEMO MUSIC INSTALL ===== */
async function installDemoMusicIfNeeded() {
  if (localStorage.getItem('odindva_demo_v5')) return;
  const map = {
    work:     'sounds/demo_work.m4a',
    rest:     'sounds/demo_relaxe.m4a',
    fin:      'sounds/demo_fin.m4a',
  };
  try {
    for (const [phase, path] of Object.entries(map)) {
      const resp = await fetch(path);
      if (!resp.ok) throw new Error(`fetch ${path} — ${resp.status}`);
      const blob = await resp.blob();
      await saveMusicBlob('_demo', phase, blob);
    }
    localStorage.removeItem('odindva_demo_v1');
    localStorage.removeItem('odindva_demo_v2');
    localStorage.removeItem('odindva_demo_v3');
    localStorage.removeItem('odindva_demo_v4');
    localStorage.setItem('odindva_demo_v5', '1');
  } catch (e) {
    console.warn('Demo music install failed:', e);
  }
}

/* ===== MUSIC STORAGE (IndexedDB) ===== */
const MUSIC_DB_NAME = 'odindva_music';
const MUSIC_STORE   = 'tracks';

function openMusicDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MUSIC_DB_NAME, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(MUSIC_STORE);
    req.onsuccess  = (e) => resolve(e.target.result);
    req.onerror    = ()  => reject(req.error);
  });
}

async function saveMusicBlob(workoutId, phase, blob) {
  const db = await openMusicDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MUSIC_STORE, 'readwrite');
    tx.objectStore(MUSIC_STORE).put(blob, `${workoutId}_${phase}`);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadMusicBlob(workoutId, phase) {
  const db = await openMusicDB();
  return new Promise((resolve) => {
    const req = db.transaction(MUSIC_STORE, 'readonly')
                  .objectStore(MUSIC_STORE).get(`${workoutId}_${phase}`);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => resolve(null);
  });
}

async function deleteMusicBlob(workoutId, phase) {
  const db = await openMusicDB();
  return new Promise((resolve) => {
    const tx = db.transaction(MUSIC_STORE, 'readwrite');
    tx.objectStore(MUSIC_STORE).delete(`${workoutId}_${phase}`);
    tx.oncomplete = resolve;
    tx.onerror    = resolve; // best-effort
  });
}

function deleteAllMusicBlobs(workoutId) {
  ['work', 'rest', 'fin'].forEach(p => deleteMusicBlob(workoutId, p));
}

/* ===== MUSIC PLAYER (Web Audio API — gapless loop with auto-trim silence) ===== */
let _musicSource = null;
let _musicGainNode = null;
const _musicBufferCache = new Map();  // key → AudioBuffer
const _phaseSavedTimes = new Map();   // key → saved playback offset (seconds)
let _phaseCurrentKey = null;
let _musicCtxTimeAtStart = 0;
let _musicOffsetAtStart = 0;

// Find last non-silent sample → use as loopEnd to skip trailing silence
function _calcLoopEnd(buffer) {
  const data = buffer.getChannelData(0);
  const thresh = 0.001;
  let last = data.length - 1;
  while (last > 0 && Math.abs(data[last]) < thresh) last--;
  return (last + 1) / buffer.sampleRate;
}

function _getMusicGain() {
  if (!_musicGainNode) {
    const ctx = getAudioCtx();
    _musicGainNode = ctx.createGain();
    _musicGainNode.gain.value = 0.6;
    _musicGainNode.connect(ctx.destination);
  }
  return _musicGainNode;
}

async function _loadMusicBuffer(workoutId, phase) {
  const key = `${workoutId}_${phase}`;
  if (_musicBufferCache.has(key)) return { buffer: _musicBufferCache.get(key), key };
  let blob = await loadMusicBlob(workoutId, phase);
  if (!blob) blob = await loadMusicBlob('_demo', phase);
  if (!blob) return null;
  const ctx = getAudioCtx();
  const arrayBuf = await blob.arrayBuffer();
  const buffer = await ctx.decodeAudioData(arrayBuf);
  _musicBufferCache.set(key, buffer);
  return { buffer, key };
}

function _currentMusicPosition() {
  if (!_phaseCurrentKey || !_musicSource) return 0;
  const ctx = getAudioCtx();
  const buf = _musicBufferCache.get(_phaseCurrentKey);
  const loopEnd = buf ? _calcLoopEnd(buf) : 1;
  return (_musicOffsetAtStart + (ctx.currentTime - _musicCtxTimeAtStart)) % loopEnd;
}

async function playPhaseMusic(workoutId, phase) {
  const _wl = JSON.parse(localStorage.getItem('odindva_workouts') || '[]');
  const _ww = _wl.find(x => String(x.id) === String(workoutId));
  if (_ww && _ww.musicDisabled) return;

  const key = `${workoutId}_${phase}`;

  // Same phase already playing — nothing to do
  if (_phaseCurrentKey === key && _musicSource) return;

  // Save position of outgoing phase
  if (_phaseCurrentKey && _musicSource) {
    _phaseSavedTimes.set(_phaseCurrentKey, _currentMusicPosition());
  }

  // Stop current source
  if (_musicSource) {
    _musicSource.onended = null;
    try { _musicSource.stop(); } catch(e) {}
    _musicSource = null;
  }

  const result = await _loadMusicBuffer(workoutId, phase);
  if (!result) return;
  const { buffer } = result;

  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') await ctx.resume();

  const loopEnd = _calcLoopEnd(buffer);
  const offset = (_phaseSavedTimes.get(key) || 0) % loopEnd;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = loopEnd;
  source.connect(_getMusicGain());

  _musicSource = source;
  _phaseCurrentKey = key;
  _musicOffsetAtStart = offset;
  _musicCtxTimeAtStart = ctx.currentTime;
  source.start(0, offset);
}

function stopPhaseMusic() {
  if (_musicSource) {
    _musicSource.onended = null;
    try { _musicSource.stop(); } catch(e) {}
    _musicSource = null;
  }
  _phaseCurrentKey = null;
  _phaseSavedTimes.clear();
  _musicBufferCache.clear();
  _musicOffsetAtStart = 0;
  _musicCtxTimeAtStart = 0;
}

function pausePhaseMusic() {
  if (!_musicSource || !_phaseCurrentKey) return;
  _phaseSavedTimes.set(_phaseCurrentKey, _currentMusicPosition());
  _musicSource.onended = null;
  try { _musicSource.stop(); } catch(e) {}
  _musicSource = null;
}

function resumePhaseMusic() {
  if (!_phaseCurrentKey) return;
  const buf = _musicBufferCache.get(_phaseCurrentKey);
  if (!buf) return;
  const ctx = getAudioCtx();
  const loopEnd = _calcLoopEnd(buf);
  const offset = (_phaseSavedTimes.get(_phaseCurrentKey) || 0) % loopEnd;

  const source = ctx.createBufferSource();
  source.buffer = buf;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = loopEnd;
  source.connect(_getMusicGain());

  _musicSource = source;
  _musicOffsetAtStart = offset;
  _musicCtxTimeAtStart = ctx.currentTime;
  source.start(0, offset);
}

/* ===== APP STATE ===== */
const state = {
  workouts: [],
  editing: null,
  exercises: [],
};

// Timer runtime state
const timer = {
  workout: null,
  currentRound: 0,
  currentExIdx: 0,
  phase: 'idle',     // idle | prep | work | rest | done
  timeLeft: 0,
  totalElapsed: 0,
  intervalId: null,
  startTs: null,
  log: [],
  paused: false,
};

/* ===== STORAGE ===== */
function saveWorkouts() {
  localStorage.setItem('odindva_workouts', JSON.stringify(state.workouts));
}

function loadWorkouts() {
  try {
    state.workouts = JSON.parse(localStorage.getItem('odindva_workouts')) || [];
  } catch { state.workouts = []; }
}

/* ===== SCREEN NAVIGATION ===== */
const screens = document.querySelectorAll('.screen');

function showScreen(id, slideOutCurrent = true) {
  const current = document.querySelector('.screen.active');
  const next = document.getElementById(id);
  if (!next || current === next) return;

  if (current && slideOutCurrent) {
    current.classList.add('slide-out');
    current.classList.remove('active');
    setTimeout(() => current.classList.remove('slide-out'), 400);
  } else if (current) {
    current.classList.remove('active');
  }

  next.classList.remove('slide-out');
  // force reflow
  void next.offsetWidth;
  next.classList.add('active');
}

/* ===== HOME ===== */
function renderHome() {
  const list = document.getElementById('workouts-list');
  const empty = document.getElementById('empty-state');

  // Remove old cards
  list.querySelectorAll('.workout-card').forEach(c => c.remove());

  if (state.workouts.length === 0) {
    empty.style.display = '';
    renderProgress();
    return;
  }
  empty.style.display = 'none';

  state.workouts.forEach((w, i) => {
    const card = document.createElement('div');
    card.className = 'workout-card';
    card.style.animationDelay = `${i * 0.05}s`;
    card.innerHTML = `
      <div class="workout-card-icon">${workoutIcon(w.icon)}</div>
      <div class="workout-card-info">
        <div class="workout-card-name">${escHtml(w.name)}</div>
        <div class="workout-card-meta">${w.intervals} упражнений · ${fmtMin((w.prepTime || 0) + w.exercises.reduce((s, ex) => s + (ex.duration || 0) + (ex.rest || 0), 0))} итого</div>
      </div>
      <div class="workout-card-arrow">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    `;

    card.addEventListener('click', () => openDetail(w));

    list.appendChild(card);
  });
  renderProgress();
}

function deleteWorkout(id) {
  state.workouts = state.workouts.filter(w => w.id !== id);
  saveWorkouts();
  renderHome();
}

/* ===== DETAIL SCREEN ===== */
let detailWorkout = null;

function openDetail(w) {
  detailWorkout = w;
  document.getElementById('detail-title').textContent = w.name;

  const exList = document.getElementById('detail-exercises');
  exList.innerHTML = '';
  w.exercises.forEach((ex, i) => {
    const row = document.createElement('div');
    row.className = 'detail-exercise-row';
    row.dataset.id = String(ex.id);
    const dur = ex.duration || w.work;
    const rst = ex.rest !== undefined ? ex.rest : w.rest;
    const restHtml = rst > 0
      ? `<span class="detail-ex-rest"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M17 21a9 9 0 1 1 0-18 7 7 0 1 0 0 18z"/></svg> ${fmtSec(rst)}</span>`
      : '';
    row.innerHTML = `<span class="detail-ex-drag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="16" x2="20" y2="16"/></svg></span><span class="detail-ex-num">${i + 1}</span><span class="detail-ex-name">${escHtml(ex.name)}</span><span class="detail-ex-dur">${fmtSec(dur)}</span>${restHtml}`;
    exList.appendChild(row);
  });
  makeSortable(exList, '.detail-exercise-row', '.detail-ex-drag', () => {
    const items = [...exList.querySelectorAll('.detail-exercise-row')];
    const newOrder = items.map(el => detailWorkout.exercises.find(ex => String(ex.id) === el.dataset.id)).filter(Boolean);
    detailWorkout.exercises = newOrder;
    items.forEach((el, i) => el.querySelector('.detail-ex-num').textContent = i + 1);
    const wi = state.workouts.findIndex(ww => ww.id === detailWorkout.id);
    if (wi !== -1) { state.workouts[wi].exercises = newOrder; saveWorkouts(); }
  });

  // Show music track name if assigned
  let musicRow = document.getElementById('detail-music-row');
  if (!musicRow) {
    musicRow = document.createElement('div');
    musicRow.id = 'detail-music-row';
    musicRow.className = 'detail-music-row';
    document.getElementById('detail-exercises').after(musicRow);
  }
  const tracks = [
    { label: 'Работа',  name: w.musicName },
    { label: 'Отдых',   name: w.musicNameRest },
    { label: 'Финиш',   name: w.musicNameFin },
  ].filter(t => t.name);

  if (w.musicDisabled) {
    musicRow.innerHTML = `<div class="detail-music-line"><span class="detail-music-beep-note">🔕 Только бип — без музыки</span></div>`;
    musicRow.style.display = 'block';
  } else if (tracks.length > 0) {
    musicRow.innerHTML = tracks.map(t => `
      <div class="detail-music-line">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        <span class="detail-music-phase">${t.label}</span>
        <span class="detail-music-name">${escHtml(t.name)}</span>
      </div>`).join('');
    musicRow.style.display = 'block';
  } else {
    musicRow.style.display = 'none';
  }

  showScreen('screen-detail');
}

function showConfirm(msg, onConfirm) {
  const overlay = document.getElementById('confirm-overlay');
  document.getElementById('confirm-msg').textContent = msg;
  overlay.style.display = 'flex';
  const okBtn = document.getElementById('confirm-ok');
  const cancelBtn = document.getElementById('confirm-cancel');
  function dismiss() {
    overlay.style.display = 'none';
    okBtn.removeEventListener('click', onOk);
    cancelBtn.removeEventListener('click', onCancel);
  }
  function onOk() { dismiss(); onConfirm(); }
  function onCancel() { dismiss(); }
  okBtn.addEventListener('click', onOk);
  cancelBtn.addEventListener('click', onCancel);
}

function openGearSheet() {
  const overlay = document.getElementById('sheet-overlay');
  const sheet = document.getElementById('bottom-sheet');
  overlay.style.display = 'flex';
  void sheet.offsetWidth;
  sheet.classList.add('sheet-open');
}

function closeGearSheet() {
  const overlay = document.getElementById('sheet-overlay');
  const sheet = document.getElementById('bottom-sheet');
  sheet.classList.remove('sheet-open');
  setTimeout(() => { overlay.style.display = 'none'; }, 300);
}

document.getElementById('btn-detail-gear').addEventListener('click', openGearSheet);
document.getElementById('sheet-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('sheet-overlay')) closeGearSheet();
});
document.getElementById('sheet-export').addEventListener('click', () => {
  closeGearSheet();
  if (detailWorkout) exportWorkout(detailWorkout);
});
document.getElementById('sheet-cancel').addEventListener('click', closeGearSheet);

document.getElementById('sheet-delete').addEventListener('click', () => {
  if (!detailWorkout) return;
  const w = detailWorkout;
  closeGearSheet();
  setTimeout(() => {
    showConfirm(`Удалить «${w.name}»?`, () => {
      deleteAllMusicBlobs(w.id);
      deleteWorkout(w.id);
      const home = document.getElementById('screen-home');
      const detail = document.getElementById('screen-detail');
      detail.classList.remove('active');
      home.classList.remove('slide-out');
      home.classList.add('active');
      renderHome();
    });
  }, 320);
});

document.getElementById('sheet-edit').addEventListener('click', () => {
  closeGearSheet();
  if (!detailWorkout) return;
  openEditScreen(detailWorkout);
});

document.getElementById('btn-back-detail').addEventListener('click', () => {
  const home = document.getElementById('screen-home');
  const detail = document.getElementById('screen-detail');
  detail.classList.remove('active');
  home.classList.remove('slide-out');
  home.classList.add('active');
});

document.getElementById('btn-start-workout').addEventListener('click', () => {
  if (detailWorkout) startWorkout(detailWorkout);
});

/* ===== EDIT WORKOUT ===== */
function openEditScreen(w) {
  formSettings = { intervals: 0, work: w.work || 30, rest: w.rest || 15, prepTime: w.prepTime || 3 };
  formExercises = [];
  resetFormMusic();
  formMusicDisabled = w.musicDisabled || false;
  setFormMusicUI('work',     w.musicName         || null);
  setFormMusicUI('rest',     w.musicNameRest     || null);
  setFormMusicUI('fin',      w.musicNameFin      || null);
  updateMusicDisabledUI();

  document.getElementById('workout-name').value = w.name;
  document.getElementById('exercises-list').innerHTML = '';
  // Use addExercise to populate rows (handles duration controls + formExercises sync)
  w.exercises.forEach(ex => addExercise(ex.name, ex.duration || w.work, ex.rest !== undefined ? ex.rest : w.rest));

  updateStepperDisplay();
  // Mark as editing
  document.getElementById('screen-create').dataset.editId = w.id;
  document.getElementById('create-screen-title').textContent = w.name;
  document.getElementById('btn-save-workout').textContent = 'Сохранить';
  showScreen('screen-create');
}

/* ===== PROGRESS ===== */
const RU_DAYS = ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
const RU_MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

const WORKOUT_ICONS = {
  zap:      '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  flame:    '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  target:   '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  star:     '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  heart:    '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  trophy:   '<line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><path d="M7 4H17l-2 9H9L7 4z"/><path d="M5 4H3v6h2"/><path d="M19 4H21v6h-2"/>',
  sun:      '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
};
const ICON_KEYS = Object.keys(WORKOUT_ICONS);

function workoutIcon(key, size = 22) {
  const paths = WORKOUT_ICONS[key] || WORKOUT_ICONS.zap;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}">${paths}</svg>`;
}

function fmtTotalTime(s) {
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h} ч ${m} мин` : `${h} ч`;
  }
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} мин` : `${s} с`;
}

let progressDetailWorkout = null; // workout name key for current detail

function renderProgress() {
  const list = document.getElementById('workouts-list');
  const old = list.querySelector('.progress-section');
  if (old) old.remove();

  const history = JSON.parse(localStorage.getItem('odindva_history') || '[]');
  if (history.length === 0) return;

  // Group by workout name
  const groups = {};
  history.forEach((item, idx) => {
    const key = item.workoutName;
    if (!groups[key]) {
      groups[key] = {
        name: key,
        icon: item.icon || 'zap',
        sessions: [],
        totalTime: 0,
        totalExercises: 0,
        lastDate: item.date,
      };
    }
    groups[key].sessions.push({ ...item, origIdx: idx });
    groups[key].totalTime += item.totalTime || 0;
    groups[key].totalExercises += item.exercises || 0;
  });

  const cards = Object.values(groups).sort(
    (a, b) => new Date(b.lastDate) - new Date(a.lastDate)
  );

  // Grand totals for header
  const grandSessions = history.length;
  const grandTime = history.reduce((acc, item) => acc + (item.totalTime || 0), 0);

  const section = document.createElement('div');
  section.className = 'progress-section';

  const header = document.createElement('div');
  header.className = 'progress-header';
  header.innerHTML = `
    <span class="progress-header-title">Прогресс</span>
    <span class="progress-header-stats">${grandSessions} сессий · ${fmtTotalTime(grandTime)}</span>
  `;
  section.appendChild(header);

  const rowsWrap = document.createElement('div');
  rowsWrap.className = 'progress-cards';
  section.appendChild(rowsWrap);

  const RU_MONTHS_SHORT = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
  const RU_DAYS_SHORT = ['вс','пн','вт','ср','чт','пт','сб'];

  cards.forEach((group) => {
    const d = new Date(group.lastDate);
    const sessWord = group.sessions.length === 1 ? 'сессия' :
      (group.sessions.length < 5 ? 'сессии' : 'сессий');

    const card = document.createElement('div');
    card.className = 'progress-card';
    card.innerHTML = `
      <div class="pcard-top">
        <span class="pcard-sessions">${group.sessions.length}</span>
        <span class="pcard-sessions-label">${sessWord}</span>
      </div>
      <div class="pcard-name">${escHtml(group.name)}</div>
      <div class="pcard-bottom">
        <span class="pcard-time">${fmtTotalTime(group.totalTime)}</span>
        <span class="pcard-date">${d.getDate()} ${RU_MONTHS_SHORT[d.getMonth()]}</span>
      </div>
    `;
    card.addEventListener('click', () => openProgressDetail(group));
    rowsWrap.appendChild(card);
  });

  list.appendChild(section);
}

function deleteHistoryItem(origIdx) {
  const history = JSON.parse(localStorage.getItem('odindva_history') || '[]');
  history.splice(origIdx, 1);
  localStorage.setItem('odindva_history', JSON.stringify(history));
}

function openProgressDetail(group) {
  progressDetailWorkout = group.name;

  document.getElementById('pdet-header-icon').innerHTML = workoutIcon(group.icon, 20);
  document.getElementById('pdet-header-name').textContent = group.name;

  document.getElementById('pdet-sum-sessions').textContent = group.sessions.length;
  document.getElementById('pdet-sum-time').textContent = fmtMin(group.totalTime);
  document.getElementById('pdet-sum-ex').textContent = group.totalExercises;

  const tbody = document.getElementById('pdet-tbody');
  tbody.innerHTML = '';

  const RU_DAYS_SHORT = ['вс','пн','вт','ср','чт','пт','сб'];
  const RU_MONTHS_SHORT = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

  group.sessions.forEach(session => {
    const d = new Date(session.date);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const dateMain = `${d.getDate()} ${RU_MONTHS_SHORT[d.getMonth()]}`;
    const dateSub = `${RU_DAYS_SHORT[d.getDay()]} ${hh}:${mm}`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="pdet-td-date">
        ${dateMain}
        <div class="pdet-td-date-sub">${dateSub}</div>
      </td>
      <td class="pdet-td-time">${fmtMin(session.totalTime)}</td>
      <td class="pdet-td-ex">${session.exercises || 0}</td>
      <td class="pdet-td-del">
        <button class="pdet-del-btn" aria-label="Удалить">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>
      </td>
    `;
    tr.querySelector('.pdet-del-btn').addEventListener('click', () => {
      showConfirm('Удалить запись?', () => {
        deleteHistoryItem(session.origIdx);
        tr.style.transition = 'opacity 0.2s';
        tr.style.opacity = '0';
        setTimeout(() => {
          tr.remove();
          // update summary
          group.sessions = group.sessions.filter(s => s !== session);
          group.totalTime -= session.totalTime || 0;
          group.totalExercises -= session.exercises || 0;
          document.getElementById('pdet-sum-sessions').textContent = group.sessions.length;
          document.getElementById('pdet-sum-time').textContent = fmtMin(group.totalTime);
          document.getElementById('pdet-sum-ex').textContent = group.totalExercises;
          renderProgress();
          if (group.sessions.length === 0) {
            const home = document.getElementById('screen-home');
            const det = document.getElementById('screen-progress-detail');
            det.classList.remove('active');
            home.classList.remove('slide-out');
            home.classList.add('active');
          }
        }, 220);
      });
    });
    tbody.appendChild(tr);
  });

  showScreen('screen-progress-detail');
}

/* ===== CREATE WORKOUT ===== */
let formSettings = { intervals: 0, work: 30, rest: 15, prepTime: 3 };
let formExercises = [];
const formMusic = {
  work:     { blob: null, action: null },
  rest:     { blob: null, action: null },
  fin:      { blob: null, action: null },
};
let formMusicDisabled = false;

function updateMusicDisabledUI() {
  const toggle = document.getElementById('music-disabled-toggle');
  const wrap = document.getElementById('music-phases-wrap');
  if (toggle) toggle.checked = formMusicDisabled;
  if (wrap) wrap.classList.toggle('music-disabled', formMusicDisabled);
}

function resetFormMusic() {
  ['work', 'rest', 'fin'].forEach(p => { formMusic[p] = { blob: null, action: null }; });
}

function setFormMusicUI(phase, name) {
  const info   = document.getElementById(`music-track-info-${phase}`);
  const nameEl = document.getElementById(`music-track-name-${phase}`);
  const removeBtn = document.getElementById(`music-remove-btn-${phase}`);
  if (name) {
    nameEl.textContent = name;
    info.style.display = 'flex';
    info.classList.remove('music-demo-active');
    if (removeBtn) removeBtn.style.display = '';
  } else if (localStorage.getItem('odindva_demo_v5')) {
    nameEl.textContent = 'Демо';
    info.style.display = 'flex';
    info.classList.add('music-demo-active');
    if (removeBtn) removeBtn.style.display = 'none';
  } else {
    info.style.display = 'none';
    info.classList.remove('music-demo-active');
  }
}

// File pickers for work, rest, and fin phases
['work', 'rest', 'fin'].forEach(phase => {
  document.getElementById(`music-file-input-${phase}`).addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    formMusic[phase].blob = file;
    formMusic[phase].action = 'set';
    setFormMusicUI(phase, file.name);
    e.target.value = '';
  });
  document.getElementById(`music-remove-btn-${phase}`).addEventListener('click', () => {
    formMusic[phase].blob = null;
    formMusic[phase].action = 'remove';
    setFormMusicUI(phase, null);
  });
});

function openCreateScreen() {
  formSettings = { intervals: 0, work: 30, rest: 15, prepTime: 3 };
  formExercises = [];
  resetFormMusic();
  formMusicDisabled = false;
  document.getElementById('workout-name').value = '';
  document.getElementById('exercises-list').innerHTML = '';
  document.getElementById('screen-create').dataset.editId = '';
  document.getElementById('create-screen-title').textContent = 'Новая тренировка';
  ['work', 'rest', 'fin'].forEach(p => setFormMusicUI(p, null));
  updateMusicDisabledUI();
  updateStepperDisplay();
  showScreen('screen-create');
}

function updateStepperDisplay() {
  document.getElementById('val-prepTime').textContent = formSettings.prepTime;
}

function addExercise(name = '', duration = null, rest = null) {
  const lastEx = formExercises.length > 0 ? formExercises[formExercises.length - 1] : null;
  const dur = (duration !== null && duration > 0) ? duration : (lastEx ? lastEx.duration : formSettings.work);
  const rst = (rest !== null && rest >= 0) ? rest : (lastEx ? lastEx.rest : formSettings.rest);
  const idx = formExercises.length;
  const ex = { id: Date.now() + idx, name, duration: dur, rest: rst };
  formExercises.push(ex);
  formSettings.intervals++;
  updateStepperDisplay();

  const item = document.createElement('div');
  item.className = 'exercise-item';
  item.dataset.id = ex.id;
  item.innerHTML = `
    <div class="ex-header">
      <div class="ex-drag-handle" aria-label="Перетащить">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="16" x2="20" y2="16"/></svg>
      </div>
      <div class="exercise-num">${idx + 1}</div>
      <input type="text" class="exercise-input" placeholder="Название упражнения" value="${escHtml(name)}" />
      <button class="btn-del-exercise" aria-label="Удалить">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="ex-timings">
      <div class="ex-timing-row">
        <span class="ex-dur-label">Работа</span>
        <div class="exercise-dur">
          <button class="ex-dur-btn ex-dur-minus">−</button>
          <span class="ex-dur-val">${dur}</span>
          <button class="ex-dur-btn ex-dur-plus">+</button>
        </div>
      </div>
      <div class="ex-timing-row">
        <span class="ex-dur-label">Отдых</span>
        <div class="exercise-dur">
          <button class="ex-dur-btn ex-rest-minus">−</button>
          <span class="ex-rest-val">${rst}</span>
          <button class="ex-dur-btn ex-rest-plus">+</button>
        </div>
      </div>
    </div>
  `;

  item.querySelector('.exercise-input').addEventListener('input', (e) => {
    const found = formExercises.find(x => x.id === ex.id);
    if (found) found.name = e.target.value;
  });

  item.querySelector('.ex-dur-minus').addEventListener('click', () => {
    const found = formExercises.find(x => x.id === ex.id);
    if (found) {
      found.duration = Math.max(5, found.duration - 5);
      item.querySelector('.ex-dur-val').textContent = found.duration;
      vibrate([10]);
    }
  });

  item.querySelector('.ex-dur-plus').addEventListener('click', () => {
    const found = formExercises.find(x => x.id === ex.id);
    if (found) {
      found.duration = Math.min(300, found.duration + 5);
      item.querySelector('.ex-dur-val').textContent = found.duration;
      vibrate([10]);
    }
  });

  item.querySelector('.ex-rest-minus').addEventListener('click', () => {
    const found = formExercises.find(x => x.id === ex.id);
    if (found) {
      found.rest = Math.max(0, found.rest - 5);
      item.querySelector('.ex-rest-val').textContent = found.rest;
      vibrate([10]);
    }
  });

  item.querySelector('.ex-rest-plus').addEventListener('click', () => {
    const found = formExercises.find(x => x.id === ex.id);
    if (found) {
      found.rest = Math.min(120, found.rest + 5);
      item.querySelector('.ex-rest-val').textContent = found.rest;
      vibrate([10]);
    }
  });

  item.querySelector('.btn-del-exercise').addEventListener('click', () => {
    formExercises = formExercises.filter(x => x.id !== ex.id);
    formSettings.intervals = Math.max(0, formSettings.intervals - 1);
    updateStepperDisplay();
    item.style.transform = 'translateX(-20px)';
    item.style.opacity = '0';
    setTimeout(() => {
      item.remove();
      rebuildExerciseNums();
    }, 250);
  });

  document.getElementById('exercises-list').appendChild(item);
}

function rebuildExerciseNums() {
  document.querySelectorAll('.exercise-item .exercise-num').forEach((el, i) => {
    el.textContent = i + 1;
  });
}

/* ===== DRAG & DROP EXERCISES ===== */
function makeSortable(list, itemSel, handleSel, onEnd) {
  function startDrag(dragEl, startY) {
    let dy = 0;
    dragEl.style.animation = 'none';   // disable slideUp fill-mode overriding transform
    dragEl.classList.add('ex-dragging');
    vibrate([15]);

    function move(clientY) {
      dy = clientY - startY;
      dragEl.style.transform = `translateY(${dy}px)`;
      const dragRect = dragEl.getBoundingClientRect();
      const dragMid  = dragRect.top + dragRect.height / 2;
      for (const sib of list.querySelectorAll(itemSel)) {
        if (sib === dragEl) continue;
        const sibRect = sib.getBoundingClientRect();
        if (Math.abs(dragMid - (sibRect.top + sibRect.height / 2)) < sibRect.height * 0.5) {
          const dragIdx = [...list.children].indexOf(dragEl);
          const sibIdx  = [...list.children].indexOf(sib);
          dragIdx < sibIdx ? list.insertBefore(sib, dragEl) : list.insertBefore(dragEl, sib);
          const newNaturalTop = dragEl.getBoundingClientRect().top - dy;
          dy = dragRect.top - newNaturalTop;
          dragEl.style.transform = `translateY(${dy}px)`;
          vibrate([8]);
          break;
        }
      }
    }

    function drop() {
      dragEl.style.animation = '';
      dragEl.classList.remove('ex-dragging');
      dragEl.style.transform = '';
      onEnd();
    }

    return { move, drop };
  }

  // ---- Touch (Safari iOS + all mobile) ----
  list.addEventListener('touchstart', (e) => {
    const handle = e.target.closest(handleSel);
    if (!handle) return;
    const item = handle.closest(itemSel);
    if (!item) return;
    e.preventDefault();                // must be non-passive to block scroll

    const { move, drop } = startDrag(item, e.touches[0].clientY);

    function tmove(ev) { ev.preventDefault(); move(ev.touches[0].clientY); }
    function tend()    { drop(); document.removeEventListener('touchmove', tmove); document.removeEventListener('touchend', tend); document.removeEventListener('touchcancel', tend); }

    document.addEventListener('touchmove',   tmove,  { passive: false });
    document.addEventListener('touchend',    tend);
    document.addEventListener('touchcancel', tend);
  }, { passive: false });

  // ---- Mouse (desktop) ----
  list.addEventListener('mousedown', (e) => {
    const handle = e.target.closest(handleSel);
    if (!handle) return;
    const item = handle.closest(itemSel);
    if (!item) return;
    if (e.button !== 0) return;
    e.preventDefault();

    const { move, drop } = startDrag(item, e.clientY);

    function mmove(ev) { move(ev.clientY); }
    function mup()     { drop(); document.removeEventListener('mousemove', mmove); document.removeEventListener('mouseup', mup); }

    document.addEventListener('mousemove', mmove);
    document.addEventListener('mouseup',   mup);
  });
}

function initExerciseDragDrop() {
  const list = document.getElementById('exercises-list');
  makeSortable(list, '.exercise-item', '.ex-drag-handle', () => {
    const newOrder = [...list.querySelectorAll('.exercise-item')]
      .map(el => formExercises.find(ex => String(ex.id) === el.dataset.id))
      .filter(Boolean);
    formExercises.length = 0;
    formExercises.push(...newOrder);
    rebuildExerciseNums();
  });
}

function saveWorkout() {
  const name = document.getElementById('workout-name').value.trim();
  if (!name) {
    flashInput(document.getElementById('workout-name'));
    return;
  }

  const inputs = document.querySelectorAll('#exercises-list .exercise-input');
  const exercises = Array.from(inputs).map((inp, i) => ({
    id: i + 1,
    name: inp.value.trim() || `Упражнение ${i + 1}`,
    duration: formExercises[i] ? formExercises[i].duration : formSettings.work,
    rest: formExercises[i] !== undefined ? formExercises[i].rest : formSettings.rest,
  }));

  if (exercises.length === 0) {
    exercises.push({ id: 1, name: 'Упражнение' });
  }

  const editId = document.getElementById('screen-create').dataset.editId;

  const resolveName = (phase, existing) => {
    const m = formMusic[phase];
    if (m.action === 'set') return m.blob.name;
    if (m.action === 'remove') return null;
    return existing || null;
  };

  if (editId) {
    // Edit existing
    const idx = state.workouts.findIndex(w => String(w.id) === String(editId));
    if (idx !== -1) {
      const old = state.workouts[idx];
      state.workouts[idx] = {
        ...old,
        name,
        exercises,
        intervals: exercises.length,
        work: formSettings.work,
        rest: formSettings.rest,
        prepTime: formSettings.prepTime,
        musicDisabled:     formMusicDisabled,
        musicName:         resolveName('work', old.musicName),
        musicNameRest:     resolveName('rest', old.musicNameRest),
        musicNameFin:      resolveName('fin',  old.musicNameFin),
      };
      detailWorkout = state.workouts[idx];

      // Persist music blob changes per phase
      ['work', 'rest', 'fin'].forEach(p => {
        const m = formMusic[p];
        if (m.action === 'set' && m.blob) saveMusicBlob(editId, p, m.blob);
        else if (m.action === 'remove')   deleteMusicBlob(editId, p);
      });
    }
    document.getElementById('screen-create').dataset.editId = '';
    saveWorkouts();
    renderHome();
    // Go back to detail
    openDetail(detailWorkout);
    return;
  }

  const workout = {
    id: Date.now(),
    name,
    exercises,
    intervals: exercises.length,
    work: formSettings.work,
    rest: formSettings.rest,
    prepTime: formSettings.prepTime,
    musicDisabled:     formMusicDisabled,
    musicName:         formMusic.work.blob ? formMusic.work.blob.name : null,
    musicNameRest:     formMusic.rest.blob ? formMusic.rest.blob.name : null,
    musicNameFin:      formMusic.fin.blob  ? formMusic.fin.blob.name  : null,
    icon: ICON_KEYS[Math.floor(Math.random() * ICON_KEYS.length)],
    createdAt: new Date().toISOString(),
  };

  ['work', 'rest', 'fin'].forEach(p => {
    if (formMusic[p].blob) saveMusicBlob(workout.id, p, formMusic[p].blob);
  });

  state.workouts.unshift(workout);
  saveWorkouts();
  renderHome();
  showScreen('screen-home', false);
  const home = document.getElementById('screen-home');
  home.style.transform = 'translateX(-40%)';
  home.classList.add('active');
  void home.offsetWidth;
  home.style.transform = '';
}

function flashInput(el) {
  el.style.borderColor = 'var(--accent2)';
  el.style.animation = 'none';
  setTimeout(() => { el.style.borderColor = ''; }, 600);
}

/* ===== TIMER CORE ===== */
const CIRCUMFERENCE = 2 * Math.PI * 120; // 753.98

function startWorkout(workout) {
  requestWakeLock();
  timer.workout = workout;
  timer.currentRound = 0;
  timer.currentExIdx = 0;
  timer.phase = 'idle';
  timer.timeLeft = 0;
  timer.totalElapsed = 0;
  timer.log = [];
  timer.paused = false;
  clearInterval(timer.intervalId);

  document.getElementById('timer-workout-name').textContent = workout.name;
  renderIntervalDots(workout.intervals);
  setCircleProgress(0);
  setCircleColor('work');

  updateExerciseLabel('В ожидании', 'idle');
  document.getElementById('circle-time').textContent = '▶';
  document.getElementById('circle-sub').textContent = 'нажми чтобы начать';

  showScreen('screen-timer');
  setTimeout(() => {
    document.getElementById('circle-tap').classList.add('hint');
    setTimeout(() => document.getElementById('circle-tap').classList.remove('hint'), 5000);
  }, 600);
}

function renderIntervalDots(count) {
  const track = document.getElementById('intervals-track');
  track.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('div');
    dot.className = 'interval-dot';
    dot.id = `dot-${i}`;
    track.appendChild(dot);
  }
}

function updateDots(currentRound) {
  const total = timer.workout.intervals;
  for (let i = 0; i < total; i++) {
    const dot = document.getElementById(`dot-${i}`);
    if (!dot) continue;
    if (i < currentRound) {
      dot.classList.add('done');
      dot.classList.remove('active');
    } else if (i === currentRound) {
      dot.classList.add('active');
      dot.classList.remove('done');
    } else {
      dot.classList.remove('active', 'done');
    }
  }
}

function setCircleProgress(fraction) {
  // fraction: 0 = empty, 1 = full
  const offset = CIRCUMFERENCE * (1 - fraction);
  document.getElementById('circle-progress').style.strokeDashoffset = offset;
}

function setCircleColor(phase) {
  const el = document.getElementById('circle-progress');
  const pulse = document.getElementById('circle-pulse');
  const colors = {
    work: 'var(--work-color)',
    rest: 'var(--rest-color)',
    prep: 'var(--prep-color)',
  };
  el.style.stroke = colors[phase] || 'var(--work-color)';
  pulse.style.stroke = colors[phase] || 'var(--work-color)';
}

function updateExerciseLabel(name, phase) {
  const exName = document.getElementById('exercise-name');
  const badge = document.getElementById('phase-badge');
  exName.textContent = name || '';
  badge.className = 'phase-badge';

  const labels = { work: 'РАБОТА', rest: 'ОТДЫХ', cooldown: 'ЗАМИНКА', prep: 'ГОТОВЬСЯ', idle: 'ОЖИДАНИЕ' };
  badge.textContent = labels[phase] || '';
  if (phase !== 'work') badge.classList.add(phase);
}

function flashCircle() {
  const c = document.getElementById('circle-tap');
  c.classList.remove('flash');
  void c.offsetWidth;
  c.classList.add('flash');
  setTimeout(() => c.classList.remove('flash'), 600);
}

function tickTime() {
  const timeEl = document.getElementById('circle-time');
  timeEl.classList.remove('tick');
  void timeEl.offsetWidth;
  timeEl.classList.add('tick');
}

// Main tap handler
document.getElementById('circle-tap').addEventListener('click', handleTap);

function handleTap() {
  unlockAudioSync();
  if (timer.phase === 'idle') {
    // Wait for both AudioContext.resume() and beep buffers before starting prep
    Promise.all([_ctxResumePromise, _beepBuffersPromise]).then(() => {
      beginPrep();
    });
  } else if (timer.phase === 'done') {
    // do nothing, results screen handles it
  } else {
    togglePause();
  }
}

function togglePause() {
  timer.paused = !timer.paused;
  const sub = document.getElementById('circle-sub');
  const pulse = document.getElementById('circle-pulse');
  if (timer.paused) {
    sub.textContent = 'пауза · тап продолжить';
    pulse.classList.remove('beat');
    clearInterval(timer.intervalId);
    pausePhaseMusic();
  } else {
    sub.textContent = phaseSubLabel(timer.phase);
    pulse.classList.add('beat');
    resumePhaseMusic();
    runTick();
  }
}

function phaseSubLabel(phase) {
  const labels = { work: 'работай!', rest: 'отдыхай', prep: 'готовься' };
  return labels[phase] || '';
}

function beginPrep() {
  timer.phase = 'prep';
  timer.startTs = Date.now();
  document.getElementById('circle-time').textContent = '';
  document.getElementById('circle-sub').textContent = '';

  const overlay = document.getElementById('prep-overlay');
  const countEl = document.getElementById('prep-count');
  overlay.style.display = 'flex';
  setCircleColor('prep');

  const prepTime = timer.workout.prepTime || 3;
  let count = prepTime;
  countEl.textContent = count;
  // Beep only in last 3 seconds
  if (count <= 3) { beepTick(); vibrate([30]); } else { vibrate([10]); }

  const pid = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(pid);
      overlay.style.display = 'none';
      beepGo();
      vibrate([60]);
      startRound(0);
    } else {
      countEl.textContent = count;
      if (count <= 3) { beepTick(); vibrate([30]); } else { vibrate([10]); }
    }
  }, 1000);
}

let _skipShowTimeout = null;

function showSkipBtn() {
  clearTimeout(_skipShowTimeout);
  const wrap = document.getElementById('timer-skip-wrap');
  if (!wrap) return;
  wrap.style.display = 'flex';
  // force reflow then fade in after 2s
  _skipShowTimeout = setTimeout(() => {
    wrap.classList.add('skip-visible');
  }, 2000);
}

function hideSkipBtn() {
  clearTimeout(_skipShowTimeout);
  const wrap = document.getElementById('timer-skip-wrap');
  if (!wrap) return;
  wrap.classList.remove('skip-visible');
  wrap.style.display = 'none';
}

function startRound(roundIdx) {
  timer.currentRound = roundIdx;
  timer.paused = false;

  const workout = timer.workout;
  const exCount = workout.exercises.length;
  const exIdx = roundIdx % exCount;
  timer.currentExIdx = exIdx;

  const roundLabel = `Упражнение ${roundIdx + 1}/${workout.intervals}`;
  document.getElementById('timer-round-label').textContent = roundLabel;

  updateDots(roundIdx);
  setCircleColor('work');
  updateExerciseLabel(workout.exercises[exIdx].name, 'work');
  document.getElementById('circle-pulse').classList.add('beat');

  timer.phase = 'work';
  const exDur = (workout.exercises[exIdx] && workout.exercises[exIdx].duration) || workout.work;
  timer.timeLeft = exDur;
  timer.log.push({ round: roundIdx + 1, exercise: workout.exercises[exIdx].name, phase: 'work', duration: exDur });

  vibrate([50, 30, 50]);
  beepGo();
  playPhaseMusic(workout.id, 'work');
  flashCircle();
  showSkipBtn();
  runTick();
}

function runTick() {
  clearInterval(timer.intervalId);
  // Snap to display
  renderTimer();

  timer.intervalId = setInterval(() => {
    if (timer.paused) return;

    timer.timeLeft--;
    timer.totalElapsed++;
    renderTimer();

    if (timer.timeLeft <= 0) {
      clearInterval(timer.intervalId);
      onPhaseEnd();
    }
  }, 1000);
}

function renderTimer() {
  const workout = timer.workout;
  let total;
  if (timer.phase === 'work') {
    const exIdx = timer.currentExIdx || 0;
    total = (workout.exercises[exIdx] && workout.exercises[exIdx].duration) || workout.work;
  } else if (timer.phase === 'rest') {
    const exIdx = timer.currentExIdx || 0;
    total = (workout.exercises[exIdx] && workout.exercises[exIdx].rest !== undefined)
      ? workout.exercises[exIdx].rest
      : workout.rest;
  } else return;

  const timeEl = document.getElementById('circle-time');
  timeEl.textContent = fmtSec(timer.timeLeft);
  tickTime();

  const fraction = timer.timeLeft / total;
  setCircleProgress(fraction);

  // Last 3 seconds warning beeps (but not on very short intervals)
  if (timer.timeLeft > 0 && timer.timeLeft <= 3 && total > 4) {
    beepWarn();
  }

  document.getElementById('circle-sub').textContent = phaseSubLabel(timer.phase);
}

function onPhaseEnd() {
  const workout = timer.workout;
  flashCircle();
  beepEnd();
  vibrate([80]);

  if (timer.phase === 'work') {
    // Was working → go to rest
    const exRest = (workout.exercises[timer.currentExIdx] && workout.exercises[timer.currentExIdx].rest !== undefined)
      ? workout.exercises[timer.currentExIdx].rest
      : workout.rest;
    if (exRest > 0) {
      timer.phase = 'rest';
      timer.timeLeft = exRest;
      setCircleColor('rest');
      updateExerciseLabel(workout.exercises[timer.currentExIdx].name, 'rest');
      timer.log.push({ round: timer.currentRound + 1, exercise: 'Отдых', phase: 'rest', duration: exRest });
      beepGo();
      playPhaseMusic(workout.id, 'rest');
      showSkipBtn();
      runTick();
    } else {
      afterRest();
    }
  } else if (timer.phase === 'rest') {
    afterRest();
  }
}

function afterRest() {
  const workout = timer.workout;
  const nextRound = timer.currentRound + 1;

  if (nextRound >= workout.intervals) {
    finishWorkout();
  } else {
    startRound(nextRound);
  }
}

function finishWorkout() {
  clearInterval(timer.intervalId);
  timer.phase = 'done';
  releaseWakeLock();
  hideSkipBtn();
  playPhaseMusic(timer.workout.id, 'fin');
  document.getElementById('circle-pulse').classList.remove('beat');
  vibrate([100, 50, 100, 50, 200]);

  showResults();
}

/* ===== RESULTS ===== */
function showResults() {
  const workout = timer.workout;

  document.getElementById('results-subtitle').textContent = workout.name;
  document.getElementById('res-time').textContent = fmtMin(timer.totalElapsed);
  document.getElementById('res-exercises').textContent = workout.exercises.length;

  const logEl = document.getElementById('results-log');
  logEl.innerHTML = '';
  timer.log.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'log-entry';
    row.innerHTML = `
      <span class="log-name">Упражнение ${entry.round} · ${escHtml(entry.exercise)}</span>
      <span class="log-time">${fmtSec(entry.duration)}</span>
    `;
    logEl.appendChild(row);
  });

  // Save history to localStorage
  const history = JSON.parse(localStorage.getItem('odindva_history') || '[]');
  history.unshift({
    id: Date.now(),
    workoutName: workout.name,
    icon: workout.icon || 'zap',
    rounds: workout.intervals,
    totalTime: timer.totalElapsed,
    exercises: workout.exercises.length,
    log: [...timer.log],
    date: new Date().toISOString(),
  });
  localStorage.setItem('odindva_history', JSON.stringify(history.slice(0, 100)));

  showScreen('screen-results');
  spawnConfetti();
}

function spawnConfetti() {
  const area = document.getElementById('confetti-area');
  area.innerHTML = '';
  const colors = ['#7c6fff', '#ff6f84', '#ffd166', '#4ecdc4', '#a8ff78', '#f7971e'];
  for (let i = 0; i < 80; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    const size = 6 + Math.random() * 10;
    piece.style.cssText = `
      left: ${Math.random() * 100}%;
      width: ${size}px;
      height: ${size}px;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
      animation-duration: ${1.5 + Math.random() * 2.5}s;
      animation-delay: ${Math.random() * 0.8}s;
    `;
    area.appendChild(piece);
  }
  // Clean up after animation
  setTimeout(() => { area.innerHTML = ''; }, 5000);
}

/* ===== STOP TIMER ===== */
document.getElementById('btn-stop-timer').addEventListener('click', () => {
  clearInterval(timer.intervalId);
  timer.phase = 'idle';
  releaseWakeLock();
  hideSkipBtn();
  stopPhaseMusic();
  document.getElementById('circle-pulse').classList.remove('beat');
  document.getElementById('prep-overlay').style.display = 'none';

  const home = document.getElementById('screen-home');
  const timer_screen = document.getElementById('screen-timer');
  timer_screen.classList.remove('active');
  home.classList.remove('slide-out');
  home.classList.add('active');
});

document.getElementById('btn-skip-phase').addEventListener('click', () => {
  if (timer.phase !== 'work' && timer.phase !== 'rest') return;
  clearInterval(timer.intervalId);
  vibrate([30]);
  hideSkipBtn();
  onPhaseEnd();
});

/* ===== RESULTS BACK ===== */
document.getElementById('btn-results-home').addEventListener('click', () => {
  stopPhaseMusic();
  showScreen('screen-home', false);
  const home = document.getElementById('screen-home');
  home.style.transform = 'translateX(0)';
  home.classList.add('active');
  document.getElementById('screen-results').classList.remove('active');
  renderHome();
});

/* ===== STEPPERS ===== */
document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    const dir = parseInt(btn.dataset.dir);
  const mins = { intervals: 1, prepTime: 3 };
  const maxs = { intervals: 30, prepTime: 30 };

    formSettings[target] = Math.max(mins[target], Math.min(maxs[target], formSettings[target] + dir));
    updateStepperDisplay();
    vibrate([10]);
  });
});

/* ===== SETTINGS SHEET ===== */
function openSettingsSheet() {
  const overlay = document.getElementById('settings-overlay');
  const sheet = document.getElementById('settings-sheet');
  overlay.style.display = 'flex';
  void sheet.offsetWidth;
  sheet.classList.add('sheet-open');
}

function closeSettingsSheet() {
  const sheet = document.getElementById('settings-sheet');
  const overlay = document.getElementById('settings-overlay');
  sheet.classList.remove('sheet-open');
  setTimeout(() => { overlay.style.display = 'none'; }, 300);
}

function exportWorkout(workout) {
  const data = {
    version: 1,
    exported: new Date().toISOString(),
    workouts: [workout],
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `odindva-${workout.name.replace(/[^a-zA-Zа-яА-Я0-9]/g, '_')}-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importWorkouts(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.workouts || !Array.isArray(data.workouts)) throw new Error('bad format');
      const incoming = data.workouts;
      const existing = JSON.parse(localStorage.getItem('odindva_workouts') || '[]');
      // Merge: skip duplicates by id
      const existingIds = new Set(existing.map(w => String(w.id)));
      const newOnes = incoming.filter(w => !existingIds.has(String(w.id)));
      const merged = [...newOnes, ...existing];
      localStorage.setItem('odindva_workouts', JSON.stringify(merged));
      state.workouts = merged;
      renderHome();
      closeSettingsSheet();
      vibrate([30, 30, 30]);
    } catch (err) {
      showConfirm('Ошибка: неверный формат файла', () => {});
    }
  };
  reader.readAsText(file);
}

document.getElementById('settings-cancel').addEventListener('click', closeSettingsSheet);
document.getElementById('settings-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('settings-overlay')) closeSettingsSheet();
});
document.getElementById('settings-new-workout').addEventListener('click', () => {
  closeSettingsSheet();
  openCreateScreen();
});
document.getElementById('settings-import').addEventListener('click', () => {
  document.getElementById('settings-import-file').click();
});
document.getElementById('settings-import-file').addEventListener('change', (e) => {
  importWorkouts(e.target.files[0]);
  e.target.value = '';
});

document.getElementById('btn-back-progress').addEventListener('click', () => {
  const home = document.getElementById('screen-home');
  const det = document.getElementById('screen-progress-detail');
  det.classList.remove('active');
  home.classList.remove('slide-out');
  home.classList.add('active');
});

/* ===== WIRE UP BUTTONS ===== */
document.getElementById('btn-open-create').addEventListener('click', openSettingsSheet);
document.getElementById('btn-back-create').addEventListener('click', () => {
  const home = document.getElementById('screen-home');
  const create = document.getElementById('screen-create');
  create.classList.remove('active');
  home.classList.remove('slide-out');
  home.classList.add('active');
});
document.getElementById('btn-add-exercise').addEventListener('click', () => addExercise());
document.getElementById('btn-save-workout').addEventListener('click', saveWorkout);

/* ===== UTILS ===== */
function fmtSec(s) {
  if (s == null || isNaN(s)) return '0:00';
  const m = Math.floor(Math.abs(s) / 60);
  const sec = Math.abs(s) % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtMin(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// Music disabled toggle
document.getElementById('music-disabled-toggle').addEventListener('change', (e) => {
  formMusicDisabled = e.target.checked;
  updateMusicDisabledUI();
});

/* ===== ORPHANED MUSIC BLOBS CLEANUP ===== */
async function cleanOrphanedMusicBlobs() {
  try {
    const db = await openMusicDB();
    const allKeys = await new Promise((resolve, reject) => {
      const tx = db.transaction(MUSIC_STORE, 'readonly');
      const req = tx.objectStore(MUSIC_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = reject;
    });
    const validIds = new Set(state.workouts.map(w => String(w.id)));
    validIds.add('_demo');
    for (const key of allKeys) {
      const str = String(key);
      let workoutId = null;
      for (const phase of ['_work', '_rest', '_fin']) {
        if (str.endsWith(phase)) {
          workoutId = str.slice(0, -phase.length);
          break;
        }
      }
      if (workoutId && !validIds.has(workoutId)) {
        const phase = str.slice(workoutId.length + 1);
        deleteMusicBlob(workoutId, phase);
      }
    }
  } catch (e) { /* best-effort */ }
}

/* ===== INSTALL BANNER ===== */
let _installPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _installPrompt = e;
  if (!localStorage.getItem('odindva_install_dismissed')) {
    document.getElementById('install-banner').style.display = 'flex';
  }
});

document.getElementById('install-btn').addEventListener('click', () => {
  if (!_installPrompt) return;
  _installPrompt.prompt();
  _installPrompt.userChoice.then(() => {
    _installPrompt = null;
    document.getElementById('install-banner').style.display = 'none';
    localStorage.setItem('odindva_install_dismissed', '1');
  });
});

document.getElementById('install-dismiss').addEventListener('click', () => {
  document.getElementById('install-banner').style.display = 'none';
  localStorage.setItem('odindva_install_dismissed', '1');
});

/* ===== INIT ===== */
function init() {
  installDemoMusicIfNeeded();
  loadBeepBuffers();
  loadWorkouts();
  cleanOrphanedMusicBlobs();
  initExerciseDragDrop();
  renderHome();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
