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
  grid.innerHTML = `<div class="col-span-full py-20 text-center text-slate-400 text-sm">กำลังโหลดกล้อง...</div>`;

  try {
    const res = await fetch('/api/video-cameras');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.cameras = data.cameras || [];
    if (state.view === 'map') { addCameraMarkers(); } else { render(); }
  } catch (err) {
    grid.innerHTML = `
      <div class="col-span-full py-20 text-center text-slate-400 text-sm">
        โหลดรายการกล้องไม่สำเร็จ (${err.message})
      </div>`;
  }
}

// --- Rendering -------------------------------------------------------------

function render() {
  stopAllPlayers();

  const grid = el('camera-grid');
  const count = el('camera-count');
  if (count) count.textContent = `${state.cameras.length} กล้อง`;

  if (!state.cameras.length) {
    grid.innerHTML = `<div class="col-span-full py-20 text-center text-slate-400 text-sm">ยังไม่มีกล้องที่พร้อมใช้งาน</div>`;
    return;
  }

  grid.innerHTML = state.cameras.map(cam => `
    <div class="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl flex flex-col">
      <div class="relative bg-black aspect-video flex items-center justify-center">
        <video id="v-${cssId(cam.id)}" class="w-full h-full object-contain" muted playsinline autoplay
               poster="${cam.image || ''}"></video>

        <span class="absolute top-2.5 left-2.5 px-2 py-0.5 text-[10px] font-bold bg-rose-600 text-white rounded shadow flex items-center space-x-1">
          <span class="w-1.5 h-1.5 rounded-full bg-white animate-ping"></span><span>LIVE</span>
        </span>

        <button data-fullscreen="${cssId(cam.id)}"
                class="absolute top-2.5 right-2.5 p-1.5 bg-black/60 hover:bg-black/80 text-white rounded-lg cursor-pointer"
                title="เต็มจอ">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-5v4m0-4h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" /></svg>
        </button>

        <div id="m-${cssId(cam.id)}" class="absolute inset-0 flex items-center justify-center text-xs text-slate-400 pointer-events-none"></div>
      </div>

      <div class="p-3">
        <h2 class="text-sm font-semibold text-white leading-snug">${escapeHtml(cam.title)}</h2>
        <p class="text-[11px] text-slate-500 mt-1">${escapeHtml(cam.org)}</p>
      </div>
    </div>
  `).join('');

  state.cameras.forEach(attachPlayer);

  grid.querySelectorAll('[data-fullscreen]').forEach(btn => {
    btn.addEventListener('click', () => {
      const video = el('v-' + btn.dataset.fullscreen);
      if (!video) return;
      if (video.requestFullscreen) video.requestFullscreen();
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
  video.addEventListener('playing', () => say(''));

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

  const hls = new window.Hls({ liveDurationInfinity: true, lowLatencyMode: true });
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

function stopAllPlayers() {
  for (const hls of state.players.values()) {
    try { hls.destroy(); } catch (e) { /* already gone */ }
  }
  state.players.clear();
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

// --- Views -----------------------------------------------------------------

function switchView(view) {
  state.view = view;
  el('view-cams').classList.toggle('hidden', view !== 'cams');
  el('view-map').classList.toggle('hidden', view !== 'map');

  const active = 'view-tab px-3 py-1.5 rounded-xl text-xs sm:text-sm font-semibold transition-all flex items-center space-x-1.5 text-white bg-rose-600 shadow-md shadow-rose-600/30 cursor-pointer';
  const idle = 'view-tab px-3 py-1.5 rounded-xl text-xs sm:text-sm font-semibold transition-all flex items-center space-x-1.5 text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer';
  el('tab-cams').className = view === 'cams' ? active : idle;
  el('tab-map').className = view === 'map' ? active : idle;

  if (view === 'map') {
    // 19 grid players would keep streaming behind the map
    stopAllPlayers();
    buildMap();
    setTimeout(() => state.map && state.map.resize(), 60);
    if (state.map && state.map.isStyleLoaded()) addCameraMarkers();
    loadTrafficIndex();
  } else {
    state.cameras.forEach(cam => attachPlayer(cam));
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
  else if (state.cameras.length) state.cameras.forEach(attachPlayer);
});

document.addEventListener('DOMContentLoaded', () => {
  startClock();
  loadCameras();
  const btn = el('btn-refresh');
  if (btn) btn.addEventListener('click', loadCameras);
  el('tab-cams').addEventListener('click', () => switchView('cams'));
  el('tab-map').addEventListener('click', () => switchView('map'));
  setInterval(() => { if (state.view === 'map') loadTrafficIndex(); }, 60000);
});
