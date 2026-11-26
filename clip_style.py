"""Clip style layer: an overlay over the whole picture (solid colour,
gradient or image, with opacity), an optional blur of the video under it,
and a logo at one of nine positions.

Rendered as ONE transparent PNG at the video's size (PIL) laid over the
(optionally blurred) video in one ffmpeg pass; audio is copied. The file is
``styled_<ts>_<clean clip>``: it sits UNDER the hook, the captions and the
spoken intro (app.py re-applies those on top), so text stays readable.

The style comes from the user (the editor), and is read back from the
metadata: every number is clamped, colours must be #RRGGBB, names are
whitelisted, and images are files this module stored itself
(``.style_<kind>_<hash>.png`` in the job dir), never a path from the request.

``blur`` is in pixels of a 360-px-wide preview (CSS ``blur()``), scaled to
the video width here so the render matches what the editor showed.
"""
import base64
import hashlib
import io
import os
import re
import subprocess
import time
import uuid

from ffmpeg_utils import METADATA_SCRUB, QUALITY, video_encode_args

PREVIEW_WIDTH = 360.0
OVERLAY_TYPES = ("none", "solid", "gradient", "image")
DIRECTIONS = ("radial", "to_bottom", "to_top", "to_left", "to_right")
POSITIONS = ("top-left", "top-center", "top-right",
             "center-left", "center", "center-right",
             "bottom-left", "bottom-center", "bottom-right")
IMAGE_PREFIX = ".style_"
MAX_IMAGE_BYTES = 10 * 1024 * 1024
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
_NAME = re.compile(r"^\.style_(overlay|logo)_[0-9a-f]{16}\.png$")


def _num(value, lo, hi, default):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:
        return default
    return min(hi, max(lo, v))


def _color(value, default="#000000"):
    return value if isinstance(value, str) and _COLOR.match(value) else default


def _image_name(value):
    return value if isinstance(value, str) and _NAME.match(value) else None


def sanitize(style):
    """A clean copy of ``style`` (dict from the editor or the metadata)."""
    style = style if isinstance(style, dict) else {}
    ov = style.get("overlay") if isinstance(style.get("overlay"), dict) else {}
    lg = style.get("logo") if isinstance(style.get("logo"), dict) else {}
    otype = ov.get("type") if ov.get("type") in OVERLAY_TYPES else "none"
    overlay = {
        "type": otype,
        "color": _color(ov.get("color")),
        "color2": _color(ov.get("color2")),
        "color2_transparent": bool(ov.get("color2_transparent", True)),
        "direction": ov.get("direction") if ov.get("direction") in DIRECTIONS else "to_bottom",
        "image": _image_name(ov.get("image")),
        "opacity": _num(ov.get("opacity"), 0.0, 1.0, 0.5),
    }
    logo = {
        "image": _image_name(lg.get("image")),
        "position": lg.get("position") if lg.get("position") in POSITIONS else "top-right",
        "size": _num(lg.get("size"), 0.03, 0.8, 0.2),
        "opacity": _num(lg.get("opacity"), 0.0, 1.0, 1.0),
        "margin": _num(lg.get("margin"), 0.0, 0.25, 0.04),
    }
    return {"overlay": overlay, "blur": _num(style.get("blur"), 0.0, 40.0, 0.0), "logo": logo}


def is_empty(style):
    s = sanitize(style)
    ov = s["overlay"]
    no_overlay = ov["type"] == "none" or ov["opacity"] <= 0 or (
        ov["type"] == "image" and not ov["image"])
    no_logo = not s["logo"]["image"] or s["logo"]["opacity"] <= 0
    return no_overlay and no_logo and s["blur"] <= 0


def store_image(output_dir, data_url, kind):
    """Decode a data: URL (or bare base64) image, re-encode it as PNG in the
    job dir, return its stored name. Raises ValueError on anything else."""
    from PIL import Image
    if kind not in ("overlay", "logo"):
        raise ValueError("bad image kind")
    if not isinstance(data_url, str) or not data_url:
        raise ValueError("no image")
    payload = data_url.split(",", 1)[1] if data_url.startswith("data:") else data_url
    try:
        raw = base64.b64decode(payload, validate=False)
    except Exception:
        raise ValueError("the image is not valid base64")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("the image is larger than 10 MB")
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception:
        raise ValueError("the file is not an image")
    if img.width * img.height > 40_000_000:
        raise ValueError("the image is too large")
    img = img.convert("RGBA")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    data = buf.getvalue()
    name = f"{IMAGE_PREFIX}{kind}_{hashlib.sha1(data).hexdigest()[:16]}.png"
    path = os.path.join(output_dir, name)
    if not os.path.exists(path):
        tmp = f"{path}.{uuid.uuid4().hex[:8]}.part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    return name


def image_path(output_dir, name):
    name = _image_name(name)
    if not name:
        return None
    path = os.path.join(output_dir, name)
    return path if os.path.exists(path) else None


def _rgb(hex_color):
    return tuple(int(hex_color[i:i + 2], 16) for i in (1, 3, 5))


def _overlay_layer(ov, w, h, output_dir):
    import numpy as np
    from PIL import Image
    alpha = ov["opacity"]
    if ov["type"] == "solid":
        r, g, b = _rgb(ov["color"])
        return Image.new("RGBA", (w, h), (r, g, b, int(round(255 * alpha))))
    if ov["type"] == "gradient":
        c1 = np.array(_rgb(ov["color"]) + (255,), dtype=np.float32)
        if ov["color2_transparent"]:
            # Fade to the same colour at 0 alpha (CSS fades to transparent
            # without a dark fringe when both stops share the colour).
            c2 = np.array(_rgb(ov["color"]) + (0,), dtype=np.float32)
        else:
            c2 = np.array(_rgb(ov["color2"]) + (255,), dtype=np.float32)
        ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
        d = ov["direction"]
        if d == "radial":
            # CSS radial-gradient(ellipse farthest-corner at center).
            t = np.sqrt(((xs + 0.5 - w / 2) / (w / 2)) ** 2 +
                        ((ys + 0.5 - h / 2) / (h / 2)) ** 2) / np.sqrt(2)
        elif d == "to_bottom":
            t = (ys + 0.5) / h
        elif d == "to_top":
            t = 1 - (ys + 0.5) / h
        elif d == "to_right":
            t = (xs + 0.5) / w
        else:  # to_left
            t = 1 - (xs + 0.5) / w
        t = np.clip(t, 0, 1)[..., None]
        px = c1 * (1 - t) + c2 * t
        px[..., 3] *= alpha
        return Image.fromarray(np.clip(px + 0.5, 0, 255).astype(np.uint8), "RGBA")
    if ov["type"] == "image":
        path = image_path(output_dir, ov["image"])
        if not path:
            return None
        src = Image.open(path).convert("RGBA")
        # object-fit: cover
        scale = max(w / src.width, h / src.height)
        sw, sh = max(1, round(src.width * scale)), max(1, round(src.height * scale))
        src = src.resize((sw, sh), Image.LANCZOS)
        left, top = (sw - w) // 2, (sh - h) // 2
        src = src.crop((left, top, left + w, top + h))
        if alpha < 1:
            a = src.getchannel("A").point(lambda v: int(round(v * alpha)))
            src.putalpha(a)
        return src
    return None


def _logo_box(lg, w, h, lw, lh):
    margin = round(lg["margin"] * w)
    vert, _, horiz = lg["position"].partition("-")
    if lg["position"] == "center":
        vert, horiz = "center", "center"
    x = {"left": margin, "center": (w - lw) // 2, "right": w - lw - margin}[horiz]
    y = {"top": margin, "center": (h - lh) // 2, "bottom": h - lh - margin}[vert]
    return x, y


def render_layer(style, w, h, output_dir, out_png):
    """Write the overlay + logo PNG. Returns False when there is nothing to draw."""
    from PIL import Image
    s = sanitize(style)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    drew = False
    if s["overlay"]["type"] != "none" and s["overlay"]["opacity"] > 0:
        layer = _overlay_layer(s["overlay"], w, h, output_dir)
        if layer is not None:
            canvas = Image.alpha_composite(canvas, layer)
            drew = True
    lg = s["logo"]
    path = image_path(output_dir, lg["image"]) if lg["opacity"] > 0 else None
    if path:
        logo = Image.open(path).convert("RGBA")
        lw = max(1, round(lg["size"] * w))
        lh = max(1, round(logo.height * lw / logo.width))
        logo = logo.resize((lw, lh), Image.LANCZOS)
        if lg["opacity"] < 1:
            a = logo.getchannel("A").point(lambda v: int(round(v * lg["opacity"])))
            logo.putalpha(a)
        x, y = _logo_box(lg, w, h, lw, lh)
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        layer.paste(logo, (x, y), logo)
        canvas = Image.alpha_composite(canvas, layer)
        drew = True
    if drew:
        canvas.save(out_png, "PNG")
    return drew


def _video_size(video_path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height", "-of", "csv=s=x:p=0", video_path], timeout=60).decode().strip()
    w, h = out.splitlines()[0].split("x")[:2]
    return int(w), int(h)


def styled_name(filename):
    return f"styled_{int(time.time())}_{filename}"


def apply(video_path, output_path, style, output_dir):
    """Write ``output_path`` = ``video_path`` with the style burned in."""
    s = sanitize(style)
    w, h = _video_size(video_path)
    png = os.path.join(output_dir, f".part_style_{uuid.uuid4().hex[:8]}.png")
    tmp = os.path.join(output_dir, f".part_{uuid.uuid4().hex[:8]}_{os.path.basename(output_path)}")
    try:
        has_layer = render_layer(s, w, h, output_dir, png)
        sigma = s["blur"] * w / PREVIEW_WIDTH
        chain = "[0:v]"
        graph = []
        if sigma > 0:
            graph.append(f"[0:v]gblur=sigma={sigma:.2f}[b]")
            chain = "[b]"
        if has_layer:
            graph.append(f"{chain}[1:v]overlay=0:0:format=auto:shortest=1[v]")
        else:
            graph.append(f"{chain}null[v]")
        cmd = ["ffmpeg", "-y", "-i", video_path]
        if has_layer:
            cmd += ["-loop", "1", "-i", png]
        cmd += ["-filter_complex", ";".join(graph), "-map", "[v]", "-map", "0:a?",
                "-c:a", "copy", "-shortest", *video_encode_args(QUALITY), *METADATA_SCRUB,
                "-movflags", "+faststart", tmp]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1800)
        if res.returncode != 0:
            tail = res.stderr.decode(errors="replace").strip().splitlines()[-3:]
            raise RuntimeError(f"ffmpeg style render failed: {' | '.join(tail)}")
        os.replace(tmp, output_path)
    finally:
        for p in (png, tmp):
            if os.path.exists(p):
                os.remove(p)
    return s
