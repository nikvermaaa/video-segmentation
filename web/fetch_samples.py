"""Download the two openly licensed Blender trailers used by the demo.

    python web/fetch_samples.py

Sintel (Blender Foundation, CC BY 3.0) and Big Buck Bunny (Blender Foundation,
CC BY 3.0). Source: download.blender.org. Credit links are in the page footer.
The .mp4 suffix on the BBB file is just the input filename; ffmpeg normalises
its QuickTime container before the pipeline uses it.
"""
from pathlib import Path
import urllib.request

folder = Path(__file__).resolve().parent / "samples"
folder.mkdir(exist_ok=True)
items = [
    ("sintel", "Sintel trailer",
     "https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4"),
    ("big-buck-bunny", "Big Buck Bunny trailer",
     "https://download.blender.org/peach/trailer/trailer_480p.mov"),
]
for sid, title, url in items:
    p = folder / (sid + ".mp4")
    if not p.exists():
        urllib.request.urlretrieve(url, p)
    (folder / (sid + ".title")).write_text(title + "\n")
    print(title, p.stat().st_size, "bytes")
