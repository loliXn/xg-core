# XGallery Core

Reusable gallery viewer core.

Public releases: `https://github.com/loliXn/xg-core/releases`

This package owns the overlay stylesheet and shell, reusable viewer state,
thumbnail and grid cells, media-slot cleanup, loading and error states, and
the common image, video, iframe, album and position renderers.
It must not contain site detection, source-page selectors, authenticated site
actions, Tampermonkey APIs, or live host DOM nodes.

## Boundary

Handlers pass serializable media items into `GalleryController`. Every item has
a stable `id`, a supported `type`, and a `src`. Site-specific fields may remain
on the item while adapters are migrated.

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

Consumers should pin a release tag plus SHA-256, or load `latest.json` from
GitHub Releases, verify the hash, and cache the last verified bundle. Do not
load a moving `@main` branch.

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
