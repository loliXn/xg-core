import { createGalleryBridge } from './bridge.js';
import { normalizeMediaItem } from './contract.js';

export class GalleryController {
    #bridge;
    #items = [];
    #itemsById = new Map();
    #currentId = null;
    #listeners = new Set();

    constructor(options = {}) {
        this.#bridge = createGalleryBridge(options.bridge);
        this.replaceItems(options.items || [], options.startId || null);
    }

    get bridge() {
        return this.#bridge;
    }

    snapshot() {
        return Object.freeze({
            items: this.#items.slice(),
            currentId: this.#currentId,
            currentIndex: this.#items.findIndex((item) => item.id === this.#currentId)
        });
    }

    subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('listener must be a function');
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    replaceItems(items, preferredId = this.#currentId) {
        const normalized = this.#normalizeUnique(items);
        this.#items = normalized;
        this.#itemsById = new Map(normalized.map((item) => [item.id, item]));
        this.#currentId = preferredId && this.#itemsById.has(preferredId)
            ? preferredId
            : (normalized[0] ? normalized[0].id : null);
        this.#emit('replace');
        return this.snapshot();
    }

    appendItems(items) {
        const normalized = this.#normalizeUnique(items, this.#itemsById);
        if (!normalized.length) return this.snapshot();
        for (const item of normalized) this.#itemsById.set(item.id, item);
        this.#items = this.#items.concat(normalized);
        if (!this.#currentId) this.#currentId = normalized[0].id;
        this.#emit('append');
        return this.snapshot();
    }

    patchItem(id, changes) {
        const current = this.#itemsById.get(id);
        if (!current) return false;
        const next = normalizeMediaItem({ ...current, ...changes, id });
        const index = this.#items.findIndex((item) => item.id === id);
        this.#items[index] = next;
        this.#itemsById.set(id, next);
        this.#emit('patch');
        return true;
    }

    removeItems(ids) {
        const removed = new Set(ids);
        if (!removed.size) return this.snapshot();
        const oldIndex = this.#items.findIndex((item) => item.id === this.#currentId);
        this.#items = this.#items.filter((item) => !removed.has(item.id));
        this.#itemsById = new Map(this.#items.map((item) => [item.id, item]));
        if (!this.#itemsById.has(this.#currentId)) {
            const nextIndex = Math.min(Math.max(0, oldIndex), this.#items.length - 1);
            this.#currentId = this.#items[nextIndex] ? this.#items[nextIndex].id : null;
        }
        this.#emit('remove');
        return this.snapshot();
    }

    setCurrentId(id) {
        if (!this.#itemsById.has(id) || id === this.#currentId) return false;
        this.#currentId = id;
        this.#emit('navigate');
        return true;
    }

    requestMore() {
        this.#emit('more');
        return this.#bridge.requestMore({ currentId: this.#currentId });
    }

    performAction(name, payload) {
        const event = {
            name: String(name || ''),
            itemId: this.#currentId,
            payload: payload && typeof payload === 'object' ? payload : {}
        };
        this.#emit('action');
        return this.#bridge.performAction(event);
    }

    destroy() {
        this.#listeners.clear();
        this.#items = [];
        this.#itemsById.clear();
        this.#currentId = null;
    }

    #normalizeUnique(items, existing = new Map()) {
        if (!Array.isArray(items)) throw new TypeError('items must be an array');
        const seen = new Set(existing.keys());
        return items.map(normalizeMediaItem).filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
    }

    #emit(reason) {
        if (!this.#listeners.size) return;
        const event = Object.freeze({ reason, snapshot: this.snapshot() });
        for (const listener of this.#listeners) listener(event);
    }
}
