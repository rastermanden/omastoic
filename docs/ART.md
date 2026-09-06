# Rebuilding the art

`art/*.txt` is generated, not hand-drawn. Each file is one Stoic reduced to a
34×20 grid of braille cells — 68×80 dots, which is the whole budget a portrait
has to be recognisable in.

```bash
bun scripts/transcode.ts          # all of them
bun scripts/transcode.ts zeno     # one
```

Every source is named in `assets/portraits.json`, and every portrait needs an
entry there before it can be built.

## The manifest

| Field | |
| --- | --- |
| `slug` | Ties the three halves together: `art/<slug>.txt`, the first column of `data/quotes.tsv`, and the roster in `data/authors.tsv`. |
| `origin` | `local` — an image that cannot be re-fetched from anywhere, committed in `assets/local/`. `commons` — public domain or CC0, downloaded into the gitignored `assets/sources/` by `scripts/fetch-sources.sh`. |
| `crop` | `WxH+X+Y` in source pixels, framed on the head. Aim near 17:20, the shape of the cell grid. |
| `floor` | Flattens everything above this lightness to one white. Some exports bake their transparency checkerboard in as pixels; this removes it. |
| `transcoder` | `ascii` or `halftone`. |
| `threshold` | `ascii` only: percent. Lower admits more ink. |
| `tone` | `halftone` only: `blur`, `black`, `white`. |

## The two transcoders

`ascii` hands the cropped image to `omarchy transcode ascii`, Omarchy's own
braille transcoder, which is a hard threshold. That is right for a drawing:
strong strokes on bare paper, nothing to blur away and no background to mask.
It also trims to the ink, so the frame comes out tight without help.

`halftone` is for photographs, which need more than a hard threshold — a bust
thresholded flat is a white blob. The image is blurred by `tone.blur` to lose
the marble's grain, levelled between `tone.black` and `tone.white` so the
sitter's own shadows survive, masked with a soft ellipse so the museum wall
behind it is not, and halftoned with a clustered 4×4 pattern — which the braille
grid renders as tone, where a diffusion dither at this size turns into static.

## What survives 68×80 dots

Hard edges and a strong dark/light separation. Fine texture does not: hatching,
stipple and marble grain all average into flat grey when the image is reduced
this far, and a face made of grey is a face made of nothing.

- **Frame head-and-shoulders.** A full-length figure puts the face in about
  eight dots, which is not a face. Crop until the head fills most of the frame.
- **Drawings beat photographs here**, and the threshold depends on how the
  drawing carries its tone. Hatching packs a lot of ink per square and wants
  `threshold` around 45; stipple carries far less and wants about 18. If a
  portrait comes out as scattered dust, lower it; as a filled silhouette, raise
  it.
- **A plain background** is worth more than a clever mask.

Judge the result at the size it will actually appear, not as a text dump:

```bash
bun scripts/transcode.ts marcus
./bin/omastoic render-png art/marcus.txt /tmp/marcus.png
```

`scripts/preview.sh <canvas.txt>` does the same for a whole canvas, at the
terminal's cell aspect ratio.

## Sources

What `assets/local/` commits is each source halved and greyscaled. That rebuilds
`art/` exactly and keeps `omarchy plugin add` from cloning several megabytes,
but it is not enough to re-crop against. The full-resolution originals are a
[release asset](https://github.com/rastermanden/omastoic/releases/tag/portrait-sources):

```bash
./scripts/fetch-sources.sh --originals   # unpacks into assets/originals/, gitignored
```

Crops are in the coordinates of the committed copy, so halve any measurement
taken off an original. Having re-cropped, write the committed copy back out and
rebuild:

```bash
magick assets/originals/zeno.jpg -colorspace Gray -resize 50% -quality 80 \
  -strip assets/local/zeno.jpg
bun scripts/transcode.ts zeno
```

A new source also wants a line in [CREDITS.md](../CREDITS.md) matching its
`credit` field — a test checks that it is there.

## Listing art

```bash
bun scripts/make-preview.ts
```

Rebuilds `preview.png`, and the `preview.gif` and `demo.mp4` that go on the
release, from the committed art — one plate per Stoic, each with that Stoic's
shortest quote, so the same art always gives the same preview. Frames are real
canvases, laid out by the same `compose()` the screensaver writes and on the
same 111×30 grid; the only liberty is the gradient they are multiplied through.
`--mono` leaves them white, `--still <slug>` chooses the Stoic on the still.

The gif and the mp4 are gitignored and belong on the release, so they are not
cloned with the plugin. Attach them when you tag:

```bash
gh release create v2.2.0 preview.gif demo.mp4 --title "Omastoic 2.2.0" --latest
```
