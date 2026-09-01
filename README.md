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

`npm run build` creates `dist/xgallery-core.iife.js`, which exposes
`globalThis.XGalleryCore` for Tampermonkey `@require`. Consumers should pin a
tag and a SHA-256 hash instead of loading a moving branch.

## Development

```text
npm run build
npm test
```

The package has no runtime dependencies and does not need `npm install`.
