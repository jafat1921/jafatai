#!/usr/bin/env bash
# Mix AI Cinema Studio - test-mode text-to-image models for the IMAGE GPU's ComfyUI (contract v32).
#
#   ./scripts/install-image-models.sh --list                 # what each flag installs, sizes and licences
#   ./scripts/install-image-models.sh --all --dry-run        # show everything it would do
#   ./scripts/install-image-models.sh --illustrious --realvis --zimage-base
#
#   --krea2        Krea 2 Turbo fp8 + Qwen3-VL 4B encoder (+ Qwen-Image VAE)   ~18 GB  CONDITIONAL (Krea 2 Community)
#   --krea2-raw    Krea 2 Raw fp8 (52-step speed); implies --krea2             ~13 GB  CONDITIONAL
#   --hidream      HiDream-O1-Image Dev fp8 (all-in-one checkpoint)            ~8 GB   MIT
#   --hidream-full HiDream-O1-Image Full fp8 (40-step speed); implies --hidream ~8 GB  MIT
#   --anima        Anima Base v1.0 + Qwen3 0.6B + turbo LoRA (+ VAE)           ~5.6 GB NON-COMMERCIAL weights
#   --illustrious  Illustrious XL v2.0 (SDXL checkpoint)                       ~6.9 GB CreativeML OpenRAIL-M
#   --realvis      RealVisXL V5.0 fp16 + SDXL-Lightning 8-step LoRA            ~7.3 GB OpenRAIL++
#   --klein9b      FLUX.2 klein 9B fp8 + Qwen3 8B fp8mixed (GATED, HF_TOKEN)   ~18 GB  NON-COMMERCIAL
#   --qwen21       Qwen-Image 2.1 Turbo int8 + Qwen3-VL 8B int8 + 2.1 VAE      ~17 GB  NON-COMMERCIAL (research)
#   --qwen21-full  Qwen-Image 2.1 base int8 (25-step speed); implies --qwen21  ~7.3 GB NON-COMMERCIAL
#   --ernie        ERNIE-Image Turbo (bf16, loaded as fp8) + Ministral 3 3B    ~24 GB  Apache-2.0
#   --zimage-base  Z-Image base bf16 (shares Turbo's encoder and VAE)          ~12 GB  Apache-2.0
#   --chroma       Chroma1-HD fp8mixed + T5-XXL fp8 scaled (shares ae VAE)     ~14 GB  Apache-2.0
#   --all          every set above (~150 GB before shared files are skipped)
#   --list         print the catalogue and exit
#   --dry-run      print what would happen, change nothing
#   --no-restart   skip the ComfyUI restart + API check
#
# Wan 2.2 "Cinematic still" needs nothing new: it reuses the installed wan22_t2v weights.
# Safe to re-run: files already present with the right size are skipped, partial downloads resume, every file is
# checked against its sha256 (Hugging Face LFS oid, read from the HF API on 2026-10-14 at the pinned revision).
# The one exception is FLUX.2 klein 9B's diffusion model: the repo is gated, so its hash can't be read without
# access; the script asks the HF API for it with your token at download time and checks against that.
# Env: COMFY_ROOT, COMFY_VENV (not needed here), HF_TOKEN (only --klein9b needs it; read from the environment,
# never written anywhere). Licences: docs/api/contract-v32-image-models.md
set -euo pipefail

declare -A WANT=()
DRY=0 RESTART=1 LIST=0
FREE_MARGIN=$((10 * 1024 * 1024 * 1024))
SETS=(krea2 krea2raw hidream hidreamfull anima illustrious realvis klein9b qwen21 qwen21full ernie zimagebase chroma)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --krea2) WANT[krea2]=1 ;;
    --krea2-raw) WANT[krea2raw]=1; WANT[krea2]=1 ;;
    --hidream) WANT[hidream]=1 ;;
    --hidream-full) WANT[hidreamfull]=1; WANT[hidream]=1 ;;
    --anima) WANT[anima]=1 ;;
    --illustrious) WANT[illustrious]=1 ;;
    --realvis) WANT[realvis]=1 ;;
    --klein9b) WANT[klein9b]=1 ;;
    --qwen21) WANT[qwen21]=1 ;;
    --qwen21-full) WANT[qwen21full]=1; WANT[qwen21]=1 ;;
    --ernie) WANT[ernie]=1 ;;
    --zimage-base) WANT[zimagebase]=1 ;;
    --chroma) WANT[chroma]=1 ;;
    --all) for s in "${SETS[@]}"; do WANT[$s]=1; done ;;
    --list) LIST=1 ;;
    --dry-run) DRY=1 ;;
    --no-restart) RESTART=0 ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[0;33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31mxx %s\033[0m\n' "$*" >&2; exit 1; }
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "${1}B"; }
wanted() { [[ -n "${WANT[$1]:-}" ]]; }

# ---------------------------------------------------------------- the catalogue
HF=https://huggingface.co
KREA="$HF/Comfy-Org/Krea-2/resolve/eb1eddd3983a54678545a9b2c178c5853b30f7be"
HIDREAM="$HF/Comfy-Org/HiDream-O1-Image/resolve/377ec7124bc46a15736c68cd9e4ad6d7da7a7614"
ANIMA="$HF/circlestone-labs/Anima/resolve/f973fc41ec7545364ac9776c2440285f43ff2a30/split_files"
ANIMA_LORAS="$HF/circlestone-labs/Anima-Official-LoRAs/resolve/218b5466a07e8a79328dd8b73ff810706d73cb86"
ILLUSTRIOUS="$HF/OnomaAIResearch/Illustrious-XL-v2.0/resolve/69459c1fe6f46db41ab31e6114f05acc0e06bcaa"
REALVIS="$HF/SG161222/RealVisXL_V5.0/resolve/ac93e0dda1f6d448cae19bbfab8c5e720a5e48bc"
LIGHTNING="$HF/ByteDance/SDXL-Lightning/resolve/c9a24f48e1c025556787b0c58dd67a091ece2e44"
KLEIN9B="$HF/black-forest-labs/FLUX.2-klein-9b-fp8/resolve/902d9d510b51533e07729f19211414a3648b77d2"
KLEIN9B_TE="$HF/Comfy-Org/vae-text-encorder-for-flux-klein-9b/resolve/3f62d9d8ae1fec33c6e91453d5c712855b096b55/split_files"
QWEN21="$HF/Comfy-Org/Qwen-Image-2.1/resolve/a8342359c61979b06a8dafb1a47991fe1f30e994"
ERNIE="$HF/Comfy-Org/ERNIE-Image/resolve/82fe29a5cd056f8b1deebc50570f125bcd4f4bea"
ZIMAGE="$HF/Comfy-Org/z_image/resolve/94d47a468ec820d29a5dc09d4642539d76d49542/split_files"
CHROMA="$HF/Comfy-Org/Chroma1-HD_repackaged/resolve/409cfff960d66598d4d0ff46cb932f53492cc6d9/split_files"
T5="$HF/comfyanonymous/flux_text_encoders/resolve/6af2a98e3f615bdfa612fbd85da93d1ed5f69ef5"

# set|label|url|path under models/|bytes|sha256 (empty = gated, read at download time)
# Shared files (the Qwen-Image VAE, Z-Image's encoder and ae VAE) are listed under each set that needs them and
# skipped when already on disk.
FILES=(
  "krea2|Krea 2 Turbo fp8|$KREA/diffusion_models/krea2_turbo_fp8_scaled.safetensors|diffusion_models/krea2_turbo_fp8_scaled.safetensors|13141730784|eb4dd8c612cfd10f64f25b057e6e6bbcb5737c94a7372177e456dbf7579502f1"
  "krea2|Qwen3-VL 4B fp8 (Krea 2)|$KREA/text_encoders/qwen3vl_4b_fp8_scaled.safetensors|text_encoders/qwen3vl_4b_fp8_scaled.safetensors|5242467968|54bd5144df0bbc25dd6ccadfcb826b521445a1b06ae5a42570bdd2974ca87094"
  "krea2|Qwen-Image VAE|$KREA/vae/qwen_image_vae.safetensors|vae/qwen_image_vae.safetensors|253806246|a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f"
  "krea2raw|Krea 2 Raw fp8|$KREA/diffusion_models/krea2_raw_fp8_scaled.safetensors|diffusion_models/krea2_raw_fp8_scaled.safetensors|13141730784|48cd5d6c100297968349b41a8e77c6591d1dac18a215807f5f25f59e5c54cd61"
  "hidream|HiDream-O1 Dev fp8|$HIDREAM/checkpoints/hidream_o1_image_dev_fp8_scaled.safetensors|checkpoints/hidream_o1_image_dev_fp8_scaled.safetensors|8067535296|7cbf53a475e0a13f92f2ec08bcffdb9b9de4305ef3b6f35cdd784d09dcd8d0cc"
  "hidreamfull|HiDream-O1 Full fp8|$HIDREAM/checkpoints/hidream_o1_image_fp8_scaled.safetensors|checkpoints/hidream_o1_image_fp8_scaled.safetensors|8067535296|05ad98bc4a94557697f31b839f6dbf6dba293a353d9e3c52eef7818b5802d206"
  "anima|Anima Base v1.0|$ANIMA/diffusion_models/anima-base-v1.0.safetensors|diffusion_models/anima-base-v1.0.safetensors|4182218328|bd43b7cffe1ed1153d9c41e7beb2f18cb1273eafbaa3af3edd6a173dc90a006e"
  "anima|Qwen3 0.6B base (Anima)|$ANIMA/text_encoders/qwen_3_06b_base.safetensors|text_encoders/qwen_3_06b_base.safetensors|1192135096|cd2a512003e2f9f3cd3c32a9c3573f820bb28c940f73c57b1ddaa983d9223eba"
  "anima|Qwen-Image VAE|$ANIMA/vae/qwen_image_vae.safetensors|vae/qwen_image_vae.safetensors|253806246|a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f"
  "anima|Anima turbo LoRA v0.2|$ANIMA_LORAS/anima-turbo-lora-v0.2.safetensors|loras/anima-turbo-lora-v0.2.safetensors|148902616|1b55e40bdb1d0e5a78cb498f245fccfdaae97823265db957d2aabdcf4cd3caf1"
  "illustrious|Illustrious XL v2.0|$ILLUSTRIOUS/Illustrious-XL-v2.0.safetensors|checkpoints/Illustrious-XL-v2.0.safetensors|6938040674|c2a1a3eaa13d4c107dc7e00c3fe830cab427aa026362740ea094745b3422a331"
  "realvis|RealVisXL V5.0 fp16|$REALVIS/RealVisXL_V5.0_fp16.safetensors|checkpoints/RealVisXL_V5.0_fp16.safetensors|6938065488|6a35a7855770ae9820a3c931d4964c3817b6d9e3c6f9c4dabb5b3a94e5643b80"
  "realvis|SDXL-Lightning 8-step LoRA|$LIGHTNING/sdxl_lightning_8step_lora.safetensors|loras/sdxl_lightning_8step_lora.safetensors|393854592|5aa30d94cdf7950a8b53a693682650ee061eddb128c5435a8f88defea73b2ac6"
  "klein9b|FLUX.2 klein 9B fp8 (gated)|$KLEIN9B/flux-2-klein-9b-fp8.safetensors|diffusion_models/flux-2-klein-9b-fp8.safetensors|9433061528|"
  "klein9b|Qwen3 8B fp8mixed (klein 9B)|$KLEIN9B_TE/text_encoders/qwen_3_8b_fp8mixed.safetensors|text_encoders/qwen_3_8b_fp8mixed.safetensors|8664848742|abad16806e0cbabc54e0325d6565847443fe396d5f0be38bb3cd3fe75a1201d6"
  # byte-identical to the FLUX.2 klein 4B copy, so an existing one is reused
  "klein9b|FLUX.2 VAE|$KLEIN9B_TE/vae/flux2-vae.safetensors|vae/flux2-vae.safetensors|336211292|868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3"
  "qwen21|Qwen-Image 2.1 Turbo int8|$QWEN21/diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors|diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors|7256787829|8144a0182964aa8403ad6dbc011db837304167d235161b9aabaa8532e967314c"
  "qwen21|Qwen3-VL 8B int8 (Qwen 2.1)|$QWEN21/text_encoders/qwen3vl_8b_int8_convrot.safetensors|text_encoders/qwen3vl_8b_int8_convrot.safetensors|9350798360|8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f"
  "qwen21|Qwen-Image 2.1 VAE|$QWEN21/vae/qwen_image_2.1_vae_bf16.safetensors|vae/qwen_image_2.1_vae_bf16.safetensors|675509688|bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"
  "qwen21full|Qwen-Image 2.1 base int8|$QWEN21/diffusion_models/qwen_image_2.1_int8_convrot.safetensors|diffusion_models/qwen_image_2.1_int8_convrot.safetensors|7256783064|cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d"
  "ernie|ERNIE-Image Turbo bf16|$ERNIE/diffusion_models/ernie-image-turbo.safetensors|diffusion_models/ernie-image-turbo.safetensors|16067025480|741a4cc0467d4b9f04490d7faa9a5869ff4aa97eb2914927a1df9abb070e8e52"
  "ernie|Ministral 3 3B (ERNIE)|$ERNIE/text_encoders/ministral-3-3b.safetensors|text_encoders/ministral-3-3b.safetensors|7717637511|49a750a128863854eac7d85e1a277a7b44bf6ec3646405b84686dfeeca3708ca"
  # ERNIE's flux2-vae.safetensors is 2 KB off the klein one; kept under its own name so neither overwrites the other
  "ernie|FLUX.2 VAE (ERNIE copy)|$ERNIE/vae/flux2-vae.safetensors|vae/flux2-vae-ernie.safetensors|336213556|d64f3a68e1cc4f9f4e29b6e0da38a0204fe9a49f2d4053f0ec1fa1ca02f9c4b5"
  "zimagebase|Z-Image base bf16|$ZIMAGE/diffusion_models/z_image_bf16.safetensors|diffusion_models/z_image_bf16.safetensors|12309866400|996a67d3ff666946b1c25cbc16d1b1918b6cc0ac166309e23fe3b3d830263dee"
  "zimagebase|Qwen3 4B (Z-Image)|$ZIMAGE/text_encoders/qwen_3_4b.safetensors|text_encoders/qwen_3_4b.safetensors|8044982048|6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a"
  "zimagebase|ae VAE|$ZIMAGE/vae/ae.safetensors|vae/ae.safetensors|335304388|afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"
  "chroma|Chroma1-HD fp8mixed|$CHROMA/diffusion_models/Chroma1-HD-fp8mixed.safetensors|diffusion_models/Chroma1-HD-fp8mixed.safetensors|9193379316|a2928ca6075f308f4d5e2182e2b96120fa8ad270ec6ea9b1b5c724c85c49a575"
  "chroma|T5-XXL fp8 scaled (Chroma)|$T5/t5xxl_fp8_e4m3fn_scaled.safetensors|text_encoders/t5xxl_fp8_e4m3fn_scaled.safetensors|5157348688|a498f0485dc9536735258018417c3fd7758dc3bccc0a645feaa472b34955557a"
  "chroma|ae VAE|$ZIMAGE/vae/ae.safetensors|vae/ae.safetensors|335304388|afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"
)

# set|app model|licence|nc (1 = non-commercial or revenue-capped weights)
LICENCES=(
  "krea2|Krea 2 Turbo|Krea 2 Community Licence: commercial use only under US\$1M revenue, content filtering required|1"
  "krea2raw|Krea 2 Raw|Krea 2 Community Licence (as above)|1"
  "hidream|HiDream-O1-Image Dev|MIT|0"
  "hidreamfull|HiDream-O1-Image Full|MIT|0"
  "anima|Anima|CircleStone Labs Non-Commercial Licence (outputs may be used commercially); encoder Apache-2.0|1"
  "illustrious|Illustrious XL v2.0|CreativeML OpenRAIL-M|0"
  "realvis|RealVisXL V5.0 + SDXL-Lightning|CreativeML OpenRAIL++-M (both)|0"
  "klein9b|FLUX.2 klein 9B|FLUX Non-Commercial Licence|1"
  "qwen21|Qwen-Image 2.1 Turbo|Qwen Research Licence: research / evaluation only|1"
  "qwen21full|Qwen-Image 2.1 base|Qwen Research Licence: research / evaluation only|1"
  "ernie|ERNIE-Image Turbo|Apache-2.0|0"
  "zimagebase|Z-Image (base)|Apache-2.0|0"
  "chroma|Chroma1-HD|Apache-2.0 (T5-XXL: Apache-2.0)|0"
)

# what the restarted ComfyUI must report: node:<class>, enum:<class>:<input>:<value>, model:<folder>:<file>
CHECKS=(
  "krea2|enum:CLIPLoader:type:krea2"
  "hidream|node:EmptyHiDreamO1LatentImage"
  "hidream|node:ModelNoiseScale"
  "hidream|node:SamplerLCM"
  "hidreamfull|node:HiDreamO1PatchSeamSmoothing"
  "qwen21|node:TextEncodeQwenImage21"
  "qwen21|node:QwenImage21Cache"
  "chroma|node:T5TokenizerOptions"
  "chroma|enum:CLIPLoader:type:chroma"
)
for row in "${FILES[@]}"; do
  IFS='|' read -r set _label _url rel _size _sha <<<"$row"
  CHECKS+=("$set|model:${rel%%/*}:${rel#*/}")
done

licence_of() {  # $1 set -> "licence|nc"
  local row s _m lic nc
  for row in "${LICENCES[@]}"; do
    IFS='|' read -r s _m lic nc <<<"$row"
    [[ "$s" == "$1" ]] && { echo "$lic|$nc"; return; }
  done
}

# ---------------------------------------------------------------- --list
if (( LIST )); then
  say "Catalogue (contract v32). Flags: --krea2 --krea2-raw --hidream --hidream-full --anima --illustrious --realvis"
  info "--klein9b --qwen21 --qwen21-full --ernie --zimage-base --chroma, or --all"
  for set in "${SETS[@]}"; do
    total=0
    for row in "${FILES[@]}"; do
      IFS='|' read -r s _l _u _r size _h <<<"$row"
      [[ "$s" == "$set" ]] && total=$((total + size))
    done
    IFS='|' read -r lic nc <<<"$(licence_of "$set")"
    printf '\n    %-12s %9s  %s%s\n' "$set" "$(human "$total")" "$lic" "$( (( nc )) && echo '  [NON-COMMERCIAL / CAPPED]')"
    for row in "${FILES[@]}"; do
      IFS='|' read -r s label _u rel size sha <<<"$row"
      [[ "$s" == "$set" ]] || continue
      printf '      %-32s %9s  models/%s%s\n' "$label" "$(human "$size")" "$rel" "$([[ -z "$sha" ]] && echo '  (gated: HF_TOKEN)')"
    done
  done
  echo
  info "Shared files (Qwen-Image VAE, Qwen3 4B, ae VAE, flux2-vae) are skipped when ComfyUI already has them."
  exit 0
fi

any=0; for s in "${SETS[@]}"; do wanted "$s" && any=1; done
(( any )) || die "pick at least one model set (try --list or --help)"

# ---------------------------------------------------------------- locate ComfyUI (same rules as install-image-tools.sh)
svc_exec() { systemctl show -p ExecStart --value "$1" 2>/dev/null || true; }
if [[ -z "${COMFY_ROOT:-}" ]]; then
  if [[ -d /data/apps/ComfyUI/models ]]; then
    COMFY_ROOT=/data/apps/ComfyUI
  else
    COMFY_ROOT="$(systemctl show -p WorkingDirectory --value comfyui.service 2>/dev/null || true)"
  fi
fi
[[ -n "$COMFY_ROOT" && -d "$COMFY_ROOT/models" ]] || die "ComfyUI not found; set COMFY_ROOT=/path/to/ComfyUI"
MODELS="$COMFY_ROOT/models"
if [[ $EUID -eq 0 && "${ALLOW_ROOT:-0}" != 1 ]]; then
  die "run this as the user that owns $COMFY_ROOT (e.g. gpu), not root; it uses sudo only for systemctl. ALLOW_ROOT=1 to override"
fi

# where an existing copy may already live: newer ComfyUI calls models/unet diffusion_models, clip text_encoders
have_file() {  # $1 rel path -> prints the path that exists
  local rel="$1" folder="${1%%/*}" name="${1#*/}" alt
  case "$folder" in diffusion_models) alt=unet ;; text_encoders) alt=clip ;; *) alt="" ;; esac
  if [[ -f "$MODELS/$rel" ]]; then echo "$MODELS/$rel"; return 0; fi
  if [[ -n "$alt" && -f "$MODELS/$alt/$name" ]]; then echo "$MODELS/$alt/$name"; return 0; fi
  return 1
}

# ---------------------------------------------------------------- licence notes
say "Licences"
for set in "${SETS[@]}"; do
  wanted "$set" || continue
  IFS='|' read -r lic nc <<<"$(licence_of "$set")"
  if (( nc )); then
    warn "$set: $lic"
  else
    info "$set: $lic"
  fi
done
nc_any=0
for s in krea2 krea2raw anima klein9b qwen21 qwen21full; do wanted "$s" && nc_any=1; done
if (( nc_any )); then
  warn "NON-COMMERCIAL / revenue-capped weights above. The app offers them only while IMAGE_ALLOW_NONCOMMERCIAL=true"
  warn "(the test-mode default). Turn it off before any commercial launch; the cards carry the licence either way."
fi

# ---------------------------------------------------------------- gated repos
GATED_OK=1
if wanted klein9b; then
  say "Gated repo: black-forest-labs/FLUX.2-klein-9b-fp8"
  if [[ -z "${HF_TOKEN:-}" ]]; then
    GATED_OK=0
    warn "HF_TOKEN is not set, so the 9B diffusion model will be skipped. To get it:"
    warn "  1. sign in at https://huggingface.co/black-forest-labs/FLUX.2-klein-9b-fp8 and accept the licence"
    warn "  2. make a read token at https://huggingface.co/settings/tokens"
    warn "  3. HF_TOKEN=hf_... ./scripts/install-image-models.sh --klein9b   (the token is only read, never saved)"
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' -I -H "Authorization: Bearer $HF_TOKEN" \
      "$KLEIN9B/flux-2-klein-9b-fp8.safetensors" || true)
    if [[ "$code" =~ ^(200|302|307)$ ]]; then
      info "HF_TOKEN has access (HTTP $code)"
    else
      GATED_OK=0
      warn "HF answered HTTP $code with your HF_TOKEN: accept the licence at"
      warn "  https://huggingface.co/black-forest-labs/FLUX.2-klein-9b-fp8 with the same account, then re-run."
    fi
  fi
fi

# ---------------------------------------------------------------- plan + disk check
declare -A SEEN=()
say "Plan  (ComfyUI: $COMFY_ROOT)"
need=0
for row in "${FILES[@]}"; do
  IFS='|' read -r set label _url rel size sha <<<"$row"
  wanted "$set" || continue
  [[ -n "${SEEN[$rel]:-}" ]] && continue
  SEEN[$rel]=1
  if p=$(have_file "$rel"); then
    info "have   $(printf '%-32s' "$label") ${p#"$MODELS/"}"
  elif [[ -z "$sha" ]] && (( ! GATED_OK )); then
    info "skip   $(printf '%-32s' "$label") (gated, no access yet)"
  else
    dest="$MODELS/$rel"; part=0
    [[ -f "$dest.part" ]] && part=$(stat -c %s "$dest.part")
    (( part > size )) && part=0
    need=$(( need + size - part ))
    info "get    $(printf '%-32s' "$label") $(printf '%9s' "$(human "$size")")  -> models/$rel"
  fi
done
avail=$(df -B1 --output=avail "$MODELS" | tail -1 | tr -d ' ')
info "free on $(df --output=target "$MODELS" | tail -1): $(human "$avail"), to download: $(human "$need") (+10G headroom)"
if (( avail < need + FREE_MARGIN )); then
  if (( DRY )); then warn "not enough free space - a real run would stop here"
  else die "not enough disk space: need $(human $((need + FREE_MARGIN))), have $(human "$avail")"; fi
fi

# ---------------------------------------------------------------- downloads
declare -A STATUS=()
CHANGED=0 FAILED=0

gated_sha() {  # the LFS sha256 HF reports for a gated file, with the caller's token
  curl -sI -H "Authorization: Bearer $HF_TOKEN" "$1" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-linked-etag"{gsub(/"/,"",$2); print $2}' | tail -1
}

fetch() {  # $1 url, $2 rel, $3 bytes, $4 sha256 (empty: gated)
  local url="$1" rel="$2" size="$3" sha="$4" dest="$MODELS/$2" part have got
  part="$dest.part"
  if p=$(have_file "$rel"); then
    have=$(stat -c %s "$p")
    if (( have == size )); then echo present; return 0; fi
    warn "$p is $have bytes, expected $size - kept as is (delete it to fetch the pinned file)"
    echo "present (size differs)"; return 0
  fi
  if [[ -z "$sha" ]]; then
    (( GATED_OK )) || { echo "skipped (gated: see above)"; return 0; }
    if (( ! DRY )); then
      sha=$(gated_sha "$url")
      [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "couldn't read the sha256 from HF"; return 1; }
      info "sha256 from the HF API: $sha" >&2
    fi
  fi
  if (( DRY )); then echo "would download"; return 0; fi
  mkdir -p "$(dirname "$dest")"
  [[ -f "$part" ]] && (( $(stat -c %s "$part") > size )) && rm -f "$part"
  if [[ ! -f "$part" ]] || (( $(stat -c %s "$part") < size )); then
    local auth=()
    [[ -n "${HF_TOKEN:-}" ]] && auth=(-H "Authorization: Bearer $HF_TOKEN")
    printf '    downloading %s\n' "$(basename "$dest")" >&2
    if ! curl -L --fail --retry 5 --retry-delay 5 --connect-timeout 30 -C - -# "${auth[@]}" -o "$part" "$url" >&2; then
      echo "download failed"; return 1
    fi
  fi
  have=$(stat -c %s "$part")
  if (( have != size )); then echo "size $have != $size (left $part)"; return 1; fi
  printf '    checking sha256 of %s\n' "$(basename "$dest")" >&2
  got=$(sha256sum "$part" | cut -d' ' -f1)
  if [[ "$got" != "$sha" ]]; then rm -f "$part"; echo "sha256 mismatch (deleted)"; return 1; fi
  mv -f "$part" "$dest"
  echo "downloaded (sha256 ok)"
}

say "Models"
SEEN=()
for row in "${FILES[@]}"; do
  IFS='|' read -r set label url rel size sha <<<"$row"
  wanted "$set" || continue
  [[ -n "${SEEN[$rel]:-}" ]] && continue
  SEEN[$rel]=1
  if res=$(fetch "$url" "$rel" "$size" "$sha"); then
    STATUS[$rel]="$res"
    [[ "$res" == downloaded* ]] && CHANGED=1
  else
    STATUS[$rel]="FAILED: $res"; FAILED=1
  fi
  info "$(printf '%-32s' "$label") ${STATUS[$rel]}"
done

# ---------------------------------------------------------------- summary
say "Summary"
printf '    %-12s %-32s %10s  %-28s %s\n' SET FILE SIZE STATUS LICENCE
SEEN=()
for row in "${FILES[@]}"; do
  IFS='|' read -r set label _url rel size _sha <<<"$row"
  wanted "$set" || continue
  [[ -n "${SEEN[$rel]:-}" ]] && continue
  SEEN[$rel]=1
  IFS='|' read -r lic nc <<<"$(licence_of "$set")"
  printf '    %-12s %-32s %10s  %-28s %s\n' "$set" "$label" "$(human "$size")" "${STATUS[$rel]:-?}" \
    "$( (( nc )) && echo 'NC: ')${lic:0:60}"
done

if (( DRY )); then
  say "Dry run: nothing changed. Re-run without --dry-run to install."
  exit 0
fi

# ---------------------------------------------------------------- restart + verify
if (( ! RESTART )); then
  say "Skipping restart (--no-restart). Restart ComfyUI yourself so it lists the new files."
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

PENDING="$COMFY_ROOT/.mixai-image-models-restart-pending"
(( CHANGED )) && touch "$PENDING"
if [[ -f "$PENDING" ]]; then
  say "Restarting: ${UNITS[*]}"
  if ! sudo systemctl restart "${UNITS[@]}"; then
    warn "restart failed (sudo?). Run: sudo systemctl restart ${UNITS[*]}"
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
      enum:*)
        IFS=':' read -r _ cls field value <<<"$check"
        out=$(curl -sf "$base/object_info/$cls" || true)
        if grep -qF "\"$value\"" <<<"$out"; then r=OK; else r=MISSING; FAILED=1; fi
        printf '    %-8s %s.%s offers %s\n' "$r" "$cls" "$field" "$value" ;;
      model:*)
        rest="${check#model:}"; folder="${rest%%:*}"; name="${rest#*:}"
        [[ "$set" == klein9b && "$name" == flux-2-klein-9b-fp8.safetensors ]] && (( ! GATED_OK )) && continue
        out=$(curl -sf "$base/models/$folder" || true)
        # newer ComfyUI lists models/unet under its new name (and clip under text_encoders)
        [[ "$folder" == diffusion_models ]] && out+=$(curl -sf "$base/models/unet" || true)
        [[ "$folder" == text_encoders ]] && out+=$(curl -sf "$base/models/clip" || true)
        if grep -qF "\"$name\"" <<<"$out"; then r=OK; else r=MISSING; FAILED=1; fi
        printf '    %-8s model %s/%s\n' "$r" "$folder" "$name" ;;
    esac
  done
done
info "Paste these back to the team (contract v32 assumes their inputs):"
info "  curl -s http://127.0.0.1:${PORTS[0]:-8188}/object_info/TextEncodeQwenImage21   (and QwenImage21Cache, SamplerLCM,"
info "  ModelNoiseScale, HiDreamO1PatchSeamSmoothing, EmptyHiDreamO1LatentImage, T5TokenizerOptions)"
info "then open Create Image: GET /api/models?type=image shows each model as available or 'Not installed'."

if (( FAILED )); then
  warn "something is MISSING or FAILED above. Logs: journalctl -u comfyui -n 200 (and comfyui-gpu1)"
  exit 1
fi
(( GATED_OK )) || { warn "done, but FLUX.2 klein 9B was skipped (gated) - see the steps above"; exit 0; }
say "Done."
