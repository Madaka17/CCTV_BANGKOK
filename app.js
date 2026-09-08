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
  showBoxes: false,
  showOverlay: localStorage.getItem('showOverlay') !== '0',
  // Measured against these servers: eight parallel fetches shared 2.5 Mbps in
  // total, while the streams themselves run 0.3-6.8 Mbps each. Playing all
  // nineteen at once cannot work, so only a few run at a time.
  maxPlaying: Number(localStorage.getItem('maxPlaying') || 3),
  playing: [],        // camera ids, oldest first
  observer: null,
  detail: null,       // camera open in the detail view
  detailMode: 'det',  // 'det' | 'live'
  detailTimer: null,
  focusId: null,      // camera the detector is working on continuously
  focusTimer: null,
  focusFps: 0,
  map: null,
  markers: []
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
  stopAllPlayers();

  const grid = el('camera-grid');

  if (!state.cameras.length) {
    grid.innerHTML = '';
    updateCameraCount(0);
    setEmptyMessage('ยังไม่มีกล้องที่พร้อมใช้งาน');
    return;
  }

  grid.innerHTML = state.cameras.map(cam => `
    <div data-cam-id="${escapeHtml(cam.id)}"
         data-search="${escapeHtml(((cam.title || '') + ' ' + (cam.org || '') + ' ' + cam.id).toLowerCase())}"
         data-org="${escapeHtml(cam.org || '')}"
         class="camera-card rounded-2xl overflow-hidden flex flex-col">
      <div class="relative bg-black aspect-video flex items-center justify-center">
        <!-- Absolute, like the overlays below it: as a flow child a tall frame
             stretches past the 16:9 box and the grid row goes ragged. -->
        <video id="v-${cssId(cam.id)}" class="absolute inset-0 w-full h-full object-contain" muted playsinline
               poster="${cam.image || ''}"></video>

        <button data-play="${cssId(cam.id)}" data-cam="${escapeHtml(cam.id)}"
                class="absolute inset-0 flex items-center justify-center bg-black/45 hover:bg-black/30 transition-colors cursor-pointer">
          <span class="w-12 h-12 rounded-full bg-white/90 flex items-center justify-center shadow-lg">
            <svg class="w-6 h-6 text-slate-900 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </span>
        </button>

        <span id="live-${cssId(cam.id)}" class="hidden absolute top-2.5 left-2.5 px-2 py-0.5 text-[10px] font-bold bg-rose-600 text-white rounded shadow items-center space-x-1">
          <span class="w-1.5 h-1.5 rounded-full bg-white animate-ping"></span><span>LIVE</span>
        </span>

        <button data-fullscreen="${cssId(cam.id)}" data-cam="${escapeHtml(cam.id)}"
                class="absolute top-2.5 right-2.5 p-1.5 bg-black/60 hover:bg-black/80 text-white rounded-lg cursor-pointer"
                title="เต็มจอ">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-5v4m0-4h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" /></svg>
        </button>

        <div id="o-${cssId(cam.id)}" class="absolute inset-0 pointer-events-none"></div>
        <img id="b-${cssId(cam.id)}" class="absolute inset-0 w-full h-full object-contain hidden" alt="" />
        <div id="m-${cssId(cam.id)}" class="absolute inset-0 flex items-center justify-center text-xs text-slate-400 pointer-events-none"></div>
      </div>

      <div class="p-3 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors" data-detail="${escapeHtml(cam.id)}">
        <h2 class="text-sm font-semibold leading-snug">${escapeHtml(cam.title)}</h2>
        <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-1">${escapeHtml(cam.org)}</p>
        <p id="c-${cssId(cam.id)}" class="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium"></p>
        <span class="inline-flex items-center gap-1 mt-2 text-[11px] font-semibold text-rose-600 dark:text-rose-400">
          รายละเอียด
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
        </span>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('[data-play]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cam = state.cameras.find(c => c.id === btn.dataset.cam);
      if (cam) playCamera(cam);
    });
  });

  grid.querySelectorAll('[data-detail]').forEach(node => {
    node.addEventListener('click', () => {
      const cam = state.cameras.find(c => c.id === node.dataset.detail);
      if (cam) openDetail(cam);
    });
  });

  applyFilter();
  paintCardCounts();
  watchVisibility();

  grid.querySelectorAll('[data-fullscreen]').forEach(btn => {
    btn.addEventListener('click', () => {
      const video = el('v-' + btn.dataset.fullscreen);
      const cam = state.cameras.find(c => c.id === btn.dataset.cam);
      if (!video || !cam) return;

      // Going fullscreen on a card that was not playing used to enlarge its
      // poster: a still picture, no stream, nothing focused, and so no boxes.
      if (!state.playing.includes(cam.id)) playCamera(cam);

      // Fullscreen the wrapper, not the video: a bare video element drops the
      // box overlay, which is the thing worth seeing up close
      const wrap = video.parentElement;
      if (wrap && wrap.requestFullscreen) wrap.requestFullscreen().then(() => setTimeout(redrawAllBoxes, 300));
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iOS Safari
    });
  });
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

// Only a few streams can run at once, so starting one may stop the oldest.
function playCamera(cam) {
  if (state.playing.includes(cam.id)) return;

  while (state.playing.length >= state.maxPlaying) {
    stopCamera(state.playing[0]);
  }

  const overlay = document.querySelector(`[data-play="${cssId(cam.id)}"]`);
  if (overlay) overlay.classList.add('hidden');
  const live = el('live-' + cssId(cam.id));
  if (live) { live.classList.remove('hidden'); live.classList.add('flex'); }

  state.playing.push(cam.id);
  attachPlayer(cam);
  updatePlayingBadge();
  refreshFocusTarget();
}

function stopCamera(id) {
  const hls = state.players.get(id);
  if (hls) { try { hls.destroy(); } catch (e) {} state.players.delete(id); }

  const video = el('v-' + cssId(id));
  if (video) { try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {} }

  const overlay = document.querySelector(`[data-play="${cssId(id)}"]`);
  if (overlay) overlay.classList.remove('hidden');
  const live = el('live-' + cssId(id));
  if (live) { live.classList.add('hidden'); live.classList.remove('flex'); }
  const msg = el('m-' + cssId(id));
  if (msg) msg.textContent = '';

  state.playing = state.playing.filter(x => x !== id);
  updatePlayingBadge();
  refreshFocusTarget();
}

// --- Search and filter -----------------------------------------------------

// Filtering hides cards instead of re-rendering the grid: a re-render tears
// down every player, so a stream would die on each keystroke. The visibility
// observer already stops a camera once its card is display:none, so hiding
// also releases the connection for free.
function applyFilter() {
  const term = (el('search')?.value || '').trim().toLowerCase();
  const org = el('org-filter')?.value || '';
  const clear = el('search-clear');
  if (clear) clear.classList.toggle('hidden', !term);

  let shown = 0;
  document.querySelectorAll('#camera-grid [data-cam-id]').forEach(card => {
    const hit = (!term || card.dataset.search.includes(term)) &&
                (!org || card.dataset.org === org);
    card.classList.toggle('hidden', !hit);
    if (hit) shown++;
  });

  updateCameraCount(shown);
  setEmptyMessage(shown ? '' : 'ไม่พบกล้องที่ตรงกับคำค้น');
}

function updateCameraCount(shown) {
  const count = el('camera-count');
  if (!count) return;
  const total = state.cameras.length;
  count.textContent = shown === total ? `${total} กล้อง` : `${shown} จาก ${total} กล้อง`;
}

function setEmptyMessage(text) {
  const box = el('grid-empty');
  if (!box) return;
  box.textContent = text;
  box.classList.toggle('hidden', !text);
}

function updatePlayingBadge() {
  const b = el('playing-count');
  if (b) b.textContent = `เล่นอยู่ ${state.playing.length}/${state.maxPlaying}`;
}

// Start cameras as they scroll into view, and stop them when they leave, so
// the few streams the connection can carry are the ones being looked at.
function watchVisibility() {
  if (state.observer) state.observer.disconnect();

  state.observer = new IntersectionObserver((entries) => {
    if (state.view !== 'cams' || state.showBoxes) return;

    entries.forEach(entry => {
      const id = entry.target.dataset.camId;
      const cam = state.cameras.find(c => c.id === id);
      if (!cam) return;

      if (entry.isIntersecting) {
        if (state.playing.length < state.maxPlaying) playCamera(cam);
      } else if (state.playing.includes(id)) {
        stopCamera(id);
      }
    });
  }, { threshold: 0.35 });

  document.querySelectorAll('[data-cam-id]').forEach(node => state.observer.observe(node));
}

function stopAllPlayers() {
  for (const hls of state.players.values()) {
    try { hls.destroy(); } catch (e) { /* already gone */ }
  }
  state.players.clear();
  state.playing.slice().forEach(stopCamera);
  setFocus(null);
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

    state.detections = new Map(list.map(d => [d.id, d]));
    const on = list.length > 0;

    const toggle = el('btn-boxes');
    if (toggle) toggle.classList.toggle('hidden', !on);

    const badge = el('vehicle-total');
    if (badge) {
      const seen = list.filter(d => d.total !== null);
      const total = seen.reduce((n, d) => n + d.total, 0);
      badge.classList.toggle('hidden', !on);
      badge.textContent = on ? `รถ ${total} คัน จาก ${seen.length} กล้อง` : '';
    }

    if (state.detail) renderDetailCounts(state.detail, state.detections.get(state.detail.id));
    redrawAllBoxes();

    paintCardCounts();
  } catch (err) {
    /* detector off; leave the page as it is */
  }
}

const LABELS = { car: 'รถยนต์', motorcycle: 'จยย.', bus: 'รถโดยสาร', truck: 'บรรทุก' };

// Reads from the stored readings rather than from one response, so a fresh
// grid can be filled in too. The catalogue and the detections are fetched at
// the same moment: when the detections landed first, render() wiped these
// lines and a new visitor saw no counts until the next poll, twenty seconds on.
function paintCardCounts() {
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

// Swap each player for the detector's annotated still, and back
function toggleBoxes() {
  state.showBoxes = !state.showBoxes;
  const btn = el('btn-boxes');
  if (btn) {
    btn.textContent = state.showBoxes ? 'ดูวิดีโอสด' : 'แสดงกรอบรถ';
    btn.classList.toggle('is-on', state.showBoxes);
  }

  state.cameras.forEach(cam => {
    const img = el('b-' + cssId(cam.id));
    const vid = el('v-' + cssId(cam.id));
    if (img) img.classList.toggle('hidden', !state.showBoxes);
    if (vid) vid.classList.toggle('hidden', state.showBoxes);
  });

  if (state.showBoxes) {
    stopAllPlayers();
    refreshBoxImages();
  } else {
    watchVisibility();
  }
}

function refreshBoxImages() {
  if (!state.showBoxes) return;
  state.cameras.forEach(cam => {
    const img = el('b-' + cssId(cam.id));
    if (img) img.src = `/api/detect-frame/${encodeURIComponent(cam.id)}?t=${Date.now()}`;
  });
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
    // Detection follows whichever camera is playing, so a card that has none
    // should say so rather than look broken
    const waiting = state.focusId === camId;
    overlay.innerHTML = state.playing.includes(camId)
      ? `<div style="position:absolute;bottom:8px;left:8px;padding:2px 8px;border-radius:8px;background:rgba(0,0,0,.7);color:#94a3b8;font-size:10px">
           ${waiting ? 'กำลังเริ่มตรวจจับ...' : 'ยังไม่ได้ตรวจจับกล้องนี้'}
         </div>`
      : '';
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

function redrawAllBoxes() {
  state.playing.forEach(id => {
    drawBoxes(id, el('o-' + cssId(id)), el('v-' + cssId(id)));
  });
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

// Whatever the viewer is actually looking at: the open camera, else the first
// one playing in the grid.
function refreshFocusTarget() {
  if (state.detail) { setFocus(state.detail.id); return; }
  if (state.view === 'cams' && !state.showBoxes && state.playing.length) {
    setFocus(state.playing[state.playing.length - 1]);
    return;
  }
  setFocus(null);
}

// --- Camera detail ---------------------------------------------------------
//
// Opens on the detector's annotated frame, since that is what the counts are
// read off, with the live stream a tab away. Only one stream runs here, and
// the grid's players are stopped while it is open.

function openDetail(cam) {
  state.detail = cam;
  state.detailMode = 'det';
  stopAllPlayers();

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
  if (state.view === 'cams') watchVisibility();
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

  const chip = (label, value, tone) =>
    `<span class="px-3 py-1.5 rounded-xl ${tone} text-xs font-semibold">${label} <span class="font-bold">${value}</span></span>`;

  box.innerHTML =
    chip('รวม', reading.total + ' คัน', 'bg-sky-500/15 border border-sky-500/30 text-sky-300') +
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
    const pin = document.createElement('div');
    pin.className = 'cursor-pointer';
    pin.innerHTML = `
      <div class="w-6 h-6 rounded-full bg-rose-600 border-2 border-white shadow-lg flex items-center justify-center">
        <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
      </div>`;

    const popup = new maplibregl.Popup({ offset: 16, maxWidth: '340px' })
      .setHTML(`
        <div class="text-slate-900">
          <p class="font-semibold text-sm mb-1">${escapeHtml(cam.title)}</p>
          <video id="pv-${cssId(cam.id)}" class="w-full rounded" muted playsinline autoplay controls></video>
        </div>`);

    const marker = new maplibregl.Marker({ element: pin })
      .setLngLat([cam.lng, cam.lat])
      .setPopup(popup)
      .addTo(state.map);

    // Only start a stream when someone actually opens the popup
    popup.on('open', () => attachPlayer(cam, 'pv-'));
    popup.on('close', () => {
      const hls = state.players.get('popup:' + cam.id);
      if (hls) { try { hls.destroy(); } catch (e) {} state.players.delete('popup:' + cam.id); }
    });

    state.markers.push(marker);
  });
}

async function loadTrafficIndex() {
  const box = el('traffic-index');
  const stamp = el('traffic-updated');
  if (!box) return;
  try {
    const r = await fetch('/api/traffic-index');
    const d = await r.json();
    const i = Number(d.index);
    const label = i < 4 ? 'คล่องตัว' : i < 7 ? 'ชะลอตัว' : 'ติดขัด';
    box.textContent = `ดัชนีจราจร ${i.toFixed(1)} · ${label}`;
    if (stamp) stamp.textContent = 'อัปเดต ' + new Date().toLocaleTimeString('th-TH');
  } catch (err) {
    box.textContent = 'ดัชนีจราจร: ไม่พร้อมใช้งาน';
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

async function loadAdvice() {
  const summary = el('advice-summary');
  try {
    const res = await fetch('/api/traffic-advice');
    renderAdvice(await res.json());
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

  el('tab-cams').classList.toggle('is-active', view === 'cams');
  el('tab-map').classList.toggle('is-active', view === 'map');
  el('tab-advice').classList.toggle('is-active', view === 'advice');
  // The search box and the play controls have nothing to act on outside the grid
  document.body.classList.toggle('hide-toolbar', view !== 'cams');

  if (view === 'map') {
    // 19 grid players would keep streaming behind the map
    stopAllPlayers();
    buildMap();
    setTimeout(() => state.map && state.map.resize(), 60);
    if (state.map && state.map.isStyleLoaded()) addCameraMarkers();
    loadTrafficIndex();
  } else if (view === 'advice') {
    stopAllPlayers();
    loadAdvice();
  } else {
    watchVisibility();
  }
}

// --- Boot ------------------------------------------------------------------

function startClock() {
  const tick = () => {
    const c = el('clock');
    if (c) c.textContent = new Date().toLocaleTimeString('th-TH');
  };
  tick();
  setInterval(tick, 1000);
}

// Players hold open connections; a hidden tab does not need them
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAllPlayers();
  else if (state.cameras.length) watchVisibility();
});

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

document.addEventListener('DOMContentLoaded', () => {
  showBuild();
  startClock();
  loadCameras();
  const btn = el('btn-refresh');
  if (btn) btn.addEventListener('click', loadCameras);
  el('tab-cams').addEventListener('click', () => switchView('cams'));
  el('tab-map').addEventListener('click', () => switchView('map'));
  el('tab-advice').addEventListener('click', () => switchView('advice'));
  el('tab-cams').classList.add('is-active');
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

  const theme = el('btn-theme');
  if (theme) theme.addEventListener('click', () => {
    // The inline script in <head> put the class there; this only flips it
    const dark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  });
  setInterval(() => { if (state.view === 'map') loadTrafficIndex(); }, 60000);
  setInterval(() => { if (state.view === 'advice') loadAdvice(); }, ADVICE_REFRESH_MS);

  el('detail-close').addEventListener('click', closeDetail);
  el('detail').addEventListener('click', (e) => { if (e.target.id === 'detail') closeDetail(); });
  el('detail-tab-det').addEventListener('click', () => setDetailMode('det'));
  el('detail-tab-live').addEventListener('click', () => setDetailMode('live'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.detail) closeDetail(); });

  const sel = el('max-playing');
  if (sel) {
    sel.value = String(state.maxPlaying);
    sel.addEventListener('change', () => {
      state.maxPlaying = Number(sel.value);
      localStorage.setItem('maxPlaying', sel.value);
      while (state.playing.length > state.maxPlaying) stopCamera(state.playing[0]);
      updatePlayingBadge();
      watchVisibility();
    });
  }
  updatePlayingBadge();

  const overlayBtn = el('btn-overlay');
  if (overlayBtn) {
    const paint = () => {
      overlayBtn.textContent = state.showOverlay ? 'ซ่อนกรอบ' : 'แสดงกรอบ';
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
  // Entering or leaving fullscreen changes the picture's rect, and Safari does
  // not always fire resize for it
  document.addEventListener('fullscreenchange', () => setTimeout(redrawAllBoxes, 200));
  document.addEventListener('webkitfullscreenchange', () => setTimeout(redrawAllBoxes, 200));

  const boxes = el('btn-boxes');
  if (boxes) boxes.addEventListener('click', toggleBoxes);
  loadDetections();
  setInterval(() => {
    if (state.view !== 'cams') return;
    loadDetections();
    refreshBoxImages();
  }, 20000);
});
