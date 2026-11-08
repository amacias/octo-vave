"""Draw packaging/octo.ico (the app and shortcut icon) from docs/img/octo.svg.

    python packaging/make_icon.py

Needs Pillow. Only the SVG's own shapes are used: one path (M/L/H/V/C/S/Z, absolute and
relative) and circles. Run it again only if the octopus changes; the .ico is committed.
"""
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SVG = (ROOT / "docs" / "img" / "octo.svg").read_text(encoding="utf-8")
SIZE = 1024  # drawn large, then scaled down for each icon size


def path_points(d, steps=24):
    toks = re.findall(r"[MmLlHhVvCcSsZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?", d)
    pts, i, cmd = [], 0, None
    x = y = 0.0
    last_ctrl = None
    def num():
        nonlocal i
        i += 1
        return float(toks[i - 1])
    def cubic(p0, p1, p2, p3):
        for k in range(1, steps + 1):
            t = k / steps; u = 1 - t
            pts.append((u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                        u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]))
    while i < len(toks):
        if re.match(r"[A-Za-z]", toks[i]):
            cmd = toks[i]; i += 1
        rel = cmd.islower(); c = cmd.upper()
        ox, oy = (x, y) if rel else (0.0, 0.0)
        if c == "M":
            x, y = ox + num(), oy + num(); pts.append((x, y)); cmd = "l" if rel else "L"; last_ctrl = None
        elif c == "L":
            x, y = ox + num(), oy + num(); pts.append((x, y)); last_ctrl = None
        elif c == "H":
            x = ox + num(); pts.append((x, y)); last_ctrl = None
        elif c == "V":
            y = (y if rel else 0.0) + num(); pts.append((x, y)); last_ctrl = None
        elif c == "C":
            p1 = (ox + num(), oy + num()); p2 = (ox + num(), oy + num()); p3 = (ox + num(), oy + num())
            cubic((x, y), p1, p2, p3); last_ctrl = p2; x, y = p3
        elif c == "S":
            p1 = (2 * x - last_ctrl[0], 2 * y - last_ctrl[1]) if last_ctrl else (x, y)
            p2 = (ox + num(), oy + num()); p3 = (ox + num(), oy + num())
            cubic((x, y), p1, p2, p3); last_ctrl = p2; x, y = p3
        elif c == "Z":
            last_ctrl = None
        else:
            sys.exit(f"unsupported path command {cmd}")
    return pts


def main():
    vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', SVG).group(1).split()]
    side = max(vb[2], vb[3])
    pad_x, pad_y = (side - vb[2]) / 2, (side - vb[3]) / 2  # centre the octopus in a square
    k = SIZE / side
    tx = lambda p: ((p[0] - vb[0] + pad_x) * k, (p[1] - vb[1] + pad_y) * k)
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    for fill, d in re.findall(r'<path[^>]*fill="([^"]+)"[^>]*d="([^"]+)"', SVG):
        dr.polygon([tx(p) for p in path_points(d)], fill=fill)
    for cx, cy, r, fill in re.findall(r'<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="([^"]+)"', SVG):
        (x0, y0), rr = tx((float(cx), float(cy))), float(r) * k
        dr.ellipse((x0 - rr, y0 - rr, x0 + rr, y0 + rr), fill=fill)
    out = Path(__file__).resolve().parent / "octo.ico"
    img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", out.relative_to(ROOT))


if __name__ == "__main__":
    main()
