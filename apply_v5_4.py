from pathlib import Path

def replace_once(path, old, new, label):
    p=Path(path)
    text=p.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"Could not find expected text for {label} in {path}")
    p.write_text(text.replace(old,new,1),encoding="utf-8")
    print("Updated", path, "-", label)

# Simple version/cache bumps.
replace_once("public/index.html","const APP_VERSION='5.3';","const APP_VERSION='5.4';","app version")
replace_once("public/index.html","const UNRESOLVED_RECHECK_VERSION='5.3';","const UNRESOLVED_RECHECK_VERSION='5.4';","recheck version")
replace_once("public/service-worker.js","const CACHE='my-ar-shelf-shell-v5.3';","const CACHE='my-ar-shelf-shell-v5.4';","service worker cache")

# This helper script intentionally stops here for the complex edits.
# Apply the remaining exact replacements from the included replacement files.
print()
print("Version/cache bumps applied.")
print("Now apply the remaining edits from public-index-replacements.txt and server-replacements.txt.")
