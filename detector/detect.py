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

import json
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
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
    # The camera someone is watching, detected continuously rather than once a
    # sweep. Held only while the page keeps saying it is still watching.
    "focus": None,
    "focus_until": 0,
    "focus_fps": 0.0,
}
lock = threading.Lock()
FOCUS_TTL = 20  # seconds without a heartbeat before focus is dropped


# --- Camera list -----------------------------------------------------------

def load_cameras(site):
    with urllib.request.urlopen(f"{site}/api/video-cameras", timeout=30) as r:
        return json.load(r).get("cameras", [])


def ensure_cameras(site):
    """The list, fetching it if we do not have one yet.

    The web server may not be up when the detector starts, and waiting a whole
    sweep interval to notice leaves focus with nothing to work on.
    """
    with lock:
        if state["cameras"]:
            return state["cameras"]
    try:
        cameras = load_cameras(site)
    except Exception as exc:
        state["error"] = str(exc)[:200]
        return []
    if cameras:
        with lock:
            state["cameras"] = cameras
            state["error"] = None
    return cameras


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

def detect(model, jpeg_bytes, confidence, imgsz=1280):
    import numpy as np

    frame = cv2.imdecode(np.frombuffer(jpeg_bytes, dtype="uint8"), cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError("could not decode frame")

    # These are traffic cameras looking down a street, so the vehicles are small.
    # Inferring at 1280 rather than the default 640 roughly doubles what is found;
    # yolov8n missed almost everything, so the small model is the floor here.
    result = model.predict(frame, imgsz=imgsz, conf=confidence, verbose=False)[0]

    counts = {}
    boxes = []
    total = 0
    height, width = frame.shape[:2]

    for box in result.boxes:
        cls = int(box.cls[0])
        if cls not in VEHICLES:
            continue
        name = VEHICLES[cls][0]
        counts[name] = counts.get(name, 0) + 1
        total += 1

        x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
        # Normalised, so the page can lay them over a video of any size
        boxes.append({
            "k": name,
            "c": round(float(box.conf[0]), 2),
            "x": round(x1 / width, 4),
            "y": round(y1 / height, 4),
            "w": round((x2 - x1) / width, 4),
            "h": round((y2 - y1) / height, 4),
        })

        colour = BOX_COLOURS[cls]
        cv2.rectangle(frame, (x1, y1), (x2, y2), colour, 2)
        label = f"{name} {float(box.conf[0]):.2f}"
        cv2.rectangle(frame, (x1, y1 - 18), (x1 + 8 * len(label), y1), colour, -1)
        cv2.putText(frame, label, (x1 + 3, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)

    banner = f"{total} vehicles"
    cv2.rectangle(frame, (8, 8), (8 + 11 * len(banner), 34), (0, 0, 0), -1)
    cv2.putText(frame, banner, (14, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
    return counts, total, (buf.tobytes() if ok else None), boxes


# --- Focus: one camera, continuously ---------------------------------------
#
# Opening ffmpeg per frame costs about five seconds, nearly all of it
# reconnecting. For the camera being watched, one ffmpeg is left running and
# frames are read off its stdout as they arrive.

JPEG_SOI = b"\xff\xd8"
JPEG_EOI = b"\xff\xd9"


class FlowTracker:
    """Boxes that follow the traffic between detections.

    Detection is far slower than the stream, so boxes from the last YOLO pass
    are already wrong by the time they are drawn. Between passes this carries
    each box along with the picture using dense optical flow, and every few
    frames a fresh detection is matched back onto the tracks by IoU.

    Adapted from the Track+DIS script: same idea, same DIS ULTRAFAST estimator,
    with the flow computed at half resolution because it is the expensive part.
    """

    # The Track+DIS defaults assume a 25 fps file, where five frames is 0.2s and
    # a box barely moves. Here the stream runs nearer 5 fps, so those numbers let
    # unmatched tracks coast for six seconds and the count filled up with ghosts:
    # 110 vehicles where YOLO saw 50. Detect more often, forget faster, and match
    # a little more loosely.
    def __init__(self, iou_threshold=0.2, max_age=4, redetect_every=3, flow_scale=0.5):
        self.iou_threshold = iou_threshold
        self.max_age = max_age
        self.redetect_every = redetect_every
        self.flow_scale = flow_scale
        self.flow = cv2.DISOpticalFlow.create(
            getattr(cv2.DISOpticalFlow, "PRESET_ULTRAFAST", 0)
        )
        self.reset()

    def reset(self):
        self.prev_gray = None
        self.tracks = {}
        self.next_id = 0
        self.frames = 0

    @staticmethod
    def _iou(a, b):
        x1, y1 = max(a[0], b[0]), max(a[1], b[1])
        x2, y2 = min(a[2], b[2]), min(a[3], b[3])
        inter = max(0, x2 - x1) * max(0, y2 - y1)
        if not inter:
            return 0.0
        union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
        return inter / union if union else 0.0

    def _small_gray(self, frame):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if self.flow_scale == 1:
            return gray
        return cv2.resize(gray, None, fx=self.flow_scale, fy=self.flow_scale)

    def _propagate(self, gray):
        """Move every track by the flow under its centre."""
        if self.prev_gray is None or not self.tracks:
            return {}

        flow = self.flow.calc(self.prev_gray, gray, None)
        fh, fw = flow.shape[:2]
        scale = 1.0 / self.flow_scale
        moved = {}

        for tid, t in self.tracks.items():
            x1, y1, x2, y2 = t["bbox"]
            cx = int((x1 + x2) / 2 * self.flow_scale)
            cy = int((y1 + y2) / 2 * self.flow_scale)
            if not (0 <= cy < fh and 0 <= cx < fw):
                continue  # left the picture

            du, dv = flow[cy, cx] * scale
            moved[tid] = {
                **t,
                "bbox": [int(x1 + du), int(y1 + dv), int(x2 + du), int(y2 + dv)],
                "age": t["age"] + 1,
            }
        return moved

    def _match(self, moved, detections):
        """Fresh detections win; unmatched tracks coast until they age out."""
        result = {}
        taken = set()

        for tid, t in moved.items():
            best_iou, best = 0.0, -1
            for i, det in enumerate(detections):
                if i in taken:
                    continue
                iou = self._iou(t["bbox"], det["bbox"])
                if iou > best_iou:
                    best_iou, best = iou, i

            if best_iou >= self.iou_threshold:
                det = detections[best]
                taken.add(best)
                result[tid] = {"bbox": det["bbox"], "name": det["name"],
                               "conf": det["conf"], "age": 0}
            elif t["age"] < self.max_age:
                result[tid] = t

        for i, det in enumerate(detections):
            if i in taken:
                continue
            result[self.next_id] = {"bbox": det["bbox"], "name": det["name"],
                                    "conf": det["conf"], "age": 0}
            self.next_id += 1

        return result

    def update(self, frame, detect_fn):
        """One frame in, the current tracks out."""
        gray = self._small_gray(frame)
        moved = self._propagate(gray)

        due = self.frames % self.redetect_every == 0 or not self.tracks
        detections = detect_fn(frame) if due else []

        if detections or due:
            self.tracks = self._match(moved, detections)
        else:
            self.tracks = {tid: t for tid, t in moved.items() if t["age"] < self.max_age}

        self.prev_gray = gray
        self.frames += 1
        return self.tracks, due


TRACK_COLOURS = [(80, 200, 12), (4, 222, 254), (255, 120, 20), (32, 32, 255),
                 (255, 80, 200), (240, 200, 40), (120, 255, 255)]


def draw_tracks(frame, tracks):
    for tid, t in tracks.items():
        x1, y1, x2, y2 = t["bbox"]
        colour = TRACK_COLOURS[tid % len(TRACK_COLOURS)]
        cv2.rectangle(frame, (x1, y1), (x2, y2), colour, 2)
        label = f"#{tid} {t['name']}"
        cv2.rectangle(frame, (x1, y1 - 16), (x1 + 8 * len(label), y1), colour, -1)
        cv2.putText(frame, label, (x1 + 3, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1)

    banner = f"{len(tracks)} vehicles"
    cv2.rectangle(frame, (8, 8), (8 + 11 * len(banner), 34), (0, 0, 0), -1)
    cv2.putText(frame, banner, (14, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
    return frame


def tracks_to_reading(cam, tracks, width, height):
    counts = {}
    boxes = []
    for tid, t in tracks.items():
        counts[t["name"]] = counts.get(t["name"], 0) + 1
        x1, y1, x2, y2 = t["bbox"]
        boxes.append({
            "id": tid, "k": t["name"], "c": round(t["conf"], 2),
            "x": round(x1 / width, 4), "y": round(y1 / height, 4),
            "w": round((x2 - x1) / width, 4), "h": round((y2 - y1) / height, 4),
        })
    return {
        "id": cam["id"], "title": cam["title"], "total": len(tracks),
        "counts": counts, "boxes": boxes, "at": time.time(),
        "ms": 0, "error": None, "live": True,
    }


def focus_worker(model, confidence, imgsz, fps, site):
    tracker = FlowTracker()

    def run_yolo(frame):
        result = model.predict(frame, imgsz=imgsz, conf=confidence, verbose=False)[0]
        out = []
        for box in result.boxes:
            cls = int(box.cls[0])
            if cls not in VEHICLES:
                continue
            x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
            out.append({"bbox": [x1, y1, x2, y2], "name": VEHICLES[cls][0],
                        "conf": float(box.conf[0])})
        return out

    while True:
        with lock:
            cam_id = state["focus"] if time.time() < state["focus_until"] else None
        cameras = ensure_cameras(site) if cam_id else []
        cam = next((c for c in cameras if c["id"] == cam_id), None)
        if not cam:
            state["focus_fps"] = 0.0
            time.sleep(0.5)
            continue

        tracker.reset()
        proc = subprocess.Popen(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-rw_timeout", "15000000", "-i", cam["hls"],
                "-vf", f"fps={fps}", "-q:v", "5",
                "-f", "image2pipe", "-vcodec", "mjpeg", "-",
            ],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        print(f"focus -> {cam['id']} ({cam['title'][:40]})", flush=True)

        buf = b""
        frames = 0
        started = time.time()
        try:
            while True:
                with lock:
                    still_wanted = state["focus"] == cam["id"] and time.time() < state["focus_until"]
                if not still_wanted:
                    break

                chunk = proc.stdout.read(65536)
                if not chunk:
                    break
                buf += chunk

                # Optical flow needs consecutive frames, so take them in order.
                # If more than a couple have piled up we are behind: skip to the
                # newest and start the flow again from there.
                starts = [i for i in _jpeg_starts(buf)]
                end_i = buf.rfind(JPEG_EOI)
                if end_i == -1 or not starts:
                    continue

                pending = [i for i in starts if i < end_i]
                if len(pending) > 2:
                    tracker.reset()
                    take = pending[-1]
                else:
                    take = pending[0]

                nxt = next((i for i in starts if i > take), None)
                jpeg = buf[take:nxt] if nxt is not None else buf[take:end_i + 2]
                buf = buf[(nxt if nxt is not None else end_i + 2):]

                frame = cv2.imdecode(np.frombuffer(jpeg, dtype="uint8"), cv2.IMREAD_COLOR)
                if frame is None:
                    continue

                try:
                    tracks, redetected = tracker.update(frame, run_yolo)
                except Exception:
                    tracker.reset()
                    continue

                height, width = frame.shape[:2]
                annotated = draw_tracks(frame, tracks)
                ok, encoded = cv2.imencode(".jpg", annotated,
                                           [int(cv2.IMWRITE_JPEG_QUALITY), 75])

                frames += 1
                with lock:
                    state["detections"][cam["id"]] = tracks_to_reading(cam, tracks, width, height)
                    if ok:
                        state["frames"][cam["id"]] = encoded.tobytes()
                    state["focus_fps"] = round(frames / max(1e-6, time.time() - started), 2)
        finally:
            proc.kill()
            proc.wait(timeout=5)
            state["focus_fps"] = 0.0
            print(f"focus released {cam['id']} after {frames} frames", flush=True)


def _jpeg_starts(buf):
    i = buf.find(JPEG_SOI)
    while i != -1:
        yield i
        i = buf.find(JPEG_SOI, i + 2)


# --- Sweep loop ------------------------------------------------------------

def sweep(model, cameras, confidence, imgsz):
    for cam in cameras:
        cam_id = cam["id"]
        # The focus worker is already on this one, at a far better rate
        with lock:
            if state["focus"] == cam_id and time.time() < state["focus_until"]:
                continue
        started = time.time()
        try:
            counts, total, annotated, boxes = detect(model, grab_frame(cam["hls"]), confidence, imgsz)
            reading = {
                "id": cam_id,
                "title": cam["title"],
                "total": total,
                "counts": counts,
                "boxes": boxes,
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
                    "boxes": [],
                    "at": time.time(),
                    "ms": int((time.time() - started) * 1000),
                    "error": str(exc)[:150],
                }


def loop(site, interval, confidence, weights, imgsz, model_box=None):
    print(f"Loading {weights} ...", flush=True)
    model = YOLO(weights)
    state["model"] = weights
    if model_box is not None:
        model_box["model"] = model
    print("Model ready", flush=True)

    while True:
        started = time.time()
        try:
            try:
                cameras = load_cameras(site)
                if cameras:
                    with lock:
                        state["cameras"] = cameras
                        state["error"] = None
            except Exception as exc:
                state["error"] = str(exc)[:200]

            if not state["cameras"]:
                print(f"no camera list yet ({state['error']}) - retrying in 5s", flush=True)
                time.sleep(5)
                continue

            sweep(model, state["cameras"], confidence, imgsz)
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
        wait = max(1, interval - (time.time() - started))
        # While a camera is being watched, leave the bandwidth to it
        while wait > 0:
            step = min(2, wait)
            time.sleep(step)
            wait -= step
            with lock:
                if time.time() < state["focus_until"]:
                    wait = max(wait, 2)


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

        if self.path.startswith("/focus"):
            query = urllib.parse.urlparse(self.path).query
            cam_id = urllib.parse.parse_qs(query).get("id", [""])[0]
            with lock:
                if cam_id:
                    if state["focus"] != cam_id:
                        state["focus"] = cam_id
                    state["focus_until"] = time.time() + FOCUS_TTL
                else:
                    state["focus"] = None
                    state["focus_until"] = 0
                current, fps = state["focus"], state["focus_fps"]
            self._json(200, {"focus": current, "fps": fps, "ttl": FOCUS_TTL})
            return

        if self.path.startswith("/detections"):
            wanted = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("id", [""])[0]
            if wanted:
                # Polling one camera a second should not carry the other eighteen
                with lock:
                    one = state["detections"].get(wanted)
                    fps = state["focus_fps"] if state["focus"] == wanted else 0.0
                self._json(200, {"detections": [one] if one else [], "fps": fps})
                return

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
                "focus": state["focus"] if time.time() < state["focus_until"] else None,
                "focusFps": state["focus_fps"],
                "error": state["error"],
            })
            return

        self._json(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="http://127.0.0.1:3000", help="where to read the camera list from")
    ap.add_argument("--port", type=int, default=5056)
    ap.add_argument("--interval", type=int, default=0,
                    help="seconds between all-camera sweeps; 0 disables them")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--weights", default="yolov8s.pt")
    ap.add_argument("--imgsz", type=int, default=1280)
    ap.add_argument("--focus-fps", type=float, default=2.0,
                    help="frames a second to pull for the camera being watched")
    args = ap.parse_args()

    model_box = {}

    def run_loop():
        loop(args.site, args.interval, args.conf, args.weights, args.imgsz, model_box)

    threading.Thread(target=run_loop, daemon=True).start()

    def run_focus():
        while "model" not in model_box:
            time.sleep(0.5)
        focus_worker(model_box["model"], args.conf, args.imgsz, args.focus_fps, args.site)

    threading.Thread(target=run_focus, daemon=True).start()

    print(f"Detector on http://127.0.0.1:{args.port}  (sweep every {args.interval}s)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
