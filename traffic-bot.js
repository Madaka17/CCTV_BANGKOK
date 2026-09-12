/**
 * AI Traffic Chatbot Engine for Bangkok CCTV Live.
 * Supports Gemini API (if key provided) or Built-in Intelligent Traffic Engine (Offline/Local RAG).
 */

const https = require('https');

/**
 * Builds a markdown and structured summary of live traffic context for the LLM or built-in engine.
 */
function buildTrafficContext(cameras, adviceData, detectionsData, trafficIndex) {
  const cams = cameras || [];
  const roads = (adviceData && adviceData.roads) || [];
  const detections = (detectionsData && detectionsData.detections) || [];
  const detMap = new Map(detections.map(d => [d.id, d]));

  // Overview stats
  const totalCams = cams.length;
  const activeDetections = detections.filter(d => d.total !== null);
  const totalVehiclesCounted = activeDetections.reduce((sum, d) => sum + (d.total || 0), 0);

  // Group vehicles by type
  const vehicleTypes = { car: 0, motorcycle: 0, bus: 0, truck: 0 };
  activeDetections.forEach(d => {
    if (d.counts) {
      Object.entries(d.counts).forEach(([k, v]) => {
        if (vehicleTypes[k] !== undefined) vehicleTypes[k] += v;
      });
    }
  });

  // Top congested roads by Longdo advice score
  const sortedRoads = [...roads].sort((a, b) => {
    const sA = (a.congestion && a.congestion.score) || 0;
    const sB = (b.congestion && b.congestion.score) || 0;
    return sB - sA;
  });

  // Signal advice breakdown
  const meterRoads = roads.filter(r => r.advice && r.advice.action === 'meter');
  const releaseRoads = roads.filter(r => r.advice && r.advice.action === 'release');

  // Cameras with high vehicle counts
  const busyCams = [...activeDetections].sort((a, b) => (b.total || 0) - (a.total || 0));

  return {
    totalCams,
    trafficIndex: trafficIndex || 'ไม่ระบุ',
    totalVehiclesCounted,
    vehicleTypes,
    sortedRoads,
    meterRoads,
    releaseRoads,
    busyCams,
    detMap,
    cams
  };
}

// --- Major Bangkok Navigation Corridors & Bypass Routes ---
const ROUTE_PRESETS = [
  {
    id: 'dmk_sathorn',
    name: 'ดอนเมือง / วิภาวดี ➔ สาทร / สีลม',
    defaultOrigin: 'สนามบินดอนเมือง',
    defaultDest: 'ถนนสาทร กรุงเทพมหานคร',
    origins: ['ดอนเมือง', 'วิภาวดี', 'หลักสี่', 'ดินแดง', 'โทลล์เวย์', 'รังสิต', 'พหลโยธิน'],
    dests: ['สาทร', 'สีลม', 'พระราม4', 'พระรามสี่', 'คลองเตย', 'ลุมพินี'],
    match: ['ดอนเมือง', 'วิภาวดี', 'หลักสี่', 'สาทร', 'สีลม', 'พระราม4', 'พระรามสี่', 'ดินแดง'],
    primary: {
      name: 'ทางด่วนเฉลิมมหานคร (ลงทางด่วนพระราม 4)',
      waypoint: 'ด่วนดินแดง',
      cams: ['DOH-PER-3-008', 'ITICM_BMAMI0074', 'ITICM_BMAMI0071'],
      via: 'ดอนเมืองโทลล์เวย์ ➔ ด่วนดินแดง ➔ ลงแยกทางด่วนพระราม 4 ➔ ถ.สาทร'
    },
    bypass: {
      name: 'ทางด่วนศรีรัช (ลงด่วนสีลม / ถ.สาทรเหนือ)',
      waypoint: 'ทางพิเศษศรีรัช',
      cams: ['DOH-PER-3-008', 'ITICM_BMAMI0076'],
      via: 'ดอนเมืองโทลล์เวย์ ➔ เชื่อมต่อด่วนศรีรัช ➔ ลงด่านสีลม หรือ ถ.สาทรเหนือโดยตรง'
    },
    tip: 'หากแยกพระราม 4 มีรถสะสม ให้เลือกเบี่ยงลงด่านสีลมแทน จะเลี่ยงคอขวดแยกพระราม 4 ได้สนิท'
  },
  {
    id: 'bangyai_cbd',
    name: 'บางใหญ่ / นนทบุรี ➔ พระราม 4 / อโศก',
    defaultOrigin: 'แยกบางใหญ่ นนทบุรี',
    defaultDest: 'แยกอโศก สุขุมวิท กรุงเทพมหานคร',
    origins: ['บางใหญ่', 'นนทบุรี', 'กาญจนาภิเษก', 'แคราย', 'รัตนาธิเบศร์', 'งามวงศ์วาน', 'บางบัวทอง'],
    dests: ['พระราม4', 'พระรามสี่', 'อโศก', 'รัชดา', 'รัชวิภา', 'สุขุมวิท', 'เพลินจิต', 'สยาม'],
    match: ['บางใหญ่', 'นนทบุรี', 'กาญจนาภิเษก', 'แคราย', 'รัตนาธิเบศร์', 'งามวงศ์วาน', 'พระราม4', 'อโศก', 'รัชดา'],
    primary: {
      name: 'รัตนาธิเบศร์ ➔ งามวงศ์วาน ➔ รัชวิภา ➔ รัชดาภิเษก',
      waypoint: 'แยกงามวงศ์วาน',
      cams: ['DOH-PER-3-006', 'DOH-PER-9-026-out', 'ITICM_BMAMI0211', 'ITICM_BMAMI0074'],
      via: 'ถ.กาญจนาภิเษก ➔ ถ.รัตนาธิเบศร์ ➔ แยกแคราย ➔ ประชานุกูล ➔ รัชวิภา ➔ รัชดาภิเษก'
    },
    bypass: {
      name: 'ทางพิเศษประจิมรัถยา (ด่วนศรีรัช-วงแหวนรอบนอก ข้ามสะพานพระราม 7)',
      waypoint: 'ทางพิเศษประจิมรัถยา',
      cams: ['DOH-PER-3-006', 'ITICM_BMAMI0166', 'ITICM_BMAMI0076'],
      via: 'ขึ้นด่วนประจิมรัถยา ด่านบางบัวทอง/กาญจนาภิเษก ➔ ข้ามสะพานพระราม 7 ➔ เชื่อมต่อด่วนศรีรัชลงใจกลางเมือง'
    },
    tip: 'ประหยัดเวลาหลบแยกแครายและแยกประชานุกูลได้ประมาณ 25-35 นาทีในช่วงเร่งด่วน'
  },
  {
    id: 'thonburi_sathorn',
    name: 'ฝั่งธนบุรี / ราชพฤกษ์ ➔ สาทร / สีลม',
    defaultOrigin: 'ถนนราชพฤกษ์ ธนบุรี',
    defaultDest: 'ถนนสาทร กรุงเทพมหานคร',
    origins: ['ธนบุรี', 'ฝั่งธน', 'ตากสิน', 'สะพานตากสิน', 'ราชพฤกษ์', 'กัลปพฤกษ์', 'เจริญนคร', 'กรุงธนบุรี', 'วงเวียนใหญ่'],
    dests: ['สาทร', 'สีลม', 'พระราม3', 'พระรามสาม', 'นราธิวาส', 'บางรัก', 'สี่พระยา'],
    match: ['ธนบุรี', 'ฝั่งธน', 'ตากสิน', 'สะพานตากสิน', 'ราชพฤกษ์', 'กัลปพฤกษ์', 'เจริญนคร', 'กรุงธนบุรี', 'สาทร', 'สีลม'],
    primary: {
      name: 'ถ.กรุงธนบุรี ข้ามสะพานสมเด็จพระเจ้าตากสิน ➔ สาทรเหนือ/ใต้',
      waypoint: 'สะพานสมเด็จพระเจ้าตากสิน',
      cams: ['ITICM_BMAMI0080', 'ITICM_BMAMI0081', 'ITICM_BMAMI0076'],
      via: 'ถ.ราชพฤกษ์/กัลปพฤกษ์ ➔ ถ.กรุงธนบุรี ➔ ข้ามสะพานตากสิน ➔ เข้าสู่ ถ.สาทร'
    },
    bypass: {
      name: 'ข้ามสะพานพระราม 3 หรือ สะพานกรุงเทพ ➔ เข้า ถ.พระราม 3 ➔ ถ.นราธิวาสราชนครินทร์',
      waypoint: 'สะพานพระราม 3',
      cams: ['ITICM_BMAMI0080', 'ITICM_BMAMI0076'],
      via: 'เบี่ยงจาก ถ.สมเด็จพระเจ้าตากสิน ➔ ข้ามสะพานพระราม 3 ➔ ถ.พระราม 3 ➔ ถ.นราธิวาสฯ เลี่ยงสะพานตากสิน'
    },
    tip: 'สะพานตากสินมักมีท้ายแถวสะสม การเบี่ยงไปสะพานพระราม 3 เข้า ถ.นราธิวาสราชนครินทร์จะช่วยหลบแถวคอยบนสะพานสาทรได้'
  },
  {
    id: 'bangna_rama2',
    name: 'บางนา-ตราด ➔ พระราม 2 / บางปะกอก',
    defaultOrigin: 'สี่แยกบางนา',
    defaultDest: 'ถนนพระราม 2 กรุงเทพมหานคร',
    origins: ['บางนา', 'บางปะกง', 'สมุทรปราการ', 'อุดมสุข', 'แบริ่ง', 'สำโรง'],
    dests: ['พระราม2', 'พระรามสอง', 'บางปะกอก', 'สุขสวัสดิ์', 'พระประแดง', 'ดาวคะนอง', 'บางขุนเทียน', 'สมุทรสาคร'],
    match: ['บางนา', 'บางปะกง', 'พระราม2', 'พระรามสอง', 'บางปะกอก', 'สุขสวัสดิ์', 'พระประแดง', 'สมุทรปราการ'],
    primary: {
      name: 'ทางพิเศษเฉลิมมหานคร (ข้ามสะพานพระราม 9)',
      waypoint: 'สะพานพระราม 9',
      cams: ['DOH-PER-3-009', 'ITICM_BMAMI0208', 'ITICM_BMAMI0293'],
      via: 'ถ.บางนา-ตราด ➔ ด่วนเฉลิมมหานคร ➔ ข้ามสะพานพระราม 9 ➔ ถ.พระราม 2'
    },
    bypass: {
      name: 'ทางพิเศษกาญจนาภิเษก วงแหวนใต้ (ข้ามสะพานกาญจนาภิเษก บางพลี-สุขสวัสดิ์)',
      waypoint: 'สะพานกาญจนาภิเษก',
      cams: ['DOH-PER-3-009', 'DOH-PER-12-015', 'ITICM_BMAMI0292'],
      via: 'ถ.กาญจนาภิเษก วงแหวนใต้ ➔ ข้ามสะพานกาญจนาภิเษก ➔ ลงสุขสวัสดิ์-พระประแดง ➔ ตัดเข้าพระราม 2'
    },
    tip: 'ช่วงสะพานพระราม 9 ชะลอตัว ให้ใช้สะพานกาญจนาภิเษกวงแหวนใต้แทน เลนกว้างกว่าและคล่องตัวกว่า'
  },
  {
    id: 'wongsawang_lamlukka',
    name: 'วงศ์สว่าง / ประชาชื่น ➔ ลำลูกกา / พหลโยธิน',
    defaultOrigin: 'แยกวงศ์สว่าง',
    defaultDest: 'ลำลูกกา ปทุมธานี',
    origins: ['วงศ์สว่าง', 'ประชาชื่น', 'ประชานุกูล', 'ประชานิเวศน์', 'พระราม7', 'บางซื่อ'],
    dests: ['ลำลูกกา', 'พหลโยธิน', 'ปทุมธานี', 'สายไหม', 'สะพานใหม่', 'รังสิต'],
    match: ['วงศ์สว่าง', 'ประชาชื่น', 'ประชานุกูล', 'ประชานิเวศน์', 'ลำลูกกา', 'พหลโยธิน', 'ปทุมธานี'],
    primary: {
      name: 'วงศ์สว่าง ➔ แยกประชานุกูล ➔ ถ.วิภาวดี ➔ พหลโยธิน',
      waypoint: 'แยกประชานุกูล',
      cams: ['ITICM_BMAMI0213', 'ITICM_BMAMI0188', 'DOH-PER-3-017'],
      via: 'ถ.รัชดาภิเษก ➔ แยกประชานุกูล ➔ ต่างระดับรัชวิภา ➔ ถ.วิภาวดีรังสิต ➔ ลำลูกกา'
    },
    bypass: {
      name: 'ข้ามสะพานพระราม 7 ➔ บางซื่อ ➔ โทลล์เวย์ด่านรัชดา หรือ ถ.เลียบคลองประปา',
      waypoint: 'สะพานพระราม 7',
      cams: ['ITICM_BMAMI0165', 'ITICM_BMAMI0210', 'DOHBHS0016', 'DOH-PER-3-017'],
      via: 'เลี่ยงแยกประชานุกูลโดยตัดออกถนนประชาชื่นเลียบคลองประปา หรือขึ้นโทลล์เวย์ด่านรัชดาภิเษก'
    },
    tip: 'หากแยกประชานุกูลมีรถติดขัด ให้ขึ้นสะพานข้ามแยกหรือใช้ทางเบี่ยงรัชดา-ประชาชื่น'
  },
  {
    id: 'phutthamonthon_bkk',
    name: 'พุทธมณฑล / นครปฐม ➔ เข้าสู่ตัวเมืองกรุงเทพฯ',
    defaultOrigin: 'พุทธมณฑลสาย 4',
    defaultDest: 'อนุสาวรีย์ชัยสมรภูมิ กรุงเทพมหานคร',
    origins: ['พุทธมณฑล', 'กระทุ่มล้ม', 'นครปฐม', 'ศาลายา', 'ทวีวัฒนา'],
    dests: ['ตัวเมือง', 'กรุงเทพ', 'บรมราชชนนี', 'เพชรเกษม', 'ปิ่นเกล้า', 'จตุจักร', 'อนุสาวรีย์'],
    match: ['พุทธมณฑล', 'กระทุ่มล้ม', 'นครปฐม', 'บรมราชชนนี', 'เพชรเกษม', 'ศาลายา', 'ปิ่นเกล้า'],
    primary: {
      name: 'ถ.เพชรเกษม / ถ.บรมราชชนนี (ระดับพื้นราบ)',
      waypoint: 'ถนนบรมราชชนนี',
      cams: ['DOH-PER-12-016', 'DOH-PER-12-016-out'],
      via: 'ถ.พุทธมณฑลสาย 4 ➔ ถ.เพชรเกษม หรือ ถ.บรมราชชนนี มุ่งหน้าสะพานสมเด็จพระปิ่นเกล้า'
    },
    bypass: {
      name: 'ทางคู่ขนานลอยฟ้าบรมราชชนนี ➔ ทางพิเศษประจิมรัถยา ข้ามสะพานพระราม 7',
      waypoint: 'ทางคู่ขนานลอยฟ้าบรมราชชนนี',
      cams: ['DOH-PER-12-016', 'ITICM_BMAMI0166'],
      via: 'ขึ้นทางคู่ขนานลอยฟ้าบรมราชชนนี ➔ เชื่อมต่อทางพิเศษประจิมรัถยา ข้ามสะพานพระราม 7 เข้าสู่จตุจักร/พระราม 9'
    },
    tip: 'ใช้คู่ขนานลอยฟ้าบรมราชชนนีเพื่อข้ามแยกสาย 2 สาย 3 และเลี่ยงไฟแดงตลอดสาย'
  },
  {
    id: 'rama2_rama7',
    name: 'พระราม 2 / บางปะกอก ➔ มจพ. พระนครเหนือ / พระราม 7 / วงศ์สว่าง',
    defaultOrigin: 'ถนนพระราม 2 กรุงเทพมหานคร',
    defaultDest: 'มหาวิทยาลัยเทคโนโลยีพระจอมเกล้าพระนครเหนือ',
    origins: ['พระราม2', 'พระรามสอง', 'บางปะกอก', 'สุขสวัสดิ์', 'ดาวคะนอง', 'จอมทอง', 'บางขุนเทียน', 'แสมดำ', 'มหาชัย', 'สมุทรสาคร'],
    dests: ['พระราม7', 'พระรามเจ็ด', 'พระนครเหนือ', 'มจพ', 'มจพ.', 'วงศ์สว่าง', 'พิบูลสงคราม', 'บางซื่อ', 'สะพานพระราม7'],
    match: ['พระราม2', 'พระรามสอง', 'พระราม7', 'พระรามเจ็ด', 'พระนครเหนือ', 'มจพ', 'วงศ์สว่าง', 'พิบูลสงคราม'],
    primary: {
      name: 'ทางพิเศษเฉลิมมหานคร ➔ ทางด่วนศรีรัช (ลงด่านสะพานพระราม 7 / ด่านประชานุกูล)',
      waypoint: 'สะพานพระราม 9',
      cams: ['ITICM_BMAMI0293', 'ITICM_BMAMI0213', 'ITICM_BMAMI0165'],
      via: 'ถ.พระราม 2 ➔ ขึ้นทางด่วนเฉลิมมหานคร ด่านดาวคะนอง (ข้ามสะพานพระราม 9 หรือสะพานทศมราชัน) ➔ เข้าทางพิเศษศรีรัช มุ่งหน้าแจ้งวัฒนะ ➔ ลงด่านสะพานพระราม 7 หรือ ด่านรัชดาภิเษก/ประชานุกูล ➔ ถ.วงศ์สว่าง ➔ มหาวิทยาลัยเทคโนโลยีพระจอมเกล้าพระนครเหนือ (มจพ.)'
    },
    bypass: {
      name: 'ทางเลี่ยงฝั่งธนบุรี (ถ.ราชพฤกษ์ ➔ ถ.นครอินทร์ ➔ ข้ามสะพานพระราม 5)',
      waypoint: 'สะพานพระราม 5',
      cams: ['ITICM_BMAMI0292', 'DOH-PER-3-006', 'ITICM_BMAMI0166'],
      via: 'ถ.พระราม 2 ➔ เลี้ยวเข้า ถ.ราชพฤกษ์ (ต่างระดับบางขุนเทียน) ➔ ตรงยาวข้ามบรมราชชนนีสู่ ถ.นครอินทร์ (วงเวียนพระราม 5) ➔ ข้ามสะพานพระราม 5 ➔ แยกพิบูลสงคราม เลี้ยวเข้า ถ.พิบูลสงคราม ➔ มจพ. พระนครเหนือ (ฟรีค่าทางด่วนและเลี่ยงรถติดสะพานพระราม 9)'
    },
    tip: 'ช่วงเวลาเร่งด่วนสะพานพระราม 9 มักมีท้ายแถวยาวสะสม การใช้ทางเลี่ยง ถ.ราชพฤกษ์-นครอินทร์ ข้ามสะพานพระราม 5 จะลื่นไหลกว่ามากและไม่ต้องเสียค่าผ่านทางพิเศษ'
  }
];

function formatCamSummary(camId, ctx) {
  const cam = ctx.cams.find(c => c.id === camId);
  const title = cam ? cam.title : camId;
  const det = ctx.detMap.get(camId);
  if (det && det.total !== null) {
    const spd = det.area_speed;
    const spdStr = spd ? `สถานะ ${spd.status_th || spd.status} · จอดนิ่ง ${spd.stopped_pct}%` : `ตรวจพบ ${det.total} คัน`;
    return `[🎥 ${title}](cam:${camId}) (*${spdStr}*)`;
  }
  return `[🎥 ${title}](cam:${camId})`;
}

function evaluateLeg(camIds, ctx) {
  let isJam = false;
  let isSlow = false;
  let maxStopped = 0;
  let minSpeed = 999;
  let totalVehicles = 0;

  camIds.forEach(id => {
    const det = ctx.detMap.get(id);
    if (det && det.total !== null) {
      totalVehicles += det.total;
      if (det.area_speed) {
        if (det.area_speed.status === 'jam') isJam = true;
        if (det.area_speed.status === 'slow') isSlow = true;
        maxStopped = Math.max(maxStopped, det.area_speed.stopped_pct || 0);
        minSpeed = Math.min(minSpeed, det.area_speed.avg_px_s || 0);
      }
    }
  });

  return {
    isJam: isJam || maxStopped >= 60,
    isSlow: isSlow || maxStopped >= 35,
    maxStopped,
    minSpeed: minSpeed === 999 ? null : minSpeed,
    totalVehicles,
    statusText: (isJam || maxStopped >= 60) ? '🔴 ติดขัดสะสม' : (isSlow || maxStopped >= 35) ? '🟡 ชะลอตัว' : '🟢 คล่องตัว'
  };
}

/**
 * Generates official Google Maps turn-by-turn navigation URL
 */
function buildGoogleMapsUrl(origin, dest, waypoint) {
  const base = 'https://www.google.com/maps/dir/?api=1';
  const o = encodeURIComponent((origin || '').trim());
  const d = encodeURIComponent((dest || '').trim());
  let u = `${base}&origin=${o}&destination=${d}&travelmode=driving`;
  if (waypoint) {
    u += `&waypoints=${encodeURIComponent(waypoint.trim())}`;
  }
  return u;
}

function evaluateRoutePreset(preset, ctx, parsed) {
  const relatedCams = [...preset.primary.cams, ...preset.bypass.cams];
  const priEval = evaluateLeg(preset.primary.cams, ctx);
  const bypEval = evaluateLeg(preset.bypass.cams, ctx);

  const originStr = (parsed && parsed.origin) ? parsed.origin : (preset.defaultOrigin || preset.name.split('➔')[0].trim());
  const destStr = (parsed && parsed.dest) ? parsed.dest : (preset.defaultDest || preset.name.split('➔')[1].trim());

  const priGmaps = buildGoogleMapsUrl(originStr, destStr, preset.primary.waypoint);
  const bypGmaps = buildGoogleMapsUrl(originStr, destStr, preset.bypass.waypoint);

  let reply = `### 🗺️ แผนที่นำทางและทางเลี่ยง: **${preset.name}**\n\n`;
  if (parsed && parsed.origin && parsed.dest) {
    reply += `📍 **คำขอเส้นทาง**: จาก **${parsed.origin}** ไปยัง **${parsed.dest}**\n\n`;
  }

  reply += `#### 1. เส้นทางหลัก: **${preset.primary.name}**\n`;
  reply += `- **สถานะปัจจุบัน**: **${priEval.statusText}**\n`;
  reply += `- **แนวเส้นทาง**: ${preset.primary.via}\n`;
  reply += `- **จุดตรวจกล้องสด**: ${preset.primary.cams.map(c => formatCamSummary(c, ctx)).join(', ')}\n`;
  reply += `- 🗺️ **ลิงก์นำทาง Google Maps**: [📍 เปิดนำทางเส้นทางหลัก (Google Maps)](${priGmaps})\n\n`;

  reply += `#### 2. เส้นทางเลี่ยง (Bypass): **${preset.bypass.name}**\n`;
  reply += `- **สถานะปัจจุบัน**: **${bypEval.statusText}**\n`;
  reply += `- **แนวเส้นทาง**: ${preset.bypass.via}\n`;
  reply += `- **จุดตรวจกล้องสด**: ${preset.bypass.cams.map(c => formatCamSummary(c, ctx)).join(', ')}\n`;
  reply += `- 🗺️ **ลิงก์นำทาง Google Maps**: [🔄 เปิดนำทางเส้นทางเลี่ยง (Google Maps)](${bypGmaps})\n\n`;

  reply += `#### 💡 คำแนะนำการเดินทางจาก AI:\n`;
  if (priEval.isJam && !bypEval.isJam) {
    reply += `> 🏆 **แนะนำใช้เส้นทางเลี่ยง**: **${preset.bypass.name}** ทันที! เนื่องจากเส้นทางหลักพบจุดติดขัดสะสม (สัดส่วนจอดนิ่งสูงถึง ${priEval.maxStopped}%) การใช้ทางเลี่ยงจะช่วยประหยัดเวลาได้ประมาณ 20-35 นาที\n`;
  } else if (!priEval.isJam && bypEval.isJam) {
    reply += `> 🏆 **แนะนำใช้เส้นทางหลัก**: **${preset.primary.name}** เนื่องจากทางเลี่ยงมีปริมาณรถสะสมหนาแน่นกว่า\n`;
  } else if (!priEval.isJam && !bypEval.isJam) {
    reply += `> 🟢 **ทั้ง 2 เส้นทางคล่องตัวดี**: แนะนำใช้ **${preset.primary.name}** ซึ่งระยะทางสั้นและตรงกว่า\n`;
  } else {
    reply += `> ⚠️ **ทั้ง 2 เส้นทางมีความหนาแน่นสูง**: แนะนำเผื่อเวลาเดินทางอย่างน้อย 30-45 นาที\n`;
  }

  if (preset.tip) {
    reply += `\n📌 *เกร็ดข้อควรระวัง*: ${preset.tip}\n`;
  }

  reply += `\n---\n`;
  reply += `**🧭 กดเปิดระบบนำทาง Google Maps ทันที**:\n`;
  reply += `- 🚗 [🗺️ เปิด Google Maps (เส้นทางหลัก)](${priGmaps})\n`;
  reply += `- 🚙 [🔄 เปิด Google Maps (เส้นทางเลี่ยง)](${bypGmaps})\n`;

  return { reply, relatedCams };
}

/**
 * Parses user input to extract Origin and Destination.
 * Example: "ช่วยแนะนำจากพระราม 2 ไป มหาลัยพระนครเหนือตรงพระราม 7 ให้หน่อย"
 * -> { origin: 'พระราม 2', dest: 'มหาลัยพระนครเหนือตรงพระราม 7' }
 */
function parseOriginDest(query) {
  if (!query) return null;
  const raw = query.trim();

  // Pattern 1: จาก... (ไปที่|ไปถึง|ไปยัง|ไป|ถึง|มุ่งหน้า)...
  let m = raw.match(/จาก\s*(.+?)\s*(?:ไปที่|ไปถึง|ไปยัง|ไป|ถึง|มุ่งหน้า)\s*(.+?)(?:ให้หน่อย|หน่อย|ทางไหนดี|ทางไหน|ดีไหม|ดีกว่า|ดี|ครับ|ค่ะ|นะ|\?|$)/i);
  if (!m) {
    // Pattern 2: [Start] (ไปที่|ไปถึง|ไปยัง|ไป) [End]
    m = raw.match(/([ก-๙a-zA-Z0-9\s.-]+?)\s*(?:ไปที่|ไปถึง|ไปยัง|ไป|มุ่งหน้า)\s*([ก-๙a-zA-Z0-9\s.-]+?)(?:ให้หน่อย|หน่อย|ทางไหนดี|ทางไหน|ดีไหม|ดีกว่า|ดี|ครับ|ค่ะ|นะ|\?|$)/i);
  }

  if (m) {
    let origin = m[1].replace(/^(ช่วยแนะนำ|ช่วยดู|แนะนำ|บอก|ขอเส้นทาง|เส้นทาง|เดินทางจาก|เริ่มจาก|ขับรถจาก|ออกเดินทางจาก)\s*/i, '').trim();
    let dest = m[2].replace(/(?:ไปทางไหนดี|ไปทางไหน|ทางไหนดี|ทางไหน|เลี่ยงรถติด|เลี่ยงติด|เลี่ยง|ดีไหม|ดีกว่า|ดี|ให้หน่อย|หน่อย|ครับ|ค่ะ|นะ|มุ่งหน้า|ไป|\?|\s)+$/gi, '').trim();

    origin = origin.replace(/^[,\s-]+|[,\s-]+$/g, '');
    dest = dest.replace(/^[,\s-]+|[,\s-]+$/g, '');

    if (origin && dest && origin !== dest) {
      return { origin, dest };
    }
  }
  return null;
}

/**
 * Fallback route evaluator for arbitrary Origin-Destination pairs
 */
function evaluateDynamicRoute(origin, dest, ctx) {
  const normO = origin.replace(/\s+/g, '').toLowerCase();
  const normD = dest.replace(/\s+/g, '').toLowerCase();
  const relatedCams = [];

  // Find cameras matching origin or destination
  const oCams = ctx.cams.filter(c => {
    const t = c.title.toLowerCase().replace(/\s+/g, '');
    return t.includes(normO) || normO.includes(t);
  });
  const dCams = ctx.cams.filter(c => {
    const t = c.title.toLowerCase().replace(/\s+/g, '');
    return t.includes(normD) || normD.includes(t);
  });

  oCams.forEach(c => { if (!relatedCams.includes(c.id)) relatedCams.push(c.id); });
  dCams.forEach(c => { if (!relatedCams.includes(c.id)) relatedCams.push(c.id); });

  const allRouteCams = [...oCams, ...dCams];
  const priGmaps = buildGoogleMapsUrl(origin, dest, null);
  const bypGmaps = buildGoogleMapsUrl(origin, dest, 'ถนนวงแหวนรอบนอก');

  let reply = `### 🗺️ แนะนำแนวเส้นทางและการหลีกเลี่ยงรถติด: **${origin} ➔ ${dest}**\n\n`;
  reply += `📍 **คำขอเส้นทาง**: จาก **${origin}** มุ่งหน้า **${dest}**\n`;
  reply += `ระบบประมวลผลโครงข่ายจราจรกรุงเทพฯ แบบไดนามิก (ดัชนีภาพรวม กทม.: **${ctx.trafficIndex}**):\n\n`;

  reply += `#### 1. เส้นทางหลัก (ทางด่วน/ทางพิเศษยกระดับ):\n`;
  reply += `- **แนวเส้นทาง**: จาก **${origin}** มุ่งหน้าขึ้นโครงข่ายทางพิเศษหรือทางยกระดับที่ใกล้ที่สุด (เช่น ทางด่วนเฉลิมมหานคร, ทางด่วนศรีรัช, หรือทางยกระดับอุตราภิมุข) ต่อเนื่องไปยังจุดลงทางด่วนในเขต **${dest}**\n`;
  reply += `- **จุดเด่น**: ประหยัดเวลา เลี่ยงสัญญาณไฟจราจรระดับพื้นราบและจุดตัดแยกสำคัญ\n`;
  reply += `- 🗺️ **ลิงก์นำทาง Google Maps**: [📍 เปิดนำทางเส้นทางหลัก (Google Maps)](${priGmaps})\n\n`;

  reply += `#### 2. เส้นทางเลี่ยง (Bypass / โครงข่ายถนนสายรองและวงแหวน):\n`;
  reply += `- **แนวเส้นทาง**: ใช้แนวถนนวงแหวนรอบนอกหรือถนนสายหลักคู่ขนาน (เช่น ถ.กาญจนาภิเษก, ถ.ราชพฤกษ์, ถ.นครอินทร์ หรือ ถ.วงแหวนอุตสาหกรรม) เลี่ยงใจกลางเมืองเข้าสู่ **${dest}**\n`;
  reply += `- **จุดเด่น**: ไม่เสียค่าผ่านทางพิเศษ และช่วยเลี่ยงคอขวดสะพานข้ามแม่น้ำเจ้าพระยาช่วงชั่วโมงเร่งด่วน\n`;
  reply += `- 🗺️ **ลิงก์นำทาง Google Maps**: [🔄 เปิดนำทางเส้นทางเลี่ยง (Google Maps)](${bypGmaps})\n\n`;

  if (allRouteCams.length > 0) {
    reply += `#### 📹 จุดตรวจกล้องสดใกล้เคียงแนวเส้นทาง:\n`;
    allRouteCams.slice(0, 4).forEach(c => {
      reply += `- ${formatCamSummary(c.id, ctx)}\n`;
    });
    reply += `\n`;
  }

  reply += `#### 💡 คำแนะนำเพิ่มเติม:\n`;
  const severeRoads = ctx.sortedRoads.filter(r => r.congestion && r.congestion.share.jam >= 20);
  if (severeRoads.length > 0) {
    reply += `> ⚠️ **จุดติดขัดที่ควรระวังในพื้นที่ใกล้เคียง**: ${severeRoads.slice(0, 2).map(r => `**${r.name}** (ติดขัดสะสม ${r.congestion.share.jam}%)`).join(', ')}\n`;
  } else {
    reply += `> 🟢 **สภาพการจราจรโดยรวม**: โครงข่ายหลักส่วนใหญ่เคลื่อนตัวได้ตามปกติ แนะนำตรวจเช็คกล้องสดก่อนออกเดินทาง\n`;
  }

  reply += `\n---\n`;
  reply += `**🧭 กดเปิดระบบนำทาง Google Maps ทันที**:\n`;
  reply += `- 🚗 [🗺️ เปิด Google Maps (เส้นทางหลัก)](${priGmaps})\n`;
  reply += `- 🚙 [🔄 เปิด Google Maps (เส้นทางเลี่ยง)](${bypGmaps})\n`;

  return { reply, relatedCams };
}

// --- Corridor Bypass Tips for Map Red Routes ---
const CORRIDOR_MAP_BYPASSES = [
  {
    match: ['พระราม7', 'พระรามเจ็ด', 'พระนครเหนือ', 'มจพ', 'วงศ์สว่าง', 'พิบูลสงคราม'],
    name: 'ย่าน มจพ. พระนครเหนือ - สะพานพระราม 7 - วงศ์สว่าง',
    bypassTips: [
      'ใช้ **ถ.พิบูลสงคราม ➔ ข้ามสะพานพระราม 5** เพื่อตัดออก ถ.นครอินทร์ / ถ.ราชพฤกษ์ เลี่ยงการข้ามสะพานพระราม 7 หรือแยกประชานุกูล',
      'ใช้ **ทางพิเศษประจิมรัถยา (ด่วนศรีรัช-วงแหวนรอบนอก)** มุ่งหน้าตลิ่งชัน/กาญจนาภิเษก หรือเชื่อมต่อด่วนศรีรัชเข้าเมือง',
      'เลี่ยงแยกวงศ์สว่างโดยใช้ทางเบี่ยงเลียบคลองประปา หรือ ถ.กรุงเทพ-นนทบุรี'
    ]
  },
  {
    match: ['ประชานุกูล', 'ประชาชื่น', 'วงศ์สว่าง', 'ประชานิเวศน์', 'รัชดา', 'รัชวิภา'],
    name: 'ย่านประชานุกูล - ประชาชื่น - วงศ์สว่าง',
    bypassTips: [
      'เบี่ยงเข้า **ถ.ประชาชื่นเลียบคลองประปา** เพื่อมุ่งหน้างามวงศ์วานหรือแจ้งวัฒนะ',
      'ขึ้นสะพานยกระดับข้ามแยกประชานุกูลตรงไปรัชวิภา เลี่ยงระดับพื้นราบ',
      'ใช้เส้นทาง **MRT วงศ์สว่าง / สะพานพระราม 7** เชื่อมต่อทางพิเศษประจิมรัถยา'
    ]
  },
  {
    match: ['สาทร', 'สีลม', 'ตากสิน', 'สะพานตากสิน', 'กรุงธนบุรี', 'เจริญนคร'],
    name: 'คอขวดสะพานตากสิน - สาทร - สีลม',
    bypassTips: [
      'เบี่ยงใช้ **สะพานพระราม 3 หรือ สะพานกรุงเทพ** ข้ามแม่น้ำเจ้าพระยาเข้าสู่ ถ.พระราม 3 ➔ ถ.นราธิวาสราชนครินทร์',
      'ใช้ทางพิเศษศรีรัช ลงด่านสีลม หรือ ด่านจันทน์ เพื่อเข้าสู่สาทรโดยตรง'
    ]
  },
  {
    match: ['พระราม4', 'พระรามสี่', 'วิทยุ', 'คลองเตย', 'ทางด่วนพระราม4'],
    name: 'ถ.พระราม 4 - ทางด่วนพระราม 4',
    bypassTips: [
      'เลี่ยงเข้า **ถ.พระราม 3** หรือ **ถ.เชื้อเพลิง** ออกสู่ ถ.สาทร/คลองเตย',
      'ใช้ทางพิเศษเฉลิมมหานคร ต่อเนื่องไปลงด่านเพลินจิต หรือสุขุมวิท 62'
    ]
  },
  {
    match: ['บางปะกอก', 'พระราม2', 'พระรามสอง', 'สุขสวัสดิ์', 'ราษฎร์บูรณะ'],
    name: 'ถ.พระราม 2 - สุขสวัสดิ์ - บางปะกอก',
    bypassTips: [
      'เบี่ยงเข้า **ถ.กัลปพฤกษ์ / ถ.ราชพฤกษ์** หรือ **ถ.เอกชัย** เพื่อมุ่งหน้าเข้าสู่ใจกลางเมือง',
      'ใช้ **ทางพิเศษกาญจนาภิเษก วงแหวนใต้** (สะพานกาญจนาภิเษก บางพลี-สุขสวัสดิ์) เลี่ยงสะพานพระราม 9'
    ]
  },
  {
    match: ['บางใหญ่', 'กาญจนาภิเษก', 'แคราย', 'รัตนาธิเบศร์', 'งามวงศ์วาน'],
    name: 'ถ.รัตนาธิเบศร์ - แคราย - งามวงศ์วาน',
    bypassTips: [
      'ใช้ **ทางพิเศษประจิมรัถยา (ด่วนศรีรัช-วงแหวนรอบนอก)** ด่านบางบัวทอง ข้ามสะพานพระราม 7',
      'ใช้ **ถ.นครอินทร์** ข้ามสะพานพระราม 5 เชื่อมต่อ ถ.ติวานนท์ หรือ พระราม 7'
    ]
  },
  {
    match: ['วิภาวดี', 'ดอนเมือง', 'หลักสี่', 'พหลโยธิน', 'ลำลูกกา'],
    name: 'ถ.วิภาวดีรังสิต - พหลโยธิน',
    bypassTips: [
      'ขึ้น **ทางยกระดับอุตราภิมุข (ดอนเมืองโทลล์เวย์)**',
      'ใช้ **ถ.กำแพงเพชร 6 (Local Road)** วิ่งเลียบทางรถไฟสายสีแดง'
    ]
  }
];

function evaluateMapRedRoutes(query, ctx) {
  const normQ = (query || '').toLowerCase().replace(/\s+/g, '');
  const relatedCams = [];

  // Filter roads with red traffic lines (jam percentage >= 15% or status 'ติดขัด')
  const redRoads = ctx.sortedRoads.filter(r => r.congestion && (r.congestion.share.jam >= 15 || r.congestion.label === 'ติดขัด'));
  const greenRoads = ctx.sortedRoads.filter(r => r.congestion && r.congestion.share.jam < 10 && r.congestion.share.flowing >= 65);

  let reply = `### 🗺️ ระบบตรวจจับเส้นทางสีแดงจากแผนที่จราจร (Live Map Red-Line Navigator)\n\n`;
  reply += `**สามารถตรวจจับจากแผนที่ (Map Traffic Vector) แทนหรือร่วมกับกล้องได้ทันทีครับ!**\n`;
  reply += `ระบบประมวลผลข้อมูลเส้นสีจราจรกว่า 33,000 เวกเตอร์เซกเมนต์ของ Longdo Traffic ทุก 5 นาที โดยแยกสถานะสี:\n`;
  reply += `- 🔴 **สีแดง (#FF2020)**: ติดขัดสะสม (Jam)\n`;
  reply += `- 🟡 **สีเหลือง (#FEDE04)**: ชะลอตัว (Slow)\n`;
  reply += `- 🟢 **สีเขียว (#54C00C)**: คล่องตัว (Flowing)\n\n`;

  if (redRoads.length === 0) {
    reply += `🟢 **สถานะบนแผนที่ขณะนี้**: ไม่พบเส้นทางสีแดงติดขัดรุนแรงในโครงข่ายหลัก เส้นทางส่วนใหญ่เป็นสีเขียว (คล่องตัว) เดินทางได้สะดวกครับ\n`;
    return { reply, relatedCams };
  }

  // Check if query asks about a specific road/area
  const matchedRedRoad = redRoads.find(r => {
    const rName = r.name.toLowerCase().replace(/\s+/g, '');
    if (normQ.includes(rName) || rName.includes(normQ)) return true;
    for (const cb of CORRIDOR_MAP_BYPASSES) {
      const inCorridor = cb.match.some(m => rName.includes(m));
      const inQuery = cb.match.some(m => normQ.includes(m));
      if (inCorridor && inQuery) return true;
    }
    return false;
  });

  if (matchedRedRoad) {
    const c = matchedRedRoad.congestion;
    (matchedRedRoad.cameras || []).forEach(cam => relatedCams.push(cam.id));
    const camLinks = (matchedRedRoad.cameras || []).map(cam => `[🎥 ${cam.title}](cam:${cam.id})`).join(', ');

    reply += `#### 🚨 ตรวจพบเส้นทางสีแดงบนถนน: **${matchedRedRoad.name}**\n`;
    reply += `- 🔴 **สัดส่วนเส้นสีแดง (ติดขัดสะสม)**: **${c.share.jam}%**\n`;
    reply += `- 🟡 **สัดส่วนเส้นสีเหลือง (ชะลอตัว)**: **${c.share.slow}%**\n`;
    reply += `- 🟢 **สัดส่วนเส้นสีเขียว (คล่องตัว)**: **${c.share.flowing}%**\n`;
    reply += `- 📊 **ระดับความหนาแน่น**: ${c.score}/100 (ระดับ: **${c.label}**)\n`;
    if (camLinks) reply += `- 📹 **จุดตรวจกล้องสด**: ${camLinks}\n\n`;

    const corridor = CORRIDOR_MAP_BYPASSES.find(cb => cb.match.some(m => matchedRedRoad.name.toLowerCase().includes(m)));
    reply += `#### 💡 คำแนะนำเส้นทางเลี่ยงสีเขียว (Green Bypass) จาก AI:\n`;
    if (corridor) {
      corridor.bypassTips.forEach(tip => {
        reply += `- 🛣️ ${tip}\n`;
      });
    } else {
      reply += `- 🛣️ แนะนำเบี่ยงใช้ถนนคู่ขนาน หรือโครงข่ายทางด่วนใกล้เคียง เพื่อเลี่ยงช่วงที่เกิดเส้นสีแดง\n`;
    }

    const gmapsSearchUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(matchedRedRoad.name + ' กรุงเทพมหานคร')}`;
    reply += `- 🗺️ **ดูสภาพจราจรบน Google Maps**: [📍 ตรวจสอบสภาพจราจร ${matchedRedRoad.name} (Google Maps)](${gmapsSearchUrl})\n`;

    if (greenRoads.length > 0) {
      reply += `\n**🟢 เส้นทางใกล้เคียงบนแผนที่ที่เป็นสีเขียว (คล่องตัวดี)**:\n`;
      greenRoads.slice(0, 3).forEach(gr => {
        (gr.cameras || []).forEach(cam => relatedCams.push(cam.id));
        reply += `- **${gr.name}**: เส้นทางสีเขียว **${gr.congestion.share.flowing}%** (สีแดงเพียง ${gr.congestion.share.jam}%)\n`;
      });
    }

    return { reply, relatedCams };
  }

  // General Report of Red Routes across Bangkok Map
  reply += `#### 🚨 ตรวจพบจุดวิกฤติเส้นสีแดงบนแผนที่ขณะนี้ (${redRoads.length} จุดหลัก):\n\n`;

  redRoads.slice(0, 4).forEach((r, idx) => {
    const c = r.congestion;
    (r.cameras || []).forEach(cam => relatedCams.push(cam.id));
    const camLinks = (r.cameras || []).map(cam => `[🎥 ${cam.title}](cam:${cam.id})`).join(', ');
    const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + ' กรุงเทพมหานคร')}`;

    reply += `**${idx + 1}. 🔴 ${r.name}**\n`;
    reply += `- **สถานะบนแผนที่**: เส้นสีแดงติดขัด **${c.share.jam}%** · ชะลอตัว ${c.share.slow}% · คล่องตัว ${c.share.flowing}%\n`;
    if (camLinks) reply += `- **จุดตรวจกล้องสด**: ${camLinks}\n`;

    const corridor = CORRIDOR_MAP_BYPASSES.find(cb => cb.match.some(m => r.name.toLowerCase().includes(m)));
    if (corridor && corridor.bypassTips.length > 0) {
      reply += `- 💡 **ทางเลี่ยงที่แนะนำ**: ${corridor.bypassTips[0]}\n`;
    }
    reply += `- 🗺️ **Google Maps**: [📍 ตรวจสอบสภาพจราจรบน Google Maps](${gmapsUrl})\n`;
    reply += `\n`;
  });

  reply += `#### 🟢 เส้นทางสีเขียวบนแผนที่ (ทางเลือกที่คล่องตัว 70-100%):\n`;
  greenRoads.slice(0, 4).forEach(gr => {
    reply += `- ✅ **${gr.name}**: เส้นทางสีเขียวคล่องตัว **${gr.congestion.share.flowing}%** (สีแดงเพียง ${gr.congestion.share.jam}%)\n`;
  });

  reply += `\n💬 *พิมพ์ถามเจาะจงได้ทันที เช่น "ถนนประชานุกูลแดงไหม ไปทางไหนแทน" หรือคลิกปุ่มหาทางเลี่ยงได้ครับ*`;
  return { reply, relatedCams };
}

/**
 * Built-in Intelligent Traffic Engine (Offline / Local RAG)
 */
function runBuiltInEngine(query, ctx, selectedCamId) {
  const q = (query || '').trim().toLowerCase();
  const normQ = q.replace(/\s+/g, '');
  const relatedCams = [];

  // 1. Map-Based Red Route & Bypass Queries:
  // "จับจากแมพ", "แผนที่", "เส้นทางแดง", "เส้นสีแดง", "ทางแดง", "ติดแดง", "สีแดง", "เส้นแดง", "ถนนแดง", "แมพ"
  const isMapRedQuery = q.includes('แมพ') || q.includes('แผนที่') || q.includes('เส้นทางแดง') ||
                        q.includes('เส้นสีแดง') || q.includes('ทางแดง') || q.includes('ติดแดง') ||
                        q.includes('สีแดง') || q.includes('เส้นแดง') || q.includes('ถนนแดง') ||
                        (q.includes('แดง') && (q.includes('เส้น') || q.includes('ทาง') || q.includes('ถนน') || q.includes('เลี่ยง') || q.includes('ไปไหน') || q.includes('ไปทางไหน') || q.includes('จับ') || q.includes('แทน')));

  if (isMapRedQuery) {
    return evaluateMapRedRoutes(query, ctx);
  }

  // 2. Navigation & Route Bypass Queries: "นำทาง", "ทางเลี่ยง", "เส้นทาง", "ไปทางไหน", "จาก ... ไป ...", "เลี่ยง"
  const isNavQuery = q.includes('นำทาง') || q.includes('เส้นทาง') || q.includes('ทางเลี่ยง') ||
                     q.includes('เลี่ยง') || q.includes('ไปทางไหน') || q.includes('เดินทาง') ||
                     q.includes('route') || q.includes('bypass') ||
                     (normQ.includes('จาก') && (normQ.includes('ไป') || normQ.includes('ถึง'))) ||
                     (q.includes('แนะนำ') && (q.includes('ไป') || q.includes('ถึง')));

  if (isNavQuery) {
    const parsed = parseOriginDest(query);
    let matchedPreset = null;

    if (selectedCamId) {
      matchedPreset = ROUTE_PRESETS.find(preset =>
        preset.primary.cams.includes(selectedCamId) || preset.bypass.cams.includes(selectedCamId)
      );
    }

    if (!matchedPreset && parsed) {
      const normOrigin = parsed.origin.replace(/\s+/g, '').toLowerCase();
      const normDest = parsed.dest.replace(/\s+/g, '').toLowerCase();

      // STRICT: Both origin and destination must match the preset corridor
      for (const preset of ROUTE_PRESETS) {
        const oMatch = (preset.origins || []).some(o => {
          const no = o.toLowerCase().replace(/\s+/g, '');
          return normOrigin.includes(no) || no.includes(normOrigin);
        });
        const dMatch = (preset.dests || []).some(d => {
          const nd = d.toLowerCase().replace(/\s+/g, '');
          return normDest.includes(nd) || nd.includes(normDest);
        });
        if (oMatch && dMatch) {
          matchedPreset = preset;
          break;
        }
      }

      // If origin & dest specified but no preset matched both, use dynamic routing fallback!
      // NEVER guess a random mismatched preset!
      if (!matchedPreset) {
        return evaluateDynamicRoute(parsed.origin, parsed.dest, ctx);
      }
    }

    if (!matchedPreset && !parsed) {
      // General query without clear "from A to B" format
      let bestPreset = null;
      let maxScore = 0;
      ROUTE_PRESETS.forEach(preset => {
        let score = 0;
        const oHit = (preset.origins || []).some(o => normQ.includes(o.toLowerCase()));
        const dHit = (preset.dests || []).some(d => normQ.includes(d.toLowerCase()));
        if (oHit && dHit) {
          score += 10;
        }
        const kwHits = (preset.match || []).filter(m => normQ.includes(m.toLowerCase())).length;
        score += kwHits;

        if (score > maxScore) {
          maxScore = score;
          bestPreset = preset;
        }
      });
      // Only match if high confidence (e.g. both origin and destination keywords exist or multiple hits)
      if (maxScore >= 10 || (maxScore >= 3 && (normQ.includes('ทางเลี่ยง') || normQ.includes('นำทาง')))) {
        matchedPreset = bestPreset;
      }
    }

    if (matchedPreset) {
      return evaluateRoutePreset(matchedPreset, ctx, parsed);
    }

    // If specific camera requested bypass
    if (selectedCamId) {
      const cam = ctx.cams.find(c => c.id === selectedCamId);
      if (cam) {
        relatedCams.push(cam.id);
        const det = ctx.detMap.get(cam.id);
        const spd = det && det.area_speed;
        let reply = `### 🗺️ คำแนะนำทางเลี่ยงจุดวิกฤติ: **${cam.title}**\n\n`;
        reply += `- **สถานะปัจจุบันที่จุดนี้**: ${det && det.total !== null ? `ตรวจพบรถ **${det.total} คัน**` : 'กำลังประมวลผล'}`;
        if (spd) {
          reply += ` · สถานะ: **${spd.status_th || spd.status}** (จอดนิ่ง **${spd.stopped_pct}%**)`;
        }
        reply += `\n\n`;
        if (spd && (spd.status === 'jam' || spd.stopped_pct >= 50)) {
          reply += `🚨 **ข้อแนะนำเร่งด่วน**: จุดนี้มีรถสะสมหนาแน่นสูง แนะนำเลี่ยงเข้าโครงข่ายทางด่วนใกล้เคียงหรือใช้ถนนคู่ขนาน\n`;
        } else {
          reply += `🟢 **ข้อแนะนำ**: สภาพการจราจร ณ จุดนี้ยังเคลื่อนตัวได้ตามปกติ สามารถใช้เส้นทางตรงได้\n`;
        }
        reply += `\n**🛣️ เส้นทางหลักและทางเลี่ยงเมืองสำคัญที่แนะนำ**:\n`;
        ROUTE_PRESETS.slice(0, 4).forEach((p, idx) => {
          reply += `${idx + 1}. **${p.name}**\n   - ทางเลี่ยง: ${p.bypass.name}\n`;
        });
        return { reply, relatedCams };
      }
    }

    // Generic Navigation Hub & live bottlenecks
    let reply = `### 🗺️ ศูนย์วางแผนเส้นทางและทางเลี่ยงเมืองอัจฉริยะ (BKK Smart Bypass Navigator)\n\n`;

    reply += `**🚨 จุดคอขวดวิกฤติที่ควรหลีกเลี่ยงขณะนี้ (Live Bottlenecks)**:\n`;
    const topBottlenecks = ctx.busyCams.filter(d => d.area_speed && (d.area_speed.status === 'jam' || d.area_speed.stopped_pct >= 50)).slice(0, 3);
    if (topBottlenecks.length > 0) {
      topBottlenecks.forEach(d => {
        relatedCams.push(d.id);
        reply += `- [🎥 ${d.title}](cam:${d.id}): ตรวจพบรถ **${d.total} คัน** · สถานะ **${d.area_speed.status_th || d.area_speed.status}** (จอดนิ่งสะสม **${d.area_speed.stopped_pct}%**)\n`;
      });
    } else {
      reply += `- ✅ โครงข่ายหลักส่วนใหญ่ยังไม่มีจุดติดขัดสะสมรุนแรง\n`;
    }

    reply += `\n**🛣️ เส้นทางเชื่อมต่อหลักที่แนะนำการวิเคราะห์ทางเลี่ยง**:\n`;
    ROUTE_PRESETS.forEach((p, idx) => {
      reply += `${idx + 1}. **${p.name}**\n   - *ทางหลัก*: ${p.primary.name}\n   - *ทางเลี่ยง*: ${p.bypass.name}\n`;
    });

    reply += `\n💬 *พิมพ์ถามเจาะจงได้ทันที เช่น "จากดอนเมืองไปสาทร" หรือ "ทางเลี่ยงพระราม 4"*`;
    return { reply, relatedCams };
  }

  // 2. If asking about a specific selected camera (general count / speed)
  if (selectedCamId) {
    const cam = ctx.cams.find(c => c.id === selectedCamId);
    if (cam) {
      const det = ctx.detMap.get(cam.id);
      const road = ctx.sortedRoads.find(r => (r.cameras || []).some(c => c.id === cam.id));
      relatedCams.push(cam.id);

      let reply = `### 📹 วิเคราะห์สภาพจราจรกล้อง: **${cam.title}** (${cam.org || 'CCTV'})\n\n`;
      if (det && det.total !== null) {
        reply += `- 🚗 **ปริมาณรถที่ตรวจพบ**: **${det.total} คัน**\n`;
        if (det.counts) {
          const breakdown = [];
          if (det.counts.car) breakdown.push(`รถเก๋ง/กระบะ ${det.counts.car}`);
          if (det.counts.motorcycle) breakdown.push(`มอเตอร์ไซค์ ${det.counts.motorcycle}`);
          if (det.counts.bus) breakdown.push(`รถโดยสาร ${det.counts.bus}`);
          if (det.counts.truck) breakdown.push(`รถบรรทุก ${det.counts.truck}`);
          reply += `  - *แยกประเภท*: ${breakdown.join(', ') || 'ไม่มีข้อมูล'}\n`;
        }

        if (det.area_speed) {
          const spd = det.area_speed;
          reply += `- 🚥 **สถานะการจราจร**: **${spd.status_th || spd.status}**\n`;
          reply += `- 🛑 **สัดส่วนรถจอดนิ่ง/รอสัญญาณ**: **${spd.stopped_pct}%** (${spd.stopped_count || 0} คันนิ่ง, ${spd.moving_count || 0} คันกำลังวิ่ง)\n`;
        }
      } else {
        reply += `- ℹ️ *กล้องนี้ยังไม่ได้เปิดการตรวจจับ AI ต่อเนื่อง (เปิดดูในโหมดผลตรวจจับเพื่อประมวลผลสดได้)*\n`;
      }

      if (road) {
        reply += `\n**การประเมินจากเครือข่ายถนน (${road.name})**:\n`;
        if (road.congestion) {
          reply += `- ดัชนีความหนาแน่น: ${road.congestion.label} (คะแนน ${road.congestion.score}/100, ติดขัด ${road.congestion.share.jam}%, ชะลอตัว ${road.congestion.share.slow}%, คล่องตัว ${road.congestion.share.flowing}%)\n`;
        }
        if (road.advice) {
          reply += `- 💡 **คำแนะนำสัญญาณไฟ**: ${road.advice.headline}\n  *${road.advice.detail}*\n`;
        }
      }
      return { reply, relatedCams };
    }
  }

  // 3. Road or Junction specific search in query
  const matchedRoad = ctx.sortedRoads.find(r => {
    const normName = r.name.toLowerCase().replace(/\s+/g, '');
    if (normQ.includes(normName) || normName.includes(normQ)) return true;
    const parts = r.name.toLowerCase().split(/[\s,./-]+/).filter(p => p.length >= 3);
    return parts.some(part => normQ.includes(part));
  }) || ctx.cams.find(c => {
    const normTitle = (c.title || '').toLowerCase().replace(/\s+/g, '');
    if (normQ.includes(normTitle) || normTitle.includes(normQ)) return true;
    const parts = (c.title || '').toLowerCase().split(/[\s,./-]+/).filter(p => p.length >= 3);
    return parts.some(part => normQ.includes(part));
  });

  if (matchedRoad) {
    const isCam = !!matchedRoad.hls;
    const targetCams = isCam ? [matchedRoad] : (matchedRoad.cameras || []);
    const roadName = isCam ? matchedRoad.title : matchedRoad.name;
    targetCams.forEach(c => relatedCams.push(c.id));

    let reply = `### 📍 วิเคราะห์สภาพจราจร: **${roadName}**\n\n`;

    targetCams.forEach(c => {
      const det = ctx.detMap.get(c.id);
      reply += `**กล้อง [🎥 ${c.title}](cam:${c.id})**:\n`;
      if (det && det.total !== null) {
        reply += `- ตรวจพบรถ **${det.total} คัน**`;
        if (det.area_speed) {
          reply += ` · สถานะ **${det.area_speed.status_th || det.area_speed.status}** · จอดนิ่ง **${det.area_speed.stopped_pct}%**`;
        }
        reply += `\n`;
      } else {
        reply += `- *ไม่มีข้อมูล AI realtime ในขณะนี้*\n`;
      }
    });

    if (!isCam && matchedRoad.congestion) {
      const c = matchedRoad.congestion;
      reply += `\n**สภาพเส้นสีบนแผนที่จราจร (${c.km} กม. รอบกล้อง)**:\n`;
      reply += `- ระดับ: **${c.label}** (คะแนนความหนาแน่น ${c.score}/100)\n`;
      reply += `- 🔴 สีแดง (ติดขัด): **${c.share.jam}%** · 🟡 สีเหลือง (ชะลอตัว): **${c.share.slow}%** · 🟢 สีเขียว (คล่องตัว): **${c.share.flowing}%**\n`;

      if (c.share.jam >= 15) {
        const corridor = CORRIDOR_MAP_BYPASSES.find(cb => cb.match.some(m => matchedRoad.name.toLowerCase().includes(m)));
        if (corridor) {
          reply += `\n💡 **คำแนะนำเส้นทางเลี่ยงสีเขียว (Green Bypass)**:\n`;
          corridor.bypassTips.forEach(tip => { reply += `- ${tip}\n`; });
        }
      }
    }

    if (!isCam && matchedRoad.advice) {
      reply += `\n🚦 **ข้อเสนอแนะการจัดการจราจร**: ${matchedRoad.advice.headline}\n> ${matchedRoad.advice.detail}\n`;
    }

    return { reply, relatedCams };
  }

  // 4. Congestion Query: "ติดตรงไหน", "รถติด", "jam"
  if (q.includes('ติด') || q.includes('jam') || q.includes('หนาแน่น')) {
    let reply = `### 🚨 รายงานจุดจราจรติดขัดและหนาแน่นสูงสุดใน กทม.\n\n`;

    const topJam = ctx.sortedRoads.filter(r => (r.congestion && r.congestion.score >= 20) || (r.advice && r.advice.action === 'meter')).slice(0, 5);

    if (topJam.length > 0) {
      reply += `**ถนนที่มีความหนาแน่นสะสมสูง**:\n`;
      topJam.forEach((r, idx) => {
        const c = r.congestion;
        const camLinks = (r.cameras || []).map(cam => {
          relatedCams.push(cam.id);
          return `[🎥 ${cam.title}](cam:${cam.id})`;
        }).join(', ');

        reply += `${idx + 1}. **${r.name}** (ดัชนี ${c ? c.score : 0}/100 - ${c ? c.label : 'ติดขัด'})\n`;
        reply += `   - กล้องตรวจสอบ: ${camLinks || 'ไม่มีกล้อง'}\n`;
        if (r.advice) reply += `   - มาตรการ: *${r.advice.headline}*\n`;
      });
    } else {
      reply += `✅ ขณะนี้ไม่พบจุดที่ติดขัดรุนแรงบนโครงข่ายหลัก การจราจรส่วนใหญ่สามารถเคลื่อนตัวได้\n`;
    }

    if (ctx.busyCams.length > 0) {
      reply += `\n**กล้องที่ตรวจพบจำนวนรถหนาแน่นที่สุด (YOLO AI)**:\n`;
      ctx.busyCams.slice(0, 3).forEach(d => {
        relatedCams.push(d.id);
        const spdStr = d.area_speed ? ` · สถานะ ${d.area_speed.status_th || d.area_speed.status}` : '';
        reply += `- [🎥 ${d.title}](cam:${d.id}): ตรวจพบ **${d.total} คัน**${spdStr}\n`;
      });
    }

    return { reply, relatedCams };
  }

  // 5. Signal / Light Timing Advice: "ปล่อยไฟ", "สัญญาณไฟ", "ปล่อยรถ", "เขียว", "meter", "release"
  if (q.includes('ไฟ') || q.includes('ปล่อย') || q.includes('สัญญาณ') || q.includes('ไฟเขียว') || q.includes('ไฟแดง')) {
    let reply = `### 🚦 ข้อเสนอแนะการปรับสัญญาณไฟจราจร (Signal Timing Advisory)\n\n`;

    if (ctx.releaseRoads.length > 0) {
      reply += `**🟢 ควรเพิ่มรอบสัญญาณไฟเขียว (Release Traffic)**:\n`;
      ctx.releaseRoads.slice(0, 4).forEach(r => {
        const camLinks = (r.cameras || []).map(cam => { relatedCams.push(cam.id); return `[🎥 ${cam.title}](cam:${cam.id})`; }).join(', ');
        reply += `- **${r.name}**: ${r.advice.headline}\n  *แนวทาง*: ${r.advice.detail} (${camLinks})\n`;
      });
      reply += `\n`;
    }

    if (ctx.meterRoads.length > 0) {
      reply += `**🔴 ควรหน่วงรถเข้าแยก (Meter / Slow Entry)**:\n`;
      ctx.meterRoads.slice(0, 4).forEach(r => {
        const camLinks = (r.cameras || []).map(cam => { relatedCams.push(cam.id); return `[🎥 ${cam.title}](cam:${cam.id})`; }).join(', ');
        reply += `- **${r.name}**: ${r.advice.headline}\n  *แนวทาง*: ${r.advice.detail} (${camLinks})\n`;
      });
      reply += `\n`;
    }

    if (!ctx.releaseRoads.length && !ctx.meterRoads.length) {
      reply += `✅ ทุกแยกยังอยู่ในเกณฑ์สมดุล ไม่จำเป็นต้องปรับรอบเวลาสัญญาณไฟเป็นกรณีพิเศษในขณะนี้\n`;
    }

    return { reply, relatedCams };
  }

  // 5. Statistics & Vehicles Breakdown: "สถิติ", "กี่คัน", "ประเภทรถ", "ความเร็ว"
  if (q.includes('สถิติ') || q.includes('กี่คัน') || q.includes('ประเภท') || q.includes('มอไซค์') || q.includes('รถยนต์')) {
    let reply = `### 📊 สถิติยานพาหนะและการจราจรภาพรวม\n\n`;
    reply += `- 📡 **จำนวนกล้องที่พร้อมใช้งาน**: **${ctx.totalCams} จุด**\n`;
    reply += `- 🚗 **ยานพาหนะที่ AI ตรวจจับได้ขณะนี้**: **${ctx.totalVehiclesCounted} คัน**\n`;
    reply += `  - 🚙 รถยนต์ส่วนบุคคล/กระบะ: **${ctx.vehicleTypes.car} คัน**\n`;
    reply += `  - 🛵 มอเตอร์ไซค์: **${ctx.vehicleTypes.motorcycle} คัน**\n`;
    reply += `  - 🚌 รถโดยสาร/รถเมล์: **${ctx.vehicleTypes.bus} คัน**\n`;
    reply += `  - 🚛 รถบรรทุก: **${ctx.vehicleTypes.truck} คัน**\n\n`;
    reply += `- 🌐 **ดัชนีจราจร กทม. (Longdo Index)**: **${ctx.trafficIndex}**\n`;
    return { reply, relatedCams };
  }

  // 6. Default General Traffic Overview
  let reply = `### 🌐 สรุปภาพรวมการจราจรกรุงเทพฯ ประจำขณะนี้\n\n`;
  reply += `- 📈 **ดัชนีจราจรภาพรวม**: **${ctx.trafficIndex}**\n`;
  reply += `- 📷 **ระบบกล้อง CCTV สด**: ตรวจสอบได้ **${ctx.totalCams} จุด** ทั่วกรุงเทพฯ\n`;
  reply += `- 🚘 **ยานพาหนะในพื้นที่ตรวจจับ AI**: รวม **${ctx.totalVehiclesCounted} คัน**\n\n`;

  if (ctx.sortedRoads.length > 0) {
    const worst = ctx.sortedRoads[0];
    if (worst.congestion && worst.congestion.score > 15) {
      reply += `⚠️ **จุดที่ต้องเฝ้าระวังเป็นพิเศษ**: **${worst.name}** (ความหนาแน่น ${worst.congestion.score}/100 - ${worst.congestion.label})\n`;
      (worst.cameras || []).forEach(c => relatedCams.push(c.id));
    } else {
      reply += `✅ **สถานะโดยรวม**: สภาพการจราจรในโครงข่ายส่วนใหญ่ยังเคลื่อนตัวได้ดี\n`;
    }
  }

  reply += `\n**ท่านสามารถสอบถามเจาะจงได้ เช่น**:\n`;
  reply += `- *"ถนนพระราม 4 ตอนนี้ติดไหม?"*\n`;
  reply += `- *"แนะนำการปล่อยไฟเขียว/หน่วงรถ"* \n`;
  reply += `- *"มีจุดไหนที่รถติดหนักที่สุด?"*\n`;

  return { reply, relatedCams };
}

/**
 * Calls Google Gemini API (Gemini 2.0 Flash Lite with robust fallback)
 */
async function callGemini(apiKey, query, ctx, history) {
  // Build comprehensive Map-grounded context for ALL roads
  const allRoadsMapContext = ctx.sortedRoads.map(r => {
    const c = r.congestion;
    const fwd = r.directions?.forward ? `ขาไป: ${r.directions.forward.label}` : '';
    const rev = r.directions?.reverse ? `ขากลับ: ${r.directions.reverse.label}` : '';
    const dirStr = [fwd, rev].filter(Boolean).join(', ');
    const camLinks = (r.cameras || []).map(cam => `${cam.title} [cam:${cam.id}]`).join(', ');
    return `- 🛣️ ถนน/แยก "${r.name}" ${dirStr ? `(${dirStr})` : ''}:
  * สีบนแผนที่ (Map Vector): 🔴 ติดขัด ${c ? c.share.jam : 0}% | 🟡 ชะลอตัว ${c ? c.share.slow : 0}% | 🟢 คล่องตัว ${c ? c.share.flowing : 0}%
  * ระดับความหนาแน่น: ${c ? c.label : 'ปกติ'} (คะแนน ${c ? c.score : 0}/100)
  * มาตรการไฟจราจร: ${r.advice ? r.advice.headline + ' - ' + r.advice.detail : 'ปกติ'}
  * กล้องตรวจจับ: ${camLinks || 'ไม่มีกล้อง'}`;
  }).join('\n');

  const promptContext = `
คุณคือ "AI ผู้ช่วยวิเคราะห์การจราจรอัจฉริยะ (BKK Traffic Gemini Flash Lite)" ประจำศูนย์ควบคุมจราจรกรุงเทพมหานคร
ทำงานด้วยโมเดล Gemini Flash Lite ความเร็วสูง เชื่อมต่อฐานข้อมูลสด Real-time จากระบบกล้อง CCTV, โมเดลตรวจจับรถ YOLO11x, และแผนที่เส้นสีจราจร Longdo Traffic Vector Tiles 33,000 เวกเตอร์เซกเมนต์

🔴🟡🟢 [กฎเหล็กสำคัญที่สุด: คำแนะนำต้องตรงกับแผนที่จราจร 100% (Strict Map Grounding)]:
1. คำตอบ สภาพจราจร และการแนะนำเส้นทางของคุณ "ต้องตรงกับข้อมูลสีเส้นบนแผนที่ (Map Vector)" ด้านล่างนี้ 100% เสมอ!
2. ห้ามคาดเดาหรือให้ข้อมูลที่ขัดแย้งกับสีของแผนที่เด็ดขาด:
   - ถนนที่มีเส้นสีแดง (ติดขัด / Jam >= 15%): ต้องแจ้งเตือนผู้ใช้ว่าเป็นจุดติดขัดสะสม คอขวด และแนะนำให้ "หลีกเลี่ยง"
   - ถนนที่มีเส้นสีเขียว (คล่องตัว / Flowing >= 65%): ให้แนะนำเป็น "เส้นทางเลี่ยงสีเขียว (Green Bypass)" ที่ควรใช้
   - ระบุเปอร์เซ็นต์สีแดง/เหลือง/เขียวให้ตรงกับตัวเลขจริงบนแผนที่เสมอ
3. หากผู้ใช้ถามว่า "ตรวจจากแมพได้ไหม" หรือ "ดูจากแผนที่" ให้ตอบอย่างมั่นใจว่าระบบประมวลผลข้อมูลเส้นสีเวกเตอร์บนแผนที่สดทุก 5 นาที และอิงคำตอบจากแผนที่โดยตรง

[ข้อมูลสถานะระบบภาพรวม]:
- ดัชนีจราจร กทม. (Longdo Traffic Index): ${ctx.trafficIndex}
- จำนวนกล้อง CCTV สด: ${ctx.totalCams} ตัว
- ปริมาณรถที่ AI นับได้ในพื้นที่กล้อง: รวม ${ctx.totalVehiclesCounted} คัน (รถเก๋ง/กระบะ: ${ctx.vehicleTypes.car}, มอเตอร์ไซค์: ${ctx.vehicleTypes.motorcycle}, รถเมล์: ${ctx.vehicleTypes.bus}, รถบรรทุก: ${ctx.vehicleTypes.truck})

[ข้อมูลเส้นสีบนแผนที่จราจรแบบสด 100% ทั่วกรุงเทพฯ (Real-Time Map Vector Readings)]:
${allRoadsMapContext}

[กล้องที่มีรถหนาแน่นสุดจาก YOLO]:
${ctx.busyCams.slice(0, 6).map(d => {
  const spd = d.area_speed ? `สถานะ ${d.area_speed.status_th || d.area_speed.status}, จอดนิ่ง ${d.area_speed.stopped_pct}%` : '';
  return `- กล้อง [🎥 ${d.title}](cam:${d.id}): พบรถ ${d.total} คัน ${spd}`;
}).join('\n')}

[การนำทางและเสนอทางเลี่ยงรถติด (Navigation & Bypass AI)]:
- วิเคราะห์ทิศทางการเดินทาง (จุดต้นทาง Origin และปลายทาง Destination) ให้ถูกต้องตรงตามคำถามของผู้ใช้เสมอ (ห้ามสลับทิศทาง)
- เสนอเปรียบเทียบอย่างน้อย 2 เส้นทาง (ทางหลัก vs ทางเลี่ยงสีเขียวบนแผนที่)
- ใส่ลิงก์กล้อง [🎥 ชื่อกล้อง](cam:CAM_ID) และแนบลิงก์เปิดนำทางบน Google Maps ในรูปแบบ [📍 เปิดนำทางบน Google Maps](https://www.google.com/maps/dir/?api=1&origin=ต้นทาง&destination=ปลายทาง&travelmode=driving) เสมอ

คำแนะนำการตอบ:
1. ตอบเป็นภาษาไทยอย่างสุภาพ เป็นมืออาชีพ ชัดเจน กระชับ และตรงประเด็น ตรวจสอบจุดเริ่มต้นและปลายทางให้ถูกต้อง 100% เสมอ
2. เมื่อกล่าวถึงกล้องใดๆ ให้ใส่ลิงก์ในรูปแบบ [🎥 ชื่อกล้อง](cam:CAM_ID) เพื่อให้ผู้ใช้กดดูภาพสดได้ทันที
3. เมื่อแนะนำเส้นทาง ให้แนบลิงก์ Google Maps Navigation ในรูปแบบ [📍 เปิดนำทางบน Google Maps](https://www.google.com/maps/dir/?api=1&origin=...&destination=...&travelmode=driving) เพื่อให้ผู้ใช้กดเปิดนำทางจริงได้ทันที
4. วิเคราะห์ทั้งด้านข้อมูลเส้นสีบนแผนที่, ปริมาณรถ, ความเร็วพื้นที่จริง, การนำทางเลี่ยงรถติด, และการบริหารจัดการสัญญาณไฟจราจร
`;

  const contents = [];
  if (Array.isArray(history)) {
    history.slice(-4).forEach(h => {
      contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content }] });
    });
  }
  contents.push({ role: 'user', parts: [{ text: `${promptContext}\n\nคำถามจากผู้ใช้: ${query}` }] });

  const body = JSON.stringify({
    contents,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1200,
    }
  });

  // Try Gemini 2.0 Flash Lite first, then fallback to other models if needed
  const models = ['gemini-2.0-flash-lite', 'gemini-2.0-flash-lite-preview-02-05', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastError = null;

  for (const model of models) {
    try {
      const text = await executeGeminiRequest(model, apiKey, body);
      return text;
    } catch (err) {
      lastError = err;
      // If model not supported or 404 on this key, try next candidate
      if (err.message && (err.message.includes('404') || err.message.includes('not found') || err.message.includes('unsupported'))) {
        continue;
      }
      break;
    }
  }

  throw lastError || new Error('Gemini API request failed');
}

function executeGeminiRequest(model, apiKey, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 15000
    }, (res) => {
      let respBody = '';
      res.on('data', chunk => { respBody += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(respBody);
          if (data.error) {
            reject(new Error(`[${model}] ${data.error.message || 'Gemini error'}`));
            return;
          }
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'ไม่สามารถสร้างคำตอบได้';
          resolve(text);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`[${model}] Gemini API timeout`)); });
    req.write(body);
    req.end();
  });
}

/**
 * Main handler exported for server.js
 */
async function handleChat(query, { history, apiKey, selectedCamId, cameras, adviceData, detectionsData, trafficIndex }) {
  const ctx = buildTrafficContext(cameras, adviceData, detectionsData, trafficIndex);
  const key = apiKey || process.env.GEMINI_API_KEY;

  if (key) {
    try {
      const reply = await callGemini(key, query, ctx, history);
      // Extract cam IDs mentioned in the reply
      const relatedCams = [];
      const camMatches = reply.matchAll(/cam:([A-Za-z0-9_-]+)/g);
      for (const m of camMatches) {
        if (!relatedCams.includes(m[1])) relatedCams.push(m[1]);
      }
      return { reply, relatedCams, mode: 'gemini' };
    } catch (err) {
      console.warn('Gemini call failed, falling back to built-in engine:', err.message);
      const fallback = runBuiltInEngine(query, ctx, selectedCamId);
      return {
        reply: `*(เชื่อมต่อ Gemini ไม่สำเร็จ: ${err.message} — สลับมาใช้ระบบวิเคราะห์ภายในอัตโนมัติ)*\n\n` + fallback.reply,
        relatedCams: fallback.relatedCams,
        mode: 'builtin-fallback'
      };
    }
  }

  const result = runBuiltInEngine(query, ctx, selectedCamId);
  return { ...result, mode: 'builtin' };
}

module.exports = {
  buildTrafficContext,
  handleChat
};
