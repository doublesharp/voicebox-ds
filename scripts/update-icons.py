"""Rebuild the Voicebox DS desktop icon and DoubleSharp attribution mark.

Requires Pillow (already in backend/requirements.txt). Only maintained icon
assets are written; catalog compilation belongs to the native build.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "app/src/assets"
CATALOG = ROOT / "tauri/assets/voicebox.icon/Assets"
ICONS = ROOT / "tauri/src-tauri/icons"


def gradient(size, top, middle, bottom):
    ramp = Image.linear_gradient("L").resize((size, size), Image.Resampling.BILINEAR)
    return ImageOps.colorize(ramp, top, bottom, mid=middle).convert("RGBA")


def main():
    # The supplied wordmark has a square 240px symbol at its left edge.
    mark = (
        Image.open(ASSETS / "doublesharp-logo.png")
        .convert("RGBA")
        .crop((0, 0, 240, 240))
    )
    mark.save(ASSETS / "doublesharp-mark.png")

    # Draw at double resolution for smooth edges on the tile and waveform.
    size = 2048
    foreground = Image.new("RGBA", (size, size))
    foreground.alpha_composite(
        mark.resize((1760, 1760), Image.Resampling.LANCZOS), (144, 144)
    )

    # Shade the center so the original loops stay visible around the waveform.
    center_mask = Image.new("L", (size, size))
    ImageDraw.Draw(center_mask).ellipse((546, 576, 1502, 1472), fill=255)
    center = Image.new("RGBA", (size, size), "#111b23")
    center.putalpha(center_mask.filter(ImageFilter.GaussianBlur(88)))
    foreground.alpha_composite(center)

    wave_mask = Image.new("L", (size, size))
    draw = ImageDraw.Draw(wave_mask)
    for x, height in zip((541, 751, 961, 1171, 1381), (176, 416, 736, 520, 272)):
        top = (size - height) // 2
        draw.rounded_rectangle((x, top, x + 126, top + height), radius=63, fill=255)

    wave = gradient(size, "#fff6cd", "#f6d577", "#c98c26")
    wave.putalpha(wave_mask)
    foreground.alpha_composite(wave)
    foreground.resize((1024, 1024), Image.Resampling.LANCZOS).save(
        CATALOG / "VoiceboxMark.png"
    )

    tile_mask = Image.new("L", (size, size))
    draw = ImageDraw.Draw(tile_mask)
    draw.rounded_rectangle((80, 80, 1968, 1968), radius=432, fill=255)
    tile = gradient(size, "#41545a", "#263a42", "#14272f")
    tile.putalpha(tile_mask)

    face_mask = Image.new("L", (size, size))
    ImageDraw.Draw(face_mask).rounded_rectangle(
        (116, 116, 1932, 1932), radius=396, fill=255
    )
    face = gradient(size, "#172b33", "#111b23", "#0b171e")
    face.putalpha(face_mask)
    tile.alpha_composite(face)
    tile.alpha_composite(foreground)
    icon = tile.resize((1024, 1024), Image.Resampling.LANCZOS)
    icon.save(CATALOG / "Voicebox.png")
    icon.resize((256, 256), Image.Resampling.LANCZOS).save(
        ASSETS / "voicebox-ds-icon.png"
    )

    for filename, size in {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
        "StoreLogo.png": 50,
        **{
            f"Square{size}x{size}Logo.png": size
            for size in (30, 44, 71, 89, 107, 142, 150, 284, 310)
        },
    }.items():
        icon.resize((size, size), Image.Resampling.LANCZOS).save(ICONS / filename)
    icon.save(ICONS / "icon.icns", format="ICNS")
    icon.save(
        ICONS / "icon.ico",
        format="ICO",
        sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)],
    )
    print(
        "Updated Voicebox DS sidebar, desktop PNG, ICNS, ICO, and icon catalog artwork."
    )


if __name__ == "__main__":
    main()
