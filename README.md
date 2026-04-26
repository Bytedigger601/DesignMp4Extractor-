# Design → MP4

Extract a Claude Design `<Stage>` animation (`animations.jsx` framework) to a frame-perfect MP4.

The tool runs the HTML in headless Chromium, replaces `requestAnimationFrame` with a virtual clock, advances the Stage one frame at a time, screenshots the canvas, and pipes the PNG sequence into ffmpeg. Output is deterministic — render time decoupled from real time, so 60s of source at 60fps gives you exactly 3600 frames, no dropped or doubled frames.

## Requirements

- Node.js 18+

ffmpeg is bundled via `ffmpeg-static` — no system install needed. (Override with `FFMPEG_PATH=/path/to/ffmpeg` if you want a specific build.)

## Install

```bash
npm install
```

The `postinstall` step downloads the Chromium build Playwright needs (~110 MB). The bundled ffmpeg (~80 MB) installs as a normal dependency.

### Run without cloning (npx)

```bash
npx github:YOUR_USER/DesignMp4Extractor design-mp4 path/to/animation.html
npx -p github:YOUR_USER/DesignMp4Extractor design-mp4-ui            # web UI
```

Or once published to npm:

```bash
npx design-mp4-extractor path/to/animation.html
npx -p design-mp4-extractor design-mp4-ui
```

## Use

### Web UI

```bash
npm start
```

Opens `http://localhost:5173` automatically. Paste the HTML path (or drag the file onto the input — works in some browsers), pick fps/crf/scale, hit **Extract MP4**, watch live progress, then **Play** or **Show in folder**. The Stage's resolution and duration are detected automatically.

### CLI

```bash
node extract.js path/to/animation.html
```

Drops `animation.mp4` next to the input.

### Options

| flag | default | meaning |
| --- | --- | --- |
| `-o, --output <file>` | `<input>.mp4` | output path |
| `--fps <n>` | from Stage (60) | render frame rate |
| `--crf <n>` | `18` | x264 quality (lower = better, 18 is visually lossless) |
| `--scale <n>` | `1` | output resolution multiplier (e.g. `0.5` for half) |
| `--start <sec>` | `0` | start time in source seconds |
| `--end <sec>` | duration | end time in source seconds |
| `--keep-frames` | off | keep the temp PNG sequence |
| `--headed` | off | show the browser window for debugging |

### Examples

Full render:
```bash
node extract.js "extracted/Weird Facts Short.html"
```

Just the first 10 seconds at 30fps:
```bash
node extract.js input.html --end 10 --fps 30 -o teaser.mp4
```

Half-resolution preview:
```bash
node extract.js input.html --scale 0.5 --crf 23 -o preview.mp4
```

## How it works

The `animations.jsx` framework drives every animation off `useTime()`, which reads from a `Stage` whose playhead advances via `requestAnimationFrame` deltas. The extractor:

1. Injects `page-init.js` before any page script. It swaps `requestAnimationFrame` for a queue and overrides `performance.now()` to read a virtual clock. It also patches `React.createElement` so the first call with `Stage` captures `{ width, height, duration, fps }` onto `window.__stageProps`.
2. Loads the HTML over `file://`, waits for Babel to finish transpiling and React to mount the Stage.
3. Sizes the viewport so the Stage's auto-fit lands at scale 1.0 (canvas renders at native resolution).
4. Calls `__animExtractor.advanceMs(stepMs)` for each frame, screenshots the canvas element, repeats.
5. Hands the PNG sequence to ffmpeg with `libx264 -crf 18 -pix_fmt yuv420p +faststart` for a content-creation-friendly MP4.

## Notes

- The Stage's `localStorage` playhead is wiped on every run, so output always starts at t=0 (or `--start`).
- If your HTML uses a Stage variant that doesn't expose `width`, `height`, `duration` as props, the extractor will time out waiting for `__stageProps`. Check console with `--headed`.
- Render time scales linearly with frame count. ~3–8 frames/sec on a typical laptop, so a 60s source at 60fps takes 8–20 minutes.
