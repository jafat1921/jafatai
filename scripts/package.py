"""Build a deployable zip for the GPU server: python scripts/package.py

Builds the frontend first so the server doesn't need to (Node is optional there),
and leaves out everything machine-specific: .env, data, venvs, node_modules and local reference material.
"""
import subprocess
import shutil
import sys
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist-deploy"

SKIP_DIRS = {".git", ".venv", "node_modules", "data", "ref", "__pycache__", ".pytest_cache",
             ".ruff_cache", "dist-deploy", ".claude", ".compliance", "test-results", "playwright-report"}
SKIP_FILES = {".env"}
SKIP_SUFFIXES = {".pyc", ".db", ".db-wal", ".db-shm", ".zip"}


def wanted(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    if any(part in SKIP_DIRS for part in rel.parts):
        return False
    return path.name not in SKIP_FILES and path.suffix not in SKIP_SUFFIXES


def main() -> int:
    npm = shutil.which("npm") or "npm"
    if "--no-build" not in sys.argv:
        rc = subprocess.call([npm, "run", "build"], cwd=ROOT / "frontend")
        if rc:
            print("frontend build failed")
            return rc

    OUT.mkdir(exist_ok=True)
    name = OUT / f"mixai-{datetime.now():%Y%m%d-%H%M}.zip"
    count = 0
    with zipfile.ZipFile(name, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(ROOT.rglob("*")):
            if p.is_file() and wanted(p):
                zf.write(p, p.relative_to(ROOT).as_posix())
                count += 1
    print(f"{name} ({count} files, {name.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
