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

const { buildAdvice } = require('./traffic-advice.js');

const PORT = process.env.PORT || 3000;

// --- Serverless (Vercel) compatibility -------------------------------------
// On Vercel this file is loaded as a serverless function: there is no long-lived
// process, the filesystem is read-only (except /tmp), and a response cannot stay
// open forever. These flags let the same file run both locally and on Vercel.
const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const WRITABLE_TILE_DIR = IS_SERVERLESS ? '/tmp/bma-tiles' : null;

// The Vercel bundler may place this file in a subdirectory, so locate the folder
// that actually contains public/ instead of trusting __dirname.
const ROOT_DIR = (function findRoot() {
  const candidates = [__dirname, path.join(__dirname, '..'), process.cwd(), '/var/task'];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'public', 'index.html'))) return dir;
    } catch (e) { /* try next candidate */ }
  }
  return __dirname;
})();
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ADVICE_TTL_MS = 5 * 60 * 1000;
let adviceCache = { at: 0, data: null };

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


// Persistent HTTPS Agent with connection pooling
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 16,
  timeout: 60000
});




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
// The province in the title used to be the filter. It is accurate, but it stops
// at the city line, and the roads a Bangkok driver queues on do not: this box
// adds 11 cameras titled for a neighbour - Kanchanaphisek at Bang Yai and
// Chaeng Watthana (Nonthaburi, 4), Bang Na-Bang Pakong km 6 and Ratburana-Phra
// Samut Chedi (Samut Prakan, 4), Krathum Lom-Phutthamonthon (Nakhon Pathom, 2)
// and Lam Luk Ka km 9 (Pathum Thani, 1). The last two provinces are the price:
// they are commuter corridors rather than city streets, and the earlier comment
// here warned about exactly them. Tighten the box if their cards read as noise.
// The prefix is still how a Bangkok title gets tidied up.
const BKK_BOX = { south: 13.49, north: 13.96, west: 100.32, east: 100.94 };
const BKK_PREFIX = '(\u0e01\u0e23\u0e38\u0e07\u0e40\u0e17\u0e1e\u0e21\u0e2b\u0e32\u0e19\u0e04\u0e23)';
// Anything else keeps its province, so a card can say it is not in the city.
const PROVINCE_PREFIX = /^\([^)]*\)\s*/;
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
      .filter(c => c.lat >= BKK_BOX.south && c.lat <= BKK_BOX.north
                && c.lng >= BKK_BOX.west && c.lng <= BKK_BOX.east)
      .map(c => c.title.startsWith(BKK_PREFIX)
        ? { ...c, title: c.title.slice(BKK_PREFIX.length).trim() }
        : c)
      .filter(c => !EXPRESSWAY_START.test(c.title.replace(PROVINCE_PREFIX, '')));

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
    console.log(`Loaded ${live.length} live video cameras around Bangkok (${list.length - live.length} offline)`);
  } catch (err) {
    // Keep whatever was loaded before rather than emptying the view
    videoCameras = { ...videoCameras, fetchedAt: Date.now(), error: String(err.message || err) };
    console.error('Video camera catalogue failed:', err.message);
  }

  return videoCameras;
}


// Browsers held on to an old app.js through several changes, and no-cache only
// helps once they have fetched it. The page is small and always revalidated, so
// stamp its asset URLs with the file's mtime: a changed file is a changed URL,
// which no cache can get wrong.
function stampAssets(html) {
  return html.replace(/(src|href)="(\/(?:js|css)\/[^"?]+)"/g, (match, attr, url) => {
    try {
      const stamp = Math.floor(fs.statSync(path.join(ROOT_DIR, 'public', url)).mtimeMs);
      return `${attr}="${url}?v=${stamp}"`;
    } catch (err) {
      return match; // not one of ours; leave it alone
    }
  });
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

// Where recorder/record.py writes. Not under the working copy: this one is
// inside a OneDrive sync root, and an archive there would be uploaded.
const RECORDINGS_DIR = process.env.CCTV_DIR || 'D:/CCTV';

// A camera id is a path segment here, so it has to be one that cannot climb
// out of the archive directory. Dots are allowed - dates and .mp4 need them -
// so ".." clears this pattern and is rejected on its own below.
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function insideArchive(parts) {
  if (!parts.length) return null;
  for (const part of parts) {
    if (!SAFE_SEGMENT.test(part) || part === '.' || part === '..') return null;
  }
  // Resolve and compare against the archive root itself. Checking against
  // root + camera is no check at all when the camera segment is "..".
  const base = path.resolve(RECORDINGS_DIR);
  const file = path.resolve(base, ...parts);
  return file.startsWith(base + path.sep) ? file : null;
}

// The page asks every thirty seconds so a new frame shows up soon after the
// round that wrote it, but the archive only changes every ten minutes. Holding
// the answer briefly keeps that from walking 29 directories per viewer per ask.
let recordingsCache = { at: 0, data: null };
const RECORDINGS_TTL_MS = 15 * 1000;

function listRecordings() {
  if (recordingsCache.data && Date.now() - recordingsCache.at < RECORDINGS_TTL_MS) {
    return recordingsCache.data;
  }

  let cameras;
  try {
    cameras = fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true });
  } catch (err) {
    // Not cached: the recorder may be starting, and the next ask should look
    return { dir: RECORDINGS_DIR, recording: false, cameras: [] };
  }

  const out = [];
  for (const entry of cameras) {
    if (!entry.isDirectory() || !SAFE_SEGMENT.test(entry.name)) continue;
    const dir = path.join(RECORDINGS_DIR, entry.name);
    // A day is a folder of clips, one per round, named for the moment the
    // camera was read. The page plays them in order and moves to the next when
    // one ends, so it needs the list, not just the newest.
    const byDay = new Map();
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.length !== 10) continue;
      const clips = fs.readdirSync(path.join(dir, item.name))
        .filter(f => f.endsWith('.mp4') && !f.includes('.writing.'))
        .sort();
      if (clips.length) byDay.set(item.name, clips);
    }
    if (!byDay.size) continue;

    const dayNames = [...byDay.keys()].sort();
    const newest = dayNames[dayNames.length - 1];
    // Only the newest day's list travels. A day is at most 144 clips a camera,
    // and every viewer asks for this every thirty seconds.
    const clips = byDay.get(newest).map(f => `${newest}/${f}`);
    out.push({
      id: entry.name,
      day: newest,
      clips,
      latest: clips[clips.length - 1],
      days: dayNames.map(d => ({ day: d, clips: byDay.get(d).length }))
        .sort((a, b) => a.day < b.day ? 1 : -1)
    });
  }
  const data = { dir: RECORDINGS_DIR, recording: out.length > 0, cameras: out };
  recordingsCache = { at: Date.now(), data };
  return data;
}

// A ten minute clip is around 150 MB. Without this a browser has to take the
// whole file before it can play any of it, and cannot seek within it at all.
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!match || (!match[1] && !match[2])) return null;
  // "bytes=-500" is the last 500 bytes, not a range starting at nothing
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start > end || start >= size ? null : { start, end };
}

function sendRecording(res, rest, rangeHeader) {
  const parts = rest.split('/').filter(Boolean);
  const file = parts.length >= 2 ? insideArchive(parts) : null;
  if (!file) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad path');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'no recording' }));
    return;
  }

  const mp4 = file.endsWith('.mp4');
  const headers = {
    'Content-Type': mp4 ? 'video/mp4' : 'image/jpeg',
    // A clip never changes once it is in place; the recorder writes under
    // .writing.mp4 and moves it here only when ffmpeg has finished with it
    'Cache-Control': mp4 ? 'public, max-age=86400' : 'no-store',
    'Accept-Ranges': 'bytes'
  };

  const range = parseRange(rangeHeader, stat.size);
  if (range) {
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'Content-Length': range.end - range.start + 1
    });
    fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(file).pipe(res);
}

function sendPlaceholder(res) {
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': PLACEHOLDER_SVG.length,
    'Cache-Control': 'no-store',
    'X-Frame-Source': 'unavailable'
  });
  res.end(PLACEHOLDER_SVG);
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


  // What recorder/record.py kept: ten minutes of one camera per file, listed
  // in the order they were recorded and handed over a range at a time.
  //
  // The archive lives outside the working copy, which sits under a OneDrive
  // sync root, so it is reached by path rather than served from public/.
  if (pathname === '/api/recordings' || pathname.startsWith('/api/recording/')) {
    if (pathname === '/api/recordings') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(listRecordings(), null, 2));
      return;
    }
    sendRecording(res, pathname.slice('/api/recording/'.length), req.headers.range);
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
  // Reading the traffic tiles means fetching 28 of them and decoding 30,000
  // segments. Longdo repaints roughly every five minutes, so asking more often
  // than that costs bandwidth and returns the same colours.
  if (pathname === '/api/traffic-advice') {
    try {
      if (!adviceCache.data || Date.now() - adviceCache.at > ADVICE_TTL_MS) {
        const { list } = await loadVideoCameras();
        adviceCache = {
          at: Date.now(),
          data: await buildAdvice(list, { userAgent: USER_AGENT })
        };
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300'
      });
      res.end(JSON.stringify(adviceCache.data));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(err.message || err), roads: [] }));
    }
    return;
  }

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
            const body = Buffer.from(stampAssets(content.toString('utf8')), 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': body.length,
            'Cache-Control': 'no-cache'
          });
          res.end(body);
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

    if (ext === '.html') {
      fs.readFile(filePath, 'utf8', (htmlErr, html) => {
        if (htmlErr) { res.writeHead(500); res.end('Read error'); return; }
        const body = Buffer.from(stampAssets(html), 'utf8');
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': body.length,
          'Cache-Control': 'no-cache'
        });
        res.end(body);
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      // A stamped URL is safe to keep; an unstamped one must be rechecked
      'Cache-Control': parsedUrl.query.v ? 'public, max-age=31536000, immutable'
                                         : (revalidate ? 'no-cache' : 'public, max-age=3600'),
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
    console.log(`Bangkok traffic, from Longdo's camera catalogue`);
    console.log(`  web         http://localhost:${PORT}`);
    console.log(`  cameras     http://localhost:${PORT}/api/video-cameras`);
    console.log(`  recordings  http://localhost:${PORT}/api/recordings`);
    console.log(`  advice      http://localhost:${PORT}/api/traffic-advice`);
    console.log(`=======================================================`);
  });
}
