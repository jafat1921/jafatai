---
title: Photo Studio models for ComfyUI
status: Ready to run
created: 2026-10-09
script: scripts/install-photo-models.sh
---

# Photo Studio models (restoration and editing)

What `scripts/install-photo-models.sh` puts on the ComfyUI server, where each file comes from, its licence,
and how to check it landed. Every URL was checked on 2026-10-09: HTTP 200 and the exact byte size below.
Hugging Face files also have their published sha256 checked after download.

Server layout assumed (override with `COMFY_ROOT` / `COMFY_VENV`): ComfyUI in `/data/apps/ComfyUI`,
venv `/data/venvs/comfy`, services `comfyui.service` (GPU 0, :8188) and `comfyui-gpu1.service` (GPU 1, :8189).
Needs ComfyUI 0.38+ (the background removal, SAM3, SUPIR and MediaPipe nodes are core there).

## Run it

```bash
cd /data/apps/mixaicinemastudio && git pull
./scripts/install-photo-models.sh --all --dry-run   # plan + disk check, changes nothing
./scripts/install-photo-models.sh                   # core (default)
./scripts/install-photo-models.sh --supir           # set B
./scripts/install-photo-models.sh --extras          # set C
./scripts/install-photo-models.sh --all             # A + B + C
./scripts/install-photo-models.sh --uninstall-list  # prints rm lines, deletes nothing
```

Other flags: `--codeformer` (opt-in, non-commercial), `--no-restart`. Run as `gpu`, not root; it calls
`sudo systemctl restart` for every `comfyui*` unit it finds, waits for `/system_stats`, then prints OK / MISSING
for each node (`/object_info/<Class>`) and model (`/models/<folder>`) on every port.

It stops before downloading if free space is below *still-to-download + 10 GB*. `HF_TOKEN` is sent to
huggingface.co if set, but none of these repos is gated today (SDXL base included), so it isn't needed.

## A) Core, ~5.46 GB (5.08 GiB)

| Item | Purpose | Source | Licence | Size (bytes) | Saved as |
|---|---|---|---|---|---|
| BiRefNet | background removal (core `LoadBackgroundRemovalModel` / `RemoveBackground`) | https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors | MIT | 444,473,596 | `models/background_removal/birefnet.safetensors` |
| facerestore_cf | custom node: `FaceRestoreModelLoader`, `FaceRestoreCFWithModel`, `CropFace` | https://github.com/mav-rik/facerestore_cf | no licence file in repo (vendored BasicSR/facelib code) | git | `custom_nodes/facerestore_cf` |
| GFPGAN v1.4 | face restoration | https://github.com/TencentARC/GFPGAN/releases/download/v1.3.4/GFPGANv1.4.pth | Apache-2.0 (repo LICENSE lists StyleGAN2 / DFDNet parts under NVIDIA and CC BY-NC-SA terms; get legal sign-off before relying on it commercially) | 348,632,874 | `models/facerestore_models/GFPGANv1.4.pth` |
| ComfyUI-DDColor | custom node: `DDColor_Colorize` | https://github.com/kijai/ComfyUI-DDColor | Apache-2.0 | git | `custom_nodes/ComfyUI-DDColor` |
| DDColor modelscope | colourisation (natural) | https://huggingface.co/piddnad/DDColor-models/resolve/main/ddcolor_modelscope.pth | Apache-2.0 | 911,950,059 | `custom_nodes/ComfyUI-DDColor/checkpoints/ddcolor_modelscope.pth` |
| DDColor artistic | colourisation (vivid) | https://huggingface.co/piddnad/DDColor-models/resolve/main/ddcolor_artistic.pth | Apache-2.0 | 911,950,059 | `custom_nodes/ComfyUI-DDColor/checkpoints/ddcolor_artistic.pth` |
| SAM 3.1 | text/point/box masks (core `SAM3_*`; load it with *Load Checkpoint*) | https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors | SAM License (Meta; commercial use allowed, with Meta's terms) | 1,745,546,848 | `models/checkpoints/sam3.1_multiplex_fp16.safetensors` |
| FBCNN colour | 1x JPEG artefact removal (blind quality) | https://github.com/jiaxi-jiang/FBCNN/releases/download/v1.0/fbcnn_color.pth | Apache-2.0 | 287,755,111 | `models/upscale_models/1x_fbcnn_color.pth` |
| NAFNet SIDD w64 | 1x denoise | https://huggingface.co/mikestealth/nafnet-models/resolve/main/NAFNet-SIDD-width64.pth | MIT (megvii-research/NAFNet) | 464,154,961 | `models/upscale_models/1x_NAFNet-SIDD-width64.pth` |
| NAFNet GoPro w64 | 1x motion deblur | https://huggingface.co/mikestealth/nafnet-models/resolve/main/NAFNet-GoPro-width64.pth | MIT | 271,778,961 | `models/upscale_models/1x_NAFNet-GoPro-width64.pth` |
| SCUNet real PSNR | 1x real-world denoise (faithful, not GAN) | https://github.com/cszn/KAIR/releases/download/v1.0/scunet_color_real_psnr.pth | Apache-2.0 (SCUNet) / MIT (KAIR) | 71,982,841 | `models/upscale_models/1x_scunet_color_real_psnr.pth` |

Notes
- The 1x models load through the normal *Load Upscale Model* node (spandrel; FBCNN, NAFNet, SCUNet are in
  spandrel's core registry). They're renamed with a `1x_` prefix so they don't get mixed up with the 4x upscalers.
- NAFNet's official weights are on Google Drive only. The mirror used backs the `nafnetlib` PyPI package;
  names and sizes match the official Drive files (443M / 259M) and a second independent mirror
  (`nyanko7/nafnet-models`) has identical sha256s. ComfyUI loads `.pth` upscale models with `weights_only`.
- facerestore_cf downloads its face detector and face parser on first use into `models/facedetection`
  (`detection_Resnet50_Final.pth` from xinntao/facexlib, `parsing_parsenet.pth` from sczhou/CodeFormer
  releases, ~195 MB together, both URLs checked). The first face restore after install is slower because of that.
- DDColor's node would also download on first use, from the same Hugging Face repo; pre-fetching means the
  first job doesn't stall. `ddcolor_paper.pth` / `ddcolor_paper_tiny.pth` still download on demand if picked.
- Node requirements go into the ComfyUI venv only, with `torch`, `torchvision`, `numpy` pinned to what's
  installed; `opencv-python` is skipped when `cv2` already imports, and `tb-nightly` (training logger only) is skipped.

## B) SUPIR, ~9.60 GB (8.94 GiB)

| Item | Purpose | Source | Licence | Size (bytes) | Saved as |
|---|---|---|---|---|---|
| SUPIR v0Q fp16 | diffusion restoration (core `SUPIRApply`, loaded via *Load Model Patch*) | https://huggingface.co/Kijai/SUPIR_pruned/resolve/main/SUPIR-v0Q_fp16.safetensors | **Non-commercial only** (Fanghua-Yu/SUPIR declaration; commercial use needs written permission from Dr. Jinjin Gu) | 2,664,858,464 | `models/model_patches/SUPIR-v0Q_fp16.safetensors` |
| SDXL base 1.0 | the SDXL model SUPIR patches | https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors | CreativeML Open RAIL++-M (commercial use allowed with use restrictions); not gated | 6,938,078,334 | `models/checkpoints/sd_xl_base_1.0.safetensors` |

ComfyUI's own SUPIR template pairs SUPIR with Juggernaut XL; we use SDXL base for its clearer licence.
**Do not expose SUPIR to paying customers until the licence question is settled.** Mix AI keeps the
"Heavy restore (SUPIR)" tool switched off unless `PHOTO_ALLOW_NONCOMMERCIAL=true` is set in `.env`.

## C) Extras, ~23 MB

| Item | Purpose | Source | Licence | Size (bytes) | Saved as |
|---|---|---|---|---|---|
| MediaPipe face landmarker | face mesh / landmarks / face masks (core `LoadMediaPipeFaceLandmarker`) | https://huggingface.co/Comfy-Org/mediapipe/resolve/main/detection/mediapipe_face_fp32.safetensors | Apache-2.0 | 5,423,900 | `models/detection/mediapipe_face_fp32.safetensors` |
| RealESRGAN x4plus anime 6B | 4x upscale for illustration / anime | https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth | BSD-3-Clause | 17,938,799 | `models/upscale_models/RealESRGAN_x4plus_anime_6B.pth` |

The core MediaPipe loader reads a safetensors port from `models/detection` (it calls `load_torch_file`), so
Google's `face_landmarker.task` file would not show up in it. The Comfy-Org repack is what the core node and
the official template use.

## Opt-in: CodeFormer (`--codeformer`)

| Item | Source | Licence | Size (bytes) | Saved as |
|---|---|---|---|---|
| CodeFormer | https://github.com/sczhou/CodeFormer/releases/download/v0.1.0/codeformer.pth | **S-Lab License 1.0, non-commercial** | 376,637,898 | `models/facerestore_models/codeformer.pth` |

Needs the core set's facerestore_cf node. The script prints the licence warning every time.

## Verify by hand

```bash
for p in 8188 8189; do
  for n in LoadBackgroundRemovalModel FaceRestoreCFWithModel DDColor_Colorize SAM3_Detect UpscaleModelLoader SUPIRApply LoadMediaPipeFaceLandmarker; do
    curl -s http://127.0.0.1:$p/object_info/$n | grep -q "\"$n\"" && echo "$p OK $n" || echo "$p MISSING $n"
  done
  for f in background_removal facerestore_models checkpoints upscale_models model_patches detection; do
    echo "$p $f: $(curl -s http://127.0.0.1:$p/models/$f)"
  done
done
```
If a custom node is MISSING: `journalctl -u comfyui -n 200 | grep -iA5 'facerestore\|ddcolor'` usually shows the import error.

## Remove

`./scripts/install-photo-models.sh --all --codeformer --uninstall-list` prints `rm` lines for every file and
node folder (with present/absent). Pip packages are left alone: the venv is shared.

## Left out, and why

- **Google `face_landmarker.task`**: the core node can't read it (see C).
- **SwinIR colour JPEG CAR models**: verified (JingyunLiang/SwinIR v0.0, Apache-2.0) but one model per JPEG
  quality level (10/20/30/40); FBCNN is blind to quality, so one file covers it.
- **NAFNet from the official Google Drive links**: Drive needs a cookie / confirmation dance for large files
  that doesn't script reliably; the pinned-sha256 HF mirror is used instead.
- **CodeFormer by default**: non-commercial licence.
