#!/usr/bin/env node
/**
 * BMA frame publisher.
 *
 * The BMA site sits behind Cloudflare, whose edge answers datacenter IPs with a
 * bot challenge, so the deployed dashboard cannot fetch camera frames at all.
 * This script runs on a machine that CAN reach it - your Mac in Bangkok - grabs
 * a frame per camera and uploads it to Vercel Blob, where the deployed site
 * reads it instead.
 *
 *   node publisher/publish-frames.js --once     one sweep, then exit
 *   node publisher/publish-frames.js            sweep every INTERVAL_SECONDS
 *
 * Needs BLOB_READ_WRITE_TOKEN in the environment (or in .env.local).
 */

const fs = require('node:fs');
const path = require('node:path');

const BMA_BASE = 'https://cpudapp.bangkok.go.th/bmatraffic';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'no-cache'
};

const ROOT = path.join(__dirname, '..');
const INTERVAL_SECONDS = Number(process.env.INTERVAL_SECONDS || 30);
const CONCURRENCY = Number(process.env.CONCURRENCY || 12);
const RUN_ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');

// --- Config ----------------------------------------------------------------

// Minimal .env.local reader, so the token does not have to be exported by hand
function loadEnvFile() {
  const envPath = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '');
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
}

function loadCameraIds() {
  if (process.env.PUBLISH_CAMERA_IDS) {
    return process.env.PUBLISH_CAMERA_IDS.split(',').map(s => s.trim()).filter(Boolean);
  }
  const listPath = path.join(__dirname, 'cameras.json');
  return JSON.parse(fs.readFileSync(listPath, 'utf8')).cameras;
}

// --- BMA client ------------------------------------------------------------

// One ASP.NET session per camera: index.aspx hands out the cookie, PlayVideo.aspx
// binds it to a camera, and only then does show.aspx return that camera's frame.
const sessions = new Map(); // cameraId -> { cookie, expiry }

async function getSession(cameraId) {
  const existing = sessions.get(cameraId);
  if (existing && Date.now() < existing.expiry) return existing.cookie;

  const res = await fetch(`${BMA_BASE}/index.aspx`, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(15000)
  });
  const rawCookie = res.headers.get('set-cookie');
  if (!rawCookie) {
    throw new Error(`no session cookie (HTTP ${res.status}) - this machine is being challenged by Cloudflare`);
  }
  const cookie = rawCookie.split(';')[0];

  await fetch(`${BMA_BASE}/PlayVideo.aspx?ID=${encodeURIComponent(cameraId)}`, {
    headers: { ...BROWSER_HEADERS, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie, Referer: `${BMA_BASE}/index.aspx` },
    signal: AbortSignal.timeout(15000)
  });

  sessions.set(cameraId, { cookie, expiry: Date.now() + 10 * 60 * 1000 });
  return cookie;
}

async function fetchFrame(cameraId) {
  const cookie = await getSession(cameraId);
  const res = await fetch(`${BMA_BASE}/show.aspx?image=${encodeURIComponent(cameraId)}&time=${Date.now()}`, {
    headers: {
      ...BROWSER_HEADERS,
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: cookie,
      Referer: `${BMA_BASE}/PlayVideo.aspx?ID=${encodeURIComponent(cameraId)}`
    },
    signal: AbortSignal.timeout(15000)
  });

  const buffer = Buffer.from(await res.arrayBuffer());
  // Anything this small is an error page or a placeholder, not a frame
  if (buffer.length <= 2000) {
    sessions.delete(cameraId);
    throw new Error(`frame too small (${buffer.length} bytes, HTTP ${res.status})`);
  }
  return buffer;
}

// --- Upload ----------------------------------------------------------------

let put;
function loadBlobClient() {
  if (DRY_RUN) return;
  try {
    ({ put } = require('@vercel/blob'));
  } catch (err) {
    console.error('Missing @vercel/blob. Run:  npm install');
    process.exit(1);
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('Missing BLOB_READ_WRITE_TOKEN.');
    console.error('Create a Blob store in the Vercel dashboard, then put its token in .env.local:');
    console.error('  BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...');
    process.exit(1);
  }
}

async function upload(pathname, body, contentType) {
  if (DRY_RUN) return `dry-run://${pathname}`;
  const result = await put(pathname, body, {
    access: 'public',
    contentType,
    addRandomSuffix: false,   // stable URL, so the site can link straight to it
    allowOverwrite: true,
    cacheControlMaxAge: 60, // the blob API's floor; the site busts it per interval
    token: process.env.BLOB_READ_WRITE_TOKEN
  });
  return result.url;
}

// --- Sweep -----------------------------------------------------------------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function sweep(cameraIds) {
  const startedAt = Date.now();
  const published = {};
  let failed = 0;

  await mapWithConcurrency(cameraIds, CONCURRENCY, async (cameraId) => {
    try {
      const frame = await fetchFrame(cameraId);
      const url = await upload(`frames/${cameraId}.jpg`, frame, 'image/jpeg');
      published[cameraId] = { url, bytes: frame.length, ts: Date.now() };
    } catch (err) {
      failed++;
      console.error(`  ${cameraId}: ${err.message}`);
    }
  });

  const manifest = {
    updatedAt: new Date().toISOString(),
    intervalSeconds: INTERVAL_SECONDS,
    count: Object.keys(published).length,
    cameras: published
  };
  const manifestUrl = await upload('frames/manifest.json', JSON.stringify(manifest), 'application/json');
  if (DRY_RUN) {
    const sizes = Object.values(published).map(p => p.bytes);
    const total = sizes.reduce((a, b) => a + b, 0);
    console.log(`  dry run: ${sizes.length} frames, ${(total / 1024).toFixed(0)} KB total, nothing uploaded`);
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[${new Date().toLocaleTimeString('th-TH')}] published ${manifest.count}/${cameraIds.length} frames in ${seconds}s${failed ? ` (${failed} failed)` : ''}`);
  return manifestUrl;
}

async function main() {
  loadEnvFile();
  loadBlobClient();

  const cameraIds = loadCameraIds();
  console.log(`Publishing ${cameraIds.length} cameras every ${INTERVAL_SECONDS}s (concurrency ${CONCURRENCY})`);

  const manifestUrl = await sweep(cameraIds);
  const baseUrl = manifestUrl.replace(/\/frames\/manifest\.json$/, '');
  if (!DRY_RUN) {
    console.log('');
    console.log('Set this on the Vercel project (Settings -> Environment Variables), then redeploy:');
    console.log(`  BLOB_BASE_URL=${baseUrl}`);
    console.log('');
  }

  if (RUN_ONCE) return;

  // The first sweep is the slow one: every camera needs its own session
  // handshake. Later sweeps reuse the cached cookies and are far quicker.
  let running = false;
  setInterval(async () => {
    if (running) {
      console.log('  previous sweep still running, skipping this tick');
      return;
    }
    running = true;
    try {
      await sweep(cameraIds);
    } catch (err) {
      console.error('sweep failed:', err.message);
    } finally {
      running = false;
    }
  }, INTERVAL_SECONDS * 1000);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
