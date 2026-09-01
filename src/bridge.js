export const BRIDGE_METHODS = Object.freeze([
    'resolveItem',
    'requestMore',
    'performAction',
    'download',
    'close',
    'settingsChanged'
]);

const noop = () => undefined;

export function createGalleryBridge(overrides = {}) {
    const bridge = {};
    for (const method of BRIDGE_METHODS) {
        const candidate = overrides[method];
        bridge[method] = typeof candidate === 'function' ? candidate : noop;
    }
    return Object.freeze(bridge);
}
