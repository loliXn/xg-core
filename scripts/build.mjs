import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

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
    moduleBody('renderers.js')
].join('\n\n');

const bundle = [
    '(function (root) {',
    "    'use strict';",
    '',
    body.split('\n').map((line) => '    ' + line).join('\n'),
    '',
    '    root.XGalleryCore = Object.freeze({',
    '        BRIDGE_METHODS,',
    '        GalleryController,',
    '        MEDIA_TYPES,',
    '        XGALLERY_CORE_API_VERSION,',
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
    '        normalizeMediaItem,',
    '        prepareMediaSlot,',
    '        renderErrorBanner,',
    '        renderErrorStage,',
    '        renderPosition,',
    '        renderThumbnailCell,',
    '        validateMediaItem',
    '    });',
    "})(typeof globalThis !== 'undefined' ? globalThis : this);",
    ''
].join('\n');

fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'xgallery-core.iife.js'), bundle, 'utf8');
console.log('built dist/xgallery-core.iife.js');
