#!/usr/bin/env bash
# Pre-downloads the Voice studio models into each engine venv's cache, so the first real job doesn't
# spend its timeout downloading. Run as the user the workers run as (gpu). Safe to re-run.
#   ./scripts/install-voice-models.sh            all engines
#   ./scripts/install-voice-models.sh omnivoice  just one (omnivoice voxcpm chatterbox kokoro whisper)
set -uo pipefail

VENVS="${AUDIO_VENVS_DIR:-/data/venvs}"
LOG="${LOG:-/data/logs/voice_models.log}"
want="${1:-all}"
failed=()

run() {
  local name=$1 venv=$2 code=$3
  [[ $want == all || $want == "$name" ]] || return 0
  local py="$VENVS/$venv/bin/python"
  if [[ ! -x $py ]]; then
    echo "!! $name: $py not found (run step12_audio_tools.sh first)"; failed+=("$name"); return
  fi
  echo "==> $name ($venv)"
  # loading on the CPU is enough to fetch everything and proves the package imports
  local out rc
  out=$(CUDA_VISIBLE_DEVICES="" "$py" -c "$code" 2>&1); rc=$?
  printf '%s\n' "$out" | tail -n 5
  if (( rc == 0 )); then echo "    OK $name"; else echo "!! $name failed (exit $rc)"; failed+=("$name"); fi
}

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
{
run omnivoice tts-omnivoice "
from omnivoice import OmniVoice
m = OmniVoice.from_pretrained('k2-fsa/OmniVoice')
print('sample rate:', getattr(m, 'sampling_rate', None) or getattr(getattr(m, 'config', None), 'sampling_rate', None))"

run voxcpm tts-voxcpm "
from voxcpm import VoxCPM
m = VoxCPM.from_pretrained('openbmb/VoxCPM2', load_denoiser=True, device='cpu', optimize=False)
print('sample rate:', m.tts_model.sample_rate)"

run chatterbox tts-chatterbox "
from chatterbox.tts import ChatterboxTTS
from chatterbox.mtl_tts import ChatterboxMultilingualTTS
import torch
ChatterboxTTS.from_pretrained(device='cpu')
ChatterboxMultilingualTTS.from_pretrained(device=torch.device('cpu'))
print('english + multilingual ready')"

run kokoro tts-kokoro "
from huggingface_hub import snapshot_download
print(snapshot_download('hexgrad/Kokoro-82M'))"

run whisper stt-whisperx "
from faster_whisper import download_model
print(download_model('large-v3'))"

echo
if (( ${#failed[@]} )); then echo "Done with failures: ${failed[*]}"; else echo "All voice models ready."; fi
du -sh ~/.cache/huggingface 2>/dev/null || true
} 2>&1 | tee -a "$LOG"
