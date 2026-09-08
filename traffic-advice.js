/**
 * Signal advice from the colours on the traffic map.
 *
 * The map draws Longdo's traffic tiles: one line per road segment, coloured by
 * how well it is moving. Those tiles carry no road names - only `fillcolor`,
 * `fillcolor_r` and a road class - so a segment on its own cannot be reported as
 * "Rama IV". What it can be tied to is a camera: every camera has a name and a
 * position, so the colours around one become that road's reading.
 *
 * Two things the data does not support, and which this therefore does not do:
 *
 * The reverse colour is mostly absent - around one camera, 6 of 63 segments
 * carried one - so comparing a road's two directions would be comparing five
 * kilometres of one against four hundred metres of the other. Both directions
 * are pooled instead, and the split is only reported when each side has enough
 * road behind it to mean something.
 *
 * And a colour says how full a road looks, not how many vehicles arrive per
 * minute or how long a queue takes to discharge. So the advice is about which
 * way to lean - hold traffic back, or let it through - and the timings are a
 * starting point for someone who can watch the junction, not a setting to apply
 * unseen.
 */

'use strict';

// Longdo paints each segment one of three colours. Anything else (no data, or a
// road too quiet to rate) is left out rather than guessed at.
const LEVELS = {
  '54C00C': { key: 'flowing', weight: 0, label: 'คล่องตัว' },
  'FEDE04': { key: 'slow', weight: 55, label: 'ชะลอตัว' },
  'FF2020': { key: 'jam', weight: 100, label: 'ติดขัด' }
};

const TRAFFIC_TILE = 'https://msv.longdo.com/maps/traffic/{z}/{x}/{y}.pbf';
const TILE_ZOOM = 12;
// How far from a camera a segment still counts as its road. Bangkok blocks run
// 300-600m, so this reaches the junction's approaches without pulling in the
// parallel road one block over.
const RADIUS_M = 700;
// Below this there is not enough road behind a number to report it.
const MIN_ROAD_M = 200;
const MIN_DIRECTION_M = 300;

// --- Vector tile reading ---------------------------------------------------
//
// Only the parts of the Mapbox Vector Tile spec this needs: a layer's keys,
// values, and each feature's tags and line geometry. Written out rather than
// pulled from a library so the server keeps its zero-dependency install.

function reader(buf) {
  return { buf, pos: 0 };
}

function varint(r) {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = r.buf[r.pos++];
    value += (byte & 0x7f) * Math.pow(2, shift);
    if (!(byte & 0x80)) return value;
    shift += 7;
  }
}

function zigzag(n) {
  return (n >>> 1) ^ -(n & 1);
}

/** Walk a message, handing each field to `visit(fieldNumber, reader, end)`. */
function eachField(r, end, visit) {
  while (r.pos < end) {
    const key = varint(r);
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 2) {
      const len = varint(r);
      const stop = r.pos + len;
      visit(field, r, stop);
      r.pos = stop;
    } else if (wire === 0) {
      const value = varint(r);
      visit(field, r, r.pos, value);
    } else if (wire === 5) {
      r.pos += 4;
    } else if (wire === 1) {
      r.pos += 8;
    } else {
      throw new Error('unsupported wire type ' + wire);
    }
  }
}

function readString(r, end) {
  return r.buf.toString('utf8', r.pos, end);
}

function readValue(r, end) {
  let out = null;
  eachField(r, end, (field, rr, stop, scalar) => {
    if (field === 1) out = readString(rr, stop);
    else if (field === 4 || field === 5) out = scalar;
    else if (field === 6) out = zigzag(scalar);
    else if (field === 7) out = Boolean(scalar);
  });
  return out;
}

/**
 * Line geometry as arrays of [x, y] in tile units.
 *
 * Coordinates are deltas driven by command integers - MoveTo starts a line,
 * LineTo continues it - so they have to be replayed in order to get positions.
 */
function readGeometry(r, end) {
  const lines = [];
  let line = null;
  let x = 0;
  let y = 0;
  while (r.pos < end) {
    const command = varint(r);
    const id = command & 7;
    const count = command >> 3;
    if (id === 1) {
      for (let i = 0; i < count; i++) {
        x += zigzag(varint(r));
        y += zigzag(varint(r));
        line = [[x, y]];
        lines.push(line);
      }
    } else if (id === 2) {
      for (let i = 0; i < count; i++) {
        x += zigzag(varint(r));
        y += zigzag(varint(r));
        if (line) line.push([x, y]);
      }
    } else {
      break; // ClosePath: polygons, which the traffic layer does not use
    }
  }
  return lines;
}

/** Every traffic segment in one tile, as { lines, props, extent }. */
function decodeTile(buffer) {
  const out = [];
  const r = reader(buffer);
  eachField(r, buffer.length, (field, rr, layerEnd) => {
    if (field !== 3) return;
    const layer = { name: null, keys: [], values: [], features: [], extent: 4096 };
    const lr = reader(rr.buf);
    lr.pos = rr.pos;
    eachField(lr, layerEnd, (lf, r2, end2, scalar) => {
      if (lf === 1) layer.name = readString(r2, end2);
      else if (lf === 2) layer.features.push([r2.pos, end2]);
      else if (lf === 3) layer.keys.push(readString(r2, end2));
      else if (lf === 4) layer.values.push(readValue(r2, end2));
      else if (lf === 5) layer.extent = scalar;
    });
    if (layer.name !== 'traffic') return;

    for (const [start, stop] of layer.features) {
      const fr = reader(rr.buf);
      fr.pos = start;
      const tags = [];
      let lines = [];
      eachField(fr, stop, (ff, r3, end3) => {
        if (ff === 2) {
          while (r3.pos < end3) tags.push(varint(r3));
        } else if (ff === 4) {
          lines = readGeometry(r3, end3);
        }
      });
      const props = {};
      for (let i = 0; i + 1 < tags.length; i += 2) {
        props[layer.keys[tags[i]]] = layer.values[tags[i + 1]];
      }
      out.push({ lines, props, extent: layer.extent });
    }
  });
  return out;
}

// --- Geography -------------------------------------------------------------

function tileToLngLat(tx, ty, px, py, extent, z) {
  const scale = Math.pow(2, z);
  const worldX = tx + px / extent;
  const worldY = ty + py / extent;
  const lng = (worldX / scale) * 360 - 180;
  const n = Math.PI * (1 - (2 * worldY) / scale);
  const lat = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  return [lng, lat];
}

function lngLatToTile(lng, lat, z) {
  const scale = Math.pow(2, z);
  const x = ((lng + 180) / 360) * scale;
  const rad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale;
  return [Math.floor(x), Math.floor(y)];
}

/** Metres between two points, flat-earth: fine over a few hundred metres. */
function distanceM(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * 110540;
  const dLng = (lng2 - lng1) * 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

// --- Scoring ---------------------------------------------------------------

const LEVEL_LABEL = { flowing: 'คล่องตัว', slow: 'ชะลอตัว', jam: 'ติดขัด' };

/**
 * How bad a stretch of road is, from its average and from how much of it is
 * stopped.
 *
 * The average alone hides the case that matters most. A corridor a third of
 * which is solid red and the rest green averages to 39 of 100, which reads as
 * "slow" - but a third of it is not moving, and that is the part an operator
 * has to do something about. So a large enough red share raises the level on
 * its own.
 */
function levelOf(value, jamShare = 0) {
  if (value >= 60 || jamShare >= 30) return 'jam';
  if (value >= 25 || jamShare >= 15) return 'slow';
  return 'flowing';
}

/**
 * Congestion 0-100 over a set of coloured stretches, each weighted by how long
 * it is - so a jammed side street cannot outvote a clear main road.
 */
function score(parts, minimumM) {
  let weighted = 0;
  let length = 0;
  const tally = { flowing: 0, slow: 0, jam: 0 };
  for (const part of parts) {
    weighted += part.level.weight * part.metres;
    length += part.metres;
    tally[part.level.key] += part.metres;
  }
  if (length < minimumM) return null;
  const value = Math.round(weighted / length);
  const share = {
    flowing: Math.round((tally.flowing / length) * 100),
    slow: Math.round((tally.slow / length) * 100),
    jam: Math.round((tally.jam / length) * 100)
  };
  const level = levelOf(value, share.jam);
  return {
    score: value,
    level,
    label: LEVEL_LABEL[level],
    km: Math.round(length / 100) / 10,
    share
  };
}

// --- What to do ------------------------------------------------------------

/**
 * The one rule worth stating plainly: green time only helps when the road ahead
 * has somewhere to put the traffic. A jam with clear roads around it is a local
 * problem and more green will drain it; a jam with jams around it means the exit
 * is full, and more green just moves the queue to the next junction.
 *
 * `peer` is the middle reading across the other roads, which is what separates
 * the two cases. Measuring against every coloured road on the tiles instead
 * drowns the comparison in empty outer suburbs: it came out at 9 of 100 over
 * three thousand kilometres, a baseline nothing could ever look busy against.
 */
function adviceFor(road, peer, directions) {
  if (!road) {
    return {
      action: 'unknown',
      headline: 'ไม่มีข้อมูลจราจรรอบจุดนี้',
      detail: 'แผนที่ยังไม่ได้ระบายสีถนนบริเวณนี้ อาจเป็นช่วงที่รถน้อยเกินกว่าจะประเมิน'
    };
  }

  // Which way to lean, when there is enough of both directions to tell them apart
  let lean = '';
  let heaviest = road;
  if (directions) {
    const { forward, reverse } = directions;
    const gap = Math.abs(forward.score - reverse.score);
    const heavy = forward.score > reverse.score ? forward : reverse;
    if (gap >= 25) {
      const which = heavy === forward ? 'ขาไป' : 'ขากลับ';
      lean = ` ทิศ${which}หนักกว่าอีกทิศชัดเจน (${heavy.score} ต่อ ${gap === 0 ? 0 : Math.min(forward.score, reverse.score)}) ให้เริ่มจากทิศนั้นก่อน`;
      // One direction standing still is worth acting on even when pooling it
      // with the clear direction averages the problem away
      if (heavy.score > road.score) heaviest = heavy;
    }
  }

  const peerBusy = peer !== null && peer >= 45;
  const worseThanPeers = peer !== null && road.score - peer >= 15;

  if (heaviest.level === 'jam' && peerBusy) {
    return {
      action: 'meter',
      headline: 'อย่าเพิ่มไฟเขียว — หน่วงรถเข้าพื้นที่แทน',
      detail:
        'ติดทั้งย่าน ไม่ใช่เฉพาะถนนนี้ แปลว่าปลายทางเต็ม การเพิ่มเวลาเขียวจะดันรถไปกองที่แยกถัดไป ' +
        'ควรลดรอบสัญญาณให้สั้นลงเหลือ 60-80 วินาที เพื่อให้แต่ละแยกได้ระบายถี่ขึ้น ' +
        'และหน่วงการปล่อยจากซอยกับทางขนานเข้าถนนหลักไว้ก่อน จนกว่าจะเริ่มมีที่ว่างด้านหน้า' +
        lean
    };
  }

  if (heaviest.level === 'jam') {
    return {
      action: 'release',
      headline: 'เพิ่มไฟเขียวให้ทิศที่ติด ~15-25 วินาที/รอบ',
      detail:
        'ติดเฉพาะถนนนี้ ถนนรอบข้างยังไหลอยู่ จึงมีที่ให้รถออกไปและมีเวลาให้ย้ายมาได้ ' +
        'ตัดเวลาเขียวจากทิศที่คล่องตัวมาให้ทิศที่ติด แล้วดูสองสามรอบสัญญาณ ' +
        'ถ้าไม่ดีขึ้นเลยแปลว่าไม่ใช่เรื่องสัญญาณ ให้ตรวจสิ่งกีดขวางหรือรถเสียด้านหน้า' +
        lean
    };
  }

  if (heaviest.level === 'slow' && worseThanPeers) {
    return {
      action: 'release',
      headline: 'เริ่มเพิ่มไฟเขียวทิศที่ติดได้ ~10-15 วินาที/รอบ',
      detail:
        'ถนนนี้ชะลอตัวกว่าย่านรอบข้าง ยังแก้ได้ก่อนจะกลายเป็นติดขัด ' +
        'ขยับเวลาเขียวเล็กน้อยมาให้ทิศที่หนักกว่า แล้วเฝ้าดูอีก 5-10 นาที' +
        lean
    };
  }

  if (heaviest.level === 'slow') {
    return {
      action: 'watch',
      headline: 'เฝ้าดู ยังไม่ต้องปรับ',
      detail:
        'ชะลอตัวพอ ๆ กับย่านรอบข้าง การย้ายเวลาเขียวตอนนี้จะย้ายคิวไปอีกทิศเฉย ๆ ' +
        'ถ้าอีก 5-10 นาทีแย่ลงชัดเจนค่อยปรับ' + lean
    };
  }

  return {
    action: 'normal',
    headline: 'ใช้รอบสัญญาณปกติ',
    detail: 'ถนนไหลดี ไม่ต้องปรับอะไร การขยับเวลาตอนนี้มีแต่จะสร้างคิวที่ยังไม่มี'
  };
}

// --- Putting it together ---------------------------------------------------

async function fetchTile(z, x, y, fetchImpl, userAgent) {
  const url = TRAFFIC_TILE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': userAgent, Referer: 'https://traffic.longdo.com/' },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * One advice card per road, built from the traffic colours near its cameras.
 *
 * Cameras sharing a name are one road: several look at Bangna-Trat, and the
 * junction they watch is the same one.
 */
async function buildAdvice(cameras, { fetchImpl = fetch, userAgent = 'Mozilla/5.0' } = {}) {
  const located = cameras.filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));

  const wanted = new Map();
  for (const cam of located) {
    const [tx, ty] = lngLatToTile(cam.lng, cam.lat, TILE_ZOOM);
    // A camera near an edge needs its neighbours, or half its road is missing
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        wanted.set(`${tx + dx}/${ty + dy}`, [tx + dx, ty + dy]);
      }
    }
  }

  const segments = [];
  const failures = [];
  await Promise.all(
    [...wanted.values()].map(async ([tx, ty]) => {
      let features;
      try {
        features = decodeTile(await fetchTile(TILE_ZOOM, tx, ty, fetchImpl, userAgent));
      } catch (err) {
        failures.push(`${tx}/${ty}: ${err.message}`);
        return;
      }
      for (const feature of features) {
        const forward = LEVELS[feature.props.fillcolor];
        const reverse = LEVELS[feature.props.fillcolor_r];
        if (!forward && !reverse) continue;
        for (const line of feature.lines) {
          for (let i = 0; i + 1 < line.length; i++) {
            const a = tileToLngLat(tx, ty, line[i][0], line[i][1], feature.extent, TILE_ZOOM);
            const b = tileToLngLat(tx, ty, line[i + 1][0], line[i + 1][1], feature.extent, TILE_ZOOM);
            segments.push({
              lat: (a[1] + b[1]) / 2,
              lng: (a[0] + b[0]) / 2,
              metres: distanceM(a[1], a[0], b[1], b[0]),
              forward,
              reverse
            });
          }
        }
      }
    })
  );

  const byName = new Map();
  for (const cam of located) {
    const name = (cam.title || cam.id).trim();
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(cam);
  }

  const roads = [];
  for (const [name, group] of byName) {
    const pooled = [];
    const forward = [];
    const reverse = [];
    for (const seg of segments) {
      const near = group.some((cam) => distanceM(cam.lat, cam.lng, seg.lat, seg.lng) <= RADIUS_M);
      if (!near) continue;
      if (seg.forward) {
        pooled.push({ level: seg.forward, metres: seg.metres });
        forward.push({ level: seg.forward, metres: seg.metres });
      }
      if (seg.reverse) {
        pooled.push({ level: seg.reverse, metres: seg.metres });
        reverse.push({ level: seg.reverse, metres: seg.metres });
      }
    }

    const congestion = score(pooled, MIN_ROAD_M);
    const f = score(forward, MIN_DIRECTION_M);
    const r = score(reverse, MIN_DIRECTION_M);
    // Only worth showing when each side has enough road to stand on
    const directions = f && r ? { forward: f, reverse: r } : null;

    roads.push({
      name,
      cameras: group.map((c) => ({ id: c.id, title: c.title })),
      lat: group[0].lat,
      lng: group[0].lng,
      congestion,
      directions
    });
  }

  // The middle road, so one gridlocked corridor cannot make the rest look calm
  // and a quiet night cannot make a busy corridor look normal
  const rated = roads
    .filter((r) => r.congestion)
    .map((r) => r.congestion.score)
    .sort((a, b) => a - b);
  const peer = rated.length ? rated[Math.floor(rated.length / 2)] : null;
  for (const road of roads) {
    road.advice = adviceFor(road.congestion, peer, road.directions);
  }

  roads.sort((a, b) => (b.congestion ? b.congestion.score : -1) - (a.congestion ? a.congestion.score : -1));

  return {
    updatedAt: Date.now(),
    tiles: wanted.size,
    segments: segments.length,
    peer,
    roads,
    error: failures.length ? failures.slice(0, 3).join('; ') : null
  };
}

module.exports = { buildAdvice, decodeTile, tileToLngLat, lngLatToTile, distanceM };
