# XGallery Core

Reusable gallery viewer core.

Public releases: `https://github.com/loliXn/xg-core/releases`

This package owns the overlay and launcher styles, shell, controls, settings,
post panels, captions, zoom and pan, thumbnail and grid windowing, media-slot
cleanup, loading and error states, and the image, video, iframe and album
rendering lifecycle.
It must not contain site detection, source-page selectors, authenticated site
actions, Tampermonkey APIs, or live host DOM nodes.

## One budget for every request

`netq.js` holds the gate that every fetch in a gallery asks for a slot first -
thumbnails, first-frame extraction, probes, prefetch, and the media on screen.
It enforces a per-host ceiling below the browser's own, orders work by lane
(`stage`, `visible`, `prefetch`, `background`), and raises a barrier while the
stage is waiting for its first bytes: past the per-host ceiling a fresh video
element does not get slower, it never starts. Adapters keep their own
transports and call `sharedMediaGate()`; a host that answers 408, 429 or 5xx is
reported once through `slot.report()` and every lane backs off.

`thumbs.js` holds the other half: `planVideoThumb()` decides what a video's
thumbnail is, and the answer is always one still frame - a cached frame, a
poster, a frozen animated poster, an extracted first frame, or a placeholder. A
`<video>` element in a cell is opt-in per adapter and nothing opts in.

## Boundary

Handlers pass serializable media items into `GalleryController`. Every item has
a stable `id`, a supported `type`, and a `src`. Adapters translate source data
into the core's generic item and UI models.

The injected bridge is the only route back to a handler:

- `resolveItem`
- `requestMore`
- `performAction`
- `download`
- `close`
- `settingsChanged`

`npm run build` writes:

- `dist/xgallery-core.iife.js`
- `dist/xgallery-core-<version>.iife.js`
- `dist/latest.json` with `version`, `url`, and `sha256`

Consumers should pin a bootstrap release tag plus SHA-256, then load
`latest.json` from GitHub Releases on each start, verify the hash, and cache
the last verified bundle. Do not load a moving `@main` branch.

## Development

```text
npm run build
npm test
```

The package has no runtime dependencies and does not need `npm install`.

## Release

1. `npm test` and `npm run build` in this package.
2. Confirm `dist/` contains no host selectors, credentials, or adapter code.
3. Publish the versioned IIFE (`xgallery-core-<version>.iife.js`) as a GitHub Release asset.
4. Confirm the asset URL returns that exact file and matches `dist/latest.json` `sha256`.
5. Upload `latest.json` last so clients never point at a missing bundle.
