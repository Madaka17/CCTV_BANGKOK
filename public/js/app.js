/**
 * Bangkok traffic live video.
 *
 * The cameras publish H.264 over HLS with open CORS and no session, so the
 * browser plays them straight from the source. The server only hands over the
 * list of which cameras are up.
 */

const state = {
  cameras: [],
  players: new Map() // camera id -> Hls instance
};

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
    render();
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

function attachPlayer(cam) {
  const video = el('v-' + cssId(cam.id));
  const msg = el('m-' + cssId(cam.id));
  if (!video) return;

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
      state.players.delete(cam.id);
    }
  });

  state.players.set(cam.id, hls);
}

function stopAllPlayers() {
  for (const hls of state.players.values()) {
    try { hls.destroy(); } catch (e) { /* already gone */ }
  }
  state.players.clear();
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
});
