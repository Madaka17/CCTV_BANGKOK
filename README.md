# BMA Traffic CCTV Live Dashboard & Stream Proxy 🚦📹
ระบบดึงภาพและสตรีมสดกล้องวงจรปิดตรวจวัดสภาพการจราจร กรุงเทพมหานคร (BMA Traffic) พร้อมหน้าเว็บแสดงกล้องครบทุกตัว และระบบคัดกรองตามเขต/อำเภอ

---

## 📌 สรุปคำตอบ: สามารถดึงวิดีโอมาโชว์ใน Dashboard ได้หรือไม่?

**ได้แน่นอน 100%!** โดยมีรายละเอียดทางเทคนิคดังนี้:

1. **กลไกการส่งภาพของเว็บ BMA:**
   - ต้นทาง (`https://cpudapp.bangkok.go.th/bmatraffic/`) **ไม่ได้ใช้โปรโตคอล RTSP หรือ HLS (.m3u8)** โดยตรง แต่ใช้ระบบ **Dynamic Image Refresh (MJPEG Frame Polling)** อัปเดตเฟรมภาพต่อเนื่องทุก ~1 วินาที ผ่าน `show.aspx?image=<cameraId>&time=<timestamp>`
2. **ข้อจำกัดที่พบและวิธีแก้:**
   - **ติด CSP (Content Security Policy):** หน้าเว็บเดิมมีเฮดเดอร์ `frame-ancestors 'self'` จึงไม่สามารถนำลิงก์ `PlayVideo.aspx` ไปใส่ใน `<iframe>` ของเว็บอื่นได้โดยตรง (เบราว์เซอร์จะบล็อก)
   - **ต้องมี Session Handshake:** การเรียก `show.aspx` ตรง ๆ โดยไม่มี Session หรือไม่ได้ส่งสัญญาณเปิดกล้องผ่าน `PlayVideo.aspx` ก่อน ตัวเซิร์ฟเวอร์ BMA จะคืนค่าภาพสีขาวว่างเปล่า (Blank Frame ~1.4 KB)
   - **ทางออก:** เราได้พัฒนา **Stream Proxy Server** (มีให้เลือกทั้ง **Node.js** และ **Python 3** โดยไม่ต้องลง Library ภายนอกเพิ่ม) ทำหน้าที่:
     1. ผูก Session กับเซิร์ฟเวอร์ BMA อัตโนมัติ
     2. Handshake เปิดกล้องตาม ID ที่ร้องขอ
     3. แปลงเป็นสตรีม **MJPEG (`multipart/x-mixed-replace`)** และ **CORS-enabled JPEG Snapshot** ทำให้สามารถนำไปใส่ในแท็ก `<img>` บนหน้าเว็บใดก็ได้ทันที!

---

## 🚀 วิธีเปิดใช้งานระบบ (Quick Start)

### ตัวเลือกที่ 1: รันด้วย Node.js (แนะนำ - เร็วและรองรับหลายการเชื่อมต่อพร้อมกัน)
```bash
node server.js
# หรือ
npm start
```

### ตัวเลือกที่ 2: รันด้วย Python 3 (Standard Library - ไม่ต้องลง pip เพิ่ม)
```bash
python3 server.py
# หรือ
npm run py
```

เมื่อเซิร์ฟเวอร์เริ่มทำงาน เปิดเบราว์เซอร์ไปที่:
👉 **[http://localhost:3000](http://localhost:3000)**

---

## 🌟 ฟีเจอร์ของหน้าเว็บ Dashboard

1. **ตารางกล้องสด (Grid View):**
   - แสดงกล้องวงจรปิดครบทั้ง **611 ตัวทั่วกรุงเทพฯ**
   - มีปุ่ม **"▶️ เล่นสด"** บนการ์ดกล้องแต่ละตัว สามารถเปิดดูวิดีโอสดในกริดได้ทันที
   - ค้นหาแบบเรียลไทม์: ค้นหาตามชื่อทางแยก, รหัสกล้อง (#603), ชื่อถนน หรือชื่อเขต
2. **ตัวกรองเขต/อำเภอ (District Filter):**
   - เมนูดรอปดาวน์เลือกตาม **50 เขตในกรุงเทพมหานคร** พร้อมแสดงจำนวนกล้องในแต่ละเขต (เช่น ดุสิต 97 ตัว, ราชเทวี 55 ตัว, พระนคร 51 ตัว, ปทุมวัน 42 ตัว, จตุจักร 35 ตัว ฯลฯ)
   - แท็กคัดกรองด่วน: สะพานข้ามแม่น้ำเจ้าพระยา, ย่านธุรกิจ (CBD: สาทร/สีลม/ปทุมวัน), ฝั่งธนบุรี
3. **แผนที่ระบุพิกัดกล้อง (Interactive Map View):**
   - แสดงหมุดกล้องทุกตัวบนแผนที่กรุงเทพฯ (Leaflet + OpenStreetMap Dark Mode)
   - คลิกที่หมุดเพื่อเปิด Popup ชมวิดีโอสด ณ ตำแหน่งนั้นทันที
   - เมื่อเลือกเขต แผนที่จะซูมและปรับมุมมองเข้าสู่ขอบเขตของเขตนั้นโดยอัตโนมัติ
4. **มัลติวิว / ผนังกล้อง (Wall Mode):**
   - โหมด Control Room แสดงสตรีมสดพร้อมกันแบบ 4 จอ (2x2) หรือ 9 จอ (3x3)
   - สามารถกดปุ่ม **"+ Wall"** จากกล้องใดก็ได้เพื่อนำเข้ามาจับตาดูพร้อมกัน
5. **เครื่องเล่นสดจอใหญ่ (Live Modal Player):**
   - แสดงวิดีโอสดความละเอียดเต็ม พร้อมเวลาดิจิทัลแบบเรียลไทม์
   - ปุ่มบันทึกภาพนิ่ง (Download Snapshot JPEG)
   - ลิงก์เปิดตำแหน่งบน Google Maps
   - ปุ่มคัดลอก URL สตรีมไปใช้งานภายนอก

---

## 🔌 API Endpoints สำหรับนำไปเชื่อมต่อ Dashboard ภายนอก

### 1. MJPEG Video Stream (แนะนำสำหรับวิดีโอสดต่อเนื่อง)
```http
GET /api/stream/:cameraId
```
- **Content-Type:** `multipart/x-mixed-replace; boundary=frame`
- นำไปใส่ในแท็ก HTML `<img>` หรือ Video Widget ใน Dashboard ได้ทันที:
  ```html
  <!-- ตัวอย่าง: กล้อง 603 (แยกสีลม-นราธิวาส) -->
  <img src="http://localhost:3000/api/stream/603" width="640" height="426" alt="CCTV" />
  ```

### 2. Live Snapshot (สำหรับดึงภาพนิ่งล่าสุด)
```http
GET /api/snapshot/:cameraId
```
- **Content-Type:** `image/jpeg`
- คืนค่าภาพ JPEG ล่าสุด พร้อมรองรับ CORS ทุกโดเมน

### 3. ข้อมูลกล้องทั้งหมด (JSON)
```http
GET /api/cameras
GET /api/cameras?district=บางรัก
GET /api/cameras?search=สีลม
```

### 4. สรุปรายการเขต (JSON)
```http
GET /api/districts
```

### 5. คำแนะนำการปล่อยรถรายถนน (JSON)
```http
GET /api/traffic-advice
```
อ่านสีเส้นจราจร (เขียว/เหลือง/แดง) จากไทล์เดียวกับที่แผนที่ใช้ รอบกล้องแต่ละตัวในรัศมี 700 เมตร
แล้วสรุปเป็นคำแนะนำว่าควรเพิ่มไฟเขียว หน่วงรถ หรือปล่อยตามปกติ แคชไว้ 5 นาทีเท่ากับรอบที่ต้นทางระบายสีใหม่

ไทล์จราจรไม่มีชื่อถนน มีแค่สีสองทิศกับลำดับชั้นถนน ชื่อบนการ์ดจึงมาจากชื่อกล้องที่อยู่ใกล้ที่สุด
และสีบอกว่าถนน*ดูแน่นแค่ไหน* ไม่ได้บอกอัตรารถต่อนาที ตัวเลขวินาทีที่แนะนำจึงเป็นจุดตั้งต้น ไม่ใช่ค่าที่ตั้งได้เลย

---

## 🛠️ ตัวอย่างการนำสตรีมไปใช้ในระบบต่าง ๆ

### A. Grafana Dashboard
1. เพิ่ม Panel ชนิด **Canvas** หรือ **Text (HTML)**
2. ระบุ Content เป็น HTML:
   ```html
   <img src="http://<SERVER_IP>:3000/api/stream/603" style="width: 100%; border-radius: 8px;" />
   ```

### B. Home Assistant
เพิ่มในไฟล์ `configuration.yaml`:
```yaml
camera:
  - platform: mjpeg
    name: "BMA CCTV Silom"
    mjpeg_url: "http://<SERVER_IP>:3000/api/stream/603"
    still_image_url: "http://<SERVER_IP>:3000/api/snapshot/603"
```

### C. Python OpenCV (ตรวจจับรถ / นับยานพาหนะ / AI)
```python
import cv2

# เชื่อมต่อไปยัง MJPEG Stream ของกล้อง 603
cap = cv2.VideoCapture("http://localhost:3000/api/stream/603")

while cap.isOpened():
    ret, frame = cap.read()
    if not ret:
        break
    
    # ประมวลผลภาพหรือนำเข้าโมเดล YOLO / AI
    cv2.imshow("BMA Traffic Live", frame)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()
```

### D. OBS Studio / VLC Player
- ใน OBS: เพิ่ม Source -> เลือก **Browser Source** ใส่ URL `http://localhost:3000/api/stream/603` หรือเลือก **Media Source**
- ใน VLC: เมนู **Media** -> **Open Network Stream** -> ใส่ URL `http://localhost:3000/api/stream/603`

---

## 📁 โครงสร้างโปรเจกต์
```
├── server.js              # Node.js Streaming Proxy & Web Server (Zero dependencies)
├── server.py              # Python 3 Streaming Proxy & Web Server (Zero dependencies)
├── package.json           # Scripts และคำสั่งเริ่มต้น
├── data/
│   ├── cameras.json       # ข้อมูลกล้อง 611 ตัว พร้อมพิกัด GPS และเขต กทม.
│   └── districts.json     # สรุป 50 เขตในกรุงเทพฯ และจำนวนกล้อง
├── public/
│   ├── index.html         # หน้าแดชบอร์ดหลัก (Tailwind CSS, Leaflet.js, Multi-view)
│   ├── css/
│   │   └── app.css        # สไตล์และแอนิเมชันสำหรับแผนที่และการ์ดกล้อง
│   └── js/
│       └── app.js         # ลอจิกการทำงานหน้าเว็บ, ฟิลเตอร์เขต, แผนที่, คัดกรอง
└── README.md              # คู่มือการใช้งานและเอกสารอ้างอิง API
```
