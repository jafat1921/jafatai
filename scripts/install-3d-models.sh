#!/usr/bin/env bash
# Mix AI Cinema Studio - image-to-3D (TRELLIS.2 + Pixal3D, native ComfyUI nodes) for the IMAGE GPU's ComfyUI.
#
#   ./scripts/install-3d-models.sh                  # check ComfyUI, download the models, restart, check the nodes
#   ./scripts/install-3d-models.sh --update-comfy   # also bring ComfyUI core up to date first (needs >= 0.34)
#   ./scripts/install-3d-models.sh --multiview      # also Pixal3D multi-view (four pictures in, ~5.6 GB more)
#   ./scripts/install-3d-models.sh --dry-run        # show what it would do
#
# Models (all from Comfy-Org's repackaged repos, none gated):
#   TRELLIS.2 (Microsoft, MIT)            diffusion_models/trellis_2_int8_convrot.safetensors
#   Pixal3D   (Tencent ARC, MIT)          diffusion_models/pixal3d_int8_convrot.safetensors
#   TRELLIS.2 shape + texture VAEs (MIT)  vae/trellis_2_{shape,texture}_vae_bf16.safetensors
#   DINOv3 ViT-L (Meta, DINOv3 License: commercial use allowed, no ITAR/military end uses)
#                                          clip_vision/dino_v3_L_naf_fp32.safetensors
#   BiRefNet (MIT, background removal)    background_removal/birefnet.safetensors
#   MoGe-2 (Microsoft, MIT)               geometry_estimation/moge_2_vitl_normal_fp16.safetensors (camera FOV for Pixal3D)
#   --multiview: Pixal3D multi-view (MIT)  diffusion_models/pixal3d_multiview_int8_convrot.safetensors
# The ComfyUI integration drops nvdiffrast/nvdiffrec, the non-commercial parts of the original TRELLIS pipeline.
#
# Safe to re-run: files with the right size are skipped and partial downloads resume.
# Env: COMFY_ROOT, COMFY_VENV, COMFY_URL (default http://127.0.0.1:8188), HF_TOKEN (optional, raises rate limits).
set -euo pipefail

DRY=0 RESTART=1 UPDATE=0 MULTIVIEW=0
COMFY_URL="${COMFY_URL:-http://127.0.0.1:8188}"
NEED_MAJOR=0 NEED_MINOR=34

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --no-restart) RESTART=0 ;;
    --update-comfy) UPDATE=1 ;;
    --multiview) MULTIVIEW=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[0;33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31mxx %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if (( DRY )); then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "${1}B"; }

# ---------------------------------------------------------------- locate ComfyUI (same rules as the other installers)
svc_exec() { systemctl show -p ExecStart --value "$1" 2>/dev/null || true; }
if [[ -z "${COMFY_ROOT:-}" ]]; then
  if [[ -d /data/apps/ComfyUI/models ]]; then
    COMFY_ROOT=/data/apps/ComfyUI
  else
    COMFY_ROOT="$(systemctl show -p WorkingDirectory --value comfyui.service 2>/dev/null || true)"
  fi
fi
[[ -n "$COMFY_ROOT" && -d "$COMFY_ROOT/models" ]] || die "ComfyUI not found; set COMFY_ROOT=/path/to/ComfyUI"
if [[ -z "${COMFY_VENV:-}" ]]; then
  if [[ -x /data/venvs/comfy/bin/python ]]; then
    COMFY_VENV=/data/venvs/comfy
  else
    py="$(svc_exec comfyui.service | grep -oE 'path=[^ ;]+' | head -1 | cut -d= -f2)"
    [[ -n "$py" ]] && COMFY_VENV="$(dirname "$(dirname "$py")")"
  fi
fi
[[ -x "${COMFY_VENV:-}/bin/python" ]] || die "ComfyUI's Python not found; set COMFY_VENV=/path/to/venv"
info "ComfyUI: $COMFY_ROOT"
info "venv:    $COMFY_VENV"

# ---------------------------------------------------------------- ComfyUI version (the 3D nodes are core from 0.34)
comfy_version() {
  sed -nE 's/^__version__ *= *"([0-9.]+)".*/\1/p' "$COMFY_ROOT/comfyui_version.py" 2>/dev/null | head -1
}
new_enough() {
  local v="$1" major minor
  major="${v%%.*}"; minor="$(echo "$v" | cut -d. -f2)"
  [[ -n "$major" && -n "$minor" ]] || return 1
  (( major > NEED_MAJOR || (major == NEED_MAJOR && minor >= NEED_MINOR) ))
}

say "Checking the ComfyUI version"
VER="$(comfy_version)"
info "installed: ${VER:-unknown}  (needed: ${NEED_MAJOR}.${NEED_MINOR} or newer)"
if ! new_enough "${VER:-0.0}"; then
  if (( UPDATE )); then
    [[ -d "$COMFY_ROOT/.git" ]] || die "ComfyUI isn't a git checkout; update it by hand"
    before="$(git -C "$COMFY_ROOT" rev-parse HEAD)"
    info "updating ComfyUI core (rollback: git -C $COMFY_ROOT checkout $before)"
    echo "$before" > "$COMFY_ROOT/.mixai-before-3d-update" 2>/dev/null || true
    run git -C "$COMFY_ROOT" fetch --tags origin
    run git -C "$COMFY_ROOT" pull --ff-only
    run "$COMFY_VENV/bin/pip" install -q -r "$COMFY_ROOT/requirements.txt"
    VER="$(comfy_version)"
    (( DRY )) || new_enough "${VER:-0.0}" || die "still ${VER:-unknown} after the update; check the ComfyUI checkout"
    info "now: ${VER:-unknown}"
  else
    die "ComfyUI ${VER:-unknown} is too old for the native 3D nodes. Re-run with --update-comfy (it notes the current commit for rollback)."
  fi
fi

# ---------------------------------------------------------------- downloads
# repo|path in repo|target folder under models/
FILES=(
  "Comfy-Org/TRELLIS.2|diffusion_models/trellis_2_int8_convrot.safetensors|diffusion_models"
  "Comfy-Org/Pixal3D|diffusion_models/pixal3d_int8_convrot.safetensors|diffusion_models"
  "Comfy-Org/TRELLIS.2|vae/trellis_2_shape_vae_bf16.safetensors|vae"
  "Comfy-Org/TRELLIS.2|vae/trellis_2_texture_vae_bf16.safetensors|vae"
  "Comfy-Org/Pixal3D|clip_vision/dino_v3_L_naf_fp32.safetensors|clip_vision"
  "Comfy-Org/BiRefNet|background_removal/birefnet.safetensors|background_removal"
  "Comfy-Org/MoGe|geometry_estimation/moge_2_vitl_normal_fp16.safetensors|geometry_estimation"
)
(( MULTIVIEW )) && FILES+=("Comfy-Org/Pixal3D|diffusion_models/pixal3d_multiview_int8_convrot.safetensors|diffusion_models")
AUTH=()
[[ -n "${HF_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer $HF_TOKEN")

# sizes from the Hub's file listing: a HEAD on resolve/ can come back without a length on the CDN redirect
remote_size() {
  local repo="$1" path="$2" dir
  dir="$(dirname "$path")"
  curl -sf --retry 3 -m 60 "${AUTH[@]}" "https://huggingface.co/api/models/$repo/tree/main/$dir" \
    | python3 -c "import json,sys; print(next((f.get('size') or 0 for f in json.load(sys.stdin) if f['path']=='$path'), 0))" \
    2>/dev/null || echo 0
}

say "Sizing the downloads"
total=0
declare -a SIZES
for i in "${!FILES[@]}"; do
  IFS='|' read -r repo path dir <<<"${FILES[$i]}"
  url="https://huggingface.co/$repo/resolve/main/$path"
  s="$(remote_size "$repo" "$path")"
  SIZES[$i]="$s"
  (( s > 0 )) || die "couldn't reach $url"
  total=$((total + s))
  info "$(basename "$path")  $(human "$s")"
done
free="$(df --output=avail -B1 "$COMFY_ROOT/models" | tail -1)"
info "total $(human "$total"), free $(human "$free")"
(( free > total + 5 * 1024 * 1024 * 1024 )) || die "not enough disk space (keeps 5 GB spare)"

say "Downloading"
for i in "${!FILES[@]}"; do
  IFS='|' read -r repo path dir <<<"${FILES[$i]}"
  url="https://huggingface.co/$repo/resolve/main/$path"
  dest="$COMFY_ROOT/models/$dir/$(basename "$path")"
  want="${SIZES[$i]}"
  if [[ -f "$dest" && "$(stat -c %s "$dest")" == "$want" ]]; then
    info "have $(basename "$dest")"
    continue
  fi
  run mkdir -p "$(dirname "$dest")"
  info "getting $(basename "$dest") ($(human "$want"))"
  run curl -fL --retry 5 -C - "${AUTH[@]}" -o "$dest.part" "$url"
  if (( ! DRY )); then
    [[ "$(stat -c %s "$dest.part")" == "$want" ]] || die "$(basename "$dest") is the wrong size; re-run to resume"
    mv "$dest.part" "$dest"
  fi
done

# ---------------------------------------------------------------- restart and check the nodes are there
if (( RESTART && ! DRY )); then
  say "Restarting ComfyUI"
  sudo systemctl restart comfyui.service
  for _ in $(seq 1 90); do
    curl -sf "$COMFY_URL/system_stats" >/dev/null && break
    sleep 2
  done
  curl -sf "$COMFY_URL/system_stats" >/dev/null || die "ComfyUI didn't come back on $COMFY_URL; see journalctl -u comfyui"
fi

if (( ! DRY )); then
  say "Checking the 3D nodes"
  missing=0
  for node in Trellis2Conditioning Trellis2ShapeStage Trellis2TextureStage EmptyTrellis2LatentStructure; do
    if curl -sf "$COMFY_URL/object_info/$node" | grep -q "\"$node\""; then
      info "ok  $node"
    else
      warn "missing $node"; missing=1
    fi
  done
  (( missing == 0 )) || die "some 3D nodes are missing; is ComfyUI ${NEED_MAJOR}.${NEED_MINOR}+ running on $COMFY_URL?"
  say "Done. In ComfyUI open Templates > 3D > \"Pixal3D & TRELLIS.2: Image to Model\" to try it, then send me:"
  info "curl -s $COMFY_URL/object_info | python3 -c \"import json,sys; d=json.load(sys.stdin); print([k for k in d if 'rellis' in k or 'ixal' in k or '3D' in k or 'Mesh' in k])\""
fi
