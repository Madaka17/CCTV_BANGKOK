#!/usr/bin/env python3
"""Camera recorder.

The site shows what a camera sees now. This keeps what it saw: a frame from
every camera on an interval, stitched into a video a day at a time, and thrown
away after a few days.

Ninety seconds is not an arbitrary interval. Each frame costs a fresh HLS
connection - playlist, first segment, then the frame - and a round of every
camera measured 77s at eight workers and 73s at sixteen, so the connection is
the cost and more threads do not move it. Anything under about 90s would start
a round before the last one finished.

That interval is too coarse to follow a vehicle, so this is not a second copy
of the detector. It is the record of how busy each junction was, hour by hour,
which is what the traffic history in logger/ needs to be worth anything.

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
from detect import MOTORCYCLE_CONF, detect, grab_frame, predict  # noqa: E402
from ultralytics import YOLO  # noqa: E402


def human(n):
    return f"{n/1024/1024:.1f} MB" if n >= 1024 * 1024 else f"{n/1024:.0f} KB"


def cameras(site):
    with urllib.request.urlopen(f"{site}/api/video-cameras", timeout=30) as r:
        data = json.load(r)
    return data if isinstance(data, list) else (data.get("cameras") or data.get("list") or [])


def capture(cam, out_dir, day, stamp, model, conf, imgsz):
    """One frame, with what was on the road drawn onto it.

    The boxes are burnt into the stored frame rather than kept beside it. The
    stitched day is then watchable as it is, with no second file to keep in
    step and nothing for the page to draw - and a frame this far apart from its
    neighbours is only ever going to be looked at, not re-processed.
    """
    try:
        frame = grab_frame(cam["hls"])
    except Exception as exc:
        return cam["id"], str(exc)[:60], None

    try:
        counts, total, annotated, _ = detect(model, frame, conf, imgsz)
    except Exception as exc:
        return cam["id"], f"detect: {str(exc)[:50]}", None

    folder = os.path.join(out_dir, cam["id"], day)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, f"{stamp}.jpg"), "wb") as fh:
        fh.write(annotated if annotated else b"")
    return cam["id"], None, {"at": stamp, "total": total, "counts": counts}


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


def stitch(cam_dir, day, fps):
    """A finished day's frames as one video, then the frames go.

    Measured on these cameras, mp4v holds 18% of what the same frames cost as
    separate JPEGs. H.264 would roughly halve that again where the machine has
    an encoder; OpenCV falls back to writing almost nothing useful when it does
    not, so this stays on the codec that is always there.
    """
    folder = os.path.join(cam_dir, day)
    shots = sorted(f for f in os.listdir(folder) if f.endswith(".jpg"))
    if not shots:
        shutil.rmtree(folder, ignore_errors=True)
        return None

    first = cv2.imread(os.path.join(folder, shots[0]))
    if first is None:
        return None
    height, width = first.shape[:2]
    path = os.path.join(cam_dir, f"{day}.mp4")
    writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        return None

    written = 0
    for name in shots:
        frame = cv2.imread(os.path.join(folder, name))
        if frame is None:
            continue
        if frame.shape[:2] != (height, width):
            frame = cv2.resize(frame, (width, height))
        writer.write(frame)
        written += 1
    writer.release()

    if written:
        shutil.rmtree(folder, ignore_errors=True)
        return path, written, os.path.getsize(path)
    os.remove(path)
    return None


def close_finished_days(out_dir, today, fps):
    """Stitch every day that is over. A day still being written is left alone."""
    made = []
    for cam_id in sorted(os.listdir(out_dir)):
        cam_dir = os.path.join(out_dir, cam_id)
        if not os.path.isdir(cam_dir):
            continue
        for day in sorted(os.listdir(cam_dir)):
            day_dir = os.path.join(cam_dir, day)
            if not os.path.isdir(day_dir) or day >= today:
                continue
            result = stitch(cam_dir, day, fps)
            if result:
                made.append((cam_id, day, result[1], result[2]))
    return made


def prune(out_dir, keep_days, today):
    """Anything older than the window, whether it was stitched or not."""
    cutoff = (datetime.strptime(today, "%Y-%m-%d") - timedelta(days=keep_days)).strftime("%Y-%m-%d")
    freed = 0
    for cam_id in sorted(os.listdir(out_dir)):
        cam_dir = os.path.join(out_dir, cam_id)
        if not os.path.isdir(cam_dir):
            continue
        for name in sorted(os.listdir(cam_dir)):
            day = name[:-4] if name.endswith(".mp4") else name
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
    ap.add_argument("--interval", type=int, default=90,
                    help="seconds between rounds; a round of every camera measured 73-77s")
    ap.add_argument("--keep-days", type=int, default=5)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--video-fps", type=int, default=10,
                    help="playback rate of the stitched day; 10 turns a day into about 16 minutes")
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

    while True:
        started = time.time()
        now = datetime.now(timezone.utc)
        day, stamp = now.strftime("%Y-%m-%d"), now.strftime("%H-%M-%S")

        try:
            found = cameras(args.site)
        except Exception as exc:
            print(f"camera list failed ({str(exc)[:60]}) - retrying in 30s", flush=True)
            time.sleep(30)
            continue

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            results = list(pool.map(
                lambda c: capture(c, args.out, day, stamp, model, args.conf, args.imgsz),
                found))
        saved = [r for r in results if r[1] is None]
        vehicles = 0
        for cam_id, error, reading in results:
            if reading:
                log_counts(args.out, cam_id, day, reading)
                vehicles += reading["total"]

        # Prune first: a day past the window is about to go, and stitching it
        # would be work done only to delete the result.
        freed = prune(args.out, args.keep_days, day)
        if freed:
            print(f"  pruned {human(freed)} past {args.keep_days} days", flush=True)
        for cam_id, d, frames, size in close_finished_days(args.out, day, args.video_fps):
            print(f"  stitched {cam_id}/{d}: {frames} frames -> {human(size)}", flush=True)

        print(f"[{now.strftime('%H:%M:%S')}] {len(saved)}/{len(found)} cameras, "
              f"{vehicles} vehicles, {time.time() - started:.0f}s", flush=True)

        if args.once:
            return
        time.sleep(max(1, args.interval - (time.time() - started)))


if __name__ == "__main__":
    main()
