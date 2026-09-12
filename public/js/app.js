/**
 * Bangkok traffic live video.
 *
 * The cameras publish H.264 over HLS with open CORS and no session, so the
 * browser plays them straight from the source. The server only hands over the
 * list of which cameras are up.
 */

const state = {
  cameras: [],
  players: new Map(), // camera id -> Hls instance
  view: 'dashboard',
  detections: new Map(), // camera id -> reading
  recordings: new Map(), // camera id -> what recorder/record.py has kept
  showGridOverlay: localStorage.getItem('showGridOverlay') === '1', // false by default: ในหน้าเมนูกล้องยังไม่ต้องขึ้นกรอบ
  showDetailOverlay: localStorage.getItem('showDetailOverlay') !== '0', // true by default: พอกดเข้าไปดูถึงจะขึ้นกรอบ
  // Measured against these servers: eight parallel fetches shared 2.5 Mbps in
  // total, while the streams themselves run 0.3-6.8 Mbps each. Playing all
  // nineteen at once cannot work, so only a few run at a time.
  playing: [],        // camera ids, oldest first
  observer: null,
  visibleCams: new Set(), // cards the observer currently reports on screen
  detail: null,       // camera open in the detail view
  detailMode: 'det',  // 'det' | 'live'
  detailTimer: null,
  focusId: null,      // camera the detector is working on continuously
  focusTimer: null,
  focusFps: 0,
  map: null,
  markers: [],
  watchlist: new Set(JSON.parse(localStorage.getItem('bkk_cctv_watchlist') || '[]')),
  trafficFilter: 'all', // 'all' | 'watchlist' | 'jam' | 'slow' | 'flowing'
  cameraTraffic: new Map(), // camera id -> { roadName, level, score, label, action }
  gridCols: Number(localStorage.getItem('bkk_cctv_grid_cols') || 3)
};

// Longdo publishes live traffic as vector tiles, open and CORS-enabled, so the
// colours below are theirs: green flowing, amber slowing, red congested.
const TRAFFIC_TILES = 'https://msv.longdo.com/maps/traffic/{z}/{x}/{y}.pbf';

const el = (id) => document.getElementById(id);

// --- Catalogue -------------------------------------------------------------

async function loadCameras() {
  const grid = el('camera-grid');
  setEmptyMessage('');
  // Cards the size of the real ones, so the grid does not jump when they land
  grid.innerHTML = Array.from({ length: 6 }, () => `
    <div class="camera-card rounded-2xl overflow-hidden">
      <div class="aspect-video skeleton-loading"></div>
      <div class="p-3 space-y-2">
        <div class="h-3.5 w-3/4 rounded skeleton-loading"></div>
        <div class="h-2.5 w-1/3 rounded skeleton-loading"></div>
      </div>
    </div>`).join('');

  try {
    const res = await fetch('/api/video-cameras');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.cameras = data.cameras || [];
    fillOrgFilter();
    if (state.view === 'map') { addCameraMarkers(); } else { render(); }
    refreshFocusTarget();
    clearAlert('cameras');
  } catch (err) {
    grid.innerHTML = '';
    setEmptyMessage(`โหลดรายการกล้องไม่สำเร็จ (${err.message})`);
    setAlert('cameras', { level: 'error', title: 'โหลดรายการกล้องไม่สำเร็จ', message: err.message, hint: 'กดรีเฟรชเพื่อลองใหม่' });
  }
}

// The owning agencies are whatever the feed happens to carry, so read them off
// the data rather than hard-coding iTIC and the highways department.
function fillOrgFilter() {
  const sel = el('org-filter');
  if (!sel) return;
  const orgs = [...new Set(state.cameras.map(c => c.org).filter(Boolean))].sort();
  const keep = sel.value;
  sel.innerHTML = '<option value="">ทุกหน่วยงาน</option>' +
    orgs.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  if (orgs.includes(keep)) sel.value = keep;
}

// --- Rendering -------------------------------------------------------------

function render() {
  const grid = el('camera-grid');

  if (!state.cameras.length) {
    grid.innerHTML = '';
    updateCameraCount(0);
    setEmptyMessage('ยังไม่มีกล้องที่พร้อมใช้งาน');
    return;
  }

  grid.innerHTML = state.cameras.map(cam => {
    const isStarred = state.watchlist.has(cam.id);
    return `
    <div data-cam-id="${escapeHtml(cam.id)}"
         data-search="${escapeHtml(((cam.title || '') + ' ' + (cam.org || '') + ' ' + cam.id).toLowerCase())}"
         data-org="${escapeHtml(cam.org || '')}"
         class="camera-card rounded-2xl overflow-hidden flex flex-col group relative">
      <div class="relative bg-black aspect-video flex items-center justify-center cursor-pointer" data-detail="${escapeHtml(cam.id)}">
        <div id="rec-${cssId(cam.id)}" class="absolute inset-0"></div>

        <!-- Top Left: LIVE indicator tag -->
        <div class="absolute top-2.5 left-2.5 z-10 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/65 backdrop-blur-md border border-white/10 text-[10px] font-bold text-white tracking-wider">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>LIVE</span>
        </div>

        <!-- Top Right Actions: Traffic Tag, Star, PiP, Fullscreen -->
        <div class="absolute top-2.5 right-2.5 z-10 flex items-center gap-1.5">
          <div id="tb-${cssId(cam.id)}"></div>
          <button data-star="${escapeHtml(cam.id)}"
                  class="card-action-btn ${isStarred ? 'is-starred' : ''}"
                  title="${isStarred ? 'ลบออกจาก Watchlist' : 'ปักหมุดลง Watchlist (ดูบ่อย)'}">
            <svg class="w-3.5 h-3.5 ${isStarred ? 'text-amber-400' : 'text-white'}" fill="${isStarred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" viewBox="0 0 20 20">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
          </button>
          <button data-pip="${cssId(cam.id)}" data-cam="${escapeHtml(cam.id)}"
                  class="card-action-btn"
                  title="Picture-in-Picture (ดูจอเล็ก)">
            <svg class="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 11h-6a1 1 0 00-1 1v4a1 1 0 001 1h6a1 1 0 001-1v-4a1 1 0 00-1-1z"/>
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z"/>
            </svg>
          </button>
          <button data-fullscreen="${cssId(cam.id)}" data-cam="${escapeHtml(cam.id)}"
                  class="card-action-btn"
                  title="เต็มจอ">
            <svg class="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5v4m0-4h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5"/>
            </svg>
          </button>
        </div>

        <div id="o-${cssId(cam.id)}" class="absolute inset-0 pointer-events-none z-20"></div>
        <div id="m-${cssId(cam.id)}" class="absolute inset-0 flex items-center justify-center text-xs text-slate-400 pointer-events-none"></div>
      </div>

      <div class="p-3.5 cursor-pointer hover:bg-slate-100/80 dark:hover:bg-slate-800/50 transition-colors flex-1 flex flex-col justify-between" data-detail="${escapeHtml(cam.id)}">
        <div>
          <h2 class="text-sm font-semibold leading-snug text-slate-900 dark:text-slate-100">${escapeHtml(cam.title)}</h2>
          <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-1.5">
            <svg class="w-3 h-3 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            <span class="truncate">${escapeHtml(cam.org)}</span>
          </p>
        </div>
        <div class="mt-2.5 pt-2 border-t border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between text-[11px]">
          <span id="c-${cssId(cam.id)}" class="text-emerald-600 dark:text-emerald-400 font-medium truncate"></span>
          <span class="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 ml-auto shrink-0">
            รายละเอียด AI
            <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          </span>
        </div>
      </div>
    </div>
  `; }).join('');

  grid.querySelectorAll('[data-detail]').forEach(node => {
    node.addEventListener('click', () => {
      const cam = state.cameras.find(c => c.id === node.dataset.detail);
      if (cam) openDetail(cam);
    });
  });

  grid.querySelectorAll('[data-star]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchlist(btn.dataset.star);
    });
  });

  grid.querySelectorAll('[data-pip]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const slot = el('rec-' + btn.dataset.pip);
      const video = slot ? slot.querySelector('video') : null;
      if (video) togglePiP(video);
    });
  });

  grid.querySelectorAll('[data-fullscreen]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const container = btn.closest('.relative');
      if (!container) return;
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (container.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      }
    });
  });

  applyFilter();
  paintCardCounts();
  paintTrafficBadges();
  updateWatchlistBadges();
  observeCards();
  state.cameras.forEach(paintRecording);
  renderDashboard();
}

// Camera ids contain characters that are awkward in selectors
const cssId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- Playback --------------------------------------------------------------

function attachPlayer(cam, prefix = 'v-') {
  const video = el(prefix + cssId(cam.id));
  const msg = prefix === 'v-' ? el('m-' + cssId(cam.id)) : null;
  if (!video) return;
  const key = prefix === 'v-' ? cam.id : 'popup:' + cam.id;

  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;

  const say = (text) => { if (msg) msg.textContent = text; };
  video.addEventListener('playing', () => {
    say('');
    drawBoxes(cam.id, el('o-' + cssId(cam.id)), video);
  });
  video.addEventListener('loadedmetadata', () => drawBoxes(cam.id, el('o-' + cssId(cam.id)), video));

  // Safari plays HLS itself; everything else needs hls.js
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = cam.hls;
    video.play().catch(() => say('แตะเพื่อเล่น'));
    return;
  }

  if (!window.Hls || !window.Hls.isSupported()) {
    say('เบราว์เซอร์นี้เล่นวิดีโอสดไม่ได้');
    return;
  }

  // Several of these publish only two 2-second segments, so the defaults
  // (which want three) stall forever waiting for a window that never arrives.
  const hls = new window.Hls({
    liveDurationInfinity: true,
    liveSyncDurationCount: 1,
    liveMaxLatencyDurationCount: 4,
    maxBufferLength: 8,
    backBufferLength: 0,
    manifestLoadingTimeOut: 20000,
    fragLoadingTimeOut: 40000
  });
  hls.loadSource(cam.hls);
  hls.attachMedia(video);

  hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
    clearAlert('cam:' + cam.id);
    video.muted = true;
    video.play().catch(() => say('แตะเพื่อเล่น'));
  });

  hls.on(window.Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal) return;
    // A live camera dropping out is ordinary; reconnect rather than give up
    if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
      say('กำลังเชื่อมต่อใหม่...');
      hls.startLoad();
    } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
      hls.recoverMediaError();
    } else {
      say('กล้องนี้ไม่พร้อมใช้งาน');
      hls.destroy();
      state.players.delete(key);
      setAlert('cam:' + cam.id, { level: 'warn', title: 'กล้องไม่พร้อมใช้งาน', message: cam.name || cam.id });
    }
  });

  state.players.set(key, hls);
}

// --- Search, Watchlist, PiP and Filters ------------------------------------

async function togglePiP(video) {
  if (!video) return;
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled) {
      await video.requestPictureInPicture();
    }
  } catch (e) {
    console.warn('PiP not available or refused:', e);
  }
}

function toggleWatchlist(camId) {
  if (state.watchlist.has(camId)) {
    state.watchlist.delete(camId);
  } else {
    state.watchlist.add(camId);
  }
  localStorage.setItem('bkk_cctv_watchlist', JSON.stringify([...state.watchlist]));
  updateWatchlistBadges();
  updateStarButtons(camId);
  if (state.trafficFilter === 'watchlist') {
    applyFilter();
  }
}

function updateWatchlistBadges() {
  const count = state.watchlist.size;
  const b = el('badge-watchlist-count');
  if (b) b.textContent = count;
  const pill = document.querySelector('.filter-pill.pill-watchlist span:last-child');
  if (pill) pill.textContent = count ? `Watchlist (${count})` : 'Watchlist';
}

function updateStarButtons(targetId = null) {
  const selector = targetId ? `[data-star="${cssId(targetId)}"], [data-star="${targetId}"]` : '[data-star]';
  document.querySelectorAll(selector).forEach(btn => {
    const id = btn.dataset.star;
    const starred = state.watchlist.has(id);
    btn.classList.toggle('is-starred', starred);
    btn.title = starred ? 'ลบออกจาก Watchlist' : 'ปักหมุดลง Watchlist';
    const svg = btn.querySelector('svg');
    if (svg) {
      svg.setAttribute('fill', starred ? 'currentColor' : 'none');
      svg.setAttribute('class', `w-3.5 h-3.5 ${starred ? 'text-amber-400' : 'text-white'}`);
    }
  });
}

function setWatchlistPresets() {
  const targets = ['อโศก', 'พระราม 4', 'ลาดพร้าว', 'สาทร', 'อนุสาวรีย์', 'ราชประสงค์', 'สุขุมวิท'];
  const picked = [];
  for (const t of targets) {
    const match = state.cameras.find(c => c.title.includes(t) && !picked.includes(c.id));
    if (match) picked.push(match.id);
    if (picked.length >= 4) break;
  }
  if (picked.length < 4) {
    state.cameras.slice(0, 4).forEach(c => {
      if (!picked.includes(c.id)) picked.push(c.id);
    });
  }
  picked.forEach(id => state.watchlist.add(id));
  localStorage.setItem('bkk_cctv_watchlist', JSON.stringify([...state.watchlist]));
  updateWatchlistBadges();
  render();
}

function setGridLayout(cols) {
  state.gridCols = cols;
  localStorage.setItem('bkk_cctv_grid_cols', cols);
  const grid = el('camera-grid');
  if (!grid) return;
  grid.className = cols === 2
    ? 'grid grid-cols-1 md:grid-cols-2 gap-4'
    : cols === 4
    ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4'
    : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4';

  [2, 3, 4].forEach(c => {
    const btn = el(`grid-cols-${c}`);
    if (btn) {
      const active = c === cols;
      btn.classList.toggle('is-active', active);
      btn.classList.toggle('bg-white', active);
      btn.classList.toggle('dark:bg-slate-800', active);
      btn.classList.toggle('text-blue-600', active);
      btn.classList.toggle('shadow-sm', active);
    }
  });
}

function setTrafficFilter(filter) {
  state.trafficFilter = filter;
  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.filter === filter);
  });

  const ind = el('active-filter-indicator');
  if (ind) {
    if (filter === 'all') {
      ind.classList.add('hidden');
      ind.textContent = '';
    } else {
      ind.classList.remove('hidden');
      const labels = {
        watchlist: '⭐ Watchlist',
        jam: '🚨 ติดขัดสะสม',
        slow: '🟡 ชะลอตัว',
        flowing: '🟢 คล่องตัว'
      };
      ind.textContent = `ตัวกรอง: ${labels[filter] || filter}`;
    }
  }

  if (state.view !== 'cams') {
    switchView('cams');
  }

  applyFilter();
}

function paintTrafficBadges() {
  state.cameras.forEach(cam => {
    const slot = el('tb-' + cssId(cam.id));
    if (!slot) return;

    // 1. Prioritize AI Video Area Speed if available
    const det = state.detections.get(cam.id);
    if (det && det.area_speed && det.area_speed.status) {
      const spd = det.area_speed;
      if (spd.status === 'jam') {
        slot.innerHTML = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-600 text-white shadow-sm shadow-rose-600/50 flex items-center gap-1" title="วิดีโอ AI ตรวจจับ: ติดขัดสะสม ${spd.stopped_pct}% จอดนิ่ง"><span class="w-1.5 h-1.5 rounded-full bg-white animate-ping"></span>ติดขัด AI</span>`;
        return;
      } else if (spd.status === 'slow') {
        slot.innerHTML = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-slate-900 shadow-sm shadow-amber-500/50" title="วิดีโอ AI ตรวจจับ: ชะลอตัว">ชะลอตัว AI</span>`;
        return;
      } else if (spd.status === 'flowing') {
        slot.innerHTML = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500 text-white shadow-sm shadow-emerald-500/50" title="วิดีโอ AI ตรวจจับ: คล่องตัว">คล่องตัว AI</span>`;
        return;
      }
    }

    // 2. Fallback to Longdo Map GPS Tiles
    const tr = state.cameraTraffic.get(cam.id);
    if (!tr) {
      slot.innerHTML = '';
      return;
    }
    if (tr.level === 'jam') {
      slot.innerHTML = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500 text-white shadow-sm shadow-rose-500/50" title="ประมาณจากแผนที่รอบด้าน 700ม.">ติดขัด (แผนที่)</span>';
    } else if (tr.level === 'slow') {
      slot.innerHTML = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-slate-900 shadow-sm shadow-amber-500/50" title="ประมาณจากแผนที่รอบด้าน 700ม.">ชะลอตัว (แผนที่)</span>';
    } else if (tr.level === 'flowing') {
      slot.innerHTML = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500 text-white shadow-sm shadow-emerald-500/50" title="ประมาณจากแผนที่รอบด้าน 700ม.">คล่องตัว (แผนที่)</span>';
    }
  });
}

function applyFilter() {
  const term = (el('search')?.value || '').trim().toLowerCase();
  const org = el('org-filter')?.value || '';
  const filter = state.trafficFilter;
  const clear = el('search-clear');
  if (clear) clear.classList.toggle('hidden', !term);

  let shown = 0;
  document.querySelectorAll('#camera-grid [data-cam-id]').forEach(card => {
    const camId = card.dataset.camId;
    const hitSearch = !term || card.dataset.search.includes(term);
    const hitOrg = !org || card.dataset.org === org;

    let hitFilter = true;
    if (filter === 'watchlist') {
      hitFilter = state.watchlist.has(camId);
    } else if (filter === 'jam') {
      hitFilter = state.cameraTraffic.get(camId)?.level === 'jam';
    } else if (filter === 'slow') {
      hitFilter = state.cameraTraffic.get(camId)?.level === 'slow';
    } else if (filter === 'flowing') {
      hitFilter = state.cameraTraffic.get(camId)?.level === 'flowing';
    }

    const hit = hitSearch && hitOrg && hitFilter;
    card.classList.toggle('hidden', !hit);
    if (hit) shown++;
  });

  updateCameraCount(shown);

  if (!shown) {
    if (filter === 'watchlist' && state.watchlist.size === 0) {
      setEmptyMessage(`
        <div class="max-w-md mx-auto p-6 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md rounded-2xl border border-slate-300 dark:border-slate-800 text-center space-y-3 shadow-xl">
          <div class="w-12 h-12 mx-auto rounded-full bg-amber-500/15 flex items-center justify-center text-amber-500">
            <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>
          </div>
          <h3 class="text-base font-bold text-slate-900 dark:text-slate-100">ยังไม่มีกล้องใน Watchlist</h3>
          <p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            เลือกปักหมุดกล้องบนการ์ด หรือคลิกปุ่มด้านล่างเพื่อเพิ่มทางแยกสำคัญ 4 จุดมาไว้บนแดชบอร์ด Multi-view
          </p>
          <button id="btn-add-preset-watchlist" class="px-4 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-md shadow-amber-500/25 hover:from-amber-600 hover:to-orange-600 transition-all cursor-pointer">
            + ปักหมุดกล้องยอดนิยม 4 จุดทันที
          </button>
        </div>
      `, true);
      const presetBtn = el('btn-add-preset-watchlist');
      if (presetBtn) presetBtn.addEventListener('click', setWatchlistPresets);
    } else {
      setEmptyMessage('ไม่พบกล้องที่ตรงกับเงื่อนไขการค้นหา/ตัวกรอง');
    }
  } else {
    setEmptyMessage('');
  }
}

function updateCameraCount(shown) {
  const count = el('camera-count');
  const badgeCams = el('badge-cams-count');
  const badgeTotal = el('badge-total-cams');
  const total = state.cameras.length;

  if (count) count.textContent = shown === total ? `${total} กล้องพร้อมดู` : `${shown} จาก ${total} กล้อง`;
  if (badgeCams) badgeCams.textContent = total;
  if (badgeTotal) badgeTotal.textContent = total;
}

function setEmptyMessage(content, isHtml = false) {
  const box = el('grid-empty');
  if (!box) return;
  if (!content) {
    box.classList.add('hidden');
    box.innerHTML = '';
  } else {
    box.classList.remove('hidden');
    if (isHtml) box.innerHTML = content;
    else box.textContent = content;
  }
}


// --- Recordings ------------------------------------------------------------
//
// recorder/record.py keeps ten minutes of video from every camera, one clip
// after another with no gap. A card plays them in the order they were
// recorded, so a viewer watching a card sees the junction as it actually ran,
// not a sample of it.

async function loadRecordings(forceFresh = false) {
  try {
    const url = forceFresh ? `/api/recordings?fresh=1&t=${Date.now()}` : `/api/recordings?t=${Date.now()}`;
    const res = await fetch(url);
    const data = await res.json();
    state.recordings = new Map((data.cameras || []).map(c => [c.id, c]));
    showRecorderNotice(!data.recording);
    state.cameras.forEach(paintRecording);
    clearAlert('recordings-api');
  } catch (err) {
    setAlert('recordings-api', { level: 'error', title: 'อ่านรายการคลิปไม่ได้', message: err.message });
  }
}

function formatClipTime(clip) {
  if (!clip) return '';
  const parts = clip.split('/');
  if (parts.length === 2) {
    const [datePart, timePart] = parts;
    const timeClean = timePart.replace(/\.mp4$/i, '');
    const [h, m, s] = timeClean.split('-').map(Number);
    if (!isNaN(h) && !isNaN(m)) {
      const d = new Date(Date.UTC(2026, 8, 11, h, m, s || 0));
      return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    }
  }
  const part = clip.includes('/') ? clip.split('/')[1] : clip;
  return part.replace(/\.mp4$/i, '').replace(/-/g, ':');
}

function paintRecording(cam) {
  const slot = el('rec-' + cssId(cam.id));
  if (!slot) return;
  const rec = state.recordings.get(cam.id);
  const clips = (rec && rec.clips) || [];
  const isWriting = rec && rec.isWriting;

  // Fallback: If no recorded clips exist at all on Drive D for this camera,
  // show the live image snapshot from the AI detector.
  if (!rec || !clips.length) {
    const liveSrc = `/api/detect-frame/${encodeURIComponent(cam.id)}?t=${Date.now()}`;
    const badgeText = isWriting ? 'กำลังบันทึกคลิปแรก...' : 'สด (Live AI)';

    let img = slot.querySelector('img.live-feed-img');
    let timeEl = slot.querySelector('.rec-time');
    if (img && timeEl) {
      timeEl.textContent = badgeText;
      return;
    }

    slot.innerHTML = `
      <img class="live-feed-img absolute inset-0 w-full h-full object-contain" src="${liveSrc}" alt="${escapeHtml(cam.title)}" />
      <div class="rec-badge absolute bottom-2.5 left-2.5 z-10 px-2 py-0.5 text-[10px] font-bold bg-slate-900/85 backdrop-blur-md text-emerald-300 rounded-md border border-white/10 flex items-center gap-1 shadow-sm pointer-events-none">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
        <span class="rec-time">${badgeText}</span>
      </div>`;

    img = slot.querySelector('img.live-feed-img');
    if (img) {
      img.onload = () => drawBoxes(cam.id, el('o-' + cssId(cam.id)), img);
      drawBoxes(cam.id, el('o-' + cssId(cam.id)), img);
    }
    return;
  }

  // Clips exist, so the card gets a video element. Whether it actually streams
  // is ensurePlayback's call - see MAX_PLAYING.
  const latestClip = clips[clips.length - 1];
  const playing = slot.querySelector('video');

  // If a video element already exists on this card
  if (playing) {
    playing.dataset.clips = clips.join(' ');
    playing.dataset.latest = latestClip;
    ensurePlayback();
    return;
  }

  slot.innerHTML = `
    <video class="absolute inset-0 w-full h-full object-contain" muted playsinline></video>
    <div class="rec-badge absolute bottom-2.5 left-2.5 z-10 px-2 py-0.5 text-[10px] font-bold bg-slate-900/85 backdrop-blur-md text-emerald-300 rounded-md border border-white/10 flex items-center gap-1 shadow-sm pointer-events-none">
      <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
      <span class="rec-time">${formatClipTime(latestClip) || 'คลิปล่าสุด'}</span>
    </div>`;

  const video = slot.querySelector('video');
  const timeEl = slot.querySelector('.rec-time');
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.dataset.clips = clips.join(' ');
  video.dataset.latest = latestClip;

  const playClip = (clip) => {
    if (video._waitNextTimer) {
      clearInterval(video._waitNextTimer);
      video._waitNextTimer = null;
    }
    video.dataset.clip = clip;
    const targetSrc = `/api/recording/${encodeURIComponent(cam.id)}/${clip}`;
    if (!video.src.includes(targetSrc)) {
      video.src = targetSrc;
    }
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    if (timeEl) timeEl.textContent = formatClipTime(clip) || 'คลิปล่าสุด';
    const p = video.play();
    if (p && p.catch) {
      p.catch(() => {
        video.muted = true;
        video.play().catch(() => {});
      });
    }
  };
  video._playClip = playClip;

  video.addEventListener('playing', () => {
    drawBoxes(cam.id, el('o-' + cssId(cam.id)), video);
  });
  video.addEventListener('loadedmetadata', () => {
    drawBoxes(cam.id, el('o-' + cssId(cam.id)), video);
  });

  video.addEventListener('ended', async () => {
    await loadRecordings(true);
    const freshRec = state.recordings.get(cam.id);
    const freshClips = (freshRec && freshRec.clips) || video.dataset.clips.split(' ').filter(Boolean);
    if (!freshClips.length) {
      video.currentTime = 0;
      video.play().catch(() => {});
      return;
    }

    const newestClip = freshClips[freshClips.length - 1];
    if (newestClip && newestClip !== video.dataset.clip) {
      playClip(newestClip);
    } else {
      // Loop smoothly
      video.currentTime = 0;
      video.play().catch(() => {});
    }
  });

  video.addEventListener('error', () => {
    setTimeout(async () => {
      // stopCard drops the source to free the connection, and that itself
      // raises an error event. A card that is no longer scheduled must stay off.
      if (!state.playing.includes(cam.id)) return;
      await loadRecordings(true);
      const errRec = state.recordings.get(cam.id);
      if (errRec && errRec.latest) playClip(errRec.latest);
    }, 4000);
  });

  ensurePlayback();
}

// --- How many clips may stream at once -------------------------------------
//
// The newest clip from every camera adds up to about 44 Mbps, and the page is
// usually watched through the Tailscale funnel, which relays. Playing all 29 at
// once starves every one of them, so only the cards on screen stream, a few at
// a time. This is the budget the comment on state.playing describes.
const MAX_PLAYING = 4;

function recVideo(camId) {
  const slot = el('rec-' + cssId(camId));
  return slot ? slot.querySelector('video') : null;
}

function stopCard(camId) {
  const video = recVideo(camId);
  if (!video) return;
  // Pausing alone leaves the browser filling its buffer, which is the whole
  // problem. Dropping the source is what closes the connection.
  try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}
  delete video.dataset.clip;
}

function ensurePlayback() {
  const visible = [...state.visibleCams].filter(id => recVideo(id));
  // A card that is already streaming keeps its slot, so scrolling a new card
  // into view does not restart clips that are playing fine.
  const keep = state.playing.filter(id => visible.includes(id));
  const wanted = [...keep, ...visible.filter(id => !keep.includes(id))].slice(0, MAX_PLAYING);

  for (const id of state.playing) {
    if (!wanted.includes(id)) stopCard(id);
  }
  state.playing = wanted;

  for (const id of wanted) {
    const video = recVideo(id);
    const rec = state.recordings.get(id);
    if (!video || !rec || !rec.latest) continue;
    if (!video.dataset.clip) {
      if (video._playClip) video._playClip(rec.latest);
    } else if (video.paused && !video.ended) {
      video.muted = true;
      video.play().catch(() => {});
    }
  }
}

// Cards are rebuilt whenever render() runs, so the observer is rebound with
// them. A filtered-out card carries Tailwind's hidden class, and the observer
// reports display:none as off screen on its own.
function observeCards() {
  if (!state.observer) {
    state.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target.dataset.camId;
        if (!id) continue;
        if (entry.isIntersecting) state.visibleCams.add(id);
        else state.visibleCams.delete(id);
      }
      ensurePlayback();
    }, { rootMargin: '100px' });
  }
  state.observer.disconnect();
  state.visibleCams.clear();
  document.querySelectorAll('#camera-grid [data-cam-id]').forEach(card => state.observer.observe(card));
}


// --- Error notifications ---------------------------------------------------
//
// Everything that goes wrong lands here, keyed by what it is so that a check
// that runs every few seconds does not stack the same alert twenty times.
// The bell in the toolbar counts what is wrong right now; a toast pops up the
// first time an alert appears, and again when it is resolved so the reader
// knows the recorder or a camera came back.

const alerts = new Map(); // id -> { level, title, message, hint, at, resolved }
const TOAST_MS = { error: 12000, warn: 8000, info: 4000 };
const LEVEL_RANK = { error: 2, warn: 1, info: 0 };

function setAlert(id, { level = 'error', title, message = '', hint = '' } = {}) {
  const cur = alerts.get(id);
  if (cur && !cur.resolved && cur.title === title && cur.message === message) return;
  alerts.set(id, { level, title, message, hint, at: Date.now(), resolved: false });
  renderAlerts(true);
  showToast({ level, title, message });
}

function clearAlert(id) {
  const cur = alerts.get(id);
  if (!cur || cur.resolved) return;
  cur.resolved = true;
  cur.at = Date.now();
  renderAlerts(false);
  showToast({ level: 'info', title: 'กลับมาปกติแล้ว', message: cur.title });
}

function renderAlerts(ring) {
  const list = el('alert-list');
  if (!list) return;

  const active = [...alerts.values()].filter(a => !a.resolved);
  const worst = active.reduce((w, a) => Math.max(w, LEVEL_RANK[a.level] || 0), -1);
  // One bell in the sidebar, one in the mobile header; both show the same thing
  document.querySelectorAll('.alert-bell').forEach(bell => {
    const count = bell.querySelector('.alert-count');
    if (count) {
      count.textContent = String(active.length);
      count.classList.toggle('hidden', !active.length);
      count.classList.toggle('is-warn', worst === 1);
    }
    bell.classList.toggle('has-error', worst === 2);
    bell.classList.toggle('has-warn', worst === 1);
    bell.title = active.length ? `การแจ้งเตือน ${active.length} รายการ` : 'การแจ้งเตือน';
    if (ring && active.length) {
      bell.classList.remove('is-ringing');
      void bell.offsetWidth; // restart the animation
      bell.classList.add('is-ringing');
    }
  });

  const items = [...alerts.entries()].sort((a, b) => {
    if (a[1].resolved !== b[1].resolved) return a[1].resolved ? 1 : -1;
    return b[1].at - a[1].at;
  });
  if (!items.length) {
    list.innerHTML = '<div class="alert-empty">ไม่มีปัญหา ทุกอย่างทำงานปกติ</div>';
    return;
  }
  list.innerHTML = items.map(([id, a]) => `
    <div class="alert-item level-${a.level}${a.resolved ? ' is-resolved' : ''}" data-alert-id="${escapeHtml(id)}">
      <span class="dot"></span>
      <div>
        <div class="title">${escapeHtml(a.title)}${a.resolved ? ' <span class="font-normal text-slate-400">— แก้แล้ว</span>' : ''}</div>
        ${a.message ? `<div class="msg">${escapeHtml(a.message)}</div>` : ''}
        ${a.hint && !a.resolved ? `<span class="hint">${escapeHtml(a.hint)}</span>` : ''}
      </div>
      <span class="time">${new Date(a.at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</span>
    </div>`).join('');
}

function showToast({ level, title, message }) {
  const stack = el('toast-stack');
  if (!stack) return;
  const t = document.createElement('div');
  t.className = `toast level-${level}`;
  t.innerHTML = `
    <span class="bar"></span>
    <div>
      <div class="title">${escapeHtml(title)}</div>
      ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ''}
    </div>
    <button class="close" aria-label="ปิด">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
    </button>`;
  const remove = () => {
    if (t.classList.contains('is-leaving')) return;
    t.classList.add('is-leaving');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  };
  t.querySelector('.close').addEventListener('click', remove);
  t.addEventListener('click', (e) => { if (!e.target.closest('.close')) toggleAlertPanel(true); });
  stack.appendChild(t);
  // Keep the stack short: the bell has the full list
  while (stack.children.length > 4) stack.firstElementChild.remove();
  setTimeout(remove, TOAST_MS[level] || 6000);
}

function toggleAlertPanel(open, bell) {
  const panel = el('alert-panel');
  if (!panel) return;
  const show = open === undefined ? panel.classList.contains('hidden') : open;
  panel.classList.toggle('hidden', !show);
  document.querySelectorAll('.alert-bell').forEach(b => b.setAttribute('aria-expanded', String(show)));
  if (!show) return;

  // Anchor to the bell that was clicked: the sidebar one sits at the bottom
  // left, the mobile one at the top right, so open towards the free side.
  // With no bell (a toast was clicked) it goes in the bottom-right corner.
  const r = bell ? bell.getBoundingClientRect() : null;
  const vw = window.innerWidth, vh = window.innerHeight;
  panel.style.left = panel.style.right = panel.style.top = panel.style.bottom = '';
  if (!r) {
    panel.style.right = '16px';
    panel.style.bottom = '16px';
    return;
  }
  if (r.left < vw / 2) panel.style.left = Math.max(8, r.left) + 'px';
  else panel.style.right = Math.max(8, vw - r.right) + 'px';
  if (r.top > vh / 2) panel.style.bottom = (vh - r.top + 8) + 'px';
  else panel.style.top = (r.bottom + 8) + 'px';
}

function initAlerts() {
  const panel = el('alert-panel');
  if (!panel) return;
  document.querySelectorAll('.alert-bell').forEach(bell => {
    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAlertPanel(panel.classList.contains('hidden'), bell);
    });
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => toggleAlertPanel(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleAlertPanel(false); });
  el('alert-clear')?.addEventListener('click', () => {
    for (const [id, a] of alerts) if (a.resolved) alerts.delete(id);
    renderAlerts(false);
  });
  renderAlerts(false);

  // Script errors and rejected promises that nothing caught
  window.addEventListener('error', (e) => {
    setAlert('js:' + (e.message || 'error'), { level: 'error', title: 'เกิดข้อผิดพลาดในหน้าเว็บ', message: e.message || String(e.error || '') });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason || '');
    setAlert('js:' + msg, { level: 'error', title: 'เกิดข้อผิดพลาดในหน้าเว็บ', message: msg });
  });
  window.addEventListener('offline', () => setAlert('offline', { level: 'error', title: 'ไม่มีการเชื่อมต่ออินเทอร์เน็ต', message: 'ภาพสดและข้อมูลจะไม่อัปเดตจนกว่าจะกลับมาออนไลน์' }));
  window.addEventListener('online', () => clearAlert('offline'));
}

function showRecorderNotice(off) {
  if (!off) { clearAlert('recorder'); return; }
  setAlert('recorder', {
    level: 'warn',
    title: 'ตัวบันทึกไม่ได้ทำงาน',
    message: 'การ์ดจึงยังไม่มีคลิปย้อนหลัง',
    hint: 'npm run record'
  });
}

// --- Vehicle detection -----------------------------------------------------
//
// Optional: detector/detect.py counts vehicles in a frame from each camera. The
// endpoint answers with enabled:false when it is not running, and the page
// simply shows no counts.

async function loadDetections() {
  try {
    const res = await fetch('/api/detections');
    const data = await res.json();
    const list = data.detections || [];

    // The detector runs beside the server, on a machine that can reach it.
    // A deployed copy has none, and used to just show nothing at all.
    showDetectorNotice(data.enabled === false);

    // Nothing refreshes a camera once it is closed, so a reading left over
    // from a view an hour ago would otherwise sit on the grid looking current.
    const now = Date.now() / 1000;
    const fresh = list.filter(d => now - d.at < STALE_AFTER);
    state.detections = new Map(fresh.map(d => [d.id, d]));

    const badge = el('vehicle-total');
    if (badge) {
      const seen = fresh.filter(d => d.total !== null);
      const total = seen.reduce((n, d) => n + d.total, 0);
      badge.classList.toggle('hidden', !seen.length);
      badge.textContent = seen.length
        ? `รถ ${total} คัน จาก ${seen.length} กล้อง` : '';
    }

    // Update live feed images on any cards operating in live image mode
    state.cameras.forEach(cam => {
      const slot = el('rec-' + cssId(cam.id));
      const liveImg = slot && slot.querySelector('img.live-feed-img');
      if (liveImg) {
        liveImg.src = `/api/detect-frame/${encodeURIComponent(cam.id)}?t=${Date.now()}`;
      }
    });

    if (state.detail) renderDetailCounts(state.detail, state.detections.get(state.detail.id));
    redrawAllBoxes();

    paintCardCounts();
    clearAlert('detections-api');
  } catch (err) {
    setAlert('detections-api', { level: 'error', title: 'อ่านผลตรวจจับไม่ได้', message: err.message });
  }
}

const LABELS = { car: 'รถยนต์', motorcycle: 'จยย.', bus: 'รถโดยสาร', truck: 'บรรทุก' };
// A count is only worth showing while it still describes the road. Detection
// runs on the open camera alone, so anything older than this is a leftover.
const STALE_AFTER = 300;

// Reads from the stored readings rather than from one response, so a fresh
// grid can be filled in too. The catalogue and the detections are fetched at
// the same moment: when the detections landed first, render() wiped these
// lines and a new visitor saw no counts until the next poll, twenty seconds on.
function paintCardCounts() {
  state.cameras.forEach(cam => {
    const box = el('c-' + cssId(cam.id));
    if (!box) return;

    const d = state.detections.get(cam.id);
    const rec = state.recordings.get(cam.id);

    // 1. Live detection reading with count
    if (d && d.total !== null) {
      const parts = Object.entries(d.counts || {})
        .filter(([_, n]) => n > 0)
        .map(([k, n]) => `${LABELS[k] || k} ${n}`)
        .join(' · ');
      box.innerHTML = `<span class="font-bold text-emerald-600 dark:text-emerald-400">🚗 ${d.total} คัน</span>${parts ? ` <span class="text-slate-500 text-[10px]">(${parts})</span>` : ''}`;
      return;
    }

    // 2. Count from 10-minute clip CSV in Drive D (only if recording is fresh)
    if (rec && rec.isFresh && rec.lastCount && rec.lastCount.total !== null) {
      const lc = rec.lastCount;
      const parts = Object.entries(lc.counts || {})
        .filter(([_, n]) => n > 0)
        .map(([k, n]) => `${LABELS[k] || k} ${n}`)
        .join(' · ');
      box.innerHTML = `<span class="font-semibold text-emerald-600 dark:text-emerald-400">🚗 ${lc.total} คัน</span>${parts ? ` <span class="text-slate-400 text-[10px]">(${parts})</span>` : ''} <span class="text-[10px] text-slate-400 dark:text-slate-500">· 10 นาทีย้อนหลัง</span>`;
      return;
    }

    box.textContent = '';
  });
}

function showDetectorNotice(off) {
  if (!off) { clearAlert('detector'); return; }
  setAlert('detector', {
    level: 'warn',
    title: 'ไม่มีการตรวจจับรถ',
    message: 'ตัวตรวจจับทำงานบนเครื่องที่รันเซิร์ฟเวอร์เท่านั้น เปิดที่ localhost:3000 เพื่อดูกรอบตรวจจับ'
  });
}


// --- Box overlay -----------------------------------------------------------
//
// The detector reports boxes in fractions of the frame, so they can be laid
// over a video of any size. The video is object-contain, so the picture is
// letterboxed inside its element and the boxes have to follow the picture,
// not the element.

const BOX_COLOURS = { car: '#54C00C', motorcycle: '#FEDE04', bus: '#FF9020', truck: '#FF3030' };

function pictureRect(media) {
  if (!media) return { x: 0, y: 0, w: 0, h: 0 };
  const ew = media.clientWidth || media.offsetWidth || 0;
  const eh = media.clientHeight || media.offsetHeight || 0;
  const vw = media.videoWidth || media.naturalWidth || 0;
  const vh = media.videoHeight || media.naturalHeight || 0;
  if (!vw || !vh || !ew || !eh) {
    const parent = media.parentElement;
    const pw = parent ? (parent.clientWidth || parent.offsetWidth || 0) : 0;
    const ph = parent ? (parent.clientHeight || parent.offsetHeight || 0) : 0;
    const fallbackVw = 16, fallbackVh = 9;
    const cw = pw || ew, ch = ph || eh;
    if (!cw || !ch) return { x: 0, y: 0, w: 0, h: 0 };
    const scale = Math.min(cw / fallbackVw, ch / fallbackVh);
    const w = fallbackVw * scale, h = fallbackVh * scale;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  const scale = Math.min(ew / vw, eh / vh);
  const w = vw * scale, h = vh * scale;
  return { x: (ew - w) / 2, y: (eh - h) / 2, w, h };
}

function drawBoxes(camId, overlay, video) {
  if (!overlay) return;
  const reading = state.detections.get(camId);
  const boxes = (reading && reading.boxes) || [];

  const isDetail = overlay.id === 'detail-overlay';
  const badgeBottom = isDetail ? '48px' : '8px';

  // In the camera menu (grid): do NOT show bounding boxes by default (clean video)
  // In the detail modal (when clicking to view): show bounding boxes!
  if (isDetail) {
    if (!state.showDetailOverlay) { overlay.innerHTML = ''; return; }
  } else {
    if (!state.showGridOverlay) { overlay.innerHTML = ''; return; }
  }

  if (!reading) {
    overlay.innerHTML = `<div style="position:absolute;bottom:8px;left:8px;padding:2px 8px;border-radius:8px;background:rgba(0,0,0,.7);color:#94a3b8;font-size:10px">
        ${state.focusId === camId ? 'กำลังเริ่มตรวจจับ...' : 'รอรอบตรวจจับ AI...'}
      </div>`;
    return;
  }

  if (!boxes.length) {
    const age = Math.round(Date.now() / 1000 - reading.at);
    overlay.innerHTML = `
      <div style="position:absolute;bottom:${badgeBottom};left:8px;padding:3px 10px;border-radius:8px;background:rgba(15,23,42,.88);backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,.15);color:#fff;font-size:11px;display:flex;align-items:center;gap:6px;box-shadow:0 4px 6px -1px rgba(0,0,0,.5);pointer-events:none">
        <span style="color:#38bdf8;font-weight:bold">🚗 0 คัน</span>
        <span style="color:#64748b;font-size:10px">(${age < 3 ? 'สด' : age + ' วิที่แล้ว'})</span>
      </div>`;
    return;
  }

  const r = pictureRect(video);
  const age = Math.round(Date.now() / 1000 - reading.at);
  const spd = reading.area_speed;
  const spdStatus = spd ? (spd.status_th || spd.status) : '';
  const spdColor = spd && spd.status === 'jam' ? '#f43f5e' : (spd && spd.status === 'slow' ? '#fbbf24' : '#34d399');

  overlay.innerHTML = `
    <svg style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none" preserveAspectRatio="none">
      ${boxes.map(b => {
        const x = r.x + b.x * r.w, y = r.y + b.y * r.h;
        const w = b.w * r.w, h = b.h * r.h;
        const c = BOX_COLOURS[b.k] || '#54C00C';
        const typeName = LABELS[b.k] || b.k;
        const stoppedText = b.stp ? ' (จอดนิ่ง)' : '';
        const idPrefix = (b.id !== undefined && b.id !== null) ? `#${b.id} ` : '';
        const labelText = `${idPrefix}${typeName}${stoppedText}`.trim();
        const tagWidth = Math.max(45, labelText.length * 7 + 12);

        const tag = (!idPrefix && !typeName) ? '' :
          `<g>
             <rect x="${x.toFixed(1)}" y="${Math.max(0, y - 16).toFixed(1)}" width="${tagWidth.toFixed(0)}" height="15" fill="rgba(15,23,42,0.88)" rx="3" />
             <text x="${(x + 4).toFixed(1)}" y="${Math.max(11, y - 4).toFixed(1)}" fill="${c}"
                   font-size="10" font-family="system-ui, sans-serif" font-weight="bold">${labelText}</text>
           </g>`;

        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"
                 fill="none" stroke="${c}" stroke-width="2" rx="2" />${tag}`;
      }).join('')}
    </svg>
    <div style="position:absolute;bottom:${badgeBottom};left:8px;padding:3px 10px;border-radius:8px;background:rgba(15,23,42,.88);backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,.15);color:#fff;font-size:11px;display:flex;align-items:center;gap:6px;box-shadow:0 4px 6px -1px rgba(0,0,0,.5);pointer-events:none">
      <span style="color:#38bdf8;font-weight:bold">🚗 ${boxes.length} คัน</span>
      ${spd && spdStatus ? `<span style="color:#64748b">|</span><span style="color:${spdColor};font-weight:bold">${spdStatus}</span>` : ''}
      <span style="color:#64748b;font-size:10px">(${age < 3 ? 'สด' : age + ' วิที่แล้ว'})</span>
    </div>`;
}

function redrawAllBoxes() {
  if (state.detail) {
    const detailMedia = (state.detailMode === 'det') ? el('detail-img') : el('detail-video');
    drawBoxes(state.detail.id, el('detail-overlay'), detailMedia);
  }
  state.cameras.forEach(cam => {
    const cardOverlay = el('o-' + cssId(cam.id));
    const cardSlot = el('rec-' + cssId(cam.id));
    const cardMedia = cardSlot && (cardSlot.querySelector('video') || cardSlot.querySelector('img'));
    if (cardOverlay && cardMedia) {
      drawBoxes(cam.id, cardOverlay, cardMedia);
    }
  });
}

// --- Realtime focus --------------------------------------------------------
//
// A sweep of all nineteen cameras takes minutes, so its boxes are always stale.
// The detector will work on one camera continuously instead - about 2 fps - if
// the page keeps telling it which one is being watched.

function setFocus(id) {
  if (state.focusId === id) return;
  state.focusId = id;
  state.focusFps = 0;

  if (state.focusTimer) { clearInterval(state.focusTimer); state.focusTimer = null; }
  if (!id) {
    fetch('/api/detect-focus?id=').catch(() => {});
    updateFocusBadge();
    return;
  }

  const beat = () => fetch(`/api/detect-focus?id=${encodeURIComponent(id)}`).catch(() => {});
  beat();

  // Two jobs on one timer: keep the focus alive, and pull its newest boxes
  state.focusTimer = setInterval(async () => {
    if (state.focusId !== id) return;
    beat();
    try {
      const res = await fetch(`/api/detections?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      const reading = (data.detections || [])[0];
      if (reading) {
        state.detections.set(id, reading);
        state.focusFps = data.fps || 0;
        redrawAllBoxes();
        if (state.detail && state.detail.id === id) renderDetailCounts(state.detail, reading);
        paintCardCounts();
      }
      updateFocusBadge();
    } catch (err) { /* detector off */ }
  }, 1000);

  updateFocusBadge();
}

function updateFocusBadge() {
  const b = el('focus-badge');
  if (!b) return;
  const on = state.focusId && state.focusFps > 0;
  b.classList.toggle('hidden', !on);
  if (on) b.textContent = `ตรวจจับสด ${state.focusFps.toFixed(1)} fps`;
}

// Focus on the open camera if viewing detail, otherwise sweeps cover all cameras.
function refreshFocusTarget() {
  if (state.detail) {
    setFocus(state.detail.id);
  } else {
    setFocus(null);
  }
}

// --- Camera detail ---------------------------------------------------------
//
// Opens on the detector's annotated frame, since that is what the counts are
// read off, with the live stream a tab away. Only one stream runs here, and
// the grid's players are stopped while it is open.

function openDetail(cam) {
  state.detail = cam;
  if (!state.detailMode || state.detailMode === 'det') {
    state.detailMode = 'live';
  }

  el('detail-title').textContent = cam.title;
  el('detail-org').textContent = cam.org;
  el('detail').classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  setDetailMode(state.detailMode);
  refreshFocusTarget();
  if (state.detailTimer) clearInterval(state.detailTimer);
  state.detailTimer = setInterval(() => {
    if (state.detail && state.detailMode === 'det') renderDetail(true);
  }, 15000);
}

function closeDetail() {
  if (state.detailTimer) { clearInterval(state.detailTimer); state.detailTimer = null; }
  const video = el('detail-video');
  const hls = state.players.get('detail');
  if (hls) { try { hls.destroy(); } catch (e) {} state.players.delete('detail'); }
  if (video) { video.onended = null; try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {} }

  state.detail = null;
  el('detail').classList.add('hidden');
  document.body.style.overflow = '';
  refreshFocusTarget();
}

function setDetailMode(mode) {
  if (!state.detail) return;
  state.detailMode = mode;
  const idle = 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700';
  el('detail-tab-det').className = 'px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer ' +
    (mode === 'det' ? 'bg-blue-600 text-white' : idle);
  el('detail-tab-live').className = 'px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer ' +
    (mode === 'live' ? 'bg-blue-600 text-white' : idle);
  if (el('detail-tab-rec')) {
    el('detail-tab-rec').className = 'px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer ' +
      (mode === 'rec' ? 'bg-blue-600 text-white' : idle);
  }
  renderDetail();
}

function renderDetail(imageOnly = false) {
  const cam = state.detail;
  if (!cam) return;

  const img = el('detail-img');
  const video = el('detail-video');
  const msg = el('detail-msg');
  const ov = el('detail-overlay');
  const reading = state.detections.get(cam.id);

  if (state.detailMode === 'det') {
    img.classList.remove('hidden');
    video.classList.add('hidden');
    video.onended = null;

    const hls = state.players.get('detail');
    if (hls) { try { hls.destroy(); } catch (e) {} state.players.delete('detail'); }
    if (!imageOnly) { try { video.pause(); video.removeAttribute('src'); } catch (e) {} }

    img.onload = () => drawBoxes(cam.id, ov, img);

    if (reading && reading.total !== null) {
      img.src = `/api/detect-frame/${encodeURIComponent(cam.id)}?t=${Date.now()}`;
      msg.textContent = '';
    } else {
      img.removeAttribute('src');
      msg.textContent = reading && reading.error
        ? 'ตรวจจับไม่สำเร็จ: ' + reading.error
        : 'กำลังเชื่อมต่อตัวตรวจจับ AI...';
    }
    drawBoxes(cam.id, ov, img);
  } else if (state.detailMode === 'rec') {
    img.classList.add('hidden');
    video.classList.remove('hidden');

    const hls = state.players.get('detail');
    if (hls) { try { hls.destroy(); } catch (e) {} state.players.delete('detail'); }

    const rec = state.recordings.get(cam.id);
    const clips = (rec && rec.clips) || [];
    if (!clips.length) {
      msg.textContent = 'ยังไม่มีคลิป 10 นาทีที่บันทึกไว้ใน Drive D';
      video.removeAttribute('src');
      if (ov) ov.innerHTML = '';
    } else {
      msg.textContent = '';
      const latestClip = clips[clips.length - 1];
      const targetSrc = `/api/recording/${encodeURIComponent(cam.id)}/${latestClip}`;
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      if (!video.src.includes(targetSrc)) {
        video.src = targetSrc;
        video.play().catch(() => {});
      } else if (video.paused) {
        video.play().catch(() => {});
      }
      video.onloadeddata = () => drawBoxes(cam.id, ov, video);
      video.onplaying = () => drawBoxes(cam.id, ov, video);
      video.onended = async () => {
        await loadRecordings(true);
        const freshRec = state.recordings.get(cam.id);
        const freshClips = (freshRec && freshRec.clips) || [];
        if (freshClips.length) {
          const freshLatest = freshClips[freshClips.length - 1];
          const newSrc = `/api/recording/${encodeURIComponent(cam.id)}/${freshLatest}`;
          if (video.src.includes(newSrc)) {
            video.currentTime = 0;
            video.play().catch(() => {});
          } else {
            video.src = newSrc;
            video.play().catch(() => {});
          }
        } else {
          video.currentTime = 0;
          video.play().catch(() => {});
        }
      };
      drawBoxes(cam.id, ov, video);
    }
  } else {
    // live mode
    img.classList.add('hidden');
    video.classList.remove('hidden');
    video.onended = null;
    msg.textContent = '';
    attachDetailPlayer(cam, video, msg);
    video.addEventListener('loadedmetadata', () => drawBoxes(cam.id, ov, video), { once: true });
    video.addEventListener('playing', () => drawBoxes(cam.id, ov, video));
    setTimeout(() => drawBoxes(cam.id, ov, video), 400);
  }

  if (imageOnly) return;
  renderDetailCounts(cam, reading);
}

function renderDetailCounts(cam, reading) {
  const box = el('detail-counts');
  const age = el('detail-age');
  const note = el('detail-note');

  if (!reading || reading.total === null) {
    const rec = state.recordings.get(cam.id);
    if (rec && rec.lastCount && rec.lastCount.total !== null) {
      const lc = rec.lastCount;
      box.innerHTML =
        chip('รวม (10 นาทีล่าสุด)', lc.total + ' คัน', 'bg-sky-500/15 border border-sky-500/30 text-sky-300') +
        Object.entries(lc.counts || {})
          .filter(([_, n]) => n > 0)
          .map(([k, n]) => chip(LABELS[k] || k, n, 'bg-slate-800 border border-slate-700 text-slate-300'))
          .join('');
      age.textContent = `จากคลิป 10 นาทีล่าสุด (${rec.latest || ''})`;
      note.textContent = 'สถิติจำนวนรถเฉลี่ยที่บันทึกไว้ในคลิป 10 นาทีล่าสุดจากไดรฟ์ D';
      return;
    }
    box.innerHTML = '';
    age.textContent = '';
    note.textContent = reading && reading.error
      ? ''
      : 'ตัวตรวจจับทำงานบนเครื่องที่รันเซิร์ฟเวอร์ ถ้าไม่ได้เปิดไว้จะไม่มีตัวเลข';
    return;
  }

  let speedChips = '';
  if (reading.area_speed) {
    const spd = reading.area_speed;
    const tone = spd.status === 'jam'
      ? 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
      : spd.status === 'slow'
        ? 'bg-amber-500/15 border border-amber-500/30 text-amber-300'
        : 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300';
    speedChips =
      chip('สถานะจราจร AI', spd.status_th || spd.status, tone) +
      (spd.stopped_pct > 0 ? chip('จอดนิ่งสะสม', spd.stopped_pct + '%', 'bg-slate-800 border border-slate-700 text-slate-300') : '');
  }

  box.innerHTML =
    chip('รวม', reading.total + ' คัน', 'bg-sky-500/15 border border-sky-500/30 text-sky-300') +
    speedChips +
    Object.entries(reading.counts)
      .map(([k, n]) => chip(LABELS[k] || k, n, 'bg-slate-800 border border-slate-700 text-slate-300'))
      .join('');

  const seconds = Math.round(Date.now() / 1000 - reading.at);
  age.textContent = `ตรวจเมื่อ ${seconds < 60 ? seconds + ' วินาทีที่แล้ว' : Math.round(seconds / 60) + ' นาทีที่แล้ว'}`;
  note.textContent = 'นับจากภาพนิ่งหนึ่งเฟรม ไม่ใช่การนับรถที่ผ่านไป — ความแม่นยำขึ้นกับมุมกล้อง กล้องมุมสูงมากจะตรวจได้น้อยกว่าความจริง';
}

function attachDetailPlayer(cam, video, msg) {
  const say = (t) => { if (msg) msg.textContent = t; };

  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = cam.hls;
    video.play().catch(() => say('แตะเพื่อเล่น'));
    return;
  }
  if (!window.Hls || !window.Hls.isSupported()) { say('เบราว์เซอร์นี้เล่นวิดีโอสดไม่ได้'); return; }

  const old = state.players.get('detail');
  if (old) { try { old.destroy(); } catch (e) {} }

  const hls = new window.Hls({
    liveDurationInfinity: true, liveSyncDurationCount: 1,
    maxBufferLength: 8, backBufferLength: 0
  });
  hls.loadSource(cam.hls);
  hls.attachMedia(video);
  hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
    video.muted = true;
    video.play().catch(() => say('แตะเพื่อเล่น'));
  });
  hls.on(window.Hls.Events.ERROR, (_e, d) => {
    if (!d.fatal) return;
    if (d.type === window.Hls.ErrorTypes.NETWORK_ERROR) { say('กำลังเชื่อมต่อใหม่...'); hls.startLoad(); }
    else if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    else { say('กล้องนี้ไม่พร้อมใช้งาน'); hls.destroy(); }
  });
  video.addEventListener('playing', () => say(''), { once: true });
  state.players.set('detail', hls);
}

// --- Traffic map -----------------------------------------------------------

function buildMap() {
  if (state.map || typeof maplibregl === 'undefined') return;

  state.map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        // Our own tiles, so the base map needs nobody's API key
        base: {
          type: 'raster',
          tiles: [location.origin + '/api/map/tiles/{z}/{x}/{y}.png'],
          tileSize: 256,
          minzoom: 10,
          maxzoom: 15
        },
        traffic: {
          type: 'vector',
          tiles: [TRAFFIC_TILES],
          minzoom: 5,
          maxzoom: 12,
          attribution: '<a href="https://traffic.longdo.com/" target="_blank">Longdo Traffic</a>'
        }
      },
      layers: [
        { id: 'base', type: 'raster', source: 'base', paint: { 'raster-brightness-max': 0.75 } },
        // Two directions per road, drawn as a pair of offset lines
        {
          id: 'traffic-forward',
          type: 'line',
          source: 'traffic',
          'source-layer': 'traffic',
          filter: ['!=', ['get', 'fillcolor'], ''],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['concat', '#', ['get', 'fillcolor']],
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 4, 17, 8],
            'line-offset': ['interpolate', ['linear'], ['zoom'], 10, 1, 17, 4],
            'line-opacity': 0.9
          }
        },
        {
          id: 'traffic-reverse',
          type: 'line',
          source: 'traffic',
          'source-layer': 'traffic',
          filter: ['!=', ['get', 'fillcolor_r'], ''],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['concat', '#', ['get', 'fillcolor_r']],
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 4, 17, 8],
            'line-offset': ['interpolate', ['linear'], ['zoom'], 10, -1, 17, -4],
            'line-opacity': 0.9
          }
        }
      ]
    },
    center: [100.5231, 13.7367],
    zoom: 11,
    attributionControl: true
  });

  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  state.map.on('load', addCameraMarkers);
}

function addCameraMarkers() {
  if (!state.map) return;
  state.markers.forEach(m => m.remove());
  state.markers = [];

  state.cameras.forEach(cam => {
    const tr = state.cameraTraffic.get(cam.id);
    const level = tr ? tr.level : null;

    const pin = document.createElement('div');
    pin.className = 'cctv-custom-pin ' +
      (level === 'jam' ? 'cctv-pin-congested' :
       level === 'slow' ? 'cctv-pin-moderate' :
       level === 'flowing' ? 'cctv-pin-flowing' :
       'bg-rose-600 border-2 border-white shadow-lg');
    
    pin.title = `${cam.title} ${tr ? '(' + tr.label + ')' : ''}`;
    pin.innerHTML = `
      <svg class="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>`;

    const statusBadge = level === 'jam'
      ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500 text-white shadow-sm shadow-rose-500/50">ติดขัด</span>'
      : level === 'slow'
      ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-slate-900 shadow-sm shadow-amber-500/50">ชะลอตัว</span>'
      : level === 'flowing'
      ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500 text-white shadow-sm shadow-emerald-500/50">คล่องตัว</span>'
      : '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-700 text-slate-300">LIVE</span>';

    const isStarred = state.watchlist.has(cam.id);

    const popup = new maplibregl.Popup({ offset: 16, maxWidth: '360px' })
      .setHTML(`
        <div class="space-y-2 text-slate-900 dark:text-white">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="font-bold text-xs leading-snug line-clamp-2">${escapeHtml(cam.title)}</p>
              <p class="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">${escapeHtml(cam.org)}</p>
            </div>
            ${statusBadge}
          </div>
          <div class="relative bg-black rounded-xl overflow-hidden aspect-video flex items-center justify-center ring-1 ring-white/10">
            <video id="pv-${cssId(cam.id)}" class="w-full h-full object-contain" muted playsinline autoplay controls></video>
          </div>
          <div class="flex items-center justify-between pt-1 gap-1.5 text-xs">
            <button id="pop-star-${cssId(cam.id)}" class="px-2.5 py-1 rounded-lg bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer">
              <span class="${isStarred ? 'text-amber-500' : 'text-slate-400'}">★</span>
              <span>${isStarred ? 'ใน Watchlist' : 'ปักหมุด'}</span>
            </button>
            <div class="flex items-center gap-1 ml-auto">
              <button id="pop-pip-${cssId(cam.id)}" class="p-1.5 rounded-lg bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 cursor-pointer" title="Picture-in-Picture">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 11h-6a1 1 0 00-1 1v4a1 1 0 001 1h6a1 1 0 001-1v-4a1 1 0 00-1-1z"/><path stroke-linecap="round" stroke-linejoin="round" d="M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
              </button>
              <button id="pop-det-${cssId(cam.id)}" class="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-semibold transition-colors cursor-pointer">
                ดูเต็มจอ / AI
              </button>
            </div>
          </div>
        </div>`);

    popup.on('open', () => {
      attachPlayer(cam, 'pv-');
      const starBtn = el(`pop-star-${cssId(cam.id)}`);
      if (starBtn) {
        starBtn.addEventListener('click', () => {
          toggleWatchlist(cam.id);
          const nowStarred = state.watchlist.has(cam.id);
          starBtn.querySelector('span:first-child').className = nowStarred ? 'text-amber-500' : 'text-slate-400';
          starBtn.querySelector('span:last-child').textContent = nowStarred ? 'ใน Watchlist' : 'ปักหมุด';
        });
      }
      const pipBtn = el(`pop-pip-${cssId(cam.id)}`);
      if (pipBtn) {
        pipBtn.addEventListener('click', () => {
          const v = el(`pv-${cssId(cam.id)}`);
          if (v) togglePiP(v);
        });
      }
      const detBtn = el(`pop-det-${cssId(cam.id)}`);
      if (detBtn) {
        detBtn.addEventListener('click', () => {
          popup.remove();
          openDetail(cam);
        });
      }
    });

    popup.on('close', () => {
      const hls = state.players.get('popup:' + cam.id);
      if (hls) { try { hls.destroy(); } catch (e) {} state.players.delete('popup:' + cam.id); }
    });

    const marker = new maplibregl.Marker({ element: pin })
      .setLngLat([cam.lng, cam.lat])
      .setPopup(popup)
      .addTo(state.map);

    state.markers.push(marker);
  });
}

async function loadTrafficIndex() {
  const box = el('traffic-index');
  const sideBox = el('sidebar-traffic-index');
  const stamp = el('traffic-updated');
  try {
    const r = await fetch('/api/traffic-index');
    const d = await r.json();
    const i = Number(d.index);
    const label = i < 4 ? 'คล่องตัว' : i < 7 ? 'ชะลอตัว' : 'ติดขัด';
    state.trafficIndex = { index: i, label, updatedAt: Date.now() };
    const text = `ดัชนีจราจร ${i.toFixed(1)} · ${label}`;
    if (box) box.textContent = text;
    if (sideBox) sideBox.textContent = text;
    if (stamp) stamp.textContent = 'อัปเดต ' + new Date().toLocaleTimeString('th-TH');
    renderDashboard();
    clearAlert('traffic-index');
  } catch (err) {
    if (box) box.textContent = 'ดัชนีจราจร: ไม่พร้อมใช้งาน';
    if (sideBox) sideBox.textContent = 'ดัชนี: ออฟไลน์';
    setAlert('traffic-index', { level: 'warn', title: 'ดัชนีจราจรไม่พร้อมใช้งาน', message: err.message });
  }
}

// --- Traffic Congestion Data (for badges & map markers) --------------------

function parseTrafficCongestion(data) {
  state.cameraTraffic.clear();
  let jamCount = 0;
  let slowCount = 0;
  let flowingCount = 0;

  (data.roads || []).forEach(road => {
    if (road.congestion && Array.isArray(road.cameras)) {
      road.cameras.forEach(c => {
        state.cameraTraffic.set(c.id, {
          roadName: road.name,
          level: road.congestion.level,
          score: road.congestion.score,
          label: road.congestion.label
        });
        if (road.congestion.level === 'jam') jamCount++;
        else if (road.congestion.level === 'slow') slowCount++;
        else if (road.congestion.level === 'flowing') flowingCount++;
      });
    }
  });

  const bJam = el('badge-jam-count');
  if (bJam) bJam.textContent = jamCount;
  const bSlow = el('badge-slow-count');
  if (bSlow) bSlow.textContent = slowCount;
  const bFlow = el('badge-flowing-count');
  if (bFlow) bFlow.textContent = flowingCount;

  paintTrafficBadges();
  if (state.view === 'map' && state.map && state.map.isStyleLoaded()) {
    addCameraMarkers();
  }
}

async function loadTrafficData() {
  try {
    const res = await fetch('/api/traffic-advice');
    const data = await res.json();
    parseTrafficCongestion(data);
    renderDashboard();
    clearAlert('traffic-data');
  } catch (err) {
    setAlert('traffic-data', { level: 'warn', title: 'โหลดข้อมูลสภาพจราจรไม่ได้', message: err.message });
  }
}

// --- Dashboard View Renderer -----------------------------------------------

function renderDashboard() {
  // 1. Digital Clock
  const dashClock = el('dash-clock');
  if (dashClock) dashClock.textContent = new Date().toLocaleTimeString('th-TH') + ' น.';

  // 2. Traffic Index
  const trafficText = el('sidebar-traffic-index')?.textContent || '';
  const matchIdx = trafficText.match(/(\d+\.\d+)/);
  const idxVal = matchIdx ? parseFloat(matchIdx[1]) : (state.trafficIndex?.index || 2.8);
  const idxNum = el('dash-kpi-index-num');
  const idxBadge = el('dash-kpi-index-badge');
  const idxDesc = el('dash-kpi-index-desc');

  if (idxNum) idxNum.textContent = idxVal.toFixed(1);
  if (idxBadge) {
    if (idxVal < 4.0) {
      idxBadge.textContent = 'คล่องตัว';
      idxBadge.className = 'status-pill status-flowing';
      if (idxDesc) idxDesc.textContent = 'การจราจรไหลลื่นดี ทั่วกรุงเทพฯ';
    } else if (idxVal < 7.0) {
      idxBadge.textContent = 'ชะลอตัว';
      idxBadge.className = 'status-pill status-slow';
      if (idxDesc) idxDesc.textContent = 'เริ่มมีแถวคอยตามจุดเชื่อมต่อสำคัญ';
    } else {
      idxBadge.textContent = 'ติดขัดสะสม';
      idxBadge.className = 'status-pill status-jam';
      if (idxDesc) idxDesc.textContent = 'ปริมาณรถหนาแน่นในหลายสายทาง';
    }
  }

  // 3. Online CCTV Count
  const camsOnline = el('dash-kpi-cams-online');
  if (camsOnline) {
    const total = state.cameras.length || 30;
    camsOnline.textContent = total;
  }

  // 4. Analytics Summary & Vehicle Classification
  const summary = roadAnalyticsState.data?.summary;
  const roads = roadAnalyticsState.data?.roads || [];

  if (summary) {
    const vehTotal = el('dash-kpi-vehicles-total');
    if (vehTotal) vehTotal.textContent = (summary.totalVehicles || 0).toLocaleString('th-TH');

    const flowRate = el('dash-kpi-flow-rate');
    if (flowRate) {
      const avgRate = Math.round(((summary.totalVehicles || 0) / Math.max(1, summary.totalClips || 1)) * 6);
      flowRate.textContent = `เฉลี่ย ~${avgRate.toLocaleString('th-TH')} คัน/ชม.`;
    }

    const kpiJam = el('dash-kpi-jam');
    if (kpiJam) kpiJam.textContent = `ติดขัด ${summary.jamCount || 0}`;

    const kpiSlow = el('dash-kpi-slow');
    if (kpiSlow) kpiSlow.textContent = `ชะลอ ${summary.slowCount || 0}`;

    const kpiFlowing = el('dash-kpi-flowing');
    if (kpiFlowing) kpiFlowing.textContent = `คล่อง ${summary.flowingCount || 0}`;

    const topJam = el('dash-kpi-top-jam');
    if (topJam) topJam.textContent = `หนาแน่นสุด: ${summary.topCongestedRoad || '-'}`;

    // Vehicle Classification breakdown
    if (summary.counts) {
      const sum = (summary.counts.car || 0) + (summary.counts.motorcycle || 0) + (summary.counts.bus || 0) + (summary.counts.truck || 0) || 1;
      const carPct = Math.round(((summary.counts.car || 0) / sum) * 100);
      const mcPct = Math.round(((summary.counts.motorcycle || 0) / sum) * 100);
      const busPct = Math.round(((summary.counts.bus || 0) / sum) * 100);
      const truckPct = Math.round(((summary.counts.truck || 0) / sum) * 100);

      const barCar = el('dash-bar-car');
      const barMc = el('dash-bar-mc');
      const barBus = el('dash-bar-bus');
      const barTruck = el('dash-bar-truck');
      if (barCar) barCar.style.width = `${carPct}%`;
      if (barMc) barMc.style.width = `${mcPct}%`;
      if (barBus) barBus.style.width = `${busPct}%`;
      if (barTruck) barTruck.style.width = `${truckPct}%`;

      const cntCar = el('dash-count-car');
      const pctCar = el('dash-pct-car');
      if (cntCar) cntCar.textContent = (summary.counts.car || 0).toLocaleString('th-TH');
      if (pctCar) pctCar.textContent = `${carPct}%`;

      const cntMc = el('dash-count-mc');
      const pctMc = el('dash-pct-mc');
      if (cntMc) cntMc.textContent = (summary.counts.motorcycle || 0).toLocaleString('th-TH');
      if (pctMc) pctMc.textContent = `${mcPct}%`;

      const cntBus = el('dash-count-bus');
      const pctBus = el('dash-pct-bus');
      if (cntBus) cntBus.textContent = (summary.counts.bus || 0).toLocaleString('th-TH');
      if (pctBus) pctBus.textContent = `${busPct}%`;

      const cntTruck = el('dash-count-truck');
      const pctTruck = el('dash-pct-truck');
      if (cntTruck) cntTruck.textContent = (summary.counts.truck || 0).toLocaleString('th-TH');
      if (pctTruck) pctTruck.textContent = `${truckPct}%`;
    }
  }

  // 5. Featured CCTV Wall (4 Strategic Monitors)
  const featuredContainer = el('dash-featured-cams');
  if (featuredContainer && state.cameras.length > 0) {
    const featuredCams = [];
    if (state.watchlist.size > 0) {
      for (const id of state.watchlist) {
        const c = state.cameras.find(cam => cam.id === id);
        if (c && featuredCams.length < 4) featuredCams.push(c);
      }
    }
    const priorityIds = ['ITICM_BMAMI0076', 'ITICM_BMAMI0164', 'DOH-PER-3-008', 'ITICM_BMAMI0071', 'ITICM_BMAMI0074', 'ITICM_BMAMI0080'];
    for (const id of priorityIds) {
      if (featuredCams.length >= 4) break;
      const c = state.cameras.find(cam => cam.id === id);
      if (c && !featuredCams.includes(c)) featuredCams.push(c);
    }
    for (const c of state.cameras) {
      if (featuredCams.length >= 4) break;
      if (!featuredCams.includes(c)) featuredCams.push(c);
    }

    featuredContainer.innerHTML = featuredCams.map(cam => {
      const trafficInfo = state.cameraTraffic.get(cam.id);
      const level = trafficInfo?.level === 'jam' ? 'jam' : trafficInfo?.level === 'slow' ? 'slow' : 'flowing';
      const levelText = level === 'jam' ? 'ติดขัด' : level === 'slow' ? 'ชะลอตัว' : 'คล่องตัว';
      const provider = /^DOH/i.test(cam.id) ? 'DOH' : /^ITIC/i.test(cam.id) ? 'iTIC' : 'BMA';

      return `
        <div class="dash-cam-card group" data-dash-cam="${escapeHtml(cam.id)}" role="button" tabindex="0" aria-label="เปิดกล้อง ${escapeHtml(cam.title)}">
          <div class="aspect-video relative overflow-hidden bg-slate-900">
            <img src="${escapeHtml(cam.image || '')}" alt="" class="w-full h-full object-cover" loading="lazy" onerror="this.onerror=null;this.src='/img/cam-offline.png';" />
            <div class="absolute top-2 left-2 z-10 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/45 backdrop-blur-sm text-[10px] font-semibold text-white tracking-wider">
              <span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span>LIVE
            </div>
            <div class="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center pointer-events-none">
              <span class="w-10 h-10 rounded-full bg-white/90 text-slate-900 flex items-center justify-center shadow-sm">
                <svg class="w-4 h-4 fill-current" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
              </span>
            </div>
          </div>
          <div class="px-3 py-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <div class="min-w-0 flex-1">
              <h4 class="text-xs font-medium text-slate-800 dark:text-slate-100 truncate" title="${escapeHtml(cam.title)}">${escapeHtml(cam.title)}</h4>
              <p class="text-[11px] text-slate-400 truncate">${escapeHtml(cam.org || 'BMA CCTV')}</p>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <span class="status-pill status-${level}">${levelText}</span>
              <span class="text-[10px] font-medium text-slate-400 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700">${provider}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    featuredContainer.querySelectorAll('[data-dash-cam]').forEach(card => {
      const open = () => {
        const cam = state.cameras.find(c => c.id === card.dataset.dashCam);
        if (cam) openDetail(cam);
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  // 6. Top Congested Hotspots (Top 5)
  const hotspotsContainer = el('dash-hotspots-list');
  if (hotspotsContainer && roads.length > 0) {
    const sortedRoads = [...roads].sort((a, b) => {
      const scoreA = (a.status?.key === 'jam' ? 100 : a.status?.key === 'slow' ? 50 : 10) + (a.stats?.latest10MinVolume || 0);
      const scoreB = (b.status?.key === 'jam' ? 100 : b.status?.key === 'slow' ? 50 : 10) + (b.stats?.latest10MinVolume || 0);
      return scoreB - scoreA;
    }).slice(0, 5);

    const maxVolume = Math.max(1, ...sortedRoads.map(r => r.stats?.latest10MinVolume || 0));

    hotspotsContainer.innerHTML = sortedRoads.map((road, index) => {
      const level = road.status?.key === 'jam' ? 'jam' : road.status?.key === 'slow' ? 'slow' : 'flowing';
      const barColor = level === 'jam' ? 'bg-rose-500' : level === 'slow' ? 'bg-amber-500' : 'bg-emerald-500';
      const volume = road.stats?.latest10MinVolume || 0;
      // Density bar: volume relative to the busiest road in the list, floored so a jam never reads as empty
      const floor = level === 'jam' ? 60 : level === 'slow' ? 35 : 10;
      const pct = Math.max(floor, Math.round((volume / maxVolume) * 100));

      return `
        <div class="hotspot-row -mx-4 px-4 py-2.5 flex items-center gap-3" data-dash-road="${escapeHtml(road.id)}" role="button" tabindex="0">
          <span class="w-6 h-6 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-semibold flex items-center justify-center shrink-0 tabular-nums">${index + 1}</span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-2">
              <h4 class="text-sm font-medium text-slate-800 dark:text-slate-100 truncate" title="${escapeHtml(road.name)}">${escapeHtml(road.name)}</h4>
              <span class="status-pill status-${level}">${escapeHtml(road.status?.label || 'ปกติ')}</span>
            </div>
            <div class="mt-1.5 flex items-center gap-2">
              <div class="flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="ความหนาแน่น ${escapeHtml(road.name)}">
                <div class="h-full rounded-full ${barColor} transition-all duration-300" style="width: ${pct}%"></div>
              </div>
              <span class="text-[11px] text-slate-500 tabular-nums shrink-0">${escapeHtml(road.zone || '')} · ${volume.toLocaleString('th-TH')} คัน/10 นาที</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    hotspotsContainer.querySelectorAll('[data-dash-road]').forEach(btn => {
      const go = () => {
        const roadId = btn.dataset.dashRoad;
        const target = document.querySelector(`[data-road-id="${roadId}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('ring-2', 'ring-blue-500');
          setTimeout(() => target.classList.remove('ring-2', 'ring-blue-500'), 2500);
        }
      };
      btn.addEventListener('click', go);
      btn.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    });
  }

  // 7. AI Traffic Summary text
  const aiSummary = el('dash-ai-summary-text');
  if (aiSummary) {
    const topRoad = summary?.topCongestedRoad;
    const jamCount = summary?.jamCount || 0;
    const slowCount = summary?.slowCount || 0;

    let text = `ขณะนี้ดัชนีจราจรรวมกรุงเทพฯ อยู่ที่ **${idxVal.toFixed(1)}** (${idxVal < 4 ? 'สภาพคล่องตัวดี' : idxVal < 7 ? 'เริ่มชะลอตัวในหลายเส้นทาง' : 'มีปริมาณรถติดขัดหนาแน่น'}) `;
    if (jamCount > 0 && topRoad) {
      text += `โดยมีถนนที่มีรถสะสมหนาแน่นที่สุดคือ **${topRoad}** มีรถติดขัดรวม ${jamCount} เส้นทางหลัก แนะนำผู้เดินทางตรวจสอบทางเลี่ยงก่อนออกเดินทาง`;
    } else if (slowCount > 0) {
      text += `มีการชะลอตัวสะสม ${slowCount} สายทางในเขตเมืองชั้นในและสะพานข้ามแม่น้ำเจ้าพระยา สามารถสัญจรได้ต่อเนื่อง`;
    } else {
      text += `การจราจรบนถนนสายหลัก 11 สายและรอบ 30 กล้อง CCTV ไหลลื่นได้ดีทุกทิศทาง ไม่มีจุดติดขัดสะสมรุนแรง`;
    }
    aiSummary.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    const tags = el('dash-ai-tags');
    if (tags) {
      const idxLevel = idxVal < 4 ? 'flowing' : idxVal < 7 ? 'slow' : 'jam';
      const items = [`<span class="status-pill status-${idxLevel}">ดัชนี ${idxVal.toFixed(1)}</span>`];
      if (jamCount > 0) items.push(`<span class="status-pill status-jam">ติดขัด ${jamCount} สาย</span>`);
      if (slowCount > 0) items.push(`<span class="status-pill status-slow">ชะลอ ${slowCount} สาย</span>`);
      if (topRoad) items.push(`<span class="status-pill status-neutral">${escapeHtml(topRoad)}</span>`);
      tags.innerHTML = items.join('');
    }
  }

  // Bind Ask AI buttons
  const dashChatBtn = el('dash-btn-chat');
  if (dashChatBtn) dashChatBtn.onclick = () => toggleChatDrawer(true);
  const dashAskAi = el('dash-btn-ask-ai');
  if (dashAskAi) dashAskAi.onclick = () => toggleChatDrawer(true);
}

// --- Views -----------------------------------------------------------------

function switchView(view) {
  if (view === 'analytics') {
    switchView('dashboard');
    setTimeout(() => {
      const target = el('dashboard-roads-section');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
    document.querySelectorAll('[data-view-target]').forEach(btn => {
      const active = btn.dataset.viewTarget === 'analytics';
      btn.classList.toggle('is-active', active);
    });
    return;
  }

  state.view = view;
  if (el('view-dashboard')) el('view-dashboard').classList.toggle('hidden', view !== 'dashboard');
  if (el('view-cams')) el('view-cams').classList.toggle('hidden', view !== 'cams');
  if (el('view-map')) el('view-map').classList.toggle('hidden', view !== 'map');
  if (el('view-analytics')) el('view-analytics').classList.toggle('hidden', view !== 'analytics');

  // Sync sidebar tabs & mobile tabs
  document.querySelectorAll('[data-view-target]').forEach(btn => {
    const active = btn.dataset.viewTarget === view;
    btn.classList.toggle('is-active', active);
    if (btn.classList.contains('mobile-tab')) {
      btn.classList.toggle('text-blue-600', active);
      btn.classList.toggle('dark:text-blue-400', active);
      btn.classList.toggle('text-slate-500', !active);
      btn.classList.toggle('dark:text-slate-400', !active);
    }
  });

  document.body.classList.toggle('hide-toolbar', view !== 'cams');

  if (view === 'dashboard') {
    renderDashboard();
  } else if (view === 'map') {
    buildMap();
    setTimeout(() => state.map && state.map.resize(), 60);
    if (state.map && state.map.isStyleLoaded()) addCameraMarkers();
    loadTrafficIndex();
  } else if (view === 'analytics') {
    loadRoadAnalytics();
  }
}

// --- Road Traffic Analytics (Drive D 10-Minute Video & AI Vehicles) ----------

const roadAnalyticsState = {
  data: null,
  day: 'latest',
  filter: 'all',
  query: '',
  selectedCameraPerRoad: {}, // roadId -> camId
  selectedClipPerRoad: {}    // roadId -> clipUrl
};

async function loadRoadAnalytics(day = null, forceFresh = false) {
  if (day) roadAnalyticsState.day = day;
  const targetDay = roadAnalyticsState.day;
  const listEl = el('analytics-road-list');
  const emptyEl = el('analytics-empty');

  // Update Day buttons UI
  document.querySelectorAll('.analytics-day-btn').forEach(btn => {
    const active = btn.dataset.day === targetDay;
    btn.classList.toggle('font-semibold', active);
    btn.classList.toggle('bg-white', active);
    btn.classList.toggle('dark:bg-slate-700', active);
    btn.classList.toggle('text-blue-600', active);
    btn.classList.toggle('dark:text-blue-400', active);
    btn.classList.toggle('shadow-sm', active);
    btn.classList.toggle('text-slate-600', !active);
    btn.classList.toggle('dark:text-slate-300', !active);
  });

  if (listEl && (!roadAnalyticsState.data || forceFresh)) {
    listEl.innerHTML = `
      <div class="col-span-full py-20 flex flex-col items-center justify-center gap-3">
        <div class="w-10 h-10 rounded-full border-2 border-rose-500 border-t-transparent animate-spin"></div>
        <div class="text-sm font-medium text-slate-500">กำลังวิเคราะห์ข้อมูลวิดีโอ 10 นาทีและตัวเลขรถยนต์จากไดรฟ์ D...</div>
      </div>
    `;
  }

  try {
    const url = `/api/road-analytics?day=${encodeURIComponent(targetDay)}${forceFresh ? '&fresh=1' : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    roadAnalyticsState.data = data;
    renderRoadAnalytics(data);
    clearAlert('road-analytics');
  } catch (err) {
    setAlert('road-analytics', { level: 'warn', title: 'โหลดข้อมูลวิเคราะห์รายถนนไม่ได้', message: err.message });
    if (listEl) {
      listEl.innerHTML = `
        <div class="col-span-full py-16 text-center text-rose-500 font-medium text-sm">
          ไม่สามารถโหลดข้อมูลการวิเคราะห์รายถนนได้ (${err.message})
        </div>
      `;
    }
  }
}

function renderRoadAnalytics(data) {
  if (!data || !data.summary || !data.roads) return;

  const summary = data.summary;
  const roads = data.roads;

  // 1. Update KPI Cards
  const kpiRoads = el('kpi-roads-count');
  if (kpiRoads) kpiRoads.textContent = summary.totalRoads || '11';

  const kpiVehicles = el('kpi-total-vehicles');
  if (kpiVehicles) kpiVehicles.textContent = (summary.totalVehicles || 0).toLocaleString('th-TH');

  const kpiClips = el('kpi-clips-count');
  if (kpiClips) kpiClips.textContent = `จาก ${summary.totalClips || 0} คลิปวิดีโอ (รอบละ 10 นาทีบนไดรฟ์ D)`;

  const kpiJam = el('kpi-jam-badge');
  if (kpiJam) kpiJam.textContent = `ติดขัด ${summary.jamCount || 0}`;

  const kpiSlow = el('kpi-slow-badge');
  if (kpiSlow) kpiSlow.textContent = `ชะลอตัว ${summary.slowCount || 0}`;

  const kpiFlowing = el('kpi-flowing-badge');
  if (kpiFlowing) kpiFlowing.textContent = `คล่อง ${summary.flowingCount || 0}`;

  const kpiTop = el('kpi-top-jammed');
  if (kpiTop) kpiTop.textContent = `หนาแน่นสูงสุด: ${summary.topCongestedRoad || '-'}`;

  const kpiBreakdown = el('kpi-vehicle-breakdown');
  if (kpiBreakdown && summary.counts) {
    const sum = (summary.counts.car || 0) + (summary.counts.motorcycle || 0) + (summary.counts.bus || 0) + (summary.counts.truck || 0) || 1;
    const carPct = Math.round(((summary.counts.car || 0) / sum) * 100);
    const mcPct = Math.round(((summary.counts.motorcycle || 0) / sum) * 100);
    const busPct = Math.round(((summary.counts.bus || 0) / sum) * 100);
    const truckPct = Math.round(((summary.counts.truck || 0) / sum) * 100);
    kpiBreakdown.innerHTML = `
      <span class="text-sky-600 dark:text-sky-400 font-semibold" title="รถยนต์ส่วนบุคคล/กระบะ">🚗 ${carPct}%</span>
      <span class="text-slate-300 dark:text-slate-700">|</span>
      <span class="text-amber-600 dark:text-amber-400 font-semibold" title="มอเตอร์ไซค์">🏍️ ${mcPct}%</span>
      <span class="text-slate-300 dark:text-slate-700">|</span>
      <span class="text-purple-600 dark:text-purple-400 font-semibold" title="รถเมล์/โดยสาร">🚌 ${busPct}%</span>
      <span class="text-slate-300 dark:text-slate-700">|</span>
      <span class="text-rose-600 dark:text-rose-400 font-semibold" title="รถบรรทุก/ใหญ่">🚛 ${truckPct}%</span>
    `;
  }

  // 2. Filter roads
  const filter = roadAnalyticsState.filter;
  const q = (roadAnalyticsState.query || '').trim().toLowerCase();

  const filtered = roads.filter(road => {
    if (filter !== 'all' && road.status.key !== filter) return false;
    if (q) {
      const matchName = (road.name || '').toLowerCase().includes(q);
      const matchZone = (road.zone || '').toLowerCase().includes(q);
      const matchChoke = (road.dischargeStrategy?.chokePoints || []).some(cp => cp.toLowerCase().includes(q));
      if (!matchName && !matchZone && !matchChoke) return false;
    }
    return true;
  });

  const listEl = el('analytics-road-list');
  const emptyEl = el('analytics-empty');

  if (emptyEl) emptyEl.classList.toggle('hidden', filtered.length > 0);
  if (!listEl) return;

  // Render cards
  listEl.innerHTML = filtered.map(road => {
    const activeClip = roadAnalyticsState.selectedClipPerRoad[road.id] || (road.latestClip ? road.latestClip.clipUrl : null);
    
    const isJam = road.status.key === 'jam';
    const isSlow = road.status.key === 'slow';
    const statusBg = isJam ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30' 
                   : isSlow ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
                   : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30';

    const trendIcon = road.stats.trendDirection === 'up' ? '▲' : road.stats.trendDirection === 'down' ? '▼' : '━';
    const trendColor = road.stats.trendDirection === 'up' ? 'text-rose-500' : road.stats.trendDirection === 'down' ? 'text-emerald-500' : 'text-slate-400';
    const trendText = road.stats.trendDirection === 'up' ? `+${road.stats.trendPct}% (เพิ่มขึ้น)` 
                    : road.stats.trendDirection === 'down' ? `${road.stats.trendPct}% (คลี่คลาย)` 
                    : 'คงที่';

    const maxTimelineTotal = Math.max(1, ...(road.timeline || []).map(t => t.total));

    return `
      <div id="road-card-${cssId(road.id)}" data-road-id="${escapeHtml(road.id)}" class="p-4 sm:p-5 rounded-2xl bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border border-slate-300 dark:border-slate-800 shadow-md space-y-4 hover:border-slate-400 dark:hover:border-slate-700 transition-all">
        
        <!-- Card Header -->
        <div class="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 dark:border-slate-800/80 pb-3">
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <span class="px-2.5 py-0.5 rounded-full text-xs font-bold border ${statusBg} flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full ${isJam ? 'bg-rose-500 animate-pulse' : isSlow ? 'bg-amber-500' : 'bg-emerald-500'}"></span>
                <span>${road.status.label}</span>
              </span>
              <span class="text-[11px] font-medium text-slate-500 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800">${road.zone}</span>
            </div>
            <h3 class="text-base font-bold text-slate-900 dark:text-white leading-snug">${road.name}</h3>
          </div>

          <!-- Trend Indicator -->
          <div class="text-right">
            <div class="text-[11px] text-slate-400">แนวโน้ม 10 นาที</div>
            <div class="text-xs font-bold ${trendColor} flex items-center gap-1 justify-end">
              <span>${trendIcon}</span>
              <span>${trendText}</span>
            </div>
          </div>
        </div>

        <!-- 10-Minute Video Player with Switchers -->
        <div class="space-y-2">
          <!-- Video Control Bar: Camera & Clip Switchers -->
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
            <!-- Camera Selector -->
            <div class="flex items-center gap-1.5 flex-1 min-w-[180px]">
              <span class="text-[11px] text-slate-400 font-medium shrink-0">จุดกล้อง:</span>
              <select class="analytics-cam-select ctl !h-7 !py-0 !text-[11px] w-full rounded-lg bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700" data-road-id="${road.id}">
                ${(road.cameraDetails || []).map(cam => `
                  <option value="${cam.id}" ${cam.id === (roadAnalyticsState.selectedCameraPerRoad[road.id] || road.cameras[0]) ? 'selected' : ''}>
                    ${cam.title} (${cam.clipCount} คลิป)
                  </option>
                `).join('')}
              </select>
            </div>

            <!-- Clip Selector -->
            <div class="flex items-center gap-1.5 flex-1 min-w-[180px]">
              <span class="text-[11px] text-slate-400 font-medium shrink-0">คลิป 10 นาที:</span>
              <select class="analytics-clip-select ctl !h-7 !py-0 !text-[11px] w-full rounded-lg bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700" data-road-id="${road.id}">
                ${(road.availableClips || []).map(c => `
                  <option value="${c.clipUrl}" ${c.clipUrl === activeClip ? 'selected' : ''}>
                    รอบ ${c.timeTh} (รวม ${c.total} คัน)
                  </option>
                `).join('')}
              </select>
            </div>
          </div>

          <!-- Video Element -->
          <div class="relative rounded-xl overflow-hidden bg-black aspect-video border border-slate-800 shadow-inner group">
            ${activeClip ? `
              <video id="video-road-${road.id}" src="${activeClip}" controls playsinline preload="metadata" class="w-full h-full object-contain"></video>
            ` : `
              <div class="w-full h-full flex flex-col items-center justify-center text-slate-500 text-xs gap-2">
                <svg class="w-8 h-8 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                <span>ไม่มีคลิปวิดีโอในรอบที่เลือก</span>
              </div>
            `}
            <div class="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/75 backdrop-blur-md text-[10px] font-mono text-white pointer-events-none flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span>
              <span>Drive D (10-min clip)</span>
            </div>
          </div>
        </div>

        <!-- Vehicle Classification & Numbers -->
        <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800/80 space-y-2.5">
          <div class="flex items-center justify-between text-xs font-semibold">
            <span class="text-slate-700 dark:text-slate-300">📊 ตัวเลขสถิติรถยนต์และแยกประเภท</span>
            <span class="text-rose-600 dark:text-rose-400 font-bold">
              ${road.stats.latest10MinVolume} คัน/10 นาที (~${road.stats.hourlyFlowEst} คัน/ชม.)
            </span>
          </div>

          <!-- Distribution Stacked Bar -->
          <div class="w-full h-2 rounded-full overflow-hidden flex bg-slate-200 dark:bg-slate-700">
            <div class="bg-sky-500 h-full" style="width: ${road.stats.percentages.car}%" title="รถยนต์ส่วนบุคคล ${road.stats.percentages.car}%"></div>
            <div class="bg-amber-500 h-full" style="width: ${road.stats.percentages.motorcycle}%" title="มอเตอร์ไซค์ ${road.stats.percentages.motorcycle}%"></div>
            <div class="bg-purple-500 h-full" style="width: ${road.stats.percentages.bus}%" title="รถโดยสาร/รถเมล์ ${road.stats.percentages.bus}%"></div>
            <div class="bg-rose-500 h-full" style="width: ${road.stats.percentages.truck}%" title="รถบรรทุก ${road.stats.percentages.truck}%"></div>
          </div>

          <!-- Vehicle Type Grid -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div class="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div class="text-[10px] text-slate-400">🚗 รถเก๋ง/กระบะ</div>
              <div class="font-bold text-sky-600 dark:text-sky-400 mt-0.5">
                ${road.stats.counts.car.toLocaleString('th-TH')} <span class="text-[10px] font-normal text-slate-500">(${road.stats.percentages.car}%)</span>
              </div>
            </div>
            <div class="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div class="text-[10px] text-slate-400">🏍️ มอเตอร์ไซค์</div>
              <div class="font-bold text-amber-600 dark:text-amber-400 mt-0.5">
                ${road.stats.counts.motorcycle.toLocaleString('th-TH')} <span class="text-[10px] font-normal text-slate-500">(${road.stats.percentages.motorcycle}%)</span>
              </div>
            </div>
            <div class="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div class="text-[10px] text-slate-400">🚌 รถเมล์/โดยสาร</div>
              <div class="font-bold text-purple-600 dark:text-purple-400 mt-0.5">
                ${road.stats.counts.bus.toLocaleString('th-TH')} <span class="text-[10px] font-normal text-slate-500">(${road.stats.percentages.bus}%)</span>
              </div>
            </div>
            <div class="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div class="text-[10px] text-slate-400">🚛 รถบรรทุก/ใหญ่</div>
              <div class="font-bold text-rose-600 dark:text-rose-400 mt-0.5">
                ${road.stats.counts.truck.toLocaleString('th-TH')} <span class="text-[10px] font-normal text-slate-500">(${road.stats.percentages.truck}%)</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 10-Minute Historical Trend Chart -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
            <span>📈 แนวโน้มปริมาณรถย้อนหลัง (คลิกที่แท่งเพื่อเปิดวิดีโอรอบนั้น)</span>
            <span class="text-[10px]">รวมบันทึก ${road.stats.totalVehicles.toLocaleString('th-TH')} คัน</span>
          </div>

          <div class="h-16 flex items-end gap-1.5 p-2 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800/80 overflow-x-auto no-scrollbar">
            ${(road.timeline || []).map(item => {
              const h = Math.max(10, Math.round((item.total / maxTimelineTotal) * 44));
              const isSelected = item.clipUrl === activeClip;
              const barColor = isSelected ? 'bg-rose-500' : 'bg-slate-300 dark:bg-slate-700 hover:bg-rose-400';
              return `
                <button class="analytics-timeline-bar flex-1 min-w-[20px] h-full flex flex-col justify-end items-center group relative cursor-pointer" data-road-id="${road.id}" data-clip-url="${item.clipUrl}">
                  <div class="w-full ${barColor} rounded-t transition-colors" style="height: ${h}px"></div>
                  <span class="text-[8px] text-slate-400 truncate w-full text-center mt-1">${item.time.slice(0, 5)}</span>
                  
                  <!-- Tooltip -->
                  <div class="absolute bottom-full mb-1 hidden group-hover:block z-20 px-2 py-1 rounded bg-slate-900 text-white text-[10px] whitespace-nowrap shadow-lg pointer-events-none">
                    ${item.time} น.: ${item.total} คัน (เก๋ง ${item.car}, มอเตอร์ไซค์ ${item.motorcycle}, บรรทุก ${item.truck})
                  </div>
                </button>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Traffic Assessment & Alternative Bypass -->
        <div class="p-3.5 rounded-xl border ${isJam ? 'bg-rose-50/50 dark:bg-rose-950/20 border-rose-200 dark:border-rose-900/50' : isSlow ? 'bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/50' : 'bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900/50'} space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white">
              <span>📍 การประเมินสภาพจราจร:</span>
              <span class="${isJam ? 'text-rose-600 dark:text-rose-400' : isSlow ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}">
                ${road.status.label} (${road.stats.latest10MinVolume} คัน/10 นาที)
              </span>
            </div>
            <span class="px-2 py-0.5 rounded text-[11px] font-semibold bg-white/80 dark:bg-slate-900 shadow-sm text-slate-600 dark:text-slate-300 shrink-0">
              ${isJam ? 'หนาแน่นสะสม' : isSlow ? 'ชะลอตัวปานกลาง' : 'การสัญจรคล่องตัว'}
            </span>
          </div>

          <p class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            ${isJam ? `มีปริมาณรถสะสมหนาแน่นในรอบ 10 นาทีล่าสุด (~${road.stats.hourlyFlowEst} คัน/ชม.) แถวคอยสะสมตามแยกหลัก แนะนำตรวจสอบเส้นทางเลี่ยง` 
              : isSlow ? `ปริมาณรถเริ่มชะลอตัวสะสม (~${road.stats.hourlyFlowEst} คัน/ชม.) เคลื่อนตัวได้ตามจังหวะสัญญาณไฟ` 
              : `การจราจรไหลลื่นต่อเนื่อง (~${road.stats.hourlyFlowEst} คัน/ชม.) สัญจรได้คล่องตัว`}
          </p>

          <!-- Choke points -->
          ${(road.dischargeStrategy.chokePoints || []).length ? `
            <div class="flex items-center gap-1.5 flex-wrap text-[11px] pt-1">
              <span class="text-slate-400 font-medium">จุดคอขวด:</span>
              ${road.dischargeStrategy.chokePoints.map(cp => `
                <span class="px-2 py-0.5 rounded-md bg-white/70 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 text-[10.5px]">
                  ⚠️ ${cp}
                </span>
              `).join('')}
            </div>
          ` : ''}

          <!-- Bypass Route & Maps Link -->
          <div class="pt-2 border-t border-slate-200/60 dark:border-slate-800/60 flex flex-wrap items-center justify-between gap-2">
            <div class="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
              <span>🛣️ ทางเลี่ยง:</span>
              <span class="font-medium text-slate-700 dark:text-slate-200">${road.dischargeStrategy.bypassRoute}</span>
            </div>

            <a href="${road.dischargeStrategy.mapsUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors cursor-pointer shadow-sm shadow-emerald-600/20 shrink-0">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
              <span>เปิด Google Maps</span>
            </a>
          </div>
        </div>

      </div>
    `;
  }).join('');

  // 3. Bind events for Card elements
  // Camera switcher
  listEl.querySelectorAll('.analytics-cam-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const roadId = e.target.dataset.roadId;
      const camId = e.target.value;
      roadAnalyticsState.selectedCameraPerRoad[roadId] = camId;
      
      const r = roads.find(x => x.id === roadId);
      if (r) {
        const camObj = (r.cameraDetails || []).find(c => c.id === camId);
        if (camObj && camObj.latestClip) {
          roadAnalyticsState.selectedClipPerRoad[roadId] = camObj.latestClip.clipUrl;
        }
      }
      renderRoadAnalytics(roadAnalyticsState.data);
    });
  });

  // Clip switcher
  listEl.querySelectorAll('.analytics-clip-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const roadId = e.target.dataset.roadId;
      const clipUrl = e.target.value;
      roadAnalyticsState.selectedClipPerRoad[roadId] = clipUrl;
      const vid = el(`video-road-${roadId}`);
      if (vid) {
        vid.src = clipUrl;
        vid.play().catch(() => {});
      }
    });
  });

  // Timeline bar clicks
  listEl.querySelectorAll('.analytics-timeline-bar').forEach(bar => {
    bar.addEventListener('click', () => {
      const roadId = bar.dataset.roadId;
      const clipUrl = bar.dataset.clipUrl;
      if (!clipUrl) return;
      roadAnalyticsState.selectedClipPerRoad[roadId] = clipUrl;
      const vid = el(`video-road-${roadId}`);
      if (vid) {
        vid.src = clipUrl;
        vid.play().catch(() => {});
      }
      const sel = listEl.querySelector(`.analytics-clip-select[data-road-id="${roadId}"]`);
      if (sel) sel.value = clipUrl;
    });
  });
}

function initRoadAnalyticsListeners() {
  // Day filter buttons
  document.querySelectorAll('.analytics-day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      loadRoadAnalytics(btn.dataset.day);
    });
  });

  // Refresh button
  const refreshBtn = el('btn-refresh-analytics');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadRoadAnalytics(roadAnalyticsState.day, true);
    });
  }

  // Filter buttons (all, jam, slow, flowing)
  document.querySelectorAll('.analytics-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.analytics-filter-btn').forEach(b => {
        b.classList.remove('bg-blue-600', 'text-white', 'is-active');
        b.classList.add('bg-slate-100', 'dark:bg-slate-800', 'text-slate-700', 'dark:text-slate-300');
      });
      btn.classList.remove('bg-slate-100', 'dark:bg-slate-800', 'text-slate-700', 'dark:text-slate-300');
      btn.classList.add('bg-blue-600', 'text-white', 'is-active');

      roadAnalyticsState.filter = btn.dataset.filter;
      renderRoadAnalytics(roadAnalyticsState.data);
    });
  });

  // Search input
  const searchInput = el('analytics-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      roadAnalyticsState.query = e.target.value;
      renderRoadAnalytics(roadAnalyticsState.data);
    });
  }
}

// --- Boot ------------------------------------------------------------------

function startClock() {
  const tick = () => {
    const timeStr = new Date().toLocaleTimeString('th-TH');
    const c = el('clock');
    if (c) c.textContent = timeStr;
    const sc = el('sidebar-clock');
    if (sc) sc.textContent = timeStr;
    const dc = el('dash-clock');
    if (dc) dc.textContent = timeStr + ' น.';
  };
  tick();
  setInterval(tick, 1000);
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}

// So it is possible to tell at a glance whether the browser is running the
// current code - the question that cost several rounds of debugging
function showBuild() {
  const tag = document.querySelector('script[src*="app.js"]');
  const stamp = tag && new URL(tag.src, location.href).searchParams.get('v');
  const box = el('build');
  if (box && stamp) {
    box.textContent = 'build ' + new Date(Number(stamp)).toLocaleTimeString('th-TH');
  }
}

// --- AI Traffic Chatbot ----------------------------------------------------

const chatState = {
  history: [],
  isOpen: false,
  isGenerating: false,
  apiKey: localStorage.getItem('bkk_gemini_api_key') || ''
};

function renderMarkdown(md) {
  let html = escapeHtml(md);

  // Headers
  html = html.replace(/^#### (.*$)/gim, '<h5 class="font-bold text-slate-800 dark:text-slate-200 mt-2 mb-0.5 text-[11px]">$1</h5>');
  html = html.replace(/^### (.*$)/gim, '<h4 class="font-bold text-slate-900 dark:text-white mt-2 mb-1 text-xs">$1</h4>');
  html = html.replace(/^## (.*$)/gim, '<h3 class="font-bold text-slate-900 dark:text-white mt-2.5 mb-1 text-sm">$1</h3>');

  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-slate-900 dark:text-white">$1</strong>');

  // Italic
  html = html.replace(/\*(.*?)\*/g, '<em class="italic text-slate-500 dark:text-slate-400">$1</em>');

  // Horizontal rules
  html = html.replace(/^---$/gim, '<hr class="my-2 border-slate-200 dark:border-slate-700/60" />');

  // Blockquotes
  html = html.replace(/^&gt; (.*$)/gim, '<div class="pl-2.5 py-1 my-1 border-l-2 border-purple-500 bg-purple-500/10 rounded-r text-[11px] text-slate-700 dark:text-slate-300">$1</div>');

  // Camera links: [text](cam:ID) -> clickable button
  html = html.replace(/\[(.*?)\]\(cam:([A-Za-z0-9_-]+)\)/g, '<a href="cam:$2" class="chat-cam-link" data-open-cam="$2">$1</a>');

  // Google Maps links: [text](https://www.google.com/maps/...) -> prominent navigation button
  html = html.replace(/\[(.*?)\]\((https?:\/\/(?:www\.)?google\.com\/maps[^\s)]+)\)/gi, (match, text, url) => {
    const cleanUrl = url.replace(/&amp;/g, '&');
    return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="chat-gmap-link" title="เปิดนำทางบน Google Maps"><svg class="w-3.5 h-3.5 inline-block shrink-0 text-emerald-500 dark:text-emerald-400" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg><span>${text}</span><svg class="w-2.5 h-2.5 opacity-60 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg></a>`;
  });

  // General web links: [text](https://...)
  html = html.replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/gi, (match, text, url) => {
    const cleanUrl = url.replace(/&amp;/g, '&');
    return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 underline inline-flex items-center gap-0.5">${text}<svg class="w-2.5 h-2.5 opacity-60 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg></a>`;
  });

  // Line breaks
  html = html.replace(/\n/g, '<br/>');
  return html;
}

function appendChatMessage(role, content) {
  const container = el('chat-messages');
  if (!container) return;

  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-msg ${role} flex gap-2.5 items-start`;

  const isUser = role === 'user';
  const avatar = isUser
    ? `<div class="w-7 h-7 rounded-lg bg-slate-700 flex items-center justify-center text-white shrink-0 mt-0.5 shadow-sm text-[10px] font-bold">ME</div>`
    : `<div class="w-7 h-7 rounded-lg bg-gradient-to-br from-rose-500 via-purple-600 to-indigo-600 flex items-center justify-center text-white shrink-0 mt-0.5 shadow-sm shadow-purple-500/20">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
      </div>`;

  const bubble = document.createElement('div');
  bubble.className = isUser
    ? 'chat-bubble p-2.5 px-3 rounded-2xl rounded-tr-sm bg-gradient-to-r from-rose-500 via-purple-600 to-indigo-600 text-white leading-relaxed text-xs'
    : 'chat-bubble flex-1 p-3 rounded-2xl rounded-tl-sm bg-slate-100 dark:bg-slate-800/90 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700/60 leading-relaxed shadow-sm text-xs';

  bubble.innerHTML = isUser ? escapeHtml(content) : renderMarkdown(content);

  // Bind cam clicks
  bubble.querySelectorAll('[data-open-cam]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const camId = a.dataset.openCam;
      const cam = state.cameras.find(c => c.id === camId);
      if (cam) {
        openDetail(cam);
      }
    });
  });

  if (isUser) {
    msgDiv.appendChild(bubble);
    msgDiv.appendChild(createNodeFromHtml(avatar));
  } else {
    msgDiv.appendChild(createNodeFromHtml(avatar));
    msgDiv.appendChild(bubble);
  }

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
}

function createNodeFromHtml(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function showTypingIndicator() {
  const container = el('chat-messages');
  if (!container) return;
  removeTypingIndicator();

  const ind = document.createElement('div');
  ind.id = 'chat-typing-indicator';
  ind.className = 'chat-msg assistant flex gap-2.5 items-start';
  ind.innerHTML = `
    <div class="w-7 h-7 rounded-lg bg-gradient-to-br from-rose-500 via-purple-600 to-indigo-600 flex items-center justify-center text-white shrink-0 mt-0.5 shadow-sm shadow-purple-500/20">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
    </div>
    <div class="chat-bubble p-3 rounded-2xl rounded-tl-sm bg-slate-100 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700/60 flex items-center gap-1.5 text-purple-600 dark:text-purple-400">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </div>
  `;
  container.appendChild(ind);
  container.scrollTop = container.scrollHeight;
}

function removeTypingIndicator() {
  const ind = el('chat-typing-indicator');
  if (ind) ind.remove();
}

async function sendChatMessage(query, selectedCamId = '') {
  const q = (query || '').trim();
  if (!q || chatState.isGenerating) return;

  appendChatMessage('user', q);
  chatState.history.push({ role: 'user', content: q });
  chatState.isGenerating = true;
  showTypingIndicator();

  const input = el('chat-input');
  if (input) input.value = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: q,
        history: chatState.history,
        apiKey: chatState.apiKey,
        selectedCamId: selectedCamId
      })
    });

    const data = await res.json();
    removeTypingIndicator();

    if (data.error) {
      appendChatMessage('assistant', `⚠️ เกิดข้อผิดพลาด: ${data.error}`);
    } else {
      appendChatMessage('assistant', data.reply);
      chatState.history.push({ role: 'assistant', content: data.reply });
      if (data.mode === 'gemini') {
        updateChatModeBadge('Gemini 2.0 Lite', 'bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-sm shadow-purple-500/30');
      }
    }
  } catch (err) {
    removeTypingIndicator();
    appendChatMessage('assistant', `⚠️ เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ (${err.message})`);
  } finally {
    chatState.isGenerating = false;
  }
}

function updateChatModeBadge(text, cls) {
  const b = el('chat-mode-badge');
  if (!b) return;
  b.textContent = text;
  b.className = `px-1.5 py-0.5 rounded text-[9px] font-bold ${cls}`;
}

function toggleChatDrawer(open) {
  const drawer = el('chat-drawer');
  if (!drawer) return;
  const show = open === undefined ? drawer.classList.contains('hidden') : open;
  drawer.classList.toggle('hidden', !show);
  chatState.isOpen = show;
  if (show) {
    const input = el('chat-input');
    if (input) setTimeout(() => input.focus(), 150);
  }
}

function initChatbot() {
  const btnToggle = el('btn-toggle-chat');
  if (btnToggle) btnToggle.addEventListener('click', () => toggleChatDrawer());
  const sideTab = el('tab-chat');
  if (sideTab) sideTab.addEventListener('click', () => toggleChatDrawer(true));
  const closeBtn = el('chat-btn-close');
  if (closeBtn) closeBtn.addEventListener('click', () => toggleChatDrawer(false));

  const form = el('chat-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = el('chat-input');
      if (input) sendChatMessage(input.value);
    });
  }

  document.querySelectorAll('[data-quick-prompt]').forEach(btn => {
    btn.addEventListener('click', () => {
      sendChatMessage(btn.dataset.quickPrompt);
    });
  });

  const askAiBtn = el('detail-ask-ai');
  if (askAiBtn) {
    askAiBtn.addEventListener('click', () => {
      if (state.detail) {
        toggleChatDrawer(true);
        sendChatMessage(`วิเคราะห์สภาพจราจรและปริมาณรถของกล้อง ${state.detail.title}`, state.detail.id);
      }
    });
  }

  const navAiBtn = el('detail-nav-ai');
  if (navAiBtn) {
    navAiBtn.addEventListener('click', () => {
      if (state.detail) {
        toggleChatDrawer(true);
        sendChatMessage(`แนะนำเส้นทางเลี่ยงรถติดบริเวณ ${state.detail.title}`, state.detail.id);
      }
    });
  }

  const clearBtn = el('chat-btn-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      chatState.history = [];
      const msgBox = el('chat-messages');
      if (msgBox) {
        msgBox.innerHTML = `
          <div class="chat-msg assistant flex gap-2.5 items-start">
            <div class="w-7 h-7 rounded-lg bg-gradient-to-br from-rose-500 via-purple-600 to-indigo-600 flex items-center justify-center text-white shrink-0 mt-0.5 shadow-sm shadow-purple-500/20">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            </div>
            <div class="chat-bubble flex-1 p-3 rounded-2xl rounded-tl-sm bg-slate-100 dark:bg-slate-800/90 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700/60 leading-relaxed shadow-sm text-xs">
              <p class="font-bold text-slate-900 dark:text-white mb-1">ล้างประวัติการสนทนาเรียบร้อยครับ 🚦</p>
              <p>สามารถสอบถามสภาพจราจรใหม่ได้ทันทีครับ</p>
            </div>
          </div>
        `;
      }
    });
  }

  const settingsBtn = el('chat-btn-settings');
  const settingsPanel = el('chat-settings-panel');
  const apiKeyInput = el('chat-input-apikey');
  const saveKeyBtn = el('chat-btn-save-key');

  if (apiKeyInput && chatState.apiKey) {
    apiKeyInput.value = chatState.apiKey;
    updateChatModeBadge('Gemini 2.0 Lite', 'bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-sm shadow-purple-500/30');
  }

  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener('click', () => {
      settingsPanel.classList.toggle('hidden');
    });
  }

  if (saveKeyBtn && apiKeyInput) {
    saveKeyBtn.addEventListener('click', () => {
      const key = apiKeyInput.value.trim();
      chatState.apiKey = key;
      localStorage.setItem('bkk_gemini_api_key', key);
      if (key) {
        updateChatModeBadge('Gemini 2.0 Lite', 'bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-sm shadow-purple-500/30');
      } else {
        updateChatModeBadge('Built-in Map AI', 'bg-purple-500/15 text-purple-600 dark:text-purple-300');
      }
      if (settingsPanel) settingsPanel.classList.add('hidden');
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initAlerts();
  showBuild();
  startClock();
  setGridLayout(state.gridCols);
  updateWatchlistBadges();
  loadCameras();
  loadTrafficIndex();
  loadTrafficData();
  loadRoadAnalytics('latest');
  initChatbot();
  initRoadAnalyticsListeners();
  switchView('dashboard');

  const btn = el('btn-refresh');
  if (btn) btn.addEventListener('click', () => { loadCameras(); loadTrafficIndex(); loadTrafficData(); loadRoadAnalytics(roadAnalyticsState.day, true); });
  const mBtn = el('mobile-btn-refresh');
  if (mBtn) mBtn.addEventListener('click', () => { loadCameras(); loadTrafficIndex(); loadTrafficData(); loadRoadAnalytics(roadAnalyticsState.day, true); });

  // Sidebar and Mobile navigation tabs
  document.querySelectorAll('[data-view-target]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.viewTarget));
  });

  // Filter buttons & pills (All, Watchlist, Jam, Slow, Flowing)
  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => setTrafficFilter(btn.dataset.filter));
  });

  // Multi-view Grid layout switchers
  [2, 3, 4].forEach(cols => {
    const b = el(`grid-cols-${cols}`);
    if (b) b.addEventListener('click', () => setGridLayout(cols));
  });

  const search = el('search');
  if (search) search.addEventListener('input', applyFilter);
  const orgSel = el('org-filter');
  if (orgSel) orgSel.addEventListener('change', applyFilter);
  const searchClear = el('search-clear');
  if (searchClear) searchClear.addEventListener('click', () => {
    search.value = '';
    search.focus();
    applyFilter();
  });

  // Global keyboard shortcut '/' to focus search
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== search && !state.detail) {
      e.preventDefault();
      search?.focus();
      search?.select();
    }
  });

  const theme = el('btn-theme');
  if (theme) theme.addEventListener('click', toggleTheme);
  const mTheme = el('mobile-btn-theme');
  if (mTheme) mTheme.addEventListener('click', toggleTheme);

  setInterval(() => { if (state.view === 'map') loadTrafficIndex(); }, 60000);
  setInterval(() => { if (state.view === 'dashboard') { loadTrafficIndex(); loadTrafficData(); loadRoadAnalytics(roadAnalyticsState.day); } }, 60000);

  el('detail-close').addEventListener('click', closeDetail);
  el('detail').addEventListener('click', (e) => { if (e.target.id === 'detail') closeDetail(); });
  el('detail-tab-det').addEventListener('click', () => setDetailMode('det'));
  el('detail-tab-live').addEventListener('click', () => setDetailMode('live'));
  if (el('detail-tab-rec')) el('detail-tab-rec').addEventListener('click', () => setDetailMode('rec'));
  const detailPip = el('detail-pip-btn');
  if (detailPip) detailPip.addEventListener('click', () => togglePiP(el('detail-video')));
  const detailFsBtn = el('detail-fullscreen-btn');
  if (detailFsBtn) {
    detailFsBtn.addEventListener('click', () => {
      const container = el('detail-player-container');
      if (!container) return;
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (container.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      }
    });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.detail) closeDetail(); });

  const overlayBtn = el('btn-overlay');
  if (overlayBtn) {
    const paint = () => {
      overlayBtn.innerHTML = `
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M3 9h2m-2 6h2m14-6h2m-2 6h2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
        <span>${state.showGridOverlay ? 'ซ่อนกรอบในเมนู' : 'แสดงกรอบในเมนู'}</span>
      `;
      overlayBtn.classList.toggle('is-on', state.showGridOverlay);
    };
    paint();
    overlayBtn.addEventListener('click', () => {
      state.showGridOverlay = !state.showGridOverlay;
      localStorage.setItem('showGridOverlay', state.showGridOverlay ? '1' : '0');
      paint();
      redrawAllBoxes();
    });
  }

  const detailOverlayBtn = el('detail-overlay-btn');
  if (detailOverlayBtn) {
    const paintDetailOverlay = () => {
      detailOverlayBtn.classList.toggle('is-on', state.showDetailOverlay);
      detailOverlayBtn.classList.toggle('bg-blue-600', state.showDetailOverlay);
      detailOverlayBtn.classList.toggle('text-white', state.showDetailOverlay);
      const lbl = el('detail-overlay-label');
      if (lbl) lbl.textContent = state.showDetailOverlay ? 'ซ่อนกรอบ AI' : 'แสดงกรอบ AI';
    };
    paintDetailOverlay();
    detailOverlayBtn.addEventListener('click', () => {
      state.showDetailOverlay = !state.showDetailOverlay;
      localStorage.setItem('showDetailOverlay', state.showDetailOverlay ? '1' : '0');
      paintDetailOverlay();
      redrawAllBoxes();
    });
  }
  window.addEventListener('resize', () => redrawAllBoxes());
  const onFsChange = () => {
    setTimeout(redrawAllBoxes, 50);
    setTimeout(redrawAllBoxes, 200);
    setTimeout(redrawAllBoxes, 500);
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  loadDetections();
  setInterval(() => {
    if (state.view !== 'cams') return;
    loadDetections();
  }, 2000);

  loadRecordings();
  setInterval(() => {
    if (state.view === 'cams') loadRecordings();
  }, 10000);

  // Browser Autoplay Policy Unblocker: Ensure all videos play on first user interaction
  const unblockVideos = () => {
    document.querySelectorAll('video').forEach(v => {
      if (v.paused && v.src) {
        v.muted = true;
        v.play().catch(() => {});
      }
    });
  };
  document.addEventListener('click', unblockVideos, { once: true });
  document.addEventListener('touchstart', unblockVideos, { once: true });
});
