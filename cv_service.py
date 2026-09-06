import os
import sys
import io
import time
import json
import base64
import http.server
import socketserver
import urllib.request
import threading
import numpy as np
from PIL import Image, ImageOps
from scipy import ndimage

PORT = 5055
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
TRAFFIC_PATH = os.path.join(DATA_DIR, 'traffic_analysis.json')
CAMERAS_PATH = os.path.join(DATA_DIR, 'cameras.json')

# Cache of last analyzed frame per camera for inter-frame temporal motion analysis
CAMERA_PREV_FRAMES = {}

def analyze_frame_cv(curr_img_bytes, prev_img_bytes=None, cid=None):
    try:
        img_curr = Image.open(io.BytesIO(curr_img_bytes))
        w, h = img_curr.size
        # ROI: focus on road surface, skip BMA text overlay at bottom (last 10%) & top (15%)
        roi_box = (int(w * 0.05), int(h * 0.15), int(w * 0.95), int(h * 0.90))
        gray_curr = ImageOps.grayscale(img_curr.crop(roi_box))
        arr_curr = np.array(gray_curr, dtype=np.float32)

        # 1. Edge magnitude (Vehicles produce sharp geometric contrast edges)
        sobel = np.hypot(ndimage.sobel(arr_curr, 0), ndimage.sobel(arr_curr, 1))
        edge_dens = float(np.mean(sobel > 32.0) * 100.0)

        # 2. Local texture variance (Cars break uniform asphalt surface)
        u = ndimage.uniform_filter(arr_curr, size=9)
        var = np.maximum(0.0, ndimage.uniform_filter(arr_curr**2, size=9) - u**2)
        tex_dens = float(np.mean(var > 220.0) * 100.0)

        # Combined vehicle occupancy
        raw_occupancy = 0.55 * edge_dens + 0.45 * tex_dens
        # Calibrate: baseline empty road ~25%, fully congested ~85%
        density = int(np.clip((raw_occupancy - 25.0) / (85.0 - 25.0) * 85.0 + 15.0, 8, 98))

        # 3. Inter-frame temporal motion (Vehicular velocity)
        motion_pct = 0.0
        if prev_img_bytes:
            try:
                img_prev = Image.open(io.BytesIO(prev_img_bytes))
                gray_prev = ImageOps.grayscale(img_prev.crop(roi_box))
                arr_prev = np.array(gray_prev, dtype=np.float32)
                diff = np.abs(arr_curr - arr_prev)
                motion_pct = float(np.mean(diff > 18.0) * 100.0)
            except Exception:
                motion_pct = 0.0

        # High-accuracy Classification based on Density + Velocity
        if density >= 70 and motion_pct < 6.0:
            status = 'congested'
            status_th = 'ติดขัด'
            speed_val = max(5, int(15 - (density - 70) * 0.3))
            speed_est = f'{speed_val} กม./ชม.'
            desc_th = 'การจราจรติดขัดสะสม เคลื่อนตัวช้าสลับหยุดนิ่ง'
        elif density >= 55 or (density >= 45 and motion_pct < 8.0):
            status = 'moderate'
            status_th = 'ชะลอตัว'
            speed_val = int(22 + motion_pct * 1.6)
            speed_est = f'{speed_val} กม./ชม.'
            desc_th = 'การจราจรชะลอตัว ปริมาณรถปานกลางเคลื่อนตัวได้เรื่อยๆ'
        else:
            status = 'flowing'
            status_th = 'คล่องตัว'
            speed_val = int(50 + motion_pct * 1.8)
            speed_est = f'{speed_val} กม./ชม.'
            desc_th = 'การจราจรคล่องตัว สัญจรสะดวกใช้ความเร็วได้ตามปกติ'

        if cid:
            CAMERA_PREV_FRAMES[cid] = curr_img_bytes

        return {
            'success': True,
            'id': cid,
            'density': density,
            'edge_dens': round(edge_dens, 1),
            'tex_dens': round(tex_dens, 1),
            'motion_pct': round(motion_pct, 1),
            'status': status,
            'status_th': status_th,
            'speed_est': speed_est,
            'desc_th': desc_th,
            'ai_method': 'Computer Vision (Sobel Contours + Temporal Diff)',
            'analyzed_at': time.strftime('%H:%M:%S น.', time.localtime()),
            'timestamp': int(time.time() * 1000)
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}

class CVRequestHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'ok', 'service': 'cv_analyzer', 'port': PORT}).encode('utf-8'))
            return

        if self.path.startswith('/analyze-camera/'):
            cid = self.path.replace('/analyze-camera/', '').split('?')[0]
            try:
                # Fetch fresh snapshot from node server on 3000
                t = int(time.time() * 1000)
                req = urllib.request.Request(f'http://127.0.0.1:3000/api/snapshot/{cid}?t={t}', headers={'User-Agent': 'Mozilla/5.0'})
                curr_bytes = urllib.request.urlopen(req, timeout=4).read()
                prev_bytes = CAMERA_PREV_FRAMES.get(cid)
                result = analyze_frame_cv(curr_bytes, prev_bytes, cid)

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode('utf-8'))
                return
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode('utf-8'))
                return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path == '/analyze':
            content_len = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_len)
            try:
                payload = json.loads(body.decode('utf-8'))
                curr_bytes = base64.b64decode(payload['current_frame'])
                cid = payload.get('cid')
                prev_bytes = None
                if payload.get('prev_frame'):
                    prev_bytes = base64.b64decode(payload['prev_frame'])
                elif cid and cid in CAMERA_PREV_FRAMES:
                    prev_bytes = CAMERA_PREV_FRAMES[cid]

                result = analyze_frame_cv(curr_bytes, prev_bytes, cid)

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode('utf-8'))
                return
            except Exception as e:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode('utf-8'))
                return

        self.send_response(404)
        self.end_headers()

class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True

if __name__ == '__main__':
    server = ThreadedTCPServer(('127.0.0.1', PORT), CVRequestHandler)
    print(f'[CV Service] Computer Vision Traffic Analyzer running on port {PORT}...')
    server.serve_forever()
