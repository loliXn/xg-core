import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
    applyGalleryFilter,
    bindFilterBar,
    createOverlayShell,
    matchGalleryItem,
    parseSearchQuery
} from '../src/index.js';

const item = (id, extra = {}) => ({
    id,
    type: extra.type || 'img',
    src: extra.src || ('https://cdn.example/' + id + '.jpg'),
    tags: extra.tags,
    description: extra.description,
    filename: extra.filename,
    bytes: extra.bytes,
    albumSize: extra.albumSize,
    postInfo: extra.postInfo
});

test('parseSearchQuery splits phrases and exclusions', () => {
    const parsed = parseSearchQuery('alpha "exact phrase" -skip');
    assert.deepEqual(parsed.include.map((t) => t.value), ['alpha', 'exact phrase']);
    assert.equal(parsed.include[1].phrase, true);
    assert.deepEqual(parsed.exclude.map((t) => t.value), ['skip']);
});

test('matchGalleryItem applies kind, extension, size and query', () => {
    const photo = item('a', { src: 'https://cdn.example/enmarchenoire.png', bytes: 2 * 1024 * 1024 });
    const clip = item('b', { type: 'video', src: 'https://cdn.example/clip.mp4' });
    assert.equal(matchGalleryItem(photo, { kind: 'images' }), true);
    assert.equal(matchGalleryItem(clip, { kind: 'images' }), false);
    assert.equal(matchGalleryItem(photo, { types: ['png'] }), true);
    assert.equal(matchGalleryItem(photo, { types: ['jpg'] }), false);
    assert.equal(matchGalleryItem(photo, { minMb: 3 }), false);
    assert.equal(matchGalleryItem(photo, { query: 'enmarchenoire' }), true);
    assert.equal(matchGalleryItem(photo, { query: '-enmarchenoire' }), false);
    assert.equal(matchGalleryItem(photo, { query: '"enmarchenoire.png"' }), true);
});

test('applyGalleryFilter maps wrapper entries', () => {
    const entries = [
        { item: item('keep', { tags: ['red'] }) },
        { item: item('drop', { tags: ['blue'] }) }
    ];
    const filtered = applyGalleryFilter(entries, { query: 'red' }, (entry) => entry.item);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].item.id, 'keep');
});

test('overlay shell includes the filter bar', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const overlay = createOverlayShell({ document: dom.window.document });
    assert.ok(overlay.querySelector('.ms-filter-bar'));
    assert.equal(overlay.querySelector('.ms-filter-input'), null);
    assert.equal(overlay.querySelector('.ms-filter-copy'), null);
    assert.equal(overlay.querySelector('.ms-filter-min-album'), null);
    assert.ok(overlay.querySelector('.ms-filter-min-mb'));
    assert.ok(overlay.querySelector('[data-act="filter-toggle"]'));
    assert.equal(overlay.querySelector('.ms-filter-bar').getAttribute('aria-hidden'), 'true');
});

test('overlay shell can isolate viewer chrome in a shadow root', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const overlay = createOverlayShell({ document: dom.window.document, shadowCss: '.ms-gallery-overlay{color:white}' });
    assert.equal(overlay.getRootNode().host.className, 'ms-gallery-root');
    assert.equal(overlay.msRootHost.shadowRoot.querySelector('.ms-gallery-overlay'), overlay);
});

test('bindFilterBar toggles type chips and kinds', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    globalThis.document = dom.window.document;
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    const overlay = createOverlayShell({ document: dom.window.document });
    const changes = [];
    const bar = bindFilterBar(overlay.querySelector('.ms-filter-bar'), {
        onChange: (state) => changes.push(state)
    });
    overlay.querySelector('[data-kind="images"]').click();
    overlay.querySelector('[data-ext="png"]').click();
    assert.equal(bar.getState().kind, 'images');
    assert.deepEqual(bar.getState().types, ['png']);
    assert.ok(changes.length >= 2);
    bar.open();
    assert.equal(bar.isOpen(), true);
    assert.equal(overlay.querySelector('[data-act="filter-toggle"]').getAttribute('aria-expanded'), 'true');
    assert.equal(overlay.style.getPropertyValue('--ms-filter-h'), '0px');
    bar.close();
    assert.equal(bar.isOpen(), false);
    bar.destroy();
    delete globalThis.document;
    delete globalThis.ResizeObserver;
});
