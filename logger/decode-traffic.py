#!/usr/bin/env python3
"""
Turn a run of logged traffic tiles into a table for analysis.

Each sample directory holds the vector tiles covering Bangkok at one moment.
This walks them, decodes every road segment, and writes one CSV row per
segment per sample:

    at, segment, lat, lng, forward, reverse

`segment` is a hash of the road's geometry. The tiles carry no feature id -
every feature reports id 0 - but the geometry of a road does not move, so its
shape is what identifies it from one sample to the next. That is what makes a
time series per road possible.

`forward` and `reverse` are the two directions, as 0 flowing, 1 slowing,
2 congested, or blank where the tile has no reading.

Usage:
    python3 logger/decode-traffic.py [--history DIR] [--out FILE] [--limit N]

Needs mapbox-vector-tile:
    python3 -m venv .venv && .venv/bin/pip install mapbox-vector-tile
    .venv/bin/python logger/decode-traffic.py
"""

import argparse
import csv
import gzip
import hashlib
import json
import math
import pathlib
import sys

try:
    import mapbox_vector_tile
except ImportError:
    sys.exit(
        "Missing mapbox-vector-tile. Install it with:\n"
        "  python3 -m venv .venv && .venv/bin/pip install mapbox-vector-tile\n"
        "then run this with .venv/bin/python"
    )

# The colours Longdo paints the roads with
LEVELS = {"54C00C": 0, "FEDE04": 1, "FF2020": 2}
EXTENT = 4096


def tile_to_lnglat(z, x, y, px, py, extent=EXTENT):
    """Tile-local coordinates to longitude/latitude."""
    n = 2 ** z
    lng = (x + px / extent) / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * (y + (extent - py) / extent) / n)))
    return lng, math.degrees(lat_rad)


def decode_tile(path):
    """Yield (segment_id, lng, lat, forward, reverse) for one tile file."""
    z, x, y = (int(p) for p in path.name.split(".")[0].split("-"))

    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)

    try:
        tile = mapbox_vector_tile.decode(raw)
    except Exception:
        return

    layer = tile.get("traffic")
    if not layer:
        return

    for feature in layer["features"]:
        geom = feature["geometry"]
        if geom["type"] != "LineString":
            continue
        coords = geom["coordinates"]
        if not coords:
            continue

        props = feature["properties"]
        forward = LEVELS.get(props.get("fillcolor") or "", "")
        reverse = LEVELS.get(props.get("fillcolor_r") or "", "")
        if forward == "" and reverse == "":
            continue

        # The shape is the identity: same road, same points, every sample
        shape = ";".join(f"{int(px)},{int(py)}" for px, py in coords)
        segment = hashlib.sha1(f"{z}/{x}/{y}|{shape}".encode()).hexdigest()[:12]

        lng, lat = tile_to_lnglat(z, x, y, *coords[0])
        yield segment, round(lng, 6), round(lat, 6), forward, reverse


def main():
    here = pathlib.Path(__file__).resolve().parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", default=str(here.parent / "data" / "traffic-history"))
    ap.add_argument("--out", default=str(here.parent / "data" / "traffic-history.csv"))
    ap.add_argument("--limit", type=int, default=0, help="stop after N samples")
    args = ap.parse_args()

    root = pathlib.Path(args.history)
    if not root.exists():
        sys.exit(f"No history at {root} - run logger/log-traffic.js first")

    samples = sorted(p for p in root.glob("*/*") if p.is_dir())
    if args.limit:
        samples = samples[: args.limit]
    if not samples:
        sys.exit(f"No samples under {root}")

    rows = 0
    segments = set()
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["at", "segment", "lat", "lng", "forward", "reverse"])

        for i, sample in enumerate(samples, 1):
            meta_path = sample / "meta.json"
            at = (
                json.loads(meta_path.read_text())["at"]
                if meta_path.exists()
                else sample.name
            )

            for tile_path in sorted(sample.glob("*.pbf*")):
                for segment, lng, lat, fwd, rev in decode_tile(tile_path):
                    writer.writerow([at, segment, lat, lng, fwd, rev])
                    segments.add(segment)
                    rows += 1

            print(f"  [{i}/{len(samples)}] {at}  rows so far {rows:,}", end="\r")

    print()
    print(f"Wrote {rows:,} rows for {len(segments):,} road segments to {args.out}")
    print(f"Samples: {len(samples)}   forward/reverse: 0 flowing, 1 slowing, 2 congested")


if __name__ == "__main__":
    main()
