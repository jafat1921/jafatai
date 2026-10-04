"""Cross-platform task runner: python scripts/tasks.py <task>

Same commands on Windows (dev) and Linux (GPU box) - no .bat/.sh pairs.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
NPM = shutil.which("npm") or "npm"


def _uv(*args):
    return ["uv", "run", "--project", str(BACKEND), *args]


def _env_host_port():
    host, port = "127.0.0.1", "8000"
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            key, _, val = line.partition("=")
            val = val.split("#")[0].strip()
            if key.strip() == "APP_HOST" and val:
                host = val
            elif key.strip() == "APP_PORT" and val:
                port = val
    return host, port


def run(cmd, cwd=ROOT):
    print("$", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=cwd)


def setup():
    if not (ROOT / ".env").exists():
        shutil.copy(ROOT / ".env.example", ROOT / ".env")
        print("created .env from .env.example - edit it before going further")
    rc = run(["uv", "sync"], cwd=BACKEND)
    return rc or run([NPM, "install"], cwd=FRONTEND)


def migrate():
    return run(_uv("alembic", "upgrade", "head"), cwd=BACKEND)


def api(reload=True):
    host, port = _env_host_port()
    # open SSE streams would otherwise block shutdown/reload forever
    cmd = _uv("uvicorn", "app.main:app", "--host", host, "--port", port, "--timeout-graceful-shutdown", "3")
    if reload:
        cmd.append("--reload")
    return run(cmd, cwd=BACKEND)


def worker():
    return run(_uv("python", "-m", "app.worker"), cwd=BACKEND)


def web():
    return run([NPM, "run", "dev"], cwd=FRONTEND)


def build():
    return run([NPM, "run", "build"], cwd=FRONTEND)


def test():
    rc = run(_uv("pytest", "-q"), cwd=BACKEND)
    return rc or run([NPM, "run", "test", "--", "--run"], cwd=FRONTEND)


def dev():
    """api + worker + vite together; Ctrl+C stops all three."""
    host, port = _env_host_port()
    procs = [
        subprocess.Popen(_uv("uvicorn", "app.main:app", "--host", host, "--port", port, "--reload",
                             "--timeout-graceful-shutdown", "3"), cwd=BACKEND),
        subprocess.Popen(_uv("python", "-m", "app.worker"), cwd=BACKEND),
        subprocess.Popen([NPM, "run", "dev"], cwd=FRONTEND),
    ]
    try:
        for p in procs:
            p.wait()
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
    return 0


def serve():
    """Production-ish: built frontend is served by the API itself."""
    return api(reload=False)


TASKS = {f.__name__: f for f in (setup, migrate, api, worker, web, build, test, dev, serve)}

if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else ""
    if name not in TASKS:
        print("usage: python scripts/tasks.py [" + "|".join(TASKS) + "]")
        sys.exit(2)
    os.environ.setdefault("PYTHONUTF8", "1")
    sys.exit(TASKS[name]())
