#!/usr/bin/env python3
"""
BMA Traffic CCTV Live Dashboard Server (Python 3 standard library only)
"""
import sys, os, time, json, ssl, urllib.request, urllib.parse, http.server, socketserver, threading

PORT = int(os.environ.get('PORT', 3000))
BMA_BASE = 'https://cpudapp.bangkok.go.th/bmatraffic'
USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

base_dir = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(base_dir, 'data', 'cameras.json'), 'r', encoding='utf-8') as f:
    cameras = json.load(f)
with open(os.path.join(base_dir, 'data', 'districts.json'), 'r', encoding='utf-8') as f:
    districts = json.load(f)

print(f"Loaded {len(cameras)} cameras and {len(districts)} districts.")

camera_dict = {c['id']: c for c in cameras}

class BmaSession:
    def __init__(self):
        self.cookie = None
        self.cookie_exp = 0
        self.lock = threading.Lock()
        self.activations = {}
        self.cache = {}
        self.ctx = ssl.create_default_context()
        self.ctx.check_hostname = False
        self.ctx.verify_mode = ssl.CERT_NONE

    def get_cookie(self):
        with self.lock:
            if self.cookie and time.time() < self.cookie_exp:
                return self.cookie
            try:
                req = urllib.request.Request(f"{BMA_BASE}/index.aspx", headers={'User-Agent': USER_AGENT})
                with urllib.request.urlopen(req, context=self.ctx, timeout=10) as resp:
                    raw_cookie = resp.headers.get('Set-Cookie', '')
                    if raw_cookie:
                        self.cookie = raw_cookie.split(';')[0]
                        self.cookie_exp = time.time() + 900
                        print(f"[BMA] Got session cookie: {self.cookie}")
            except Exception as e:
                print(f"[BMA] Error getting cookie: {e}")
            return self.cookie

    def activate_camera(self, cid):
        last = self.activations.get(cid, 0)
        if time.time() - last < 35:
            return
        cookie = self.get_cookie()
        headers = {'User-Agent': USER_AGENT, 'Referer': f"{BMA_BASE}/index.aspx"}
        if cookie:
            headers['Cookie'] = cookie
        try:
            req = urllib.request.Request(f"{BMA_BASE}/PlayVideo.aspx?ID={cid}", headers=headers)
            with urllib.request.urlopen(req, context=self.ctx, timeout=10) as resp:
                pass
            self.activations[cid] = time.time()
        except Exception as e:
            print(f"[BMA] Error activating camera {cid}: {e}")

    def fetch_frame(self, cid):
        cached = self.cache.get(cid)
        if cached and time.time() - cached['time'] < 0.7:
            return cached['data']
        self.activate_camera(cid)
        cookie = self.get_cookie()
        headers = {'User-Agent': USER_AGENT, 'Referer': f"{BMA_BASE}/PlayVideo.aspx?ID={cid}"}
        if cookie:
            headers['Cookie'] = cookie
        try:
            t = int(time.time() * 1000)
            req = urllib.request.Request(f"{BMA_BASE}/show.aspx?image={cid}&time={t}", headers=headers)
            with urllib.request.urlopen(req, context=self.ctx, timeout=10) as resp:
                data = resp.read()
                if len(data) > 2000:
                    self.cache[cid] = {'data': data, 'time': time.time()}
                    return data
                if len(data) <= 2000 and len(data) > 0:
                    self.activations.pop(cid, None)
                    return data
        except Exception as e:
            print(f"[BMA] Error fetching frame {cid}: {e}")
        return cached['data'] if cached else None

bma = BmaSession()
threading.Thread(target=bma.get_cookie, daemon=True).start()

class RequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == '/api/cameras':
            res = cameras
            if 'district' in query and query['district'][0] != 'all':
                d = query['district'][0].lower()
                res = [c for c in res if c['district_th'].lower() == d or c['district_en'].lower() == d or c['district_code'] == d]
            if 'search' in query and query['search'][0].strip():
                q = query['search'][0].lower().strip()
                res = [c for c in res if q in c['id'] or q in c['name'].lower() or q in c['name_en'].lower() or q in c['desc'].lower() or q in c['district_th'].lower()]
            body = json.dumps({'total': len(res), 'cameras': res}, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == '/api/districts':
            body = json.dumps({'total': len(districts), 'districts': districts}, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path.startswith('/api/cameras/'):
            cid = path.replace('/api/cameras/', '').strip('/')
            cam = camera_dict.get(cid)
            if not cam:
                self.send_error(404, 'Camera not found')
                return
            body = json.dumps(cam, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path.startswith('/api/snapshot/'):
            cid = path.replace('/api/snapshot/', '').strip('/')
            cam = camera_dict.get(cid)
            if not cam:
                self.send_error(404, 'Camera not found')
                return
            frame = bma.fetch_frame(cid)
            if not frame:
                self.send_error(503, 'Camera feed unavailable')
                return
            self.send_response(200)
            self.send_header('Content-Type', 'image/jpeg')
            self.send_header('Content-Length', str(len(frame)))
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.end_headers()
            self.wfile.write(frame)
            return

        if path.startswith('/api/stream/'):
            cid = path.replace('/api/stream/', '').strip('/')
            cam = camera_dict.get(cid)
            if not cam:
                self.send_error(404, 'Camera not found')
                return
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.send_header('Cache-Control', 'no-cache, private')
            self.send_header('Connection', 'close')
            self.end_headers()
            try:
                while True:
                    frame = bma.fetch_frame(cid)
                    if frame:
                        header = f"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {len(frame)}\r\n\r\n".encode('ascii')
                        self.wfile.write(header + frame + b"\r\n")
                        self.wfile.flush()
                    time.sleep(1.0)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        # Static files from public/
        req_path = path.lstrip('/')
        if not req_path:
            req_path = 'index.html'
        file_path = os.path.join(base_dir, 'public', req_path)
        if os.path.isfile(file_path):
            return super().do_GET()
        else:
            # Fallback to index.html
            self.path = '/index.html'
            return super().do_GET()

    def translate_path(self, path):
        req_path = path.lstrip('/')
        if not req_path:
            req_path = 'index.html'
        return os.path.join(base_dir, 'public', req_path)

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

if __name__ == '__main__':
    server = ThreadedHTTPServer(('', PORT), RequestHandler)
    print("=" * 60)
    print(f"🚀 BMA Traffic CCTV Dashboard (Python) running on port {PORT}")
    print(f"👉 http://localhost:{PORT}")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
