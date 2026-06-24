---
name: image-banner-recompose
description: >
  Intelligently recomposes any uploaded image into a 2364 × 640 px banner. Use this skill
  whenever a user uploads an image and wants a banner, header, or wide-format version of it —
  even if they don't use the word "banner". Triggers on: "make a banner from this", "adapt to
  2364x640", "I need a header image", "turn this photo into a banner", "make a wide version",
  "convert this book cover to a banner", or any combination of an uploaded image + a request
  for a wide/panoramic/header format. This skill does NOT simply resize — it analyzes the image
  with Claude Vision and recomposes it intelligently: smart crop, outpainting, blurred backdrop,
  or solid edge extend depending on the image and available tools. Always use when the target
  output is 2364×640 px.
compatibility: >
  Requires Python with Pillow and numpy. Optional FAL_KEY or REPLICATE_API_TOKEN for AI
  outpainting (best fill quality on busy/photographic covers). Uses the present_files tool and
  the claude.ai / Cowork paths /mnt/user-data/uploads, /mnt/user-data/outputs, /home/claude.
metadata:
  author: armando
  version: "0.2.0"
---

# image-banner-recompose

Produces a high-quality **2364 × 640 px banner** from any uploaded image by intelligently
recomposing — not mechanically resizing. The output should look intentional and designed.
The skill **picks the right strategy per image** and always finishes the focal subject with an
unsharp pass so it stays crisp.

---

## Step-by-step workflow

### Step 1 — Find the image
Check `/mnt/user-data/uploads/` for the uploaded image. If none, ask the user to upload one.
Supported: JPEG, PNG, WEBP, BMP, TIFF.

### Step 2 — Analyze with Vision
Examine the image and report (5–8 lines): main subject(s), focal point, aspect ratio (w÷h vs the
target 3.69:1), background type (solid / gradient / scene / transparent), dominant colours, mood,
and **all text regions** (titles, author names, logos) — flag these as protected zones.

### Step 3 — Check API keys + source resolution
```bash
echo "FAL_KEY=${FAL_KEY:-NOT_SET}"; echo "REPLICATE_API_TOKEN=${REPLICATE_API_TOKEN:-NOT_SET}"
```
Then run `warn_if_lowres()` from `references/strategies.md`. If the source is under ~500px tall,
tell the user the centred subject will be upscaled and may look soft, and suggest a larger source
(or AI-upscaling it first) before proceeding.

### Step 4 — Auto-select the strategy
Use `choose_strategy(img, has_api)` from `references/strategies.md`. It returns one of:

| Strategy | When | Fill |
|---|---|---|
| `smart_crop`      | source already wide (~≥3:1) | none — reframe to the most salient region |
| `outpaint`        | FAL_KEY or REPLICATE_API_TOKEN set | AI-generated, matches the scene (best) |
| `solid_extend` (A)| no API + **solid** side edges (`edge_std` < 18) | the cover's edge colour, feathered |
| `blurred_backdrop` (B)| no API + **busy/photographic** edges | full-bleed blurred copy of the cover |

State the chosen strategy and the `edge_std` value in one sentence. Honor an override
("force backdrop", "force solid", "force outpaint"). For **text-bearing covers**, never crop into
text and never let outpaint fill begin inside a text box (keep ≥40px margin).

### Step 5 — Install deps + execute
```bash
pip install Pillow numpy --break-system-packages -q
# only if outpainting:
pip install fal-client --break-system-packages -q   # or: pip install replicate ...
```
Write Python to `/home/claude/`, import the chosen function from `references/strategies.md`, run it.
Each strategy returns `(x_offset, scaled_w)` — keep these for QA.

### Step 6 — Verify dimensions
Open with Pillow and assert `img.size == (2364, 640)`; correct + re-run if not.

### Step 6a — QA (mandatory, strategy-aware)
Run `run_qa(output, source, x_offset, scaled_w, mode=...)` from `references/qa_check.md`.
**Pass `mode="whole"` for `blurred_backdrop`, `mode="edge"` for `solid_extend` / `outpaint`** (this
is what makes the colour + brightness checks consistent — see the note in that file).
- **All pass** → print a one-line green light, go to Step 7.
- **Any fail** → print the report + a plain-language description, ask the user *"apply automatic
  corrections and regenerate, or deliver as-is?"*, wait, then `apply_fixes(...)` and re-run QA.

### Step 7 — Save + present
Save to `/mnt/user-data/outputs/banner_<original_filename>.png` and call `present_files`.

### Step 8 — Summary
Report: strategy chosen (and why), QA result, whether text was preserved, confirmed dimensions,
and a low-res note if it applied.

---

## Quality constraints (non-negotiable)
- Main subject fully visible, never distorted (no non-uniform scaling).
- All source text legible and unobscured in the output.
- No hard seams or colour discontinuities at the fill boundaries.
- Output exactly 2364 × 640 px (verified programmatically).
- Focal subject sharp (unsharp finishing pass applied; never blurred).

---

## Error handling

| Error | Action |
|---|---|
| No image in uploads | Ask the user to upload |
| Unreadable format | Suggest re-saving as PNG/JPEG |
| Source < 500px tall | Warn (soft result); offer to proceed or get a larger source |
| API timeout / error | Fall back to `solid_extend` or `blurred_backdrop`, inform the user |
| Wrong output dimensions | Re-run with explicit resize + crop |

---

## Reference files
- `references/strategies.md` — auto-selector + all strategy code (+ sharpening, low-res guard)
- `references/qa_check.md` — strategy-aware QA pipeline + corrections
- `references/api_endpoints.md` — fal.ai / Replicate endpoint + auth reference
