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
  view: 'cams',
  detections: new Map(), // camera id -> reading
  recordings: new Map(), // camera id -> what recorder/record.py has kept
  showOverlay: localStorage.getItem('showOverlay') !== '0',
  // Measured against these servers: eight parallel fetches shared 2.5 Mbps in
  // total, while the streams themselves run 0.3-6.8 Mbps each. Playing all
  // nineteen at once cannot work, so only a few run at a time.
  playing: [],        // camera ids, oldest first
  observer: null,
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
  } catch (err) {
    grid.innerHTML = '';
    setEmptyMessage(`โหลดรายการกล้องไม่สำเร็จ (${err.message})`);
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
      <div class="relative bg-black aspect-video flex items-center justify-center">
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

        <div id="o-${cssId(cam.id)}" class="absolute inset-0 pointer-events-none"></div>
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
          <span class="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-600 dark:text-rose-400 ml-auto shrink-0">
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
      const slot = el('rec-' + btn.dataset.fullscreen);
      if (!slot) return;
      if (slot.requestFullscreen) slot.requestFullscreen();
    });
  });

  applyFilter();
  paintCardCounts();
  paintTrafficBadges();
  updateWatchlistBadges();
  state.cameras.forEach(paintRecording);
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
      btn.classList.toggle('text-rose-500', active);
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
        slot.innerHTML = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-600 text-white shadow-sm shadow-rose-600/50 flex items-center gap-1" title="วิดีโอ AI ตรวจจับ: ติดขัดสะสม ${spd.stopped_pct}% จอดนิ่ง"><span class="w-1.5 h-1.5 rounded-full bg-white animate-ping"></span>ติดขัด AI (${spd.avg_px_s} px/s)</span>`;
        return;
      } else if (spd.status === 'slow') {
        slot.innerHTML = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-slate-900 shadow-sm shadow-amber-500/50" title="วิดีโอ AI ตรวจจับ: ชะลอตัว">ชะลอตัว AI (${spd.avg_px_s} px/s)</span>`;
        return;
      } else if (spd.status === 'flowing') {
        slot.innerHTML = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500 text-white shadow-sm shadow-emerald-500/50" title="วิดีโอ AI ตรวจจับ: คล่องตัว">คล่องตัว AI (${spd.avg_px_s} px/s)</span>`;
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

async function loadRecordings() {
  try {
    const res = await fetch('/api/recordings');
    const data = await res.json();
    state.recordings = new Map((data.cameras || []).map(c => [c.id, c]));
    showRecorderNotice(!data.recording);
    state.cameras.forEach(paintRecording);
  } catch (err) {
    /* recorder not running; the cards say so */
  }
}

function paintRecording(cam) {
  const slot = el('rec-' + cssId(cam.id));
  if (!slot) return;
  const rec = state.recordings.get(cam.id);

  if (!rec) {
    slot.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-xs text-slate-500">ยังไม่มีคลิปที่บันทึกไว้</div>';
    return;
  }

  const clips = rec.clips || [];
  if (!clips.length) {
    slot.innerHTML = '<div class="absolute inset-0 flex items-center justify-center text-xs text-slate-500">ยังไม่มีคลิปที่บันทึกไว้</div>';
    return;
  }

  // Keep playing where this card already was. Repainting happens every time
  // the list is refetched, and starting the day over each time would mean a
  // card never got past its first clip.
  const playing = slot.querySelector('video');
  const at = playing && playing.dataset.clip;
  let index = at ? clips.indexOf(at) : -1;
  if (index === -1) index = clips.length - 1;   // a new card opens on the newest
  if (playing && clips[index] === at) {
    playing.dataset.clips = clips.join(' ');
    return;
  }

  slot.innerHTML = `<video class="absolute inset-0 w-full h-full object-contain"
    muted playsinline autoplay></video>
    <span class="absolute top-2.5 left-2.5 px-2 py-0.5 text-[10px] font-bold bg-slate-900/80 text-white rounded"></span>`;
  const video = slot.querySelector('video');
  const badge = slot.querySelector('span');
  video.dataset.clips = clips.join(' ');

  const show = (i) => {
    const list = video.dataset.clips.split(' ');
    const clip = list[Math.min(i, list.length - 1)];
    video.dataset.clip = clip;
    video.src = `/api/recording/${encodeURIComponent(cam.id)}/${clip}`;
    badge.textContent = clip.slice(11, 19).replace(/-/g, ':');
    video.play().catch(() => { /* a card off screen may refuse to start */ });
  };

  // A clip is ten minutes and the next one is already recorded by the time it
  // ends, so a card that runs straight on never has to wait for one.
  video.addEventListener('ended', () => {
    const list = video.dataset.clips.split(' ');
    const next = list.indexOf(video.dataset.clip) + 1;
    show(next < list.length ? next : 0);
  });

  show(index);
}

function showRecorderNotice(off) {
  let bar = el('recorder-notice');
  if (!off) { if (bar) bar.remove(); return; }
  if (bar) return;
  bar = document.createElement('div');
  bar.id = 'recorder-notice';
  bar.className = 'detector-notice';
  bar.textContent = 'ตัวบันทึกไม่ได้ทำงาน การ์ดจึงยังไม่มีคลิป — เปิดด้วย npm run record';
  document.body.insertBefore(bar, document.body.firstChild);
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

    if (state.detail) renderDetailCounts(state.detail, state.detections.get(state.detail.id));
    redrawAllBoxes();

    paintCardCounts();
  } catch (err) {
    /* detector off; leave the page as it is */
  }
}

const LABELS = { car: 'รถยนต์', motorcycle: 'จยย.', bus: 'รถโดยสาร', truck: 'บรรทุก' };
// A count is only worth showing while it still describes the road. Detection
// runs on the open camera alone, so anything older than this is a leftover.
const STALE_AFTER = 120;

// Reads from the stored readings rather than from one response, so a fresh
// grid can be filled in too. The catalogue and the detections are fetched at
// the same moment: when the detections landed first, render() wiped these
// lines and a new visitor saw no counts until the next poll, twenty seconds on.
function paintCardCounts() {
  // Wipe first: a reading that has just aged out is gone from the map, and
  // painting only what is left would leave its old line on the card forever.
  state.cameras.forEach(cam => {
    const box = el('c-' + cssId(cam.id));
    if (box && !state.detections.has(cam.id)) box.textContent = '';
  });

  state.detections.forEach(d => {
    const box = el('c-' + cssId(d.id));
    if (!box) return;
    if (d.total === null) {
      box.textContent = '';
      return;
    }
    const parts = Object.entries(d.counts)
      .map(([k, n]) => `${LABELS[k] || k} ${n}`)
      .join(' · ');
    box.textContent = d.total ? `${d.total} คัน — ${parts}` : 'ไม่พบรถ';
  });
}

function showDetectorNotice(off) {
  let bar = el('detector-notice');
  if (!off) { if (bar) bar.remove(); return; }
  if (bar) return;

  bar = document.createElement('div');
  bar.id = 'detector-notice';
  bar.className = 'detector-notice';
  bar.textContent = 'เว็บนี้ไม่มีการตรวจจับรถ — ตัวตรวจจับทำงานบนเครื่องที่รันเซิร์ฟเวอร์เท่านั้น เปิดที่ http://localhost:3000 เพื่อดูกรอบตรวจจับ';
  document.body.insertBefore(bar, document.body.firstChild);
}


// --- Box overlay -----------------------------------------------------------
//
// The detector reports boxes in fractions of the frame, so they can be laid
// over a video of any size. The video is object-contain, so the picture is
// letterboxed inside its element and the boxes have to follow the picture,
// not the element.

const BOX_COLOURS = { car: '#54C00C', motorcycle: '#FEDE04', bus: '#FF9020', truck: '#FF3030' };

function pictureRect(video) {
  const ew = video.clientWidth, eh = video.clientHeight;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return { x: 0, y: 0, w: ew, h: eh };

  const scale = Math.min(ew / vw, eh / vh);
  const w = vw * scale, h = vh * scale;
  return { x: (ew - w) / 2, y: (eh - h) / 2, w, h };
}

function drawBoxes(camId, overlay, video) {
  if (!overlay) return;
  const reading = state.detections.get(camId);
  const boxes = (reading && reading.boxes) || [];

  if (!state.showOverlay) { overlay.innerHTML = ''; return; }

  if (!boxes.length) {
    // The first pass takes a moment after the stream opens, and a bare picture
    // in the meantime reads as the detector being broken
    overlay.innerHTML = `<div style="position:absolute;bottom:8px;left:8px;padding:2px 8px;border-radius:8px;background:rgba(0,0,0,.7);color:#94a3b8;font-size:10px">
        ${state.focusId === camId ? 'กำลังเริ่มตรวจจับ...' : 'ยังไม่ได้ตรวจจับกล้องนี้'}
      </div>`;
    return;
  }

  const r = pictureRect(video);
  const age = Math.round(Date.now() / 1000 - reading.at);

  // Inline styles rather than utility classes: this markup is injected after
  // load, and positioning the overlay must not depend on a CDN picking it up.
  overlay.innerHTML = `
    <svg style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none" preserveAspectRatio="none">
      ${boxes.map(b => {
        const x = r.x + b.x * r.w, y = r.y + b.y * r.h;
        const w = b.w * r.w, h = b.h * r.h;
        const c = BOX_COLOURS[b.k] || '#54C00C';
        // The id comes from the tracker, so the same vehicle keeps its number
        // from frame to frame - which is what shows the tracking is working
        const tag = b.id === undefined ? '' :
          `<text x="${(x + 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" fill="${c}"
                 font-size="11" font-family="monospace"
                 style="paint-order:stroke;stroke:#000;stroke-width:3">#${b.id}</text>`;
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"
                 fill="none" stroke="${c}" stroke-width="2" rx="2" />${tag}`;
      }).join('')}
    </svg>
    <div style="position:absolute;bottom:8px;left:8px;padding:2px 8px;border-radius:8px;background:rgba(0,0,0,.7);color:#fff;font-size:10px">
      ${boxes.length} คัน · ${age < 3 ? 'สด' : 'ตรวจเมื่อ ' + (age < 60 ? age + ' วิ' : Math.round(age / 60) + ' นาที') + 'ที่แล้ว'}
    </div>`;
}

// Only the camera someone has opened. The grid used to draw boxes on every
// playing card, and that is what forced the detector to sweep all of them:
// twenty streams and twenty YOLO passes a round to decorate thumbnails too
// small to read a box off. One camera at a time is also the only way the
// tracker reaches its full rate.
function redrawAllBoxes() {
  if (state.detail && state.detailMode === 'live') {
    drawBoxes(state.detail.id, el('detail-overlay'), el('detail-video'));
  }
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
        const line = el('c-' + cssId(id));
        if (line && reading.total !== null) {
          const parts = Object.entries(reading.counts).map(([k, n]) => `${LABELS[k] || k} ${n}`).join(' · ');
          line.textContent = reading.total ? `${reading.total} คัน — ${parts}` : 'ไม่พบรถ';
        }
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

// The open camera, or nothing. Closing the detail releases the detector, so a
// grid left open on screen costs it nothing.
function refreshFocusTarget() {
  setFocus(state.detail ? state.detail.id : null);
}

// --- Camera detail ---------------------------------------------------------
//
// Opens on the detector's annotated frame, since that is what the counts are
// read off, with the live stream a tab away. Only one stream runs here, and
// the grid's players are stopped while it is open.

function openDetail(cam) {
  state.detail = cam;
  state.detailMode = 'det';

  el('detail-title').textContent = cam.title;
  el('detail-org').textContent = cam.org;
  el('detail').classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  renderDetail();
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
  if (video) { try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {} }

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
    (mode === 'det' ? 'bg-rose-600 text-white' : idle);
  el('detail-tab-live').className = 'px-3 py-1.5 rounded-xl text-xs font-semibold cursor-pointer ' +
    (mode === 'live' ? 'bg-rose-600 text-white' : idle);
  renderDetail();
}

function renderDetail(imageOnly = false) {
  const cam = state.detail;
  if (!cam) return;

  const img = el('detail-img');
  const video = el('detail-video');
  const msg = el('detail-msg');
  const reading = state.detections.get(cam.id);

  if (state.detailMode === 'det') {
    img.classList.remove('hidden');
    video.classList.add('hidden');
    const ov = el('detail-overlay');
    if (ov) ov.innerHTML = '';

    const hls = state.players.get('detail');
    if (hls) { try { hls.destroy(); } catch (e) {} state.players.delete('detail'); }
    if (!imageOnly) { try { video.pause(); } catch (e) {} }

    if (reading && reading.total !== null) {
      img.src = `/api/detect-frame/${encodeURIComponent(cam.id)}?t=${Date.now()}`;
      msg.textContent = '';
    } else {
      img.removeAttribute('src');
      msg.textContent = reading && reading.error
        ? 'ตรวจจับไม่สำเร็จ: ' + reading.error
        : 'ยังไม่มีผลตรวจจับ — ตัวตรวจจับอาจไม่ได้เปิดอยู่';
    }
  } else {
    img.classList.add('hidden');
    video.classList.remove('hidden');
    msg.textContent = '';
    attachDetailPlayer(cam, video, msg);
    video.addEventListener('loadedmetadata', () => drawBoxes(cam.id, el('detail-overlay'), video), { once: true });
    setTimeout(() => drawBoxes(cam.id, el('detail-overlay'), video), 400);
  }

  if (imageOnly) return;
  renderDetailCounts(cam, reading);
}

function renderDetailCounts(cam, reading) {
  const box = el('detail-counts');
  const age = el('detail-age');
  const note = el('detail-note');

  if (!reading || reading.total === null) {
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
      chip('ความเร็วพื้นที่ AI', spd.avg_px_s + ' px/s', 'bg-purple-500/15 border border-purple-500/30 text-purple-300') +
      chip('สถานะวิดีโอ', spd.status_th || spd.status, tone) +
      chip('จอดนิ่งสะสม', spd.stopped_pct + '%', 'bg-slate-800 border border-slate-700 text-slate-300');
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
    const text = `ดัชนีจราจร ${i.toFixed(1)} · ${label}`;
    if (box) box.textContent = text;
    if (sideBox) sideBox.textContent = text;
    if (stamp) stamp.textContent = 'อัปเดต ' + new Date().toLocaleTimeString('th-TH');
  } catch (err) {
    if (box) box.textContent = 'ดัชนีจราจร: ไม่พร้อมใช้งาน';
    if (sideBox) sideBox.textContent = 'ดัชนี: ออฟไลน์';
  }
}

// --- Signal advice ---------------------------------------------------------
//
// The server reads the same traffic colours the map draws and turns them into
// one card per road. Longdo repaints about every five minutes, so refreshing
// faster than that redraws the same numbers.

const ADVICE_REFRESH_MS = 5 * 60 * 1000;

const ACTION_STYLE = {
  meter: { chip: 'bg-rose-600 text-white', box: 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900' },
  release: { chip: 'bg-amber-500 text-slate-900', box: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900' },
  watch: { chip: 'bg-slate-500 text-white', box: 'bg-slate-100 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700' },
  normal: { chip: 'bg-emerald-600 text-white', box: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900' },
  unknown: { chip: 'bg-slate-400 text-white', box: 'bg-slate-100 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700' }
};

const ACTION_LABEL = {
  meter: 'หน่วงรถ',
  release: 'เพิ่มไฟเขียว',
  watch: 'เฝ้าดู',
  normal: 'ปกติ',
  unknown: 'ไม่มีข้อมูล'
};

const LEVEL_COLOUR = { flowing: '#54C00C', slow: '#FEDE04', jam: '#FF2020' };

/** The green/amber/red proportions of a road, as one bar. */
function shareBar(share) {
  const part = (pct, colour) =>
    pct > 0 ? `<div style="width:${pct}%;background:${colour}"></div>` : '';
  return `<div class="flex h-2 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-800">
    ${part(share.jam, LEVEL_COLOUR.jam)}${part(share.slow, LEVEL_COLOUR.slow)}${part(share.flowing, LEVEL_COLOUR.flowing)}
  </div>`;
}

function directionChips(directions) {
  if (!directions) return '';
  const chip = (name, d) => `<span class="px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
      <span style="color:${LEVEL_COLOUR[d.level]}">&#9679;</span> ${name} ${escapeHtml(d.label)}
    </span>`;
  return `<div class="flex flex-wrap gap-1.5 text-[11px]">
    ${chip('ขาไป', directions.forward)}${chip('ขากลับ', directions.reverse)}
  </div>`;
}

function adviceCard(road) {
  const style = ACTION_STYLE[road.advice.action] || ACTION_STYLE.unknown;
  const c = road.congestion;
  const reading = c
    ? `${shareBar(c.share)}
       <p class="text-[11px] text-slate-500 dark:text-slate-400">
         ติดขัด ${c.share.jam}% &middot; ชะลอตัว ${c.share.slow}% &middot; คล่องตัว ${c.share.flowing}%
         <span class="text-slate-400 dark:text-slate-500">จากถนน ${c.km} กม. รอบกล้อง</span>
       </p>`
    : '<p class="text-[11px] text-slate-500">ไม่มีเส้นจราจรที่ระบายสีรอบจุดนี้</p>';

  return `<article class="p-4 bg-white dark:bg-slate-900/90 rounded-2xl border border-slate-300 dark:border-slate-800 space-y-2.5">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-sm font-semibold leading-snug">${escapeHtml(road.name)}</h3>
        <p class="text-[11px] text-slate-500 mt-0.5">${c ? escapeHtml(c.label) : 'ไม่มีข้อมูล'}</p>
      </div>
      <span class="shrink-0 px-2 py-0.5 rounded-lg text-[11px] font-semibold ${style.chip}">
        ${ACTION_LABEL[road.advice.action]}
      </span>
    </div>
    ${reading}
    ${directionChips(road.directions)}
    <div class="rounded-xl border p-3 ${style.box}">
      <p class="text-xs font-semibold leading-snug">${escapeHtml(road.advice.headline)}</p>
      <p class="text-[11px] mt-1.5 leading-relaxed text-slate-600 dark:text-slate-300">${escapeHtml(road.advice.detail)}</p>
    </div>
  </article>`;
}

function renderAdvice(data) {
  const list = el('advice-list');
  const empty = el('advice-empty');
  const roads = data.roads || [];

  list.innerHTML = roads.map(adviceCard).join('');
  empty.classList.toggle('hidden', roads.length > 0);
  if (!roads.length) {
    empty.textContent = data.error ? 'อ่านข้อมูลจราจรไม่สำเร็จ: ' + data.error : 'ยังไม่มีข้อมูลจราจร';
  }

  const acting = roads.filter((r) => r.advice.action === 'meter' || r.advice.action === 'release').length;
  const summary = el('advice-summary');
  summary.textContent = acting
    ? `${acting} จาก ${roads.length} ถนนควรปรับการปล่อยรถ`
    : `ทั้ง ${roads.length} ถนนยังไม่ต้องปรับอะไร`;
  const stamp = el('advice-updated');
  if (stamp) stamp.textContent = 'อัปเดต ' + new Date(data.updatedAt).toLocaleTimeString('th-TH');
}

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
          label: road.congestion.label,
          action: road.advice ? road.advice.action : null
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

async function loadAdvice() {
  const summary = el('advice-summary');
  try {
    const res = await fetch('/api/traffic-advice');
    const data = await res.json();
    parseTrafficCongestion(data);
    renderAdvice(data);
  } catch (err) {
    if (summary) summary.textContent = 'อ่านข้อมูลจราจรไม่สำเร็จ';
  }
}

// --- Views -----------------------------------------------------------------

function switchView(view) {
  state.view = view;
  el('view-cams').classList.toggle('hidden', view !== 'cams');
  el('view-map').classList.toggle('hidden', view !== 'map');
  el('view-advice').classList.toggle('hidden', view !== 'advice');

  // Sync sidebar tabs & mobile tabs
  document.querySelectorAll('[data-view-target]').forEach(btn => {
    const active = btn.dataset.viewTarget === view;
    btn.classList.toggle('is-active', active);
    if (btn.classList.contains('mobile-tab')) {
      btn.classList.toggle('text-rose-600', active);
      btn.classList.toggle('dark:text-rose-400', active);
      btn.classList.toggle('text-slate-500', !active);
      btn.classList.toggle('dark:text-slate-400', !active);
    }
  });

  document.body.classList.toggle('hide-toolbar', view !== 'cams');

  if (view === 'map') {
    buildMap();
    setTimeout(() => state.map && state.map.resize(), 60);
    if (state.map && state.map.isStyleLoaded()) addCameraMarkers();
    loadTrafficIndex();
  } else if (view === 'advice') {
    loadAdvice();
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
  html = html.replace(/^### (.*$)/gim, '<h4 class="font-bold text-slate-900 dark:text-white mt-2 mb-1 text-xs">$1</h4>');
  html = html.replace(/^## (.*$)/gim, '<h3 class="font-bold text-slate-900 dark:text-white mt-2.5 mb-1 text-sm">$1</h3>');

  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-slate-900 dark:text-white">$1</strong>');

  // Italic
  html = html.replace(/\*(.*?)\*/g, '<em class="italic text-slate-500 dark:text-slate-400">$1</em>');

  // Blockquotes
  html = html.replace(/^&gt; (.*$)/gim, '<div class="pl-2.5 py-1 my-1 border-l-2 border-purple-500 bg-purple-500/10 rounded-r text-[11px] text-slate-700 dark:text-slate-300">$1</div>');

  // Camera links: [text](cam:ID) -> clickable button
  html = html.replace(/\[(.*?)\]\(cam:([A-Za-z0-9_-]+)\)/g, '<a href="cam:$2" class="chat-cam-link" data-open-cam="$2">$1</a>');

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
        updateChatModeBadge('Gemini Flash', 'bg-gradient-to-r from-purple-500 to-pink-500 text-white');
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
    updateChatModeBadge('Gemini Flash', 'bg-gradient-to-r from-purple-500 to-pink-500 text-white');
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
        updateChatModeBadge('Gemini Flash', 'bg-gradient-to-r from-purple-500 to-pink-500 text-white');
      } else {
        updateChatModeBadge('Built-in AI', 'bg-purple-500/15 text-purple-600 dark:text-purple-300');
      }
      if (settingsPanel) settingsPanel.classList.add('hidden');
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  showBuild();
  startClock();
  setGridLayout(state.gridCols);
  updateWatchlistBadges();
  loadCameras();
  loadAdvice();
  loadTrafficIndex();
  initChatbot();

  const btn = el('btn-refresh');
  if (btn) btn.addEventListener('click', () => { loadCameras(); loadAdvice(); loadTrafficIndex(); });
  const mBtn = el('mobile-btn-refresh');
  if (mBtn) mBtn.addEventListener('click', () => { loadCameras(); loadAdvice(); loadTrafficIndex(); });

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

  const adviceBtn = el('advice-refresh');
  if (adviceBtn) adviceBtn.addEventListener('click', loadAdvice);

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
  setInterval(() => { if (state.view === 'advice') loadAdvice(); }, ADVICE_REFRESH_MS);

  el('detail-close').addEventListener('click', closeDetail);
  el('detail').addEventListener('click', (e) => { if (e.target.id === 'detail') closeDetail(); });
  el('detail-tab-det').addEventListener('click', () => setDetailMode('det'));
  el('detail-tab-live').addEventListener('click', () => setDetailMode('live'));
  const detailPip = el('detail-pip-btn');
  if (detailPip) detailPip.addEventListener('click', () => togglePiP(el('detail-video')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.detail) closeDetail(); });

  const overlayBtn = el('btn-overlay');
  if (overlayBtn) {
    const paint = () => {
      overlayBtn.textContent = state.showOverlay ? 'ซ่อนกรอบ AI' : 'แสดงกรอบ AI';
      overlayBtn.classList.toggle('is-on', state.showOverlay);
    };
    paint();
    overlayBtn.addEventListener('click', () => {
      state.showOverlay = !state.showOverlay;
      localStorage.setItem('showOverlay', state.showOverlay ? '1' : '0');
      paint();
      redrawAllBoxes();
    });
  }
  window.addEventListener('resize', () => redrawAllBoxes());
  document.addEventListener('fullscreenchange', () => setTimeout(redrawAllBoxes, 200));
  document.addEventListener('webkitfullscreenchange', () => setTimeout(redrawAllBoxes, 200));

  loadDetections();
  setInterval(() => {
    if (state.view !== 'cams') return;
    loadDetections();
  }, 20000);

  loadRecordings();
  setInterval(() => {
    if (state.view === 'cams') loadRecordings();
  }, 30000);
});
