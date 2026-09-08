#!/usr/bin/env node
/**
 * Traffic history logger.
 *
 * Longdo publishes live road conditions as vector tiles, but only ever "now" -
 * there is no history and no forecast. Forecasting needs a past to learn from,
 * so this samples the tiles covering Bangkok on an interval and keeps them.
 *
 * Tiles are stored whole rather than decoded, since decoding now would throw
 * away detail that later analysis might want. fetch un-gzips the response, so
 * they are re-compressed on the way to disk - about a third of the size.
 * Use logger/decode-traffic.py to turn a run into a table.
 *
 *   node logger/log-traffic.js --once     one sample, then exit
 *   node logger/log-traffic.js            sample every INTERVAL_MINUTES
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const TILE_URL = 'https://msv.longdo.com/maps/traffic/{z}/{x}/{y}.pbf';
const INDEX_URL = 'https://traffic.longdo.com/api/json/traffic/index';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OUT_DIR = process.env.TRAFFIC_LOG_DIR || path.join(__dirname, '..', 'data', 'traffic-history');
const INTERVAL_MINUTES = Number(process.env.INTERVAL_MINUTES || 5);
const ZOOM = Number(process.env.TRAFFIC_ZOOM || 12); // the tiles' own maximum
const RUN_ONCE = process.argv.includes('--once');

// Greater Bangkok
const BOUNDS = { minLat: 13.49, maxLat: 13.96, minLng: 100.32, maxLng: 100.94 };

const lngToX = (lng, z) => Math.floor((lng + 180) / 360 * 2 ** z);
const latToY = (lat, z) =>
  Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);

function tilesForBounds(z) {
  const tiles = [];
  for (let x = lngToX(BOUNDS.minLng, z); x <= lngToX(BOUNDS.maxLng, z); x++) {
    for (let y = latToY(BOUNDS.maxLat, z); y <= latToY(BOUNDS.minLat, z); y++) {
      tiles.push({ z, x, y });
    }
  }
  return tiles;
}

async function fetchTile({ z, x, y }) {
  const url = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchIndex() {
  try {
    const res = await fetch(`${INDEX_URL}?time=${Date.now()}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10000)
    });
    return res.ok ? await res.json() : null;
  } catch (err) {
    return null;
  }
}

async function sample(tiles) {
  const at = new Date();
  // One directory per day keeps a long run navigable
  const day = at.toISOString().slice(0, 10);
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  const dir = path.join(OUT_DIR, day, stamp);

  let written = 0;
  let bytes = 0;
  const failures = [];

  for (const t of tiles) {
    try {
      const buf = await fetchTile(t);
      const gz = zlib.gzipSync(buf, { level: 9 });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${t.z}-${t.x}-${t.y}.pbf.gz`), gz);
      written++;
      bytes += gz.length;
    } catch (err) {
      failures.push(err.message);
    }
  }

  if (!written) {
    console.error(`[${at.toLocaleTimeString('th-TH')}] no tiles: ${failures[0] || 'unknown'}`);
    return;
  }

  const index = await fetchIndex();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    at: at.toISOString(),
    zoom: ZOOM,
    tiles: written,
    bytes,
    trafficIndex: index ? index.index : null,
    failures
  }, null, 2) + '\n');

  console.log(
    `[${at.toLocaleTimeString('th-TH')}] ${written}/${tiles.length} tiles, ` +
    `${(bytes / 1024).toFixed(0)} KB` +
    (index ? `, index ${index.index}` : '') +
    (failures.length ? `, ${failures.length} failed` : '')
  );
}

async function main() {
  const tiles = tilesForBounds(ZOOM);
  // measured: about 3 KB a tile once re-compressed
  const perDay = (24 * 60 / INTERVAL_MINUTES) * tiles.length * 3 / 1024;

  console.log(`Sampling ${tiles.length} tiles at zoom ${ZOOM} every ${INTERVAL_MINUTES} min`);
  console.log(`Writing to ${OUT_DIR} - roughly ${perDay.toFixed(0)} MB a day`);

  await sample(tiles);
  if (RUN_ONCE) return;

  let running = false;
  setInterval(async () => {
    if (running) return;         // a slow sample must not stack on the next tick
    running = true;
    try {
      await sample(tiles);
    } catch (err) {
      console.error('sample failed:', err.message);
    } finally {
      running = false;
    }
  }, INTERVAL_MINUTES * 60 * 1000);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
