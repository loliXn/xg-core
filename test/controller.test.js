import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BRIDGE_METHODS,
    CORE_EVENTS,
    GalleryController,
    XGALLERY_CORE_API_VERSION,
    configureVideoElement,
    createIframeMedia,
    createGalleryBridge,
    createOverlayShell,
    prepareMediaSlot,
    renderErrorStage,
    renderThumbnailCell
} from '../src/index.js';

const item = (id, src = 'https://cdn.example/' + id + '.jpg') => ({
    id,
    type: 'img',
    src
});

test('contract has a stable API version and complete bridge', () => {
    assert.equal(XGALLERY_CORE_API_VERSION, 1);
    const bridge = createGalleryBridge();
    for (const method of BRIDGE_METHODS) assert.equal(typeof bridge[method], 'function');
    assert.ok(CORE_EVENTS.includes('navigate'));
    assert.ok(CORE_EVENTS.includes('more'));
});

test('controller requestMore and performAction do not pass host nodes', () => {
    const calls = [];
    const controller = new GalleryController({
        items: [item('a')],
        startId: 'a',
        bridge: {
            requestMore(payload) { calls.push(['more', payload]); },
            performAction(payload) { calls.push(['action', payload]); }
        }
    });
    controller.requestMore();
    controller.performAction('like', { wanted: true });
    assert.equal(calls[0][0], 'more');
    assert.equal(calls[0][1].currentId, 'a');
    assert.equal(calls[1][1].name, 'like');
    assert.equal(calls[1][1].itemId, 'a');
    assert.equal(calls[1][1].payload.wanted, true);
});

test('controller preserves current item across replacement', () => {
    const controller = new GalleryController({ items: [item('a'), item('b')], startId: 'b' });
    controller.replaceItems([item('x'), item('b'), item('c')]);
    assert.equal(controller.snapshot().currentId, 'b');
    assert.equal(controller.snapshot().currentIndex, 1);
});

test('append deduplicates stable IDs', () => {
    const controller = new GalleryController({ items: [item('a')] });
    controller.appendItems([item('a'), item('b')]);
    assert.deepEqual(controller.snapshot().items.map((entry) => entry.id), ['a', 'b']);
});

test('patch and removal keep navigation valid', () => {
    const controller = new GalleryController({ items: [item('a'), item('b')], startId: 'b' });
    assert.equal(controller.patchItem('b', { src: 'https://cdn.example/full-b.jpg' }), true);
    assert.equal(controller.snapshot().items[1].src, 'https://cdn.example/full-b.jpg');
    controller.removeItems(['b']);
    assert.equal(controller.snapshot().currentId, 'a');
});

test('overlay shell rendering is core-owned', () => {
    const document = {
        createElement() {
            return { className: '', style: {}, innerHTML: '' };
        }
    };
    const overlay = createOverlayShell({
        document,
        classes: ['ms-test'],
        showInfo: true,
        infoLabel: 'Info'
    });
    assert.match(overlay.className, /ms-gallery-overlay ms-test/);
    assert.match(overlay.innerHTML, /ms-gallery-topbar/);
    assert.match(overlay.innerHTML, /ms-filter-bar/);
    assert.match(overlay.innerHTML, />Info<\/span>/);
});

test('shared DOM renderers are exported by core', () => {
    assert.equal(typeof renderThumbnailCell, 'function');
    assert.equal(typeof prepareMediaSlot, 'function');
    assert.equal(typeof renderErrorStage, 'function');
    assert.equal(typeof configureVideoElement, 'function');
    assert.equal(typeof createIframeMedia, 'function');
});
