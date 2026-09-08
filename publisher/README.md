# Frame publisher

## ทำไมต้องมี

เว็บ BMA (`cpudapp.bangkok.go.th`) อยู่หลัง Cloudflare ที่ตอบ bot challenge
(`"Just a moment..."` + HTTP 403 ไม่มี session cookie) ให้กับ IP ของศูนย์ข้อมูล
ทดสอบแล้วทั้ง region `iad1` และ `sin1` ของ Vercel โดนเหมือนกัน ขณะที่เครื่องในไทย
เรียกได้ปกติ แปลว่าเซิร์ฟเวอร์บน Vercel ดึงภาพกล้องเองไม่ได้เลย

สคริปต์นี้จึงรันบนเครื่องที่เรียก BMA ได้ (Mac ของคุณ) ดึงเฟรมแล้วอัปขึ้น
Vercel Blob ส่วนเว็บบน Vercel อ่านภาพจาก Blob แทน

```
เครื่องคุณ (ไทย) ──► BMA ──► Vercel Blob ──► เบราว์เซอร์ผู้ใช้
                                    ▲
                          Vercel function บอก URL
```

## ติดตั้งครั้งเดียว

**1. สร้าง Blob store**

ที่ Vercel dashboard → โปรเจกต์ `cctv-bangkok` → แท็บ **Storage** → **Create Database**
→ เลือก **Blob** → ตั้งชื่อ (เช่น `cctv-frames`) → **Create**

**2. เอา token มาใส่เครื่อง**

ในหน้า store ที่เพิ่งสร้าง กด **`.env.local`** แล้วคัดลอกค่า `BLOB_READ_WRITE_TOKEN`
เอามาสร้างไฟล์ `.env.local` ที่ราก repo (ไฟล์นี้อยู่ใน `.gitignore` แล้ว ไม่ถูก commit):

```
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxxxxxxxxxxx
```

**3. ลงแพ็กเกจ**

```sh
npm install
```

**4. รันรอบแรก แล้วเอา URL ไปตั้งบน Vercel**

```sh
npm run publish:once
```

จบแล้วสคริปต์จะพิมพ์บรรทัดแบบนี้ออกมา:

```
Set this on the Vercel project (Settings -> Environment Variables), then redeploy:
  BLOB_BASE_URL=https://xxxxxxxx.public.blob.vercel-storage.com
```

เอาไปใส่ที่ Vercel dashboard → **Settings** → **Environment Variables**
(ชื่อ `BLOB_BASE_URL`, เลือกครบทั้ง Production/Preview/Development) แล้ว **Redeploy** หนึ่งครั้ง

เสร็จแล้วเว็บจะขึ้นแถบสีฟ้าบอกว่าเป็นภาพจากคลังภาพ และดึงรูปจาก Blob CDN โดยตรง

## ใช้งานประจำวัน

```sh
npm run publish:frames      # วนดึงทุก 30 วิ ปล่อยหน้าต่างนี้ไว้
```

รอบแรกจะช้าหน่อย (~25 วิ) เพราะต้องเปิด session ให้ทุกกล้อง รอบถัดๆ ไปเหลือ ~6-12 วิ
ถ้ารอบก่อนยังไม่จบ ตัวสคริปต์จะข้ามรอบนั้นไปเอง ไม่ยิงซ้อนกัน

หยุดด้วย `Ctrl-C` — พอหยุด ภาพบนเว็บจะค้างอยู่ที่เฟรมสุดท้ายที่อัปไว้

## คำสั่ง / ตัวเลือก

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run publish:frames` | วนดึงและอัปทุก `INTERVAL_SECONDS` |
| `npm run publish:once` | ดึงและอัปหนึ่งรอบแล้วจบ |
| `node publisher/publish-frames.js --once --dry-run` | ดึงจาก BMA อย่างเดียว ไม่อัป ไม่ต้องมี token — ใช้เช็คว่าเครื่องนี้ยังผ่าน Cloudflare อยู่ไหม |

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | — | token ของ Blob store (จำเป็น) |
| `INTERVAL_SECONDS` | `30` | ระยะห่างระหว่างรอบ |
| `CONCURRENCY` | `12` | ดึงพร้อมกันกี่กล้อง |
| `PUBLISH_CAMERA_IDS` | — | รายการ id คั่นด้วยจุลภาค ใช้แทน `cameras.json` ชั่วคราว |

## เปลี่ยนว่าจะเผยแพร่กล้องไหนบ้าง

แก้ `publisher/cameras.json` — ตอนนี้เลือกไว้ 50 กล้อง กระจายครบ 44 เขต โดยมี 4 กล้อง
ที่เป็นค่าเริ่มต้นของหน้า Multi-View อยู่ต้นรายการ

กล้องที่ **ไม่ได้** อยู่ในรายการจะไม่มีภาพบนเว็บที่ deploy (ข้อมูลกล้อง ตำแหน่งบนแผนที่
และสถิติจราจรยังแสดงครบทุกตัวตามเดิม) เพิ่มได้ แต่ดูโควตา Blob ด้วย — 50 กล้อง/30 วิ
คิดเป็นราว 144,000 writes ต่อวัน และพื้นที่เก็บราว 2 MB (เขียนทับที่เดิม ไม่สะสม)

## รันอัตโนมัติเมื่อเปิดเครื่อง (ถ้าต้องการ)

สร้าง `~/Library/LaunchAgents/com.cctv.publisher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cctv.publisher</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/vexila/Desktop/camera/publisher/publish-frames.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/vexila/Desktop/camera</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/cctv-publisher.log</string>
  <key>StandardErrorPath</key><string>/tmp/cctv-publisher.err</string>
</dict>
</plist>
```

ตรวจ path ของ node ด้วย `which node` ก่อน แล้วโหลดด้วย
`launchctl load ~/Library/LaunchAgents/com.cctv.publisher.plist`

## เมื่อภาพไม่ขึ้น

รัน `node publisher/publish-frames.js --once --dry-run`

- ขึ้น `no session cookie ... challenged by Cloudflare` → เครื่องนี้โดน Cloudflare กั้นแล้ว
  ลองเปิด https://cpudapp.bangkok.go.th/bmatraffic/index.aspx ในเบราว์เซอร์ก่อน
- ดึงได้ครบแต่เว็บยังไม่ขึ้นภาพ → เช็คว่าตั้ง `BLOB_BASE_URL` บน Vercel แล้ว redeploy หรือยัง
  ดูได้จาก `curl https://cctv-bangkok.vercel.app/api/config` ต้องเห็น `"frames":"published"`
