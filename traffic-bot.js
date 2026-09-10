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

/**
 * Built-in Intelligent Traffic Engine (Offline / Local RAG)
 */
function runBuiltInEngine(query, ctx, selectedCamId) {
  const q = (query || '').trim().toLowerCase();
  const relatedCams = [];

  // 1. If asking about a specific selected camera
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
          reply += `- ⚡ **ความเร็วพื้นที่จริง**: **${spd.avg_px_s} px/s** (สถานะ: **${spd.status_th || spd.status}**)\n`;
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

  // 2. Road or Junction specific search in query
  const normQ = q.replace(/\s+/g, '');
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
          reply += ` · ความเร็วพื้นที่ **${det.area_speed.avg_px_s} px/s** · จอดนิ่ง **${det.area_speed.stopped_pct}%** (สถานะ: **${det.area_speed.status_th || det.area_speed.status}**)`;
        }
        reply += `\n`;
      } else {
        reply += `- *ไม่มีข้อมูล AI realtime ในขณะนี้*\n`;
      }
    });

    if (!isCam && matchedRoad.congestion) {
      const c = matchedRoad.congestion;
      reply += `\n**สภาพโครงข่ายถนน (${c.km} กม. รอบกล้อง)**:\n`;
      reply += `- ระดับ: **${c.label}** (คะแนน ${c.score}/100)\n`;
      reply += `- สัดส่วน: ติดขัด ${c.share.jam}% · ชะลอตัว ${c.share.slow}% · คล่องตัว ${c.share.flowing}%\n`;
    }

    if (!isCam && matchedRoad.advice) {
      reply += `\n💡 **ข้อเสนอแนะการจัดการจราจร**: ${matchedRoad.advice.headline}\n> ${matchedRoad.advice.detail}\n`;
    }

    return { reply, relatedCams };
  }

  // 3. Congestion Query: "ติดตรงไหน", "รถติด", "jam"
  if (q.includes('ติด') || q.includes('jam') || q.includes('หนาแน่น') || q.includes('แดง')) {
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
        const spdStr = d.area_speed ? ` · ความเร็ว ${d.area_speed.avg_px_s} px/s (${d.area_speed.status_th})` : '';
        reply += `- [🎥 ${d.title}](cam:${d.id}): ตรวจพบ **${d.total} คัน**${spdStr}\n`;
      });
    }

    return { reply, relatedCams };
  }

  // 4. Signal / Light Timing Advice: "ปล่อยไฟ", "สัญญาณไฟ", "ปล่อยรถ", "เขียว", "meter", "release"
  if (q.includes('ไฟ') || q.includes('ปล่อย') || q.includes('สัญญาณ') || q.includes('เขียว') || q.includes('แดง')) {
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
 * Calls Google Gemini API if user has provided an API key
 */
async function callGemini(apiKey, query, ctx, history) {
  const promptContext = `
คุณคือ "AI ผู้ช่วยวิเคราะห์การจราจรอัจฉริยะ (BKK Traffic AI Copilot)" ของศูนย์ควบคุมจราจรกรุงเทพฯ
คุณมีข้อมูลสภาพการจราจรแบบ Real-time จากระบบกล้อง CCTV, โมเดลตรวจจับวัตถุ YOLO11x, การคำนวณเวกเตอร์ความเร็ว Optical Flow และ Longdo Traffic Index ดังนี้:

[ข้อมูลสถานะระบบล่าสุด]:
- ดัชนีจราจรภาพรวม กทม. (Longdo Traffic Index): ${ctx.trafficIndex}
- จำนวนกล้อง CCTV สด: ${ctx.totalCams} ตัว
- ปริมาณรถที่ AI นับได้ในพื้นที่กล้อง: รวม ${ctx.totalVehiclesCounted} คัน (รถเก๋ง: ${ctx.vehicleTypes.car}, มอเตอร์ไซค์: ${ctx.vehicleTypes.motorcycle}, รถเมล์: ${ctx.vehicleTypes.bus}, รถบรรทุก: ${ctx.vehicleTypes.truck})

[ข้อมูลถนนและสัญญาณไฟที่มีการแนะนำ]:
${ctx.sortedRoads.slice(0, 8).map(r => {
  const c = r.congestion;
  return `- ${r.name}: ความหนาแน่น=${c ? c.label : 'N/A'} (คะแนน ${c ? c.score : 0}/100), ติดขัด=${c ? c.share.jam : 0}%, คล่องตัว=${c ? c.share.flowing : 0}%, คำแนะนำ=${r.advice ? r.advice.headline : 'ปกติ'}`;
}).join('\n')}

[กล้องที่มีรถหนาแน่นสุดจาก YOLO]:
${ctx.busyCams.slice(0, 5).map(d => {
  const spd = d.area_speed ? `ความเร็ว ${d.area_speed.avg_px_s} px/s, จอดนิ่ง ${d.area_speed.stopped_pct}% (${d.area_speed.status_th})` : '';
  return `- กล้อง ${d.title} (ID: ${d.id}): พบรถ ${d.total} คัน ${spd}`;
}).join('\n')}

คำแนะนำการตอบ:
1. ตอบเป็นภาษาไทยอย่างสุภาพ เป็นมืออาชีพ ชัดเจน กระชับ และตรงประเด็น
2. เมื่อกล่าวถึงกล้องใดๆ ให้ใส่ลิงก์ในรูปแบบ [🎥 ชื่อกล้อง](cam:CAM_ID) เพื่อให้ผู้ใช้กดดูภาพสดได้ทันที
3. วิเคราะห์ทั้งด้านปริมาณรถ, ความเร็วพื้นที่จริง, และการบริหารจัดการสัญญาณไฟจราจร
`;

  const contents = [];
  if (Array.isArray(history)) {
    history.slice(-4).forEach(h => {
      contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content }] });
    });
  }
  contents.push({ role: 'user', parts: [{ text: `${promptContext}\n\nคำถามจากผู้ใช้: ${query}` }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = JSON.stringify({
    contents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 1000,
    }
  });

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 12000
    }, (res) => {
      let respBody = '';
      res.on('data', chunk => { respBody += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(respBody);
          if (data.error) {
            reject(new Error(data.error.message || 'Gemini API error'));
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
    req.on('timeout', () => { req.destroy(new Error('Gemini API timeout')); });
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
