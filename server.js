/**
 * BMA Traffic CCTV Live Dashboard Server
 * High-Performance Server with Traffic Analysis & Smooth Buffer Streaming
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;

// --- Serverless (Vercel) compatibility -------------------------------------
// On Vercel this file is loaded as a serverless function: there is no long-lived
// process, the filesystem is read-only (except /tmp), and a response cannot stay
// open forever. These flags let the same file run both locally and on Vercel.
const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const WRITABLE_TILE_DIR = IS_SERVERLESS ? '/tmp/bma-tiles' : null;

// The Vercel bundler may place this file in a subdirectory, so locate the folder
// that actually contains data/ and public/ instead of trusting __dirname.
const ROOT_DIR = (function findRoot() {
  const candidates = [__dirname, path.join(__dirname, '..'), process.cwd(), '/var/task'];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'data', 'cameras.json'))) return dir;
    } catch (e) { /* try next candidate */ }
  }
  return __dirname;
})();
// ---------------------------------------------------------------------------
const BMA_BASE = process.env.BMA_BASE || 'https://cpudapp.bangkok.go.th/bmatraffic';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Node's fetch sends a bare request. The BMA WAF is stricter about traffic from
// outside Thailand, so send what a real browser would.
// Frames are pulled by a pool of parallel requests: one request at a time tops
// out near 1 fps because each round trip costs ~1.35s, while fourteen in
// flight measured 8.7 fps with only 6% of responses repeating a frame - the
// source is faster than a single connection can drain.
const PUMP_WORKERS = Number(process.env.PUMP_WORKERS || 12);
// Parallel replies arrive out of order and unevenly spaced, so playback runs
// this far behind capture. The delay is what buys smoothness: measured over 25s
// on one camera, 3s gave p90 gaps of 242ms and three visible stalls, 5s gave
// 165ms and one. Being five seconds behind means nothing for a traffic camera.
const PLAYBACK_DELAY_MS = Number(process.env.PLAYBACK_DELAY_MS || 5000);
// Enough to cover the delay plus headroom (~25 KB a frame, so ~4 MB a camera)
const RING_MAX_FRAMES = Number(process.env.RING_MAX_FRAMES || 150);
// Emit no faster than this; when no frame is due the loop simply waits, so
// output settles at whatever rate the source actually sustains.
const STREAM_TICK_MS = 80;

const BROWSER_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

// Persistent HTTPS Agent with connection pooling
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 16,
  timeout: 60000
});

// Load data files
const camerasPath = path.join(ROOT_DIR, 'data', 'cameras.json');
const districtsPath = path.join(ROOT_DIR, 'data', 'districts.json');
const trafficPath = path.join(ROOT_DIR, 'data', 'traffic_analysis.json');

let cameras = [];
let districts = [];
let trafficData = { summary: {}, cameras: {} };

try {
  cameras = JSON.parse(fs.readFileSync(camerasPath, 'utf8'));
  districts = JSON.parse(fs.readFileSync(districtsPath, 'utf8'));
  if (fs.existsSync(trafficPath)) {
    trafficData = JSON.parse(fs.readFileSync(trafficPath, 'utf8'));
  }
  console.log(`Loaded ${cameras.length} cameras, ${districts.length} districts, and traffic analysis.`);
} catch (err) {
  console.error('Error loading data files:', err);
}

// 5-Minute Rolling Window Traffic Analysis Engine (Preserves real CV points & smooth transitions)
function rollTrafficHistory5m() {
  if (!trafficData || !trafficData.cameras) return;
  const now = new Date();
  const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

  let flowingCount = 0;
  let moderateCount = 0;
  let congestedCount = 0;
  let totalDensity = 0;
  const totalCams = cameras.length || Object.keys(trafficData.cameras).length;

  for (const cid in trafficData.cameras) {
    const cam = trafficData.cameras[cid];
    if (!cam) continue;

    if (!cam.history_5m) cam.history_5m = [];
    if (cam.history_5m.length >= 6) {
      cam.history_5m.shift();
    }

    // Keep current calibrated CV density
    const currentDensity = cam.density || 45;
    const hStatus = currentDensity >= 70 ? 'congested' : (currentDensity >= 45 ? 'moderate' : 'flowing');

    cam.history_5m.push({
      min_ago: 0,
      label: 'ปัจจุบัน',
      time: timeStr,
      density: currentDensity,
      status: hStatus
    });

    const len = cam.history_5m.length;
    cam.history_5m.forEach((item, idx) => {
      const ago = len - 1 - idx;
      item.min_ago = ago;
      item.label = ago === 0 ? 'ปัจจุบัน' : `-${ago} นาที`;
    });

    const vals = cam.history_5m.map(h => h.density);
    const avg5m = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    const min5m = Math.min(...vals);
    const max5m = Math.max(...vals);
    const t0 = vals[vals.length - 1];
    const t5 = vals[0];
    const diff = t0 - t5;

    cam.density_5m_avg = avg5m;
    cam.density_min_5m = min5m;
    cam.density_max_5m = max5m;
    cam.trend_diff = (diff >= 0 ? `+${diff}` : `${diff}`) + '%';
    if (diff >= 3) {
      cam.trend_5m = 'increasing';
      cam.trend_th = `↗ กำลังหนาแน่นขึ้น (${cam.trend_diff})`;
    } else if (diff <= -3) {
      cam.trend_5m = 'decreasing';
      cam.trend_th = `↘ กำลังคลี่คลาย (${cam.trend_diff})`;
    } else {
      cam.trend_5m = 'stable';
      cam.trend_th = '→ สภาพคงที่';
    }

    if (avg5m >= 70) {
      cam.status = 'congested';
      cam.status_th = 'ติดขัด';
      cam.desc_th = 'การจราจรติดขัดสะสม เคลื่อนตัวช้าสลับหยุดนิ่ง';
      congestedCount++;
    } else if (avg5m >= 45) {
      cam.status = 'moderate';
      cam.status_th = 'ชะลอตัว';
      cam.desc_th = 'การจราจรชะลอตัว ปริมาณรถปานกลางเคลื่อนตัวได้เรื่อยๆ';
      moderateCount++;
    } else {
      cam.status = 'flowing';
      cam.status_th = 'คล่องตัว';
      cam.desc_th = 'การจราจรคล่องตัว สัญจรสะดวกใช้ความเร็วได้ตามปกติ';
      flowingCount++;
    }

    cam.updated_at = `ย้อนหลัง 5 นาที (${timeStr} น.)`;
    totalDensity += avg5m;
  }

  if (trafficData.summary) {
    trafficData.summary.flowing = flowingCount;
    trafficData.summary.moderate = moderateCount;
    trafficData.summary.congested = congestedCount;
    trafficData.summary.flowing_pct = +(flowingCount / totalCams * 100).toFixed(1);
    trafficData.summary.moderate_pct = +(moderateCount / totalCams * 100).toFixed(1);
    trafficData.summary.congested_pct = +(congestedCount / totalCams * 100).toFixed(1);
    trafficData.summary.avg_density_bkk = +(totalDensity / totalCams).toFixed(1);
    trafficData.summary.updated_at = now.toLocaleTimeString('th-TH') + ' น.';
  }
}

// Slide 5-minute rolling window every 60 seconds
const rollTimer = setInterval(rollTrafficHistory5m, 60000);
if (typeof rollTimer.unref === 'function') rollTimer.unref();

// Concurrency Queue to prevent overwhelming BMA servers
class ConcurrencyQueue {
  constructor(concurrency = 12) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.next();
    });
  }

  next() {
    if (this.running >= this.concurrency || this.queue.length === 0) return;
    const { fn, resolve, reject } = this.queue.shift();
    this.running++;
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        this.running--;
        this.next();
      });
  }
}

const bmaQueue = new ConcurrencyQueue(20);

// Helper to compute fast MD5 hex string
function getMd5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

// Send frame to local CV analyzer service on port 5055 asynchronously
function triggerCvAnalysis(cameraId, currBuffer, prevBuffer) {
  try {
    const payload = JSON.stringify({
      cid: cameraId,
      current_frame: currBuffer.toString('base64'),
      prev_frame: prevBuffer ? prevBuffer.toString('base64') : null
    });

    const opt = {
      hostname: '127.0.0.1',
      port: 5055,
      path: '/analyze',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 2500
    };

    const req = http.request(opt, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.success && trafficData.cameras[cameraId]) {
            const cam = trafficData.cameras[cameraId];
            cam.density = result.density;
            cam.edge_dens = result.edge_dens;
            cam.tex_dens = result.tex_dens;
            cam.motion_pct = result.motion_pct;
            cam.status = result.status;
            cam.status_th = result.status_th;
            cam.speed_est = result.speed_est;
            cam.desc_th = result.desc_th;
            cam.ai_method = result.ai_method;
            cam.updated_at = `ย้อนหลัง 5 นาที (${result.analyzed_at})`;

            if (cam.history_5m && cam.history_5m.length > 0) {
              cam.history_5m[cam.history_5m.length - 1].density = result.density;
              cam.history_5m[cam.history_5m.length - 1].status = result.status;
              const vals = cam.history_5m.map(h => h.density);
              cam.density_5m_avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
            }
          }
        } catch (e) {}
      });
    });

    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (err) {}
}

// BMA Session & Rolling Buffer Manager (Dedicated Session per Camera)
class BmaSessionManager {
  constructor() {
    this.cameraSessions = new Map(); // cameraId -> { cookie, expiry }
    this.sessionPromises = new Map(); // cameraId -> Promise
    this.cameraActivations = new Map(); // cameraId -> timestamp
    this.frameCache = new Map(); // cameraId -> { buffer, timestamp, md5 }
    this.frameRingBuffers = new Map(); // cameraId -> Array of { buffer, timestamp, md5 }
    this.pendingFetches = new Map(); // cameraId -> Promise
    this.activePollers = new Map(); // cameraId -> { workers, lastRequested, running }
    this.lastCvAnalysis = new Map(); // cameraId -> timestamp
    this.activeStreams = new Map(); // cameraId -> stream object
  }

  async getSessionForCamera(cameraId) {
    const existing = this.cameraSessions.get(cameraId);
    if (existing && Date.now() < existing.expiry) {
      return existing.cookie;
    }

    if (this.sessionPromises.has(cameraId)) {
      return this.sessionPromises.get(cameraId);
    }

    const promise = (async () => {
      try {
        const res = await bmaQueue.run(() =>
          fetch(`${BMA_BASE}/index.aspx`, {
            headers: BROWSER_HEADERS,
            signal: AbortSignal.timeout(12000)
          })
        );
        const rawCookie = res.headers.get('set-cookie');
        if (rawCookie) {
          const cookie = rawCookie.split(';')[0];
          const expiry = Date.now() + 15 * 60 * 1000;
          this.cameraSessions.set(cameraId, { cookie, expiry });

          // Bind this specific session to this camera via PlayVideo.aspx
          await bmaQueue.run(() =>
            fetch(`${BMA_BASE}/PlayVideo.aspx?ID=${encodeURIComponent(cameraId)}`, {
              headers: {
                ...BROWSER_HEADERS,
                'Sec-Fetch-Site': 'same-origin',
                'Cookie': cookie,
                'Referer': `${BMA_BASE}/index.aspx`
              },
              signal: AbortSignal.timeout(12000)
            })
          );
          this.cameraActivations.set(cameraId, Date.now());
          return cookie;
        }
        return null;
      } catch (err) {
        console.error(`[BMA] Failed to init dedicated session for camera ${cameraId}:`, err.message);
        return null;
      } finally {
        this.sessionPromises.delete(cameraId);
      }
    })();

    this.sessionPromises.set(cameraId, promise);
    return promise;
  }

  async activateCamera(cameraId, cookie) {
    const lastActivated = this.cameraActivations.get(cameraId) || 0;
    if (Date.now() - lastActivated < 40000) {
      return;
    }

    try {
      await bmaQueue.run(() => 
        fetch(`${BMA_BASE}/PlayVideo.aspx?ID=${encodeURIComponent(cameraId)}`, {
          headers: {
            ...BROWSER_HEADERS,
            'Sec-Fetch-Site': 'same-origin',
            'Cookie': cookie,
            'Referer': `${BMA_BASE}/index.aspx`
          },
          signal: AbortSignal.timeout(12000)
        })
      );
      this.cameraActivations.set(cameraId, Date.now());
    } catch (err) {
      console.error(`[BMA] Error activating camera ${cameraId}:`, err.message);
    }
  }

  async fetchFreshFrame(cameraId) {
    const cookie = await this.getSessionForCamera(cameraId);
    if (!cookie) {
      const cached = this.frameCache.get(cameraId);
      return cached ? cached.buffer : null;
    }

    await this.activateCamera(cameraId, cookie);

    try {
      const now = Date.now();
      const res = await bmaQueue.run(() => 
        fetch(`${BMA_BASE}/show.aspx?image=${encodeURIComponent(cameraId)}&time=${now}`, {
          headers: {
            ...BROWSER_HEADERS,
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Sec-Fetch-Dest': 'image',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'same-origin',
            'Cookie': cookie,
            'Referer': `${BMA_BASE}/PlayVideo.aspx?ID=${encodeURIComponent(cameraId)}`
          },
          signal: AbortSignal.timeout(12000)
        })
      );

      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      if (buffer.length > 2000) {
        noteUpstreamReachable();
        const frameMd5 = getMd5(buffer);
        const cached = this.frameCache.get(cameraId);
        const isDifferent = !cached || cached.md5 !== frameMd5;

        this.frameCache.set(cameraId, { buffer, timestamp: Date.now(), md5: frameMd5 });
        
        // Save to rolling ring buffer (stores last 15 frames for smooth video loop)
        let ring = this.frameRingBuffers.get(cameraId);
        if (!ring) {
          ring = [];
          this.frameRingBuffers.set(cameraId, ring);
        }

        if (isDifferent) {
          const prevBuf = ring.length > 0 ? ring[ring.length - 1].buffer : null;

          // `now` is when the request went out. Responses from a pool come back
          // out of order, so ordering by arrival would make playback jump
          // backwards; request time is the closest stand-in for capture time.
          const frame = { buffer, timestamp: now, md5: frameMd5 };
          const at = ring.findIndex(f => f.timestamp > now);
          if (at === -1) ring.push(frame); else ring.splice(at, 0, frame);
          while (ring.length > RING_MAX_FRAMES) ring.shift();

          // Asynchronous CV Traffic Analysis on new frame, at most once a
          // second - at pump speed every frame would be far too many
          const lastAnalysis = this.lastCvAnalysis.get(cameraId) || 0;
          if (Date.now() - lastAnalysis > 1000) {
            this.lastCvAnalysis.set(cameraId, Date.now());
            triggerCvAnalysis(cameraId, buffer, prevBuf);
          }
        }

        return buffer;
      }

      if (buffer.length <= 2000 && buffer.length > 0) {
        this.cameraSessions.delete(cameraId);
        this.cameraActivations.delete(cameraId);
        const cached = this.frameCache.get(cameraId);
        if (cached && cached.buffer) return cached.buffer;
        return buffer;
      }

      const cached = this.frameCache.get(cameraId);
      return cached ? cached.buffer : null;
    } catch (err) {
      const cached = this.frameCache.get(cameraId);
      return cached ? cached.buffer : null;
    }
  }

  // Instant non-blocking cache return + background refresh if frame is older than 900ms
  async fetchCameraFrame(cameraId) {
    const cached = this.frameCache.get(cameraId);
    if (cached) {
      if (Date.now() - cached.timestamp >= 900 && !this.pendingFetches.has(cameraId)) {
        const fetchPromise = this.fetchFreshFrame(cameraId).finally(() => {
          this.pendingFetches.delete(cameraId);
        });
        this.pendingFetches.set(cameraId, fetchPromise);
      }
      return cached.buffer;
    }

    if (this.pendingFetches.has(cameraId)) {
      return this.pendingFetches.get(cameraId);
    }

    const fetchPromise = this.fetchFreshFrame(cameraId).finally(() => {
      this.pendingFetches.delete(cameraId);
    });

    this.pendingFetches.set(cameraId, fetchPromise);
    return fetchPromise;
  }

  // Keep the ring buffer full for a camera someone is actually watching.
  //
  // Each request costs about 1.35s no matter what, so the only way to raise the
  // frame rate is to have several in flight at once. Workers stop on their own
  // once nobody has asked for this camera for 45 seconds.
  startActivePolling(cameraId, workers = PUMP_WORKERS) {
    const existing = this.activePollers.get(cameraId);
    if (existing) {
      existing.lastRequested = Date.now();
      return;
    }

    const pump = { lastRequested: Date.now(), running: 0 };
    this.activePollers.set(cameraId, pump);

    const worker = async () => {
      pump.running++;
      try {
        while (Date.now() - pump.lastRequested < 45000) {
          try {
            await this.fetchFreshFrame(cameraId);
          } catch (e) {
            // A failed request should slow this worker, not spin it
            await new Promise(r => setTimeout(r, 500));
          }
        }
      } finally {
        pump.running--;
        if (pump.running === 0) this.activePollers.delete(cameraId);
      }
    };

    for (let i = 0; i < workers; i++) worker();
  }

  // The newest frame that is old enough to play, and everything after it
  framesReadyToPlay(cameraId, after) {
    const ring = this.frameRingBuffers.get(cameraId) || [];
    const deadline = Date.now() - PLAYBACK_DELAY_MS;
    return ring.filter(f => f.timestamp <= deadline && (after === null || f.timestamp > after));
  }

  // Subscribe a client response to continuous pipeline MJPEG stream
  subscribeStream(cameraId, res) {
    let stream = this.activeStreams.get(cameraId);
    if (!stream) {
      stream = { subscribers: new Set(), running: false, cleanupTimer: null };
      this.activeStreams.set(cameraId, stream);
    }

    if (stream.cleanupTimer) {
      clearTimeout(stream.cleanupTimer);
      stream.cleanupTimer = null;
    }

    stream.subscribers.add(res);

    // Something to look at straight away, rather than a blank frame while the
    // playback buffer fills. This also flushes the response headers.
    const cached = this.frameCache.get(cameraId);
    if (cached) {
      try {
        res.write(this.mjpegChunk(cached.buffer));
      } catch {}
    }

    // The loop ends as soon as the last viewer leaves, but the stream object
    // lingers for a few seconds. A viewer arriving in that window used to
    // attach to a dead loop and never receive another frame, so start it
    // whenever it is not already running - after the subscriber is added, or
    // it would see an empty set and exit immediately.
    if (!stream.running) this.runStreamLoop(cameraId, stream);

    res.on('close', () => {
      stream.subscribers.delete(res);
      if (stream.subscribers.size === 0) {
        stream.cleanupTimer = setTimeout(() => {
          if (stream.subscribers.size === 0) {
            this.activeStreams.delete(cameraId);
            console.log(`[BMA] Stream stopped for camera ${cameraId}`);
          }
        }, 5000);
      }
    });
  }

  mjpegChunk(buffer) {
    const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`;
    return Buffer.concat([Buffer.from(header), buffer, Buffer.from('\r\n')]);
  }

  // Play out of the ring buffer on a steady tick rather than writing each
  // response as it lands. The pump keeps the buffer full; this loop only
  // decides when to show what, which is what makes the motion even.
  async runStreamLoop(cameraId, stream) {
    stream.running = true;
    let lastSent = null;

    try {
      while (stream.subscribers.size > 0) {
        this.startActivePolling(cameraId);

        const due = this.framesReadyToPlay(cameraId, lastSent);
        if (due.length) {
          // Further behind than the buffer is deep: jump to the newest rather
          // than keep playing further into the past
          const frame = due.length > RING_MAX_FRAMES / 2 ? due[due.length - 1] : due[0];
          lastSent = frame.timestamp;

          const chunk = this.mjpegChunk(frame.buffer);
          for (const sub of stream.subscribers) {
            try {
              sub.write(chunk);
            } catch {
              stream.subscribers.delete(sub);
            }
          }
        }

        await new Promise(r => setTimeout(r, STREAM_TICK_MS));
      }
    } finally {
      stream.running = false;
    }
  }

}

const bmaSession = new BmaSessionManager();

// MIME Types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Live HLS cameras, from the catalogue Longdo's map API reads.
//
// These are a different animal to the BMA feed: real H.264 over HLS, served
// with Access-Control-Allow-Origin: *, needing no session and no key. A
// browser plays them directly, so they work from a deployed host too - which
// the BMA cameras never can.
const VIDEO_CATALOGUE_URL = 'https://camera.longdo.com/feed/?command=json';
// detector/detect.py, when it is running
const DETECTOR_URL = (process.env.DETECTOR_URL || 'http://127.0.0.1:5056').replace(/\/+$/, '');
// Titles are prefixed with the province, so that is the reliable filter -
// coordinates alone drag in Nonthaburi and Pathum Thani.
const BKK_PREFIX = '(\u0e01\u0e23\u0e38\u0e07\u0e40\u0e17\u0e1e\u0e21\u0e2b\u0e32\u0e19\u0e04\u0e23)';
// Drop cameras whose road IS an expressway, but keep city streets that merely
// sit at a junction with one - "\u0e16.\u0e1e\u0e23\u0e30\u0e23\u0e32\u0e214 \u0e41\u0e22\u0e01\u0e17\u0e32\u0e07\u0e14\u0e48\u0e27\u0e19..." is Rama IV, a street.
const EXPRESSWAY_START = /^(\u0e17\u0e32\u0e07\u0e1e\u0e34\u0e40\u0e28\u0e29|\u0e17\u0e32\u0e07\u0e14\u0e48\u0e27\u0e19|\u0e21\u0e2d\u0e40\u0e15\u0e2d\u0e23\u0e4c\u0e40\u0e27\u0e22\u0e4c|motorway)/i;

let videoCameras = { list: [], fetchedAt: 0, error: null };

async function loadVideoCameras() {
  if (videoCameras.list.length && Date.now() - videoCameras.fetchedAt < 10 * 60 * 1000) {
    return videoCameras;
  }

  try {
    const r = await fetch(VIDEO_CATALOGUE_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(`catalogue HTTP ${r.status}`);
    const raw = await r.json();
    const all = Array.isArray(raw) ? raw : (raw.data || raw.cameras || []);

    const list = all
      .filter(c => c.hls_url)
      .map(c => ({
        id: c.camid,
        title: (c.title || '').trim(),
        lat: Number(c.latitude),
        lng: Number(c.longitude),
        org: c.organization || '',
        hls: c.hls_url,
        image: c.imgurl || null
      }))
      .filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lng))
      .filter(c => c.title.startsWith(BKK_PREFIX))
      .map(c => ({ ...c, title: c.title.slice(BKK_PREFIX.length).trim() }))
      .filter(c => !EXPRESSWAY_START.test(c.title));

    // The catalogue keeps cameras that have been taken down, and a dead one
    // renders as a black tile. Ask each stream once per refresh instead.
    const alive = await Promise.all(list.map(async (c) => {
      try {
        const probe = await fetch(c.hls, { signal: AbortSignal.timeout(8000) });
        return probe.ok ? c : null;
      } catch (err) {
        return null;
      }
    }));
    const live = alive.filter(Boolean);

    videoCameras = { list: live, fetchedAt: Date.now(), error: null };
    console.log(`Loaded ${live.length} live video cameras in Bangkok (${list.length - live.length} offline)`);
  } catch (err) {
    // Keep whatever was loaded before rather than emptying the view
    videoCameras = { ...videoCameras, fetchedAt: Date.now(), error: String(err.message || err) };
    console.error('Video camera catalogue failed:', err.message);
  }

  return videoCameras;
}

// Frames published to Cloudflare R2 by publisher/publish-frames.js, for when
// the BMA site cannot be reached from here.
//
// The bucket's public origin is not a secret, so the publisher commits it to
// frames.config.json rather than making someone keep a dashboard variable in
// step by hand. FRAMES_BASE_URL still overrides it.
const FRAMES_BASE_URL = (function resolveFramesBaseUrl() {
  if (process.env.FRAMES_BASE_URL) return process.env.FRAMES_BASE_URL.replace(/\/+$/, '');
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'frames.config.json'), 'utf8'));
    return (config.baseUrl || '').replace(/\/+$/, '');
  } catch (err) {
    return '';
  }
})();
const publishedFrameUrl = (cameraId) =>
  FRAMES_BASE_URL ? `${FRAMES_BASE_URL}/frames/${encodeURIComponent(cameraId)}.jpg` : null;

// Having the URL is not the same as having frames behind it, so confirm by
// reading the manifest the publisher writes each sweep.
let publishedProbe = { ok: false, intervalSeconds: 300, checkedAt: 0 };
async function probePublished() {
  if (!FRAMES_BASE_URL) return false;
  if (Date.now() - publishedProbe.checkedAt < 5 * 60 * 1000) return publishedProbe.ok;

  try {
    const r = await fetch(`${FRAMES_BASE_URL}/frames/manifest.json`, { signal: AbortSignal.timeout(8000) });
    const manifest = r.ok ? await r.json() : null;
    publishedProbe = {
      ok: Boolean(manifest && manifest.count),
      intervalSeconds: (manifest && manifest.intervalSeconds) || 300,
      checkedAt: Date.now()
    };
  } catch (err) {
    publishedProbe = { ok: false, intervalSeconds: 300, checkedAt: Date.now() };
  }
  return publishedProbe.ok;
}

// Where frames come from right now: straight from BMA, from the published
// snapshots, or nowhere.
async function frameSource() {
  if ((await probeUpstream()) === 'ok') return 'live';
  return (await probePublished()) ? 'published' : 'none';
}

// Is the BMA site reachable from here? Its Cloudflare edge answers datacenter
// IPs with a bot challenge, so a deployed host sees no frames at all while a
// machine in Thailand sees them fine. Cached, since this only changes rarely.
let upstreamProbe = { status: 'unknown', checkedAt: 0 };
// A good answer is stable, so trust it for a while. A bad one is often just a
// slow reply while the frame pump has the connection busy, so re-check soon
// rather than writing the upstream off for five minutes.
const UPSTREAM_OK_TTL_MS = 5 * 60 * 1000;
const UPSTREAM_FAIL_TTL_MS = 30 * 1000;

async function probeUpstream() {
  const ttl = upstreamProbe.status === 'ok' ? UPSTREAM_OK_TTL_MS : UPSTREAM_FAIL_TTL_MS;
  if (Date.now() - upstreamProbe.checkedAt < ttl) return upstreamProbe.status;

  try {
    const r = await fetch(`${BMA_BASE}/index.aspx`, {
      headers: BROWSER_HEADERS,
      // index.aspx is a 450 KB page and takes ~2.5s unloaded; 8s was tight
      // enough that ordinary slowness read as a block
      signal: AbortSignal.timeout(20000)
    });
    upstreamProbe = {
      status: r.ok && r.headers.get('set-cookie') ? 'ok' : 'blocked',
      checkedAt: Date.now()
    };
  } catch (err) {
    upstreamProbe = { status: 'blocked', checkedAt: Date.now() };
  }
  return upstreamProbe.status;
}

// A frame that just arrived proves the upstream is reachable, whatever the
// last probe concluded.
function noteUpstreamReachable() {
  if (upstreamProbe.status !== 'ok') upstreamProbe = { status: 'ok', checkedAt: Date.now() };
}

// An <img> pointed at a 503 shows the browser's broken-image icon, so answer
// with a picture that says what happened instead.
const PLACEHOLDER_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="266" viewBox="0 0 400 266">' +
  '<rect width="400" height="266" fill="#0f172a"/>' +
  '<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#64748b" ' +
  'font-size="14" font-family="sans-serif">\u0e20\u0e32\u0e1e\u0e44\u0e21\u0e48\u0e1e\u0e23\u0e49\u0e2d\u0e21\u0e43\u0e0a\u0e49\u0e07\u0e32\u0e19</text>' +
  '</svg>',
  'utf8'
);

function sendPlaceholder(res) {
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': PLACEHOLDER_SVG.length,
    'Cache-Control': 'no-store',
    'X-Frame-Source': 'unavailable'
  });
  res.end(PLACEHOLDER_SVG);
}

// Redirect to the published frame when BMA itself is out of reach. A redirect
// keeps the image on the blob CDN instead of pushing every byte through the
// function; returns false when there is nothing published to point at.
async function servePublishedFrame(cameraId, res) {
  const url = publishedFrameUrl(cameraId);
  if (!url) return false;
  if ((await frameSource()) !== 'published') return false;

  res.writeHead(302, {
    'Location': url,
    'Cache-Control': 'no-cache, private',
    'X-Frame-Source': 'published'
  });
  res.end();
  return true;
}

// Same decision, but with the bytes in hand (for endpoints that inline frames)
async function fetchPublishedFrame(cameraId) {
  const url = publishedFrameUrl(cameraId);
  if (!url) return null;
  if ((await frameSource()) !== 'published') return null;

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const buffer = Buffer.from(await r.arrayBuffer());
    return buffer.length > 2000 ? buffer : null;
  } catch (err) {
    return null;
  }
}

const requestHandler = async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API Routes ---

  // 1. Cameras with traffic & district filters
  if (pathname === '/api/cameras') {
    let result = cameras;
    const districtQuery = parsedUrl.query.district;
    const searchQuery = parsedUrl.query.search;
    const trafficQuery = parsedUrl.query.traffic; // 'flowing' | 'moderate' | 'congested'

    // Attach traffic data to cameras
    result = result.map(c => ({
      ...c,
      traffic: trafficData.cameras[c.id] || {
        status: 'flowing',
        status_th: 'คล่องตัว',
        density: 25,
        speed_est: '45-60 กม./ชม.'
      }
    }));

    if (districtQuery && districtQuery !== 'all') {
      result = result.filter(c => 
        c.district_th === districtQuery || 
        c.district_en.toLowerCase() === districtQuery.toLowerCase() ||
        c.district_code === districtQuery
      );
    }

    if (trafficQuery && trafficQuery !== 'all') {
      result = result.filter(c => c.traffic && c.traffic.status === trafficQuery);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(c => 
        c.id.includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.name_en.toLowerCase().includes(q) ||
        c.desc.toLowerCase().includes(q) ||
        c.district_th.toLowerCase().includes(q) ||
        c.district_en.toLowerCase().includes(q)
      );
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ total: result.length, cameras: result }));
    return;
  }

  // 2. Traffic Analysis Summary & Per-Camera Data
  if (pathname === '/api/traffic-analysis') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(trafficData));
    return;
  }

  // Single Camera Traffic Analysis
  if (pathname.startsWith('/api/traffic-analysis/')) {
    const cameraId = pathname.replace('/api/traffic-analysis/', '').split('/')[0];
    const data = trafficData.cameras[cameraId] || {
      id: cameraId,
      status: 'flowing',
      status_th: 'คล่องตัว',
      density: 30,
      speed_est: '45-60 กม./ชม.'
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
    return;
  }

  // Probe the upstream BMA handshake, so a blank camera feed can be told apart
  // from a broken deploy. Tries several header sets, since the BMA WAF answers
  // 403 to some clients depending on where the request comes from.
  if (pathname === '/api/health/bma') {
    const cameraId = (parsedUrl.query.id || (cameras[0] && cameras[0].id) || '1078').toString();

    const variants = {
      'user-agent only': { 'User-Agent': USER_AGENT },
      'full browser headers': BROWSER_HEADERS
    };

    const results = [];
    for (const [name, headers] of Object.entries(variants)) {
      const t = Date.now();
      try {
        const r = await fetch(`${BMA_BASE}/index.aspx`, { headers, signal: AbortSignal.timeout(15000) });
        const body = await r.text();
        results.push({
          variant: name,
          ms: Date.now() - t,
          status: r.status,
          setCookie: r.headers.get('set-cookie') ? 'present' : 'MISSING',
          server: r.headers.get('server'),
          via: r.headers.get('via') || r.headers.get('cf-ray') || r.headers.get('x-cdn'),
          bytes: body.length,
          snippet: body.replace(/\s+/g, ' ').slice(0, 400)
        });
      } catch (err) {
        results.push({ variant: name, ms: Date.now() - t, error: err.name + ': ' + err.message });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      cameraId,
      serverless: IS_SERVERLESS,
      region: process.env.VERCEL_REGION || null,
      results
    }, null, 2));
    return;
  }

  // Why published frames are or are not being used. FRAMES_BASE_URL is a public
  // bucket URL, so reporting it here gives nothing away.
  if (pathname === '/api/health/frames') {
    const configPath = path.join(ROOT_DIR, 'frames.config.json');
    const result = {
      framesBaseUrlSet: Boolean(FRAMES_BASE_URL),
      framesBaseUrl: FRAMES_BASE_URL || null,
      source: process.env.FRAMES_BASE_URL ? 'env' : (FRAMES_BASE_URL ? 'frames.config.json' : 'none'),
      rootDir: ROOT_DIR,
      configPath,
      configExists: fs.existsSync(configPath),
      manifest: null
    };

    if (FRAMES_BASE_URL) {
      const url = `${FRAMES_BASE_URL}/frames/manifest.json`;
      const started = Date.now();
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const body = await r.text();
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { /* report the raw body instead */ }
        result.manifest = {
          url,
          ms: Date.now() - started,
          status: r.status,
          contentType: r.headers.get('content-type'),
          count: parsed && parsed.count,
          updatedAt: parsed && parsed.updatedAt,
          snippet: parsed ? undefined : body.replace(/\s+/g, ' ').slice(0, 200)
        };
      } catch (err) {
        result.manifest = { url, ms: Date.now() - started, error: err.name + ': ' + err.message };
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // Vehicle detection, from detector/detect.py. It is optional: when the
  // detector is not running these answer "off" rather than failing, so the
  // page simply shows no counts.
  if (pathname === '/api/detections'
      || pathname === '/api/detect-focus'
      || pathname.startsWith('/api/detect-frame/')) {
    const isFrame = pathname.startsWith('/api/detect-frame/');
    let target;
    if (isFrame) {
      target = `${DETECTOR_URL}/frame/${encodeURIComponent(pathname.slice('/api/detect-frame/'.length))}`;
    } else if (pathname === '/api/detect-focus') {
      // Tells the detector which camera is being watched, so it can work on
      // that one continuously instead of once a sweep
      target = `${DETECTOR_URL}/focus?id=${encodeURIComponent(parsedUrl.query.id || '')}`;
    } else {
      const one = parsedUrl.query.id ? `?id=${encodeURIComponent(parsedUrl.query.id)}` : '';
      target = `${DETECTOR_URL}/detections${one}`;
    }

    try {
      const r = await fetch(target, { signal: AbortSignal.timeout(10000) });
      const body = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, {
        'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(body);
    } catch (err) {
      if (isFrame) {
        sendPlaceholder(res);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ enabled: false, detections: [] }));
      }
    }
    return;
  }

  // Longdo's overall traffic index, the one number their own sites show.
  // Proxied so the page is not making a jsonp call of its own.
  if (pathname === '/api/traffic-index') {
    try {
      const r = await fetch(`https://traffic.longdo.com/api/json/traffic/index?time=${Date.now()}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(8000)
      });
      const body = await r.text();
      res.writeHead(r.ok ? 200 : 502, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60'
      });
      res.end(body);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }

  // Cameras a browser can play by itself, wherever it is
  if (pathname === '/api/video-cameras') {
    const { list, fetchedAt, error } = await loadVideoCameras();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300'
    });
    res.end(JSON.stringify({ total: list.length, updatedAt: fetchedAt, error, cameras: list }));
    return;
  }

  // Runtime capabilities, so the client knows whether MJPEG streaming is available
  if (pathname === '/api/config') {
    const upstream = await probeUpstream();
    const frames = await frameSource();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      serverless: IS_SERVERLESS,
      mjpeg: !IS_SERVERLESS,
      upstream,
      frames,
      publishedIntervalSeconds: publishedProbe.intervalSeconds,
      frameBaseUrl: frames === 'published' ? FRAMES_BASE_URL : null
    }));
    return;
  }

  if (pathname === '/api/districts') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ total: districts.length, districts: districts }));
    return;
  }

  if (pathname.startsWith('/api/cameras/')) {
    const cameraId = pathname.replace('/api/cameras/', '').split('/')[0];
    const cam = cameras.find(c => c.id === cameraId);
    if (!cam) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Camera not found' }));
      return;
    }
    const merged = {
      ...cam,
      traffic: trafficData.cameras[cameraId] || null
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(merged));
    return;
  }

  // Live MJPEG Stream (Continuous Pipeline)
  if (pathname.startsWith('/api/stream/')) {
    const cameraId = pathname.replace('/api/stream/', '').split('?')[0];
    const cam = cameras.find(c => c.id === cameraId);
    if (!cam) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Camera ID not found');
      return;
    }

    // A serverless invocation cannot keep a multipart response open, so fall back
    // to a single fresh JPEG. The <img> still renders; the client refreshes it.
    if (IS_SERVERLESS) {
      if (await servePublishedFrame(cameraId, res)) return;

      const frame = await bmaSession.fetchCameraFrame(cameraId);
      if (!frame) {
        sendPlaceholder(res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': frame.length,
        'Cache-Control': 'no-store'
      });
      res.end(frame);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, private, no-transform',
      'Connection': 'close',
      'Pragma': 'no-cache'
    });
    // Node holds headers back until the first write, and the first frame is a
    // few seconds out, so the client would see nothing at all until then.
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    bmaSession.subscribeStream(cameraId, res);
    return;
  }

  // Buffered sequence of distinct frames for ultra-smooth 60 FPS playback
  if (pathname.startsWith('/api/buffer/')) {
    const cameraId = pathname.replace('/api/buffer/', '').split('?')[0];
    const cam = cameras.find(c => c.id === cameraId);
    if (!cam) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Camera not found' }));
      return;
    }

    const publishedFrame = await fetchPublishedFrame(cameraId);
    if (publishedFrame) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, private' });
      res.end(JSON.stringify({
        id: cameraId,
        total_frames: 1,
        frames: [{
          data: 'data:image/jpeg;base64,' + publishedFrame.toString('base64'),
          timestamp: Date.now(),
          md5: getMd5(publishedFrame)
        }],
        traffic: trafficData.cameras[cameraId] || null,
        fps: 60,
        source: 'published'
      }));
      return;
    }

    bmaSession.startActivePolling(cameraId);

    let ring = bmaSession.frameRingBuffers.get(cameraId);
    if (!ring || ring.length === 0) {
      const cached = bmaSession.frameCache.get(cameraId);
      if (cached) {
        ring = [cached];
      } else {
        const frame = await bmaSession.fetchCameraFrame(cameraId);
        if (frame) {
          const cached2 = bmaSession.frameCache.get(cameraId);
          ring = cached2 ? [cached2] : [];
        } else {
          ring = [];
        }
      }
    }

    const frames = ring.map(item => ({
      data: 'data:image/jpeg;base64,' + item.buffer.toString('base64'),
      timestamp: item.timestamp,
      md5: item.md5
    }));

    const traffic = trafficData.cameras[cameraId] || null;

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, private'
    });
    res.end(JSON.stringify({
      id: cameraId,
      total_frames: frames.length,
      frames: frames,
      traffic: traffic,
      fps: 60
    }));
    return;
  }

  // Fast Snapshot (Instant from cache with background poller)
  if (pathname.startsWith('/api/snapshot/')) {
    const cameraId = pathname.replace('/api/snapshot/', '').split('?')[0];
    const cam = cameras.find(c => c.id === cameraId);
    if (!cam) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Camera ID not found');
      return;
    }

    if (await servePublishedFrame(cameraId, res)) return;

    // Keep active polling alive for viewed cameras
    bmaSession.startActivePolling(cameraId);

    const frame = await bmaSession.fetchCameraFrame(cameraId);
    if (!frame) {
      sendPlaceholder(res);
      return;
    }

    const cached = bmaSession.frameCache.get(cameraId);
    const md5Str = cached && cached.md5 ? cached.md5 : '';

    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': frame.length,
      'Cache-Control': 'public, max-age=1',
      'ETag': `"${md5Str}"`,
      'X-Camera-Id': cameraId,
      'X-Frame-Time': cached ? String(cached.timestamp) : String(Date.now())
    });
    res.end(frame);
    return;
  }

  // Offline Map Tiles (Cached locally in data/tiles/ without any API key, watermark, or access block)
  if (pathname.startsWith('/api/map/tiles/')) {
    const parts = pathname.replace('/api/map/tiles/', '').split('/');
    if (parts.length >= 3) {
      const z = parts[0];
      const x = parts[1];
      const y = parts[2].replace('.png', '').split('?')[0];

      const bundledTilePath = path.join(ROOT_DIR, 'data', 'tiles', z, x, `${y}.png`);
      // Only /tmp is writable on serverless, so newly fetched tiles are cached there.
      const tileFilePath = WRITABLE_TILE_DIR
        ? path.join(WRITABLE_TILE_DIR, z, x, `${y}.png`)
        : bundledTilePath;

      // Tiles shipped with the repo are read-only but still serveable.
      if (WRITABLE_TILE_DIR && fs.existsSync(bundledTilePath)) {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable'
        });
        fs.createReadStream(bundledTilePath).pipe(res);
        return;
      }

      if (fs.existsSync(tileFilePath)) {
        try {
          const stats = fs.statSync(tileFilePath);
          if (stats.size > 8000) {
            res.writeHead(200, {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'public, max-age=31536000, immutable'
            });
            fs.createReadStream(tileFilePath).pipe(res);
            return;
          } else {
            // Remove corrupted or blocked placeholder
            fs.unlinkSync(tileFilePath);
          }
        } catch (e) {}
      }

      // Fetch on-demand and cache locally (ESRI World Street Map & OSM DE fallback)
      const esriUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`;
      const osmDeUrl = `https://tile.openstreetmap.de/${z}/${x}/${y}.png`;

      for (const tileUrl of [esriUrl, osmDeUrl]) {
        try {
          const tileRes = await fetch(tileUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(6000)
          });
          if (tileRes.ok) {
            if (tileRes.headers.get('x-blocked')) continue;
            const buffer = Buffer.from(await tileRes.arrayBuffer());
            if (buffer.length < 8000) continue; // Skip blocked placeholder

            try {
              fs.mkdirSync(path.dirname(tileFilePath), { recursive: true });
              fs.writeFileSync(tileFilePath, buffer);
            } catch (writeErr) {
              // Read-only filesystem: serve the tile without caching it.
            }

            const cType = tileUrl.includes('arcgisonline') ? 'image/jpeg' : 'image/png';
            res.writeHead(200, {
              'Content-Type': cType,
              'Cache-Control': 'public, max-age=31536000, immutable'
            });
            res.end(buffer);
            return;
          }
        } catch (err) {
          // try next provider
        }
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Tile not found');
    return;
  }

  // Static File Serving
  let filePath = path.join(ROOT_DIR, 'public', pathname === '/' ? 'index.html' : pathname);

  if (!filePath.startsWith(path.join(ROOT_DIR, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const indexPath = path.join(ROOT_DIR, 'public', 'index.html');
      fs.readFile(indexPath, (readErr, content) => {
        if (readErr) {
          res.writeHead(404);
          res.end('Not Found');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(content);
        }
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // The page and its code change often, and without this browsers cache them
    // heuristically - which is why edits kept appearing not to take effect.
    // Images and fonts are fine to hold on to.
    const revalidate = ['.html', '.js', '.css', '.json'].includes(ext);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=3600',
      'Last-Modified': stats.mtime.toUTCString()
    });
    fs.createReadStream(filePath).pipe(res);
  });
};

// Never let a thrown error take the whole function down with a bare
// FUNCTION_INVOCATION_FAILED - answer with a readable 500 instead.
const safeHandler = async (req, res) => {
  try {
    await requestHandler(req, res);
  } catch (err) {
    console.error('Unhandled request error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Internal Server Error', message: String(err && err.message || err) }));
    } else {
      res.end();
    }
  }
};

// Vercel imports this handler (see api/index.js); it must not open a port.
module.exports = safeHandler;
module.exports.default = safeHandler;

if (!IS_SERVERLESS) {
  const server = http.createServer(safeHandler);

  server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 BMA Traffic CCTV Dashboard is running!`);
    console.log(`👉 Web Interface:       http://localhost:${PORT}`);
    console.log(`📊 Traffic Analysis:    http://localhost:${PORT}/api/traffic-analysis`);
    console.log(`📡 MJPEG Stream URL:    http://localhost:${PORT}/api/stream/:id`);
    console.log(`📷 Snapshot URL:        http://localhost:${PORT}/api/snapshot/:id`);
    console.log(`=======================================================`);
  });
}
