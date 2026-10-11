"""The worker run as `python -m app.worker` must be the same module the handlers import."""
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]

PROBE = """
import runpy, sys
sys.argv = ["app.worker", "--lanes", "not-a-lane"]
try:
    runpy.run_module("app.worker", run_name="__main__", alter_sys=True)
except SystemExit:
    pass
from app import worker
from app.podcast import video_stages
# the copy the handlers reach is the one that ran as __main__, so its JobDeferred is the one caught
print(worker.__name__, video_stages._w() is worker)
"""


def test_handlers_see_the_running_worker_module():
    out = subprocess.run([sys.executable, "-c", PROBE], cwd=BACKEND, capture_output=True, text=True, timeout=120)
    assert out.stdout.split()[-2:] == ["__main__", "True"], out.stdout + out.stderr
