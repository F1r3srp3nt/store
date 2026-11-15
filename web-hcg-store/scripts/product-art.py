#!/usr/bin/env python3
"""
Builds the web renditions of approved product artwork.

Source: the full-resolution originals in the repository's `assets/products/<product-id>/`
(`banner.webp` and/or `icon.webp`, stored losslessly; never published). Output:
`web-hcg-store/public/media/products/<product-id>/`:

    banner-640 / banner-1200 / banner-2000   (3:1 promotional banners; .avif + .webp)
    icon-128 / icon-256                        (square icons; .avif + .webp)

Images are only resized (Lanczos) and re-encoded. They are never cropped, padded or edited. The
catalogue (`catalogue/products.json`) is the single place that says which product uses which file.

Usage (from web-hcg-store/):  python3 scripts/product-art.py [product-id ...]
Requires Pillow with AVIF and WebP support.
"""

import sys
from pathlib import Path

from PIL import Image, features

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT.parent / "assets" / "products"
OUT = ROOT / "public" / "media" / "products"

WIDTHS = {"banner": (640, 1200, 2000), "icon": (128, 256)}
WEBP_QUALITY = 82
AVIF_QUALITY = 60


def build(product_dir: Path) -> None:
    for kind, widths in WIDTHS.items():
        src = product_dir / f"{kind}.webp"
        if not src.exists():
            continue
        image = Image.open(src).convert("RGB")
        out_dir = OUT / product_dir.name
        out_dir.mkdir(parents=True, exist_ok=True)
        for width in widths:
            height = round(width * image.height / image.width)
            resized = image.resize((width, height), Image.LANCZOS)
            resized.save(out_dir / f"{kind}-{width}.webp", "WEBP", quality=WEBP_QUALITY, method=6)
            resized.save(out_dir / f"{kind}-{width}.avif", "AVIF", quality=AVIF_QUALITY, speed=4)
            print(f"{product_dir.name}/{kind}-{width}  {width}x{height}")


def main() -> int:
    if not (features.check("avif") and features.check("webp")):
        print("Pillow needs AVIF and WebP support.", file=sys.stderr)
        return 1
    wanted = set(sys.argv[1:])
    dirs = sorted(d for d in SOURCES.iterdir() if d.is_dir() and (not wanted or d.name in wanted))
    if not dirs:
        print("No matching product artwork in assets/products/.", file=sys.stderr)
        return 1
    for d in dirs:
        build(d)
    return 0


if __name__ == "__main__":
    sys.exit(main())
