import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');

function moduleBody(file) {
    return fs.readFileSync(path.join(src, file), 'utf8')
        .replace(/^import .*?;\r?\n/gm, '')
        .replace(/^export\s+/gm, '')
        .trim();
}

const body = [
    moduleBody('contract.js'),
    moduleBody('bridge.js'),
    moduleBody('controller.js'),
    moduleBody('styles.js'),
    moduleBody('view.js'),
    moduleBody('renderers.js'),
    moduleBody('update.js')
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
    '        MEDIA_TYPES,',
    '        XGALLERY_CORE_API_VERSION,',
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
    '        ensureMediaBox,',
    '        installOverlayStyles,',
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
].join('\n');

fs.mkdirSync(dist, { recursive: true });
const sha256 = crypto.createHash('sha256').update(bundle).digest('hex');
const versionedName = 'xgallery-core-' + version + '.iife.js';
fs.writeFileSync(path.join(dist, 'xgallery-core.iife.js'), bundle, 'utf8');
fs.writeFileSync(path.join(dist, versionedName), bundle, 'utf8');
const manifest = {
    version: version,
    url: 'https://cdn.jsdelivr.net/gh/loliXn/xg-core@v' + version + '/dist/xgallery-core.iife.js',
    sha256: sha256
};
fs.writeFileSync(path.join(dist, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('built dist/' + versionedName + ' sha256=' + sha256);
