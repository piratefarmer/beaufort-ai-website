#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parent
pages = [
    "index.html",
    "dashboard.html",
    "weather.html",
    "library.html",
    "why-beaufort.html",
    "storm-nov2022.html",
    "chart-corrections.html",
    "landing.html",
]
beacon = '  <script src="/js/analytics-beacon.js?v=20260731c" defer></script>'
changed = []
for name in pages:
    p = root / name
    if not p.exists():
        print("missing", name)
        continue
    text = p.read_text()
    if "analytics-beacon.js" in text:
        print("already", name)
        continue
    if "</body>" in text:
        updated = text.replace("</body>", beacon + "\n</body>", 1)
    elif "</head>" in text:
        updated = text.replace("</head>", beacon + "\n</head>", 1)
    else:
        print("no inject", name)
        continue
    p.write_text(updated)
    changed.append(name)
print("changed", changed)
print("beacon_exists", (root / "js" / "analytics-beacon.js").exists())
