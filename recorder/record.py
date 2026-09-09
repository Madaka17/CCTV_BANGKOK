#!/usr/bin/env python3
"""Camera recorder.

The site shows what a camera sees now. This keeps what it saw: a frame from
every camera on an interval, stitched into a video a day at a time, and thrown
away after a few days.

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
import subprocess
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


def stitch(cam_dir, day, fps, drop_frames):
    """The day's frames as one video.

    Rebuilt every round rather than only when the day is over, so a card shows
    moving traffic from the first few frames on instead of a still picture
    until midnight. Re-encoding the day so far costs a read of each frame, and
    a day tops out at 144 of them.

    The video is written beside the real name and moved into place, because the
    web server may be streaming the old one to somebody while this runs. The
    temporary name still has to end in .mp4: OpenCV picks the container from
    the extension, and a ".part" suffix leaves the writer unable to open at all.

    H.264, because no browser plays anything else here. mp4v was the first
    choice and it was wrong: OpenCV reads it back happily, which is how it got
    through review, but MPEG-4 Part 2 is not a codec a browser will play in a
    video element - the cards were being handed a file they could only show as
    black. It needs openh264-2.5.0-win64.dll beside cv2; see the README.

    It is a third of the size as well. Twenty frames measured 1.08 MB as H.264
    against 3.54 MB as mp4v, and mp4v was already 18% of what the same frames
    cost kept as separate JPEGs.
    """
    folder = os.path.join(cam_dir, day)
    shots = sorted(f for f in os.listdir(folder) if f.endswith(".jpg"))
    if not shots:
        if drop_frames:
            shutil.rmtree(folder, ignore_errors=True)
        return None

    first = cv2.imread(os.path.join(folder, shots[0]))
    if first is None:
        return None
    height, width = first.shape[:2]
    path = os.path.join(cam_dir, f"{day}.mp4")
    partial = os.path.join(cam_dir, f"{day}.writing.mp4")
    writer = cv2.VideoWriter(partial, cv2.VideoWriter_fourcc(*"avc1"), fps, (width, height))
    if not writer.isOpened():
        # It may still have created the file before giving up
        if os.path.exists(partial):
            os.remove(partial)
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

    if not written:
        if os.path.exists(partial):
            os.remove(partial)
        return None

    # Windows will not let the finished file take the place of one another
    # process has open, and the page loops these videos, so the server has the
    # old one open a good part of the time. Wait for a gap; if there is not one,
    # keep the video that is already there and try again next round.
    for attempt in range(6):
        try:
            os.replace(partial, path)
            break
        except PermissionError:
            if attempt == 5:
                os.remove(partial)
                return None
            time.sleep(0.5)

    if drop_frames:
        shutil.rmtree(folder, ignore_errors=True)
    return path, written, os.path.getsize(path)


def restitch(out_dir, today, fps):
    """Rebuild every day's video.

    Today's is rebuilt in place and keeps its frames, since more are coming. A
    day that is over is rebuilt one last time and gives its frames up.
    """
    made = []
    for cam_id in sorted(os.listdir(out_dir)):
        cam_dir = os.path.join(out_dir, cam_id)
        if not os.path.isdir(cam_dir):
            continue
        for day in sorted(os.listdir(cam_dir)):
            day_dir = os.path.join(cam_dir, day)
            if not os.path.isdir(day_dir):
                continue
            finished = day < today
            result = stitch(cam_dir, day, fps, drop_frames=finished)
            if result and finished:
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
    ap.add_argument("--keep-days", type=int, default=5)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--video-fps", type=int, default=10,
                    help="playback rate of the stitched day; at ten minute samples "
                         "a whole day comes to about fifteen seconds")
    ap.add_argument("--weights", default="detector/weights/yolo11x.pt")
    ap.add_argument("--conf", type=float, default=0.15)
    ap.add_argument("--imgsz", type=int, default=1280)
    ap.add_argument("--once", action="store_true", help="one round, then stop")
    ap.add_argument("--stitch-only", action="store_true",
                    help="rebuild the videos and exit; how the loop runs the stitch")
    args = ap.parse_args()

    if args.stitch_only:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        for cam_id, d, frames, size in restitch(args.out, today, args.video_fps):
            print(f"  closed {cam_id}/{d}: {frames} frames -> {human(size)}")
        return

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
        day, stamp = now.strftime("%Y-%m-%d"), now.strftime("%H-%M-%S")

        try:
            found = cameras(args.site)
        except Exception as exc:
            print(f"camera list failed ({str(exc)[:60]}) - retrying in 30s", flush=True)
            time.sleep(30)
            continue

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

        # Rebuilding the videos in this process cost it about 600 MB a round
        # that it never gave back - it reached 15 GB and was killed. The work
        # is reading every frame of the day back through OpenCV, and whatever
        # holds on to that is not worth chasing when a child process hands it
        # all back on exit. This is the same file, run for the stitch alone.
        child = subprocess.run(
            [sys.executable, os.path.abspath(__file__), "--stitch-only",
             "--out", args.out, "--video-fps", str(args.video_fps)],
            capture_output=True, text=True, timeout=600)
        for line in child.stdout.splitlines():
            print(line, flush=True)
        if child.returncode:
            print(f"  stitch failed ({child.returncode}): "
                  f"{child.stderr.strip()[-200:]}", flush=True)

        print(f"[{now.strftime('%H:%M:%S')}] {len(saved)}/{len(found)} cameras, "
              f"{vehicles} vehicles, {time.time() - started:.0f}s", flush=True)

        if args.once:
            return
        time.sleep(max(1, args.interval - (time.time() - started)))


if __name__ == "__main__":
    main()
