# QA Pipeline (strategy-aware)

Run after every recomposition, before delivering. Five checks compare the output against the
source. **Pass `mode` to match the strategy** — this is the fix for the old contradiction where
`color_match` and `brightness` referenced different things and could never both pass:

| Strategy | `mode` | Fill is compared against |
|---|---|---|
| `solid_extend` (A), `outpaint` | `"edge"`  | the cover's **edge** colours/brightness (the fill continues the edge) |
| `blurred_backdrop` (B)         | `"whole"` | the **whole cover** (the backdrop is derived from the whole image) |
| `smart_crop`                   | —         | no fill zones; checks are skipped/auto-pass |

## Contents
- Full QA runner (`run_qa`, strategy-aware)
- Corrections (`fix_seam`, `fix_brightness`, `apply_fixes`)
- Thresholds

---

## Full QA runner

```python
from PIL import Image, ImageFilter, ImageEnhance
import numpy as np

TARGET_W, TARGET_H = 2364, 640

def run_qa(output_path, source_path, x_offset, scaled_w, mode="edge"):
    banner = Image.open(output_path).convert("RGB")
    source = Image.open(source_path).convert("RGB")
    banner_arr = np.array(banner, dtype=float)
    src_scale = TARGET_H / source.size[1]
    src_w = int(source.size[0] * src_scale)
    source_scaled = source.resize((src_w, TARGET_H), Image.LANCZOS)
    src_arr = np.array(source_scaled, dtype=float)
    right_edge = x_offset + scaled_w
    fill_zones = []
    if x_offset > 10: fill_zones.append((0, x_offset))
    if right_edge < TARGET_W - 10: fill_zones.append((right_edge, TARGET_W))
    results = {}

    def mean_color(arr, x1, x2): return arr[:, x1:x2, :].mean(axis=(0, 1))
    def lum(arr, x1, x2):
        r = arr[:, x1:x2, :]
        return (0.299*r[:,:,0] + 0.587*r[:,:,1] + 0.114*r[:,:,2])

    # ── 1. Seam ───────────────────────────────────────────────
    g = np.array(banner.convert("L"), dtype=float)
    seam_xs = ([x_offset] if x_offset > 2 else []) + ([right_edge] if right_edge < TARGET_W-2 else [])
    max_seam = max([np.abs(g[:, max(0,sx-3):sx].mean(1) - g[:, sx:min(TARGET_W,sx+3)].mean(1)).mean()
                    for sx in seam_xs], default=0.0)
    results["seam"] = {"passed": max_seam < 40, "value": round(float(max_seam),2), "threshold": 40,
        "message": (f"✓ No visible seam ({max_seam:.1f})" if max_seam < 40
                    else f"✗ Hard seam (delta={max_seam:.1f} > 40)")}

    # ── 2. Color match — only meaningful when foreign fill is added (edge / outpaint).
    #     For a blurred backdrop the fill IS the cover (intentionally varied), so it's n/a.
    if mode == "whole":
        results["color_match"] = {"passed": True, "value": 0.0, "threshold": 25,
            "message": "✓ Colour n/a (backdrop is derived from the cover)"}
    else:
        ref_left  = mean_color(src_arr, 0, min(10, src_w))
        ref_right = mean_color(src_arr, max(0, src_w-10), src_w)
        de = 0.0
        if x_offset > 0:
            de = max(de, np.sqrt(((mean_color(banner_arr, 0, x_offset) - ref_left)**2).sum()))
        if right_edge < TARGET_W:
            de = max(de, np.sqrt(((mean_color(banner_arr, right_edge, TARGET_W) - ref_right)**2).sum()))
        results["color_match"] = {"passed": de < 25, "value": round(float(de),2), "threshold": 25,
            "message": (f"✓ Fill colour matches ({de:.1f})" if de < 25 else f"✗ Colour mismatch (ΔE={de:.1f} > 25)")}

    # ── 3. Artifacts / noise ──────────────────────────────────
    def lvar(arr, x1, x2):
        reg = arr[:, x1:x2, :]; h,w,_ = reg.shape
        if w < 8 or h < 8: return reg.std()**2
        bh, bw = h//8, w//8
        return np.mean([reg[by*bh:(by+1)*bh, bx*bw:(bx+1)*bw].std()**2 for by in range(8) for bx in range(8)])
    src_var = lvar(src_arr, 0, src_w) + 1e-6
    fill_var = max([lvar(banner_arr, z[0], z[1]) for z in fill_zones], default=0)
    ratio = fill_var / src_var if fill_zones else 0
    results["artifacts"] = {"passed": ratio < 2.5, "value": round(float(ratio),2), "threshold": 2.5,
        "message": (f"✓ Fill clean ({ratio:.2f}×)" if ratio < 2.5 else f"✗ Artifacts ({ratio:.2f}× > 2.5)")}

    # ── 4. Brightness — like colour, n/a for a blurred backdrop (fill is the cover) ──
    if mode == "whole":
        results["brightness"] = {"passed": True, "value": 0.0, "threshold": 15,
            "message": "✓ Brightness n/a (backdrop is derived from the cover)"}
    else:  # edge: reference the cover's edge strips (consistent with color_match)
        el = np.concatenate([lum(src_arr, 0, min(10, src_w)).ravel(),
                             lum(src_arr, max(0, src_w-10), src_w).ravel()])
        ref_lum_mean, ref_lum_std = el.mean(), el.std()
        max_ld = 0
        for z in fill_zones:
            fl = lum(banner_arr, z[0], z[1])
            max_ld = max(max_ld, abs(fl.mean() - ref_lum_mean), abs(fl.std() - ref_lum_std))
        results["brightness"] = {"passed": max_ld < 15 or not fill_zones, "value": round(float(max_ld),2),
            "threshold": 15, "message": (f"✓ Brightness consistent ({max_ld:.1f})" if max_ld < 15 or not fill_zones
                        else f"✗ Brightness mismatch ({max_ld:.1f} > 15)")}

    # ── 5. Sharpness (subject vs source) ──────────────────────
    def sharp(pil, x1, x2):
        return np.array(pil.crop((x1,0,x2,TARGET_H)).convert("L").filter(ImageFilter.FIND_EDGES), dtype=float).var()
    ssrc = sharp(source_scaled, 0, src_w) + 1e-6
    sratio = sharp(banner, x_offset, min(x_offset+scaled_w, TARGET_W)) / ssrc
    results["sharpness"] = {"passed": sratio >= 0.80, "value": round(float(sratio),3), "threshold": 0.80,
        "message": (f"✓ Sharpness retained ({sratio*100:.0f}%)" if sratio >= 0.80
                    else f"✗ Subject blurred ({sratio*100:.0f}% < 80%)")}
    return results


def print_qa_report(results):
    passed = all(r["passed"] for r in results.values())
    print("\n── QA Report ─────────────────────────────────")
    for r in results.values(): print(f"  {r['message']}")
    print("──────────────────────────────────────────────")
    if passed: print("  ✅ All checks passed.\n")
    else: print(f"  ⚠️  Issues: {', '.join(k for k,r in results.items() if not r['passed'])}\n")
    return passed
```

---

## Corrections

Apply only the fixes for checks that failed, then re-run QA. With the strategy-aware `mode`, the
A and B strategies normally pass without corrections; these remain as a safety net.

```python
def fix_seam(banner_path, x_offset, scaled_w, blend=80):
    b = np.array(Image.open(banner_path).convert("RGB"), dtype=float)
    for seam, d in [(x_offset, "L"), (x_offset+scaled_w, "R")]:
        for i in range(blend):
            t = i/blend
            x = (seam-blend+i) if d=="L" else (seam+i)
            if 0 <= x < TARGET_W:
                edge = b[:, seam if d=="L" else min(seam, TARGET_W-1), :]
                b[:, x, :] = (b[:, x, :]*(1-t) + edge*t) if d=="L" else (edge*(1-t) + b[:, x, :]*t)
    Image.fromarray(np.clip(b,0,255).astype("uint8")).save(banner_path)

def fix_brightness(banner_path, source_path, x_offset, scaled_w, mode="edge"):
    banner = Image.open(banner_path).convert("RGB")
    src = Image.open(source_path).convert("RGB")
    ssw = int(src.size[0]*(TARGET_H/src.size[1]))
    ss = np.array(src.resize((ssw, TARGET_H), Image.LANCZOS), dtype=float)
    def L(a, x1, x2): r=a[:,x1:x2,:]; return (0.299*r[:,:,0]+0.587*r[:,:,1]+0.114*r[:,:,2]).mean()
    ref = L(ss, 0, ssw) if mode=="whole" else (L(ss,0,min(10,ssw))+L(ss,max(0,ssw-10),ssw))/2
    re = x_offset+scaled_w
    for x1, x2 in [(0, x_offset), (re, TARGET_W)]:
        if x2-x1 < 5: continue
        crop = banner.crop((x1,0,x2,TARGET_H))
        fl = np.array(crop, dtype=float); fl_l = (0.299*fl[:,:,0]+0.587*fl[:,:,1]+0.114*fl[:,:,2]).mean()
        if fl_l < 1: continue
        f = max(0.6, min(1.6, ref/fl_l))
        banner.paste(ImageEnhance.Brightness(crop).enhance(f), (x1, 0))
    banner.save(banner_path)

def apply_fixes(banner_path, source_path, x_offset, scaled_w, failed, mode="edge"):
    if "seam" in failed: fix_seam(banner_path, x_offset, scaled_w)
    if "brightness" in failed: fix_brightness(banner_path, source_path, x_offset, scaled_w, mode)
    print("Fixes applied. Re-running QA...")
```

---

## Thresholds

| Check | Pass if | Reference (edge mode / whole mode) |
|---|---|---|
| Seam | max delta < 40 | join boundaries |
| Color match | ΔE < 25 | cover edge / whole cover |
| Artifacts | ratio < 2.5× | source content |
| Brightness | delta < 15 | cover edge / whole cover |
| Sharpness | ≥ 0.80 | subject vs source |
