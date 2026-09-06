/**
 * BMA Traffic CCTV Live Dashboard - Frontend Application
 * Ultra-Smooth 60 FPS Canvas Motion Interpolation & 100% Offline Bangkok Map
 */

// Application State
const state = {
  cameras: [],
  districts: [],
  trafficSummary: null,
  filtered: [],
  currentDistrict: 'all',
  currentTrafficFilter: 'all', // 'all' | 'flowing' | 'moderate' | 'congested'
  searchQuery: '',
  currentSort: 'name',
  currentPage: 1,
  pageSize: 24,
  currentView: 'grid', // 'grid' | 'map' | 'wall' | 'api'
  wallCameras: ['603', '1338', '915', '908'],
  wallLayout: '2x2',
  liveAll: true,
  smoothMotion: true,
  liveIntervalMs: 1200,
  visibleCameras: new Set(),
  activeModalCam: null,

  // 100% Offline Map State
  map: null,
  markersMap: new Map(),
  currentMapStyle: 'dark', // 'dark' | 'streets'
  is3dMode: false,

  // 60 FPS HTML5 Canvas Motion Interpolation Engine State
  modalCanvas: null,
  modalCtx: null,
  modalRafId: null,
  modalPrevImg: null,
  modalNextImg: null,
  modalTransitionStart: 0,
  modalTransitionDuration: 750,
  modalPlaybackSpeed: 1.6,
  modalIsPaused: false,
  modalFetchTimer: null,
  modalFpsFrames: 0,
  modalFpsLastTime: 0,

  observer: null,
  liveLoopTimer: null
};

// Safe DOM Helper
const getEl = id => document.getElementById(id);

// DOM Elements
const elements = {
  districtSelect: getEl('district-select'),
  searchInput: getEl('search-input'),
  clearSearch: getEl('clear-search'),
  sortSelect: getEl('sort-select'),
  filteredCount: getEl('filtered-count'),
  activeLiveCount: getEl('active-live-count'),
  btnToggleLiveAll: getEl('btn-toggle-live-all'),
  liveAllText: getEl('live-all-text'),
  btnToggleSmooth: getEl('btn-toggle-smooth'),
  camerasGrid: getEl('cameras-grid'),
  pageStart: getEl('page-start'),
  pageEnd: getEl('page-end'),
  pageTotal: getEl('page-total'),
  btnPrevPage: getEl('btn-prev-page'),
  btnNextPage: getEl('btn-next-page'),
  pageNumbers: getEl('page-numbers'),
  pageSizeSelect: getEl('page-size-select'),
  viewGrid: getEl('view-grid'),
  viewMap: getEl('view-map'),
  viewWall: getEl('view-wall'),
  viewApi: getEl('view-api'),
  tabGrid: getEl('tab-grid'),
  tabMap: getEl('tab-map'),
  tabWall: getEl('tab-wall'),
  tabApi: getEl('tab-api'),
  wallGrid: getEl('wall-grid'),
  wallCountBadge: getEl('wall-count-badge'),
  wall2x2Btn: getEl('wall-grid-2x2'),
  wall3x3Btn: getEl('wall-grid-3x3'),
  btnClearWall: getEl('btn-clear-wall'),

  // Offline Map Elements
  btnResetMap: getEl('btn-reset-map'),
  btnToggle3d: getEl('btn-toggle-3d'),
  mapCamerasCount: getEl('map-cameras-count'),
  mapContainer: getEl('map'),

  // Traffic Filter Buttons & Stats
  filterTrafficAll: getEl('filter-traffic-all'),
  filterTrafficFlowing: getEl('filter-traffic-flowing'),
  filterTrafficModerate: getEl('filter-traffic-moderate'),
  filterTrafficCongested: getEl('filter-traffic-congested'),
  statFlowingCount: getEl('stat-flowing-count'),
  statFlowingPct: getEl('stat-flowing-pct'),
  statModerateCount: getEl('stat-moderate-count'),
  statModeratePct: getEl('stat-moderate-pct'),
  statCongestedCount: getEl('stat-congested-count'),
  statCongestedPct: getEl('stat-congested-pct'),
  barFlowing: getEl('bar-flowing'),
  barModerate: getEl('bar-moderate'),
  barCongested: getEl('bar-congested'),

  // Modal Elements
  playerModal: getEl('player-modal'),
  modalClose: getEl('modal-close'),
  modalCameraId: getEl('modal-camera-id'),
  modalCameraName: getEl('modal-camera-name'),
  modalCameraDistrict: getEl('modal-camera-district'),
  modalTrafficDot: getEl('modal-traffic-dot'),
  modalTrafficBadge: getEl('modal-traffic-badge'),
  modalCanvas: getEl('modal-canvas'),
  modalSpinner: getEl('modal-spinner'),
  modalFpsBadge: getEl('modal-fps-badge'),
  modalTimestamp: getEl('modal-timestamp'),
  modalTrafficStatusText: getEl('modal-traffic-status-text'),
  modalTrafficTrendBadge: getEl('modal-traffic-trend-badge'),
  modalTrafficDensityText: getEl('modal-traffic-density-text'),
  modalTrafficDensityBar: getEl('modal-traffic-density-bar'),
  modalTrafficSpeed: getEl('modal-traffic-speed'),
  modalTrafficHistoryContainer: getEl('modal-traffic-history-container'),
  modalTrafficUpdatedAt: getEl('modal-traffic-updated-at'),
  modalCvEdge: getEl('modal-cv-edge'),
  modalCvMotion: getEl('modal-cv-motion'),
  modalCvSpeed: getEl('modal-cv-speed'),
  statAvgDensityVal: getEl('stat-avg-density-val'),
  modalBtnToggle: getEl('modal-btn-toggle'),
  modalToggleText: getEl('modal-toggle-text'),
  modalBtnSnapshot: getEl('modal-btn-snapshot'),
  modalBtnPinWall: getEl('modal-btn-pin-wall'),
  modalGmapsLink: getEl('modal-gmaps-link'),
  modalCoords: getEl('modal-coords'),
  modalDirection: getEl('modal-direction'),
  toast: getEl('toast'),
  toastText: getEl('toast-text')
};

// Toast notification helper
function showToast(msg) {
  if (!elements.toast || !elements.toastText) return;
  elements.toastText.textContent = msg;
  elements.toast.classList.remove('translate-y-20', 'opacity-0', 'pointer-events-none');
  setTimeout(() => {
    elements.toast.classList.add('translate-y-20', 'opacity-0', 'pointer-events-none');
  }, 2500);
}

// Fetch Initial Data
async function initApp() {
  try {
    // 1. Fetch Districts
    const distRes = await fetch('/api/districts');
    const distData = await distRes.json();
    state.districts = distData.districts;
    renderDistrictOptions();

    // 2. Fetch Traffic Analysis Summary
    try {
      const trafficRes = await fetch('/api/traffic-analysis');
      const trafficJson = await trafficRes.json();
      if (trafficJson && trafficJson.summary) {
        state.trafficSummary = trafficJson.summary;
        updateTrafficSummaryUI(trafficJson.summary);
      }
    } catch (tErr) {
      console.warn('Could not load traffic summary:', tErr);
    }

    // 3. Fetch Cameras
    const camRes = await fetch('/api/cameras');
    const camData = await camRes.json();
    state.cameras = camData.cameras;

    initIntersectionObserver();
    applyFilters();
    initEventListeners();
    updateWallBadge();
    startLiveStreamingEngine();

    // Digital clock in modal
    setInterval(() => {
      const now = new Date();
      if (elements.modalTimestamp) {
        elements.modalTimestamp.textContent = now.toLocaleTimeString('th-TH');
      }
    }, 1000);

    // Live background polling for 5-minute rolling traffic metrics every 30s
    setInterval(async () => {
      try {
        const res = await fetch('/api/traffic-analysis');
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.summary) {
          state.trafficSummary = data.summary;
          updateTrafficSummaryUI(data.summary);
        }
        if (data && data.cameras) {
          state.cameras.forEach(cam => {
            if (data.cameras[cam.id]) {
              cam.traffic = data.cameras[cam.id];
            }
          });
          if (state.activeModalCam && data.cameras[state.activeModalCam.id]) {
            state.activeModalCam.traffic = data.cameras[state.activeModalCam.id];
            updateModalTrafficDisplay(state.activeModalCam.traffic);
          }
        }
      } catch (e) {}
    }, 30000);

  } catch (err) {
    console.error('Initialization error:', err);
    if (elements.filteredCount) elements.filteredCount.textContent = 'เชื่อมต่อเซิร์ฟเวอร์ล้มเหลว';
  }
}

// Update Top Traffic Summary Banner
function updateTrafficSummaryUI(summary) {
  if (!summary) return;
  if (elements.statFlowingCount) elements.statFlowingCount.textContent = summary.flowing;
  if (elements.statFlowingPct) elements.statFlowingPct.textContent = summary.flowing_pct + '%';
  if (elements.statModerateCount) elements.statModerateCount.textContent = summary.moderate;
  if (elements.statModeratePct) elements.statModeratePct.textContent = summary.moderate_pct + '%';
  if (elements.statCongestedCount) elements.statCongestedCount.textContent = summary.congested;
  if (elements.statCongestedPct) elements.statCongestedPct.textContent = summary.congested_pct + '%';

  if (elements.barFlowing) elements.barFlowing.style.width = summary.flowing_pct + '%';
  if (elements.barModerate) elements.barModerate.style.width = summary.moderate_pct + '%';
  if (elements.barCongested) elements.barCongested.style.width = summary.congested_pct + '%';

  const lblF = getEl('lbl-flowing-pct');
  if (lblF) lblF.textContent = Math.round(summary.flowing_pct) + '%';
  const lblM = getEl('lbl-moderate-pct');
  if (lblM) lblM.textContent = Math.round(summary.moderate_pct) + '%';
  const lblC = getEl('lbl-congested-pct');
  if (lblC) lblC.textContent = Math.round(summary.congested_pct) + '%';

  if (elements.statAvgDensityVal && summary.avg_density_bkk) {
    elements.statAvgDensityVal.textContent = summary.avg_density_bkk + '%';
  }
}

// Populate District dropdown
function renderDistrictOptions() {
  if (!elements.districtSelect) return;
  const optionsHtml = state.districts
    .filter(d => d.camera_count > 0)
    .map(d => '<option value="' + d.name_th + '">🏙️ เขต' + d.name_th + ' (' + d.camera_count + ' กล้อง)</option>')
    .join('');

  elements.districtSelect.innerHTML = `
    <option value="all">📍 ทุกเขตในกรุงเทพฯ (ทั้งหมด 611 กล้อง)</option>
    ${optionsHtml}
  `;
}

// Apply Filters & Search
function applyFilters() {
  let result = state.cameras;

  // Filter by District
  if (state.currentDistrict !== 'all') {
    result = result.filter(c => c.district_th === state.currentDistrict);
  }

  // Filter by Traffic Condition (flowing | moderate | congested)
  if (state.currentTrafficFilter !== 'all') {
    result = result.filter(c => c.traffic && c.traffic.status === state.currentTrafficFilter);
  }

  // Search Query
  if (state.searchQuery.trim()) {
    const q = state.searchQuery.toLowerCase().trim();
    result = result.filter(c => 
      c.id.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      (c.name_en && c.name_en.toLowerCase().includes(q)) ||
      (c.desc && c.desc.toLowerCase().includes(q)) ||
      (c.district_th && c.district_th.toLowerCase().includes(q)) ||
      (c.district_en && c.district_en.toLowerCase().includes(q))
    );
  }

  // Sort
  if (state.currentSort === 'name') {
    result.sort((a, b) => a.name.localeCompare(b.name, 'th'));
  } else if (state.currentSort === 'id') {
    result.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  } else if (state.currentSort === 'district') {
    result.sort((a, b) => a.district_th.localeCompare(b.district_th, 'th'));
  } else if (state.currentSort === 'traffic' || state.currentSort === 'density') {
    result.sort((a, b) => {
      const denA = a.traffic ? (a.traffic.density_5m_avg ?? a.traffic.density ?? 0) : 0;
      const denB = b.traffic ? (b.traffic.density_5m_avg ?? b.traffic.density ?? 0) : 0;
      return denB - denA;
    });
  } else if (state.currentSort === 'density_asc') {
    result.sort((a, b) => {
      const denA = a.traffic ? (a.traffic.density_5m_avg ?? a.traffic.density ?? 0) : 0;
      const denB = b.traffic ? (b.traffic.density_5m_avg ?? b.traffic.density ?? 0) : 0;
      return denA - denB;
    });
  }

  state.filtered = result;
  state.currentPage = 1;

  if (elements.filteredCount) elements.filteredCount.textContent = 'พบ ' + result.length + ' กล้อง';
  renderGrid();
  renderPagination();
  updateMapMarkers();
}

// Intersection Observer: Only poll active visible cards
function initIntersectionObserver() {
  if (state.observer) state.observer.disconnect();

  state.observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const cid = entry.target.dataset.camId;
      if (!cid) return;
      if (entry.isIntersecting) {
        state.visibleCameras.add(cid);
        refreshCameraFrame(cid);
      } else {
        state.visibleCameras.delete(cid);
      }
    });
    updateLiveCountBadge();
  }, {
    rootMargin: '250px 0px',
    threshold: 0.05
  });
}

function updateLiveCountBadge() {
  if (elements.activeLiveCount) {
    if (state.liveAll) {
      elements.activeLiveCount.innerHTML = `
        <span class="w-1.5 h-1.5 rounded-full bg-rose-400 animate-ping"></span>
        <span>กำลังสตรีมสด ${state.visibleCameras.size} กล้องพร้อมกัน</span>
      `;
      elements.activeLiveCount.classList.remove('opacity-50');
    } else {
      elements.activeLiveCount.innerHTML = `
        <span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
        <span>หยุดพักสตรีมสด</span>
      `;
      elements.activeLiveCount.classList.add('opacity-50');
    }
  }
}

// Live Streaming Engine for Grid Cards
function startLiveStreamingEngine() {
  if (state.liveLoopTimer) clearInterval(state.liveLoopTimer);

  state.liveLoopTimer = setInterval(() => {
    if (!state.liveAll || state.currentView !== 'grid') return;

    const visibleList = Array.from(state.visibleCameras);
    visibleList.forEach((cid, index) => {
      setTimeout(() => {
        if (state.visibleCameras.has(cid)) {
          refreshCameraFrame(cid);
        }
      }, (index * 45) % state.liveIntervalMs);
    });
  }, state.liveIntervalMs);
}

// Subtle cross-fade for grid cards
function refreshCameraFrame(cid) {
  const currentImg = document.getElementById('card-img-' + cid);
  if (!currentImg) return;

  const nextImg = new Image();
  const timestamp = Date.now();
  nextImg.onload = () => {
    if (nextImg.naturalWidth > 100) {
      if (state.smoothMotion) {
        currentImg.style.opacity = '0.94';
        setTimeout(() => {
          currentImg.src = nextImg.src;
          currentImg.style.opacity = '1';
        }, 50);
      } else {
        currentImg.src = nextImg.src;
      }
      const badge = document.getElementById('badge-live-' + cid);
      if (badge) badge.classList.remove('hidden');
    }
  };
  nextImg.src = '/api/snapshot/' + cid + '?t=' + timestamp;
}

// Render 6-bar mini sparkline for 5-minute density history
function renderMiniSparkline(history, currentDensity) {
  if (!history || !history.length) {
    const d = currentDensity || 30;
    const color = d >= 70 ? 'bg-rose-500' : (d >= 40 ? 'bg-amber-400' : 'bg-emerald-400');
    return `<div class="flex-1 ${color} rounded-sm opacity-80" style="height: ${Math.max(20, d)}%" title="ปัจจุบัน: ${d}%"></div>`;
  }

  return history.map(item => {
    const val = item.density;
    const color = val >= 70 ? 'bg-rose-500' : (val >= 40 ? 'bg-amber-400' : 'bg-emerald-400');
    const heightPct = Math.max(18, Math.min(100, val));
    const tip = `${item.label} (${item.time}): ${val}%`;
    return `<div class="flex-1 ${color} rounded-sm opacity-85 hover:opacity-100 transition-all cursor-pointer" style="height: ${heightPct}%" title="${tip}"></div>`;
  }).join('');
}

// Helper to get traffic badge markup (with 5-minute rolling average & trend)
function getTrafficBadgeHtml(traffic) {
  if (!traffic) return '';
  const status = traffic.status || 'flowing';
  const density = traffic.density_5m_avg ?? traffic.density ?? 30;
  const trend = traffic.trend_5m === 'increasing' ? '↗' : (traffic.trend_5m === 'decreasing' ? '↘' : '→');

  if (status === 'congested') {
    return `
      <span class="px-2 py-0.5 text-[10px] font-bold rounded-md bg-rose-500/20 text-rose-300 border border-rose-500/40 flex items-center space-x-1 backdrop-blur-sm shadow-sm" title="เฉลี่ย 5 นาที: ${density}% ${traffic.trend_th || ''}">
        <span class="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse"></span>
        <span>🔴 ติดขัด (${density}% ${trend})</span>
      </span>
    `;
  } else if (status === 'moderate') {
    return `
      <span class="px-2 py-0.5 text-[10px] font-bold rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center space-x-1 backdrop-blur-sm shadow-sm" title="เฉลี่ย 5 นาที: ${density}% ${traffic.trend_th || ''}">
        <span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
        <span>🟡 ชะลอตัว (${density}% ${trend})</span>
      </span>
    `;
  }
  return `
    <span class="px-2 py-0.5 text-[10px] font-bold rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center space-x-1 backdrop-blur-sm shadow-sm" title="เฉลี่ย 5 นาที: ${density}% ${traffic.trend_th || ''}">
      <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
      <span>🟢 คล่องตัว (${density}% ${trend})</span>
    </span>
  `;
}

// Render Camera Cards Grid
function renderGrid() {
  const { filtered, currentPage, pageSize } = state;
  const start = (currentPage - 1) * pageSize;
  const end = Math.min(start + pageSize, filtered.length);
  const pageItems = filtered.slice(start, end);

  if (state.observer) state.observer.disconnect();
  state.visibleCameras.clear();

  if (pageItems.length === 0) {
    if (elements.camerasGrid) {
      elements.camerasGrid.innerHTML = `
        <div class="col-span-full py-16 text-center text-slate-400 space-y-3">
          <svg class="w-12 h-12 mx-auto text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <p class="text-sm">ไม่พบกล้องวงจรปิดที่ตรงกับเงื่อนไขการค้นหาหรือตัวกรองจราจร</p>
          <button onclick="resetSearch()" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded-lg border border-slate-700 cursor-pointer">ล้างตัวกรองทั้งหมด</button>
        </div>
      `;
    }
    return;
  }

  if (elements.camerasGrid) {
    elements.camerasGrid.innerHTML = pageItems.map(cam => {
      const initialUrl = '/api/snapshot/' + cam.id + '?t=' + Date.now();
      const traffic = cam.traffic || { status: 'flowing', status_th: 'คล่องตัว', density: 30, speed_est: '50 กม./ชม.' };
      const densityColor = traffic.status === 'congested' ? 'bg-rose-500' : traffic.status === 'moderate' ? 'bg-amber-400' : 'bg-emerald-500';

      return `
        <div class="camera-card bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-lg flex flex-col group relative" data-cam-id="${cam.id}">
          
          <!-- Video / Image Preview Area -->
          <div class="relative bg-slate-950 aspect-video overflow-hidden flex items-center justify-center cursor-pointer" onclick="openModal('${cam.id}')">
            <img 
              id="card-img-${cam.id}" 
              src="${initialUrl}" 
              alt="${cam.name}" 
              loading="lazy" 
              class="w-full h-full object-cover smooth-stream-img transition-all duration-200 group-hover:scale-105"
              onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'400\' height=\'266\' viewBox=\'0 0 400 266\' fill=\'%230f172a\'><text x=\'50%25\' y=\'50%25\' dominant-baseline=\'middle\' text-anchor=\'middle\' fill=\'%2364748b\' font-size=\'14\' font-family=\'sans-serif\'>กำลังโหลดภาพสด...</text></svg>'"
            />

            <!-- Top Left: Live Badge & ID -->
            <div class="absolute top-2.5 left-2.5 flex items-center space-x-1.5">
              <span id="badge-live-${cam.id}" class="px-2 py-0.5 text-[10px] font-bold rounded-md border backdrop-blur-md bg-rose-600/90 text-white border-rose-400 flex items-center space-x-1">
                <span class="w-1.5 h-1.5 rounded-full bg-white animate-ping"></span>
                <span>LIVE</span>
              </span>
              <span class="px-1.5 py-0.5 text-[10px] font-mono bg-slate-900/80 text-slate-300 rounded border border-slate-700">#${cam.id}</span>
            </div>

            <!-- Top Right: Traffic Status Pill -->
            <div class="absolute top-2.5 right-2.5">
              ${getTrafficBadgeHtml(traffic)}
            </div>

            <!-- Quick Action Hover Overlay -->
            <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center space-x-2">
              <button 
                type="button" 
                onclick="event.stopPropagation(); openModal('${cam.id}')" 
                class="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold shadow-lg transition-transform hover:scale-105 flex items-center space-x-1.5 cursor-pointer" 
                title="ขยายดูภาพสดความลื่น 60 FPS"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <span>ขยายดูสด (60 FPS)</span>
              </button>
            </div>
          </div>

          <!-- Card Body -->
          <div class="p-4 flex-1 flex flex-col justify-between space-y-3">
            <div>
              <div class="flex items-start justify-between gap-2">
                <h4 class="text-sm font-bold text-white leading-snug line-clamp-2 hover:text-rose-400 cursor-pointer" onclick="openModal('${cam.id}')">${cam.name}</h4>
              </div>
              ${cam.desc ? `<p class="text-xs text-slate-400 mt-1 line-clamp-1 flex items-center space-x-1"><svg class="w-3 h-3 text-slate-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/></svg><span>${cam.desc}</span></p>` : ''}
            </div>

            <!-- 5-Minute Traffic Density & Mini Sparkline Indicator -->
            <div class="space-y-1.5 pt-1 bg-slate-950/40 p-2 rounded-xl border border-slate-800/60">
              <div class="flex items-center justify-between text-[11px] text-slate-400">
                <span class="flex items-center space-x-1">
                  <span class="text-slate-400 text-[10px]">ย้อนหลัง 5 นาที:</span>
                  <span class="font-bold text-slate-200">${traffic.density_5m_avg ?? traffic.density}%</span>
                  <span class="text-[10px] font-semibold text-slate-300 ml-0.5">${traffic.trend_5m === 'increasing' ? '↗' : (traffic.trend_5m === 'decreasing' ? '↘' : '→')}</span>
                </span>
                <span class="font-mono text-slate-300 text-[10px]">${traffic.speed_est}</span>
              </div>
              <div class="w-full h-3 rounded bg-slate-900/80 p-0.5 flex items-end gap-1 overflow-hidden" title="ไทม์ไลน์ความหนาแน่น 5 นาทีย้อนหลัง (-5m ถึง ตอนนี้)">
                ${renderMiniSparkline(traffic.history_5m, traffic.density)}
              </div>
            </div>

            <!-- Bottom Meta & Actions -->
            <div class="pt-2 border-t border-slate-800 flex items-center justify-between">
              <span class="px-2 py-0.5 text-[11px] font-medium bg-slate-800 text-slate-300 border border-slate-700/60 rounded-md">
                เขต${cam.district_th}
              </span>

              <div class="flex items-center space-x-1">
                <button 
                  type="button" 
                  onclick="locateOnMap('${cam.id}')" 
                  class="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors cursor-pointer" 
                  title="ดูพิกัดบนแผนที่"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" /></svg>
                </button>
                <button 
                  type="button" 
                  onclick="addToWall('${cam.id}')" 
                  class="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded transition-colors cursor-pointer" 
                  title="เพิ่มเข้า Multi-View Wall"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
                </button>
                <button 
                  type="button" 
                  onclick="copyStreamUrl('${cam.id}')" 
                  class="p-1.5 text-slate-400 hover:text-teal-400 hover:bg-slate-800 rounded transition-colors cursor-pointer" 
                  title="คัดลอก URL สตรีม"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                </button>
              </div>
            </div>

          </div>

        </div>
      `;
    }).join('');

    document.querySelectorAll('.camera-card').forEach(card => {
      state.observer.observe(card);
    });
  }
}

// Pagination Controls
function renderPagination() {
  const { filtered, currentPage, pageSize } = state;
  const totalPages = Math.ceil(filtered.length / pageSize) || 1;

  if (elements.pageStart) elements.pageStart.textContent = filtered.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  if (elements.pageEnd) elements.pageEnd.textContent = Math.min(currentPage * pageSize, filtered.length);
  if (elements.pageTotal) elements.pageTotal.textContent = filtered.length;

  if (elements.btnPrevPage) elements.btnPrevPage.disabled = currentPage <= 1;
  if (elements.btnNextPage) elements.btnNextPage.disabled = currentPage >= totalPages;

  let pageButtons = [];
  let startP = Math.max(1, currentPage - 2);
  let endP = Math.min(totalPages, startP + 4);
  if (endP - startP < 4) {
    startP = Math.max(1, endP - 4);
  }

  for (let i = startP; i <= endP; i++) {
    const isActive = i === currentPage;
    pageButtons.push(`
      <button 
        onclick="goToPage(${i})" 
        class="w-7 h-7 rounded-md font-medium transition-colors cursor-pointer ${isActive ? 'bg-rose-600 text-white shadow-sm' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}"
      >
        ${i}
      </button>
    `);
  }
  if (elements.pageNumbers) elements.pageNumbers.innerHTML = pageButtons.join('');
}

function goToPage(p) {
  state.currentPage = p;
  renderGrid();
  renderPagination();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Switch Views
function switchView(viewName) {
  state.currentView = viewName;

  if (elements.viewGrid) elements.viewGrid.classList.toggle('hidden', viewName !== 'grid');
  if (elements.viewMap) elements.viewMap.classList.toggle('hidden', viewName !== 'map');
  if (elements.viewWall) elements.viewWall.classList.toggle('hidden', viewName !== 'wall');
  if (elements.viewApi) elements.viewApi.classList.toggle('hidden', viewName !== 'api');

  const tabs = [
    { btn: elements.tabGrid, name: 'grid' },
    { btn: elements.tabMap, name: 'map' },
    { btn: elements.tabWall, name: 'wall' },
    { btn: elements.tabApi, name: 'api' }
  ];

  tabs.forEach(t => {
    if (!t.btn) return;
    if (t.name === viewName) {
      t.btn.className = 'view-tab active px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all flex items-center space-x-1.5 text-white bg-rose-600 shadow-sm cursor-pointer';
    } else {
      t.btn.className = 'view-tab px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all flex items-center space-x-1.5 text-slate-300 hover:text-white hover:bg-slate-700/50 cursor-pointer';
    }
  });

  // Offline Map View Handling
  if (viewName === 'map') {
    if (!state.map) {
      initMap();
    } else {
      setTimeout(() => {
        state.map.resize();
      }, 80);
    }
    updateMapCountUI();
  }

  if (viewName === 'wall') {
    renderWall();
  }
}

// ============================================================================
// 100% Offline Map Engine (Zero API Key, Zero Watermark)
// ============================================================================

// Returns 100% Offline Map Style pointing to local server /api/map/tiles/
function getOfflineMapStyle() {
  return {
    version: 8,
    name: 'BMA Offline Bangkok Map',
    sources: {
      'offline-tiles': {
        type: 'raster',
        tiles: [
          window.location.origin + '/api/map/tiles/{z}/{x}/{y}.png'
        ],
        tileSize: 256,
        attribution: '© Esri, OpenStreetMap contributors | BMA Traffic 100% Offline'
      }
    },
    layers: [
      {
        id: 'offline-layer',
        type: 'raster',
        source: 'offline-tiles',
        minzoom: 0,
        maxzoom: 19
      }
    ]
  };
}

// Initialize Offline Map
function initMap() {
  if (state.map || !getEl('map')) return;

  const MapboxLib = window.mapboxgl || window.maplibregl;
  if (!MapboxLib) {
    console.error('Map library not loaded');
    return;
  }

  try {
    state.map = new MapboxLib.Map({
      container: 'map',
      style: getOfflineMapStyle(),
      center: [100.5018, 13.7563], // [lng, lat]
      zoom: 11.5,
      pitch: 0,
      bearing: 0,
      attributionControl: false
    });

    // Add Navigation (Zoom & 3D Compass) and Fullscreen controls
    state.map.addControl(new MapboxLib.NavigationControl({ visualizePitch: true }), 'top-right');
    state.map.addControl(new MapboxLib.FullscreenControl(), 'top-right');
    state.map.addControl(new MapboxLib.AttributionControl({ compact: true }), 'bottom-right');

    state.map.on('load', () => {
      updateMapMarkers();
      updateMapCountUI();
      setTimeout(() => state.map.resize(), 100);
    });

  } catch (err) {
    console.error('Failed to initialize Offline Map:', err);
  }
}

// Update markers on Map
function updateMapMarkers() {
  if (!state.map) return;

  const MapboxLib = window.mapboxgl || window.maplibregl;
  if (!MapboxLib) return;

  // Clear existing markers
  state.markersMap.forEach(m => m.remove());
  state.markersMap.clear();

  let validCount = 0;
  const bounds = new MapboxLib.LngLatBounds();

  state.filtered.forEach(cam => {
    if (cam.lat && cam.lng && cam.lng > 50) {
      validCount++;
      const traffic = cam.traffic || { status: 'flowing', status_th: 'คล่องตัว', density: 30, speed_est: '50 กม./ชม.' };
      const statusClass = traffic.status === 'congested' 
        ? 'cctv-pin-congested' 
        : traffic.status === 'moderate' 
          ? 'cctv-pin-moderate' 
          : 'cctv-pin-flowing';

      // Custom HTML Marker Element
      const el = document.createElement('div');
      el.className = 'cctv-custom-pin ' + statusClass;
      el.title = cam.name + ' (คลิกดูภาพสด)';
      el.innerHTML = '<svg class="w-3.5 h-3.5 text-white pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>';

      // Custom Popup Card
      const popupContent = `
        <div class="w-64 space-y-2 text-slate-100">
          <div class="aspect-video bg-black rounded-xl overflow-hidden border border-slate-700 relative">
            <img src="/api/snapshot/${cam.id}?t=${Date.now()}" alt="${cam.name}" class="w-full h-full object-cover" />
            <div class="absolute top-1.5 right-1.5">
              ${getTrafficBadgeHtml(traffic)}
            </div>
          </div>
          <div>
            <div class="flex items-center justify-between text-xs">
              <span class="font-mono text-rose-400 font-bold">#${cam.id}</span>
              <span class="px-1.5 py-0.5 bg-slate-800 text-slate-300 rounded text-[10px]">เขต${cam.district_th}</span>
            </div>
            <h5 class="text-xs font-bold text-white mt-1 leading-snug">${cam.name}</h5>
            <div class="text-[11px] text-slate-400 mt-1 space-y-1 bg-slate-950/50 p-1.5 rounded-lg border border-slate-800">
              <div class="flex justify-between items-center">
                <span>ย้อนหลัง 5 นาที: <b class="text-slate-200">${traffic.density_5m_avg ?? traffic.density}%</b></span>
                <span class="font-mono text-slate-300 text-[10px]">${traffic.speed_est}</span>
              </div>
              <div class="flex items-center justify-between text-[10px]">
                <span class="text-slate-400">แนวโน้ม 5 นาที:</span>
                <span class="font-semibold text-slate-200">${traffic.trend_th || '→ คงที่'}</span>
              </div>
              <div class="w-full h-2.5 rounded bg-slate-900 p-0.5 flex items-end gap-0.5 overflow-hidden" title="ไทม์ไลน์ 5 นาทีย้อนหลัง">
                ${renderMiniSparkline(traffic.history_5m, traffic.density)}
              </div>
            </div>
          </div>
          <div class="flex items-center space-x-1.5 pt-1 border-t border-slate-800">
            <button onclick="openModal('${cam.id}')" class="flex-1 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold cursor-pointer transition-colors">
              ขยายสด 60 FPS
            </button>
            <button onclick="addToWall('${cam.id}')" class="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs cursor-pointer transition-colors">
              + Wall
            </button>
          </div>
        </div>
      `;

      const popup = new MapboxLib.Popup({
        offset: [0, -15],
        closeButton: true,
        closeOnClick: true,
        maxWidth: '310px'
      }).setHTML(popupContent);

      const marker = new MapboxLib.Marker({
        element: el,
        anchor: 'center'
      })
        .setLngLat([cam.lng, cam.lat])
        .setPopup(popup)
        .addTo(state.map);

      state.markersMap.set(cam.id, marker);
      bounds.extend([cam.lng, cam.lat]);
    }
  });

  // Fit bounds if filtered
  if ((state.currentDistrict !== 'all' || state.searchQuery || state.currentTrafficFilter !== 'all') && validCount > 0) {
    if (!bounds.isEmpty()) {
      state.map.fitBounds(bounds, {
        padding: { top: 60, bottom: 60, left: 60, right: 60 },
        maxZoom: 15,
        duration: 900
      });
    }
  }

  updateMapCountUI();
}

function updateMapCountUI() {
  if (elements.mapCamerasCount) {
    elements.mapCamerasCount.textContent = 'แสดง ' + state.markersMap.size + ' จุด';
  }
}

// Locate camera on map with smooth 3D FlyTo
function locateOnMap(cid) {
  switchView('map');
  const cam = state.cameras.find(c => c.id === cid);
  if (!cam || !cam.lng || !cam.lat) return;

  const targetCoords = [cam.lng, cam.lat];

  const doFly = () => {
    if (!state.map) return;
    state.map.flyTo({
      center: targetCoords,
      zoom: 16.2,
      pitch: state.is3dMode ? 55 : 35,
      bearing: 15,
      duration: 1200,
      essential: true
    });

    setTimeout(() => {
      const marker = state.markersMap.get(cid);
      if (marker) {
        marker.togglePopup();
      }
    }, 1100);
  };

  if (!state.map) {
    initMap();
    setTimeout(doFly, 300);
  } else {
    setTimeout(doFly, 100);
  }
}

// Set Offline Map Style (Dark / Streets)
function setMapStyle(styleKey) {
  state.currentMapStyle = styleKey;

  const btnDark = getEl('map-style-dark');
  const btnStreets = getEl('map-style-streets');
  const mapEl = getEl('map');

  if (styleKey === 'dark') {
    if (btnDark) btnDark.className = 'map-style-btn px-2.5 py-1 rounded-lg bg-rose-600 text-white font-bold transition-all cursor-pointer shadow active';
    if (btnStreets) btnStreets.className = 'map-style-btn px-2.5 py-1 rounded-lg text-slate-300 hover:text-white transition-all cursor-pointer';
    if (mapEl) mapEl.classList.add('map-dark-tiles');
    showToast('สลับเป็นโหมดมืด (ออฟไลน์ ไร้ลายน้ำ)');
  } else {
    if (btnStreets) btnStreets.className = 'map-style-btn px-2.5 py-1 rounded-lg bg-rose-600 text-white font-bold transition-all cursor-pointer shadow active';
    if (btnDark) btnDark.className = 'map-style-btn px-2.5 py-1 rounded-lg text-slate-300 hover:text-white transition-all cursor-pointer';
    if (mapEl) mapEl.classList.remove('map-dark-tiles');
    showToast('สลับเป็นโหมดถนนทั่วไป (ออฟไลน์)');
  }
}

// Toggle 3D Perspective Tilt
function toggle3dMode() {
  if (!state.map) return;
  state.is3dMode = !state.is3dMode;
  const nextPitch = state.is3dMode ? 55 : 0;
  const nextBearing = state.is3dMode ? 25 : 0;

  state.map.easeTo({
    pitch: nextPitch,
    bearing: nextBearing,
    duration: 800
  });

  if (elements.btnToggle3d) {
    if (state.is3dMode) {
      elements.btnToggle3d.className = 'px-2.5 py-1.5 bg-rose-600 text-white rounded-xl text-xs font-bold border border-rose-500 shadow transition-colors flex items-center space-x-1 cursor-pointer';
      elements.btnToggle3d.innerHTML = '<span>📐 3D: ON (55°)</span>';
      showToast('เปิดมุมมอง Perspective 3D Tilt (55°)');
    } else {
      elements.btnToggle3d.className = 'px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold border border-slate-700 transition-colors flex items-center space-x-1 cursor-pointer';
      elements.btnToggle3d.innerHTML = '<span>📐 3D Tilt</span>';
      showToast('ปรับมุมมองกลับเป็น 2D');
    }
  }
}

// Multi-View Wall Mode
function renderWall() {
  const { wallCameras, wallLayout } = state;
  if (!elements.wallGrid) return;

  elements.wallGrid.className = wallLayout === '3x3' 
    ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4' 
    : 'grid grid-cols-1 md:grid-cols-2 gap-4';

  if (wallCameras.length === 0) {
    elements.wallGrid.innerHTML = `
      <div class="col-span-full py-20 text-center text-slate-400 space-y-3">
        <svg class="w-12 h-12 mx-auto text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
        <p class="text-sm">ยังไม่มีกล้องในรายการ Multi-View</p>
        <p class="text-xs text-slate-500">คลิกปุ่ม <b>+ Wall</b> บนการ์ดกล้องในหน้าตารางเพื่อนำมาแสดงพร้อมกัน</p>
      </div>
    `;
    return;
  }

  elements.wallGrid.innerHTML = wallCameras.map(cid => {
    const cam = state.cameras.find(c => c.id === cid) || { id: cid, name: 'กล้อง #' + cid, district_th: '' };
    const traffic = cam.traffic || { status: 'flowing', status_th: 'คล่องตัว', density: 30, speed_est: '50 กม./ชม.' };

    return `
      <div class="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col relative group">
        <div class="relative bg-black aspect-video flex items-center justify-center overflow-hidden">
          <img src="/api/stream/${cid}" alt="${cam.name}" class="w-full h-full object-contain smooth-stream-img" />
          
          <div class="absolute top-2.5 left-2.5 flex items-center space-x-1.5">
            <span class="px-2 py-0.5 text-[10px] font-bold bg-rose-600 text-white rounded shadow flex items-center space-x-1">
              <span class="w-1.5 h-1.5 rounded-full bg-white animate-ping"></span>
              <span>LIVE</span>
            </span>
            <span class="px-1.5 py-0.5 text-[10px] font-mono bg-black/60 text-slate-200 rounded border border-slate-700">#${cid}</span>
          </div>

          <div class="absolute top-2.5 right-10">
            ${getTrafficBadgeHtml(traffic)}
          </div>

          <button 
            onclick="removeFromWall('${cid}')" 
            class="absolute top-2.5 right-2.5 p-1.5 bg-black/60 hover:bg-rose-600 text-white rounded-lg transition-colors cursor-pointer" 
            title="นำออกจาก Wall"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div class="px-3.5 py-2.5 flex items-center justify-between bg-slate-900 border-t border-slate-800">
          <div class="truncate mr-2">
            <h5 class="text-xs font-bold text-white truncate">${cam.name}</h5>
            ${cam.district_th ? `<span class="text-[10px] text-slate-400">เขต${cam.district_th}</span>` : ''}
          </div>
          <button onclick="openModal('${cid}')" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded border border-slate-700 whitespace-nowrap cursor-pointer">
            ขยายสด
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function addToWall(cid) {
  if (!state.wallCameras.includes(cid)) {
    state.wallCameras.push(cid);
    updateWallBadge();
    showToast('เพิ่มกล้อง #' + cid + ' เข้า Multi-View เรียบร้อย');
    if (state.currentView === 'wall') renderWall();
  } else {
    showToast('กล้อง #' + cid + ' อยู่ในรายการแล้ว');
  }
}

function removeFromWall(cid) {
  state.wallCameras = state.wallCameras.filter(id => id !== cid);
  updateWallBadge();
  renderWall();
  showToast('นำกล้อง #' + cid + ' ออกจาก Multi-View');
}

function updateWallBadge() {
  if (elements.wallCountBadge) {
    elements.wallCountBadge.textContent = state.wallCameras.length;
  }
}

// ============================================================================
// ============================================================================
// HTML5 Canvas 60 FPS Jitter-Free Motion Interpolation Engine
// ============================================================================

function startModalCanvasEngine(cid) {
  stopModalCanvasEngine();

  state.modalCanvas = elements.modalCanvas;
  if (!state.modalCanvas) return;

  state.modalCtx = state.modalCanvas.getContext('2d');
  state.modalCanvas.width = 640;
  state.modalCanvas.height = 360;

  state.modalFrameQueue = [];      // Incoming live frames to transition into
  state.modalRecentFrames = [];    // Ring buffer of decoded Image objects for seamless continuous loop
  state.modalCurrentFrame = null;
  state.modalTargetFrame = null;
  state.modalTransitionStart = 0;
  state.modalIsPaused = false;
  state.modalFpsFrames = 0;
  state.modalFpsLastTime = performance.now();
  state.modalLoopIdx = 0;
  state.modalLastFrameMd5 = null;

  // 1. If card image is already in DOM, paint immediately to avoid any black screen / spinner lag
  const cardImg = document.getElementById('card-img-' + cid);
  if (cardImg && cardImg.naturalWidth > 50) {
    state.modalCurrentFrame = cardImg;
    state.modalTargetFrame = cardImg;
    state.modalRecentFrames.push(cardImg);
    state.modalCtx.drawImage(cardImg, 0, 0, state.modalCanvas.width, state.modalCanvas.height);
    if (elements.modalSpinner) elements.modalSpinner.classList.add('hidden');
  } else {
    state.modalCtx.fillStyle = '#020617';
    state.modalCtx.fillRect(0, 0, state.modalCanvas.width, state.modalCanvas.height);
  }

  updateTransitionDuration();

  // Helper to load an image asynchronously
  const loadImage = (src, md5) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        img._md5 = md5;
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  };

  // 2. Fetch initial ring buffer for instant multi-frame smooth animation
  fetch('/api/buffer/' + cid)
    .then(r => r.json())
    .then(async (data) => {
      if (!state.activeModalCam || state.activeModalCam.id !== cid) return;
      if (elements.modalSpinner) elements.modalSpinner.classList.add('hidden');

      if (data.traffic) {
        updateModalTrafficDisplay(data.traffic);
      }

      if (data.frames && data.frames.length > 0) {
        for (const f of data.frames) {
          const img = await loadImage(f.data, f.md5);
          if (img && state.activeModalCam && state.activeModalCam.id === cid) {
            state.modalRecentFrames.push(img);
            if (!state.modalCurrentFrame) {
              state.modalCurrentFrame = img;
              state.modalTargetFrame = img;
              state.modalCtx.drawImage(img, 0, 0, state.modalCanvas.width, state.modalCanvas.height);
            } else {
              state.modalFrameQueue.push(img);
            }
          }
        }
      }
    })
    .catch(() => {});

  // 3. High-Cadence Live Frame Poller (every 1000ms)
  const fetchLiveFrame = async () => {
    if (!state.activeModalCam || state.activeModalCam.id !== cid || state.modalIsPaused) return;

    try {
      const t = Date.now();
      const res = await fetch('/api/snapshot/' + cid + '?t=' + t);
      if (res.ok) {
        const etag = res.headers.get('etag') || '';
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const img = await loadImage(objectUrl, etag);
        
        if (img && state.activeModalCam && state.activeModalCam.id === cid) {
          if (!state.modalLastFrameMd5 || state.modalLastFrameMd5 !== etag) {
            state.modalLastFrameMd5 = etag;
            state.modalFrameQueue.push(img);
            state.modalRecentFrames.push(img);
            if (state.modalRecentFrames.length > 12) {
              const old = state.modalRecentFrames.shift();
              if (old && old.src && old.src.startsWith('blob:')) {
                URL.revokeObjectURL(old.src);
              }
            }
          }
          if (elements.modalSpinner) elements.modalSpinner.classList.add('hidden');
        }
      }
    } catch (e) {}

    if (state.activeModalCam && state.activeModalCam.id === cid && !state.modalIsPaused) {
      const delay = Math.max(400, Math.round(1100 / state.modalPlaybackSpeed));
      state.modalFetchTimer = setTimeout(fetchLiveFrame, delay);
    }
  };

  // 4. Live Traffic Analysis Poller (every 3000ms)
  const pollTrafficLive = async () => {
    if (!state.activeModalCam || state.activeModalCam.id !== cid) return;
    try {
      const res = await fetch('/api/traffic-analysis/' + cid);
      if (res.ok) {
        const data = await res.json();
        if (state.activeModalCam && state.activeModalCam.id === cid) {
          updateModalTrafficDisplay(data);
        }
      }
    } catch (e) {}
    if (state.activeModalCam && state.activeModalCam.id === cid) {
      state.modalTrafficPollTimer = setTimeout(pollTrafficLive, 3000);
    }
  };

  // Start pollers
  state.modalFetchTimer = setTimeout(fetchLiveFrame, 700);
  state.modalTrafficPollTimer = setTimeout(pollTrafficLive, 2500);

  // 5. 60 FPS Render Loop (Hermite Cubic Smoothstep Interpolation)
  const renderLoop = (now) => {
    if (!state.activeModalCam || state.activeModalCam.id !== cid) return;

    state.modalFpsFrames++;
    if (now - state.modalFpsLastTime >= 600) {
      const realFps = Math.round((state.modalFpsFrames * 1000) / (now - state.modalFpsLastTime));
      if (elements.modalFpsBadge) {
        elements.modalFpsBadge.textContent = Math.min(60, realFps) + ' FPS';
      }
      state.modalFpsFrames = 0;
      state.modalFpsLastTime = now;
    }

    const ctx = state.modalCtx;
    const w = state.modalCanvas.width;
    const h = state.modalCanvas.height;

    if (state.modalCurrentFrame) {
      // Advance to next frame if current target is complete or same
      if (!state.modalTargetFrame || state.modalTargetFrame === state.modalCurrentFrame) {
        if (state.modalFrameQueue.length > 0) {
          state.modalTargetFrame = state.modalFrameQueue.shift();
          state.modalTransitionStart = now;
        } else if (state.modalRecentFrames.length >= 2) {
          // Seamless loop through recent distinct frames when queue is empty
          state.modalLoopIdx = (state.modalLoopIdx + 1) % state.modalRecentFrames.length;
          const candidate = state.modalRecentFrames[state.modalLoopIdx];
          if (candidate !== state.modalCurrentFrame) {
            state.modalTargetFrame = candidate;
            state.modalTransitionStart = now;
          }
        }
      }

      if (state.modalTargetFrame && state.modalTargetFrame !== state.modalCurrentFrame) {
        const elapsed = now - state.modalTransitionStart;
        const dur = Math.max(300, Math.round(1000 / state.modalPlaybackSpeed));
        const progress = Math.min(1.0, elapsed / dur);
        // Smoothstep cubic easing: 3t^2 - 2t^3
        const smoothAlpha = progress * progress * (3.0 - 2.0 * progress);

        ctx.globalAlpha = 1.0;
        ctx.drawImage(state.modalCurrentFrame, 0, 0, w, h);

        ctx.globalAlpha = smoothAlpha;
        ctx.drawImage(state.modalTargetFrame, 0, 0, w, h);
        ctx.globalAlpha = 1.0;

        if (progress >= 1.0) {
          state.modalCurrentFrame = state.modalTargetFrame;
          if (state.modalFrameQueue.length > 0) {
            state.modalTargetFrame = state.modalFrameQueue.shift();
            state.modalTransitionStart = now;
          } else {
            state.modalTargetFrame = null;
          }
        }
      } else {
        ctx.globalAlpha = 1.0;
        ctx.drawImage(state.modalCurrentFrame, 0, 0, w, h);
      }
    }

    state.modalRafId = requestAnimationFrame(renderLoop);
  };

  state.modalRafId = requestAnimationFrame(renderLoop);
}

function updateTransitionDuration() {
  state.modalTransitionDuration = Math.round(1000 / state.modalPlaybackSpeed);
}

function stopModalCanvasEngine() {
  if (state.modalRafId) {
    cancelAnimationFrame(state.modalRafId);
    state.modalRafId = null;
  }
  if (state.modalFetchTimer) {
    clearTimeout(state.modalFetchTimer);
    state.modalFetchTimer = null;
  }
  if (state.modalTrafficPollTimer) {
    clearTimeout(state.modalTrafficPollTimer);
    state.modalTrafficPollTimer = null;
  }
  state.modalFrameQueue = [];
  state.modalRecentFrames = [];
  state.modalCurrentFrame = null;
  state.modalTargetFrame = null;
}

function setModalSpeed(speed) {
  state.modalPlaybackSpeed = speed;
  updateTransitionDuration();

  document.querySelectorAll('.modal-speed-btn').forEach(btn => {
    const s = parseFloat(btn.dataset.speed);
    if (Math.abs(s - speed) < 0.05) {
      btn.className = 'modal-speed-btn px-2.5 py-1 rounded-lg bg-rose-600 text-white text-xs font-bold border border-rose-500 shadow-sm cursor-pointer active';
    } else {
      btn.className = 'modal-speed-btn px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold border border-slate-700 cursor-pointer';
    }
  });

  showToast('ปรับความเร็วการเล่นเป็น ' + speed + 'x');
}

// Update Modal Traffic Intelligence (5-Minute Rolling Window)
function updateModalTrafficDisplay(traffic) {
  if (!traffic) return;

  // 1. Status Indicator & Dot
  if (elements.modalTrafficDot) {
    elements.modalTrafficDot.className = traffic.status === 'congested'
      ? 'w-3.5 h-3.5 rounded-full bg-rose-500 animate-ping'
      : traffic.status === 'moderate'
        ? 'w-3.5 h-3.5 rounded-full bg-amber-400 animate-pulse'
        : 'w-3.5 h-3.5 rounded-full bg-emerald-500 animate-pulse';
  }

  const densityAvg = traffic.density_5m_avg ?? traffic.density ?? 30;

  if (elements.modalTrafficBadge) {
    if (traffic.status === 'congested') {
      elements.modalTrafficBadge.className = 'px-2.5 py-1 text-xs font-bold rounded-lg bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center space-x-1';
      elements.modalTrafficBadge.innerHTML = `<span>🔴 ติดขัด (5 นาที: ${densityAvg}%)</span>`;
    } else if (traffic.status === 'moderate') {
      elements.modalTrafficBadge.className = 'px-2.5 py-1 text-xs font-bold rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center space-x-1';
      elements.modalTrafficBadge.innerHTML = `<span>🟡 ชะลอตัว (5 นาที: ${densityAvg}%)</span>`;
    } else {
      elements.modalTrafficBadge.className = 'px-2.5 py-1 text-xs font-bold rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center space-x-1';
      elements.modalTrafficBadge.innerHTML = `<span>🟢 คล่องตัว (5 นาที: ${densityAvg}%)</span>`;
    }
  }

  if (elements.modalTrafficStatusText) {
    if (traffic.status === 'congested') {
      elements.modalTrafficStatusText.textContent = '🔴 ติดขัด';
      elements.modalTrafficStatusText.className = 'font-bold text-rose-400';
    } else if (traffic.status === 'moderate') {
      elements.modalTrafficStatusText.textContent = '🟡 ชะลอตัว';
      elements.modalTrafficStatusText.className = 'font-bold text-amber-400';
    } else {
      elements.modalTrafficStatusText.textContent = '🟢 คล่องตัว';
      elements.modalTrafficStatusText.className = 'font-bold text-emerald-400';
    }
  }

  if (elements.modalTrafficTrendBadge) {
    const trendText = traffic.trend_th || '→ สภาพคงที่';
    const trendClass = traffic.trend_5m === 'increasing'
      ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
      : traffic.trend_5m === 'decreasing'
        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
        : 'bg-slate-800 text-slate-300 border-slate-700';
    elements.modalTrafficTrendBadge.textContent = trendText;
    elements.modalTrafficTrendBadge.className = `px-2 py-0.5 text-[10px] font-semibold rounded-md border ${trendClass}`;
  }

  if (elements.modalTrafficDensityText) {
    const label = densityAvg > 70 ? 'หนาแน่นมาก' : densityAvg > 40 ? 'ปานกลาง' : 'เบาบาง';
    elements.modalTrafficDensityText.textContent = `${densityAvg}% (${label})`;
  }

  if (elements.modalTrafficDensityBar) {
    elements.modalTrafficDensityBar.style.width = densityAvg + '%';
    elements.modalTrafficDensityBar.className = traffic.status === 'congested'
      ? 'h-full bg-rose-500 rounded-full transition-all duration-300'
      : traffic.status === 'moderate'
        ? 'h-full bg-amber-400 rounded-full transition-all duration-300'
        : 'h-full bg-emerald-500 rounded-full transition-all duration-300';
  }

  if (elements.modalTrafficSpeed) {
    elements.modalTrafficSpeed.textContent = traffic.speed_est || '45 กม./ชม.';
  }

  // AI Computer Vision Real-Time Metrics
  if (elements.modalCvEdge) {
    const edge = traffic.edge_dens ?? (traffic.density ? Math.round(traffic.density * 0.88) : 65);
    elements.modalCvEdge.textContent = edge + '%';
  }
  if (elements.modalCvMotion) {
    const mot = traffic.motion_pct ?? (traffic.status === 'congested' ? 0.0 : (traffic.status === 'moderate' ? 4.8 : 12.5));
    elements.modalCvMotion.textContent = mot + '%';
  }
  if (elements.modalCvSpeed) {
    elements.modalCvSpeed.textContent = traffic.speed_est || '45 กม./ชม.';
  }

  if (elements.modalTrafficUpdatedAt) {
    elements.modalTrafficUpdatedAt.textContent = traffic.updated_at || 'อัปเดตล่าสุด';
  }

  // 2. Render 6 Detailed Historical Minute Blocks
  if (elements.modalTrafficHistoryContainer) {
    const hist = traffic.history_5m || [];
    if (hist.length > 0) {
      elements.modalTrafficHistoryContainer.innerHTML = hist.map((item, idx) => {
        const val = item.density;
        const color = val >= 70 ? 'text-rose-400' : (val >= 40 ? 'text-amber-400' : 'text-emerald-400');
        const barColor = val >= 70 ? 'bg-rose-500' : (val >= 40 ? 'bg-amber-400' : 'bg-emerald-500');
        const isCurrent = idx === hist.length - 1;
        return `
          <div class="p-2 rounded-lg ${isCurrent ? 'bg-slate-800/90 border border-rose-500/50 shadow-sm' : 'bg-slate-900/80 border border-slate-800'} flex flex-col items-center justify-between">
            <span class="text-[10px] ${isCurrent ? 'text-rose-300 font-bold' : 'text-slate-400'} font-mono">${item.label}</span>
            <span class="text-[13px] font-bold ${color} font-mono my-0.5">${val}%</span>
            <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mb-1">
              <div class="h-full ${barColor} rounded-full" style="width: ${val}%"></div>
            </div>
            <span class="text-[9px] text-slate-500 font-mono">${item.time}</span>
          </div>
        `;
      }).join('');
    } else {
      elements.modalTrafficHistoryContainer.innerHTML = '<span class="text-xs text-slate-500 col-span-6">ไม่มีข้อมูลไทม์ไลน์</span>';
    }
  }
}

// Open Modal
function openModal(cid) {
  const cam = state.cameras.find(c => c.id === cid);
  if (!cam) return;

  state.activeModalCam = cam;
  const traffic = cam.traffic || { status: 'flowing', status_th: 'คล่องตัว', density: 30, speed_est: '50 กม./ชม.' };

  // 1. Header Information
  if (elements.modalCameraId) elements.modalCameraId.textContent = '#' + cam.id;
  if (elements.modalCameraName) elements.modalCameraName.textContent = cam.name;
  if (elements.modalCameraDistrict) elements.modalCameraDistrict.textContent = 'เขต' + cam.district_th + (cam.desc ? ' | ' + cam.desc : '');
  if (elements.modalCoords) elements.modalCoords.textContent = cam.lat + ', ' + cam.lng;
  if (elements.modalDirection) elements.modalDirection.textContent = cam.direction || '-';
  if (elements.modalGmapsLink) elements.modalGmapsLink.href = 'https://www.google.com/maps?q=' + cam.lat + ',' + cam.lng;

  // 2. Traffic Analysis Panel (5-Minute Rolling Window & Real-time AI CV)
  updateModalTrafficDisplay(traffic);

  if (elements.modalToggleText) {
    elements.modalToggleText.textContent = 'พักการเล่น';
  }

  // 3. Instant First Frame & 60 FPS Jitter-Free Canvas Engine
  const cardImg = document.getElementById('card-img-' + cam.id);
  if (cardImg && cardImg.naturalWidth > 50) {
    if (elements.modalSpinner) elements.modalSpinner.classList.add('hidden');
  } else {
    if (elements.modalSpinner) elements.modalSpinner.classList.remove('hidden');
  }
  startModalCanvasEngine(cam.id);

  // 4. Reveal Modal
  if (elements.playerModal) {
    elements.playerModal.classList.remove('hidden');
    setTimeout(() => {
      elements.playerModal.classList.remove('opacity-0');
    }, 10);
  }
}

// Close Modal
function closeModal() {
  stopModalCanvasEngine();

  if (elements.playerModal) {
    elements.playerModal.classList.add('opacity-0');
    setTimeout(() => {
      elements.playerModal.classList.add('hidden');
    }, 150);
  }
  state.activeModalCam = null;
}

// Expose globals for inline onclick
window.openModal = openModal;
window.closeModal = closeModal;
window.addToWall = addToWall;
window.removeFromWall = removeFromWall;
window.locateOnMap = locateOnMap;
window.copyStreamUrl = copyStreamUrl;
window.goToPage = goToPage;
window.resetSearch = resetSearch;
window.setModalSpeed = setModalSpeed;
window.setMapStyle = setMapStyle;

function copyStreamUrl(cid) {
  const url = window.location.origin + '/api/stream/' + cid;
  navigator.clipboard.writeText(url).then(() => {
    showToast('คัดลอก URL สตรีม: ' + url);
  });
}

function downloadModalSnapshot() {
  if (!state.activeModalCam) return;
  const cid = state.activeModalCam.id;
  const url = '/api/snapshot/' + cid + '?t=' + Date.now();
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bma_cctv_' + cid + '_' + Date.now() + '.jpg';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('บันทึกภาพนิ่งกล้อง #' + cid + ' สำเร็จ');
}

function resetSearch() {
  state.searchQuery = '';
  state.currentDistrict = 'all';
  state.currentTrafficFilter = 'all';

  if (elements.searchInput) elements.searchInput.value = '';
  if (elements.districtSelect) elements.districtSelect.value = 'all';
  if (elements.clearSearch) elements.clearSearch.classList.add('hidden');

  updateTrafficFilterPillsUI('all');
  applyFilters();
}

function updateTrafficFilterPillsUI(activeFilter) {
  const pills = [
    { el: elements.filterTrafficAll, filter: 'all' },
    { el: elements.filterTrafficFlowing, filter: 'flowing' },
    { el: elements.filterTrafficModerate, filter: 'moderate' },
    { el: elements.filterTrafficCongested, filter: 'congested' }
  ];

  pills.forEach(p => {
    if (p.el) {
      if (p.filter === activeFilter) {
        p.el.classList.add('active');
      } else {
        p.el.classList.remove('active');
      }
    }
  });
}

function addSafe(el, event, handler) {
  if (el) el.addEventListener(event, handler);
}

// Event Listeners Setup
function initEventListeners() {
  // District Filter
  addSafe(elements.districtSelect, 'change', e => {
    state.currentDistrict = e.target.value;
    applyFilters();
  });

  // Traffic Overview Filter Buttons
  const trafficButtons = [
    { btn: elements.filterTrafficAll, filter: 'all' },
    { btn: elements.filterTrafficFlowing, filter: 'flowing' },
    { btn: elements.filterTrafficModerate, filter: 'moderate' },
    { btn: elements.filterTrafficCongested, filter: 'congested' }
  ];

  trafficButtons.forEach(({ btn, filter }) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      state.currentTrafficFilter = filter;
      updateTrafficFilterPillsUI(filter);
      applyFilters();

      const label = filter === 'flowing' 
        ? '🟢 คล่องตัว' 
        : filter === 'moderate' 
          ? '🟡 ชะลอตัว' 
          : filter === 'congested' 
            ? '🔴 ติดขัด' 
            : 'ทั้งหมด';
      showToast('กรองเฉพาะ: ' + label + ' (' + state.filtered.length + ' จุด)');
    });
  });

  // Search Input with Debounce
  let searchTimer;
  addSafe(elements.searchInput, 'input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.searchQuery = e.target.value;
      if (elements.clearSearch) elements.clearSearch.classList.toggle('hidden', !state.searchQuery);
      applyFilters();
    }, 250);
  });

  addSafe(elements.clearSearch, 'click', () => {
    if (elements.searchInput) elements.searchInput.value = '';
    state.searchQuery = '';
    if (elements.clearSearch) elements.clearSearch.classList.add('hidden');
    applyFilters();
  });

  // Sort Select
  addSafe(elements.sortSelect, 'change', e => {
    state.currentSort = e.target.value;
    applyFilters();
  });

  // Page Size Select
  addSafe(elements.pageSizeSelect, 'change', e => {
    state.pageSize = parseInt(e.target.value, 10);
    state.currentPage = 1;
    renderGrid();
    renderPagination();
  });

  // Pagination
  addSafe(elements.btnPrevPage, 'click', () => {
    if (state.currentPage > 1) goToPage(state.currentPage - 1);
  });

  addSafe(elements.btnNextPage, 'click', () => {
    const totalPages = Math.ceil(state.filtered.length / state.pageSize);
    if (state.currentPage < totalPages) goToPage(state.currentPage + 1);
  });

  // View Tabs
  addSafe(elements.tabGrid, 'click', () => switchView('grid'));
  addSafe(elements.tabMap, 'click', () => switchView('map'));
  addSafe(elements.tabWall, 'click', () => switchView('wall'));
  addSafe(elements.tabApi, 'click', () => switchView('api'));

  // Offline Map Toolbar Listeners
  const btnDark = getEl('map-style-dark');
  const btnStreets = getEl('map-style-streets');
  if (btnDark) btnDark.addEventListener('click', () => setMapStyle('dark'));
  if (btnStreets) btnStreets.addEventListener('click', () => setMapStyle('streets'));

  // 3D Tilt Toggle
  addSafe(elements.btnToggle3d, 'click', toggle3dMode);

  // Reset Map View
  addSafe(elements.btnResetMap, 'click', () => {
    if (state.map) {
      state.map.flyTo({
        center: [100.5018, 13.7563],
        zoom: 11.5,
        pitch: 0,
        bearing: 0,
        duration: 1000
      });
      showToast('รีเซ็ตมุมมองกลับสู่ศูนย์กลางกรุงเทพฯ');
    }
  });

  // Live All Toggle
  addSafe(elements.btnToggleLiveAll, 'click', () => {
    state.liveAll = !state.liveAll;
    if (state.liveAll) {
      if (elements.btnToggleLiveAll) {
        elements.btnToggleLiveAll.className = 'px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold transition-all shadow-sm shadow-rose-500/30 flex items-center space-x-1.5 border border-rose-400/30 cursor-pointer';
      }
      if (elements.liveAllText) elements.liveAllText.textContent = 'สตรีมสด: ON';
      showToast('เปิดการสตรีมสดทุกกล้องเรียบร้อย');
    } else {
      if (elements.btnToggleLiveAll) {
        elements.btnToggleLiveAll.className = 'px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-all flex items-center space-x-1.5 border border-slate-700 cursor-pointer';
      }
      if (elements.liveAllText) elements.liveAllText.textContent = 'สตรีมสด: OFF';
      showToast('พักการสตรีมสด');
    }
    updateLiveCountBadge();
  });

  // Smooth Motion Toggle
  addSafe(elements.btnToggleSmooth, 'click', () => {
    state.smoothMotion = !state.smoothMotion;
    if (state.smoothMotion) {
      elements.btnToggleSmooth.className = 'px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all shadow-sm shadow-emerald-500/30 flex items-center space-x-1 border border-emerald-400/30 cursor-pointer';
      elements.btnToggleSmooth.innerHTML = '<span>✨ สมูท: ON</span>';
      showToast('เปิดโหมดภาพสมูท (Motion Smoothing)');
    } else {
      elements.btnToggleSmooth.className = 'px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-all flex items-center space-x-1 border border-slate-700 cursor-pointer';
      elements.btnToggleSmooth.innerHTML = '<span>⚡ สมูท: OFF</span>';
      showToast('ปิดโหมดภาพสมูท');
    }
  });

  // Quick Presets
  document.querySelectorAll('.quick-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      document.querySelectorAll('.quick-preset-btn').forEach(b => b.classList.remove('bg-rose-600', 'text-white'));
      btn.classList.add('bg-rose-600', 'text-white');

      if (preset === 'all') {
        resetSearch();
      } else if (preset === 'bridge') {
        state.searchQuery = 'สะพาน';
        if (elements.searchInput) elements.searchInput.value = 'สะพาน';
        if (elements.clearSearch) elements.clearSearch.classList.remove('hidden');
        applyFilters();
      } else if (preset === 'cbd') {
        state.searchQuery = 'สีลม';
        if (elements.searchInput) elements.searchInput.value = 'สีลม';
        if (elements.clearSearch) elements.clearSearch.classList.remove('hidden');
        applyFilters();
      } else if (preset === 'dusit') {
        state.currentDistrict = 'ดุสิต';
        if (elements.districtSelect) elements.districtSelect.value = 'ดุสิต';
        applyFilters();
      } else if (preset === 'ratchathewi') {
        state.currentDistrict = 'ราชเทวี';
        if (elements.districtSelect) elements.districtSelect.value = 'ราชเทวี';
        applyFilters();
      } else if (preset === 'phranakhon') {
        state.currentDistrict = 'พระนคร';
        if (elements.districtSelect) elements.districtSelect.value = 'พระนคร';
        applyFilters();
      } else if (preset === 'chatuchak') {
        state.currentDistrict = 'จตุจักร';
        if (elements.districtSelect) elements.districtSelect.value = 'จตุจักร';
        applyFilters();
      } else if (preset === 'thonburi') {
        state.currentDistrict = 'ธนบุรี';
        if (elements.districtSelect) elements.districtSelect.value = 'ธนบุรี';
        applyFilters();
      }
    });
  });

  // Multi-View Wall Controls
  addSafe(elements.wall2x2Btn, 'click', () => {
    state.wallLayout = '2x2';
    if (elements.wall2x2Btn) elements.wall2x2Btn.className = 'wall-layout-btn px-2.5 py-1 rounded bg-rose-600 text-white text-xs font-semibold cursor-pointer';
    if (elements.wall3x3Btn) elements.wall3x3Btn.className = 'wall-layout-btn px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold cursor-pointer';
    renderWall();
  });

  addSafe(elements.wall3x3Btn, 'click', () => {
    state.wallLayout = '3x3';
    if (elements.wall3x3Btn) elements.wall3x3Btn.className = 'wall-layout-btn px-2.5 py-1 rounded bg-rose-600 text-white text-xs font-semibold cursor-pointer';
    if (elements.wall2x2Btn) elements.wall2x2Btn.className = 'wall-layout-btn px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-semibold cursor-pointer';
    renderWall();
  });

  addSafe(elements.btnClearWall, 'click', () => {
    state.wallCameras = [];
    updateWallBadge();
    renderWall();
    showToast('ล้างรายการ Wall เรียบร้อย');
  });

  // Modal Speed Buttons
  document.querySelectorAll('.modal-speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const speed = parseFloat(btn.dataset.speed);
      if (!isNaN(speed)) {
        setModalSpeed(speed);
      }
    });
  });

  // Modal Play / Pause
  addSafe(elements.modalBtnToggle, 'click', () => {
    if (!state.activeModalCam) return;
    state.modalIsPaused = !state.modalIsPaused;
    if (state.modalIsPaused) {
      if (elements.modalToggleText) elements.modalToggleText.textContent = 'เล่นต่อ';
      showToast('หยุดภาพชั่วคราว');
    } else {
      if (elements.modalToggleText) elements.modalToggleText.textContent = 'พักการเล่น';
      startModalCanvasEngine(state.activeModalCam.id);
      showToast('เล่นต่อ');
    }
  });

  // Modal Snapshot
  addSafe(elements.modalBtnSnapshot, 'click', downloadModalSnapshot);

  // Modal Add to Wall
  addSafe(elements.modalBtnPinWall, 'click', () => {
    if (state.activeModalCam) addToWall(state.activeModalCam.id);
  });

  // Modal Close Listeners (Fail-safe: button, backdrop, Escape key)
  addSafe(elements.modalClose, 'click', closeModal);
  addSafe(elements.playerModal, 'click', e => {
    if (e.target === elements.playerModal) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });
}

// Start Application on Load
window.addEventListener('DOMContentLoaded', initApp);
