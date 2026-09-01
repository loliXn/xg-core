import test from 'node:test';
import assert from 'node:assert/strict';

import {
    compareCoreVersions,
    isTrustedCoreUrl,
    parseCoreManifest,
    sha256Hex,
    shouldInstallCore,
    verifiedCoreRecord
} from '../src/update.js';

test('parseCoreManifest accepts a pinned https bundle', () => {
    const manifest = parseCoreManifest({
        version: '0.2.0',
        url: 'https://cdn.jsdelivr.net/gh/loliXn/xg-core@v0.2.0/dist/xgallery-core.iife.js',
        sha256: 'a'.repeat(64)
    });
    assert.equal(manifest.version, '0.2.0');
});

test('parseCoreManifest rejects untrusted hosts and bad hashes', () => {
    assert.throws(() => parseCoreManifest({
        version: '0.2.0',
        url: 'https://evil.example/core.js',
        sha256: 'a'.repeat(64)
    }));
    assert.throws(() => parseCoreManifest({
        version: '0.2.0',
        url: 'https://cdn.jsdelivr.net/gh/loliXn/xg-core@v0.2.0/dist/xgallery-core.iife.js',
        sha256: 'nope'
    }));
});

test('version compare and install policy', () => {
    assert.equal(compareCoreVersions('0.2.0', '0.1.0'), 1);
    assert.equal(shouldInstallCore('0.1.0', '0.2.0'), true);
    assert.equal(shouldInstallCore('0.2.0', '0.2.0'), false);
    assert.equal(shouldInstallCore('0.2.1', '0.2.0'), false);
});

test('trusted core URLs', () => {
    assert.equal(isTrustedCoreUrl('https://cdn.jsdelivr.net/gh/loliXn/xg-core@v0.2.0/dist/xgallery-core.iife.js'), true);
    assert.equal(isTrustedCoreUrl('https://github.com/loliXn/xg-core/releases/download/v0.2.0/xgallery-core-0.2.0.iife.js'), true);
    assert.equal(isTrustedCoreUrl('http://cdn.jsdelivr.net/gh/loliXn/xg-core@v0.2.0/dist/xgallery-core.iife.js'), false);
});

test('verifiedCoreRecord refuses a hash mismatch', async () => {
    const code = '(function(){globalThis.XGalleryCore={};})();';
    const sha = await sha256Hex(code);
    const manifest = {
        version: '0.2.0',
        url: 'https://cdn.jsdelivr.net/gh/loliXn/xg-core@v0.2.0/dist/xgallery-core.iife.js',
        sha256: sha
    };
    assert.ok(verifiedCoreRecord(manifest, code, sha));
    assert.equal(verifiedCoreRecord(manifest, code, 'b'.repeat(64)), null);
});
