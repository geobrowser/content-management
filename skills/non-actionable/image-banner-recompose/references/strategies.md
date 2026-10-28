# Strategy Implementations

Full Python code for each recomposition strategy + the auto-selector. Read the section for your
chosen strategy. All output is exactly 2364 × 640 px. The focal cover always gets an unsharp
finishing pass, so place it via the helpers here (do not paste a raw resize).

## Contents
- Auto-selector (`choose_strategy`, `edge_std`)
- Strategy A — Solid edge extend
- Strategy B — Blurred backdrop
- Smart crop (wide sources)
- Outpainting (fal.ai / Replicate)
- Verify output + low-resolution guard

```python
from PIL import Image, ImageFilter
import numpy as np

TARGET_W, TARGET_H = 2364, 640

def sharp_cover(img, sw):
    """Scale the source to the banner height and apply an unsharp finishing pass."""
    return np.array(
        img.resize((sw, TARGET_H), Image.LANCZOS)
           .filter(ImageFilter.UnsharpMask(radius=2, percent=160, threshold=2)),
        dtype=float)
```

---

## Auto-selector — which strategy to use

```python
def edge_std(img, frac=0.06):
    """Mean per-channel std of the LEFT and RIGHT edge strips (what we extend into).
    Low (~< 18) => near-solid side background => solid-extend (A) looks seamless.
    High => busy/photographic edges => blurred backdrop (B) looks better."""
    a = np.array(img.convert("RGB"), dtype=float)
    h, w, _ = a.shape
    bx = max(2, int(w * frac))
    left  = a[:, :bx].reshape(-1, 3)
    right = a[:, -bx:].reshape(-1, 3)
    return max(float(left.std(axis=0).mean()), float(right.std(axis=0).mean()))

SOLID_THRESHOLD = 18  # edge_std below this => treat the background as solid

def choose_strategy(img, has_api):
    """Return one of: 'outpaint' | 'smart_crop' | 'solid_extend' | 'backdrop'."""
    ow, oh = img.size
    ratio = ow / oh
    if ratio >= 3.0:
        return "smart_crop"          # already wide -> reframe, no fill needed
    if has_api:
        return "outpaint"            # best fill quality when an API key is available
    if edge_std(img) < SOLID_THRESHOLD:
        return "solid_extend"        # A: solid side background
    return "blurred_backdrop"        # B: busy/photographic
```

Tell the user the chosen strategy and the `edge_std` value in one line, and honor an override
("force solid", "force backdrop", "force outpaint").

---

## Strategy A — Solid edge extend (no API; solid-background covers)

Fills the sides with the cover's own edge colour and feathers the join. Best for covers whose
left/right edges are a flat colour (the fill reads as a seamless extension). Text is never cropped.

```python
def solid_extend(input_path, output_path, feather=44):
    img = Image.open(input_path).convert("RGB")
    ow, oh = img.size
    sw = int(ow * (TARGET_H / oh))
    x = (TARGET_W - sw) // 2
    cover = sharp_cover(img, sw)
    lc = cover[:, :5, :].mean(axis=(0, 1))
    rc = cover[:, -5:, :].mean(axis=(0, 1))
    c = np.zeros((TARGET_H, TARGET_W, 3), dtype=float)
    c[:, :x, :] = lc
    c[:, x + sw:, :] = rc
    c[:, x:x + sw, :] = cover
    for i in range(feather):
        a = i / feather
        if 0 <= x + i < TARGET_W:
            c[:, x + i, :] = lc * (1 - a) + cover[:, i, :] * a
        xr = x + sw - feather + i
        if 0 <= xr < TARGET_W:
            a2 = 1 - i / feather
            c[:, xr, :] = rc * (1 - a2) + cover[:, sw - feather + i, :] * a2
    Image.fromarray(np.clip(c, 0, 255).astype("uint8")).save(output_path)
    return x, sw   # pass to QA as x_offset, scaled_w
```

---

## Strategy B — Blurred backdrop (no API; busy / photographic covers)

Places a full-bleed, heavily-blurred copy of the cover behind the sharp cover. The backdrop uses
the cover's whole palette, so it reads as designed (not flat bars). Best for photos, paintings,
and busy covers.

```python
def blurred_backdrop(input_path, output_path, feather=36):
    img = Image.open(input_path).convert("RGB")
    ow, oh = img.size
    sw = int(ow * (TARGET_H / oh))
    x = (TARGET_W - sw) // 2
    cover = sharp_cover(img, sw)
    s2 = max(TARGET_W / ow, TARGET_H / oh)
    bw, bh = int(ow * s2), int(oh * s2)
    bg = img.resize((bw, bh), Image.LANCZOS)
    l, t = (bw - TARGET_W) // 2, (bh - TARGET_H) // 2
    bga = np.array(
        bg.crop((l, t, l + TARGET_W, t + TARGET_H)).filter(ImageFilter.GaussianBlur(radius=60)),
        dtype=float)
    c = bga.copy()
    c[:, x:x + sw, :] = cover
    for i in range(feather):
        a = i / feather
        if 0 <= x + i < TARGET_W:
            c[:, x + i, :] = bga[:, x + i, :] * (1 - a) + cover[:, i, :] * a
        xr = x + sw - feather + i
        if 0 <= xr < TARGET_W:
            a2 = 1 - i / feather
            c[:, xr, :] = bga[:, xr, :] * (1 - a2) + cover[:, sw - feather + i, :] * a2
    Image.fromarray(np.clip(c, 0, 255).astype("uint8")).save(output_path)
    return x, sw
```

---

## Strategy: Smart crop (wide / landscape sources)

For sources already wider than ~3:1. Scale to height 640 then slide a 2364-wide window to the
highest-entropy region. No fill needed.

```python
def smart_crop(input_path, output_path):
    img = Image.open(input_path).convert("RGB")
    ow, oh = img.size
    sw = int(ow * (TARGET_H / oh))
    img_r = img.resize((sw, TARGET_H), Image.LANCZOS)
    if sw <= TARGET_W:                      # not actually wide enough -> backdrop instead
        return blurred_backdrop(input_path, output_path)
    gray = np.array(img_r.convert("L"))
    def entropy(x):
        hist, _ = np.histogram(gray[:, x:x + TARGET_W], bins=256, range=(0, 256))
        p = hist / hist.sum(); p = p[p > 0]
        return -np.sum(p * np.log2(p))
    step = max(1, (sw - TARGET_W) // 20)
    best_x = max(range(0, sw - TARGET_W + 1, step), key=entropy)
    img_r.crop((best_x, 0, best_x + TARGET_W, TARGET_H)).save(output_path)
    return 0, TARGET_W                      # full-frame, no fill zones
```

---

## Strategy: Outpainting (when FAL_KEY or REPLICATE_API_TOKEN is set — best quality)

Place the sharp cover centred on the canvas, mask the empty sides, and let the model fill them
coherently from the cover's scene. See `references/api_endpoints.md` for auth + endpoint details.

```python
def outpaint(input_path, output_path, scene_description="", provider="fal"):
    import base64, io, os, urllib.request
    from PIL import ImageDraw
    img = Image.open(input_path).convert("RGB")
    ow, oh = img.size
    sw = int(ow * (TARGET_H / oh))
    x = (TARGET_W - sw) // 2
    canvas = Image.new("RGB", (TARGET_W, TARGET_H), (0, 0, 0))
    canvas.paste(img.resize((sw, TARGET_H), Image.LANCZOS), (x, 0))
    mask = Image.new("L", (TARGET_W, TARGET_H), 255)
    ImageDraw.Draw(mask).rectangle([x, 0, x + sw, TARGET_H], fill=0)   # keep cover, fill sides
    def b64(im):
        buf = io.BytesIO(); im.save(buf, "PNG"); return base64.b64encode(buf.getvalue()).decode()
    prompt = (f"Extend this image naturally. {scene_description} Seamlessly match the original's "
              "colour palette, lighting and mood.")
    if provider == "fal":
        import fal_client
        res = fal_client.submit("fal-ai/bria/eraser/outpainting", arguments={
            "image_url": f"data:image/png;base64,{b64(canvas)}",
            "mask_url": f"data:image/png;base64,{b64(mask)}", "prompt": prompt}).get()
        urllib.request.urlretrieve(res["image"]["url"], output_path)
    else:
        import replicate
        out = replicate.run("stability-ai/stable-diffusion-inpainting", input={
            "prompt": prompt, "image": f"data:image/png;base64,{b64(canvas)}",
            "mask": f"data:image/png;base64,{b64(mask)}",
            "num_inference_steps": 50, "guidance_scale": 7.5})
        urllib.request.urlretrieve(out[0] if isinstance(out, list) else out, output_path)
    o = Image.open(output_path)
    if o.size != (TARGET_W, TARGET_H):
        o.resize((TARGET_W, TARGET_H), Image.LANCZOS).save(output_path)
    return x, sw
```

---

## Verify output (always run after saving)

```python
img = Image.open(output_path)
assert img.size == (2364, 640), f"Wrong dimensions: {img.size}"
print(f"✓ Verified: {img.size}")
```

## Low-resolution guard

```python
def warn_if_lowres(input_path, min_h=500):
    h = Image.open(input_path).size[1]
    if h < min_h:
        print(f"⚠️ Source is only {h}px tall — the centred cover will be upscaled and may look soft. "
              "For a crisp result, use a source ≥ 500px tall (or AI-upscale it first).")
        return True
    return False
```
