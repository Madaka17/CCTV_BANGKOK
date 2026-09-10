#!/usr/bin/env python3
"""Camera recorder.

The site shows what a camera sees now. This keeps what it saw: ten minutes of
video from every camera, without a break, written to D:/CCTV and played back on
the cards in the order it was recorded.

ffmpeg does the recording, not OpenCV, and it copies the stream rather than
decoding it. Twenty-nine of the thirty cameras Longdo serves are already H.264
at 25fps - measured with ffprobe - which is exactly what a browser plays, so
there is nothing to convert and a round costs almost no CPU at all. Only
ITICM_BMAMI0188 arrives as HEVC, which most browsers will not play, and only
that one is re-encoded.

That is also why the clips have no boxes on them any more. Drawing them meant
running the model over every frame, at 70ms a frame; ten minutes at 25fps is
15000 frames, or seventeen minutes of GPU for one camera's one clip. Instead a
finished clip is sampled - a couple of dozen frames spread across the ten
minutes - and only the vehicle counts are kept, in the same CSV as before.

    python recorder/record.py --out D:/CCTV

Writes D:/CCTV/<camera>/<date>/<time>.mp4, one every ten minutes per camera,
and D:/CCTV/<camera>/<date>.csv alongside them.
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
from datetime import datetime, timezone

# Sampling a clip means seeking into it, and a seek lands the decoder in the
# middle of a GOP, which makes ffmpeg say "co located POCs unavailable" for
# every one. OpenCV decodes forward from the keyframe before the target so the
# frame itself is fine, and 24 seeks a clip across 29 cameras buried the round
# summary in thousands of those lines. Set before cv2 loads, or it is ignored.
os.environ.setdefault("OPENCV_FFMPEG_LOGLEVEL", "-8")

import cv2  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "detector"))
from detect import MOTORCYCLE_CONF, VEHICLES, predict, vehicle_boxes  # noqa: E402
from ultralytics import YOLO  # noqa: E402


# One probe measured 1.05 Mbps at 704x576; the 1080p cameras run higher. Call
# it 2 Mbps across the thirty and a ten minute clip is around 150 MB, so a
# round of every camera is roughly 4.4 GB and an hour is 26 GB. The 219 GB free
# on D: is therefore about eight hours of history before free_space() starts
# taking the oldest clip off each camera.
CODEC_PROBE = ["ffprobe", "-hide_banner", "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=codec_name", "-of", "csv=p=0:nk=1"]


def human(n):
    if n >= 1024 ** 3:
        return f"{n/1024**3:.1f} GB"
    return f"{n/1024/1024:.0f} MB" if n >= 1024 * 1024 else f"{n/1024:.0f} KB"


def cameras(site):
    with urllib.request.urlopen(f"{site}/api/video-cameras", timeout=30) as r:
        data = json.load(r)
    return data if isinstance(data, list) else (data.get("cameras") or data.get("list") or [])


def codec_of(url, cache):
    """What the camera sends, remembered per camera for the life of the run.

    A probe is a fresh HLS connection and a second or two, and the answer does
    not change between rounds, so it is paid once. An unreadable probe is
    treated as H.264: that is what all but one camera is, and a copy that turns
    out to be wrong costs one clip rather than an hour of re-encoding.
    """
    if url in cache:
        return cache[url]
    try:
        out = subprocess.run(CODEC_PROBE + [url], capture_output=True, text=True,
                             timeout=60, stdin=subprocess.DEVNULL)
        codec = (out.stdout.strip().splitlines() or ["h264"])[0].strip() or "h264"
    except Exception:
        codec = "h264"
    cache[url] = codec
    return codec


def start(cam, out_dir, day, seconds, codec):
    """Begin recording one camera. Returns the process and where it will land.

    The clip is written under a name the server skips - it lists *.mp4 but not
    *.writing.mp4 - and moved into place when ffmpeg is done, so a card never
    picks up a file that is still being appended to.
    """
    stamp = datetime.now(timezone.utc).strftime("%H-%M-%S")
    folder = os.path.join(out_dir, cam["id"], day)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{stamp}.mp4")
    partial = os.path.join(folder, f"{stamp}.writing.mp4")

    video = ["-c:v", "copy"] if codec == "h264" else [
        # The one HEVC camera. veryfast because this runs beside the live
        # detector on the same machine, and 704x576 does not need better.
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p"]

    proc = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
         # A camera that stops sending mid-clip should end the clip, not hang
         # the round until the wall-clock kill in wait_for().
         "-rw_timeout", "20000000",
         "-i", cam["hls"], "-t", str(seconds), "-an", *video,
         # Without this the index sits at the end of the file and a browser has
         # to fetch all 150 MB before the first frame shows.
         "-movflags", "+faststart", "-y", partial],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE, text=True)
    return {"cam": cam["id"], "proc": proc, "path": path, "partial": partial,
            "day": day, "at": stamp, "started": time.time()}


def duration_of(path):
    """Seconds of video in a finished file, or 0 if it has none."""
    try:
        out = subprocess.run(
            ["ffprobe", "-hide_banner", "-v", "error", "-show_entries",
             "format=duration", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
        return float(out.stdout.strip() or 0)
    except Exception:
        return 0.0


def wait_for(jobs, seconds, floor_seconds=30):
    """Wait out the round, then take what finished.

    A camera whose stream drops part way still leaves a playable clip, and a
    short clip of a real junction is worth keeping - the first round measured
    600.0s from fifteen cameras and 320-520s from three more. But one came back
    at 4.2 seconds, which is a card that flashes and moves on rather than a
    record of anything, so there is a floor.

    faststart rewrites the file once ffmpeg has the last frame, so a clip lands
    a little after its ten minutes are up; the grace is for that, and it is
    short. One camera that hangs holds up the whole round, and the round after
    it is footage from every camera that nobody recorded.

    communicate() rather than wait(), because ffmpeg's stderr is a pipe: a
    flaky stream that fills the pipe buffer would block ffmpeg forever waiting
    for someone to read it, and nobody would until it exited.

    Each camera is given until its own start plus the clip length, not until
    this call plus it. The counting of the last round happens between the two,
    and a measured round came to 763s for 600s of video because of it - 163
    seconds per round of every camera recording nothing.
    """
    done = []
    for job in jobs:
        deadline = job["started"] + seconds + 30
        try:
            _, stderr = job["proc"].communicate(timeout=max(1, deadline - time.time()))
        except subprocess.TimeoutExpired:
            job["proc"].kill()
            _, stderr = job["proc"].communicate()
        err = (stderr or "").strip().splitlines()
        job["error"] = None
        if job["proc"].returncode != 0:
            job["error"] = err[-1][:70] if err else f"ffmpeg exit {job['proc'].returncode}"
        elif not os.path.exists(job["partial"]) or os.path.getsize(job["partial"]) == 0:
            job["error"] = "empty clip"
        else:
            held = duration_of(job["partial"])
            if held < floor_seconds:
                job["error"] = f"only {held:.1f}s of video"
        if job["error"]:
            if os.path.exists(job["partial"]):
                os.remove(job["partial"])
            continue
        os.replace(job["partial"], job["path"])
        done.append(job)
    return done


def count(job, model, conf, imgsz, samples):
    """How many vehicles the clip holds, from frames spread across it.

    Not a tracker: two sampled frames are half a minute apart and share no
    vehicle, so there is nothing to follow between them. Each sample is counted
    on its own and the clip keeps the average, which is what "how busy was this
    junction over ten minutes" actually asks for.
    """
    cap = cv2.VideoCapture(job["path"])
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total <= 0:
        cap.release()
        return None

    seen = []
    step = max(1, total // samples)
    try:
        for i in range(0, total, step):
            cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            counts = {}
            for cls, _ in vehicle_boxes(predict(model, frame, conf, imgsz), conf):
                name = VEHICLES[cls][0]
                counts[name] = counts.get(name, 0) + 1
            seen.append(counts)
            if len(seen) >= samples:
                break
    finally:
        cap.release()

    if not seen:
        return None
    mean = {}
    for name in ("car", "motorcycle", "bus", "truck"):
        mean[name] = round(sum(c.get(name, 0) for c in seen) / len(seen))
    return {"at": job["at"], "total": sum(mean.values()), "counts": mean}


def count_round(jobs, out_dir, pool, model, args):
    """Measure a finished round and write its rows."""
    vehicles = 0
    readings = pool.map(
        lambda j: count(j, model, args.conf, args.imgsz, args.samples), jobs)
    for job, reading in zip(jobs, readings):
        if reading:
            log_counts(out_dir, job["cam"], job["day"], reading)
            vehicles += reading["total"]
    print(f"  counted {len(jobs)} clips, {vehicles} vehicles", flush=True)


def log_counts(out_dir, cam_id, day, reading):
    """One line per clip, so the day is a table as well as a video."""
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


def clips_of(cam_dir):
    """Every finished clip of one camera, oldest first.

    The names sort into time order on their own - <date>/<HH-MM-SS>.mp4 - so
    the oldest is the first of them, and a clip still being written is not one
    of them.
    """
    found = []
    for day in sorted(os.listdir(cam_dir)):
        day_dir = os.path.join(cam_dir, day)
        if len(day) != 10 or not os.path.isdir(day_dir):
            continue
        for name in sorted(os.listdir(day_dir)):
            if name.endswith(".mp4") and ".writing." not in name:
                found.append(os.path.join(day_dir, name))
    return found


def free_space(out_dir, floor):
    """Take the oldest clip off every camera until the drive has room again.

    A pass at a time rather than one camera at a time, so the history stays the
    same length everywhere: no camera loses its whole day while another keeps
    every clip. A pass frees a round's worth, so the drive is back over the
    floor within a pass or two of reaching it.
    """
    freed = 0
    while shutil.disk_usage(out_dir).free < floor:
        removed = 0
        for cam_id in sorted(os.listdir(out_dir)):
            cam_dir = os.path.join(out_dir, cam_id)
            if not os.path.isdir(cam_dir):
                continue
            oldest = clips_of(cam_dir)
            if not oldest:
                continue
            freed += os.path.getsize(oldest[0])
            os.remove(oldest[0])
            removed += 1
            day_dir = os.path.dirname(oldest[0])
            if not os.listdir(day_dir):
                os.rmdir(day_dir)
        # Nothing left to give: the drive is full of something else
        if not removed:
            break
    return freed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.environ.get("CCTV_DIR", "D:/CCTV"))
    ap.add_argument("--site", default="http://127.0.0.1:3000")
    ap.add_argument("--minutes", type=int, default=10,
                    help="length of one clip; the next starts as this one ends")
    ap.add_argument("--free-gb", type=float, default=20.0,
                    help="keep this much of the drive free by dropping oldest clips")
    ap.add_argument("--samples", type=int, default=24,
                    help="frames per clip measured for the vehicle counts")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--weights", default="detector/weights/yolo11x.pt")
    ap.add_argument("--conf", type=float, default=0.15)
    ap.add_argument("--imgsz", type=int, default=1280)
    ap.add_argument("--once", action="store_true", help="one clip, then stop")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    seconds = args.minutes * 60
    floor = int(args.free_gb * 1024 ** 3)

    print(f"Loading {args.weights} ...", flush=True)
    model = YOLO(args.weights)
    # Same reason as the detector: the first real frame otherwise pays for the
    # fp16 cast and for cuDNN picking its algorithms.
    predict(model, np.zeros((720, 1280, 3), dtype=np.uint8), MOTORCYCLE_CONF, args.imgsz)
    print(f"Recording {args.minutes} minute clips to {args.out}, "
          f"keeping {args.free_gb:g} GB free", flush=True)

    pool = ThreadPoolExecutor(max_workers=args.workers)
    codecs = {}
    # Counted while the next round records, not between rounds: the model is
    # the only slow part left, and a gap here is footage nobody kept.
    pending = None

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

        freed = free_space(args.out, floor)
        if freed:
            print(f"  dropped {human(freed)} of oldest clips to stay above "
                  f"{args.free_gb:g} GB free", flush=True)

        jobs = [start(c, args.out, day, seconds, codec_of(c["hls"], codecs))
                for c in found]

        if pending:
            count_round(pending, args.out, pool, model, args)

        done = wait_for(jobs, seconds)
        kept = sum(os.path.getsize(j["path"]) for j in done)
        print(f"[{now.strftime('%H:%M:%S')}] {len(done)}/{len(jobs)} cameras, "
              f"{human(kept)}, {time.time() - started:.0f}s, "
              f"{human(shutil.disk_usage(args.out).free)} free", flush=True)

        if args.once:
            count_round(done, args.out, pool, model, args)
            return
        pending = done


if __name__ == "__main__":
    main()
