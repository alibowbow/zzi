"""Subset Pretendard Variable to the characters the app actually shows.

The UI has no free-text input, so every glyph it can display lives in the
source files. Re-run after changing UI text:

    pip install fonttools brotli
    python3 scripts/subset-font.py path/to/PretendardVariable.woff2

(test/font.test.js fails when a source character is missing from the subset.)
"""
import pathlib
import sys

from fontTools import subset

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = ["index.html", "app.js", "manifest.webmanifest"] + [str(p.relative_to(ROOT)) for p in (ROOT / "src").rglob("*.js")]
EXTRA = "·–—‘’“”…•→←↑↓✓×%°²³½·「」『』『』"


def charset():
    chars = set(chr(c) for c in range(0x20, 0x7F)) | set(EXTRA)
    for rel in SOURCES:
        chars |= set((ROOT / rel).read_text(encoding="utf-8"))
    return "".join(sorted(c for c in chars if c.isprintable() or c == " "))


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: subset-font.py PretendardVariable.woff2")
    text = charset()
    (ROOT / "fonts" / "charset.txt").write_text(text, encoding="utf-8")
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.glyph_names = False
    font = subset.load_font(sys.argv[1], options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    out = ROOT / "fonts" / "PretendardVariable-subset.woff2"
    subset.save_font(font, str(out), options)
    print(f"{len(text)} characters -> {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
