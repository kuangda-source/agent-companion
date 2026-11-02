#!/usr/bin/env python3
"""Convert this simulator's framebuffer capture to a viewable PNG."""

from pathlib import Path
import sys
from PIL import Image

source = Path(sys.argv[1])
with Image.open(source) as image:
    if image.size != (1024, 600):
        raise ValueError("unexpected simulator framebuffer size")
    output = source.with_suffix(".png")
    image.save(output)
print(output)
