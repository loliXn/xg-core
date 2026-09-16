import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');
// --dev writes an untracked bundle for local iteration. It is flagged so the
// userscript never swaps it out for a cached or downloaded release, and it
// never touches the release artifacts or latest.json.
const dev = process.argv.includes('--dev');

function moduleBody(file) {
    return fs.readFileSync(path.join(src, file), 'utf8')
        .replace(/^import .*?;\r?\n/gm, '')
        .replace(/^export\s+/gm, '')
        .trim();
}

const body = [
    moduleBody('contract.js'),
    moduleBody('media-format.js'),
    moduleBody('bridge.js'),
    moduleBody('controller.js'),
    moduleBody('styles.js'),
    moduleBody('filter.js'),
    moduleBody('view.js'),
    moduleBody('renderers.js'),
    moduleBody('update.js'),
    moduleBody('panels.js'),
    moduleBody('runtime.js')
].join('\n\n');

const bundle = [
    '(function (root) {',
    "    'use strict';",
    '',
    body.split('\n').map((line) => '    ' + line).join('\n'),
    '',
    '    root.XGalleryCore = Object.freeze({',
    '        BRIDGE_METHODS,',
    '        CORE_EVENTS,',
    '        CORE_MANIFEST_URL,',
    '        CORE_UPDATE_INTERVAL_MS,',
    '        GalleryController,',
    '        inspectImageFormat,',
    '        createViewerRuntime,',
    '        renderPostPanel,',
    '        createSettingsPanel,',
    '        MEDIA_TYPES,',
    '        XGALLERY_CORE_API_VERSION,',
    '        XGALLERY_CORE_VERSION,',
    '        XGALLERY_CORE_LOCAL: ' + (dev ? 'true' : 'false') + ',',
    '        compareCoreVersions,',
    '        OVERLAY_CSS,',
    '        configureVideoElement,',
    '        createExpandButton,',
    '        createImageMedia,',
    '        createIframeMedia,',
    '        createIframeShield,',
    '        createLoadingPreview,',
    '        createPlaceholderIcon,',
    '        createResolveIndicator,',
    '        createOverlayShell,',
    '        createGalleryBridge,',
    '        DEFAULT_FILTER_STATE,',
    '        FILTER_TYPE_OPTIONS,',
    '        applyGalleryFilter,',
    '        bindFilterBar,',
    '        filterBarMarkup,',
    '        itemExtension,',
    '        itemSearchText,',
    '        matchGalleryItem,',
    '        normalizeFilterState,',
    '        parseSearchQuery,',
    '        ensureMediaBox,',
    '        installOverlayStyles,',
    '        installLauncherStyles,',
    '        LAUNCHER_CSS,',
    '        DEFAULT_ACCENT,',
    '        ACCENT_PRESETS,',
    '        accentTokens,',
    '        applyAccent,',
    '        isTrustedCoreUrl,',
    '        normalizeMediaItem,',
    '        parseCoreManifest,',
    '        sha256Hex,',
    '        shouldInstallCore,',
    '        prepareMediaSlot,',
    '        renderErrorBanner,',
    '        renderErrorStage,',
    '        renderPosition,',
    '        renderThumbnailCell,',
    '        validateMediaItem,',
    '        verifiedCoreRecord',
    '    });',
    "})(typeof globalThis !== 'undefined' ? globalThis : this);",
    ''
].join('\n').replace(/[ \t]+$/gm, '');
// Source files can carry CRLF line endings (Windows checkouts with
// core.autocrlf=true), which moduleBody() copies through verbatim. Git's own
// clean filter normalizes CRLF -> LF the moment the built file is committed,
// so a hash taken here beforehand does not match what the committed blob -
// and so jsDelivr - actually serves. Normalize once, up front, so the hash
// printed below is the one that ships.
const bundleNormalized = bundle.replace(/\r\n/g, '\n');


fs.mkdirSync(dist, { recursive: true });
if (dev) {
    fs.writeFileSync(path.join(dist, 'xgallery-core.dev.iife.js'), bundleNormalized, 'utf8');
    console.log('built dist/xgallery-core.dev.iife.js (local, not a release)');
    process.exit(0);
}
const sha256 = crypto.createHash('sha256').update(bundleNormalized).digest('hex');
const versionedName = 'xgallery-core-' + version + '.iife.js';
fs.writeFileSync(path.join(dist, 'xgallery-core.iife.js'), bundleNormalized, 'utf8');
fs.writeFileSync(path.join(dist, versionedName), bundleNormalized, 'utf8');
const manifest = {
    version: version,
    url: 'https://cdn.jsdelivr.net/gh/loliXn/xg-core@v' + version + '/dist/xgallery-core.iife.js',
    sha256: sha256
};
fs.writeFileSync(path.join(dist, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('built dist/' + versionedName + ' sha256=' + sha256);
