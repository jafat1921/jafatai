#!/usr/bin/env bash
# Mix AI Cinema Studio - photo restoration / editing models for ComfyUI.
#
#   ./scripts/install-photo-models.sh                 # core set (default)
#   ./scripts/install-photo-models.sh --all --dry-run # show everything it would do
#
#   --core         BiRefNet, face restore (GFPGAN 1.4), DDColor, SAM 3.1, 1x restoration models  ~5.5 GB
#   --supir        SUPIR-v0Q + SDXL base 1.0 (SUPIR weights are NON-COMMERCIAL, see docs)    ~9.6 GB
#   --extras       MediaPipe face landmarker, RealESRGAN x4plus anime 6B                      ~23 MB
#   --all          core + supir + extras
#   --codeformer   also fetch CodeFormer (NON-COMMERCIAL S-Lab licence), off unless asked     ~377 MB
#   --dry-run      print what would happen, change nothing
#   --no-restart   skip the ComfyUI restart + API check
#   --uninstall-list  print what to remove for the chosen sets (deletes nothing)
#
# Safe to re-run: files already present with the right size are skipped, partial downloads resume,
# custom nodes are git pull --ff-only'ed. Env: COMFY_ROOT, COMFY_VENV, HF_TOKEN (only for gated repos;
# none of the current ones are gated).
# Every URL below was checked on 2026-10-09 (HTTP 200 + exact byte size). Full list: docs/ops/photo-models.md
set -euo pipefail

WANT_CORE=0 WANT_SUPIR=0 WANT_EXTRAS=0 WANT_CF=0
DRY=0 RESTART=1 UNINSTALL_LIST=0
FREE_MARGIN=$((10 * 1024 * 1024 * 1024))

while [[ $# -gt 0 ]]; do
  case "$1" in
    --core)   WANT_CORE=1 ;;
    --supir)  WANT_SUPIR=1 ;;
    --extras) WANT_EXTRAS=1 ;;
    --all)    WANT_CORE=1; WANT_SUPIR=1; WANT_EXTRAS=1 ;;
    --codeformer) WANT_CF=1 ;;
    --dry-run) DRY=1 ;;
    --no-restart) RESTART=0 ;;
    --uninstall-list) UNINSTALL_LIST=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
# no set named -> core (but --codeformer alone means just that)
if (( WANT_CORE + WANT_SUPIR + WANT_EXTRAS == 0 && WANT_CF == 0 )); then WANT_CORE=1; fi

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[0;33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31mxx %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if (( DRY )); then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "${1}B"; }

# ---------------------------------------------------------------- locate ComfyUI
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
    # ExecStart looks like "{ path=/data/venvs/comfy/bin/python ; argv[]=... }"
    py="$(svc_exec comfyui.service | grep -oE 'path=[^ ;]+' | head -1 | cut -d= -f2)"
    [[ -n "$py" ]] && COMFY_VENV="$(dirname "$(dirname "$py")")"
  fi
fi
PY="${COMFY_VENV:-}/bin/python"
[[ -x "$PY" ]] || die "ComfyUI venv python not found; set COMFY_VENV=/path/to/venv"

MODELS="$COMFY_ROOT/models"
NODES="$COMFY_ROOT/custom_nodes"

if [[ $EUID -eq 0 && "${ALLOW_ROOT:-0}" != 1 ]]; then
  die "run this as the user that owns $COMFY_ROOT (e.g. gpu), not root; it uses sudo only for systemctl. ALLOW_ROOT=1 to override"
fi

# ---------------------------------------------------------------- the catalogue
# set|label|url|path relative to COMFY_ROOT|bytes|sha256 (HF publishes it; GitHub releases this old don't)
FILES=(
  # A) core
  "core|BiRefNet (background removal)|https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors|models/background_removal/birefnet.safetensors|444473596|9ab37426bf4de0567af6b5d21b16151357149139362e6e8992021b8ce356a154"
  "core|GFPGAN v1.4 (face restore)|https://github.com/TencentARC/GFPGAN/releases/download/v1.3.4/GFPGANv1.4.pth|models/facerestore_models/GFPGANv1.4.pth|348632874|"
  "core|DDColor modelscope|https://huggingface.co/piddnad/DDColor-models/resolve/main/ddcolor_modelscope.pth|custom_nodes/ComfyUI-DDColor/checkpoints/ddcolor_modelscope.pth|911950059|17c460d7e55b32a598370621d77173be59e03c24b0823f06821db23a50c263ce"
  "core|DDColor artistic|https://huggingface.co/piddnad/DDColor-models/resolve/main/ddcolor_artistic.pth|custom_nodes/ComfyUI-DDColor/checkpoints/ddcolor_artistic.pth|911950059|a591ee5beedad36de703d8977e92d0c30c1eedc6453fd1b300f3b460842a23a9"
  "core|SAM 3.1 multiplex fp16|https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors|models/checkpoints/sam3.1_multiplex_fp16.safetensors|1745546848|9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03"
  "core|FBCNN colour (JPEG artefacts)|https://github.com/jiaxi-jiang/FBCNN/releases/download/v1.0/fbcnn_color.pth|models/upscale_models/1x_fbcnn_color.pth|287755111|"
  # NAFNet: the official weights are Google Drive only. This HF mirror backs the nafnetlib PyPI package;
  # file names and sizes match the official Drive files (443M / 259M) and a second mirror
  # (nyanko7/nafnet-models) has byte-identical sha256s.
  "core|NAFNet SIDD width64 (denoise)|https://huggingface.co/mikestealth/nafnet-models/resolve/main/NAFNet-SIDD-width64.pth|models/upscale_models/1x_NAFNet-SIDD-width64.pth|464154961|cd685efaae01f7c4e9951f2deab05780079c8eb1e49ed664b72f6db04dabb445"
  "core|NAFNet GoPro width64 (deblur)|https://huggingface.co/mikestealth/nafnet-models/resolve/main/NAFNet-GoPro-width64.pth|models/upscale_models/1x_NAFNet-GoPro-width64.pth|271778961|329d3ab4077b8d6b7ff61de376e483714667960bf85be027bf4335cda701196f"
  "core|SCUNet real PSNR (denoise)|https://github.com/cszn/KAIR/releases/download/v1.0/scunet_color_real_psnr.pth|models/upscale_models/1x_scunet_color_real_psnr.pth|71982841|"
  # B) SUPIR
  "supir|SUPIR v0Q fp16|https://huggingface.co/Kijai/SUPIR_pruned/resolve/main/SUPIR-v0Q_fp16.safetensors|models/model_patches/SUPIR-v0Q_fp16.safetensors|2664858464|3eef33ec7633122ca23b1e5ef167faa048b5a0845768694d5e8070138ac013ce"
  "supir|SDXL base 1.0|https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors|models/checkpoints/sd_xl_base_1.0.safetensors|6938078334|31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"
  # C) extras. The core MediaPipe loader reads a torch/safetensors port from models/detection,
  # NOT Google's face_landmarker.task, so the Comfy-Org repack is the right file here.
  "extras|MediaPipe face landmarker|https://huggingface.co/Comfy-Org/mediapipe/resolve/main/detection/mediapipe_face_fp32.safetensors|models/detection/mediapipe_face_fp32.safetensors|5423900|a98c4806081d40eba35102a0f6dc0000c2e1388b72cf24e691703d0605bd888a"
  "extras|RealESRGAN x4plus anime 6B|https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth|models/upscale_models/RealESRGAN_x4plus_anime_6B.pth|17938799|"
  # opt-in only
  "codeformer|CodeFormer (non-commercial)|https://github.com/sczhou/CodeFormer/releases/download/v0.1.0/codeformer.pth|models/facerestore_models/codeformer.pth|376637898|"
)

# set|dir name|git url
# TODO: pin both nodes to a tested commit once the Photo Studio workflows are settled
REPOS=(
  "core|facerestore_cf|https://github.com/mav-rik/facerestore_cf.git"
  "core|ComfyUI-DDColor|https://github.com/kijai/ComfyUI-DDColor.git"
)

# what to ask ComfyUI after the restart: set|node:<class> or model:<folder>:<file>
CHECKS=(
  "core|node:LoadBackgroundRemovalModel"
  "core|model:background_removal:birefnet.safetensors"
  "core|node:FaceRestoreModelLoader"
  "core|node:FaceRestoreCFWithModel"
  "core|model:facerestore_models:GFPGANv1.4.pth"
  "core|node:DDColor_Colorize"
  "core|node:SAM3_Detect"
  "core|model:checkpoints:sam3.1_multiplex_fp16.safetensors"
  "core|node:UpscaleModelLoader"
  "core|model:upscale_models:1x_fbcnn_color.pth"
  "core|model:upscale_models:1x_NAFNet-SIDD-width64.pth"
  "core|model:upscale_models:1x_NAFNet-GoPro-width64.pth"
  "core|model:upscale_models:1x_scunet_color_real_psnr.pth"
  "supir|node:SUPIRApply"
  "supir|model:model_patches:SUPIR-v0Q_fp16.safetensors"
  "supir|model:checkpoints:sd_xl_base_1.0.safetensors"
  "extras|node:LoadMediaPipeFaceLandmarker"
  "extras|model:detection:mediapipe_face_fp32.safetensors"
  "extras|model:upscale_models:RealESRGAN_x4plus_anime_6B.pth"
  "codeformer|model:facerestore_models:codeformer.pth"
)

wanted() {
  case "$1" in
    core) (( WANT_CORE )) ;;
    supir) (( WANT_SUPIR )) ;;
    extras) (( WANT_EXTRAS )) ;;
    codeformer) (( WANT_CF )) ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------- --uninstall-list
if (( UNINSTALL_LIST )); then
  say "Would remove (nothing is deleted - copy the lines you want)"
  for row in "${FILES[@]}"; do
    IFS='|' read -r set label _url rel _size _sha <<<"$row"
    wanted "$set" || continue
    state=absent; [[ -e "$COMFY_ROOT/$rel" ]] && state=present
    printf '    rm -f %-80q # %s, %s\n' "$COMFY_ROOT/$rel" "$label" "$state"
  done
  for row in "${REPOS[@]}"; do
    IFS='|' read -r set dir _url <<<"$row"
    wanted "$set" || continue
    state=absent; [[ -d "$NODES/$dir" ]] && state=present
    printf '    rm -rf %-79q # custom node, %s\n' "$NODES/$dir" "$state"
  done
  info "pip packages added for the custom nodes are left in place (shared venv; removing them can break other nodes)."
  info "then: sudo systemctl restart comfyui comfyui-gpu1"
  exit 0
fi

# ---------------------------------------------------------------- licence notes
if (( WANT_SUPIR )); then
  warn "SUPIR weights are NON-COMMERCIAL ONLY (Fanghua-Yu/SUPIR 'Non-Commercial Use Only Declaration')."
  warn "Commercial use needs written permission from Dr. Jinjin Gu. SDXL base is CreativeML Open RAIL++-M (commercial OK)."
fi
if (( WANT_CF )); then
  warn "CodeFormer is under the S-Lab License 1.0: NON-COMMERCIAL use only. Do not enable it for paying"
  warn "customers without a licence from the authors (sczhou/CodeFormer)."
fi

# ---------------------------------------------------------------- plan + disk check
say "Plan  (ComfyUI: $COMFY_ROOT, venv: $COMFY_VENV)"
need=0
for row in "${FILES[@]}"; do
  IFS='|' read -r set label _url rel size _sha <<<"$row"
  wanted "$set" || continue
  dest="$COMFY_ROOT/$rel"
  if [[ -f "$dest" ]]; then
    info "have   $(printf '%-32s' "$label") $rel"
  else
    part=0; [[ -f "$dest.part" ]] && part=$(stat -c %s "$dest.part")
    (( part > size )) && part=0
    need=$(( need + size - part ))
    info "get    $(printf '%-32s' "$label") $(printf '%9s' "$(human "$size")")  -> $rel"
  fi
done
for row in "${REPOS[@]}"; do
  IFS='|' read -r set dir url <<<"$row"
  wanted "$set" || continue
  if [[ -d "$NODES/$dir/.git" ]]; then info "update node $dir"; else info "clone  node $dir  ($url)"; fi
done

seen_fs=""
for d in "$MODELS" "$NODES"; do
  mnt=$(df --output=target "$d" | tail -1)
  [[ " $seen_fs " == *" $mnt "* ]] && continue
  seen_fs+=" $mnt"
  avail=$(df -B1 --output=avail "$d" | tail -1 | tr -d ' ')
  info "free on $mnt: $(human "$avail"), to download: $(human "$need") (+10G headroom)"
  if (( avail < need + FREE_MARGIN )); then
    if (( DRY )); then warn "not enough free space - a real run would stop here"
    else die "not enough disk space on $d: need $(human $((need + FREE_MARGIN))), have $(human "$avail")"; fi
  fi
done

# ---------------------------------------------------------------- helpers
declare -A STATUS=()
CHANGED=0
FAILED=0

pip_safe_install() {  # $1 = node dir, $2 = requirements file
  local req="$2" filtered cons
  [[ -f "$req" ]] || return 0
  filtered="$(mktemp)"; cons="$(mktemp)"
  # torch/torchvision/numpy are owned by ComfyUI: never let a node's requirements move them.
  # opencv-python is skipped when cv2 already imports (installing it next to the headless build breaks cv2).
  # tb-nightly is only used by basicsr's training logger.
  local skip='^(torch|torchvision|torchaudio|tb-nightly|tensorboard)([^a-z0-9_-]|$)'
  if "$PY" -c 'import cv2' 2>/dev/null; then skip='^(torch|torchvision|torchaudio|tb-nightly|tensorboard|opencv[-_]python|opencv[-_]python[-_]headless)([^a-z0-9_-]|$)'; fi
  sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$req" | grep -v '^$' | grep -viE "$skip" > "$filtered" || true
  "$PY" -m pip freeze 2>/dev/null | grep -iE '^(torch|torchvision|torchaudio|numpy|xformers|triton)==' > "$cons" || true
  info "pip (into $COMFY_VENV): $(tr '\n' ' ' < "$filtered")"
  if (( DRY )); then rm -f "$filtered" "$cons"; return 0; fi
  if [[ -s "$filtered" ]] && ! "$PY" -m pip install --quiet -c "$cons" -r "$filtered"; then
    rm -f "$filtered" "$cons"; return 1
  fi
  rm -f "$filtered" "$cons"
}

sync_repo() {  # $1 dir name, $2 url
  local dir="$NODES/$1" url="$2" before after
  if [[ -d "$dir/.git" ]]; then
    before=$(git -C "$dir" rev-parse HEAD)
    run git -C "$dir" pull --ff-only --quiet || return 1
    after=$(git -C "$dir" rev-parse HEAD)
    if (( DRY )); then STATUS[$1]="would pull"
    elif [[ "$before" != "$after" ]]; then STATUS[$1]="updated"; CHANGED=1
    else STATUS[$1]="up to date"; fi
  elif [[ -e "$dir" ]]; then
    warn "$dir exists but is not a git checkout - leaving it alone"
    STATUS[$1]="exists (not git)"
    return 0
  else
    run git clone --quiet "$url" "$dir" || return 1
    if (( DRY )); then STATUS[$1]="would clone"; else STATUS[$1]="cloned"; CHANGED=1; fi
  fi
  # this node's requirements_312 is the same list plus 'packaging'
  local req="$dir/requirements.txt"
  [[ -f "$dir/requirements_312.txt" ]] && req="$dir/requirements_312.txt"
  if (( DRY )) && [[ ! -d "$dir" ]]; then info "pip: requirements of $1 after clone"; return 0; fi
  pip_safe_install "$dir" "$req"
}

fetch() {  # $1 url, $2 dest, $3 bytes, $4 sha256 (may be empty)
  local url="$1" dest="$2" size="$3" sha="$4" part have
  part="$dest.part"
  if [[ -f "$dest" ]]; then
    have=$(stat -c %s "$dest")
    if (( have == size )); then echo present; return 0; fi
    # a different build under the same name: don't touch it
    warn "$dest is $have bytes, expected $size - kept as is"
    echo "present (size differs)"; return 0
  fi
  if (( DRY )); then echo "would download"; return 0; fi
  mkdir -p "$(dirname "$dest")"
  [[ -f "$part" ]] && (( $(stat -c %s "$part") > size )) && rm -f "$part"
  if [[ ! -f "$part" ]] || (( $(stat -c %s "$part") < size )); then
    local auth=()
    if [[ -n "${HF_TOKEN:-}" && "$url" == https://huggingface.co/* ]]; then
      auth=(-H "Authorization: Bearer $HF_TOKEN")   # curl drops it on the redirect to the CDN host
    fi
    printf '    downloading %s\n' "$(basename "$dest")" >&2
    if ! curl -L --fail --retry 5 --retry-delay 5 --connect-timeout 30 -C - -# "${auth[@]}" -o "$part" "$url" >&2; then
      echo "download failed"; return 1
    fi
  fi
  have=$(stat -c %s "$part")
  if (( have != size )); then echo "size $have != $size (left $part)"; return 1; fi
  if [[ -n "$sha" ]]; then
    local got; got=$(sha256sum "$part" | cut -d' ' -f1)
    if [[ "$got" != "$sha" ]]; then rm -f "$part"; echo "sha256 mismatch (deleted)"; return 1; fi
  fi
  mv -f "$part" "$dest"
  echo downloaded
}

# ---------------------------------------------------------------- custom nodes
say "Custom nodes"
for row in "${REPOS[@]}"; do
  IFS='|' read -r set dir url <<<"$row"
  wanted "$set" || continue
  if ! sync_repo "$dir" "$url"; then STATUS[$dir]="FAILED"; FAILED=1; warn "$dir failed"; fi
done
(( WANT_CORE )) && info "facerestore_cf fetches its face detector / parser (retinaface, parsenet) into models/facedetection on first use."

# ---------------------------------------------------------------- models
say "Models"
for row in "${FILES[@]}"; do
  IFS='|' read -r set label url rel size sha <<<"$row"
  wanted "$set" || continue
  # fetch runs in a subshell, so CHANGED is decided here
  if res=$(fetch "$url" "$COMFY_ROOT/$rel" "$size" "$sha"); then
    STATUS[$rel]="$res"
    [[ "$res" == downloaded ]] && CHANGED=1
  else
    STATUS[$rel]="FAILED: $res"; FAILED=1
  fi
  info "$(printf '%-32s' "$label") ${STATUS[$rel]}"
done

# ---------------------------------------------------------------- summary
say "Summary"
printf '    %-10s %-32s %10s  %-26s %s\n' SET ITEM SIZE STATUS PATH
for row in "${REPOS[@]}"; do
  IFS='|' read -r set dir _url <<<"$row"
  wanted "$set" || continue
  printf '    %-10s %-32s %10s  %-26s %s\n' "$set" "node $dir" "-" "${STATUS[$dir]:-?}" "custom_nodes/$dir"
done
for row in "${FILES[@]}"; do
  IFS='|' read -r set label _url rel size _sha <<<"$row"
  wanted "$set" || continue
  printf '    %-10s %-32s %10s  %-26s %s\n' "$set" "$label" "$(human "$size")" "${STATUS[$rel]:-?}" "$rel"
done

if (( DRY )); then
  say "Dry run: nothing changed. Re-run without --dry-run to install."
  exit 0
fi

# ---------------------------------------------------------------- restart + verify
if (( ! RESTART )); then
  say "Skipping restart (--no-restart). Restart ComfyUI yourself to pick up the new nodes."
  exit "$FAILED"
fi

mapfile -t UNITS < <(systemctl list-units --all --type=service --plain --no-legend 'comfyui*' 2>/dev/null | awk '{print $1}')
if (( ${#UNITS[@]} == 0 )); then
  warn "no comfyui*.service found - restart ComfyUI by hand, then check http://127.0.0.1:8188/object_info"
  exit "$FAILED"
fi

PORTS=()
for u in "${UNITS[@]}"; do
  port=$(svc_exec "$u" | grep -oE -- '--port[= ]+[0-9]+' | grep -oE '[0-9]+' | head -1 || true)
  if [[ -z "$port" ]]; then
    case "$u" in comfyui.service) port=8188 ;; comfyui-gpu1.service) port=8189 ;; esac
  fi
  [[ -n "$port" ]] && PORTS+=("$port")
done

# a marker survives a failed/timed-out sudo, so the next run still restarts
PENDING="$COMFY_ROOT/.mixai-photo-restart-pending"
(( CHANGED )) && touch "$PENDING"
if [[ -f "$PENDING" ]]; then
  say "Restarting: ${UNITS[*]}"
  if ! sudo systemctl restart "${UNITS[@]}"; then
    warn "restart failed (sudo?). New nodes are NOT loaded yet - re-run this script, or:"
    warn "  sudo systemctl restart ${UNITS[*]}"
    exit 1
  fi
  rm -f "$PENDING"
else
  say "Nothing new on disk - not restarting; checking the running ComfyUI"
fi

for port in "${PORTS[@]}"; do
  base="http://127.0.0.1:$port"
  printf '    waiting for %s ' "$base"
  for _ in $(seq 1 90); do
    curl -sf -o /dev/null "$base/system_stats" && break
    printf '.'; sleep 2
  done
  echo
  if ! curl -sf -o /dev/null "$base/system_stats"; then
    warn "$base did not come up - see: journalctl -u comfyui* -n 100"
    FAILED=1; continue
  fi
  say "ComfyUI on :$port"
  for row in "${CHECKS[@]}"; do
    IFS='|' read -r set check <<<"$row"
    wanted "$set" || continue
    case "$check" in
      node:*)
        cls="${check#node:}"
        out=$(curl -sf "$base/object_info/$cls" || true)
        if grep -q "\"$cls\"" <<<"$out"; then r=OK; else r=MISSING; FAILED=1; fi
        printf '    %-8s node  %s\n' "$r" "$cls" ;;
      model:*)
        rest="${check#model:}"; folder="${rest%%:*}"; name="${rest#*:}"
        out=$(curl -sf "$base/models/$folder" || true)
        if grep -qF "\"$name\"" <<<"$out"; then r=OK; else r=MISSING; FAILED=1; fi
        printf '    %-8s model %s/%s\n' "$r" "$folder" "$name" ;;
    esac
  done
done

if (( FAILED )); then
  warn "something is MISSING or FAILED above. Logs: journalctl -u comfyui -n 200 (and comfyui-gpu1)"
  exit 1
fi
say "Done."
