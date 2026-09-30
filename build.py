"""Copy the files the app needs into dist/, ready to upload to a static host.

    python build.py
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
FILES = ["index.html", "manifest.webmanifest", "apple-touch-icon.png", "icon-192.png"]


def main():
    manifest = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))
    files = list(dict.fromkeys(FILES + [icon["src"] for icon in manifest.get("icons", [])]))

    missing = [f for f in files if not (ROOT / f).is_file()]
    if missing:
        sys.exit("Missing files: " + ", ".join(missing))

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()
    for f in files:
        shutil.copy2(ROOT / f, DIST / f)

    total = sum((DIST / f).stat().st_size for f in files)
    print(f"Built {len(files)} files ({total / 1024:.0f} KB) into {DIST}")
    for f in files:
        print("  " + f)


if __name__ == "__main__":
    main()
