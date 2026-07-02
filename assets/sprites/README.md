# Sprite assets

## gunner-sheet.png

- Source: "Purple sci-fi soldier FPS sprite sheet" by warpzone32
  https://opengameart.org/content/purple-sci-fi-soldier-fps-sprite-sheet
  (file: gunnerspritesheetpublicdomain.png, downloaded 2026-07-02)
- License: **CC0 / public domain** (no attribution required; noted here for provenance).
- Layout: uniform grid of 64×128-pixel cells, 16 columns × 7 rows (bottom
  128 px band empty). The grid is irregular in meaning — directions, walk
  poses, and orange muzzle-lit firing variants are mixed across rows.

## gunner-mapping.json

Curated cell selection (visually verified): for each of 5 facing directions
(front, front-left, left, back-left, back — right-side directions are
produced by horizontal mirroring at render time), 2 walk-stride cells and
1 firing cell. `gunner-mapping-verify.png` is the labeled proof sheet.
Known compromise: `back.fire` reuses the `back-left` lit cell — the sheet
has no true rear muzzle-flash frame (the gun points away from the camera).

`tools/gen-sprites.py` consumes both files and generates
`packages/client/src/sprites/gunner-data.ts`. Re-run it if either changes.
