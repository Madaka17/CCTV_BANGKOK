# Frame publisher

## ทำไมต้องมี

เว็บ BMA (`cpudapp.bangkok.go.th`) อยู่หลัง Cloudflare ที่ตอบ bot challenge
(`"Just a moment..."` + HTTP 403 ไม่มี session cookie) ให้กับ IP ของศูนย์ข้อมูล
ทดสอบแล้วทั้ง region `iad1` และ `sin1` ของ Vercel โดนเหมือนกัน ขณะที่เครื่องในไทย
เรียกได้ปกติ แปลว่าเซิร์ฟเวอร์บน Vercel ดึงภาพกล้องเองไม่ได้เลย

สคริปต์นี้จึงรันบนเครื่องที่เรียก BMA ได้ (Mac ของคุณ) ดึงเฟรมแล้วอัปขึ้น
Cloudflare R2 ส่วนเว็บบน Vercel อ่านภาพจาก R2 แทน

```
เครื่องคุณ (ไทย) ──► BMA ──► Cloudflare R2 ──► เบราว์เซอร์ผู้ใช้
                                     ▲
                          Vercel function บอก URL
```

### ทำไมไม่ใช้ Vercel Blob

ลองแล้วใช้งานได้จริง แต่โควตาฟรีของ Hobby คือ **advanced operations (การเขียน)
2,000 ครั้งต่อเดือน** ขณะที่งานนี้เขียน 51 ไฟล์ต่อรอบ — โควตาทั้งเดือนหมดใน
ราว 20 นาที ส่วน R2 ให้ฟรี 1,000,000 writes + 10,000,000 reads + 10GB ต่อเดือน
และไม่คิดค่า egress

## โควตากับความถี่

R2 ฟรี = **1,000,000 writes/เดือน** งานนี้เขียน 51 ไฟล์ต่อรอบ (50 กล้อง + manifest):

| รอบ | writes/เดือน | % โควตา |
|---|---|---|
| 30 วิ | 4,406,400 | 441% ❌ |
| 1 นาที | 2,203,200 | 220% ❌ |
| 2 นาที | 1,101,600 | 110% ❌ |
| 3 นาที | 734,400 | 73% |
| **5 นาที (ค่าเริ่มต้น)** | **440,640** | **44%** |
| 10 นาที | 220,320 | 22% |

สคริปต์จะพิมพ์ตัวเลขนี้ให้ดูทุกครั้งที่เริ่มรัน และเตือนถ้าเกิน 100%

## ติดตั้งครั้งเดียว

**1. สร้าง R2 bucket**

สมัคร/เข้า [dash.cloudflare.com](https://dash.cloudflare.com) (ฟรี ไม่ต้องมีโดเมน)
→ เมนูซ้ายหัวข้อ **Build** → **Storage & databases** → **R2 Object Storage**
→ **Create bucket** → ตั้งชื่อ `cctv-frames` → **Create**

> nav ของ Cloudflare ไม่มีเมนู "R2" ที่ระดับบนสุดแล้ว ต้องเข้าผ่าน Storage & databases
> หรือกด `Cmd+K` แล้วพิมพ์ `R2`

> ครั้งแรกต้องกด **Enable R2** และผูกบัตรเพื่อยืนยันตัวตน แต่ไม่ตัดเงินถ้าอยู่ในโควตาฟรี

**2. เปิดให้อ่านแบบสาธารณะ**

ในหน้า bucket → แท็บ **Settings** → เมนูย่อย **Public Development URL** → **Enable**
แล้วพิมพ์ยืนยัน

> เดิม Cloudflare เรียกหัวข้อนี้ว่า "Public access / R2.dev subdomain" ตอนนี้เปลี่ยนชื่อแล้ว

จะได้ URL หน้าตาแบบ `https://pub-xxxxxxxxxxxx.r2.dev` — **คัดลอกเก็บไว้** นี่คือค่า
`R2_PUBLIC_BASE_URL`

**3. สร้าง API token**

หน้า R2 (ระดับบนสุด ไม่ใช่ในหน้า bucket) → **API** → **Manage API tokens**
→ **Create API token**

- Permission: **Object Read & Write**
- Specify bucket: เลือก `cctv-frames`
- **Create API Token**

หน้าถัดไปจะโชว์ **Access Key ID** กับ **Secret Access Key** — โชว์ครั้งเดียวเท่านั้น
คัดลอกทั้งคู่ไว้ก่อนปิดหน้า

**4. ใส่ค่าลง `.env.local`**

ที่ราก repo (`~/Desktop/camera/.env.local`, อยู่ใน `.gitignore` แล้ว):

```
R2_ACCOUNT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
R2_ACCESS_KEY_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
R2_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
R2_BUCKET=cctv-frames
R2_PUBLIC_BASE_URL=https://pub-xxxxxxxxxxxx.r2.dev
```

`R2_ACCOUNT_ID` หาได้จาก URL ของ dashboard (`dash.cloudflare.com/<account id>/...`)
หรือมุมขวาของหน้า R2

**5. รันรอบแรก**

```sh
npm run publish:once
```

จบแล้วจะพิมพ์บรรทัดนี้ออกมา:

```
Set this on the Vercel project (Settings -> Environment Variables), then redeploy:
  FRAMES_BASE_URL=https://pub-xxxxxxxxxxxx.r2.dev
```

**6. ตั้งบน Vercel**

Vercel dashboard → โปรเจกต์ `cctv-bangkok` → **Settings** → **Environment Variables**
→ เพิ่ม `FRAMES_BASE_URL` (เลือกครบทั้ง Production/Preview/Development) → **Redeploy**

เช็คว่าต่อติด:

```sh
curl https://cctv-bangkok.vercel.app/api/config
```

ต้องเห็น `"frames":"published"`

## ใช้งานประจำวัน

```sh
npm run publish:frames      # วนดึงทุก 5 นาที ปล่อยหน้าต่างนี้ไว้
```

รอบแรกจะช้าหน่อย (~25 วิ) เพราะต้องเปิด session ให้ทุกกล้อง รอบถัดๆ ไปเหลือ ~6-12 วิ
ถ้ารอบก่อนยังไม่จบ สคริปต์จะข้ามรอบนั้นไปเอง ไม่ยิงซ้อนกัน

หยุดด้วย `Ctrl-C` — พอหยุด ภาพบนเว็บจะค้างอยู่ที่เฟรมสุดท้ายที่อัปไว้

## คำสั่ง / ตัวเลือก

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run publish:frames` | วนดึงและอัปทุก `INTERVAL_SECONDS` |
| `npm run publish:once` | ดึงและอัปหนึ่งรอบแล้วจบ |
| `node publisher/publish-frames.js --once --dry-run` | ดึงจาก BMA อย่างเดียว ไม่อัป ไม่ต้องมี credential — ใช้เช็คว่าเครื่องนี้ยังผ่าน Cloudflare อยู่ไหม |

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `R2_ACCOUNT_ID` | — | account id ของ Cloudflare |
| `R2_ACCESS_KEY_ID` | — | จาก R2 API token |
| `R2_SECRET_ACCESS_KEY` | — | จาก R2 API token |
| `R2_BUCKET` | — | ชื่อ bucket |
| `R2_PUBLIC_BASE_URL` | — | URL สาธารณะของ bucket (`https://pub-….r2.dev`) |
| `INTERVAL_SECONDS` | `300` | ระยะห่างระหว่างรอบ — ดูตารางโควตาข้างบนก่อนลด |
| `CONCURRENCY` | `12` | ดึงพร้อมกันกี่กล้อง |
| `PUBLISH_CAMERA_IDS` | — | รายการ id คั่นด้วยจุลภาค ใช้แทน `cameras.json` ชั่วคราว |

## เปลี่ยนว่าจะเผยแพร่กล้องไหนบ้าง

แก้ `publisher/cameras.json` — ตอนนี้เลือกไว้ 50 กล้อง กระจายครบ 44 เขต โดยมี 4 กล้อง
ที่เป็นค่าเริ่มต้นของหน้า Multi-View อยู่ต้นรายการ

กล้องที่ **ไม่ได้** อยู่ในรายการจะไม่มีภาพบนเว็บที่ deploy (ข้อมูลกล้อง ตำแหน่งบนแผนที่
และสถิติจราจรยังแสดงครบทุกตัวตามเดิม) เพิ่มกล้องได้ แต่ writes ต่อรอบจะเพิ่มตาม
ดูตารางโควตาประกอบ

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
- ขึ้น `R2 PUT ... -> 403` → API token ผิด หรือไม่มีสิทธิ์เขียน bucket นี้
- ขึ้น `R2 PUT ... -> 404` → ชื่อ bucket หรือ account id ผิด
- ดึงและอัปได้ครบแต่เว็บยังไม่ขึ้นภาพ → `curl https://cctv-bangkok.vercel.app/api/config`
  - `"frames":"none"` แปลว่าเซิร์ฟเวอร์อ่าน `frames/manifest.json` ไม่ได้ — เช็คว่าตั้ง
    `FRAMES_BASE_URL` บน Vercel แล้ว redeploy หรือยัง และ bucket เปิด public access แล้วหรือยัง
  - ลองเปิด `<R2_PUBLIC_BASE_URL>/frames/manifest.json` ในเบราว์เซอร์ตรงๆ ต้องเห็น JSON
