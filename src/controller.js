import { createGalleryBridge } from './bridge.js';
import { normalizeMediaItem } from './contract.js';
import { applyGalleryFilter, normalizeFilterState } from './filter.js';

export class GalleryController {
    #bridge;
    #items = [];
    #itemsById = new Map();
    #currentId = null;
    #listeners = new Set();
    #visible = [];
    #visibleIndex = new Map();
    #visibility = null;
    #filter = normalizeFilterState();
    #batches = new Map();
    #membership = new Map();
    #sessionId;
    #sourceId;
    #revision = 0;
    #destroyed = false;

    constructor(options = {}) {
        this.#bridge = createGalleryBridge(options.bridge);
        this.#sessionId = String(options.sessionId || 'default');
        this.#sourceId = String(options.sourceId || 'default');
        this.replaceItems(options.items || [], options.startId || null);
    }

    get bridge() {
        return this.#bridge;
    }

    snapshot() {
        return Object.freeze({
            sessionId: this.#sessionId,
            sourceId: this.#sourceId,
            revision: this.#revision,
            items: this.#visible.slice(),
            canonicalItems: this.#items.slice(),
            visibleIds: this.#visible.map(item => item.id),
            batches: Array.from(this.#batches.values(), batch => Object.freeze({
                id: batch.id, label: batch.label, ids: batch.ids.slice()
            })),
            membership: Object.freeze(Object.fromEntries(this.#membership)),
            currentId: this.#currentId,
            currentIndex: this.#visibleIndex.get(this.#currentId) ?? -1
        });
    }

    subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('listener must be a function');
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    replaceItems(items, preferredId = this.#currentId) {
        return this.reconcileItems(items, { preferredId });
    }

    // Compatibility boundary: hosts may still collect/enrich lists privately.
    // Core owns their canonical snapshot, projection and selected identity.
    reconcileItems(items, { preferredId = this.#currentId, visibleIds = null, batches = null } = {}) {
        const oldIndex = this.#visibleIndex.get(this.#currentId) ?? 0;
        const normalized = this.#normalizeUnique(items);
        this.#items = normalized;
        this.#itemsById = new Map(normalized.map((item) => [item.id, item]));
        this.#visibility = visibleIds == null ? null : new Set(visibleIds);
        if (batches) {
            this.#batches.clear();
            this.#membership.clear();
            for (const batch of batches) this.#recordBatch(batch.id, batch.label, batch.ids);
            const groups = new Map();
            for (const item of normalized) {
                const owner = this.#membership.get(item.id);
                if (owner && item.groupId) groups.set(item.groupId, owner);
            }
            let inherited = batches[0]?.id;
            const additions = new Map();
            for (const item of normalized) {
                const owner = this.#membership.get(item.id) || groups.get(item.groupId) || inherited;
                if (owner) {
                    if (!this.#membership.has(item.id)) {
                        if (!additions.has(owner)) additions.set(owner, []);
                        additions.get(owner).push(item.id);
                    }
                    inherited = owner;
                }
            }
            for (const [owner, ids] of additions) this.#recordBatch(owner, '', ids);
        } else {
            for (const batch of this.#batches.values()) batch.ids = batch.ids.filter(id => this.#itemsById.has(id));
            for (const id of this.#membership.keys()) if (!this.#itemsById.has(id)) this.#membership.delete(id);
        }
        // A hydrated child can be inserted beside its parent in an earlier
        // batch. Membership is stable, but paint order follows canonical order.
        for (const batch of this.#batches.values()) batch.ids = [];
        for (const item of normalized) {
            const owner = this.#membership.get(item.id);
            if (owner) this.#batches.get(owner)?.ids.push(item.id);
        }
        this.#project(preferredId, oldIndex);
        this.#emit('replace');
        return this.snapshot();
    }

    commitBatch({ sessionId = this.#sessionId, sourceId = this.#sourceId, batchId, label, items = [] }) {
        if (this.#destroyed || sessionId !== this.#sessionId || sourceId !== this.#sourceId) return false;
        if (!batchId) throw new TypeError('batchId is required');
        const oldIndex = this.#visibleIndex.get(this.#currentId) ?? 0;
        const incoming = this.#normalizeUnique(items);
        const index = new Map(this.#items.map((item, at) => [item.id, at]));
        for (const item of incoming) {
            if (index.has(item.id)) this.#items[index.get(item.id)] = item;
            else this.#items.push(item);
            this.#itemsById.set(item.id, item);
        }
        this.#recordBatch(String(batchId), label, incoming.map(item => item.id));
        this.#project(this.#currentId, oldIndex);
        this.#emit('batch');
        return this.snapshot();
    }

    setFilter(filter) {
        const oldIndex = this.#visibleIndex.get(this.#currentId) ?? 0;
        this.#filter = normalizeFilterState(filter);
        this.#visibility = null;
        this.#project(this.#currentId, oldIndex);
        this.#emit('filter');
        return this.snapshot();
    }

    navigate(delta, { wrap = true } = {}) {
        const length = this.#visible.length;
        if (!length) return this.position();
        const current = this.#visibleIndex.get(this.#currentId) ?? 0;
        const target = current + Math.trunc(Number(delta) || 0);
        const index = wrap ? ((target % length) + length) % length : Math.max(0, Math.min(length - 1, target));
        this.setCurrentId(this.#visible[index].id);
        return this.position();
    }

    position() {
        return { length: this.#visible.length, currentId: this.#currentId, currentIndex: this.#visibleIndex.get(this.#currentId) ?? -1 };
    }

    appendItems(items) {
        const normalized = this.#normalizeUnique(items, this.#itemsById);
        if (!normalized.length) return this.snapshot();
        for (const item of normalized) this.#itemsById.set(item.id, item);
        this.#items = this.#items.concat(normalized);
        this.#project();
        this.#emit('append');
        return this.snapshot();
    }

    patchItem(id, changes) {
        return this.patchMedia(id, changes);
    }

    patchMedia(id, changes, reason = 'patch') {
        if (this.#destroyed) return false;
        const current = this.#itemsById.get(id);
        if (!current) return false;
        const next = normalizeMediaItem({ ...current, ...changes, id });
        const index = this.#items.findIndex((item) => item.id === id);
        this.#items[index] = next;
        this.#itemsById.set(id, next);
        this.#project();
        this.#emit(reason);
        return true;
    }

    removeItems(ids) {
        const removed = new Set(ids);
        if (!removed.size) return this.snapshot();
        const oldIndex = this.#visibleIndex.get(this.#currentId) ?? 0;
        this.#items = this.#items.filter((item) => !removed.has(item.id));
        this.#itemsById = new Map(this.#items.map((item) => [item.id, item]));
        for (const id of removed) this.#membership.delete(id);
        for (const batch of this.#batches.values()) batch.ids = batch.ids.filter(id => !removed.has(id));
        this.#project(this.#currentId, oldIndex);
        this.#emit('remove');
        return this.snapshot();
    }

    setCurrentId(id) {
        if (!this.#visibleIndex.has(id) || id === this.#currentId) return false;
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
        this.#destroyed = true;
        this.#listeners.clear();
        this.#items = [];
        this.#itemsById.clear();
        this.#visible = [];
        this.#visibleIndex.clear();
        this.#batches.clear();
        this.#membership.clear();
        this.#visibility = null;
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

    #recordBatch(id, label, ids) {
        let batch = this.#batches.get(id);
        if (!batch) {
            batch = { id, label: label || 'Batch ' + (this.#batches.size + 1), ids: [] };
            this.#batches.set(id, batch);
        } else if (label) batch.label = label;
        const members = new Set(batch.ids);
        for (const member of ids || []) {
            if (!this.#itemsById.has(member) || members.has(member)) continue;
            const owner = this.#membership.get(member);
            if (owner && owner !== id) continue;
            batch.ids.push(member);
            members.add(member);
            this.#membership.set(member, id);
        }
    }

    #project(preferredId = this.#currentId, fallbackIndex = this.#visibleIndex.get(this.#currentId) ?? 0) {
        this.#visible = this.#visibility
            ? this.#items.filter(item => this.#visibility.has(item.id))
            : applyGalleryFilter(this.#items, this.#filter);
        this.#visibleIndex = new Map(this.#visible.map((item, index) => [item.id, index]));
        this.#currentId = this.#visibleIndex.has(preferredId) ? preferredId
            : (this.#visible[Math.min(Math.max(0, fallbackIndex), this.#visible.length - 1)]?.id || null);
    }

    #emit(reason) {
        this.#revision++;
        if (!this.#listeners.size) return;
        const event = Object.freeze({ reason, snapshot: this.snapshot() });
        for (const listener of this.#listeners) listener(event);
    }
}
