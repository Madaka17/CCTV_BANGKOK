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
const BMA_BASE = 'https://cpudapp.bangkok.go.th/bmatraffic';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
    this.activePollers = new Map(); // cameraId -> { timer, lastRequested }
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
            headers: { 'User-Agent': USER_AGENT }
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
                'User-Agent': USER_AGENT,
                'Cookie': cookie,
                'Referer': `${BMA_BASE}/index.aspx`
              }
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
            'User-Agent': USER_AGENT,
            'Cookie': cookie,
            'Referer': `${BMA_BASE}/index.aspx`
          }
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
            'User-Agent': USER_AGENT,
            'Cookie': cookie,
            'Referer': `${BMA_BASE}/PlayVideo.aspx?ID=${encodeURIComponent(cameraId)}`
          }
        })
      );

      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      if (buffer.length > 2000) {
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
          ring.push({ buffer, timestamp: Date.now(), md5: frameMd5 });
          if (ring.length > 15) ring.shift();

          // Asynchronous CV Traffic Analysis on new frame
          triggerCvAnalysis(cameraId, buffer, prevBuf);
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

  // Active poller for cameras actively viewed (modal or wall) to ensure high-cadence fresh frames
  startActivePolling(cameraId) {
    if (this.activePollers.has(cameraId)) {
      this.activePollers.get(cameraId).lastRequested = Date.now();
      return;
    }

    const poller = {
      lastRequested: Date.now(),
      timer: null
    };

    const poll = async () => {
      if (Date.now() - poller.lastRequested > 45000) {
        if (poller.timer) clearInterval(poller.timer);
        this.activePollers.delete(cameraId);
        return;
      }
      try {
        await this.fetchFreshFrame(cameraId);
      } catch (e) {}
    };

    poller.timer = setInterval(poll, 1100);
    if (typeof poller.timer.unref === 'function') poller.timer.unref();
    this.activePollers.set(cameraId, poller);
    poll();
  }

  // Subscribe a client response to continuous pipeline MJPEG stream
  subscribeStream(cameraId, res) {
    let stream = this.activeStreams.get(cameraId);
    if (!stream) {
      stream = {
        subscribers: new Set(),
        running: false,
        cleanupTimer: null
      };
      this.activeStreams.set(cameraId, stream);

      const streamLoop = async () => {
        stream.running = true;
        while (stream.subscribers.size > 0) {
          const frame = await this.fetchFreshFrame(cameraId);
          if (frame && stream.subscribers.size > 0) {
            const boundary = '--frame\r\n';
            const header = `Content-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
            const chunk = Buffer.concat([
              Buffer.from(boundary + header),
              frame,
              Buffer.from('\r\n')
            ]);

            for (const sub of stream.subscribers) {
              try {
                sub.write(chunk);
              } catch {
                stream.subscribers.delete(sub);
              }
            }
          }
          await new Promise(r => setTimeout(r, 30));
        }
        stream.running = false;
      };

      streamLoop().catch(console.error);
    }

    if (stream.cleanupTimer) {
      clearTimeout(stream.cleanupTimer);
      stream.cleanupTimer = null;
    }

    stream.subscribers.add(res);

    const cached = this.frameCache.get(cameraId);
    if (cached) {
      const boundary = '--frame\r\n';
      const header = `Content-Type: image/jpeg\r\nContent-Length: ${cached.buffer.length}\r\n\r\n`;
      try {
        res.write(Buffer.concat([
          Buffer.from(boundary + header),
          cached.buffer,
          Buffer.from('\r\n')
        ]));
      } catch {}
    }

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

// Fresh BMA session cookie, bypassing the cache (used by the health check)
async function freshBmaCookie(cameraId) {
  bmaSession.cameraSessions.delete(cameraId);
  return bmaSession.getSessionForCamera(cameraId);
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

  // Step-by-step check of the upstream BMA handshake, so a blank camera feed
  // can be told apart from a broken deploy.
  if (pathname === '/api/health/bma') {
    const cameraId = (parsedUrl.query.id || (cameras[0] && cameras[0].id) || '1078').toString();
    const steps = [];
    const step = async (name, fn) => {
      const t = Date.now();
      try {
        const info = await fn();
        steps.push({ step: name, ok: true, ms: Date.now() - t, ...info });
        return info;
      } catch (err) {
        steps.push({ step: name, ok: false, ms: Date.now() - t, error: err.name + ': ' + err.message });
        return null;
      }
    };

    const index = await step('GET index.aspx', async () => {
      const r = await fetch(`${BMA_BASE}/index.aspx`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15000)
      });
      const body = await r.text();
      return {
        status: r.status,
        contentType: r.headers.get('content-type'),
        setCookie: r.headers.get('set-cookie') ? 'present' : 'MISSING',
        bytes: body.length
      };
    });

    if (index && index.setCookie === 'present') {
      const cookie = await freshBmaCookie(cameraId);
      await step(`GET show.aspx?image=${cameraId}`, async () => {
        const r = await fetch(`${BMA_BASE}/show.aspx?image=${encodeURIComponent(cameraId)}&time=${Date.now()}`, {
          headers: {
            'User-Agent': USER_AGENT,
            'Cookie': cookie || '',
            'Referer': `${BMA_BASE}/PlayVideo.aspx?ID=${encodeURIComponent(cameraId)}`
          },
          signal: AbortSignal.timeout(15000)
        });
        const buf = Buffer.from(await r.arrayBuffer());
        return { status: r.status, contentType: r.headers.get('content-type'), bytes: buf.length };
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ cameraId, serverless: IS_SERVERLESS, region: process.env.VERCEL_REGION || null, steps }, null, 2));
    return;
  }

  // Runtime capabilities, so the client knows whether MJPEG streaming is available
  if (pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ serverless: IS_SERVERLESS, mjpeg: !IS_SERVERLESS }));
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
      const frame = await bmaSession.fetchCameraFrame(cameraId);
      if (!frame) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Camera feed unavailable');
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

    // Keep active polling alive for viewed cameras
    bmaSession.startActivePolling(cameraId);

    const frame = await bmaSession.fetchCameraFrame(cameraId);
    if (!frame) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Camera feed unavailable');
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
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
        }
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
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
