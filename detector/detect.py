#!/usr/bin/env python3
"""
Vehicle detection for the live cameras.

Grabs one frame from each camera in turn, counts the vehicles in it with YOLO,
and serves the results over HTTP. Nothing is written to disk: the counts and the
annotated frames live in memory, and the newest reading replaces the last.

    detector/.venv/bin/python detector/detect.py

    GET /detections          counts for every camera, newest first
    GET /frame/<camid>.jpg   the last annotated frame for one camera
    GET /health              model and loop status

The web server proxies these at /api/detections and /api/detect-frame/<id>.
"""

import argparse
import io
import json
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
from ultralytics import YOLO

# COCO classes that are vehicles, and what to call them in Thai
VEHICLES = {
    2: ("car", "รถยนต์"),
    3: ("motorcycle", "จักรยานยนต์"),
    5: ("bus", "รถโดยสาร"),
    7: ("truck", "รถบรรทุก"),
}
BOX_COLOURS = {2: (80, 200, 12), 3: (4, 222, 254), 5: (255, 120, 20), 7: (32, 32, 255)}

state = {
    "detections": {},   # camid -> reading
    "frames": {},       # camid -> annotated jpeg bytes
    "cameras": [],
    "model": None,
    "started": time.time(),
    "sweeps": 0,
    "error": None,
}
lock = threading.Lock()


# --- Camera list -----------------------------------------------------------

def load_cameras(site):
    with urllib.request.urlopen(f"{site}/api/video-cameras", timeout=30) as r:
        return json.load(r).get("cameras", [])


# --- Frame capture ---------------------------------------------------------

def grab_frame(hls_url, timeout=25):
    """One frame from a live stream, as encoded JPEG bytes."""
    proc = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-rw_timeout", "15000000",
            "-i", hls_url,
            "-frames:v", "1", "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "-",
        ],
        capture_output=True,
        timeout=timeout,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError((proc.stderr.decode()[:150] or "no frame").strip())
    return proc.stdout


# --- Detection -------------------------------------------------------------

def detect(model, jpeg_bytes, confidence):
    import numpy as np

    frame = cv2.imdecode(np.frombuffer(jpeg_bytes, dtype="uint8"), cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError("could not decode frame")

    result = model.predict(frame, conf=confidence, verbose=False)[0]

    counts = {}
    total = 0
    for box in result.boxes:
        cls = int(box.cls[0])
        if cls not in VEHICLES:
            continue
        name = VEHICLES[cls][0]
        counts[name] = counts.get(name, 0) + 1
        total += 1

        x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
        colour = BOX_COLOURS[cls]
        cv2.rectangle(frame, (x1, y1), (x2, y2), colour, 2)
        label = f"{name} {float(box.conf[0]):.2f}"
        cv2.rectangle(frame, (x1, y1 - 18), (x1 + 8 * len(label), y1), colour, -1)
        cv2.putText(frame, label, (x1 + 3, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)

    banner = f"{total} vehicles"
    cv2.rectangle(frame, (8, 8), (8 + 11 * len(banner), 34), (0, 0, 0), -1)
    cv2.putText(frame, banner, (14, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
    return counts, total, (buf.tobytes() if ok else None)


# --- Sweep loop ------------------------------------------------------------

def sweep(model, cameras, confidence):
    for cam in cameras:
        cam_id = cam["id"]
        started = time.time()
        try:
            counts, total, annotated = detect(model, grab_frame(cam["hls"]), confidence)
            reading = {
                "id": cam_id,
                "title": cam["title"],
                "total": total,
                "counts": counts,
                "at": time.time(),
                "ms": int((time.time() - started) * 1000),
                "error": None,
            }
            with lock:
                state["detections"][cam_id] = reading
                if annotated:
                    state["frames"][cam_id] = annotated
        except Exception as exc:
            with lock:
                state["detections"][cam_id] = {
                    "id": cam_id,
                    "title": cam["title"],
                    "total": None,
                    "counts": {},
                    "at": time.time(),
                    "ms": int((time.time() - started) * 1000),
                    "error": str(exc)[:150],
                }


def loop(site, interval, confidence, weights):
    print(f"Loading {weights} ...", flush=True)
    model = YOLO(weights)
    state["model"] = weights
    print("Model ready", flush=True)

    while True:
        started = time.time()
        try:
            cameras = load_cameras(site)
            if cameras:
                with lock:
                    state["cameras"] = cameras
                    state["error"] = None
            sweep(model, state["cameras"], confidence)
            state["sweeps"] += 1

            seen = [d for d in state["detections"].values() if d["total"] is not None]
            print(
                f"[{time.strftime('%H:%M:%S')}] sweep {state['sweeps']}: "
                f"{len(seen)}/{len(state['cameras'])} cameras, "
                f"{sum(d['total'] for d in seen)} vehicles, "
                f"{time.time() - started:.0f}s",
                flush=True,
            )
        except Exception as exc:
            state["error"] = str(exc)[:200]
            print("sweep failed:", exc, flush=True)

        # Pace by when the sweep started, so a slow one does not compound
        time.sleep(max(1, interval - (time.time() - started)))


# --- HTTP ------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # the sweep log is the useful one

    def _send(self, code, body, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode(), "application/json; charset=utf-8")

    def do_GET(self):
        if self.path.startswith("/frame/"):
            cam_id = self.path[len("/frame/"):].split("?")[0].removesuffix(".jpg")
            with lock:
                frame = state["frames"].get(cam_id)
            if frame:
                self._send(200, frame, "image/jpeg")
            else:
                self._json(404, {"error": "no frame yet"})
            return

        if self.path.startswith("/detections"):
            with lock:
                readings = sorted(
                    state["detections"].values(),
                    key=lambda d: (d["total"] is None, -(d["total"] or 0)),
                )
            self._json(200, {
                "sweeps": state["sweeps"],
                "cameras": len(state["cameras"]),
                "detections": readings,
            })
            return

        if self.path.startswith("/health"):
            self._json(200, {
                "model": state["model"],
                "sweeps": state["sweeps"],
                "cameras": len(state["cameras"]),
                "uptime": int(time.time() - state["started"]),
                "error": state["error"],
            })
            return

        self._json(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="http://127.0.0.1:3000", help="where to read the camera list from")
    ap.add_argument("--port", type=int, default=5056)
    ap.add_argument("--interval", type=int, default=60, help="seconds between sweeps")
    ap.add_argument("--conf", type=float, default=0.35)
    ap.add_argument("--weights", default="yolov8n.pt")
    args = ap.parse_args()

    threading.Thread(
        target=loop,
        args=(args.site, args.interval, args.conf, args.weights),
        daemon=True,
    ).start()

    print(f"Detector on http://127.0.0.1:{args.port}  (sweep every {args.interval}s)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
