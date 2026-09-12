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
import math
import os
import queue
import re
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
import torch
from ultralytics import YOLO

# COCO classes that are vehicles, and what to call them in Thai
VEHICLES = {
    2: ("car", "รถยนต์"),
    3: ("motorcycle", "จักรยานยนต์"),
    5: ("bus", "รถโดยสาร"),
    7: ("truck", "รถบรรทุก"),
}
BOX_COLOURS = {2: (80, 200, 12), 3: (4, 222, 254), 5: (255, 120, 20), 7: (32, 32, 255)}

# Motorcycles came back barely at all: 2 of 128 vehicles over 18 frames, on
# Bangkok roads. They are not being dropped as some other class - the model
# simply calls them cars. A bike and its rider merge into one small shape, and
# what does survive as a motorcycle scores far below what a car scores, so the
# shared floor cuts it. Two things move it, measured on those frames:
#
#   floor of its own, 0.15 -> 0.08   motorcycles 2 -> 6
#   test-time augmentation           motorcycles 6 -> 11, all vehicles 128 -> 187
#
# The added boxes sit on real traffic - mostly the far end of the road, which a
# single pass misses. Augmentation costs about 200ms a frame against 500-700ms,
# and that fits: focus runs YOLO every third frame, and it is the only thing
# using the GPU now that sweeps are off.
#
# Measured at night, in rain. Motorcycles are hardest to tell from cars then, so
# treat these as the floor of what daylight should give.
MOTORCYCLE = 3
MOTORCYCLE_CONF = 0.08
AUGMENT = True

# Half precision, which the card does in hardware. Measured over the same 18
# frames, in a process that only ever used one precision: 610-641ms a frame at
# fp32 against 201-289ms at fp16, and it finds slightly more rather than less
# (282 vehicles against 287). On a machine without a GPU it would be slower, so
# it is asked for only when there is one.
#
# Measure precision in its own process. Switching mid-process casts the weights
# between calls and reads as 2.2s a frame, which is the cast, not the maths.
QUANTIZE = 16 if torch.cuda.is_available() else None

# Opening an HLS stream is almost entirely waiting on the network, so several
# cameras are opened at once while inference stays on the one GPU. Over 19
# cameras: 15.5s one at a time, 6.8s with three or five. Eight was worse at
# 11.8s - past a handful the streams start competing for the same bandwidth,
# and the sweep already has to share it with whoever is watching a camera.
SWEEP_WORKERS = 6

state = {
    "detections": {},   # camid -> reading
    "frames": {},       # camid -> annotated jpeg bytes
    "cameras": [],
    "model": None,
    "started": time.time(),
    "sweeps": 0,
    "error": None,
    # Cameras someone is watching, detected continuously rather than once a
    # sweep. Held only while a page keeps saying it is still watching.
    "focus": {},        # camid -> expiry timestamp
    "claimed": {},      # camid -> worker id, so two workers never take the same one
    "focus_fps": {},    # camid -> frames a second
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
#
# OpenCV is built with FFmpeg, so it opens these HLS URLs itself. Calling an
# ffmpeg binary meant the detector found nothing at all on a machine that did
# not have one, and cost seconds per camera starting the process where opening
# the stream here takes under half a second.

STREAM_TIMEOUT_MS = 8000
# How often the camera list is re-read when sweeps are off. The catalogue is
# cached for ten minutes upstream, so asking faster only repeats the answer.
CATALOGUE_REFRESH = 300
# A grab that returns this fast came out of ffmpeg's buffer; one that waits
# longer went to the wire, which means the buffer is empty and we are live.
LIVE_EDGE_SECS = 0.030
# Draining is not free: these servers feed the backlog over at anywhere from
# 1.6x to 34x real time, so the slowest camera's 9.5s of it costs 5.9s to throw
# away - worse than the staleness. Half a second clears the backlog outright on
# most cameras and takes the top off the rest. It bounds the buffered part only:
# the grab that finally reaches the wire waits for the next segment however long
# that takes, which measured as up to 1.9s on these streams. That grab is the
# one worth paying for - it is the frame that is actually live.
DRAIN_BUDGET_SECS = 0.5
# How far the focused read may fall behind live before it snaps forward.
# Decoding one frame in every skip + 1 is only right while the model keeps to
# its rate; a pass that runs long leaves the stream ahead of us, and nothing in
# the loop ever gives that time back - which is the delay that builds up on a
# live view and never recovers.
MAX_LAG_SECS = 2.0


def open_stream(url):
    """A capture on a live stream, or None if it will not open.

    The timeouts only take effect if they are set before opening, so this
    cannot use the VideoCapture(url) constructor.
    """
    cap = cv2.VideoCapture()
    cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, STREAM_TIMEOUT_MS)
    cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, STREAM_TIMEOUT_MS)
    if not cap.open(url, cv2.CAP_FFMPEG):
        cap.release()
        return None
    return cap


def drain_to_live(cap):
    """Throw away the backlog ffmpeg buffered at open, leaving the newest frame.

    Opening one of these HLS streams hands over 3-3.6s of video that has already
    happened, so the first frame read is that many seconds stale. CAP_PROP_BUFFERSIZE
    is the usual cure but the FFmpeg backend does not implement it - set() returns
    False and get() reads back -1 - so drop the backlog by grabbing without
    decoding, and stop at whichever comes first: a grab that waits for the wire,
    or the budget running out.
    """
    deadline = time.time() + DRAIN_BUDGET_SECS
    grabbed = False
    while True:
        started = time.time()
        if not cap.grab():
            return grabbed
        grabbed = True
        if time.time() - started > LIVE_EDGE_SECS or time.time() >= deadline:
            return True


def grab_frame(hls_url):
    """One frame from a live stream, as close to now as the stream allows."""
    cap = open_stream(hls_url)
    if cap is None:
        raise RuntimeError("could not open stream")
    try:
        # retrieve(), not read(): the frame the last grab waited for is the
        # live one, and reading again would throw it away to fetch the next.
        ok, frame = cap.retrieve() if drain_to_live(cap) else (False, None)
    finally:
        cap.release()
    if not ok or frame is None:
        raise RuntimeError("no frame")
    return frame


# --- Detection -------------------------------------------------------------

def vehicle_boxes(result, confidence):
    """Vehicle boxes clearing the confidence floor for their own class."""
    for box in result.boxes:
        cls = int(box.cls[0])
        if cls not in VEHICLES:
            continue
        floor = MOTORCYCLE_CONF if cls == MOTORCYCLE else confidence
        if float(box.conf[0]) >= floor:
            yield cls, box


model_lock = threading.Lock()


def predict(model, frame, confidence, imgsz):
    """One pass, floored low enough that the per-class floors can still apply."""
    with model_lock:
        return model.predict(frame, imgsz=imgsz, conf=min(confidence, MOTORCYCLE_CONF),
                             augment=AUGMENT, quantize=QUANTIZE, verbose=False)[0]


def detect(model, frame, confidence, imgsz=1280):
    # These are traffic cameras looking down a street, so the vehicles are small.
    # Inferring at 1280 rather than the default 640 roughly doubles what is found.
    # Going past 1280 makes it worse: the cameras send 600x480 to 1280x720, so a
    # larger size is only upscaling. Measured over four frames, 1920 found 14
    # vehicles where 1280 found 21.
    result = predict(model, frame, confidence, imgsz)

    counts = {}
    boxes = []
    total = 0
    height, width = frame.shape[:2]

    for cls, box in vehicle_boxes(result, confidence):
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
# Reopening the stream for every frame would spend most of the time connecting.
# For the camera being watched, one capture is left open and frames are read off
# it as they arrive.


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
        self.prev_time = None
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
        """Move every track by the flow under its centre and compute motion velocity."""
        if self.prev_gray is None or not self.tracks:
            return {}

        now = time.time()
        dt = max(0.01, now - self.prev_time) if self.prev_time else 0.1
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

            y_min, y_max = max(0, cy - 1), min(fh, cy + 2)
            x_min, x_max = max(0, cx - 1), min(fw, cx + 2)
            flow_win = flow[y_min:y_max, x_min:x_max]
            du = float(np.median(flow_win[..., 0])) * scale
            dv = float(np.median(flow_win[..., 1])) * scale

            disp = math.sqrt(du * du + dv * dv)
            inst_speed = disp / dt
            prev_speed = t.get("speed", inst_speed)
            speed = prev_speed * 0.4 + inst_speed * 0.6

            moved[tid] = {
                **t,
                "bbox": [int(x1 + du), int(y1 + dv), int(x2 + du), int(y2 + dv)],
                "age": t["age"] + 1,
                "speed": round(speed, 1),
                "is_stopped": speed < 3.5,
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
                spd = t.get("speed", 0.0)
                result[tid] = {
                    "bbox": det["bbox"], "name": det["name"],
                    "conf": det["conf"], "age": 0,
                    "speed": spd, "is_stopped": spd < 3.5
                }
            elif t["age"] < self.max_age:
                result[tid] = t

        for i, det in enumerate(detections):
            if i in taken:
                continue
            result[self.next_id] = {
                "bbox": det["bbox"], "name": det["name"],
                "conf": det["conf"], "age": 0,
                "speed": 0.0, "is_stopped": True
            }
            self.next_id += 1

        return result

    def get_area_metrics(self):
        """Evaluate Space Mean Speed, stopped ratio, and overall traffic status."""
        total = len(self.tracks)
        if total == 0:
            return {
                "avg_px_s": 0.0,
                "status": "empty",
                "status_th": "ถนนว่าง",
                "stopped_count": 0,
                "moving_count": 0,
                "stopped_pct": 0.0,
            }

        speeds = [t.get("speed", 0.0) for t in self.tracks.values()]
        stopped = sum(1 for s in speeds if s < 3.5)
        moving = total - stopped
        avg_spd = sum(speeds) / total
        stopped_pct = (stopped / total) * 100.0

        if total <= 2:
            status, status_th = "empty", "ถนนโล่ง"
        elif stopped_pct >= 65.0:
            status, status_th = "jam", "ติดขัดสะสม"
        elif avg_spd < 12.0 or stopped_pct >= 35.0:
            status, status_th = "slow", "ชะลอตัว"
        else:
            status, status_th = "flowing", "คล่องตัว"

        return {
            "avg_px_s": round(avg_spd, 1),
            "status": status,
            "status_th": status_th,
            "stopped_count": stopped,
            "moving_count": moving,
            "stopped_pct": round(stopped_pct, 1),
        }

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
        self.prev_time = time.time()
        self.frames += 1
        return self.tracks, due


TRACK_COLOURS = [(80, 200, 12), (4, 222, 254), (255, 120, 20), (32, 32, 255),
                 (255, 80, 200), (240, 200, 40), (120, 255, 255)]


def draw_tracks(frame, tracks, area_metrics=None):
    for tid, t in tracks.items():
        x1, y1, x2, y2 = t["bbox"]
        colour = TRACK_COLOURS[tid % len(TRACK_COLOURS)]
        cv2.rectangle(frame, (x1, y1), (x2, y2), colour, 2)
        label = f"#{tid} {t['name']}"
        cv2.rectangle(frame, (x1, y1 - 16), (x1 + 8 * len(label), y1), colour, -1)
        cv2.putText(frame, label, (x1 + 3, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1)

    # cv2 cannot draw Thai, so the burned-in banner uses the English status
    status_str = f" - {area_metrics['status']}" if area_metrics else ""
    banner = f"{len(tracks)} vehicles{status_str}"
    cv2.rectangle(frame, (8, 8), (8 + 10 * len(banner), 34), (0, 0, 0), -1)
    cv2.putText(frame, banner, (14, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)
    return frame


def tracks_to_reading(cam, tracks, width, height, area_metrics=None):
    counts = {}
    boxes = []
    for tid, t in tracks.items():
        counts[t["name"]] = counts.get(t["name"], 0) + 1
        x1, y1, x2, y2 = t["bbox"]
        boxes.append({
            "id": tid, "k": t["name"], "c": round(t["conf"], 2),
            "x": round(x1 / width, 4), "y": round(y1 / height, 4),
            "w": round((x2 - x1) / width, 4), "h": round((y2 - y1) / height, 4),
            "spd": round(t.get("speed", 0.0), 1),
            "stp": t.get("speed", 0.0) < 3.5,
        })
    return {
        "id": cam["id"], "title": cam["title"], "total": len(tracks),
        "counts": counts, "boxes": boxes, "at": time.time(),
        "ms": 0, "error": None, "live": True,
        "area_speed": area_metrics or {
            "avg_px_s": 0.0, "status": "flowing", "status_th": "คล่องตัว",
            "stopped_count": 0, "moving_count": len(tracks), "stopped_pct": 0.0
        },
    }


def _claim_camera(worker_id, site):
    """A focused camera no other worker has taken."""
    now = time.time()
    with lock:
        for camid, until in list(state["focus"].items()):
            if until < now:
                state["focus"].pop(camid, None)
                state["claimed"].pop(camid, None)
                state["focus_fps"].pop(camid, None)

        # Keep the one already held if it is still wanted
        for camid, holder in state["claimed"].items():
            if holder == worker_id and camid in state["focus"]:
                wanted = camid
                break
        else:
            wanted = next((c for c in state["focus"] if c not in state["claimed"]), None)
            if wanted:
                state["claimed"][wanted] = worker_id

    if not wanted:
        return None
    cameras = ensure_cameras(site)
    return next((c for c in cameras if c["id"] == wanted), None)


def focus_worker(worker_id, model, confidence, imgsz, fps, site, redetect_every=3, max_age=4):
    tracker = FlowTracker(redetect_every=redetect_every, max_age=max_age)

    def run_yolo(frame):
        result = predict(model, frame, confidence, imgsz)
        out = []
        for cls, box in vehicle_boxes(result, confidence):
            x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
            out.append({"bbox": [x1, y1, x2, y2], "name": VEHICLES[cls][0],
                        "conf": float(box.conf[0])})
        return out

    while True:
        cam = _claim_camera(worker_id, site)
        if not cam:
            time.sleep(0.5)
            continue

        tracker.reset()
        cap = open_stream(cam["hls"])
        if cap is None:
            with lock:
                state["claimed"].pop(cam["id"], None)
            time.sleep(1)
            continue

        # ffmpeg was thinning the stream for us with -vf fps=N. Every frame
        # arrives here instead, so decode one in every skip + 1 and let grab()
        # discard the rest: that holds the read at the live edge without paying
        # to decode frames nothing looks at.
        native = cap.get(cv2.CAP_PROP_FPS)
        skip = max(0, round((native if native > 0 else 25) / fps) - 1)
        # The skip loop below holds the live edge once it is there, but it
        # starts 3s behind it: that is how much video the open buffered.
        drain_to_live(cap)
        print(f"focus -> {cam['id']} ({cam['title'][:40]})", flush=True)

        frames = 0
        snaps = 0
        base_pts = base_wall = None
        started = time.time()
        try:
            while True:
                with lock:
                    still_wanted = state["focus"].get(cam["id"], 0) > time.time()
                if not still_wanted:
                    break

                for _ in range(skip):
                    if not cap.grab():
                        break
                ok, frame = cap.read()
                if not ok or frame is None:
                    break

                # Video time should keep pace with wall time. Where it does not
                # we are working through a backlog, so throw it away and start
                # measuring again. Reading the newest frame every time instead
                # sounds better and is not: these streams arrive a segment at a
                # time, so a reader pinned to the live edge spends most of its
                # life waiting for the next one - measured at 0.8 fps against
                # the 8 this gets by reading steadily and snapping when it must.
                now = time.time()
                pts = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
                if base_pts is None:
                    base_pts, base_wall = pts, now
                elif (now - base_wall) - (pts - base_pts) > MAX_LAG_SECS:
                    drain_to_live(cap)
                    base_pts = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
                    base_wall = time.time()
                    snaps += 1

                try:
                    tracks, redetected = tracker.update(frame, run_yolo)
                except Exception:
                    tracker.reset()
                    continue

                height, width = frame.shape[:2]
                area_metrics = tracker.get_area_metrics()
                annotated = draw_tracks(frame, tracks, area_metrics)
                ok, encoded = cv2.imencode(".jpg", annotated,
                                           [int(cv2.IMWRITE_JPEG_QUALITY), 75])

                frames += 1
                with lock:
                    state["detections"][cam["id"]] = tracks_to_reading(cam, tracks, width, height, area_metrics)
                    if ok:
                        state["frames"][cam["id"]] = encoded.tobytes()
                    state["focus_fps"][cam["id"]] = round(frames / max(1e-6, time.time() - started), 2)
        finally:
            cap.release()
            with lock:
                state["claimed"].pop(cam["id"], None)
                state["focus_fps"].pop(cam["id"], None)
            print(f"focus released {cam['id']} after {frames} frames "
                  f"({snaps} snaps back to live)", flush=True)


# --- Sweep loop ------------------------------------------------------------

# --- Recorded clips ----------------------------------------------------------
#
# The dashboard plays the recorder's ten minute clips and wants boxes that
# belong to the frame on screen, not to whatever the live stream shows now.
# A clip is sampled every CLIP_STEP seconds through the same model and the
# boxes are kept beside it as <clip>.boxes.json, so it is only ever paid for
# once. Work is queued: the page asks, gets "pending", and asks again.

CLIP_DIR = os.environ.get("CCTV_DIR", "D:/CCTV")
# Three seconds: 200 frames a clip, which shares the GPU with the sweeps and
# still finishes four dashboard clips inside the ten minutes they stay current.
CLIP_STEP = 3.0
CLIP_SEGMENT = re.compile(r"^[A-Za-z0-9_-]+$")
CLIP_NAME = re.compile(r"^\d{4}-\d{2}-\d{2}/\d{2}-\d{2}-\d{2}\.mp4$")
clip_queue = queue.Queue()
clip_pending = set()


def clip_paths(cam_id, clip):
    if not CLIP_SEGMENT.match(cam_id or "") or not CLIP_NAME.match(clip or ""):
        return None, None
    mp4 = os.path.join(CLIP_DIR, cam_id, *clip.split("/"))
    return mp4, mp4[:-4] + ".boxes.json"


def analyse_clip(model, confidence, imgsz, mp4, out):
    cap = cv2.VideoCapture(mp4)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    step = max(1, int(round(fps * CLIP_STEP)))
    frames = []
    started = time.time()
    for i in range(0, max(total, 1), step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, frame = cap.read()
        if not ok:
            break
        height, width = frame.shape[:2]
        result = predict(model, frame, confidence, imgsz)
        counts, boxes = {}, []
        for cls, box in vehicle_boxes(result, confidence):
            name = VEHICLES[cls][0]
            counts[name] = counts.get(name, 0) + 1
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
            boxes.append({
                "k": name,
                "x": round(x1 / width, 3), "y": round(y1 / height, 3),
                "w": round((x2 - x1) / width, 3), "h": round((y2 - y1) / height, 3),
            })
        frames.append({"t": round(i / fps, 2), "total": len(boxes), "counts": counts, "boxes": boxes})
        # A clip takes a minute or two to get through. Publish what is done so
        # far every few frames, so the page has boxes for the start of the clip
        # while the rest is still being worked on.
        if len(frames) % 10 == 0:
            write_json(out + ".partial", {
                "status": "partial", "step": CLIP_STEP, "duration": round(total / fps, 1),
                "frames": frames,
            })
    cap.release()
    data = {
        "status": "done", "model": state["model"], "step": CLIP_STEP,
        "duration": round(total / fps, 1), "frames": frames,
        "ms": int((time.time() - started) * 1000),
    }
    write_json(out, data)
    try:
        os.remove(out + ".partial")
    except OSError:
        pass
    return data


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, path)


def clip_worker(model_box, confidence, imgsz):
    while "model" not in model_box:
        time.sleep(0.5)
    while True:
        cam_id, clip = clip_queue.get()
        mp4, out = clip_paths(cam_id, clip)
        try:
            if mp4 and os.path.exists(mp4) and not os.path.exists(out):
                data = analyse_clip(model_box["model"], confidence, imgsz, mp4, out)
                print(f"clip {cam_id}/{clip}: {len(data['frames'])} frames in {data['ms']} ms", flush=True)
        except Exception as exc:
            print(f"clip {cam_id}/{clip} failed: {str(exc)[:80]}", flush=True)
        finally:
            with lock:
                clip_pending.discard((cam_id, clip))


def _capture(cam):
    """One camera's frame, or the error that stopped it. Runs off the main thread."""
    # The focus worker is already on this one, at a far better rate
    with lock:
        if state["focus"].get(cam["id"], 0) > time.time():
            return cam, None, None, 0.0
    started = time.time()
    try:
        return cam, grab_frame(cam["hls"]), None, time.time() - started
    except Exception as exc:
        return cam, None, str(exc)[:150], time.time() - started


def sweep(model, cameras, confidence, imgsz):
    with ThreadPoolExecutor(max_workers=SWEEP_WORKERS) as pool:
        for cam, frame, error, secs in pool.map(_capture, cameras):
            cam_id = cam["id"]
            if frame is None and error is None:
                continue  # focused, and being read faster elsewhere

            started = time.time()
            if error is None:
                try:
                    counts, total, annotated, boxes = detect(model, frame, confidence, imgsz)
                except Exception as exc:
                    error = str(exc)[:150]

            elapsed = int((secs + time.time() - started) * 1000)
            if error is not None:
                with lock:
                    state["detections"][cam_id] = {
                        "id": cam_id,
                        "title": cam["title"],
                        "total": None,
                        "counts": {},
                        "boxes": [],
                        "at": time.time(),
                        "ms": elapsed,
                        "error": error,
                    }
                continue

            with lock:
                state["detections"][cam_id] = {
                    "id": cam_id,
                    "title": cam["title"],
                    "total": total,
                    "counts": counts,
                    "boxes": boxes,
                    "at": time.time(),
                    "ms": elapsed,
                    "error": None,
                }
                if annotated:
                    state["frames"][cam_id] = annotated


def loop(site, interval, confidence, weights, imgsz, model_box=None):
    print(f"Loading {weights} ...", flush=True)
    model = YOLO(weights)

    # The first real frame otherwise pays for the fp16 cast and for cuDNN
    # choosing its algorithms, which turned the first sweep into 45s against the
    # 8s of every sweep after it. One throwaway frame of the right shape moves
    # that cost here, where nothing is waiting on it.
    predict(model, np.zeros((720, 1280, 3), dtype=np.uint8), MOTORCYCLE_CONF, imgsz)

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

            if interval <= 0:
                # Sweeps off, as --interval has always said 0 would do. The
                # page only draws boxes on the camera someone has opened, so
                # reading the other twenty costs a stream and a YOLO pass each
                # and nothing looks at the answer. Keeping the list fresh is
                # all this thread is for now; the focus workers get the GPU.
                time.sleep(CATALOGUE_REFRESH)
                continue

            sweep(model, state["cameras"], confidence, imgsz)
            state["sweeps"] += 1

            seen = [d for d in state["detections"].values() if d.get("total") is not None]
            print(
                f"[{time.strftime('%H:%M:%S')}] sweep {state['sweeps']}: "
                f"{len(seen)}/{len(state['cameras'])} cameras, "
                f"{sum(d.get('total') or 0 for d in seen)} vehicles, "
                f"{time.time() - started:.1f}s",
                flush=True,
            )
        except Exception as exc:
            state["error"] = str(exc)[:200]
            print("sweep failed:", exc, flush=True)

        # Pace by when the sweep started, so a slow one does not compound
        wait = max(1.0, interval - (time.time() - started))
        time.sleep(wait)


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
                    state["focus"][cam_id] = time.time() + FOCUS_TTL
                held = sorted(state["focus"])
                fps = state["focus_fps"].get(cam_id, 0.0)
            self._json(200, {"focus": cam_id or None, "held": held,
                             "fps": fps, "ttl": FOCUS_TTL})
            return

        if self.path.startswith("/detections"):
            wanted = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("id", [""])[0]
            if wanted:
                # Polling one camera a second should not carry the other eighteen
                with lock:
                    one = state["detections"].get(wanted)
                    fps = state["focus_fps"].get(wanted, 0.0)
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

        if self.path.startswith("/clip"):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            cam_id = query.get("cam", [""])[0]
            clip = query.get("clip", [""])[0]
            mp4, out = clip_paths(cam_id, clip)
            if not mp4:
                self._json(400, {"error": "bad clip"})
                return
            if os.path.exists(out):
                with open(out, "rb") as f:
                    self._send(200, f.read(), "application/json")
                return
            if not os.path.exists(mp4):
                self._json(404, {"error": "no such clip"})
                return
            with lock:
                if (cam_id, clip) not in clip_pending:
                    clip_pending.add((cam_id, clip))
                    clip_queue.put((cam_id, clip))
                queued = len(clip_pending)
            if os.path.exists(out + ".partial"):
                try:
                    with open(out + ".partial", "rb") as f:
                        self._send(200, f.read(), "application/json")
                    return
                except OSError:
                    pass
            self._json(200, {"status": "pending", "queued": queued})
            return

        if self.path.startswith("/health"):
            self._json(200, {
                "model": state["model"],
                "sweeps": state["sweeps"],
                "cameras": len(state["cameras"]),
                "uptime": int(time.time() - state["started"]),
                "focus": sorted(state["focus"]),
                "focusFps": dict(state["focus_fps"]),
                "workers": state.get("focus_workers"),
                "error": state["error"],
            })
            return

        self._json(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="http://127.0.0.1:3000", help="where to read the camera list from")
    ap.add_argument("--port", type=int, default=5056)
    ap.add_argument("--interval", type=int, default=5,
                    help="seconds between all-camera sweeps; 0 disables them")
    # 0.25 was throwing away real vehicles: on a busy frame it found 7 of the
    # 15 a person can count. Below about 0.12 the misses turn into whole-bush
    # and whole-building boxes, so 0.15 is where the trade sits.
    ap.add_argument("--conf", type=float, default=0.15)
    # yolov8s is fast but weak on these views: on one busy frame it found 7
    # vehicles where yolo11m found 15 and yolo11x found 20, and it misread a
    # wall as a truck. yolo11x costs 169ms a frame against yolov8s's 32ms, but
    # the streams deliver frames far more slowly than that - the GPU sits at
    # 0-3% between sweeps - so the larger model buys accuracy for free here.
    ap.add_argument("--weights", default="yolo11x.pt")
    ap.add_argument("--imgsz", type=int, default=1280)
    # Two meant the third person to open a camera got nothing at all - not a
    # slower picture, nothing - while the two being served drifted six times
    # apart from each other. Six shares out evenly: measured 1.52, 1.80 and 1.33
    # fps across three viewers where two workers gave 5.55, 0.89 and zero.
    #
    # It costs nothing to raise, because the card is not what runs out. Through
    # all of this the GPU sat at 4-24% and only touched 100% while the recorder
    # was boxing its clips. What limits a viewer is the stream: HLS arrives a
    # segment at a time and these cameras drop connections at random.
    ap.add_argument("--focus-workers", type=int, default=6,
                    help="cameras that can be tracked at once")
    # A ceiling rather than a target: one camera on its own reached 10.5 fps,
    # and holding that back at 8 was leaving frames on the table for no reason
    # the measurements support. The streams themselves rarely offer more than
    # this, so in practice it only stops a single viewer monopolising the card.
    # One frame every three seconds, each one through YOLO. The optical-flow
    # tracker cannot carry a box across a gap that long, so every frame is a
    # fresh detection and a track is dropped after one miss.
    ap.add_argument("--focus-fps", type=float, default=1 / 3,
                    help="frames a second to pull for the camera being watched")
    ap.add_argument("--redetect-every", type=int, default=1,
                    help="run YOLO on every Nth focused frame (1 = every frame)")
    ap.add_argument("--track-max-age", type=int, default=1,
                    help="frames a track survives without a matching detection")
    args = ap.parse_args()

    model_box = {}

    def run_loop():
        loop(args.site, args.interval, args.conf, args.weights, args.imgsz, model_box)

    threading.Thread(target=run_loop, daemon=True).start()

    state["focus_workers"] = args.focus_workers

    def run_focus(worker_id):
        while "model" not in model_box:
            time.sleep(0.5)
        focus_worker(worker_id, model_box["model"], args.conf, args.imgsz,
                     args.focus_fps, args.site, args.redetect_every, args.track_max_age)

    for worker_id in range(args.focus_workers):
        threading.Thread(target=run_focus, args=(worker_id,), daemon=True).start()

    threading.Thread(target=clip_worker, args=(model_box, args.conf, args.imgsz), daemon=True).start()

    print(f"Detector on http://127.0.0.1:{args.port}  (sweep every {args.interval}s)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
