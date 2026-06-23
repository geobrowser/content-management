# API Endpoints Reference

## fal.ai

**Auth**: Set `FAL_KEY` environment variable. Install: `pip install fal-client --break-system-packages`

```python
import fal_client
os.environ["FAL_KEY"] = "your-key"  # or export FAL_KEY=... in shell
```

| Use case               | Endpoint                              | Key input params                                           |
|------------------------|---------------------------------------|------------------------------------------------------------|
| Outpainting            | `fal-ai/bria/eraser/outpainting`      | `image_url`, `mask_url`, `prompt`                         |
| Image-to-image extend  | `fal-ai/flux/dev/image-to-image`      | `image_url`, `prompt`, `strength` (0.3–0.6 for extension) |
| Background replacement | `fal-ai/bria/background/replace`      | `image_url`, `prompt` (describes new background)          |

**Pattern:**
```python
result = fal_client.submit("fal-ai/bria/eraser/outpainting", arguments={...}).get()
image_url = result["image"]["url"]
```

**Notes:**
- Images must be passed as `data:image/png;base64,...` URLs or public HTTPS URLs
- Mask: white (255) = fill this area, black (0) = keep original
- For outpainting: keep the original content in the base image, mask only the extension areas
- Response time: ~10–30 seconds typical

---

## Replicate

**Auth**: Set `REPLICATE_API_TOKEN` environment variable. Install: `pip install replicate --break-system-packages`

| Use case               | Model slug                                    | Key input params                                     |
|------------------------|-----------------------------------------------|------------------------------------------------------|
| Outpainting/inpainting | `stability-ai/stable-diffusion-inpainting`    | `prompt`, `image`, `mask`, `num_inference_steps`     |
| Background removal     | `cjwbw/rembg`                                 | `image` (returns image with transparent background)  |

**Pattern:**
```python
import replicate
output = replicate.run("stability-ai/stable-diffusion-inpainting", input={
    "prompt": "...",
    "image": "data:image/png;base64,...",
    "mask": "data:image/png;base64,...",
    "num_inference_steps": 50,
    "guidance_scale": 7.5,
})
result_url = output[0]
```

**Notes:**
- Mask convention is the same as fal.ai (white = fill)
- For best results: guidance_scale 7–10, steps 40–60
- May need to resize output to exactly 2364×640 after generation

---

## Fallback priority

1. `FAL_KEY` set → use fal.ai (`fal-ai/bria/eraser/outpainting`)
2. `REPLICATE_API_TOKEN` set → use Replicate (`stability-ai/stable-diffusion-inpainting`)
3. Neither → use Pillow-only strategy from `strategies.md` Strategy D

Never tell the user "outpainting is not available" — always have a fallback ready.
