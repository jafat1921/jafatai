#!/usr/bin/env bash
# Mix AI Cinema Studio - Edit Image tools for the IMAGE GPU's ComfyUI (contract v30; ControlNet: v31).
#
#   ./scripts/install-image-tools.sh                    # aux + inpaint + iclight + control (the commercial-safe set)
#   ./scripts/install-image-tools.sh --all --dry-run    # show everything it would do
#
#   --aux        comfyui_controlnet_aux + line art, anime line art, soft edge (HED), Depth Anything V2 Small  ~0.4 GB
#   --inpaint    comfyui-inpaint-nodes + big-lama (object removal)                                           ~0.2 GB
#   --iclight    ComfyUI-IC-Light + IC-Light v1 fc/fbc + Realistic Vision 5.1 (SD1.5) checkpoint              ~5.6 GB
#   --tryon      ComfyUI-CatVTON + CatVTON, SD1.5 inpainting and sd-vae-ft-mse (CatVTON is NON-COMMERCIAL)    ~7.6 GB
#   --control    Z-Image Fun ControlNet Union 2.1 lite + DWPose (pose) weights for controlnet_aux; implies --aux ~2.4 GB
#                (contract v31: Depth / Sketch / Pose / Edge to image)
#   --all        all five
#   --dry-run    print what would happen, change nothing
#   --no-restart skip the ComfyUI restart + API check
#   --uninstall-list  print what to remove for the chosen sets (deletes nothing)
#
# Safe to re-run: files already present with the right size are skipped, partial downloads resume, git nodes are
# checked out at the commit pinned below (pass --latest to follow their default branch instead).
# Env: COMFY_ROOT, COMFY_VENV, HF_TOKEN (none of these repos are gated), HF_HOME (defaults to what comfyui.service
# uses, so the CatVTON node finds its downloads).
# Sizes and sha256 come from the Hugging Face API / GitHub release API, checked on 2026-10-14. big-lama.pt and the
# CatVTON node zip are GitHub release assets with no published hash: size only. Licences: docs/api/contract-v30-image-tools.md
# and docs/api/contract-v31-styles-control-templates.md
set -euo pipefail

WANT_AUX=0 WANT_INPAINT=0 WANT_ICLIGHT=0 WANT_TRYON=0 WANT_CONTROL=0
DRY=0 RESTART=1 UNINSTALL_LIST=0 LATEST=0
FREE_MARGIN=$((10 * 1024 * 1024 * 1024))

while [[ $# -gt 0 ]]; do
  case "$1" in
    --aux)     WANT_AUX=1 ;;
    --inpaint) WANT_INPAINT=1 ;;
    --iclight) WANT_ICLIGHT=1 ;;
    --tryon)   WANT_TRYON=1 ;;
    --control) WANT_CONTROL=1 ;;
    --all)     WANT_AUX=1; WANT_INPAINT=1; WANT_ICLIGHT=1; WANT_TRYON=1; WANT_CONTROL=1 ;;
    --dry-run) DRY=1 ;;
    --no-restart) RESTART=0 ;;
    --latest)  LATEST=1 ;;
    --uninstall-list) UNINSTALL_LIST=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
if (( WANT_AUX + WANT_INPAINT + WANT_ICLIGHT + WANT_TRYON + WANT_CONTROL == 0 )); then
  WANT_AUX=1; WANT_INPAINT=1; WANT_ICLIGHT=1; WANT_CONTROL=1
fi
# the ControlNet's photo-to-map step runs on the controlnet_aux preprocessors
if (( WANT_CONTROL )); then WANT_AUX=1; fi

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[0;33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31mxx %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if (( DRY )); then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "${1}B"; }

# ---------------------------------------------------------------- locate ComfyUI (same rules as install-photo-models.sh)
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
PY="${COMFY_VENV:-}/bin/python"
[[ -x "$PY" ]] || die "ComfyUI venv python not found; set COMFY_VENV=/path/to/venv"

if [[ -z "${HF_HOME:-}" ]]; then
  hf="$(systemctl show -p Environment --value comfyui.service 2>/dev/null | tr ' ' '\n' | grep '^HF_HOME=' | cut -d= -f2- || true)"
  [[ -n "$hf" ]] && export HF_HOME="$hf"
fi

MODELS="$COMFY_ROOT/models"
NODES="$COMFY_ROOT/custom_nodes"
AUX="custom_nodes/comfyui_controlnet_aux/ckpts"

if [[ $EUID -eq 0 && "${ALLOW_ROOT:-0}" != 1 ]]; then
  die "run this as the user that owns $COMFY_ROOT (e.g. gpu), not root; it uses sudo only for systemctl. ALLOW_ROOT=1 to override"
fi

# ---------------------------------------------------------------- the catalogue
# set|label|url|path relative to COMFY_ROOT|bytes|sha256 (empty: the host publishes none, size is checked)
FILES=(
  # controlnet_aux reads its annotators from ckpts/<hf repo>/<file> and only downloads what is missing
  "aux|Line art (sk_model)|https://huggingface.co/lllyasviel/Annotators/resolve/982e7edaec38759d914a963c48c4726685de7d96/sk_model.pth|$AUX/lllyasviel/Annotators/sk_model.pth|17173511|c686ced2a666b4850b4bb6ccf0748031c3eda9f822de73a34b8979970d90f0c6"
  "aux|Line art coarse (sk_model2)|https://huggingface.co/lllyasviel/Annotators/resolve/982e7edaec38759d914a963c48c4726685de7d96/sk_model2.pth|$AUX/lllyasviel/Annotators/sk_model2.pth|17173511|30a534781061f34e83bb9406b4335da4ff2616c95d22a585c1245aa8363e74e0"
  "aux|Anime line art (netG)|https://huggingface.co/lllyasviel/Annotators/resolve/982e7edaec38759d914a963c48c4726685de7d96/netG.pth|$AUX/lllyasviel/Annotators/netG.pth|217631959|ccabdcc3f5cf3c07cf65d58776acb21df7dfda825cdc70c9766a93fd62bfc488"
  "aux|Soft edge (ControlNetHED)|https://huggingface.co/lllyasviel/Annotators/resolve/982e7edaec38759d914a963c48c4726685de7d96/ControlNetHED.pth|$AUX/lllyasviel/Annotators/ControlNetHED.pth|29444406|5ca93762ffd68a29fee1af9d495bf6aab80ae86f08905fb35472a083a4c7a8fa"
  "aux|Depth Anything V2 Small|https://huggingface.co/depth-anything/Depth-Anything-V2-Small/resolve/03876f8651c73a60fe4c2c48294e09fcb6838fcf/depth_anything_v2_vits.pth|$AUX/depth-anything/Depth-Anything-V2-Small/depth_anything_v2_vits.pth|99218434|715fade13be8f229f8a70cc02066f656f2423a59effd0579197bbf57860e1378"
  "inpaint|LaMa big-lama|https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt|models/inpaint/big-lama.pt|205669692|"
  "iclight|IC-Light v1 fc|https://huggingface.co/lllyasviel/ic-light/resolve/9cad1878695f546a7fb9eaca14e2a89131ba5ffe/iclight_sd15_fc.safetensors|models/unet/iclight_sd15_fc.safetensors|1719148312|a033fbaaa2f3f7859fa6a4477ee63ebbf9c116bf3569d5811856d2807f3468cd"
  "iclight|IC-Light v1 fbc|https://huggingface.co/lllyasviel/ic-light/resolve/9cad1878695f546a7fb9eaca14e2a89131ba5ffe/iclight_sd15_fbc.safetensors|models/unet/iclight_sd15_fbc.safetensors|1719171352|bb8ccedaa4944b16cfa8356afcbc2c2174cc4c4af57de19124ae0cddd0d96947"
  # contract v31. The lite 2602 build: 2.0 GB instead of 6.7 GB, so it fits beside Z-Image Turbo bf16 on a 20 GB card
  "control|Z-Image Fun ControlNet Union 2.1 lite|https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1/resolve/5155fc56d17821007d6f62ac192c09e0f0e72016/Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors|models/model_patches/Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors|2016627488|3ea098db9bd145be525c7e2366920b6d76c5ffd46b3d7aa8169bbc943fdaee35"
  # DWPose for DWPreprocessor, TorchScript builds (no onnxruntime needed); both repos say apache-2.0
  "control|DWPose YOLOX-L detector|https://huggingface.co/hr16/yolox-onnx/resolve/a124b32c3b7c5cebda1c7cd96178f0f9d2050125/yolox_l.torchscript.pt|$AUX/hr16/yolox-onnx/yolox_l.torchscript.pt|217697649|80bc14b13c260c24b3014cd42c02994bf52296ab8fa2d80a60b6afe08c93ef42"
  "control|DWPose ll_ucoco 384|https://huggingface.co/hr16/DWPose-TorchScript-BatchSize5/resolve/359d662a9b33b73f6d0f21732baf8845f17bb4be/dw-ll_ucoco_384_bs5.torchscript.pt|$AUX/hr16/DWPose-TorchScript-BatchSize5/dw-ll_ucoco_384_bs5.torchscript.pt|135059124|d86a0b2b59fddc0901a7076e9f59c9f8602602133ed72511c693fd11eea23d91"
  "iclight|Realistic Vision 5.1 fp16|https://huggingface.co/SG161222/Realistic_Vision_V5.1_noVAE/resolve/main/Realistic_Vision_V5.1_fp16-no-ema.safetensors|models/checkpoints/Realistic_Vision_V5.1_fp16-no-ema.safetensors|2132625894|99a75a901f4fec732056930a89fa34cf360f6f72d75ce5bf333ddf82adf8dd2a"
)

# set|dir name|git url|pinned commit (2026-10-14)
REPOS=(
  "aux|comfyui_controlnet_aux|https://github.com/Fannovel16/comfyui_controlnet_aux.git|a587a4c1594524c1d2de5cd1a86cd868ff448e1c"
  "inpaint|comfyui-inpaint-nodes|https://github.com/Acly/comfyui-inpaint-nodes.git|5b7681746fe19e563113d27366ba85236bc1ba5b"
  "iclight|ComfyUI-IC-Light|https://github.com/kijai/ComfyUI-IC-Light.git|22811d903af8a90100dccef1c4b579526649a6ab"
)

# CatVTON's ComfyUI node is not a git repo: it ships as a zip on the 'ComfyUI' release of Zheng-Chong/CatVTON
CATVTON_ZIP="https://github.com/Zheng-Chong/CatVTON/releases/download/ComfyUI/ComfyUI-CatVTON.zip"
CATVTON_ZIP_BYTES=3987719
CATVTON_DIR="ComfyUI-CatVTON"

# set|label|hf repo|revision|bytes (whole snapshot)|file=sha256 checks, comma separated
# The node loads these by repo id through huggingface_hub, so they go into the HF cache, not models/
SNAPSHOTS=(
  "tryon|CatVTON weights (CC BY-NC-SA)|zhengchong/CatVTON|2969fcf85fe62f2036605716f0b56f0b81d01d79|1423479200|mix-48k-1024/attention/model.safetensors=a1fc093f1b6744623079e6f4e7313411f524e388c4b7467df1e0e7f577cba23a,DensePose/model_final_162be9.pkl=b8a7382001b16e453bad95ca9dbc68ae8f2b839b304cf90eaf5c27fbdb4dae91,SCHP/exp-schp-201908261155-lip.pth=24fa3254ceeb74c8435458994a64b522fb439a3635b7b86ff470457e0413da00,SCHP/exp-schp-201908301523-atr.pth=e9d7c91ce3b4e7133df56b599fc817b533e3439c5e8d282a59126d2fda339a2a"
  "tryon|SD1.5 inpainting (mirror)|booksforcharlie/stable-diffusion-inpainting|d260cf3646fe94c6d5d70820b77512f836d7cce2|5483000000|unet/diffusion_pytorch_model.bin=af4e22eecaca7a1c5dd849f51924effdccc1f765141e898c323b775cc80a43b3,vae/diffusion_pytorch_model.bin=1b134cded8eb78b184aefb8805b6b572f36fa77b255c483665dda931fa0130c5"
  "tryon|sd-vae-ft-mse|stabilityai/sd-vae-ft-mse|31f26fdeee1355a5c34592e401dd41e45d25a493|669360000|diffusion_pytorch_model.safetensors=a1d993488569e928462932c8c38a0760b874d166399b14414135bd9c42df5815"
)

CHECKS=(
  "aux|node:LineArtPreprocessor"
  "aux|node:AnimeLineArtPreprocessor"
  "aux|node:DepthAnythingV2Preprocessor"
  "aux|node:CannyEdgePreprocessor"
  "aux|node:HEDPreprocessor"
  "inpaint|node:INPAINT_LoadInpaintModel"
  "inpaint|node:INPAINT_InpaintWithModel"
  "inpaint|model:inpaint:big-lama.pt"
  "iclight|node:LoadAndApplyICLightUnet"
  "iclight|node:ICLightConditioning"
  "iclight|node:LightSource"
  "iclight|model:unet:iclight_sd15_fc.safetensors"
  "iclight|model:unet:iclight_sd15_fbc.safetensors"
  "iclight|model:checkpoints:Realistic_Vision_V5.1_fp16-no-ema.safetensors"
  # IC-Light reuses Photo Studio's BiRefNet (install-photo-models.sh --core) for its foreground matte
  "iclight|node:RemoveBackground"
  "iclight|model:background_removal:birefnet.safetensors"
  "tryon|node:LoadCatVTONPipeline"
  "tryon|node:LoadAutoMasker"
  "tryon|node:AutoMasker"
  "tryon|node:CatVTON"
  "control|node:ModelPatchLoader"
  "control|node:QwenImageDiffsynthControlnet"
  "control|node:DWPreprocessor"
  "control|node:Scribble_XDoG_Preprocessor"
  "control|model:model_patches:Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors"
)

wanted() {
  case "$1" in
    aux) (( WANT_AUX )) ;;
    inpaint) (( WANT_INPAINT )) ;;
    iclight) (( WANT_ICLIGHT )) ;;
    tryon) (( WANT_TRYON )) ;;
    control) (( WANT_CONTROL )) ;;
    *) return 1 ;;
  esac
}

hf_cache_dir() {  # where huggingface_hub keeps a repo
  local repo="$1" base="${HF_HUB_CACHE:-${HF_HOME:-$HOME/.cache/huggingface}/hub}"
  echo "$base/models--${repo//\//--}"
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
    IFS='|' read -r set dir _url _pin <<<"$row"
    wanted "$set" || continue
    state=absent; [[ -d "$NODES/$dir" ]] && state=present
    printf '    rm -rf %-79q # custom node, %s\n' "$NODES/$dir" "$state"
  done
  if (( WANT_TRYON )); then
    state=absent; [[ -d "$NODES/$CATVTON_DIR" ]] && state=present
    printf '    rm -rf %-79q # custom node, %s\n' "$NODES/$CATVTON_DIR" "$state"
    for row in "${SNAPSHOTS[@]}"; do
      IFS='|' read -r _set label repo _rev _size _checks <<<"$row"
      d="$(hf_cache_dir "$repo")"; state=absent; [[ -d "$d" ]] && state=present
      printf '    rm -rf %-79q # %s, %s\n' "$d" "$label" "$state"
    done
  fi
  info "pip packages added for the custom nodes are left in place (shared venv; removing them can break other nodes)."
  info "then: sudo systemctl restart comfyui comfyui-gpu1"
  exit 0
fi

# ---------------------------------------------------------------- licence notes
if (( WANT_AUX )); then
  warn "lllyasviel/Annotators is marked licence 'other': line art, anime line art and soft edge are treated as"
  warn "NON-COMMERCIAL (IMAGE_ALLOW_NONCOMMERCIAL) until confirmed. Depth Anything V2 Small is Apache-2.0; Canny has no weights."
fi
if (( WANT_INPAINT )); then
  info "LaMa (advimman/lama) is Apache-2.0. comfyui-inpaint-nodes is GPL-3.0 (runs inside ComfyUI, not shipped with the app)."
fi
if (( WANT_ICLIGHT )); then
  info "IC-Light v1 is Apache-2.0; Realistic Vision 5.1 is CreativeML OpenRAIL-M (commercial use allowed, use restrictions apply)."
fi
if (( WANT_TRYON )); then
  warn "CatVTON weights are CC BY-NC-SA 4.0: NON-COMMERCIAL ONLY. The app offers try-on only while"
  warn "IMAGE_ALLOW_NONCOMMERCIAL=true. SD1.5 inpainting: CreativeML OpenRAIL-M; sd-vae-ft-mse: MIT."
fi

if (( WANT_CONTROL )); then
  info "Z-Image-Turbo-Fun-Controlnet-Union-2.1 is Apache-2.0. DWPose (yzd-v/DWPose, hr16 TorchScript builds) and YOLOX"
  info "are Apache-2.0 per their model cards. HED soft edges stay non-commercial (Annotators, see --aux)."
  info "ModelPatchLoader / QwenImageDiffsynthControlnet are ComfyUI core nodes: an old ComfyUI needs updating first."
fi

# ---------------------------------------------------------------- plan + disk check
say "Plan  (ComfyUI: $COMFY_ROOT, venv: $COMFY_VENV, HF cache: $(dirname "$(hf_cache_dir x/y)"))"
need=0
for row in "${FILES[@]}"; do
  IFS='|' read -r set label _url rel size _sha <<<"$row"
  wanted "$set" || continue
  dest="$COMFY_ROOT/$rel"
  if [[ -f "$dest" ]]; then
    info "have   $(printf '%-30s' "$label") $rel"
  else
    part=0; [[ -f "$dest.part" ]] && part=$(stat -c %s "$dest.part")
    (( part > size )) && part=0
    need=$(( need + size - part ))
    info "get    $(printf '%-30s' "$label") $(printf '%9s' "$(human "$size")")  -> $rel"
  fi
done
for row in "${REPOS[@]}"; do
  IFS='|' read -r set dir url pin <<<"$row"
  wanted "$set" || continue
  if [[ -d "$NODES/$dir/.git" ]]; then info "update node $dir -> ${pin:0:10}"; else info "clone  node $dir @ ${pin:0:10}  ($url)"; fi
done
if (( WANT_TRYON )); then
  if [[ -d "$NODES/$CATVTON_DIR" ]]; then info "have   node $CATVTON_DIR"; else info "unzip  node $CATVTON_DIR  ($CATVTON_ZIP)"; fi
  for row in "${SNAPSHOTS[@]}"; do
    IFS='|' read -r _set label repo rev size _checks <<<"$row"
    if [[ -d "$(hf_cache_dir "$repo")/snapshots/$rev" ]]; then
      info "have   $(printf '%-30s' "$label") hf:$repo"
    else
      need=$(( need + size ))
      info "get    $(printf '%-30s' "$label") $(printf '%9s' "$(human "$size")")  -> hf:$repo@${rev:0:10}"
    fi
  done
fi

seen_fs=""
targets=("$MODELS" "$NODES")
if (( WANT_TRYON )); then
  (( DRY )) || mkdir -p "$(dirname "$(hf_cache_dir x/y)")"
  targets+=("$(dirname "$(hf_cache_dir x/y)")")
fi
for d in "${targets[@]}"; do
  [[ -d "$d" ]] || continue
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
  # torch/torchvision/numpy are owned by ComfyUI: never let a node's requirements move them
  local skip='^(torch|torchvision|torchaudio|tb-nightly|tensorboard|xformers)([^a-z0-9_-]|$)'
  if "$PY" -c 'import cv2' 2>/dev/null; then skip='^(torch|torchvision|torchaudio|tb-nightly|tensorboard|xformers|opencv[-_]python|opencv[-_]python[-_]headless|opencv[-_]contrib[-_]python)([^a-z0-9_-]|$)'; fi
  sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$req" | grep -v '^$' | grep -viE "$skip" > "$filtered" || true
  "$PY" -m pip freeze 2>/dev/null | grep -iE '^(torch|torchvision|torchaudio|numpy|xformers|triton)==' > "$cons" || true
  info "pip (into $COMFY_VENV): $(tr '\n' ' ' < "$filtered")"
  if (( DRY )); then rm -f "$filtered" "$cons"; return 0; fi
  if [[ -s "$filtered" ]] && ! "$PY" -m pip install --quiet -c "$cons" -r "$filtered"; then
    rm -f "$filtered" "$cons"; return 1
  fi
  rm -f "$filtered" "$cons"
}

sync_repo() {  # $1 dir name, $2 url, $3 pinned commit
  local dir="$NODES/$1" url="$2" pin="$3" before after
  if [[ -d "$dir/.git" ]]; then
    before=$(git -C "$dir" rev-parse HEAD)
    run git -C "$dir" fetch --quiet origin || return 1
    if (( LATEST )); then
      run git -C "$dir" pull --ff-only --quiet || return 1
    elif [[ "$before" != "$pin" ]]; then
      run git -C "$dir" checkout --quiet "$pin" || return 1
    fi
    after=$(git -C "$dir" rev-parse HEAD)
    if (( DRY )); then STATUS[$1]="would sync"
    elif [[ "$before" != "$after" ]]; then STATUS[$1]="at ${after:0:10}"; CHANGED=1
    else STATUS[$1]="at ${after:0:10} (no change)"; fi
  elif [[ -e "$dir" ]]; then
    warn "$dir exists but is not a git checkout - leaving it alone"
    STATUS[$1]="exists (not git)"
    return 0
  else
    run git clone --quiet "$url" "$dir" || return 1
    (( LATEST )) || run git -C "$dir" checkout --quiet "$pin" || return 1
    if (( DRY )); then STATUS[$1]="would clone"; else STATUS[$1]="cloned ${pin:0:10}"; CHANGED=1; fi
  fi
  if (( DRY )) && [[ ! -d "$dir" ]]; then info "pip: requirements of $1 after clone"; return 0; fi
  pip_safe_install "$dir" "$dir/requirements.txt"
}

fetch() {  # $1 url, $2 dest, $3 bytes, $4 sha256 (may be empty)
  local url="$1" dest="$2" size="$3" sha="$4" part have
  part="$dest.part"
  if [[ -f "$dest" ]]; then
    have=$(stat -c %s "$dest")
    if (( have == size )); then echo present; return 0; fi
    warn "$dest is $have bytes, expected $size - kept as is"
    echo "present (size differs)"; return 0
  fi
  if (( DRY )); then echo "would download"; return 0; fi
  mkdir -p "$(dirname "$dest")"
  [[ -f "$part" ]] && (( $(stat -c %s "$part") > size )) && rm -f "$part"
  if [[ ! -f "$part" ]] || (( $(stat -c %s "$part") < size )); then
    local auth=()
    if [[ -n "${HF_TOKEN:-}" && "$url" == https://huggingface.co/* ]]; then
      auth=(-H "Authorization: Bearer $HF_TOKEN")
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
  if [[ -n "$sha" ]]; then echo "downloaded (sha256 ok)"; else echo "downloaded (size ok, no published hash)"; fi
}

catvton_deps() {
  # the release zip has no requirements.txt: its pipeline needs accelerate + diffusers, and the auto-masker
  # needs DensePose from detectron2, which has no wheel for current torch, so it builds here (CPU ops only,
  # no CUDA toolkit needed). torch/numpy stay pinned; detectron2 moves omegaconf back to 2.3.
  local cons; cons="$(mktemp)"
  "$PY" -m pip freeze 2>/dev/null | grep -iE '^(torch|torchvision|torchaudio|numpy|xformers|triton)==' > "$cons" || true
  local need=()
  "$PY" -c 'import accelerate' 2>/dev/null || need+=(accelerate)
  "$PY" -c 'import diffusers' 2>/dev/null || need+=(diffusers)
  if (( ${#need[@]} )); then
    info "pip (into $COMFY_VENV): ${need[*]}"
    if (( ! DRY )); then "$PY" -m pip install --quiet -c "$cons" "${need[@]}" || { rm -f "$cons"; return 1; }; CHANGED=1; fi
  fi
  if ! "$PY" -c 'import densepose' 2>/dev/null; then
    info "build  detectron2 + DensePose (CPU ops, a few minutes)"
    if (( ! DRY )); then
      FORCE_CUDA=0 "$PY" -m pip install --quiet --no-build-isolation -c "$cons"         "git+https://github.com/facebookresearch/detectron2.git"         "git+https://github.com/facebookresearch/detectron2.git#subdirectory=projects/DensePose" || { rm -f "$cons"; return 1; }
      CHANGED=1
    fi
  fi
  rm -f "$cons"
}

patch_catvton_abn() {
  # SCHP's in-place batch norm JIT-compiles a CUDA extension on import, which needs the CUDA toolkit; swap in
  # a pure-PyTorch version so the node loads with just the driver and PyTorch
  local f="$NODES/$CATVTON_DIR/model/SCHP/modules/functions.py"
  local ours; ours="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/patches/catvton_inplace_abn_functions.py"
  [[ -f "$f" ]] && grep -q "cpp_extension import load" "$f" || return 0
  if (( DRY )); then info "would patch  $CATVTON_DIR inplace_abn (no CUDA toolkit needed)"; return 0; fi
  cp "$f" "$f.orig" && cp "$ours" "$f" || { warn "couldn't patch $f"; FAILED=1; return 1; }
  info "patched $CATVTON_DIR inplace_abn (original kept as functions.py.orig)"
  STATUS[$CATVTON_DIR]="${STATUS[$CATVTON_DIR]:-present} +patched"; CHANGED=1
}

install_catvton_node() {
  local dir="$NODES/$CATVTON_DIR"
  if [[ -d "$dir" && ! -f "$dir/__init__.py" && -f "$dir/$CATVTON_DIR/__init__.py" ]]; then
    # an earlier install kept the zip's __MACOSX folder, so the node sat one level too deep and never loaded
    if (( DRY )); then STATUS[$CATVTON_DIR]="would flatten"; return 0; fi
    local old="$dir.nested"
    mv "$dir" "$old" && mv "$old/$CATVTON_DIR" "$dir" && rm -rf "$old"
    STATUS[$CATVTON_DIR]="flattened"; CHANGED=1
    pip_safe_install "$dir" "$dir/requirements.txt"
    return
  fi
  if [[ -d "$dir" ]]; then STATUS[$CATVTON_DIR]="present"; return 0; fi
  if (( DRY )); then STATUS[$CATVTON_DIR]="would unzip"; return 0; fi
  local tmp; tmp="$(mktemp -d)"
  curl -L --fail --retry 5 --connect-timeout 30 -s -o "$tmp/node.zip" "$CATVTON_ZIP" || { rm -rf "$tmp"; return 1; }
  if (( $(stat -c %s "$tmp/node.zip") != CATVTON_ZIP_BYTES )); then
    warn "ComfyUI-CatVTON.zip is $(stat -c %s "$tmp/node.zip") bytes, expected $CATVTON_ZIP_BYTES"
    rm -rf "$tmp"; return 1
  fi
  "$PY" -m zipfile -e "$tmp/node.zip" "$tmp/x" || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp/x/__MACOSX"  # Finder metadata the release zip carries
  # the zip may hold one top folder or the files themselves
  local top; mapfile -t top < <(find "$tmp/x" -mindepth 1 -maxdepth 1)
  if (( ${#top[@]} == 1 )) && [[ -d "${top[0]}" ]]; then mv "${top[0]}" "$dir"; else mv "$tmp/x" "$dir"; fi
  rm -rf "$tmp"
  STATUS[$CATVTON_DIR]="unzipped"; CHANGED=1
  pip_safe_install "$dir" "$dir/requirements.txt"
}

snapshot() {  # $1 repo, $2 revision, $3 "file=sha,file=sha"
  local repo="$1" rev="$2" checks="$3" dir
  if (( DRY )); then echo "would download"; return 0; fi
  dir=$("$PY" - "$repo" "$rev" <<'PYEOF'
import sys
from huggingface_hub import snapshot_download

print(snapshot_download(sys.argv[1], revision=sys.argv[2]))
PYEOF
) || { echo "download failed"; return 1; }
  local pair f want got
  IFS=',' read -ra pairs <<<"$checks"
  for pair in "${pairs[@]}"; do
    f="${pair%%=*}"; want="${pair#*=}"
    got=$(sha256sum "$dir/$f" | cut -d' ' -f1)
    if [[ "$got" != "$want" ]]; then echo "sha256 mismatch on $f"; return 1; fi
  done
  echo "in HF cache (sha256 ok)"
}

# ---------------------------------------------------------------- custom nodes
say "Custom nodes"
for row in "${REPOS[@]}"; do
  IFS='|' read -r set dir url pin <<<"$row"
  wanted "$set" || continue
  if ! sync_repo "$dir" "$url" "$pin"; then STATUS[$dir]="FAILED"; FAILED=1; warn "$dir failed"; fi
done
if (( WANT_TRYON )); then
  if ! install_catvton_node; then STATUS[$CATVTON_DIR]="FAILED"; FAILED=1; warn "$CATVTON_DIR failed"; fi
  patch_catvton_abn
  catvton_deps || { FAILED=1; warn "CatVTON's Python packages failed"; }
fi

# ---------------------------------------------------------------- models
say "Models"
for row in "${FILES[@]}"; do
  IFS='|' read -r set label url rel size sha <<<"$row"
  wanted "$set" || continue
  if res=$(fetch "$url" "$COMFY_ROOT/$rel" "$size" "$sha"); then
    STATUS[$rel]="$res"
    [[ "$res" == downloaded* ]] && CHANGED=1
  else
    STATUS[$rel]="FAILED: $res"; FAILED=1
  fi
  info "$(printf '%-30s' "$label") ${STATUS[$rel]}"
done
if (( WANT_TRYON )); then
  for row in "${SNAPSHOTS[@]}"; do
    IFS='|' read -r _set label repo rev _size checks <<<"$row"
    if res=$(snapshot "$repo" "$rev" "$checks"); then STATUS[$repo]="$res"; else STATUS[$repo]="FAILED: $res"; FAILED=1; fi
    info "$(printf '%-30s' "$label") ${STATUS[$repo]}"
  done
fi

# ---------------------------------------------------------------- summary
say "Summary"
printf '    %-8s %-30s %10s  %-34s %s\n' SET ITEM SIZE STATUS PATH
for row in "${REPOS[@]}"; do
  IFS='|' read -r set dir _url pin <<<"$row"
  wanted "$set" || continue
  printf '    %-8s %-30s %10s  %-34s %s\n' "$set" "node $dir" "-" "${STATUS[$dir]:-?}" "custom_nodes/$dir (pin ${pin:0:10})"
done
if (( WANT_TRYON )); then
  printf '    %-8s %-30s %10s  %-34s %s\n' tryon "node $CATVTON_DIR" "$(human $CATVTON_ZIP_BYTES)" "${STATUS[$CATVTON_DIR]:-?}" "custom_nodes/$CATVTON_DIR"
fi
for row in "${FILES[@]}"; do
  IFS='|' read -r set label _url rel size _sha <<<"$row"
  wanted "$set" || continue
  printf '    %-8s %-30s %10s  %-34s %s\n' "$set" "$label" "$(human "$size")" "${STATUS[$rel]:-?}" "$rel"
done
if (( WANT_TRYON )); then
  for row in "${SNAPSHOTS[@]}"; do
    IFS='|' read -r set label repo rev size _checks <<<"$row"
    printf '    %-8s %-30s %10s  %-34s %s\n' "$set" "$label" "~$(human "$size")" "${STATUS[$repo]:-?}" "hf:$repo@${rev:0:10}"
  done
fi

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

PENDING="$COMFY_ROOT/.mixai-image-tools-restart-pending"
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
        # newer ComfyUI lists models/unet under its new name
        [[ "$folder" == unet ]] && out+=$(curl -sf "$base/models/diffusion_models" || true)
        if grep -qF "\"$name\"" <<<"$out"; then r=OK; else r=MISSING; FAILED=1; fi
        printf '    %-8s model %s/%s\n' "$r" "$folder" "$name" ;;
    esac
  done
done
info "Paste the input specs for the CatVTON / IC-Light / inpaint nodes back to the team:"
info "  curl -s http://127.0.0.1:${PORTS[0]:-8188}/object_info/CatVTON  (and AutoMasker, LoadCatVTONPipeline, LightSource)"
if (( WANT_CONTROL )); then
  info "and the ControlNet ones (contract v31 assumes their inputs):"
  info "  curl -s http://127.0.0.1:${PORTS[0]:-8188}/object_info/QwenImageDiffsynthControlnet  (and ModelPatchLoader, DWPreprocessor, ZImageFunControlnet)"
fi

if (( FAILED )); then
  warn "something is MISSING or FAILED above. Logs: journalctl -u comfyui -n 200 (and comfyui-gpu1)"
  exit 1
fi
say "Done."
