export const XGALLERY_RUNTIME_API_VERSION = 1;

// Legacy getters are still supported while consumers adopt session commands.
export function createRuntimeFacade(bridge) {
    if (!bridge || typeof bridge !== 'object' || !bridge.state) throw new TypeError('runtime bridge state is required');
    const version = bridge.runtimeApiVersion ?? XGALLERY_RUNTIME_API_VERSION;
    if (version !== XGALLERY_RUNTIME_API_VERSION) throw new TypeError('Unsupported runtime bridge version: ' + version);
    return bridge;
}

export const BRIDGE_METHODS = Object.freeze([
    'resolveItem',
    'resolveMediaResource',
    'requestMore',
    'performAction',
    'download',
    'close',
    'settingsChanged'
]);

export const CORE_EVENTS = Object.freeze([
    'replace',
    'append',
    'patch',
    'remove',
    'navigate',
    'action',
    'more',
    'batch',
    'filter'
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
