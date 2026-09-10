#!/usr/bin/env python3
"""Camera recorder.

The site shows what a camera sees now. This keeps what it saw: a frame from
a few seconds of video from every camera on an interval, and thrown away after
a day.

The interval has a floor and it is not small. Each frame costs a fresh HLS
connection - playlist, first segment, then the frame - and a round of every
camera measured 77s at eight workers and 73s at sixteen, or 108-131s once the
model runs on each frame as well. So the connection is the cost, more threads
do not move it, and anything under about two minutes would start a round before
the last one finished.

Ten minutes sits well clear of that. It is far too coarse to follow a vehicle,
so this is not a second copy of the detector: it is the record of how busy each
junction was, hour by hour, which is what the traffic history in logger/ needs
to be worth anything. Longdo repaint their own road colours every five minutes,
so a ten minute sample is the same order as the thing it sits beside.

    python recorder/record.py --out D:/CCTV

Writes D:/CCTV/<camera>/<date>/<time>.jpg while a day is in progress, then
D:/CCTV/<camera>/<date>.mp4 once it is over.
"""

import argparse
import json
import os
import shutil
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "detector"))
from detect import (MOTORCYCLE_CONF, VEHICLES, FlowTracker,  # noqa: E402
                    drain_to_live, draw_tracks, open_stream, predict,
                    vehicle_boxes)
from ultralytics import YOLO  # noqa: E402


# How long a clip runs. Six seconds is enough to see whether traffic is moving.
CLIP_SECONDS = 6
# Written at this rate whatever the camera sends. Some of these run at 60fps,
# which for watching a queue move is four times the file for nothing a viewer
# can see: one measured 87 MB for six seconds at 1920x1080. Resolution is left
# alone - that is what makes a clip worth looking at - and only the surplus
# frames go. Across every camera it took the mean from 19.1 MB to what the
# storage figures below assume.
CLIP_FPS = 15


def human(n):
    return f"{n/1024/1024:.1f} MB" if n >= 1024 * 1024 else f"{n/1024:.0f} KB"


def cameras(site):
    with urllib.request.urlopen(f"{site}/api/video-cameras", timeout=30) as r:
        data = json.load(r)
    return data if isinstance(data, list) else (data.get("cameras") or data.get("list") or [])


def capture(cam, out_dir, day, model, conf, imgsz):
    """A few seconds of real video from one camera, and what was on it.

    A frame every ten minutes could not be read as traffic - the road simply
    looked different each time, and no amount of cross-fading between two
    unrelated moments makes that a picture of anything. Seconds of actual
    motion tell someone what a junction is like at a glance.

    The boxes do not go on it. Drawing them would mean running the model over
    every frame of every clip - 90 frames times 29 cameras a round, against the
    29 passes this does - so one frame out of the clip is measured for the
    count and the video itself is left as it came off the camera.
    """
    cap = open_stream(cam["hls"])
    if cap is None:
        return cam["id"], "could not open stream", None

    try:
        drain_to_live(cap)
        native = cap.get(cv2.CAP_PROP_FPS)
        native = native if 1 < native <= 120 else 25
        step = max(1, round(native / CLIP_FPS))
        fps = native / step
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if not width or not height:
            return cam["id"], "no frame size", None

        stamp = datetime.now(timezone.utc).strftime("%H-%M-%S")
        folder = os.path.join(out_dir, cam["id"], day)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, f"{stamp}.mp4")
        partial = os.path.join(folder, f"{stamp}.writing.mp4")
        raw = os.path.join(folder, f"{stamp}.raw.mp4")

        writer = cv2.VideoWriter(raw, cv2.VideoWriter_fourcc(*"avc1"),
                                 fps, (width, height))
        if not writer.isOpened():
            if os.path.exists(raw):
                os.remove(raw)
            return cam["id"], "no encoder", None

        # Read at whatever the camera sends and keep one in every step, so the
        # clip covers CLIP_SECONDS of real time however fast the source runs.
        wanted = int(CLIP_SECONDS * native)
        written = 0
        try:
            for i in range(wanted):
                ok, frame = cap.read()
                if not ok or frame is None:
                    break
                if i % step:
                    continue
                writer.write(frame)
                written += 1
        finally:
            writer.release()
    finally:
        cap.release()

    # A stream that hands over a frame or two and stops is not a clip
    if written < CLIP_FPS:
        if os.path.exists(raw):
            os.remove(raw)
        return cam["id"], f"only {written} frames", None

    try:
        counts, total = annotate(raw, partial, fps, (width, height), model, conf, imgsz)
    except Exception as exc:
        for leftover in (raw, partial):
            if os.path.exists(leftover):
                os.remove(leftover)
        return cam["id"], f"annotate: {str(exc)[:50]}", None
    os.replace(partial, path)
    os.remove(raw)
    return cam["id"], None, {"at": stamp, "total": total, "counts": counts}


def annotate(source, target, fps, size, model, conf, imgsz):
    """The same clip with the vehicles boxed, and what it counted.

    Reading the clip back rather than boxing it as it arrives, because the
    tracker cannot keep up with a live stream and eight of them at once: it
    costs 70ms a frame, and a six second clip at fifteen frames is 5.3s of
    work. Off the stream clock that is fine - 29 cameras come to 154s of a
    600s round - but on it the read would fall behind and the clip would tear.

    The tracker runs the model on every third frame and carries the boxes
    between on optical flow, which is what makes 90 frames cost 25 passes
    rather than 90.
    """
    def run_yolo(frame):
        result = predict(model, frame, conf, imgsz)
        out = []
        for cls, box in vehicle_boxes(result, conf):
            x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
            out.append({"bbox": [x1, y1, x2, y2], "name": VEHICLES[cls][0],
                        "conf": float(box.conf[0])})
        return out

    cap = cv2.VideoCapture(source)
    writer = cv2.VideoWriter(target, cv2.VideoWriter_fourcc(*"avc1"), fps, size)
    if not writer.isOpened():
        cap.release()
        raise RuntimeError("no encoder for the annotated clip")

    tracker = FlowTracker()
    tracker.reset()
    counts, total = {}, 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                break
            tracks, _ = tracker.update(frame, run_yolo)
            writer.write(draw_tracks(frame, tracks))
            # The last frame's tracks are the count for the clip
            counts = {}
            for t in tracks.values():
                counts[t["name"]] = counts.get(t["name"], 0) + 1
            total = len(tracks)
    finally:
        writer.release()
        cap.release()
    return counts, total

def log_counts(out_dir, cam_id, day, reading):
    """One line per frame, so the day is a table as well as a video."""
    path = os.path.join(out_dir, cam_id, f"{day}.csv")
    header = "at,total,car,motorcycle,bus,truck"
    counts = reading["counts"]
    row = ",".join(str(v) for v in (
        reading["at"], reading["total"],
        counts.get("car", 0), counts.get("motorcycle", 0),
        counts.get("bus", 0), counts.get("truck", 0),
    ))
    new = not os.path.exists(path)
    with open(path, "a", encoding="utf-8") as fh:
        if new:
            print(header, file=fh)
        print(row, file=fh)


def prune(out_dir, keep_days, today):
    """Anything older than the window."""
    cutoff = (datetime.strptime(today, "%Y-%m-%d") - timedelta(days=keep_days)).strftime("%Y-%m-%d")
    freed = 0
    for cam_id in sorted(os.listdir(out_dir)):
        cam_dir = os.path.join(out_dir, cam_id)
        if not os.path.isdir(cam_dir):
            continue
        for name in sorted(os.listdir(cam_dir)):
            day = name[:-4] if name.endswith(".mp4") else name
            # ".writing.mp4" leaves a longer stem, so it never matches a date
            if len(day) != 10 or day >= cutoff:
                continue
            path = os.path.join(cam_dir, name)
            if os.path.isdir(path):
                freed += sum(os.path.getsize(os.path.join(path, f)) for f in os.listdir(path))
                shutil.rmtree(path, ignore_errors=True)
            else:
                freed += os.path.getsize(path)
                os.remove(path)
    return freed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.environ.get("CCTV_DIR", "D:/CCTV"))
    ap.add_argument("--site", default="http://127.0.0.1:3000")
    ap.add_argument("--interval", type=int, default=600,
                    help="seconds between rounds; a round of every camera takes 108-131s")
    ap.add_argument("--keep-days", type=int, default=1,
                    help="clips are 9 MB each, so a day of them is already 38 GB")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--weights", default="detector/weights/yolo11x.pt")
    ap.add_argument("--conf", type=float, default=0.15)
    ap.add_argument("--imgsz", type=int, default=1280)
    ap.add_argument("--once", action="store_true", help="one round, then stop")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    print(f"Loading {args.weights} ...", flush=True)
    model = YOLO(args.weights)
    # Same reason as the detector: the first real frame otherwise pays for the
    # fp16 cast and for cuDNN picking its algorithms.
    predict(model, np.zeros((720, 1280, 3), dtype=np.uint8), MOTORCYCLE_CONF, args.imgsz)
    print(f"Recording every {args.interval}s to {args.out}, keeping {args.keep_days} days",
          flush=True)

    # One pool for the life of the process, not one per round. A thread that
    # has called into the model leaves state behind when it dies, and building
    # eight fresh ones every ten minutes cost about 300 MB a round that never
    # came back - the recorder reached 15 GB and was killed for it. Measured
    # here: five rounds through a pool that is kept sat at 2300.7 MB to the
    # decimal, where five rounds of new pools climbed 1947 -> 3509 MB.
    #
    # It is also the difference between 71 seconds a round and 5, because each
    # new thread pays for its own CUDA warm-up before it can infer anything.
    pool = ThreadPoolExecutor(max_workers=args.workers)

    while True:
        started = time.time()
        now = datetime.now(timezone.utc)
        day = now.strftime("%Y-%m-%d")

        try:
            found = cameras(args.site)
        except Exception as exc:
            print(f"camera list failed ({str(exc)[:60]}) - retrying in 30s", flush=True)
            time.sleep(30)
            continue

        results = list(pool.map(
            lambda c: capture(c, args.out, day, model, args.conf, args.imgsz),
            found))
        saved = [r for r in results if r[1] is None]
        vehicles = 0
        for cam_id, error, reading in results:
            if reading:
                log_counts(args.out, cam_id, day, reading)
                vehicles += reading["total"]

        freed = prune(args.out, args.keep_days, day)
        if freed:
            print(f"  pruned {human(freed)} past {args.keep_days} days", flush=True)

        print(f"[{now.strftime('%H:%M:%S')}] {len(saved)}/{len(found)} cameras, "
              f"{vehicles} vehicles, {time.time() - started:.0f}s", flush=True)

        if args.once:
            return
        time.sleep(max(1, args.interval - (time.time() - started)))


if __name__ == "__main__":
    main()
