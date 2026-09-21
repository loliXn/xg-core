(function (root) {
    'use strict';

    const XGALLERY_CORE_API_VERSION = 1;
    const XGALLERY_CORE_VERSION = '0.8.1';

    const MEDIA_TYPES = Object.freeze([
        'img',
        'video',
        'iframe',
        'album'
    ]);

    const MEDIA_TYPE_SET = new Set(MEDIA_TYPES);

    function validateMediaItem(item) {
        const errors = [];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return ['item must be an object'];
        }
        if (typeof item.id !== 'string' || !item.id.trim()) {
            errors.push('id must be a non-empty string');
        }
        if (!MEDIA_TYPE_SET.has(item.type)) {
            errors.push('type must be one of: ' + MEDIA_TYPES.join(', '));
        }
        if (typeof item.src !== 'string' || !item.src.trim()) {
            errors.push('src must be a non-empty string');
        }
        if (item.thumbSrc != null && typeof item.thumbSrc !== 'string') {
            errors.push('thumbSrc must be a string when provided');
        }
        return errors;
    }

    function normalizeMediaItem(item) {
        const errors = validateMediaItem(item);
        if (errors.length) throw new TypeError(errors.join('; '));
        return {
            ...item,
            id: item.id.trim(),
            src: item.src.trim(),
            thumbSrc: String(item.thumbSrc || item.src).trim()
        };
    }

    // Content signatures outrank filenames and server MIME labels.
    async function inspectImageFormat(blob) {
        const bytes = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
        const text = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
        const result = (format, animated = false) => ({ format, animated,
            mime: 'image/' + (format === 'jpg' ? 'jpeg' : format) });
        if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return result('gif', true);
        if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return result('jpg');
        if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
            return result('webp', text(12, 4) === 'VP8X' && !!(bytes[20] & 2));
        }
        if (bytes[0] === 137 && text(1, 3) === 'PNG') {
            const view = new DataView(bytes.buffer);
            for (let at = 8; at + 8 <= bytes.length;) {
                const type = text(at + 4, 4);
                if (type === 'acTL') return result('png', true);
                if (type === 'IDAT' || type === 'IEND') break;
                at += 12 + view.getUint32(at);
            }
            return result('png');
        }
        return null;
    }

    /**
     * One budget for every byte the gallery fetches.
     *
     * The gallery used to have seven independent queues - thumbnail sniffing,
     * first-frame extraction, availability probes, image preloads, resolvers,
     * neighbour prefetch - each with its own limit and none of them aware of the
     * others. Right after a navigation that is fifteen to twenty requests against
     * one host, of which exactly one is the media the user is looking at, and it
     * had no priority over the other nineteen. Six concurrent requests is the
     * per-host ceiling for HTTP/1.1: past it a fresh <video> is not slow, it never
     * starts at all, and a CDN that is refusing the overflow answers 408 or 429,
     * which is how the stage reached "can't be loaded" for a file that plays
     * perfectly on its own.
     *
     * This is a gate, not a transport: callers keep GM_xmlhttpRequest, fetch, or a
     * plain Image, and only ask permission first. That keeps every existing queue's
     * own ordering intact while making the total spend visible in one place.
     *
     * Three rules do the work:
     *   - a per-host ceiling, set below the browser's own so there is headroom;
     *   - lanes, so the stage is served before anything decorative;
     *   - a barrier: while the stage is still fetching its first bytes, the lanes
     *     below it wait. Measured against a slow origin, that is the difference
     *     between a video that never loads and one that loads in six seconds.
     */

    const MEDIA_LANES = Object.freeze({
        STAGE: 0,       // the media on screen; never waits for anything
        VISIBLE: 1,     // thumbnails the user can see
        PREFETCH: 2,    // the next item, neighbour images, resolves
        BACKGROUND: 3   // off-screen thumbnails, probes, first-frame extraction
    });

    const LANE_NAMES = ['stage', 'visible', 'prefetch', 'background'];

    // How much else may run while the stage is still waiting for its first
    // bytes. Up to five concurrent fetches never delayed the stage in the
    // measurements; six starved it. Four leaves a margin. So the barrier is a narrowing, not a stop: the stage can be
    // slow for honest reasons - a big file on a slow host - and a strip that
    // froze for as long as a video took to start would be its own bug. The
    // first version did exactly that, then let one request through at a time,
    // and on a slow host that was a minute of nothing followed by everything.
    const BARRIER_WIDTH = 4;

    function hostOf(url) {
        const value = String(url || '');
        if (!value) return '';
        // Data and blob URLs cost no connection; they share one pseudo-host so a
        // burst of them cannot crowd out a real one either.
        if (/^(?:data|blob):/i.test(value)) return '(local)';
        const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(value);
        if (match) return match[1].toLowerCase();
        return '(relative)';
    }

    /**
     * @param {object} [options]
     * @param {number} [options.hostLimit] concurrent requests per host (default 4).
     * @param {number} [options.totalLimit] concurrent requests overall (default 10).
     * @param {function} [options.now]
     * @param {function} [options.setTimeout]
     */
    function createMediaGate(options) {
        const config = options || {};
        const hostLimit = Math.max(1, Number(config.hostLimit) || 4);
        const totalLimit = Math.max(1, Number(config.totalLimit) || 10);
        const now = typeof config.now === 'function' ? config.now : () => Date.now();
        const later = typeof config.setTimeout === 'function' ? config.setTimeout : ((fn, ms) => setTimeout(fn, ms));

        const waiting = [];                 // queued tickets, ordered on pick
        const liveByHost = new Map();       // host -> count
        const live = new Set();             // granted slots
        const cooldowns = new Map();        // host -> timestamp until which to hold back
        let liveTotal = 0;
        let stageBusySince = 0;
        let sequence = 0;
        let pumping = false;

        const barrierIsUp = () => stageBusySince > 0;
        // The stage's own slots are exempt from every limit, so they must not be
        // counted against the barrier either, or a big video would block it.
        const liveBelowStage = () => { let n = 0; live.forEach((t) => { if (t.lane !== MEDIA_LANES.STAGE) n += 1; }); return n; };

        function hostCount(host) {
            return liveByHost.get(host) || 0;
        }

        function coolingDown(host) {
            const until = cooldowns.get(host) || 0;
            if (!until) return 0;
            const left = until - now();
            if (left <= 0) { cooldowns.delete(host); return 0; }
            return left;
        }

        function canStart(ticket) {
            if (ticket.lane === MEDIA_LANES.STAGE) return true;
            // While the stage is fetching its first bytes everything else shares a
            // narrow lane, most useful first: thumbnails the user can see, then
            // prefetch, then background work.
            if (barrierIsUp() && liveBelowStage() >= BARRIER_WIDTH) return false;
            if (liveTotal >= totalLimit) return false;
            if (hostCount(ticket.host) >= hostLimit) return false;
            if (coolingDown(ticket.host)) return false;
            return true;
        }

        // Lane first, then the caller's own ordering hint (distance from the
        // current item), then arrival: a queue that reorders itself on every pump
        // rather than a fixed FIFO, because what is worth fetching changes as the
        // user moves.
        function pickIndex() {
            let best = -1;
            let bestTicket = null;
            for (let i = 0; i < waiting.length; i++) {
                const ticket = waiting[i];
                if (!canStart(ticket)) continue;
                if (!bestTicket
                    || ticket.lane < bestTicket.lane
                    || (ticket.lane === bestTicket.lane && ticket.weight < bestTicket.weight)
                    || (ticket.lane === bestTicket.lane && ticket.weight === bestTicket.weight && ticket.seq < bestTicket.seq)) {
                    best = i;
                    bestTicket = ticket;
                }
            }
            return best;
        }

        function pump() {
            if (pumping) return;
            pumping = true;
            try {
                for (;;) {
                    const index = pickIndex();
                    if (index < 0) break;
                    const ticket = waiting.splice(index, 1)[0];
                    grant(ticket);
                }
            } finally {
                pumping = false;
            }
            scheduleCooldownWake();
        }

        let pumpScheduled = false;
        function schedulePump() {
            if (pumpScheduled) return;
            pumpScheduled = true;
            Promise.resolve().then(() => { pumpScheduled = false; pump(); });
        }

        let cooldownTimer = null;
        function scheduleCooldownWake() {
            if (cooldownTimer || !waiting.length) return;
            let soonest = 0;
            waiting.forEach((ticket) => {
                const left = coolingDown(ticket.host);
                if (left && (!soonest || left < soonest)) soonest = left;
            });
            if (!soonest) return;
            cooldownTimer = later(() => { cooldownTimer = null; pump(); }, Math.max(50, soonest + 10));
        }

        function grant(ticket) {
            if (ticket.settled) return;
            ticket.settled = true;
            ticket.granted = true;
            liveTotal += 1;
            liveByHost.set(ticket.host, hostCount(ticket.host) + 1);
            live.add(ticket);
            ticket.resolve(ticket.slot);
        }

        function finish(ticket) {
            if (ticket.released) return;
            ticket.released = true;
            if (ticket.granted) {
                live.delete(ticket);
                liveTotal = Math.max(0, liveTotal - 1);
                liveByHost.set(ticket.host, Math.max(0, hostCount(ticket.host) - 1));
                if (!hostCount(ticket.host)) liveByHost.delete(ticket.host);
            } else if (!ticket.settled) {
                ticket.settled = true;
                const index = waiting.indexOf(ticket);
                if (index >= 0) waiting.splice(index, 1);
                ticket.resolve(null);
            }
            pump();
        }

        /**
         * Ask for a slot. Resolves with a slot object, or with null if the request
         * was cancelled before it ever started - a caller that gets null must not
         * fetch anything.
         *
         * @param {object} request
         * @param {string} request.url
         * @param {number} [request.lane] one of MEDIA_LANES.
         * @param {number} [request.weight] lower runs first inside a lane.
         * @param {string} [request.tag] for cancelling a group later.
         * @param {function} [request.onAbort] called if the job is cancelled while running.
         */
        function acquire(request) {
            const spec = request || {};
            const ticket = {
                url: String(spec.url || ''),
                host: hostOf(spec.url),
                lane: Number.isFinite(spec.lane) ? spec.lane : MEDIA_LANES.BACKGROUND,
                weight: Number.isFinite(spec.weight) ? spec.weight : 0,
                tag: spec.tag || '',
                onAbort: typeof spec.onAbort === 'function' ? spec.onAbort : null,
                seq: ++sequence,
                settled: false,
                granted: false,
                released: false,
                resolve: null,
                slot: null
            };
            ticket.slot = {
                url: ticket.url,
                host: ticket.host,
                lane: ticket.lane,
                get lane_name() { return LANE_NAMES[ticket.lane] || String(ticket.lane); },
                release() { finish(ticket); },
                // A caller that learns something about the host (a 429, a timeout)
                // reports it here so every other lane backs off too.
                report(result) { noteResult(ticket.url, result); }
            };
            const promise = new Promise((resolve) => { ticket.resolve = resolve; });
            waiting.push(ticket);
            // A burst of requests arrives in one tick - a strip filling in asks
            // for thirty at once - and the pump must see the whole burst before it
            // picks, or whichever was submitted first wins regardless of lane.
            schedulePump();
            return promise;
        }

        /**
         * Cancel everything matching: queued tickets never start, running ones get
         * their onAbort called. Used when a cell is recycled, the gallery closes,
         * or the stage needs the network to itself.
         */
        function abort(filter) {
            const matches = (ticket) => {
                if (typeof filter === 'function') return !!filter(ticket);
                if (!filter) return true;
                if (filter.tag != null && ticket.tag !== filter.tag) return false;
                if (filter.lane != null && ticket.lane !== filter.lane) return false;
                if (filter.laneAtLeast != null && ticket.lane < filter.laneAtLeast) return false;
                if (filter.host != null && ticket.host !== filter.host) return false;
                return true;
            };
            let cancelled = 0;
            for (let i = waiting.length - 1; i >= 0; i--) {
                const ticket = waiting[i];
                if (!matches(ticket)) continue;
                waiting.splice(i, 1);
                ticket.settled = true;
                ticket.released = true;
                ticket.resolve(null);
                cancelled += 1;
            }
            Array.from(live).forEach((ticket) => {
                if (!matches(ticket)) return;
                cancelled += 1;
                const onAbort = ticket.onAbort;
                ticket.onAbort = null;
                finish(ticket);
                if (onAbort) { try { onAbort(); } catch (e) { } }
            });
            pump();
            return cancelled;
        }

        /**
         * The barrier. Raised while the stage is fetching its first bytes, lowered
         * when it has them - or when it gives up.
         */
        function setStageBusy(busy) {
            const next = busy ? (stageBusySince || now()) : 0;
            if (next === stageBusySince) return;
            stageBusySince = next;
            pump();
        }

        // A host that refuses work is told once and every lane hears it.
        function noteResult(url, result) {
            const host = hostOf(url);
            if (!host || !result) return;
            const status = Number(result.status);
            // Status 0 is not the host talking: it is a cancelled request, a
            // blocked one, or a network blip on this end, and one dead thumbnail
            // must not pause every request to the site. Only what the host
            // actually answered, or a timeout, backs it off.
            const transient = result.timeout === true || status === 408 || status === 429 || status >= 500;
            if (!transient) {
                if (status >= 200 && status < 400) cooldowns.delete(host);
                return;
            }
            const retryAfter = Number(result.retryAfter);
            const base = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(60000, retryAfter * 1000)
                : Math.min(30000, 2000 * Math.max(1, Number(result.attempt) || 1));
            cooldowns.set(host, Math.max(cooldowns.get(host) || 0, now() + base));
            scheduleCooldownWake();
        }

        function stats() {
            const lanes = [0, 0, 0, 0];
            waiting.forEach((ticket) => { lanes[ticket.lane] = (lanes[ticket.lane] || 0) + 1; });
            return {
                live: liveTotal,
                waiting: waiting.length,
                waitingByLane: lanes,
                hosts: Array.from(liveByHost.entries()).map(([host, count]) => ({ host, count })),
                cooling: Array.from(cooldowns.keys()),
                barrier: barrierIsUp() ? 'up' : 'down'
            };
        }

        return { acquire, abort, setStageBusy, noteResult, stats, LANES: MEDIA_LANES, hostOf };
    }

    // One gate per page. Core and the adapter both reach for this rather than
    // each making their own - two budgets would be no budget at all.
    let sharedGate = null;
    function sharedMediaGate(options) {
        if (!sharedGate) sharedGate = createMediaGate(options);
        return sharedGate;
    }

    /**
     * What a video's thumbnail should be, decided in one place.
     *
     * This used to be a ladder of ifs inside the painting code, and every adapter
     * met a slightly different rung of it. Two things went wrong there and both
     * were visible:
     *
     *   - a cell could end up with a real <video> element, which costs a decoder
     *     and a connection per thumbnail and, when the item's own file was the
     *     preview, fetched the very file the stage was streaming;
     *   - a cell could end up with the original animated GIF in an <img>, playing,
     *     because the freeze pipeline had a timeout that fell back to the raw URL.
     *
     * So the rule is now stated rather than implied: **a thumbnail is one still
     * frame.** Five outcomes, in order of what they cost:
     *
     *   frozen      - a frame we already extracted for this item; free.
     *   still       - a poster image the site gave us; one cheap image request.
     *   freeze      - a poster that may itself animate, so it goes through the
     *                 inspect-and-freeze path and is painted as a single frame.
     *   extract     - no poster at all: pull the first frame out of the file.
     *   placeholder - nothing is available, or extraction is not possible here.
     *
     * `video` is a sixth outcome that an adapter has to ask for explicitly, for a
     * host that has no poster and no extractable container. Nothing opts in today.
     */

    const THUMB_PLANS = Object.freeze(['frozen', 'still', 'freeze', 'extract', 'video', 'placeholder']);

    /**
     * @param {object} input
     * @param {string} [input.frozen] a frame already extracted for this item.
     * @param {string} [input.thumbSrc] the thumbnail URL the painter was handed.
     * @param {string} [input.itemThumbSrc] the item's own thumbnail URL.
     * @param {string} [input.src] the media's URL.
     * @param {function} input.isPlaceholderUrl
     * @param {function} input.isImageUrl an image URL, by the adapter's rules.
     * @param {function} [input.mayAnimate] the URL could be an animated image.
     * @param {function} [input.canExtract] a first frame can be pulled from this item.
     * @param {boolean} [input.allowVideoElement] adapter opt-in, off by default.
     * @param {boolean} [input.preferExtract] extraction beats a poster here.
     * @returns {{kind: string, url: string}}
     */
    function planVideoThumb(input) {
        const spec = input || {};
        const isPlaceholderUrl = spec.isPlaceholderUrl || (() => false);
        const isImageUrl = spec.isImageUrl || (() => false);
        const mayAnimate = spec.mayAnimate || (() => false);
        const canExtract = typeof spec.canExtract === 'function' ? spec.canExtract : () => !!spec.canExtract;

        if (spec.frozen) return { kind: 'frozen', url: String(spec.frozen) };

        const posterCandidates = [spec.thumbSrc, spec.itemThumbSrc];
        let poster = '';
        for (let i = 0; i < posterCandidates.length; i++) {
            const candidate = String(posterCandidates[i] || '');
            if (!candidate) continue;
            if (isPlaceholderUrl(candidate)) continue;
            // Only an image can be a poster. That is also what keeps a cell from
            // pointing at the media file itself, which is how a thumbnail ended up
            // streaming the very thing the stage was streaming, twice over the
            // same host budget - while a still, or a GIF standing in for a video,
            // is legitimately its own poster and still gets frozen below.
            if (!isImageUrl(candidate) && !/^data:image\//i.test(candidate)) continue;
            poster = candidate;
            break;
        }

        // A feed whose posters are known to be worse than the real first frame
        // (a blurred or letterboxed placeholder) can ask for extraction first.
        if (poster && !(spec.preferExtract && canExtract())) {
            return { kind: mayAnimate(poster) ? 'freeze' : 'still', url: poster };
        }
        if (canExtract()) return { kind: 'extract', url: String(spec.src || '') };
        if (spec.allowVideoElement === true) {
            const playable = String(spec.src || spec.thumbSrc || '');
            if (playable && !isPlaceholderUrl(playable)) return { kind: 'video', url: playable };
        }
        return { kind: 'placeholder', url: '' };
    }

    const BRIDGE_METHODS = Object.freeze([
        'resolveItem',
        'requestMore',
        'performAction',
        'download',
        'close',
        'settingsChanged'
    ]);

    const CORE_EVENTS = Object.freeze([
        'replace',
        'append',
        'patch',
        'remove',
        'navigate',
        'action',
        'more'
    ]);

    const noop = () => undefined;

    function createGalleryBridge(overrides = {}) {
        const bridge = {};
        for (const method of BRIDGE_METHODS) {
            const candidate = overrides[method];
            bridge[method] = typeof candidate === 'function' ? candidate : noop;
        }
        return Object.freeze(bridge);
    }

    class GalleryController {
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

    const OVERLAY_CSS = String.raw`
            :root, .ms-gallery-overlay, .ms-r34-settings-overlay {
                /* Surface ladder and hairline borders for the overlay chrome. */
                --ms-bg: hsl(220, 8%, 8%);
                --ms-surface-1: hsl(220, 7%, 9%);
                --ms-surface-2: hsl(220, 7%, 10%);
                --ms-surface-3: hsl(220, 7%, 13%);
                --ms-hairline: rgba(255, 255, 255, 0.08);
                --ms-line: rgba(255, 255, 255, 0.16);
                --ms-line-strong: rgba(255, 255, 255, 0.26);
                --ms-line-soft: var(--ms-hairline);
                --ms-text: hsl(40, 22%, 88%);
                --ms-text-2: hsl(38, 14%, 80%);
                --ms-text-3: hsl(35, 10%, 62%);
                --ms-text-4: hsl(35, 7%, 46%);
                /* One accent, driven by three channels. Everything derived from it -
                   tint, line, hover, links, and the ink that sits on an accent fill -
                   is computed here, so the live accent setting only has to write
                   the --xg-accent-* inputs on :root, which inherit into the shadow
                   roots too. Default hsl(223, 78%, 65%): lighter and less saturated
                   than the old 57% blue, and it passes 4.5:1 as text on every dark
                   surface, which the old one did not (3.4-3.8:1). */
                --ms-accent-h: var(--xg-accent-h, 223);
                --ms-accent-s: var(--xg-accent-s, 78%);
                --ms-accent-l: var(--xg-accent-l, 65%);
                --ms-accent: hsl(var(--ms-accent-h), var(--ms-accent-s), var(--ms-accent-l));
                --ms-accent-tint: hsla(var(--ms-accent-h), var(--ms-accent-s), var(--ms-accent-l), 0.13);
                --ms-accent-tint-strong: hsla(var(--ms-accent-h), var(--ms-accent-s), var(--ms-accent-l), 0.22);
                --ms-accent-line: hsla(var(--ms-accent-h), var(--ms-accent-s), var(--ms-accent-l), 0.72);
                --ms-accent-hover: hsl(var(--ms-accent-h), var(--ms-accent-s), min(92%, calc(var(--ms-accent-l) + 5%)));
                --ms-accent-link: hsl(var(--ms-accent-h), min(100%, calc(var(--ms-accent-s) + 4%)), min(90%, calc(var(--ms-accent-l) + 8%)));
                --ms-accent-link-hover: hsl(var(--ms-accent-h), min(100%, calc(var(--ms-accent-s) + 8%)), min(94%, calc(var(--ms-accent-l) + 17%)));
                /* White fails on any accent light enough to pass as text, so the ink
                   on an accent fill is dark unless applyAccent picks otherwise. */
                --ms-on-accent: hsl(220, 8%, var(--xg-on-accent-l, 8%));
                --ms-hover: rgba(255, 255, 255, 0.08);
                --ms-pressed: rgba(255, 255, 255, 0.12);
                --ms-control-rest: rgba(255, 255, 255, 0.035);
                --ms-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.25);
                --ms-shadow-md: 0 4px 12px rgba(0, 0, 0, 0.35);
                --ms-shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.45);
                --ms-ease: cubic-bezier(0.4, 0, 0.2, 1);
                --ms-ease-out: cubic-bezier(0.215, 0.61, 0.355, 1);
                --ms-font-ui: "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif;
                --ms-font-data: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            }
            @supports not (backdrop-filter: blur(12px)) {
                .ms-gallery-topbar, .ms-thumbs-wrap, .ms-dropdown-menu, .ms-grid-controls {
                    background: var(--ms-surface-1);
                }
            }
            #ms-loading-overlay {
                position: fixed;
                inset: 0;
                background: hsla(220, 8%, 8%, 0.96);
                z-index: 2147483645;
                display: none;
                align-items: center;
                justify-content: center;
                color: var(--ms-text);
                font-family: var(--ms-font-ui) !important;
                flex-direction: column;
                text-align: center;
                pointer-events: auto;
            }
            #ms-loading-overlay .ms-loading-main {
                font-size: 18px;
                font-weight: 700;
                margin-bottom: 8px;
            }
            #ms-loading-overlay .ms-loading-sub {
                font-size: 12px;
                opacity: 0.8;
            }

            .ms-gallery-overlay {
                --ms-topbar-h: 50px;
                --ms-filter-h: 0px;
                --ms-thumbs-h: 90px;
                --ms-tags-w: 420px;
                position: fixed;
                inset: 0;
                background: var(--ms-bg);
                z-index: 2147483646;
                display: none;
                opacity: 0;
                visibility: hidden;
                pointer-events: none;
                transition: opacity 160ms var(--ms-ease-out), visibility 160ms var(--ms-ease-out);
                color: var(--ms-text);
                font-family: var(--ms-font-ui) !important;
            }
            .ms-gallery-overlay,
            .ms-gallery-overlay * {
                box-sizing: border-box;
            }
            /* The gallery is its own layout world.
               Without this, every geometry read inside the viewer - the width of
               the top bar, the strip's scroll position - forces the browser to lay
               out the whole host document first. On a big page (an imageboard
               thread of half a million nodes) one such read costs tens of
               milliseconds, and a navigation makes a dozen of them; containment
               keeps that work inside the overlay, which is a few hundred nodes.

               It has to be strict (layout + paint + size + style): the browser
               will only lay out a subtree on its own if the subtree's own size
               cannot change, and layout containment alone does not promise that.
               With layout+paint+style alone a trace still showed a full-document
               layout - 5 dirty objects, 933,592 laid out, 22 ms - several times
               per navigation. Size containment is safe for all three boxes below
               because none of them is sized by its contents: the overlay fills the
               viewport (inset: 0), and the strip and the grid fill panels of a
               fixed height. */
            .ms-gallery-overlay {
                contain: strict;
            }
            /* The panels inside it are contained too, but without size: their
               widths come from the overlay, and a scroller whose own size is
               contained is a needless risk for the strip's centring maths. */
            .ms-thumbs-track,
            .ms-grid-wrap {
                contain: layout paint style;
            }
            /* Buttons/inputs/selects/links don't inherit font-family by default
               (browser UA stylesheet quirk), so host-page styles can otherwise
               leak through and make them look mismatched from the rest of the UI. */
            .ms-gallery-overlay button,
            .ms-gallery-overlay input,
            .ms-gallery-overlay select,
            .ms-gallery-overlay a {
                font-family: inherit !important;
            }
            /* Some hosts restyle raw form controls. Isolation keeps overlay chrome ours. */
            .ms-gallery-overlay.ms-reset-host,
            .ms-gallery-overlay.ms-pixeldrain {
                isolation: isolate;
            }
            .ms-gallery-overlay.ms-open {
                display: block;
                opacity: 1;
                visibility: visible;
                pointer-events: auto;
            }
            .ms-gallery-overlay:not(.ms-open) {
                pointer-events: none !important;
            }
            .ms-gallery-overlay.ms-opening {
                display: block;
                visibility: visible;
                pointer-events: none !important;
            }
            .ms-gallery-overlay.ms-opening .ms-gallery-topbar {
                transform: translateX(-50%) translateY(-4px);
                opacity: 0;
            }
            .ms-gallery-overlay.ms-opening .ms-gallery-stage,
            .ms-gallery-overlay.ms-opening .ms-thumbs-wrap {
                transform: translateY(3px);
                opacity: 0;
            }
            .ms-gallery-overlay .ms-gallery-topbar,
            .ms-gallery-overlay .ms-filter-bar,
            .ms-gallery-overlay .ms-gallery-stage,
            .ms-gallery-overlay .ms-thumbs-wrap {
                transition: opacity 160ms var(--ms-ease-out), transform 160ms var(--ms-ease-out);
            }
            .ms-gallery-overlay.ms-thumbs-hidden {
                --ms-thumbs-h: 0px;
            }
            .ms-gallery-overlay.ms-thumbs-hidden .ms-thumbs-wrap {
                transform: translateY(110%);
                opacity: 0;
                pointer-events: none;
            }
            .ms-gallery-overlay .ms-tags-overlay.active {
                height: var(--ms-info-height, 100%);
                max-height: 100%;
                align-self: flex-start;
            }
            .ms-tags-header { cursor: grab; touch-action: none; }
            .ms-tags-header:active { cursor: grabbing; }
            .ms-info-height-grip { position:absolute;bottom:0;left:16px;right:16px;height:10px;cursor:ns-resize;touch-action:none;z-index:30; }
            .ms-info-height-grip::after { content:'';position:absolute;left:calc(50% - 22px);bottom:3px;width:44px;height:3px;border-radius:3px;background:var(--ms-line-strong); }
            .ms-info-height-grip:hover::after { background:var(--ms-text-3); }
            .ms-gallery-overlay[data-info-layout$="right"] .ms-tags-resizer { right:auto;left:0; }
            .ms-gallery-overlay[data-info-layout="right"] .ms-tags-overlay.active,
            .ms-gallery-overlay[data-info-layout="edge-right"] .ms-tags-overlay.active { order:2;margin-left:16px;margin-right:0; }
            .ms-gallery-overlay[data-info-layout="edge-left"] .ms-gallery-stage:has(.ms-tags-overlay.active) { padding-left:calc(var(--ms-tags-w) + 32px); }
            .ms-gallery-overlay[data-info-layout="edge-right"] .ms-gallery-stage:has(.ms-tags-overlay.active) { padding-right:calc(var(--ms-tags-w) + 32px); }
            .ms-gallery-overlay[data-info-layout="edge-left"] .ms-tags-overlay.active { position:absolute;left:16px;top:calc(var(--ms-topbar-h) + var(--ms-filter-h) + 16px); }
            .ms-gallery-overlay[data-info-layout="edge-right"] .ms-tags-overlay.active { position:absolute;right:16px;top:calc(var(--ms-topbar-h) + var(--ms-filter-h) + 16px); }
            .ms-gallery-overlay[data-info-layout^="edge-"] .ms-tags-overlay.active { max-height:calc(100% - var(--ms-topbar-h) - var(--ms-filter-h) - var(--ms-thumbs-h) - 30px); }
            /* Closing: the overlay stays up, fully opaque and emptied, while the
               page underneath is scrolled back to the post being viewed. Hides the
               virtual list's re-render/re-anchor thrash instead of letting the user
               watch the page jump around. */
            .ms-gallery-overlay.ms-closing {
                background: #000;
                transition: none;
            }
            .ms-gallery-overlay.ms-closing > * {
                visibility: hidden;
            }

            .ms-gallery-topbar {
                position: absolute;
                top: 10px;
                left: 50%;
                transform: translateX(-50%);
                width: calc(100% - 40px);
                max-width: 95%;
                height: 40px;
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
                align-items: center;
                column-gap: 12px;
                z-index: 100;
                pointer-events: auto;
                background: rgba(24, 25, 28, 0.97);
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
                border: 1px solid var(--ms-hairline);
                border-radius: 10px;
                padding: 0 14px;
                box-sizing: border-box;
                box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
            }
            .ms-gallery-info {
                grid-column: 1;
                min-width: 0;
                width: fit-content;
                max-width: 100%;
                justify-self: start;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                font-size: 12px;
                opacity: 0.9;
            }
            /* X byline: avatar + clickable poster name, then the post link. */
            .ms-info-byline {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                min-width: 0;
                max-width: 100%;
                color: var(--ms-text-2);
                vertical-align: middle;
            }
            .ms-info-avatar {
                width: 18px;
                height: 18px;
                border-radius: 50%;
                flex-shrink: 0;
                object-fit: cover;
                background: var(--ms-surface-3);
            }
            .ms-info-author {
                color: #e7e9ea !important;
                font-weight: 600;
                text-decoration: none;
                flex-shrink: 0;
                max-width: 16ch;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .ms-gallery-overlay .ms-info-author:hover {
                text-decoration: none;
                color: var(--ms-accent) !important;
            }
            .ms-info-sep { color: #71767b; margin-right: 2px; }
            .ms-info-byline > a:last-child {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .ms-gallery-controls {
                grid-column: 3;
                /* Grid items default to min-width:auto, which floors their size
                   at their content's own min-content width - since these buttons
                   are nowrap + flex-shrink:0, that floor is the FULL unshrunk row,
                   so the minmax(0, 1fr) track cap above never actually took effect
                   and the row just spilled leftward into the center cluster's
                   column. min-width:0 lets the grid track actually clamp this box,
                   which both contains it and makes updateTopbarCompact()'s
                   scrollWidth-vs-clientWidth overflow check start seeing real
                   overflow instead of two numbers that were always equal. */
                min-width: 0;
                max-width: 100%;
                justify-self: end;
                display: flex;
                flex-wrap: nowrap;
                justify-content: flex-end;
                gap: 4px;
                align-items: center;
            }
            .ms-gallery-overlay .ms-btn {
                border: 1px solid transparent;
                background: transparent;
                color: var(--ms-text-3);
                border-radius: 8px;
                height: 32px;
                padding: 0 10px;
                cursor: pointer;
                font-weight: 500;
                font-size: 11px;
                transition: color 150ms var(--ms-ease), background-color 150ms var(--ms-ease);
                text-transform: uppercase;
                letter-spacing: 0.5px;
                white-space: nowrap !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                line-height: 1 !important;
                flex-shrink: 0;
                box-shadow: none;
                outline: none;
            }
            /* The display:inline-flex !important above exists to survive hostile
               host-page button styling, but it also beat every inline
               style.display='none' we set - so the Favorite heart, Loop and HD
               buttons were visible on sites that never support them. Re-hide via
               a higher-specificity rule that matches the inline style itself. */
            .ms-gallery-overlay .ms-btn[style*="display:none"],
            .ms-gallery-overlay .ms-btn[style*="display: none"],
            .ms-gallery-overlay .ms-icon-btn[style*="display:none"],
            .ms-gallery-overlay .ms-icon-btn[style*="display: none"] {
                display: none !important;
            }
            .ms-gallery-overlay .ms-btn:hover {
                background: var(--ms-hover);
                color: var(--ms-text);
            }
            .ms-gallery-overlay .ms-btn:active { background: var(--ms-pressed); }
            .ms-gallery-overlay .ms-btn.active:hover { background: var(--ms-accent-tint-strong); }
            .ms-gallery-overlay .ms-gallery-topbar .ms-btn,
            .ms-gallery-overlay .ms-gallery-topbar .ms-icon-btn {
                border: none;
                box-shadow: none;
                outline: none;
                height: 30px;
            }
            .ms-gallery-overlay .ms-gallery-topbar .ms-icon-btn { width: 30px; }
            .ms-gallery-overlay .ms-gallery-topbar .ms-btn-icon,
            .ms-gallery-overlay .ms-gallery-topbar .ms-icon-btn svg {
                width: 12px;
                height: 12px;
            }
            .ms-btn-icon {
                width: 16px;
                height: 16px;
                stroke: currentColor;
                fill: none;
                vertical-align: -1px;
                margin-right: 6px;
                flex-shrink: 0;
            }

            .ms-filter-bar {
                position: absolute;
                top: calc(var(--ms-topbar-h) + 8px);
                right: 20px;
                left: auto;
                transform: translateY(-6px) scale(0.985);
                transform-origin: top right;
                width: min(620px, calc(100% - 24px));
                z-index: 100;
                box-sizing: border-box;
                padding: 12px;
                border: 1px solid var(--ms-line);
                border-radius: 12px;
                background: var(--ms-surface-2);
                box-shadow: var(--ms-shadow-md);
                display: flex;
                flex-direction: column;
                gap: 12px;
                opacity: 0;
                visibility: hidden;
                pointer-events: none;
                transition: opacity 160ms var(--ms-ease-out), transform 160ms var(--ms-ease-out), visibility 160ms var(--ms-ease-out);
            }
            .ms-gallery-overlay.ms-filter-open .ms-filter-bar {
                transform: translateY(0) scale(1);
                opacity: 1;
                visibility: visible;
                pointer-events: auto;
            }
            .ms-filter-row,
            .ms-filter-toolbar {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
                align-items: center;
            }
            .ms-filter-search {
                position: relative;
                flex: 1 1 220px;
                min-width: 0;
            }
            .ms-filter-search-icon,
            .ms-filter-bar svg {
                width: 14px;
                height: 14px;
                flex-shrink: 0;
            }
            .ms-filter-search-icon {
                position: absolute;
                left: 12px;
                top: 50%;
                transform: translateY(-50%);
                color: var(--ms-text-4);
                pointer-events: none;
                display: inline-flex;
            }
            .ms-filter-input,
            .ms-filter-pair input {
                width: 100%;
                height: 40px;
                box-sizing: border-box;
                border: 1px solid var(--ms-line);
                border-radius: 10px;
                background: var(--ms-surface-1);
                color: var(--ms-text);
                padding: 0 52px 0 36px;
                font-size: 13px;
            }
            .ms-filter-pair input { padding: 0 12px; }
            .ms-filter-input:focus,
            .ms-filter-pair input:focus {
                outline: none;
                border-color: var(--ms-accent-line);
                box-shadow: 0 0 0 3px var(--ms-accent-tint);
            }
            .ms-filter-kbd {
                position: absolute;
                right: 8px;
                top: 50%;
                transform: translateY(-50%);
                display: none;
                align-items: center;
                gap: 3px;
                padding: 2px 6px;
                border: 1px solid var(--ms-line);
                border-radius: 6px;
                background: var(--ms-surface-3);
                color: var(--ms-text-4);
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                font-size: 10px;
                pointer-events: none;
            }
            @media (min-width: 640px) {
                .ms-filter-kbd { display: inline-flex; }
            }
            .ms-filter-actions {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
            }
            .ms-filter-submit,
            .ms-filter-copy,
            .ms-filter-kind,
            .ms-filter-extras-toggle,
            .ms-filter-reset,
            .ms-filter-type,
            .ms-filter-chip {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                border: 1px solid var(--ms-line);
                background: transparent;
                color: var(--ms-text-3);
                cursor: pointer;
            }
            .ms-filter-submit,
            .ms-filter-copy {
                height: 40px;
                padding: 0 14px;
                border-radius: 10px;
                font-size: 12px;
                font-weight: 650;
            }
            .ms-filter-submit {
                border-color: var(--ms-accent-line);
                background: var(--ms-accent);
                color: var(--ms-on-accent);
            }
            .ms-filter-copy:hover,
            .ms-filter-kind:hover,
            .ms-filter-extras-toggle:hover,
            .ms-filter-reset:hover,
            .ms-filter-type:hover,
            .ms-filter-chip:hover {
                background: var(--ms-hover);
                color: var(--ms-text);
            }
            .ms-filter-toolbar { justify-content: space-between; }
            .ms-filter-kinds,
            .ms-filter-toolbar-end { display: flex; flex-wrap: wrap; gap: 6px; }
            .ms-filter-kind,
            .ms-filter-extras-toggle,
            .ms-filter-reset {
                height: 30px;
                padding: 0 10px;
                border-radius: 8px;
                font-size: 11px;
                font-weight: 600;
            }
            .ms-filter-kind.is-active {
                border-color: var(--ms-accent-line);
                background: var(--ms-accent);
                color: var(--ms-on-accent);
            }
            .ms-filter-extras {
                display: grid;
                grid-template-columns: 1fr;
                gap: 12px;
                padding-top: 12px;
                border-top: 1px solid var(--ms-hairline);
            }
            @media (min-width: 900px) {
                .ms-filter-extras {
                    grid-template-columns: 1.45fr 1fr;
                }
            }
            .ms-filter-field {
                display: flex;
                flex-direction: column;
                gap: 8px;
                min-width: 0;
            }
            .ms-filter-field > span {
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                font-size: 10px;
                letter-spacing: 0.09em;
                text-transform: uppercase;
                color: var(--ms-text-4);
            }
            .ms-filter-hide-unavailable { justify-self: start; padding-inline: 12px; }
            .ms-filter-types {
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 6px;
            }
            @media (min-width: 520px) {
                .ms-filter-types { grid-template-columns: repeat(5, minmax(0, 1fr)); }
            }
            .ms-filter-type {
                height: 32px;
                border-radius: 8px;
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                font-size: 11px;
                letter-spacing: 0.08em;
            }
            .ms-filter-type.is-active {
                border-color: var(--ms-accent-line);
                background: var(--ms-accent-tint);
                color: var(--ms-text);
            }
            .ms-filter-pair {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 8px;
            }
            .ms-filter-chips {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
            }
            .ms-filter-chip {
                height: 26px;
                padding: 0 8px;
                border-radius: 999px;
                font-size: 11px;
                background: var(--ms-surface-1);
            }
            .ms-filter-chip svg { width: 10px; height: 10px; }

            .ms-gallery-stage {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
                padding: calc(var(--ms-topbar-h) + var(--ms-filter-h) + 16px) 40px calc(var(--ms-thumbs-h) + 14px) 40px;
                box-sizing: border-box;
            }
            .ms-media-wrap {
                width: 100%;
                height: 100%;
                display: flex;
                align-items: center;
                justify-content: center;
                position: relative;
                overflow: hidden;
                transition: max-width 200ms var(--ms-ease-out);
            }
            .ms-gallery-overlay .ms-media-wrap {
                min-width: 0 !important;
                min-height: 0 !important;
                overflow: hidden !important;
                box-sizing: border-box !important;
            }
            .ms-gallery-overlay .ms-media-box {
                min-width: 0 !important;
                min-height: 0 !important;
                box-sizing: border-box !important;
            }
            .ms-gallery-overlay .ms-media-box > img,
            .ms-gallery-overlay .ms-media-box > video {
                object-fit: contain !important;
            }
            .ms-media-box {
                position: relative;
                flex: 0 0 auto;
                max-width: 100%;
                max-height: 100%;
                overflow: hidden;
                border-radius: 4px;
                background: #000;
            }
            .ms-media-box > .ms-media,
            .ms-media-box > img,
            .ms-media-box > video,
            .ms-media-box > iframe {
                position: absolute;
                inset: 0;
                width: 100% !important;
                height: 100% !important;
                max-width: none !important;
                max-height: none !important;
                min-width: 0 !important;
                min-height: 0 !important;
                object-fit: cover;
                border-radius: 4px;
                display: block;
                background: #000;
                margin: 0;
            }
            .ms-fit-vertical .ms-media-box > img,
            .ms-fit-vertical .ms-media-box > video {
                object-fit: fill;
            }
            /* With the description panel open, cap the image's share of the
               stage instead of letting it fill all remaining flex space - tied
               to --ms-tags-w so dragging the panel narrower (see
               bindTagsPanelResizer) directly grows the image, and vice versa. */
            .ms-gallery-overlay.ms-has-tags-panel:not(.ms-grid-mode) .ms-media-wrap {
                max-width: min(1000px, calc(100vw - var(--ms-tags-w) - 80px));
            }
            .ms-gallery-overlay.ms-has-tags-panel[data-info-layout^="edge-"]:not(.ms-grid-mode) .ms-media-wrap {
                max-width: 100%;
                flex: 1 1 auto;
                min-width: 0;
            }
            :host-context(html[data-xg-minimal-motion="1"]) *,
            :host-context(html[data-xg-minimal-motion="1"]) *::before,
            :host-context(html[data-xg-minimal-motion="1"]) *::after {
                animation-duration: 0.001ms !important;
                animation-delay: 0ms !important;
                transition-duration: 0ms !important;
                transition-delay: 0ms !important;
                scroll-behavior: auto !important;
            }
            /* The stage centres the [panel, image] pair as one unit, so the image
               always sits (panel width + gap) / 2 right of true centre. Reclaiming
               the stage's left padding while the panel is open pulls the whole
               group back toward the middle. Widening the panel via its drag handle
               trades this back again. */
            .ms-gallery-overlay.ms-has-tags-panel:not(.ms-grid-mode) .ms-gallery-stage {
                padding-left: 8px;
            }

            .ms-media-wrap > .ms-media,
            .ms-media-wrap > img,
            .ms-media-wrap > video,
            .ms-media-wrap > iframe {
                position: absolute;
                inset: 0;
                margin: auto;
                width: auto;
                height: auto;
                max-width: 100%;
                max-height: 100%;
                border-radius: 4px;
                display: block;
                background: #000;
                outline: none;
                border: none;
            }
            .ms-media-wrap iframe {
                width: 100%;
                height: 100%;
                max-width: 100%;
                max-height: 100%;
            }
            .ms-media-wrap .ms-media {
                opacity: 1;
                transform: none;
                filter: none;
                transition: none;
                z-index: 3;
            }
            .ms-media-wrap img.ms-loading-thumb {
                z-index: 2;
                pointer-events: none;
                width: 100%;
                height: 100%;
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
            }
            .ms-fit-vertical .ms-media-wrap img.ms-loading-thumb {
                object-fit: fill;
            }
            .ms-media-wrap video.ms-media:not(.ms-ready) {
                opacity: 0;
            }
            .ms-caption-overlay {
                position: absolute;
                left: 0;
                right: 0;
                z-index: 6;
                max-height: 38%;
                overflow: auto;
                color: var(--ms-text);
                font-size: var(--ms-tags-font, 15px);
                line-height: 1.45;
                pointer-events: none;
                box-sizing: border-box;
                overflow-wrap: anywhere;
                text-shadow: 0 1px 3px rgba(0,0,0,.85);
            }
            .ms-caption-overlay p { margin: 0 0 .45em; }
            .ms-caption-overlay p:last-child { margin-bottom: 0; }
            .ms-caption-overlay.ms-caption-bottom {
                top: auto;
                bottom: 0;
                padding: 24px 18px 14px;
                background: linear-gradient(transparent, rgba(0, 0, 0, 0.78));
            }
            .ms-caption-overlay.ms-caption-top {
                top: 0;
                bottom: auto;
                padding: 14px 18px 24px;
                background: linear-gradient(rgba(0, 0, 0, 0.78), transparent);
            }
            .ms-caption-overlay a {
                color: var(--ms-accent);
                pointer-events: auto;
            }
            .ms-caption-overlay.ms-caption-snapchat {
                max-height: none;
                overflow: hidden;
                font-size: calc(var(--ms-tags-font, 15px) * 1.35);
                font-weight: 650;
                line-height: 1.25;
                text-align: center;
                padding: 10px 14px;
                background: rgba(0, 0, 0, 0.7);
                cursor: grab;
                pointer-events: auto;
                user-select: none;
            }
            .ms-caption-overlay.ms-caption-snapchat.ms-caption-bottom,
            .ms-caption-overlay.ms-caption-snapchat.ms-caption-top {
                top: 0;
                bottom: auto;
                padding: 10px 14px;
                background: rgba(0, 0, 0, 0.7);
            }
            .ms-caption-mode {
                display: flex;
                gap: 3px;
                width: 100%;
                padding: 3px;
                border: 1px solid var(--ms-line);
                border-radius: 9px;
                background: var(--ms-surface-1);
                box-sizing: border-box;
            }
            .ms-caption-footer .ms-caption-mode {
                width: auto;
                flex: 0 0 auto;
            }
            .ms-caption-footer .ms-caption-mode button {
                flex: 0 0 auto;
                padding: 0 10px;
            }
            .ms-caption-mode button {
                flex: 1 1 0;
                min-width: 0;
                height: 30px;
                padding: 0 7px;
                border: 0;
                background: transparent;
                color: var(--ms-text-3);
                border-radius: 6px;
                font-size: 11px;
                font-weight: 650;
                cursor: pointer;
                transition: color 150ms var(--ms-ease), background-color 150ms var(--ms-ease), transform 120ms var(--ms-ease);
            }
            .ms-caption-mode button:hover {
                color: var(--ms-text);
                background: var(--ms-hover);
            }
            .ms-caption-mode button:active {
                transform: scale(0.97);
            }
            .ms-caption-mode button.active {
                color: var(--ms-text);
                background: var(--ms-accent-tint);
                box-shadow: inset 0 0 0 1px var(--ms-accent-line);
            }
            .ms-media-wrap iframe.ms-media {
                z-index: 1;
            }
            .ms-media-wrap .ms-media.ms-ready {
                opacity: 1;
                transform: none;
                filter: none;
            }
            .ms-gallery-overlay:not(.ms-fit-vertical) .ms-media-wrap > img,
            .ms-gallery-overlay:not(.ms-fit-vertical) .ms-media-wrap > video {
                width: auto;
                height: auto;
                max-width: 100%;
                max-height: 100%;
            }
            .ms-gallery-overlay:not(.ms-fit-vertical) .ms-media-wrap iframe,
            .ms-fit-vertical .ms-media-wrap iframe,
            .ms-media-wrap iframe.ms-media {
                width: 100% !important;
                height: 100% !important;
                min-width: 100% !important;
                min-height: 100% !important;
                max-width: 100% !important;
                max-height: 100% !important;
                object-fit: fill;
            }
            .ms-fit-vertical .ms-media-wrap > img,
            .ms-fit-vertical .ms-media-wrap > video {
                max-width: 100%;
                max-height: 100%;
                object-fit: fill;
            }

            .ms-nav {
                position: absolute;
                top: calc(var(--ms-topbar-h) + (100% - var(--ms-topbar-h) - var(--ms-thumbs-h)) / 4);
                bottom: auto;
                height: calc((100% - var(--ms-topbar-h) - var(--ms-thumbs-h)) / 2);
                width: clamp(76px, 10vw, 128px);
                border: 0;
                border-radius: 0;
                background: transparent;
                color: var(--ms-text);
                cursor: pointer;
                z-index: 10;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0;
            }
            .ms-nav svg {
                width: 38px;
                height: 38px;
                padding: 9px;
                box-sizing: border-box;
                border-radius: 50%;
                background: rgba(32, 33, 36, 0.94);
                border: 1px solid var(--ms-hairline);
                color: var(--ms-text-2);
                stroke: currentColor;
                fill: none;
                stroke-width: 2;
                stroke-linecap: round;
                stroke-linejoin: round;
                opacity: 0;
                box-shadow: var(--ms-shadow-sm);
                transition: opacity 160ms var(--ms-ease-out), transform 160ms var(--ms-ease-out), background-color 140ms var(--ms-ease), color 140ms var(--ms-ease);
                pointer-events: none;
            }
            .ms-nav.prev svg { transform: translateX(-6px); }
            .ms-nav.next svg { transform: translateX(6px); }
            .ms-nav:hover svg,
            .ms-nav:focus-visible svg {
                opacity: 1;
                transform: translateX(0);
                background: rgba(255, 255, 255, 0.12);
                color: var(--ms-text);
            }
            .ms-nav.prev {
                left: 0;
            }
            .ms-nav.next {
                right: 0;
            }
            .ms-nav:disabled {
                display: none;
            }

            @media (hover: none), (pointer: coarse) {
                .ms-nav { width: 68px; }
                .ms-nav svg { opacity: 0.78; transform: none; }
            }

            .ms-iframe-shield {
                position: absolute;
                inset: 0;
                z-index: 5;
                background: transparent;
                cursor: pointer;
            }

            .ms-thumbs-wrap {
                position: absolute;
                left: 0;
                right: 0;
                bottom: 0;
                height: 90px;
                background: hsla(220, 7%, 9%, 0.92);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border-top: 1px solid var(--ms-line);
                overflow: hidden;
                z-index: 3;
                display: block;
                pointer-events: auto;
                touch-action: pan-x;
            }
            /* Optional vote/info row between the media and the thumbnail strip.
               Shown and hidden by the same toggle as the description panel.
               The title card is centred and resizable. */
            .ms-reddit-info-row {
                position: absolute;
                left: 0;
                right: 0;
                bottom: var(--ms-thumbs-h);
                height: var(--ms-reddit-row-h, 92px);
                display: none;
                align-items: center;
                justify-content: center;
                padding: 12px 18px;
                z-index: 3;
                box-sizing: border-box;
                pointer-events: none;
            }
            .ms-gallery-overlay.ms-reddit-row-open:not(.ms-grid-mode):not(.ms-stage-fullscreen) .ms-reddit-info-row {
                display: flex;
            }
            .ms-gallery-overlay.ms-reddit-row-open:not(.ms-grid-mode):not(.ms-stage-fullscreen) .ms-gallery-stage {
                padding-bottom: calc(var(--ms-thumbs-h) + var(--ms-reddit-row-h, 92px) + 14px);
            }
            .ms-reddit-card {
                position: relative;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100%;
                width: min(760px, calc(100vw - 460px));
                padding: 12px 20px;
                background: var(--ms-surface-2);
                border: 1px solid var(--ms-line);
                border-radius: 12px;
                box-shadow: var(--ms-shadow-lg);
                pointer-events: auto;
                box-sizing: border-box;
            }
            /* Same affordance as the tags panel resizer: a wide invisible hit area
               with a small visible grip that lights up on hover. */
            .ms-reddit-resizer {
                position: absolute;
                left: 0;
                right: 0;
                top: -5px;
                height: 12px;
                cursor: ns-resize;
                z-index: 2;
            }
            .ms-reddit-resizer::after {
                content: "";
                position: absolute;
                left: 50%;
                top: 4px;
                transform: translateX(-50%);
                width: 46px;
                height: 3px;
                border-radius: 3px;
                background: var(--ms-line-strong);
                transition: background 150ms var(--ms-ease);
            }
            .ms-reddit-resizer:hover::after { background: var(--ms-accent); }
            .ms-gallery-overlay.ms-reddit-resizing .ms-reddit-card,
            .ms-gallery-overlay.ms-reddit-resizing .ms-gallery-stage,
            .ms-gallery-overlay.ms-reddit-resizing .ms-media-wrap {
                transition: none !important;
            }
            .ms-reddit-postinfo {
                width: 100%;
                min-width: 0;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 4px;
                text-align: center;
                overflow: hidden;
            }
            .ms-reddit-title {
                color: var(--ms-text);
                font-size: var(--ms-reddit-title-fs, 17px);
                font-weight: 600;
                line-height: 1.4;
                text-decoration: none;
                max-width: 100%;
                display: -webkit-box;
                /* Grows with the card as it is dragged taller. */
                -webkit-line-clamp: var(--ms-reddit-lines, 2);
                -webkit-box-orient: vertical;
                overflow: hidden;
            }
            .ms-reddit-title:hover {
                text-decoration: none;
                color: #ff4500;
                background: var(--ms-hover);
            }
            /* Same treatment the topbar gives its labels, so the two read as one UI. */
            .ms-reddit-meta {
                color: var(--ms-text-3);
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                max-width: 100%;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                flex: 0 0 auto;
            }
            .ms-reddit-meta a {
                color: var(--ms-text-3);
                text-decoration: none;
                transition: color 150ms var(--ms-ease);
            }
            .ms-reddit-meta a:hover {
                color: #ff4500;
                text-decoration: underline;
            }
            /* Anchored to the right edge, not to the card, so the controls stay
               put whatever the title does. */
            .ms-reddit-actions {
                position: absolute;
                right: 18px;
                top: 50%;
                transform: translateY(-50%);
                display: flex;
                align-items: center;
                gap: 10px;
                pointer-events: auto;
            }
            /* Up, score and down are one connected control with fully rounded
               ends. Save is the same shape on its own. */
            .ms-reddit-votes {
                box-sizing: border-box;
                height: 38px;
                padding: 3px;
                gap: 2px;
                display: inline-flex;
                align-items: center;
                background: var(--ms-surface-2);
                border: 1px solid var(--ms-line);
                border-radius: 999px;
                box-shadow: var(--ms-shadow-lg);
            }
            .ms-reddit-vote {
                width: 32px;
                height: 32px;
                padding: 0;
                border: none;
                border-radius: 50%;
                background: transparent;
                color: var(--ms-text-3);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: color 150ms var(--ms-ease), background-color 150ms var(--ms-ease), transform 150ms var(--ms-ease);
            }
            .ms-reddit-save {
                box-sizing: border-box;
                height: 38px;
                padding: 0 18px;
                gap: 7px;
                background: var(--ms-surface-2);
                border: 1px solid var(--ms-line);
                border-radius: 999px;
                box-shadow: var(--ms-shadow-lg);
                color: var(--ms-text-3);
                font-size: 12px;
                font-weight: 600;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: color 150ms var(--ms-ease), background-color 150ms var(--ms-ease), border-color 150ms var(--ms-ease), transform 150ms var(--ms-ease);
            }
            .ms-reddit-vote svg,
            .ms-reddit-save svg {
                width: 16px;
                height: 16px;
                display: block;
                pointer-events: none;
            }
            .ms-reddit-vote:hover,
            .ms-reddit-save:hover {
                background: var(--ms-hover);
                color: var(--ms-text);
            }
            .ms-reddit-save:hover { border-color: var(--ms-line); }
            .ms-reddit-vote:active,
            .ms-reddit-save:active { transform: scale(0.92); }
            .ms-reddit-vote.upvoted {
                color: #ff4500;
                background: rgba(255, 69, 0, 0.12);
            }
            .ms-reddit-vote.downvoted {
                color: #7193ff;
                background: rgba(113, 147, 255, 0.12);
            }
            .ms-reddit-save.saved {
                color: #ffb000;
                border-color: rgba(255, 176, 0, 0.55);
                background: rgba(255, 176, 0, 0.12);
            }
            /* The seam between the two halves of the connected vote control. */
            .ms-reddit-score {
                align-self: stretch;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 12px;
                font-weight: 700;
                color: var(--ms-text-2);
                padding: 0 6px;
                min-width: 28px;
                box-sizing: border-box;
                user-select: none;
                font-variant-numeric: tabular-nums;
            }
            /* Not enough width for a card plus controls side by side: let the card
               use the full width and drop the controls below it. */
            @media (max-width: 900px) {
                .ms-reddit-info-row {
                    flex-direction: column;
                    gap: 8px;
                    height: auto;
                    justify-content: center;
                }
                .ms-reddit-card { width: calc(100vw - 36px); }
                .ms-reddit-actions {
                    position: static;
                    transform: none;
                }
            }
            .ms-thumbs-track {
                height: 100%;
                overflow-x: auto;
                overflow-y: hidden;
                white-space: nowrap;
                scroll-behavior: auto;
                /* Appending thumbs mid-session otherwise lets the browser's scroll
                   anchoring nudge the strip to compensate, which reads as jitter. */
                overflow-anchor: none;
                cursor: grab;
                user-select: none;
                touch-action: pan-x;
                padding: 10px 8px;
                box-sizing: border-box;
                scrollbar-width: none;
            }
            .ms-thumbs-track::-webkit-scrollbar {
                display: none;
            }
            .ms-thumbs-track:active { cursor: grabbing; }
            .ms-thumbs-track.ms-thumbs-windowed { position: relative; }
            .ms-thumbs-sizer { display: block; height: 1px; pointer-events: none; }
            .ms-load-mark-layer {
                position: absolute;
                left: 0;
                top: 0;
                height: 100%;
                pointer-events: none;
                z-index: 6;
            }
            .ms-load-mark {
                position: absolute;
                top: 10px;
                width: 14px;
                height: 70px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: var(--ms-accent);
            }
            .ms-load-mark::before {
                content: "";
                position: absolute;
                left: 50%;
                top: 8px;
                bottom: 8px;
                width: 1px;
                background: var(--ms-accent);
                opacity: 0.7;
            }
            .ms-load-mark svg {
                width: 11px;
                height: 11px;
                stroke: currentColor;
                fill: none;
                stroke-width: 2.6;
                stroke-linecap: round;
                stroke-linejoin: round;
                position: relative;
                z-index: 1;
            }
            .ms-thumb-group-layer {
                position: absolute;
                left: 0;
                top: 0;
                height: 100%;
                pointer-events: none;
                z-index: 2;
            }
            .ms-thumb-group-box {
                position: absolute;
                top: 6px;
                height: 78px;
                border: 2px solid;
                border-radius: 10px;
                box-sizing: border-box;
                background: rgba(255, 255, 255, 0.03);
            }
            /* One level up: a block of several posts (item.superGroupId). Thin,
               dashed and translucent so the solid post outline stays dominant;
               1px outside it on the sides, 3px above and below inside the 90px
               strip (thumbs 10..80, post box 6..84, this box 3..87). */
            .ms-thumb-supergroup-box {
                position: absolute;
                top: 3px;
                height: 84px;
                border: 1px dashed;
                border-radius: 12px;
                box-sizing: border-box;
                background: none;
            }
            .ms-thumb.ms-thumb-abs {
                position: absolute;
                top: 10px;
                margin-right: 0 !important;
                z-index: 1;
            }
            .ms-gallery-overlay .ms-btn-expand-album {
                position: absolute;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 12;
                display: inline-flex !important;
                align-items: center;
                gap: 8px;
                height: 46px;
                min-width: 180px;
                max-width: calc(100% - 24px);
                padding: 0 22px;
                border-radius: 10px;
                background: hsla(220, 14%, 12%, 0.96);
                border: 1px solid var(--ms-accent-line);
                color: var(--ms-text);
                font-size: 14px;
                font-weight: 600;
                letter-spacing: 0.2px;
                text-transform: none;
                box-shadow: var(--ms-shadow-md);
                cursor: pointer;
                backdrop-filter: blur(12px);
            }
            .ms-btn-expand-album:hover {
                background: var(--ms-surface-3);
                border-color: var(--ms-line-strong);
                color: var(--ms-text);
            }
            .ms-btn-expand-album:disabled {
                opacity: 0.65;
                cursor: progress;
            }
            .ms-btn-expand-album svg {
                width: 16px;
                height: 16px;
                stroke: currentColor;
                fill: none;
                flex-shrink: 0;
            }

            .ms-thumb {
                --ms-thumb-rest-opacity: 0.7;
                padding: 0 !important;
                position: relative;
                display: inline-block;
                width: 70px;
                height: 70px;
                box-sizing: border-box;
                margin-right: 6px;
                border: 2px solid var(--ms-line) !important;
                border-radius: 6px;
                overflow: hidden;
                opacity: var(--ms-thumb-rest-opacity);
                cursor: pointer;
                vertical-align: top;
                background: var(--ms-surface-1);
                transition: opacity 150ms var(--ms-ease), border-color 150ms var(--ms-ease);
            }
            .ms-thumb-video-icon {
                position: absolute;
                top: 4px;
                right: 4px;
                width: 14px;
                height: 14px;
                background: rgba(0, 0, 0, 0.7);
                border-radius: 3px;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 5;
                pointer-events: none;
            }
            .ms-thumb-video-icon svg {
                width: 10px;
                height: 10px;
                fill: #fff;
            }
            .ms-thumb-gif-icon {
                position: absolute;
                top: 4px;
                right: 4px;
                background: rgba(0, 0, 0, 0.7);
                border: 1px solid var(--ms-line);
                color: var(--ms-text);
                font-family: system-ui, -apple-system, Segoe UI, sans-serif !important;
                font-size: 8px;
                font-weight: 900;
                padding: 1px 3px;
                border-radius: 2px;
                line-height: 1;
                z-index: 5;
                pointer-events: none;
            }
            .ms-thumb:hover {
                --ms-thumb-rest-opacity: 1;
                opacity: var(--ms-thumb-rest-opacity);
                border-color: var(--ms-line-strong) !important;
            }
            .ms-thumb.active {
                --ms-thumb-rest-opacity: 1;
                opacity: var(--ms-thumb-rest-opacity);
                border-color: var(--ms-accent) !important;
            }
            .ms-thumb.ms-thumb-entering {
                animation: ms-thumb-enter 180ms cubic-bezier(0.23, 1, 0.32, 1) both;
            }
            @keyframes ms-thumb-enter {
                from { opacity: 0; transform: translateY(4px); }
                to { opacity: var(--ms-thumb-rest-opacity); transform: translateY(0); }
            }
            .ms-thumb > img,
            .ms-thumb > video {
                width: 100% !important;
                height: 100% !important;
                min-width: 100% !important;
                min-height: 100% !important;
                max-width: none !important;
                max-height: none !important;
                object-fit: cover !important;
                margin: 0 !important;
                background: var(--ms-bg);
                display: block;
                pointer-events: none;
                opacity: 1;
                transition: opacity 150ms cubic-bezier(0.23, 1, 0.32, 1);
            }
            .ms-thumb img.ms-loaded,
            .ms-thumb img[src^="data:"],
            .ms-thumb img[src^="blob:"] {
                opacity: 1;
            }
            .ms-thumb > img:not(.ms-loaded),
            .ms-grid-cell > img:not(.ms-loaded) {
                opacity: 0;
            }
            .ms-thumb > .ms-thumb-handoff-old,
            .ms-thumb > .ms-thumb-handoff-in {
                position: absolute;
                inset: 0;
            }
            .ms-thumb > .ms-thumb-handoff-old {
                z-index: 1;
                opacity: 1;
                margin: auto;
            }
            .ms-thumb > img.ms-thumb-handoff-in,
            .ms-thumb > video.ms-thumb-handoff-in {
                z-index: 2;
                opacity: 0;
                transition: opacity 150ms cubic-bezier(0.23, 1, 0.32, 1);
            }
            .ms-thumb > img.ms-thumb-handoff-in.ms-thumb-handoff-ready,
            .ms-thumb > video.ms-thumb-handoff-in.ms-thumb-handoff-ready {
                opacity: 1;
            }
            .ms-thumb > .ms-thumb-handoff-old.ms-thumb-handoff-leaving {
                opacity: 0;
                transition: opacity 150ms cubic-bezier(0.23, 1, 0.32, 1);
            }
            .ms-thumb:has(> img:not(.ms-loaded))::before,
            .ms-grid-cell:has(> img:not(.ms-loaded))::before {
                content: '';
                position: absolute;
                left: 50%;
                top: 50%;
                width: 14px;
                height: 14px;
                margin: -8px 0 0 -8px;
                border: 2px solid rgba(255, 255, 255, 0.2);
                border-top-color: rgba(255, 255, 255, 0.75);
                border-radius: 50%;
                animation: ms-spin 0.8s linear infinite;
                z-index: 2;
            }
            .ms-thumb:has(> .ms-thumb-handoff-old)::before {
                display: none;
            }
            .ms-thumb-group {
                display: inline-flex;
                flex-direction: row;
                align-items: center;
                gap: 4px;
                border: 2px solid var(--ms-line-soft);
                border-radius: 8px;
                padding: 4px;
                margin-right: 6px;
                background: rgba(255, 255, 255, 0.02);
                box-sizing: border-box;
                vertical-align: top;
                height: 70px;
            }
            .ms-thumb-group .ms-thumb,
            .ms-thumb-group .ms-placeholder,
            .ms-thumb-group .ms-thumb.ms-placeholder {
                width: 60px !important;
                height: 60px !important;
                margin-right: 0 !important;
                border: 2px solid transparent !important;
            }
            .ms-thumb-group .ms-thumb.active,
            .ms-thumb-group .ms-thumb.ms-placeholder.active {
                border-color: var(--ms-accent) !important;
            }
            .ms-thumb.ms-uncached, .ms-grid-cell.ms-uncached {
                filter: grayscale(1) opacity(0.5);
                transition: filter 0.3s ease, opacity 0.3s ease;
            }
            .ms-thumb.ms-placeholder {
                display: inline-flex !important;
                align-items: center;
                justify-content: center;
                flex-direction: column;
                background: var(--ms-surface-2);
                width: 70px !important;
                height: 70px !important;
                margin-right: 6px;
                border: 2px solid var(--ms-line) !important;
                border-radius: 6px;
                overflow: hidden;
                padding: 0;
                vertical-align: top;
            }
            .ms-thumb.ms-placeholder.active {
                border-color: var(--ms-accent) !important;
            }
            .ms-thumb.ms-placeholder > svg {
                width: 24px;
                height: 24px;
                margin-bottom: 2px;
                opacity: 0.7;
                flex-shrink: 0;
            }
            .ms-thumb.ms-placeholder .ms-domain {
                font-size: 6px;
                color: var(--ms-text-4);
                text-align: center;
                word-break: break-word;
                padding: 0 2px;
                font-family: monospace;
                width: 100%;
                line-height: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                flex-shrink: 0;
            }

            .ms-xcom-gallery-btn {
                position: fixed;
                top: 70px;
                right: 20px;
                z-index: 9999;
                padding: 10px 20px;
                background: var(--ms-surface-1);
                color: var(--ms-text);
                border: 1px solid var(--ms-line);
                border-radius: 20px;
                cursor: pointer;
                font-weight: 700;
                box-shadow: var(--ms-shadow-md);
                font-family: system-ui, -apple-system, Segoe UI, sans-serif !important;
                font-size: 13px;
                letter-spacing: 0.5px;
                transition: all 120ms ease;
            }
            .ms-xcom-gallery-btn:hover {
                background: var(--ms-surface-3);
                border-color: var(--ms-line-strong);
                box-shadow: var(--ms-shadow-md);
            }
            .ms-site-gallery-btn {
                position: fixed;
                top: 70px;
                right: 20px;
                z-index: 9999;
                height: 38px;
                box-sizing: border-box;
                padding: 0 18px;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                line-height: 1 !important;
                text-align: center !important;
                background: var(--ms-surface-1);
                color: var(--ms-text);
                border: 1px solid var(--ms-line);
                border-radius: 20px;
                cursor: pointer;
                font-weight: 700;
                box-shadow: var(--ms-shadow-md);
                font-family: system-ui, -apple-system, Segoe UI, sans-serif !important;
                font-size: 13px;
                letter-spacing: 0.5px;
                transition: all 120ms ease;
            }
            .ms-site-gallery-btn:hover {
                background: var(--ms-surface-3);
                border-color: var(--ms-line-strong);
                box-shadow: var(--ms-shadow-md);
            }
            .ms-site-settings-btn {
                position: fixed;
                top: 70px;
                right: 118px;
                z-index: 9999;
                width: 38px;
                height: 38px;
                box-sizing: border-box;
                padding: 0;
                background: var(--ms-surface-1);
                color: var(--ms-text);
                border: 1px solid var(--ms-line);
                border-radius: 50%;
                cursor: pointer;
                font-size: 18px;
                line-height: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: var(--ms-shadow-md);
                transition: all 120ms ease;
            }
            .ms-site-settings-btn svg {
                display: block;
                transition: transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
            }
            .ms-site-settings-btn svg path,
            .ms-site-settings-btn svg circle {
                fill: none !important;
                stroke: currentColor !important;
            }
            .ms-site-settings-btn:hover {
                background: var(--ms-surface-3);
                border-color: var(--ms-line-strong);
                box-shadow: var(--ms-shadow-md);
            }
            .ms-site-settings-btn:hover svg {
                transform: rotate(45deg);
            }
            /* Optional host-page companion button next to Gallery. */
            #ms-site-redirect-btn {
                position: fixed;
                top: 70px;
                right: 166px;
                z-index: 9999;
                height: 38px;
                box-sizing: border-box;
                padding: 0 14px;
                background: var(--ms-surface-1);
                color: var(--ms-text);
                border: 1px solid var(--ms-line);
                border-radius: 20px;
                cursor: pointer;
                /* Host stylesheets can override UA button fonts; keep this chrome aligned. */
                font-family: system-ui, -apple-system, Segoe UI, sans-serif !important;
                font-size: 13px;
                font-weight: 700;
                letter-spacing: 0.5px;
                line-height: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: var(--ms-shadow-md);
                transition: all 120ms ease;
            }
            #ms-site-redirect-btn:hover {
                background: var(--ms-surface-3);
                border-color: var(--ms-line-strong);
            }
            /* Hide the host page while the overlay is open. Adapters may use a
               lighter variant that still allows layout. */
            body.ms-host-isolation > :not(.ms-gallery-overlay):not(.ms-gallery-root):not(#ms-settings-root):not(#ms-site-cluster):not([data-ms-fly-ghost]),
            body.ms-reddit-isolation > :not(.ms-gallery-overlay):not(.ms-gallery-root):not(#ms-settings-root):not(#ms-site-cluster):not([data-ms-fly-ghost]) {
                visibility: hidden !important;
                pointer-events: none !important;
                contain: layout paint style;
                content-visibility: hidden;
            }
            body.ms-host-isolation-layout > :not(.ms-gallery-overlay):not(.ms-gallery-root):not(#ms-settings-root):not(#ms-site-cluster):not([data-ms-fly-ghost]),
            body.ms-bdsmlr-isolation > :not(.ms-gallery-overlay):not(.ms-gallery-root):not(#ms-settings-root):not(#ms-site-cluster):not([data-ms-fly-ghost]) {
                visibility: hidden !important;
                pointer-events: none !important;
            }
            /* Highlight the restored host post after close. */
            .ms-post-highlight {
                outline: 3px solid rgba(255, 69, 0, 0.9) !important;
                outline-offset: 2px;
                animation: ms-post-highlight-fade 2.5s ease forwards;
            }
            @keyframes ms-post-highlight-fade {
                0% { outline-color: rgba(255, 69, 0, 0.9); }
                70% { outline-color: rgba(255, 69, 0, 0.9); }
                100% { outline-color: rgba(255, 69, 0, 0); }
            }
            .ms-r34-settings-overlay {
                font: 14px/1.5 var(--ms-font-ui);
                color-scheme: dark;
                position: fixed;
                inset: 0;
                z-index: 100000;
                background: rgba(6, 8, 12, 0.62);
                display: flex;
                align-items: center;
                justify-content: center;
                backdrop-filter: blur(8px);
                opacity: 0;
                transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1);
            }
            .ms-r34-settings-overlay.ms-settings-open {
                opacity: 1;
            }
            .ms-r34-settings-modal {
                background: var(--ms-surface-1);
                border: 1px solid var(--ms-hairline);
                border-radius: 12px;
                padding: 0;
                width: 560px;
                max-width: calc(100vw - 32px);
                max-height: min(85vh, 720px);
                overflow: hidden;
                display: flex;
                flex-direction: column;
                color: var(--ms-text-2);
                font-family: var(--ms-font-ui) !important;
                box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.04), var(--ms-shadow-lg);
                transform: translateY(12px) scale(0.96);
                opacity: 0;
                transform-origin: 50% 42%;
                transition: transform 220ms cubic-bezier(0.23, 1, 0.32, 1), opacity 200ms cubic-bezier(0.23, 1, 0.32, 1);
            }
            .ms-r34-settings-overlay.ms-settings-open .ms-r34-settings-modal {
                transform: translateY(0) scale(1);
                opacity: 1;
            }
            .ms-settings-head {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 16px 16px 14px 18px;
                border-bottom: 1px solid var(--ms-hairline);
                flex-shrink: 0;
            }
            .ms-r34-settings-modal h3 {
                display: flex;
                align-items: center;
                gap: 8px;
                margin: 0;
                flex: 1;
                min-width: 0;
                font-size: 15px;
                font-weight: 600;
                color: var(--ms-text);
                letter-spacing: -0.01em;
                text-wrap: balance;
            }
            .ms-r34-settings-modal h3 svg {
                width: 16px;
                height: 16px;
                margin: 0;
                flex-shrink: 0;
                color: var(--ms-text-3);
            }
            .ms-settings-close {
                width: 32px;
                height: 32px;
                padding: 0;
                border-radius: 8px;
                border: 1px solid transparent;
                background: transparent;
                color: var(--ms-text-3);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                flex-shrink: 0;
            }
            .ms-settings-close:hover {
                background: var(--ms-hover);
                color: var(--ms-text);
            }
            .ms-settings-close svg {
                width: 14px;
                height: 14px;
            }
            .ms-settings-body {
                padding: 0 16px 8px;
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color: var(--ms-line-strong) transparent;
            }
            .ms-r34-settings-overlay *, .ms-r34-settings-overlay *::before, .ms-r34-settings-overlay *::after { box-sizing: border-box; }
            .ms-r34-settings-overlay button, .ms-r34-settings-overlay input, .ms-r34-settings-overlay select, .ms-r34-settings-overlay textarea { font: inherit; }
            .ms-settings-section-group { margin: 12px 0 8px; color: var(--ms-text-3); font: 600 11px/1.5 var(--ms-font-ui); text-transform: uppercase; letter-spacing: .06em; }
            .ms-settings-label { flex: 1; min-width: 0; font-size: 13px; }
            .ms-settings-label small { color: var(--ms-text-3); font-size: 11px; }
            .ms-settings-row > input, .ms-settings-row > select { max-width: 180px; min-width: 0; }
            .ms-settings-row > button, .ms-settings-row > select { border: 1px solid var(--ms-line); background: var(--ms-surface-3); color: var(--ms-text); border-radius: 7px; padding: 7px 10px; font-size: 12px; }
            .ms-r34-settings-overlay :focus-visible { outline: 2px solid var(--ms-accent); outline-offset: 3px; }
            .ms-tags-action-icon { display: inline-flex; }
            @media (prefers-reduced-motion: reduce) {
                .ms-r34-settings-overlay,
                .ms-r34-settings-modal {
                    transition: none;
                }
                .ms-r34-settings-modal {
                    transform: none;
                }
            }
            .ms-r34-settings-modal label.ms-field-label {
                display: block;
                font-size: 11px;
                color: var(--ms-text-4);
                margin: 14px 0 6px;
                letter-spacing: 0.5px;
                text-transform: uppercase;
            }
            .ms-r34-settings-modal input[type="text"],
            .ms-r34-settings-modal input[type="number"] {
                width: 100%;
                padding: 8px 10px;
                background: var(--ms-surface-3);
                border: 1px solid var(--ms-line);
                border-radius: 6px;
                color: var(--ms-text-2);
                font-family: inherit;
                font-size: 13px;
                box-sizing: border-box;
                outline: none;
                transition: border-color 150ms var(--ms-ease);
            }
            .ms-r34-settings-modal input#ms-r34-creds {
                font-family: "SF Mono", Consolas, monospace;
            }
            .ms-r34-settings-modal input:focus {
                border-color: var(--ms-accent);
            }
            .ms-r34-settings-modal .ms-r34-btn-row {
                display: flex;
                gap: 8px;
                margin: 0;
                padding: 12px 16px 14px;
                border-top: 1px solid var(--ms-hairline);
                justify-content: flex-end;
                flex-shrink: 0;
            }
            .ms-r34-settings-modal .ms-r34-btn-row button,
            .ms-r34-settings-modal .ms-cache-clear,
            .ms-r34-settings-modal .ms-r34-clear {
                padding: 8px 14px;
                border-radius: 8px;
                border: 1px solid var(--ms-line);
                background: var(--ms-surface-3);
                color: var(--ms-text-2);
                cursor: pointer;
                font-family: inherit;
                font-size: 13px;
                font-weight: 600;
                transition: background 140ms var(--ms-ease), border-color 140ms var(--ms-ease), color 140ms var(--ms-ease), transform 140ms var(--ms-ease);
            }
            .ms-r34-settings-modal .ms-r34-btn-row button:hover,
            .ms-r34-settings-modal .ms-cache-clear:hover,
            .ms-r34-settings-modal .ms-r34-clear:hover {
                background: var(--ms-hover);
                border-color: var(--ms-line-strong);
                color: var(--ms-text);
            }
            .ms-r34-settings-modal .ms-r34-btn-row button:active,
            .ms-r34-settings-modal .ms-cache-clear:active,
            .ms-r34-settings-modal .ms-r34-clear:active {
                transform: scale(0.97);
            }
            .ms-r34-settings-modal button.ms-r34-save {
                background: var(--ms-accent);
                border-color: var(--ms-accent);
                color: var(--ms-on-accent);
            }
            .ms-r34-settings-modal button.ms-r34-save:hover {
                background: var(--ms-accent-hover);
                border-color: var(--ms-accent-hover);
                color: var(--ms-on-accent);
            }
            .ms-r34-settings-modal .ms-r34-status {
                font-size: 11px;
                margin-top: 8px;
                color: var(--ms-text-4);
            }
            .ms-r34-settings-modal .ms-r34-status.active {
                color: var(--ms-accent);
            }

            /* Dropdown menus */
            .ms-dropdown {
                position: relative;
                display: inline-block;
            }
            .ms-dropdown-menu {
                position: absolute;
                top: 100%;
                left: 50%;
                transform: translateX(-50%);
                background: hsla(220, 7%, 9%, 0.92);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border: 1px solid var(--ms-line);
                border-radius: 12px;
                padding: 6px 0;
                margin-top: 8px;
                display: none;
                flex-direction: column;
                min-width: 110px;
                box-shadow: var(--ms-shadow-md);
                z-index: 1000;
            }
            .ms-dropdown-menu::before {
                content: '';
                position: absolute;
                top: -12px;
                left: 0;
                right: 0;
                height: 12px;
                background: transparent;
            }
            .ms-dropdown:hover .ms-dropdown-menu {
                display: flex;
            }
            .ms-dropdown-item {
                border: none;
                background: transparent;
                color: var(--ms-text-3);
                padding: 8px 14px;
                cursor: pointer;
                font-size: 11px;
                text-align: left;
                white-space: nowrap;
                text-transform: uppercase;
                font-weight: 500;
                width: 100%;
                box-sizing: border-box;
                transition: background-color 150ms var(--ms-ease), color 150ms var(--ms-ease);
            }
            .ms-dropdown-item:hover {
                background: var(--ms-hover);
                color: var(--ms-text);
            }
            .ms-dropdown-item.active {
                color: var(--ms-accent);
                font-weight: 700;
                background: var(--ms-accent-tint);
            }

            .ms-gallery-end-toast {
                position: fixed;
                left: 50%;
                bottom: calc(var(--ms-thumbs-h) + 20px);
                transform: translate(-50%, 8px);
                padding: 9px 14px;
                border: 1px solid var(--ms-line);
                border-radius: 999px;
                background: var(--ms-surface-2);
                color: var(--ms-text);
                font-size: 12px;
                font-weight: 600;
                opacity: 0;
                pointer-events: none;
                z-index: 40;
                transition: opacity 0.16s ease, transform 0.16s ease;
            }
            .ms-gallery-end-toast.active {
                opacity: 0.75;
                transform: translate(-50%, 0);
            }
            .ms-imgfap-fav-menu {
                position: fixed;
                width: min(330px, calc(100vw - 24px));
                padding: 14px;
                border: 1px solid var(--ms-line);
                border-radius: 14px;
                background: var(--ms-surface-2);
                color: var(--ms-text);
                box-shadow: 0 14px 38px rgba(0,0,0,0.65);
                z-index: 45;
                box-sizing: border-box;
            }
            .ms-imgfap-fav-title { margin-bottom: 10px; font-size: 13px; font-weight: 700; }
            .ms-imgfap-fav-section + .ms-imgfap-fav-section { margin-top: 11px; padding-top: 11px; border-top: 1px solid var(--ms-line-soft); }
            .ms-imgfap-fav-label { display: block; margin-bottom: 6px; color: #bbb; font-size: 11px; font-weight: 600; }
            .ms-imgfap-fav-controls { display: flex; gap: 7px; }
            .ms-imgfap-fav-controls select {
                min-width: 0;
                flex: 1 1 auto;
                height: 32px;
                padding: 0 28px 0 9px;
                border: 1px solid var(--ms-line);
                border-radius: 8px;
                background: var(--ms-surface-1);
                color: var(--ms-text);
                font: inherit;
            }
            .ms-imgfap-fav-controls button {
                flex: 0 0 auto;
                min-width: 54px;
                height: 32px;
                padding: 0 10px;
                border: 1px solid var(--ms-line);
                border-radius: 8px;
                background: #252525;
                color: var(--ms-text);
                font: inherit;
                cursor: pointer;
            }
            .ms-imgfap-fav-controls button:hover { background: #303030; }
            .ms-imgfap-fav-controls button:disabled { opacity: 0.5; cursor: default; }
            .ms-imgfap-fav-status { min-height: 16px; margin-top: 9px; color: var(--ms-text-3); font-size: 11px; }
            .ms-imgfap-fav-status.success { color: #63d471; }
            .ms-imgfap-fav-status.error { color: #ff7b7b; }

            /* Resolving loader */
            .ms-resolve-loading {
                position: absolute;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(18, 18, 18, 0.85);
                border: 1px solid var(--ms-line);
                border-radius: 20px;
                padding: 8px 16px;
                display: flex;
                align-items: center;
                gap: 10px;
                z-index: 10;
                pointer-events: none;
                box-shadow: var(--ms-shadow-sm);
            }
            .ms-resolve-spinner {
                width: 14px;
                height: 14px;
                border: 2px solid var(--ms-line-strong);
                border-top-color: var(--ms-text);
                border-radius: 50%;
                animation: ms-spin 0.8s linear infinite;
            }
            .ms-resolve-text {
                font-size: 11px;
                color: var(--ms-text-3);
                font-weight: 500;
                letter-spacing: 0.3px;
            }
            @keyframes ms-spin {
                to { transform: rotate(360deg); }
            }
            .ms-index-input {
                display: inline-flex !important;
                align-items: center !important;
                width: 1ch !important;
                min-width: 0 !important;
                height: 1em !important;
                background: transparent !important;
                border: none !important;
                border: 0 !important;
                color: inherit !important;
                font-family: inherit !important;
                font-weight: 600 !important;
                font-size: 12px !important;
                line-height: 1 !important;
                text-align: center !important;
                padding: 0 !important;
                margin: 0 !important;
                outline: none !important;
                box-sizing: content-box !important;
                vertical-align: middle !important;
                position: relative !important;
                top: 0 !important;
                cursor: text !important;
                -webkit-appearance: none !important;
                appearance: none !important;
                -moz-appearance: textfield !important;
            }
            .ms-index-input::-webkit-outer-spin-button,
            .ms-index-input::-webkit-inner-spin-button {
                -webkit-appearance: none;
                margin: 0;
            }
            .ms-index-input:focus {
                color: var(--ms-text);
            }
            .ms-position-control {
                display: inline-flex;
                height: 32px;
                min-width: 0;
                padding: 0 7px;
                box-sizing: border-box;
                align-items: center;
                justify-content: center;
                gap: 2px;
                border: 1px solid var(--ms-hairline);
                border-radius: 8px;
                background: var(--ms-surface-2);
                color: var(--ms-text-3);
                font-size: 12px;
                font-variant-numeric: tabular-nums;
                flex-shrink: 0;
            }
            .ms-position-control > span {
                display: inline-flex;
                align-items: center;
                height: 1em;
                line-height: 1;
            }
            /* Counter plus Grid, merged at the seam: one outer border, one 1px
               division, square inner corners. The group owns the border so the
               two halves cannot drift apart, and Grid can never be separated
               from the counter by a button appearing or disappearing next to it. */
            .ms-position-group {
                display: inline-flex;
                align-items: stretch;
                flex-shrink: 0;
                height: 32px;
                box-sizing: border-box;
                border: 1px solid var(--ms-hairline);
                border-radius: 8px;
                background: var(--ms-surface-2);
                overflow: hidden;
            }
            .ms-position-group > .ms-position-control {
                height: 100%;
                border: 0;
                border-radius: 0;
                background: transparent;
                box-shadow: none;
            }
            /* The ring lives on the group: overflow: hidden would clip it if it
               were drawn on the input's own box. */
            .ms-position-group:focus-within {
                border-color: var(--ms-accent-line);
                box-shadow: 0 0 0 2px var(--ms-accent-tint);
            }
            .ms-gallery-overlay .ms-gallery-topbar .ms-position-group > .ms-btn {
                height: 100%;
                border: 0;
                border-inline-start: 1px solid var(--ms-hairline);
                border-radius: 0;
            }
            .ms-position-control:focus-within {
                border-color: var(--ms-accent-line);
                box-shadow: 0 0 0 2px var(--ms-accent-tint);
            }
            .ms-position-total { color: var(--ms-text-4); }

            .ms-x-action {
                color: var(--ms-text-3);
            }
            .ms-x-action svg {
                width: 17px;
                height: 17px;
                stroke: currentColor;
                fill: none;
                stroke-width: 2;
            }
            .ms-x-action.active[data-act="x-like"] { color: #f91880; }
            .ms-x-action.active[data-act="x-like"] svg,
            .ms-x-action.active[data-act="x-bookmark"] svg { fill: currentColor; }
            .ms-x-action.active[data-act="x-bookmark"] { color: var(--ms-accent); }
            .ms-x-action:disabled { opacity: 0.38; cursor: default; }
            .ms-gallery-info a {
                color: inherit;
                text-decoration: none;
            }
            .ms-gallery-info a:hover {
                text-decoration: none;
                color: var(--ms-accent);
            }

            .ms-thumb.ms-placeholder.ms-source-saint {
                background: rgba(255, 179, 102, 0.15) !important;
            }
            .ms-thumb.ms-placeholder.ms-source-redgifs {
                background: rgba(255, 137, 137, 0.15) !important;
            }
            .ms-thumb.ms-placeholder.ms-source-bunkr {
                background: rgba(204, 153, 255, 0.15) !important;
            }
            .ms-thumb.ms-placeholder.ms-source-pornpics {
                background: rgba(255, 128, 204, 0.15) !important;
            }
            .ms-thumb.ms-placeholder.ms-source-saint > svg {
                fill: #ffb366;
                opacity: 0.9;
            }
            .ms-thumb.ms-placeholder.ms-source-redgifs > svg {
                fill: #ff8989;
                opacity: 0.9;
            }
            .ms-thumb.ms-placeholder.ms-source-bunkr > svg {
                fill: #cc99ff;
                opacity: 0.9;
            }
            .ms-thumb.ms-placeholder.ms-source-pornpics > svg {
                fill: #ff80cc;
                opacity: 0.9;
            }
            .ms-thumb.ms-placeholder.ms-source-saint .ms-domain {
                color: #ffb366;
                opacity: 0.8;
            }
            .ms-thumb.ms-placeholder.ms-source-redgifs .ms-domain {
                color: #ff8989;
                opacity: 0.8;
            }
            .ms-thumb.ms-placeholder.ms-source-bunkr .ms-domain {
                color: #cc99ff;
                opacity: 0.8;
            }
            .ms-thumb.ms-placeholder.ms-source-pornpics .ms-domain {
                color: #ff80cc;
                opacity: 0.8;
            }
            .ms-retry-btn:hover {
                background: var(--ms-surface-3) !important;
                border-color: #f43f5e !important;
                color: var(--ms-text) !important;
            }
            .ms-media-error-banner {
                position: absolute;
                top: 68px;
                left: 50%;
                z-index: 10;
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 8px 16px;
                border-radius: 20px;
                background: rgba(244, 63, 94, 0.9);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
                color: #fff;
                font-size: 12px;
                font-weight: 600;
                pointer-events: none;
                transform: translateX(-50%);
            }
            .ms-media-error-stage {
                display: flex;
                height: 100%;
                padding: 20px;
                box-sizing: border-box;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 12px;
                color: #f43f5e;
                font-size: 14px;
                text-align: center;
            }
            .ms-media-error-message { font-weight: 600; }
            .ms-media-error-url {
                max-width: 80%;
                font-size: 11px;
                opacity: 0.7;
                word-break: break-all;
            }
            .ms-retry-btn {
                margin-top: 8px;
                padding: 6px 16px;
                border: 1px solid var(--ms-line);
                border-radius: 14px;
                background: var(--ms-surface-1);
                box-shadow: var(--ms-shadow-sm);
                color: var(--ms-text-2);
                cursor: pointer;
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                transition: background-color 150ms var(--ms-ease), border-color 150ms var(--ms-ease), color 150ms var(--ms-ease);
            }

            /* Hand (pan) tool for oversized media */
            .ms-media-wrap.ms-pan-enabled {
                cursor: grab;
            }
            .ms-media-wrap.ms-pan-enabled > .ms-media-box {
                visibility: hidden;
                background: transparent;
            }
            .ms-media-wrap.ms-pan-enabled.ms-pan-dragging {
                cursor: grabbing;
            }
            .ms-media-wrap img.ms-pannable {
                max-width: none !important;
                max-height: none !important;
                position: absolute !important;
                top: 0;
                left: 0;
                border-radius: 0;
                will-change: transform;
                user-select: none;
                inset: 0 auto auto 0 !important;
                margin: 0 !important;
            }
            .ms-pan-hint {
                position: absolute;
                top: 12px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(18, 18, 18, 0.85);
                border: 1px solid var(--ms-line);
                border-radius: 16px;
                padding: 5px 14px;
                font-size: 11px;
                color: var(--ms-text-3);
                z-index: 12;
                pointer-events: none;
                box-shadow: var(--ms-shadow-sm);
            }

            /* Grid view */
            .ms-grid-wrap {
                position: absolute;
                inset: 0;
                padding: calc(var(--ms-topbar-h) + var(--ms-filter-h) + 24px) 20px 70px 20px;
                box-sizing: border-box;
                overflow-y: auto;
                overflow-x: hidden;
                display: none;
                z-index: 5;
                scrollbar-width: thin;
                scrollbar-color: var(--ms-line-strong) var(--ms-surface-1);
            }
            .ms-gallery-overlay.ms-grid-mode .ms-grid-wrap { display: block; }
            .ms-gallery-overlay.ms-grid-mode .ms-gallery-stage,
            .ms-gallery-overlay.ms-grid-mode .ms-thumbs-wrap { display: none !important; }
            .ms-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(var(--ms-grid-size, 160px), 1fr));
                gap: 8px;
            }
            .ms-grid.ms-grid-windowed {
                display: block;
                position: relative;
                min-height: 1px;
            }
            .ms-grid-sizer { width: 100%; pointer-events: none; }
            .ms-grid-cell.ms-grid-abs {
                position: absolute;
                margin: 0;
            }
            .ms-grid-cell {
                position: relative;
                aspect-ratio: 1 / 1;
                border-radius: 6px;
                overflow: hidden;
                background: var(--ms-surface-1);
                cursor: pointer;
                border: 2px solid var(--ms-line-soft);
                padding: 0;
                transition: border-color 150ms var(--ms-ease), transform 200ms var(--ms-ease-out), box-shadow 200ms var(--ms-ease-out);
            }
            .ms-grid-cell:hover {
                border-color: var(--ms-line-strong);
                transform: translateY(-1px);
                box-shadow: var(--ms-shadow-sm);
            }
            .ms-grid-cell.active { border-color: var(--ms-accent); }
            .ms-grid-cell img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
                pointer-events: none;
            }
            .ms-grid-cell .ms-grid-idx {
                position: absolute;
                bottom: 4px;
                left: 4px;
                background: rgba(0, 0, 0, 0.65);
                color: var(--ms-text-3);
                font-size: 10px;
                padding: 1px 6px;
                border-radius: 8px;
                pointer-events: none;
            }
            .ms-grid-cell .ms-thumb-video-icon { pointer-events: none; }
            .ms-grid-cell.ms-grid-placeholder {
                display: flex;
                align-items: center;
                justify-content: center;
                flex-direction: column;
            }
            .ms-grid-cell.ms-grid-placeholder .ms-domain {
                font-size: 9px;
                color: var(--ms-text-4);
                font-family: monospace;
                margin-top: 4px;
            }
            .ms-grid-controls {
                position: absolute;
                bottom: 16px;
                left: 50%;
                transform: translateX(-50%);
                display: none;
                align-items: center;
                gap: 10px;
                background: hsla(220, 7%, 9%, 0.92);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border: 1px solid var(--ms-line);
                border-radius: 20px;
                padding: 8px 18px;
                z-index: 20;
                box-shadow: var(--ms-shadow-md);
            }
            .ms-gallery-overlay.ms-grid-mode .ms-grid-controls { display: flex; }
            .ms-grid-controls span {
                font-size: 10px;
                color: var(--ms-text-4);
                text-transform: uppercase;
                letter-spacing: 0.5px;
                white-space: nowrap;
            }
            .ms-grid-controls input[type="range"],
            .ms-grid-size-slider {
                width: 140px;
                height: 12px;
                -webkit-appearance: none;
                appearance: none;
                border: 0;
                border-radius: 2px;
                background: transparent;
                accent-color: var(--ms-accent);
                outline: none;
                cursor: pointer;
            }
            .ms-zoom-slider::-webkit-slider-runnable-track,
            .ms-grid-size-slider::-webkit-slider-runnable-track,
            .ms-grid-controls input[type="range"]::-webkit-slider-runnable-track {
                height: 4px;
                border-radius: 2px;
                background: var(--ms-line);
            }
            .ms-zoom-slider::-moz-range-track,
            .ms-grid-size-slider::-moz-range-track,
            .ms-grid-controls input[type="range"]::-moz-range-track {
                height: 4px;
                border-radius: 2px;
                background: var(--ms-line);
                border: 0;
            }
            .ms-grid-size-slider::-webkit-slider-thumb,
            .ms-grid-controls input[type="range"]::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 12px;
                height: 12px;
                margin-top: -4px;
                border: 0;
                border-radius: 50%;
                background: var(--ms-accent);
                cursor: pointer;
            }
            .ms-grid-size-slider::-moz-range-thumb,
            .ms-grid-controls input[type="range"]::-moz-range-thumb {
                width: 12px;
                height: 12px;
                border: 0;
                border-radius: 50%;
                background: var(--ms-accent);
                cursor: pointer;
            }
            .ms-grid-size-value,
            .ms-zoom-value {
                display: inline-block;
                min-width: 3.5em;
                color: var(--ms-text-2);
                font-weight: 700;
                font-variant-numeric: tabular-nums;
            }
            .ms-grid-loadmore {
                display: block;
                margin: 18px auto 60px;
                padding: 10px 32px;
                background: var(--ms-surface-1);
                border: 1px solid var(--ms-line);
                border-radius: 20px;
                color: var(--ms-text-3);
                font-size: 12px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                cursor: pointer;
                transition: all 120ms ease;
            }
            .ms-grid-loadmore:hover {
                background: var(--ms-surface-3);
                border-color: var(--ms-line);
                color: var(--ms-text);
            }
            .ms-grid-loadmore.ms-hidden { display: none; }
            /* A normal member of the centre cluster's flex row. It used to be
               absolutely positioned at a hardcoded "left: calc(50% - 145px)",
               which drifted into whatever else occupied that spot as the viewport
               narrowed. Visibility (not display) is toggled so its 14px is always
               reserved - that was the reason for absolute positioning in the first
               place (no layout jitter when it appears), and it now holds without
               the fixed offset. */
            .ms-topbar-spinner {
                width: 14px;
                height: 14px;
                border: 2px solid var(--ms-line-strong);
                border-top-color: var(--ms-text);
                border-radius: 50%;
                animation: ms-spin 0.8s linear infinite;
                visibility: hidden;
                flex-shrink: 0;
            }
            .ms-hd-btn {
                display: inline-flex;
                align-items: center;
                gap: 6px;
            }
            .ms-hd-spinner {
                display: none;
                width: 10px;
                height: 10px;
                border: 2px solid var(--ms-line-strong);
                border-top-color: var(--ms-text);
                border-radius: 50%;
                animation: ms-spin 0.8s linear infinite;
            }
            .ms-hd-btn.loading .ms-hd-spinner {
                display: inline-block;
            }
            .ms-hd-btn.ms-hd-max {
                color: var(--ms-accent);
                border-color: var(--ms-accent-line);
                background: var(--ms-accent-tint);
                cursor: default;
            }
            .ms-hd-btn.ms-hd-max:hover {
                background: var(--ms-accent-tint-strong);
            }
            .ms-media-wrap img.ms-media.ms-ready:not(.ms-pannable) {
                cursor: zoom-in;
            }
            .ms-settings-section-group {
                font-size: 11px;
                font-weight: 650;
                color: var(--ms-text-4);
                letter-spacing: 0.04em;
                text-transform: uppercase;
                margin: 14px 2px 8px;
            }
            .ms-settings-section-group:first-of-type {
                margin-top: 0;
            }
            .ms-settings-card {
                background: var(--ms-surface-2);
                border: 1px solid var(--ms-hairline);
                border-radius: 12px;
                overflow: hidden;
            }
            .ms-settings-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 16px;
                padding: 11px 12px;
                border-bottom: 1px solid var(--ms-hairline);
                transition: background-color 140ms var(--ms-ease-out);
            }
            .ms-settings-row:hover { background: var(--ms-control-rest); }
            .ms-settings-card .ms-settings-row:last-child {
                border-bottom: none;
            }
            .ms-settings-row .ms-settings-label {
                font-size: 13px;
                color: var(--ms-text-3);
                letter-spacing: 0.2px;
                line-height: 1.4;
            }
            .ms-settings-row .ms-settings-label small {
                display: block;
                font-size: 11px;
                color: var(--ms-text-4);
                font-weight: 400;
                margin-top: 2px;
            }
            .ms-settings-row select,
            .ms-settings-row input[type="number"] {
                background: var(--ms-surface-3);
                border: 1px solid var(--ms-line);
                border-radius: 6px;
                color: var(--ms-text-2);
                font-family: inherit;
                font-size: 12px;
                padding: 6px 8px;
                outline: none;
                flex-shrink: 0;
                transition: border-color 150ms var(--ms-ease);
            }
            .ms-settings-row select:focus,
            .ms-settings-row input[type="number"]:focus {
                border-color: var(--ms-accent);
            }
            .ms-settings-row input[type="number"] {
                width: 64px;
            }
            .ms-select-wrap {
                position: relative;
                display: inline-flex;
                flex-shrink: 0;
            }
            .ms-select-wrap select {
                appearance: none;
                -webkit-appearance: none;
                -moz-appearance: none;
                padding-right: 26px;
                cursor: pointer;
            }
            .ms-select-wrap::after {
                content: '';
                position: absolute;
                right: 10px;
                top: 50%;
                width: 6px;
                height: 6px;
                border-right: 1.5px solid var(--ms-text-4);
                border-bottom: 1.5px solid var(--ms-text-4);
                transform: translateY(-65%) rotate(45deg);
                pointer-events: none;
            }
            /* Toggle switch used in place of bare checkboxes - the real
               input[type=checkbox] stays in the DOM (visually hidden) so
               existing .checked reads keep working unchanged; only its visual
               presentation changes. */
            .ms-toggle {
                position: relative;
                display: inline-flex;
                align-items: center;
                flex-shrink: 0;
                cursor: pointer;
            }
            .ms-toggle input {
                position: absolute;
                opacity: 0;
                width: 1px;
                height: 1px;
                margin: 0;
            }
            .ms-toggle-track {
                width: 36px;
                height: 20px;
                background: var(--ms-surface-3);
                border: 1px solid var(--ms-line);
                border-radius: 999px;
                position: relative;
                box-sizing: border-box;
                transition: background 160ms var(--ms-ease), border-color 160ms var(--ms-ease);
            }
            .ms-toggle-thumb {
                position: absolute;
                top: 2px;
                left: 2px;
                width: 14px;
                height: 14px;
                border-radius: 50%;
                background: var(--ms-text-3);
                transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1), background 160ms var(--ms-ease);
            }
            .ms-toggle input:checked + .ms-toggle-track {
                background: var(--ms-accent);
                border-color: var(--ms-accent-line);
            }
            .ms-toggle input:checked + .ms-toggle-track .ms-toggle-thumb {
                transform: translateX(16px);
                background: #fff;
            }
            .ms-toggle input:focus-visible + .ms-toggle-track {
                outline: 2px solid var(--ms-accent);
                outline-offset: 2px;
            }
            .ms-settings-section {
                border-top: 1px solid var(--ms-line);
                margin-top: 16px;
                padding-top: 12px;
            }
            .ms-settings-section-title {
                font-size: 11px;
                color: var(--ms-text-4);
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin-bottom: 4px;
                font-weight: 600;
            }

            /* Tags panel: left-docked vertical list, toggled by the Tags/Description button */
            .ms-tags-overlay {
                /* A normal flex child of .ms-gallery-stage (not an absolutely-
                   positioned overlay) so the stage's existing justify-content:
                   center centers the [panel, image] pair as a whole, instead of
                   pinning the panel to the screen edge and pushing the image off
                   to one side. Collapses via flex-basis/width for the open/close
                   animation rather than display:none, so the transition is smooth. */
                position: relative;
                align-self: stretch;
                flex: 0 0 0px;
                width: 0;
                max-width: 0;
                margin-right: 0;
                z-index: 5;
                pointer-events: none;
                opacity: 0;
                overflow: hidden;
                transition: flex-basis 200ms var(--ms-ease-out), width 200ms var(--ms-ease-out), max-width 200ms var(--ms-ease-out), margin-right 200ms var(--ms-ease-out), opacity 200ms var(--ms-ease-out);
            }
            .ms-tags-overlay.active {
                flex: 0 0 var(--ms-tags-w);
                width: var(--ms-tags-w);
                max-width: var(--ms-tags-w);
                margin-right: 16px;
                opacity: 1;
                pointer-events: auto;
                z-index: 20;
            }
            .ms-gallery-overlay.ms-tags-resizing .ms-tags-overlay,
            .ms-gallery-overlay.ms-tags-resizing .ms-media-wrap {
                transition: none !important;
            }
            .ms-tags-resizer {
                position: absolute;
                top: 0;
                right: -3px;
                width: 10px;
                height: 100%;
                cursor: ew-resize;
                z-index: 6;
                background: transparent;
            }
            .ms-tags-resizer::after {
                content: '';
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 3px;
                height: 46px;
                border-radius: 3px;
                background: var(--ms-line-strong);
                transition: background 150ms var(--ms-ease);
            }
            .ms-tags-resizer:hover::after {
                background: var(--ms-accent);
            }
            .ms-tags-panel {
                height: 100%;
                width: 100%;
                box-sizing: border-box;
                background: var(--ms-surface-2);
                border: 1px solid var(--ms-line);
                border-radius: 12px;
                display: flex;
                flex-direction: column;
                box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
                pointer-events: auto;
                overflow: hidden;
            }
            .ms-tags-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 14px 16px;
                border-bottom: 1px solid var(--ms-line);
                flex-shrink: 0;
            }
            .ms-tags-header h3 {
                margin: 0;
                font-size: 14px;
                font-weight: 600;
                color: var(--ms-text);
            }
            .ms-tags-header-tools {
                display: flex;
                align-items: center;
                gap: 4px;
                flex-shrink: 0;
            }
            .ms-tags-font-btn {
                background: none;
                border: 1px solid var(--ms-line);
                border-radius: 8px;
                color: var(--ms-text-3);
                font-size: 11px;
                font-weight: 600;
                line-height: 1;
                padding: 0;
                width: 32px;
                height: 32px;
                cursor: pointer;
                transition: color 150ms var(--ms-ease), background-color 150ms var(--ms-ease);
            }
            .ms-tags-font-btn:hover {
                color: var(--ms-text);
                background: var(--ms-hover);
            }
            .ms-tags-close {
                width: 32px;
                height: 32px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                background: transparent;
                border: none;
                border-radius: 8px;
                color: var(--ms-text-4);
                font-size: 22px;
                cursor: pointer;
                transition: color 150ms var(--ms-ease);
                line-height: 1;
                padding: 0;
            }
            .ms-tags-close:hover {
                color: var(--ms-text);
                background: var(--ms-hover);
            }
            .ms-tags-content {
                flex: 1 1 auto;
                min-height: 0;
                display: flex;
                flex-direction: column;
                font-size: 14px;
                padding: 0;
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color: var(--ms-line-strong) var(--ms-surface-1);
            }
            .ms-post-panel {
                flex: 1 0 auto;
                width: 100%;
                min-height: 100%;
                padding: 0;
                /* The body's entrance moves it a few pixels down. Without clipping,
                   that counted as scroll overflow: a scrollbar appeared for the
                   length of the fade, took its width from the text, and a caption
                   close to the edge wrapped onto a second line and back. clip does
                   not create a scroll container, so the sticky header and footer
                   still pin to the panel's scroller. */
                overflow-y: clip;
                box-sizing: border-box;
                display: flex;
                flex-direction: column;
                align-items: stretch;
                color: var(--ms-text-2);
                font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
            }
            .ms-post-body {
                display: flex;
                flex: 1 0 auto;
                flex-direction: column;
                gap: 20px;
                width: 100%;
                padding: 6px 18px 24px;
                box-sizing: border-box;
            }
            /* No post header above: the body sits directly under the panel title's
               rule and needs the same breathing room the header would have given. */
            .ms-post-panel > .ms-post-body:first-child { padding-top: 14px; }
            .ms-info-empty {
                margin: 0;
                font-size: 13px;
                line-height: 1.5;
                color: var(--ms-text-4);
            }
            /* An editor (Photopea) over the gallery, with its own title bar. */
            .ms-editor-frame-wrap {
                position: fixed; inset: 0; z-index: 2147483647;
                display: flex; flex-direction: column;
                background: var(--ms-surface-0, #0e0f12);
            }
            .ms-editor-bar {
                display: flex; align-items: center; gap: 12px;
                padding: 8px 12px; flex: 0 0 auto;
                border-bottom: 1px solid var(--ms-hairline);
                background: var(--ms-surface-1);
                font: 500 13px/1.3 var(--ms-font-ui, system-ui, sans-serif);
                color: var(--ms-text);
            }
            .ms-editor-title { max-width: 48%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .ms-editor-status { color: var(--ms-text-4); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .ms-editor-fallback { color: var(--ms-accent); font-size: 12px; text-decoration: underline; }
            .ms-editor-spacer { flex: 1 1 auto; }
            .ms-editor-close {
                appearance: none; border: 0; background: transparent; cursor: pointer;
                color: var(--ms-text-2); font-size: 20px; line-height: 1;
                width: 32px; height: 28px; border-radius: 6px;
            }
            .ms-editor-close:hover { background: var(--ms-hover); color: var(--ms-text); }
            .ms-editor-frame { flex: 1 1 auto; width: 100%; border: 0; display: block; background: #1e1e1e; }
            /* How many files a post carries, on the corner of its thumbnail. */
            .ms-thumb-att-badge {
                position: absolute;
                top: 3px;
                right: 3px;
                min-width: 17px;
                height: 17px;
                padding: 0 4px;
                box-sizing: border-box;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border-radius: 9px;
                background: var(--ms-accent);
                color: var(--ms-on-accent, #0d0f12);
                font: 600 10px/1 var(--ms-font-ui);
                letter-spacing: 0;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
                pointer-events: none;
                z-index: 3;
            }
            .ms-att-list { display: flex; flex-direction: column; gap: 4px; width: 100%; }
            .ms-att-row {
                display: flex; align-items: stretch; width: 100%; box-sizing: border-box;
                border: 1px solid var(--ms-hairline); border-radius: 8px;
                background: rgba(255, 255, 255, 0.03); overflow: hidden;
            }
            .ms-att-main {
                display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0;
                padding: 7px 10px;
                color: var(--ms-text-2); text-decoration: none; font-weight: 400;
                transition: background 150ms var(--ms-ease), color 150ms var(--ms-ease);
            }
            .ms-att-main:hover { background: var(--ms-hover); color: var(--ms-text); }

            .ms-att-icon {
                flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
                width: 20px; height: 20px; color: var(--ms-text-4);
                transition: color 150ms var(--ms-ease);
            }
            .ms-att-icon svg { width: 20px; height: 20px; display: block; }
            .ms-att-main:hover .ms-att-icon { color: var(--ms-accent); }
            .ms-att-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
            /* Both lines clip rather than wrap, so every row keeps the same height
               however narrow the panel is dragged. */
            .ms-att-name {
                font-size: 13px; line-height: 1.35;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            .ms-att-meta {
                font-size: 11px; line-height: 1.3; color: var(--ms-text-4);
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            .ms-att-dl {
                flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
                width: 34px; color: var(--ms-text-4); text-decoration: none;
                border-left: 1px solid var(--ms-hairline);
                transition: background 150ms var(--ms-ease), color 150ms var(--ms-ease);
            }
            .ms-att-dl svg { width: 16px; height: 16px; display: block; }
            .ms-att-dl:hover { background: var(--ms-hover); color: var(--ms-text); }
            .ms-post-section {
                width: 100%;
            }
            .ms-tag-pills {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                width: 100%;
            }
            .ms-info-tags-label {
                color: var(--ms-text-4);
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin: 0 0 8px;
                width: 100%;
            }
            .ms-tag-group-owner {
                color: var(--ms-text-2);
                text-decoration: none;
                transition: color 150ms var(--ms-ease);
            }
            .ms-tag-group-owner:hover {
                color: var(--ms-accent);
            }
            /* Tags are soft chips: a quiet fill, no outline. The chip is the
               busiest element in the panel, so it carries the least ink. */
            .ms-tag-pill {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                max-width: 100%;
                box-sizing: border-box;
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid transparent;
                color: var(--ms-text-3);
                padding: 4px 10px;
                border-radius: 999px;
                font-size: 12px;
                line-height: 1.25;
                text-decoration: none;
                word-break: break-word;
                transition: background 150ms var(--ms-ease), color 150ms var(--ms-ease);
            }
            .ms-tag-pill:hover {
                background: var(--ms-hover);
                color: var(--ms-text);
            }
            .ms-tag-overflow[hidden] { display: none !important; }
            .ms-tag-more {
                min-height: 26px;
                padding: 4px 10px;
                border: 1px solid transparent;
                border-radius: 999px;
                background: transparent;
                color: var(--ms-text-4);
                font: 500 12px/1.25 var(--ms-font-ui);
                cursor: pointer;
            }
            .ms-tag-more:hover { color: var(--ms-text); background: var(--ms-hover); }
            .ms-tag-more[aria-expanded="true"] { color: var(--ms-text-2); background: rgba(255, 255, 255, 0.05); }
            /* Optional tag categories, assigned by adapters. A small leading dot
               carries the category; the chip itself stays neutral, so a long
               categorised tag list does not turn into a wall of colour. */
            .ms-tag-pill[class*="ms-tag-pill-"]::before {
                content: '';
                width: 6px;
                height: 6px;
                flex-shrink: 0;
                border-radius: 50%;
                background: var(--ms-tag-dot, var(--ms-text-4));
            }
            .ms-tag-pill-artist { --ms-tag-dot: hsl(0, 62%, 64%); }
            .ms-tag-pill-copyright { --ms-tag-dot: hsl(290, 48%, 66%); }
            .ms-tag-pill-character { --ms-tag-dot: hsl(130, 42%, 58%); }
            .ms-tag-pill-general { --ms-tag-dot: hsl(210, 60%, 66%); }
            .ms-tag-pill-metadata { --ms-tag-dot: hsl(32, 70%, 62%); }
            .ms-info-description p {
                margin: 0 0 6px;
            }
            .ms-info-description p:last-child {
                margin-bottom: 0;
            }
            .ms-gallery-overlay .ms-info-description a[href]:not(.ms-info-user-link) {
                color: var(--ms-accent-link) !important;
                font-weight: 500;
                text-decoration: underline !important;
                text-decoration-color: var(--ms-accent-line) !important;
                text-decoration-thickness: 1px;
                text-underline-offset: 2px;
                transition: color 150ms var(--ms-ease), text-decoration-color 150ms var(--ms-ease);
            }
            .ms-gallery-overlay .ms-info-description a[href]:not(.ms-info-user-link):hover {
                color: var(--ms-accent-link-hover) !important;
                text-decoration-color: currentColor !important;
            }
            .ms-info-description .ms-desc-divider {
                border: none;
                border-top: 1px solid rgba(255,255,255,0.12);
                margin: 8px 0;
            }
            .ms-info-desc-author {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 6px;
            }
            .ms-info-desc-avatar {
                width: 24px;
                height: 24px;
                border-radius: 50%;
                object-fit: cover;
                flex-shrink: 0;
                background: var(--ms-surface-3);
                transition: box-shadow 150ms var(--ms-ease);
            }
            .ms-info-desc-username {
                font-weight: 650;
                font-size: 14px;
                color: var(--ms-text);
                text-decoration: none;
                transition: color 150ms var(--ms-ease);
            }
            /* Avatar and name are one link: they react together and are a single
               tab stop. The name turns accent without drawing a box (guidelines,
               interactive state table) and the avatar gets an accent ring. A user
               without a profile URL renders no link, so nothing reacts. */
            .ms-gallery-overlay a.ms-info-user-link {
                display: flex;
                align-items: center;
                gap: inherit;
                min-width: 0;
                color: inherit;
                text-decoration: none;
                border-radius: 6px;
                cursor: pointer;
            }
            .ms-info-user-sm > a.ms-info-user-link { display: inline-flex; }
            .ms-gallery-overlay a.ms-info-user-link:hover .ms-info-desc-username,
            .ms-gallery-overlay a.ms-info-user-link:focus-visible .ms-info-desc-username {
                text-decoration: none;
                color: var(--ms-accent);
            }
            .ms-gallery-overlay a.ms-info-user-link:hover > .ms-info-desc-avatar,
            .ms-gallery-overlay a.ms-info-user-link:focus-visible > .ms-info-desc-avatar {
                box-shadow: 0 0 0 2px var(--ms-accent-line);
            }
            .ms-info-description {
                color: var(--ms-text-2);
                font-size: var(--ms-tags-font, 16px);
                line-height: 1.55;
                margin: 0;
                width: 100%;
                background: transparent;
                border: 0;
                border-radius: 0;
                padding: 0;
                box-sizing: border-box;
                word-break: break-word;
                text-wrap: pretty;
            }
            .ms-info-description-attributed {
                padding-left: 12px;
                border-left: 2px solid var(--ms-line-strong);
            }
            .ms-panel-caption {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .ms-position-control {
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            }
            /* The header stays pinned while a long caption scrolls, but it is
               separated by a short fade rather than a rule, so it reads as the
               top of the post and not as a toolbar. */
            .ms-info-posthead {
                position: sticky;
                top: 0;
                z-index: 2;
                display: flex;
                flex-direction: column;
                gap: 4px;
                width: 100%;
                min-height: 32px;
                margin: 0;
                padding: 14px 18px 10px;
                background: var(--ms-surface-2);
                box-sizing: border-box;
            }
            .ms-info-posthead::after {
                content: '';
                position: absolute;
                left: 0;
                right: 0;
                top: 100%;
                height: 12px;
                background: linear-gradient(var(--ms-surface-2), transparent);
                pointer-events: none;
            }
            .ms-post-byline {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                min-width: 0;
            }
            .ms-post-byline > .ms-info-user {
                min-width: 0;
            }
            .ms-post-byline .ms-info-desc-username {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .ms-post-repost {
                display: flex;
                align-items: center;
                gap: 6px;
                min-width: 0;
                padding-left: 32px; /* avatar 24px + gap 8px: aligns under the name */
                color: var(--ms-text-4);
                font-size: 12px;
                line-height: 1.4;
            }
            .ms-post-repost-icon {
                display: inline-flex;
                flex-shrink: 0;
                color: var(--ms-text-4);
            }
            .ms-post-repost-icon svg {
                width: 13px;
                height: 13px;
            }
            .ms-post-repost .ms-info-user-sm .ms-info-desc-username {
                color: var(--ms-text-2);
                font-weight: 500;
            }
            .ms-info-user {
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: 0;
            }
            .ms-info-user-sm {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                vertical-align: middle;
            }
            .ms-info-user-sm .ms-info-desc-avatar {
                width: 16px;
                height: 16px;
            }
            .ms-info-user-sm .ms-info-desc-username {
                font-size: 12px;
            }
            .ms-info-postmeta {
                flex-shrink: 0;
                font-size: 12px;
                color: var(--ms-text-4);
                line-height: 1.5;
                white-space: nowrap;
            }
            .ms-info-description .ms-info-user-sm {
                margin-bottom: 6px;
            }
            .ms-info-original {
                width: 100%;
                margin: 0;
                font-size: 12px;
                color: var(--ms-text-4);
            }
            .ms-info-stats {
                display: flex;
                flex-wrap: wrap;
                gap: 4px 0;
                width: 100%;
                margin: 0;
                font-size: 12px;
                color: var(--ms-text-4);
            }
            .ms-info-stat + .ms-info-stat::before {
                content: '·';
                margin: 0 8px;
                color: var(--ms-text-4);
            }
            .ms-info-stats b {
                color: var(--ms-text-2);
                font-weight: 500;
                font-variant-numeric: tabular-nums;
            }
            .ms-info-desc-role {
                font-size: 0.67em;
                text-transform: uppercase;
                letter-spacing: 0.4px;
                color: var(--ms-text-4);
                margin-right: 2px;
            }
            .ms-gallery-overlay .ms-btn.active {
                color: var(--ms-accent);
                background: var(--ms-accent-tint);
            }
            .ms-filter-trigger.active {
                color: var(--ms-accent);
                background: var(--ms-accent-tint);
            }
            .ms-filter-trigger.is-open,
            .ms-filter-trigger.active.is-open {
                color: var(--ms-text) !important;
                background: var(--ms-hover) !important;
            }
            .ms-filter-count {
                display: inline-flex;
                min-width: 16px;
                height: 16px;
                padding: 0 4px;
                align-items: center;
                justify-content: center;
                border-radius: 5px;
                background: var(--ms-accent);
                color: var(--ms-on-accent);
                font: 650 10px/1 var(--ms-font-data);
                font-variant-numeric: tabular-nums;
                margin-left: 4px;
            }
            .ms-filter-count[hidden] { display: none !important; }
            .ms-tags-actions-bar {
                display: flex;
                align-items: center;
                gap: 8px;
                margin: 0;
                flex-wrap: wrap;
            }
            .ms-post-context {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .ms-post-footer {
                position: sticky;
                bottom: 0;
                z-index: 3;
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                justify-content: space-between;
                gap: 8px 12px;
                margin-top: auto;
                padding: 10px 12px;
                border-top: 1px solid var(--ms-hairline);
                background: var(--ms-surface-2);
            }
            .ms-caption-footer {
                display: flex;
                flex: 1 1 auto;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }
            .ms-caption-mode-label {
                display: inline-flex;
                margin: 0;
                color: var(--ms-text-4);
                font: 600 11px/1.2 var(--ms-font-ui);
                letter-spacing: 0.5px;
                text-transform: uppercase;
            }
            /* Post actions are ghost buttons: no fill and no outline until the
               pointer arrives, so the footer stays quiet under the text. */
            .ms-tags-action-btn,
            .ms-tags-like-btn,
            .ms-tags-hide-btn,
            .adv-hide-btn-list {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                height: 32px;
                padding: 0 10px;
                gap: 6px;
                background: transparent;
                border: 1px solid transparent;
                color: var(--ms-text-3);
                border-radius: 8px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                box-sizing: border-box;
                line-height: 1;
                margin: 0;
                transition: background 150ms var(--ms-ease), border-color 150ms var(--ms-ease), color 150ms var(--ms-ease), transform 150ms var(--ms-ease);
            }
            .ms-tags-action-btn:hover,
            .ms-tags-like-btn:hover,
            .ms-tags-hide-btn:hover,
            .adv-hide-btn-list:hover {
                background: var(--ms-hover);
                color: var(--ms-text);
            }
            .ms-tags-action-btn:active,
            .ms-tags-like-btn:active,
            .ms-tags-hide-btn:active,
            .adv-hide-btn-list:active {
                transform: scale(0.97);
            }
            .ms-tags-action-btn svg,
            .ms-tags-hide-btn svg,
            .adv-hide-btn-list svg {
                width: 15px;
                height: 15px;
                stroke: currentColor;
                fill: none;
                flex-shrink: 0;
            }
            .ms-tags-like-btn svg {
                width: 16px;
                height: 16px;
                fill: none;
                stroke: currentColor;
                flex-shrink: 0;
                transition: fill 150ms var(--ms-ease), stroke 150ms var(--ms-ease);
            }
            .ms-tags-like-btn:hover svg {
                stroke: #ff2a54;
            }
            .ms-tags-like-btn.active {
                color: #ff2a54;
                background: rgba(255, 42, 84, 0.1);
            }
            .ms-tags-like-btn.active svg {
                fill: #ff2a54;
                stroke: #ff2a54;
            }
            .ms-tags-like-count {
                padding-left: 2px;
                color: var(--ms-text-4);
                font-weight: 600;
                font-variant-numeric: tabular-nums;
            }
            .ms-tags-like-btn.active .ms-tags-like-count {
                color: inherit;
            }
            .ms-gallery-overlay .ms-info-posthead .ms-info-desc-avatar {
                width: 24px;
                height: 24px;
            }
            .ms-gallery-overlay .ms-info-posthead .ms-info-desc-username {
                font-size: 14px;
                font-weight: 600;
            }

            .ms-gallery-overlay .ms-tags-content {
                font-size: 14px;
            }
            .ms-tags-panel,
            .ms-info-description,
            .ms-tag-pill,
            .ms-tags-action-btn,
            .ms-tags-like-btn,
            .ms-tags-hide-btn,
            .ms-tags-header h3,
            .ms-tags-font-btn {
                font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
            }
            .ms-fav-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                background: transparent !important;
                border: none !important;
                cursor: pointer;
                padding: 0 8px !important;
                transition: color 140ms var(--ms-ease-out), background-color 140ms var(--ms-ease-out);
            }
            .ms-fav-btn:hover {
                background: var(--ms-hover) !important;
                transform: none;
            }
            .ms-fav-btn svg {
                width: 18px;
                height: 18px;
                stroke: var(--ms-text-3);
                fill: transparent;
                transition: stroke 150ms var(--ms-ease), fill 150ms var(--ms-ease);
            }
            .ms-fav-btn:hover svg {
                stroke: #ff2a54;
            }
            .ms-fav-btn.active svg {
                stroke: #ff2a54;
                fill: #ff2a54;
            }

            /* Center topbar cluster: a normal grid item (column 2 of
               .ms-gallery-topbar's 3-column grid), so it's always laid out
               alongside .ms-gallery-info/.ms-gallery-controls instead of being
               absolutely positioned on top of them - the grid guarantees info
               and controls can never overlap this cluster, at any width. */
            .ms-gallery-center {
                grid-column: 2;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
            }
            .ms-gallery-center > * {
                pointer-events: auto;
            }
            /* Viewer-only controls keep their slot in grid mode and fade. Hiding
               them with display re-centred the centre cluster and moved the
               counter. Visibility is delayed on the way out so the fade can run,
               and immediate on the way back in. */
            .ms-gallery-overlay .ms-gallery-topbar .ms-mode-viewer {
                transition: color 150ms var(--ms-ease), background-color 150ms var(--ms-ease),
                    opacity 150ms var(--ms-ease), visibility 0s linear 0s;
            }
            .ms-gallery-overlay.ms-grid-mode .ms-gallery-topbar .ms-mode-viewer {
                opacity: 0 !important;
                visibility: hidden !important;
                pointer-events: none !important;
                transition: color 150ms var(--ms-ease), background-color 150ms var(--ms-ease),
                    opacity 150ms var(--ms-ease), visibility 0s linear 150ms;
            }
            /* Grid and Viewer share one box: both words are laid out at zero
               height, so the wider one sizes the label and a mode switch never
               changes the group's width. The empty alternative text keeps them
               out of the accessible name; the first declaration is the fallback. */
            .ms-gallery-overlay .ms-grid-btn .ms-btn-label {
                display: inline-flex;
                flex-direction: column;
                align-items: center;
            }
            .ms-gallery-overlay .ms-grid-btn .ms-btn-label::before,
            .ms-gallery-overlay .ms-grid-btn .ms-btn-label::after {
                display: block;
                height: 0;
                overflow: hidden;
                visibility: hidden;
            }
            .ms-gallery-overlay .ms-grid-btn .ms-btn-label::before { content: "Grid"; content: "Grid" / ""; }
            .ms-gallery-overlay .ms-grid-btn .ms-btn-label::after { content: "Viewer"; content: "Viewer" / ""; }
            .ms-icon-btn {
                display: inline-flex !important;
                align-items: center;
                justify-content: center;
                width: 32px;
                height: 32px;
                padding: 0 !important;
                flex-shrink: 0;
                box-sizing: border-box;
            }
            .ms-fullscreen-btn {
                background: transparent !important;
                border: none !important;
                cursor: pointer;
                color: var(--ms-text-3);
                border-radius: 8px;
                transition: color 150ms var(--ms-ease), background-color 150ms var(--ms-ease);
            }
            .ms-fullscreen-btn:hover {
                color: var(--ms-text);
                background: var(--ms-hover) !important;
            }
            .ms-fullscreen-btn.active {
                color: var(--ms-accent);
                background: var(--ms-accent-tint) !important;
            }
            .ms-fullscreen-btn svg {
                width: 18px;
                height: 18px;
                stroke: currentColor;
                fill: none;
            }

            /* Settings dropdown sections */
            .ms-dropdown-menu-wide {
                min-width: 190px;
            }
            .ms-dropdown-section-label {
                font-size: 9px;
                color: var(--ms-text-4);
                text-transform: uppercase;
                letter-spacing: 0.5px;
                padding: 6px 14px 2px;
            }
            .ms-dropdown-divider {
                height: 1px;
                background: var(--ms-surface-3);
                margin: 6px 0;
            }

            /* Fit-to-page toggle: expands the media stage to fill the viewport
               (CSS-only, not the browser's real Fullscreen API). */
            .ms-gallery-overlay.ms-stage-fullscreen .ms-gallery-stage {
                padding: 0 !important;
            }
            .ms-gallery-overlay.ms-stage-fullscreen .ms-thumbs-wrap,
            .ms-gallery-overlay.ms-stage-fullscreen .ms-nav {
                display: none !important;
            }
            /* Fit to page means the media, not our chrome: the bar itself goes
               away and only its controls are left floating over the image. It
               still slides off after the idle delay, and still comes back on
               pointer movement - only the panel behind the buttons is dropped. */
            .ms-gallery-overlay.ms-stage-fullscreen .ms-gallery-topbar {
                transform: translateX(-50%) translateY(0);
                transition: transform 200ms var(--ms-ease-out), background-color 200ms var(--ms-ease);
                background: transparent;
                backdrop-filter: none;
                -webkit-backdrop-filter: none;
                border-color: transparent;
                box-shadow: none;
            }
            /* Without the panel behind them the buttons sit straight on the photo,
               so they need their own contrast: a fill of their own and a shadow
               under the glyphs. */
            .ms-gallery-overlay.ms-stage-fullscreen .ms-gallery-topbar .ms-btn,
            .ms-gallery-overlay.ms-stage-fullscreen .ms-gallery-topbar .ms-position-group,
            .ms-gallery-overlay.ms-stage-fullscreen .ms-gallery-topbar .ms-zoom-slider-wrap {
                background: rgba(24, 25, 28, 0.72);
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
            }
            .ms-gallery-overlay.ms-stage-fullscreen .ms-gallery-topbar .ms-position-group > .ms-btn {
                background: transparent;
                backdrop-filter: none;
                -webkit-backdrop-filter: none;
            }
            .ms-gallery-overlay.ms-stage-fullscreen .ms-gallery-info {
                text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75);
            }
            .ms-gallery-overlay.ms-stage-fullscreen.ms-topbar-idle .ms-gallery-topbar {
                transform: translateX(-50%) translateY(-160%);
                pointer-events: none;
            }

            /* Responsive topbar: controls never wrap to a second row - instead
               updateTopbarCompact() (JS) measures whether the control row's
               natural width overflows its grid column and toggles this class,
               collapsing every button down to icon-only. Measured against the
               real content (button count/labels vary per site), not a fixed
               viewport breakpoint, so it stays correct regardless of window
               width or which buttons happen to be visible. */
            .ms-gallery-topbar.ms-icons-only .ms-btn-label { display: none; }
            .ms-gallery-topbar.ms-icons-only .ms-btn { padding: 0 8px; }
            .ms-gallery-topbar.ms-icons-only .ms-btn-icon { margin-right: 0; }
            /* A pinned control is exempt from every compaction tier. Grid is a
               primary mode switch rather than a setting, so it keeps its label
               and its padding at any width - it is the one button in the bar that
               must look the same wherever the window is. */
            .ms-gallery-topbar.ms-icons-only .ms-btn-pinned .ms-btn-label { display: inline-flex !important; }
            .ms-gallery-topbar.ms-icons-only .ms-btn-pinned { padding: 0 10px; }
            .ms-gallery-topbar.ms-icons-only .ms-btn-pinned .ms-btn-icon { margin-right: 6px; }
            /* The centre cluster has to give ground too: .ms-icon-btn is a fixed
               32px with padding:0 !important so the rules above can't touch it,
               and the zoom slider is a fixed 90px that never hid. Together those
               are ~115px that used to be unreclaimable in exactly the cramped
               configuration where it matters most. */
            .ms-gallery-topbar.ms-icons-only .ms-zoom-value { display: none; }
            .ms-gallery-topbar.ms-icons-only .ms-zoom-slider-wrap { margin: 0; gap: 0; }
            .ms-gallery-topbar.ms-icons-only .ms-zoom-slider { width: 60px; }

            /* Tier 2: labels alone aren't always enough (high page zoom on a
               narrow window). Because both flexible tracks are 1fr, the controls
               can never claim more than half the free width even when the info
               text is empty - so the only way to guarantee no overlap at any
               width is to stop reserving that half. Collapses the info column and
               gives up perfect centring of the middle cluster; space-between then
               keeps it roughly centred between the (zero-width) info track and
               the right-aligned controls. */
            .ms-gallery-topbar.ms-topbar-tight {
                grid-template-columns: 0 auto auto;
                justify-content: space-between;
                column-gap: 8px;
            }
            .ms-gallery-topbar.ms-topbar-tight .ms-gallery-info { display: none; }

            @media (prefers-reduced-motion: reduce) {
                .ms-gallery-overlay,
                .ms-gallery-overlay .ms-gallery-topbar,
                .ms-gallery-overlay .ms-gallery-stage,
                .ms-gallery-overlay .ms-thumbs-wrap,
                .ms-gallery-overlay .ms-thumb img,
                .ms-gallery-overlay .ms-thumb-handoff-old,
                .ms-nav svg { transition-duration: 0.01ms !important; transform: none !important; }
                .ms-thumb.ms-thumb-entering { animation: none !important; }
            }


            /* Zoom Slider styles */
            /* Always in flow, only ever toggled with visibility: showing/hiding it
               with display made the whole centre cluster re-centre, so enabling
               pan mode visibly nudged the fullscreen and favourite buttons
               sideways. Reserving the slot keeps them fixed. */
            .ms-zoom-slider-wrap {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                height: 30px;
                padding: 0 8px;
                box-sizing: border-box;
                border: 1px solid var(--ms-hairline);
                border-radius: 8px;
                background: var(--ms-surface-2);
                color: var(--ms-text-3);
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin: 0 4px;
            }
            .ms-zoom-slider-wrap.ms-zoom-idle {
                visibility: hidden;
                pointer-events: none;
            }
            /* Zoom mode is off but the current item is still zoomable. The slider
               keeps its place and stays live - dragging it re-enters zoom on its
               own - it just reads as inactive. Distinct from ms-zoom-idle, which
               means zoom does not apply to this item at all. */
            .ms-zoom-slider-wrap.ms-zoom-off {
                opacity: 0.55;
                transition: opacity 150ms var(--ms-ease);
            }
            .ms-zoom-slider-wrap.ms-zoom-off:hover,
            .ms-zoom-slider-wrap.ms-zoom-off:focus-within {
                opacity: 1;
            }
            .ms-zoom-value {
                display: inline-block;
                min-width: 34px;
                text-align: right;
                font-variant-numeric: tabular-nums;
            }
            .ms-zoom-slider {
                -webkit-appearance: none;
                appearance: none;
                width: 90px;
                height: 16px;
                border: 0;
                border-radius: 2px;
                background: transparent;
                accent-color: var(--ms-accent);
                outline: none;
                cursor: pointer;
                touch-action: none;
            }
            .ms-zoom-slider::-webkit-slider-runnable-track {
                height: 4px;
                border-radius: 2px;
                background: linear-gradient(to right,
                    var(--ms-accent) 0 var(--ms-zoom-progress, 0%),
                    var(--ms-line) var(--ms-zoom-progress, 0%) 100%);
            }
            .ms-zoom-slider::-moz-range-track {
                height: 4px;
                border: 0;
                border-radius: 2px;
                background: var(--ms-line);
            }
            .ms-zoom-slider::-moz-range-progress {
                height: 4px;
                border-radius: 2px;
                background: var(--ms-accent);
            }
            .ms-zoom-slider::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 12px;
                height: 12px;
                margin-top: -4px;
                border-radius: 50%;
                background: var(--ms-accent) !important;
                cursor: pointer;
                border: 0 !important;
                box-shadow: none !important;
                transition: transform 90ms var(--ms-ease);
            }
            .ms-zoom-slider::-webkit-slider-thumb:hover {
                transform: scale(1.12);
            }
            .ms-zoom-slider::-moz-range-thumb {
                width: 12px;
                height: 12px;
                border-radius: 50%;
                background: var(--ms-accent) !important;
                cursor: pointer;
                border: 0 !important;
                box-shadow: none !important;
                transition: transform 90ms var(--ms-ease);
            }
            .ms-zoom-slider::-moz-range-thumb:hover {
                transform: scale(1.12);
            }
            .ms-zoom-slider:focus-visible {
                filter: drop-shadow(0 0 3px var(--ms-accent));
            }
    .ms-index-input{top:0!important;height:1em!important;display:inline-flex!important;align-items:center!important;}.ms-position-control>span{display:inline-flex;align-items:center;height:1em;line-height:1;}.ms-tags-overlay.active{z-index:20;}.ms-load-mark-layer{position:absolute;left:0;top:0;height:100%;pointer-events:none;z-index:6;}.ms-load-mark{position:absolute;top:10px;width:14px;height:70px;display:flex;align-items:center;justify-content:center;color:var(--ms-accent);}.ms-load-mark::before{content:"";position:absolute;left:50%;top:8px;bottom:8px;width:1px;background:var(--ms-accent);opacity:0.7;}.ms-load-mark svg{width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;position:relative;z-index:1;}.ms-settings-row.ms-settings-stack{flex-direction:column;align-items:stretch;gap:8px;}.ms-settings-textarea{width:100%;min-height:88px;resize:vertical;box-sizing:border-box;background:var(--ms-surface-3,#1b1d24);border:1px solid var(--ms-line,#333);border-radius:8px;color:var(--ms-text-2,#ddd);font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:8px 10px;outline:none;}.ms-settings-textarea:focus{border-color:var(--ms-accent);}.ms-settings-hint{margin:0;font-size:11px;color:var(--ms-text-4,#888);}.ms-blacklist-pills{display:flex;flex-wrap:wrap;gap:6px;}
            .ms-accent-picker{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px}
            .ms-accent-swatch{width:26px;height:26px;padding:0;border:0;border-radius:50%;background:transparent;display:grid;place-items:center;cursor:pointer;transition:box-shadow 150ms var(--ms-ease)}
            .ms-accent-swatch-dot{width:16px;height:16px;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);pointer-events:none}
            .ms-accent-swatch[aria-pressed="true"]{box-shadow:0 0 0 2px var(--ms-accent)}
            .ms-accent-picker>input[type="color"]{width:30px;height:26px;padding:0 2px;border:1px solid var(--ms-line);border-radius:8px;background:transparent;cursor:pointer}
            .ms-accent-picker>.ms-accent-reset{padding:4px 10px;min-height:26px;border:1px solid var(--ms-line);border-radius:8px;background:var(--ms-surface-3);color:var(--ms-text);font:600 12px/1.25 var(--ms-font-ui);cursor:pointer;transition:background-color 150ms var(--ms-ease)}.ms-blacklist-pill{border:0;background:var(--ms-control-rest);color:var(--ms-text-3);border-radius:8px;padding:4px 10px;font:500 12px/1.3 var(--ms-font-ui);cursor:pointer;transition:background-color 150ms var(--ms-ease),color 150ms var(--ms-ease);}.ms-blacklist-pill:hover{background:var(--ms-hover);color:var(--ms-text);}.ms-blacklist-pill[aria-pressed="true"]{background:var(--ms-accent-tint);color:var(--ms-accent);}
            .ms-info-source{display:flex;flex-direction:column;align-items:flex-start;width:fit-content;max-width:100%;min-width:0;gap:2px;line-height:1.25}
            .ms-info-source>a{align-self:flex-start;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            .ms-info-meta{display:block;font:10px/1.3 var(--ms-font-data);font-variant-numeric:tabular-nums;color:var(--ms-text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .ms-info-meta>span:empty{display:none}
            .ms-info-meta>span:not(:empty)~span:not(:empty)::before{content:"\00B7";margin:0 5px;color:var(--ms-text-4)}
            .ms-post-media-meta{font-size:11px;line-height:18px;min-height:18px;color:var(--ms-text-4)}
            .ms-tags-action-btn,.ms-tags-action-btn *{text-decoration:none!important}
            /* A tab row, not a row of pills. Route nav in this design is quiet text
               with an active underline, and four outlined buttons floating between
               the header hairline and the body read as four separate controls
               rather than one switch. The seam the row sits on is the only border
               in the region; the tabs themselves carry none. */
            .ms-settings-tabs {
                display: flex;
                gap: 2px;
                flex-shrink: 0;
                padding: 4px 16px 0;
                margin-bottom: 12px;
                border-bottom: 1px solid var(--ms-hairline);
                /* overflow-y has to be stated: left alone it computes to auto
                   next to overflow-x, and the active underline below then earns
                   the row a vertical scrollbar of its own. */
                overflow-x: auto;
                overflow-y: hidden;
                scrollbar-width: thin;
                scrollbar-color: var(--ms-line-strong) transparent;
            }
            .ms-settings-tab {
                position: relative;
                flex-shrink: 0;
                height: 36px;
                padding: 0 12px;
                border: 0;
                border-radius: 8px 8px 0 0;
                background: transparent;
                color: var(--ms-text-3);
                font: 500 13px/1 var(--ms-font-ui);
                white-space: nowrap;
                cursor: pointer;
                transition: background-color 150ms var(--ms-ease), color 150ms var(--ms-ease);
            }
            .ms-settings-tab::after {
                content: "";
                position: absolute;
                left: 8px;
                right: 8px;
                bottom: 0;
                height: 2px;
                border-radius: 1px 1px 0 0;
                background: transparent;
                transition: background-color 150ms var(--ms-ease);
            }
            .ms-settings-tab:hover { background: var(--ms-hover); color: var(--ms-text); }
            .ms-settings-tab[aria-selected="true"] { color: var(--ms-accent); }
            .ms-settings-tab[aria-selected="true"]::after { background: var(--ms-accent); }
            .ms-settings-tab[aria-selected="true"]:hover { background: var(--ms-hover); }
            /* The row is a scroll container, so an outward ring would be clipped. */
            .ms-settings-tab:focus-visible { outline: 2px solid var(--ms-accent); outline-offset: -2px; }
            /* Switching from a long page to a short one must not resize the dialog. */
            .ms-settings-page { min-height: 240px; }
            .ms-settings-page[hidden]{display:none!important}
            .ms-r34-settings-modal button:not(:disabled):not([aria-selected="true"]):not(.is-success):not(.is-error):not(.ms-r34-save):not(:active):hover{background:var(--ms-hover)!important;color:var(--ms-text)!important}
            .ms-r34-settings-modal button:focus-visible{outline:2px solid var(--ms-accent);outline-offset:2px}
            .ms-r34-settings-modal button:disabled{opacity:.45;cursor:default}
            .ms-settings-row>button{padding:8px 12px;min-height:34px;border:1px solid var(--ms-line);border-radius:8px;background:var(--ms-surface-3);color:var(--ms-text);font:600 12px/1.25 var(--ms-font-ui);cursor:pointer;transition:background-color 140ms var(--ms-ease-out),border-color 140ms var(--ms-ease-out),color 140ms var(--ms-ease-out),opacity 140ms var(--ms-ease-out)}
            .ms-settings-row>button.is-busy{cursor:wait;color:var(--ms-text-3)}
            .ms-settings-row>button.is-success{border-color:var(--ms-accent-line);background:var(--ms-accent-tint)}
            .ms-settings-row>button.is-error{border-color:rgba(239,96,96,.58);color:#f3b0b0}
            .ms-settings-row>select,.ms-settings-row>input[type="number"],.ms-settings-label{font-family:var(--ms-font-ui)}
            .ms-position-control{font-family:var(--ms-font-data);font-variant-numeric:tabular-nums}.ms-info-postmeta,.ms-tags-like-count{font-family:var(--ms-font-ui);font-variant-numeric:tabular-nums}
            .ms-settings-label small{font-family:var(--ms-font-ui)}
            .ms-gallery-overlay[data-ms-feed-loading="1"] .ms-position-control::after{content:"";display:inline-block;width:6px;height:6px;margin-left:7px;border-radius:50%;background:var(--ms-accent);box-shadow:0 0 0 3px var(--ms-accent-tint);animation:ms-feed-pulse 900ms var(--ms-ease-out) infinite alternate}
            @keyframes ms-feed-pulse{from{opacity:.38;transform:scale(.82)}to{opacity:1;transform:scale(1)}}
            .ms-gallery-overlay :where(button, a, input, select, textarea):focus-visible {
                outline: 2px solid var(--ms-accent);
                outline-offset: 2px;
            }
            .ms-gallery-overlay :where(button, [role="button"], a.ms-tag-pill, a.ms-tags-action-btn):not(:disabled) {
                transition-property: color, background-color, border-color, box-shadow, opacity, transform, scale;
                transition-duration: 140ms;
                transition-timing-function: var(--ms-ease-out);
            }
            .ms-gallery-overlay :where(button, [role="button"]):disabled {
                opacity: 0.42;
                cursor: default;
            }
            .ms-gallery-topbar .ms-btn {
                border-color: transparent !important;
                box-shadow: none !important;
            }
            /* ---------------------------------------------------------------------
               Entrances. Opacity plus a few pixels of the independent translate
               property, so they compose with transforms controls use for layout.
               Navigation itself never animates; these cover content that arrives.
               --------------------------------------------------------------------- */
            .ms-post-body {
                transition: opacity 160ms var(--ms-ease-out), translate 160ms var(--ms-ease-out);
            }
            .ms-post-body.ms-post-entering {
                opacity: 0;
                translate: 0 4px;
                transition: none;
            }
            .ms-post-skeleton {
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding-top: 2px;
            }
            .ms-skel-line,
            .ms-skel-chips {
                display: block;
                height: 12px;
                width: 92%;
                border-radius: 6px;
                background: linear-gradient(90deg, var(--ms-surface-3) 0%, hsl(220, 7%, 17%) 50%, var(--ms-surface-3) 100%);
                background-size: 200% 100%;
                animation: ms-skel-shimmer 1.4s ease-in-out infinite;
            }
            .ms-skel-wide { width: 100%; }
            .ms-skel-short { width: 58%; }
            .ms-skel-chips {
                height: 22px;
                width: 70%;
                margin-top: 6px;
                border-radius: 11px;
            }
            @keyframes ms-skel-shimmer {
                from { background-position: 100% 0; }
                to { background-position: -100% 0; }
            }
            .ms-grid-cell.ms-grid-entering {
                animation: ms-grid-enter 200ms var(--ms-ease-out) backwards;
            }
            @keyframes ms-grid-enter {
                from { opacity: 0; translate: 0 6px; }
            }
            /* Status pills (resolving, loading GIF, checking availability) wait a
               moment before fading in. Work that finishes quickly, like a cached
               load, never flashes a pill; slow work still gets one. Updating the
               text of a pill already on screen does not replay this. */
            .ms-resolve-loading {
                animation: ms-pill-in 160ms var(--ms-ease-out) 220ms backwards;
            }
            @keyframes ms-pill-in {
                from { opacity: 0; translate: 0 4px; }
            }
            @media (prefers-reduced-motion: reduce) {
                .ms-resolve-loading { animation: none; }
                .ms-post-body { transition: none; }
                .ms-skel-line, .ms-skel-chips { animation: none; }
                .ms-grid-cell.ms-grid-entering { animation: none; }
            }

            /* ---------------------------------------------------------------------
               Interaction states: one system for every control.

                 rest      transparent, or the control's own surface
                 hover     neutral fill (buttons) or a firmer edge (fields)
                 press     pressed fill and a slight shrink
                 open      pressed fill and an inset ring (disclosure triggers)
                 selected  accent tint and accent text (per component)
                 focus     2px accent outline (global rule above)

               Press uses the independent scale property rather than transform.
               Several controls already use transform for placement (centred with
               translateX(-50%), lifted with translateY(-1px)); scale composes with
               that instead of replacing it, so nothing jumps when pressed.
               Selected controls keep their tint while pressed.
               --------------------------------------------------------------------- */
            .ms-gallery-overlay :where(button, [role="button"], a.ms-tag-pill, a.ms-tags-action-btn):not(:disabled):not(.ms-nav):active,
            .ms-r34-settings-overlay :where(button, [role="button"]):not(:disabled):active {
                scale: 0.97;
            }
            .ms-gallery-overlay :where(.ms-filter-kind, .ms-filter-type, .ms-filter-reset, .ms-tags-font-btn, .ms-tags-close,
                .ms-tag-more, .ms-tag-pill, .ms-retry-btn, .ms-grid-loadmore, .ms-caption-mode button):not(:disabled):not(.active):not(.is-active):not([aria-pressed="true"]):not([aria-expanded="true"]):active {
                background-color: var(--ms-pressed) !important;
            }
            .ms-r34-settings-overlay :where(.ms-settings-close, .ms-settings-tab, .ms-settings-row > button, .ms-blacklist-pill):not(:disabled):not([aria-selected="true"]):not([aria-pressed="true"]):active {
                background-color: var(--ms-pressed) !important;
            }
            /* The previous/next strip is the whole screen edge; press the chevron. */
            .ms-gallery-overlay .ms-nav:not(:disabled):active svg {
                scale: 0.92;
            }
            /* Thumbnails and grid cells are media, not surfaces: press dims them. */
            .ms-gallery-overlay :where(.ms-thumb, .ms-grid-cell):active {
                scale: 0.96;
            }

            /* Fields: hover firms the edge. Focus keeps its own accent rule, so a
               focused field is left alone. */
            .ms-gallery-overlay :where(.ms-filter-input, .ms-filter-pair input):not(:disabled):not(:focus):hover,
            .ms-r34-settings-overlay :where(input:not([type="checkbox"]):not([type="range"]), select, textarea):not(:disabled):not(:focus):hover {
                border-color: var(--ms-line-strong);
            }
            .ms-gallery-overlay .ms-position-control:not(:focus-within):hover {
                border-color: var(--ms-line);
                background-color: var(--ms-surface-3);
            }

            /* Toggle switch: the track answers hover, the thumb answers press. */
            .ms-r34-settings-overlay .ms-toggle:hover .ms-toggle-track,
            .ms-gallery-overlay .ms-toggle:hover .ms-toggle-track {
                border-color: var(--ms-line-strong);
            }
            .ms-r34-settings-overlay .ms-toggle:hover input:checked + .ms-toggle-track,
            .ms-gallery-overlay .ms-toggle:hover input:checked + .ms-toggle-track {
                background: var(--ms-accent-hover);
            }
            .ms-r34-settings-overlay .ms-toggle:active .ms-toggle-thumb,
            .ms-gallery-overlay .ms-toggle:active .ms-toggle-thumb {
                scale: 0.86;
            }
            .ms-toggle-thumb {
                transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1), background 160ms var(--ms-ease), scale 120ms var(--ms-ease);
            }

            /* Range thumbs grow a little under the pointer, like the zoom slider. */
            .ms-grid-size-slider::-webkit-slider-thumb,
            .ms-grid-controls input[type="range"]::-webkit-slider-thumb {
                transition: transform 90ms var(--ms-ease);
            }
            .ms-grid-size-slider:hover::-webkit-slider-thumb,
            .ms-grid-controls input[type="range"]:hover::-webkit-slider-thumb {
                transform: scale(1.12);
            }
            .ms-grid-size-slider:active::-webkit-slider-thumb,
            .ms-grid-controls input[type="range"]:active::-webkit-slider-thumb,
            .ms-zoom-slider:active::-webkit-slider-thumb {
                transform: scale(1.25);
            }

            /* A disclosure trigger whose panel is open. It must differ from hover:
               right after the click the pointer is still on the button, and a
               state that paints the same fill as hover shows no change at all.
               Kept after the topbar reset above, which clears box-shadow. */
            .ms-gallery-overlay .ms-gallery-topbar .ms-filter-trigger.is-open,
            .ms-gallery-overlay .ms-gallery-topbar .ms-filter-trigger.active.is-open {
                color: var(--ms-text) !important;
                background: var(--ms-pressed) !important;
                box-shadow: inset 0 0 0 1px var(--ms-line-strong) !important;
            }
            @media (prefers-reduced-motion: reduce) {
                .ms-gallery-overlay :where(button, [role="button"], a, input) {
                    transition-duration: 0.01ms !important;
                }
            }

            /* ------------------------------------------------------------------
               The host-page launcher cluster.

               These used to be three independent position:fixed boxes at
               right: 20px / 118px / 166px, so the gaps between them were not
               declared anywhere - they were what was left after subtracting two
               content-dependent widths from three hardcoded offsets. That made
               Gallery-to-settings about 26px and content-dependent, while
               settings-to-auxiliary was exactly 10px, which is the uneven spacing
               the auxiliary button appeared to cause.

               One flex container fixes both complaints at once: spacing is now
               structural (a shared 1px seam drawn by the adjacent-sibling rule),
               so it is identical with and without the auxiliary button, and the
               settings button cannot drift away from Gallery again. Outer corners
               are rounded by the container, inner corners are square, because
               overflow: hidden clips the children to the container's radius.
               ------------------------------------------------------------------ */
            #ms-site-cluster {
                position: fixed;
                top: 70px;
                right: 20px;
                z-index: 9999;
                display: inline-flex;
                align-items: stretch;
                isolation: isolate;
                box-sizing: border-box;
                border: 1px solid rgba(255, 255, 255, 0.24);
                border-radius: 10px;
                background: #191b20;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
                overflow: hidden;
            }
            /* The inline shield sets display, so this has to outrank it: a
               cluster with nothing in it would otherwise be a bordered empty box
               floating on the page. */
            #ms-site-cluster:empty { display: none !important; }
            #ms-site-cluster > .ms-site-cluster-btn {
                appearance: none !important;
                box-sizing: border-box !important;
                height: 36px !important;
                min-height: 36px !important;
                max-height: 36px !important;
                margin: 0 !important;
                padding: 0 14px !important;
                position: static !important;
                inset: auto !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                gap: 6px !important;
                flex: 0 0 auto !important;
                border: 0 !important;
                border-radius: 0 !important;
                background: transparent !important;
                color: #e7e8eb !important;
                font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif !important;
                letter-spacing: 0.5px;
                text-transform: none !important;
                text-shadow: none !important;
                text-decoration: none !important;
                white-space: nowrap !important;
                cursor: pointer !important;
                opacity: 1 !important;
                filter: none !important;
                backdrop-filter: none !important;
                box-shadow: none !important;
                transition: background-color 150ms cubic-bezier(0.4, 0, 0.2, 1);
            }
            /* The seam. Written as an adjacent-sibling rule so N buttons always
               produce N-1 identical divisions: removing a button (cum.st drops
               Gallery) re-seams and re-rounds with no JS at all. */
            #ms-site-cluster > .ms-site-cluster-btn + .ms-site-cluster-btn {
                border-inline-start: 1px solid rgba(255, 255, 255, 0.24) !important;
            }
            #ms-site-cluster > .ms-site-cluster-btn:hover { background: rgba(255, 255, 255, 0.08) !important; }
            #ms-site-cluster > .ms-site-cluster-btn:active { background: rgba(255, 255, 255, 0.12) !important; scale: 0.97; }
            /* overflow: hidden on the container would clip an outward ring. */
            #ms-site-cluster > .ms-site-cluster-btn:focus-visible {
                outline: 2px solid var(--ms-accent) !important;
                outline-offset: -2px !important;
            }
            #ms-site-cluster > #ms-site-settings-btn { width: 36px !important; padding: 0 !important; }
            #ms-site-cluster > #ms-site-settings-btn svg {
                display: block;
                width: 18px;
                height: 18px;
                transition: transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
            }
            #ms-site-cluster > #ms-site-settings-btn:hover svg { transform: rotate(45deg); }
            @media (prefers-reduced-motion: reduce) {
                #ms-site-cluster > #ms-site-settings-btn svg { transition: none; }
                #ms-site-cluster > #ms-site-settings-btn:hover svg { transform: none; }
            }
            #ms-site-cluster > #ms-site-settings-btn svg path,
            #ms-site-cluster > #ms-site-settings-btn svg circle {
                fill: none !important;
                stroke: currentColor !important;
            }
            @media (prefers-reduced-motion: reduce) {
                #ms-site-cluster > .ms-site-cluster-btn { transition-duration: 0.01ms !important; }
                #ms-site-cluster > .ms-site-cluster-btn:active { scale: 1; }
            }
    `;

    function installOverlayStyles(addStyle) {
        if (typeof addStyle !== 'function') throw new TypeError('addStyle must be a function');
        return addStyle(OVERLAY_CSS);
    }

    const LAUNCHER_CSS = String.raw`
            :root {
                --ms-bg: hsl(220, 8%, 8%);
                --ms-surface-1: hsl(220, 7%, 9%);
                --ms-surface-3: hsl(220, 7%, 13%);
                --ms-line: rgba(255, 255, 255, 0.16);
                --ms-line-strong: rgba(255, 255, 255, 0.26);
                --ms-text: hsl(40, 22%, 88%);
                /* One accent, driven by three channels. Everything derived from it -
                   tint, line, hover, links, and the ink that sits on an accent fill -
                   is computed here, so the live accent setting only has to write
                   the --xg-accent-* inputs on :root, which inherit into the shadow
                   roots too. Default hsl(223, 78%, 65%): lighter and less saturated
                   than the old 57% blue, and it passes 4.5:1 as text on every dark
                   surface, which the old one did not (3.4-3.8:1). */
                --ms-accent-h: var(--xg-accent-h, 223);
                --ms-accent-s: var(--xg-accent-s, 78%);
                --ms-accent-l: var(--xg-accent-l, 65%);
                --ms-accent: hsl(var(--ms-accent-h), var(--ms-accent-s), var(--ms-accent-l));
                --ms-accent-tint: hsla(var(--ms-accent-h), var(--ms-accent-s), var(--ms-accent-l), 0.13);
                --ms-accent-tint-strong: hsla(var(--ms-accent-h), var(--ms-accent-s), var(--ms-accent-l), 0.22);
                --ms-accent-line: hsla(var(--ms-accent-h), var(--ms-accent-s), var(--ms-accent-l), 0.72);
                --ms-accent-hover: hsl(var(--ms-accent-h), var(--ms-accent-s), min(92%, calc(var(--ms-accent-l) + 5%)));
                --ms-accent-link: hsl(var(--ms-accent-h), min(100%, calc(var(--ms-accent-s) + 4%)), min(90%, calc(var(--ms-accent-l) + 8%)));
                --ms-accent-link-hover: hsl(var(--ms-accent-h), min(100%, calc(var(--ms-accent-s) + 8%)), min(94%, calc(var(--ms-accent-l) + 17%)));
                /* White fails on any accent light enough to pass as text, so the ink
                   on an accent fill is dark unless applyAccent picks otherwise. */
                --ms-on-accent: hsl(220, 8%, var(--xg-on-accent-l, 8%));
                --ms-hover: rgba(255, 255, 255, 0.08);
                --ms-shadow-md: 0 4px 12px rgba(0, 0, 0, 0.35);
                --ms-font-ui: "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif;
            }
            .ms-xcom-gallery-btn, .ms-site-gallery-btn {
                position: fixed;
                top: 70px;
                right: 20px;
                z-index: 9999;
                height: 38px;
                box-sizing: border-box;
                padding: 0 18px;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                line-height: 1 !important;
                background: var(--ms-surface-1);
                color: var(--ms-text);
                border: 1px solid var(--ms-line);
                border-radius: 20px;
                cursor: pointer;
                font-weight: 700;
                box-shadow: var(--ms-shadow-md);
                font-family: var(--ms-font-ui) !important;
                font-size: 13px;
                letter-spacing: 0.5px;
            }
            .ms-xcom-gallery-btn { padding: 10px 20px; height: auto; }
            .ms-xcom-gallery-btn:hover, .ms-site-gallery-btn:hover {
                background: var(--ms-surface-3);
                border-color: var(--ms-line-strong);
            }
            /* Layout-neutral by construction. The old version was a fixed 28px
               inline-flex, which as an atomic inline forces the line box to
               contain its whole margin box - so on a host with a 21px line it
               grew every line of prose it appeared in, and vertical-align: middle
               hung it below the descent and made that worse. It is now sized in
               em from the text beside it (1.3 x 0.82em = 1.07em against a typical
               1.4 line-height), so it always fits inside the line it joins. */
            .ms-open-in-gallery {
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                gap: 0.4em !important;
                box-sizing: border-box !important;
                height: 1.3em !important;
                min-height: 0 !important;
                max-height: none !important;
                padding: 0 0.45em !important;
                margin: 0 0 0 0.4em !important;
                /* Sits inside the ascent/descent band rather than centred on the
                   x-height, which is what used to push it past the descent. */
                vertical-align: -0.25em !important;
                background: var(--ms-surface-1) !important;
                color: var(--ms-text) !important;
                border: 1px solid var(--ms-line) !important;
                border-radius: 999px !important;
                cursor: pointer !important;
                font-family: var(--ms-font-ui) !important;
                font-size: 0.82em;
                font-weight: 600;
                letter-spacing: 0.02em;
                line-height: 1 !important;
                text-transform: none;
                white-space: nowrap !important;
            }
            .ms-open-in-gallery svg {
                width: 1em;
                height: 1em;
                flex: 0 0 auto;
                display: block;
            }
            /* In flow it is icon-only. The label was around 90px of inline width,
               and that width is what wrapped prose and broke the two-up embed row
               on simpcity - height was only half the problem. */
            .ms-open-in-gallery:not(.ms-open-in-gallery--pinned):not(.ms-open-in-gallery--unfurl) {
                padding: 0 !important;
                width: 1.3em !important;
                gap: 0 !important;
            }
            .ms-open-in-gallery:not(.ms-open-in-gallery--pinned):not(.ms-open-in-gallery--unfurl) .ms-btn-label {
                display: none !important;
            }
            /* Out of flow, for block hosts. Takes no part in the host's layout at
               all - including inside a flex or grid parent, where an absolutely
               positioned child is not an item and so adds no track. */
            .ms-open-in-gallery--pinned {
                position: absolute !important;
                top: auto !important;
                left: auto !important;
                right: 8px !important;
                bottom: 8px !important;
                margin: 0 !important;
                vertical-align: baseline !important;
                font-size: 11px !important;
                height: 22px !important;
                padding: 0 8px !important;
                z-index: 4 !important;
                box-shadow: var(--ms-shadow-md) !important;
            }
            .ms-open-in-gallery--embed {
                margin-inline-start: 0;
                margin-block-start: 0;
            }
            .ms-open-in-gallery--unfurl {
                margin-inline-start: 0.4em;
                margin-block-start: 0;
                height: 1.5em !important;
                min-height: 0 !important;
                padding: 0 0.5em;
                font-size: 0.78em;
                position: relative !important;
                z-index: 4 !important;
                pointer-events: auto !important;
                touch-action: manipulation;
                isolation: isolate;
            }
            .ms-open-in-gallery-host {
                position: relative !important;
                z-index: 3 !important;
            }
            .ms-open-in-gallery:hover {
                background: var(--ms-surface-3) !important;
                color: var(--ms-text) !important;
                border-color: var(--ms-line) !important;
            }
            .ms-open-in-gallery:active {
                scale: 0.97;
            }
            @media (prefers-reduced-motion: reduce) {
                .ms-open-in-gallery:active { scale: 1; }
            }
            .ms-open-in-gallery:focus-visible {
                outline: 2px solid var(--ms-accent);
                outline-offset: 2px;
            }
            .ms-site-settings-btn {
                position: fixed;
                top: 70px;
                right: 118px;
                z-index: 9999;
                width: 38px;
                height: 38px;
                box-sizing: border-box;
                padding: 0;
                background: var(--ms-surface-1);
                color: var(--ms-text);
                border: 1px solid var(--ms-line);
                border-radius: 50%;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: var(--ms-shadow-md);
                transition: transform 180ms cubic-bezier(0.23, 1, 0.32, 1), background 140ms var(--ms-ease), border-color 140ms var(--ms-ease);
            }
            .ms-site-settings-btn svg {
                display: block;
                transition: transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
            }
            .ms-site-settings-btn svg path,
            .ms-site-settings-btn svg circle {
                fill: none !important;
                stroke: currentColor !important;
            }
            .ms-site-settings-btn:hover {
                background: var(--ms-surface-3);
                border-color: var(--ms-line-strong);
            }
            .ms-site-settings-btn:hover svg {
                transform: rotate(45deg);
            }
            #ms-site-redirect-btn {
                position: fixed;
                top: 70px;
                right: 166px;
                z-index: 9999;
                height: 38px;
                box-sizing: border-box;
                padding: 0 14px;
                background: var(--ms-surface-1);
                color: var(--ms-text);
                border: 1px solid var(--ms-line);
                border-radius: 20px;
                cursor: pointer;
                font-family: system-ui, -apple-system, Segoe UI, sans-serif !important;
                font-size: 13px;
                font-weight: 700;
                letter-spacing: 0.5px;
                line-height: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: var(--ms-shadow-md);
            }
            #ms-site-redirect-btn:hover {
                background: var(--ms-surface-3);
                border-color: var(--ms-line-strong);
            }

            /* ------------------------------------------------------------------
               The host-page launcher cluster.

               These used to be three independent position:fixed boxes at
               right: 20px / 118px / 166px, so the gaps between them were not
               declared anywhere - they were what was left after subtracting two
               content-dependent widths from three hardcoded offsets. That made
               Gallery-to-settings about 26px and content-dependent, while
               settings-to-auxiliary was exactly 10px, which is the uneven spacing
               the auxiliary button appeared to cause.

               One flex container fixes both complaints at once: spacing is now
               structural (a shared 1px seam drawn by the adjacent-sibling rule),
               so it is identical with and without the auxiliary button, and the
               settings button cannot drift away from Gallery again. Outer corners
               are rounded by the container, inner corners are square, because
               overflow: hidden clips the children to the container's radius.
               ------------------------------------------------------------------ */
            #ms-site-cluster {
                position: fixed;
                top: 70px;
                right: 20px;
                z-index: 9999;
                display: inline-flex;
                align-items: stretch;
                isolation: isolate;
                box-sizing: border-box;
                border: 1px solid rgba(255, 255, 255, 0.24);
                border-radius: 10px;
                background: #191b20;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
                overflow: hidden;
            }
            /* The inline shield sets display, so this has to outrank it: a
               cluster with nothing in it would otherwise be a bordered empty box
               floating on the page. */
            #ms-site-cluster:empty { display: none !important; }
            #ms-site-cluster > .ms-site-cluster-btn {
                appearance: none !important;
                box-sizing: border-box !important;
                height: 36px !important;
                min-height: 36px !important;
                max-height: 36px !important;
                margin: 0 !important;
                padding: 0 14px !important;
                position: static !important;
                inset: auto !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                gap: 6px !important;
                flex: 0 0 auto !important;
                border: 0 !important;
                border-radius: 0 !important;
                background: transparent !important;
                color: #e7e8eb !important;
                font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif !important;
                letter-spacing: 0.5px;
                text-transform: none !important;
                text-shadow: none !important;
                text-decoration: none !important;
                white-space: nowrap !important;
                cursor: pointer !important;
                opacity: 1 !important;
                filter: none !important;
                backdrop-filter: none !important;
                box-shadow: none !important;
                transition: background-color 150ms cubic-bezier(0.4, 0, 0.2, 1);
            }
            /* The seam. Written as an adjacent-sibling rule so N buttons always
               produce N-1 identical divisions: removing a button (cum.st drops
               Gallery) re-seams and re-rounds with no JS at all. */
            #ms-site-cluster > .ms-site-cluster-btn + .ms-site-cluster-btn {
                border-inline-start: 1px solid rgba(255, 255, 255, 0.24) !important;
            }
            #ms-site-cluster > .ms-site-cluster-btn:hover { background: rgba(255, 255, 255, 0.08) !important; }
            #ms-site-cluster > .ms-site-cluster-btn:active { background: rgba(255, 255, 255, 0.12) !important; scale: 0.97; }
            /* overflow: hidden on the container would clip an outward ring. */
            #ms-site-cluster > .ms-site-cluster-btn:focus-visible {
                outline: 2px solid var(--ms-accent) !important;
                outline-offset: -2px !important;
            }
            #ms-site-cluster > #ms-site-settings-btn { width: 36px !important; padding: 0 !important; }
            #ms-site-cluster > #ms-site-settings-btn svg {
                display: block;
                width: 18px;
                height: 18px;
                transition: transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
            }
            #ms-site-cluster > #ms-site-settings-btn:hover svg { transform: rotate(45deg); }
            @media (prefers-reduced-motion: reduce) {
                #ms-site-cluster > #ms-site-settings-btn svg { transition: none; }
                #ms-site-cluster > #ms-site-settings-btn:hover svg { transform: none; }
            }
            #ms-site-cluster > #ms-site-settings-btn svg path,
            #ms-site-cluster > #ms-site-settings-btn svg circle {
                fill: none !important;
                stroke: currentColor !important;
            }
            @media (prefers-reduced-motion: reduce) {
                #ms-site-cluster > .ms-site-cluster-btn { transition-duration: 0.01ms !important; }
                #ms-site-cluster > .ms-site-cluster-btn:active { scale: 1; }
            }
    `;
    function installLauncherStyles(addStyle) { return addStyle(LAUNCHER_CSS); }

    // ---- accent colour -----------------------------------------------------------
    const DEFAULT_ACCENT = '#6088eb';
    // No red: in this design red means liked or favourite.
    const ACCENT_PRESETS = [
        ['Blue', '#6088eb'], ['Sky', '#51b8ec'], ['Teal', '#3bbab6'],
        ['Green', '#59c084'], ['Amber', '#efac39'], ['Violet', '#aa84eb']
    ];

    function relativeLuminance(rgb) {
        return rgb.map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); })
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    }
    function contrastRatio(a, b) {
        const x = relativeLuminance(a), y = relativeLuminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    }
    function hslToRgb(h, s, l) {
        s /= 100; l /= 100;
        const k = (n) => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        return [0, 8, 4].map((n) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
    }

    // A picked colour becomes channel values. Lightness is raised until the accent
    // passes 4.5:1 as text on the lightest dark surface, so a navy pick still reads;
    // the ink on an accent fill is whichever of white or near-black contrasts more.
    function accentTokens(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!m) return null;
        const n = parseInt(m[1], 16);
        const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        let h = 0, s = 0, l = (max + min) / 2;
        if (d) {
            s = d / (1 - Math.abs(2 * l - 1));
            h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            h = (h * 60 + 360) % 360;
        }
        h = Math.round(h); s = Math.round(s * 100); l = Math.round(l * 100);
        const surface = hslToRgb(220, 7, 13);
        while (l < 90 && contrastRatio(hslToRgb(h, s, l), surface) < 4.5) l++;
        const fill = hslToRgb(h, s, l);
        const onAccentL = contrastRatio([255, 255, 255], fill) >= contrastRatio(hslToRgb(220, 8, 8), fill) ? 100 : 8;
        return { h, s, l, onAccentL };
    }

    // Writes the accent inputs on :root through one owned style element. Custom
    // properties inherit through shadow hosts even under all: initial, so this one
    // rule recolours the overlay, the settings panel and the launcher alike. An
    // empty or invalid value removes it and the stylesheet default applies.
    function applyAccent(color, doc) {
        const d = doc || document;
        let sheet = d.getElementById('xg-accent-vars');
        const tokens = accentTokens(color);
        if (!tokens) { if (sheet) sheet.remove(); return null; }
        if (!sheet) {
            sheet = d.createElement('style');
            sheet.id = 'xg-accent-vars';
            sheet.setAttribute('data-xg-own', '1');
            (d.head || d.documentElement).append(sheet);
        }
        sheet.textContent = ':root{--xg-accent-h:' + tokens.h + ';--xg-accent-s:' + tokens.s + '%;--xg-accent-l:' + tokens.l
            + '%;--xg-on-accent-l:' + tokens.onAccentL + '%}';
        return tokens;
    }

    const IMAGE_EXTS = Object.freeze(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']);
    const VIDEO_EXTS = Object.freeze(['mp4', 'webm', 'm4v', 'mov', 'mkv']);
    const FILE_TYPE_OPTIONS = Object.freeze([
        'jpg', 'png', 'gif', 'webp', 'mp4', 'webm', 'm4v', 'zip', 'pdf'
    ]);

    const DEFAULT_FILTER_STATE = Object.freeze({
        query: '',
        kind: 'all',
        types: Object.freeze([]),
        minMb: null,
        maxMb: null,
        minAlbum: null,
        maxAlbum: null,
        extrasOpen: false,
        hideUnavailable: false
    });

    function asNumber(value) {
        if (value === '' || value == null) return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function normalizeFilterState(input) {
        const src = input && typeof input === 'object' ? input : {};
        const kind = src.kind === 'images' || src.kind === 'videos' ? src.kind : 'all';
        const types = Array.isArray(src.types)
            ? src.types.map((t) => String(t || '').replace(/^\./, '').toLowerCase()).filter(Boolean)
            : [];
        return {
            query: String(src.query || ''),
            kind: kind,
            types: types,
            minMb: asNumber(src.minMb),
            maxMb: asNumber(src.maxMb),
            minAlbum: asNumber(src.minAlbum),
            maxAlbum: asNumber(src.maxAlbum),
            extrasOpen: src.extrasOpen === true,
            hideUnavailable: src.hideUnavailable === true
        };
    }

    function isFilterStateActive(input) {
        const state = normalizeFilterState(input);
        return state.kind !== 'all'
            || state.types.length > 0
            || state.minMb != null
            || state.maxMb != null
            || state.hideUnavailable
            || String(state.query || '').trim() !== '';
    }

    function parseSearchQuery(query) {
        const text = String(query || '').trim();
        const include = [];
        const exclude = [];
        const re = /([+-])?"([^"]+)"|([+-])?(\S+)/g;
        let match;
        while ((match = re.exec(text))) {
            const quoted = match[2];
            const word = quoted != null ? quoted : match[4];
            if (!word) continue;
            const sign = quoted != null ? match[1] : match[3];
            const token = { value: word.toLowerCase(), phrase: quoted != null };
            if (sign === '-') exclude.push(token);
            else include.push(token);
        }
        return { include: include, exclude: exclude };
    }

    function itemSearchText(item) {
        if (!item || typeof item !== 'object') return '';
        const parts = [
            item.src, item.thumbSrc, item.resolveUrl, item.filename,
            item.galleryName, item.title, item.description, item.postId
        ];
        if (Array.isArray(item.tags)) {
            for (const tag of item.tags) {
                parts.push(typeof tag === 'string' ? tag : (tag && (tag.name || tag.tag || '')));
            }
        } else if (item.tags) {
            parts.push(String(item.tags));
        }
        const author = item.postInfo && item.postInfo.author;
        if (author) parts.push(author.username, author.profileUrl);
        return parts.filter(Boolean).join(' ').toLowerCase();
    }

    function itemExtension(item) {
        if (!item) return '';
        if (item.detectedFormat && item.detectedFormatSource === item.src) return item.detectedFormat;
        const mime = String(item.mediaMime || item.mimeType || '').toLowerCase().split(';')[0].trim();
        if (mime === 'image/gif') return 'gif';
        if (mime === 'image/webp') return 'webp';
        if (mime === 'image/jpeg') return 'jpg';
        if (mime === 'image/png') return 'png';
        if (mime === 'video/mp4') return 'mp4';
        if (mime === 'video/webm') return 'webm';
        if (item.isGif) return 'gif';
        const name = String(item.filename || item.src || item.thumbSrc || '').split('?')[0];
        const match = name.match(/\.([a-z0-9]{2,5})$/i);
        if (!match) return '';
        const ext = match[1].toLowerCase();
        return ext === 'jpeg' ? 'jpg' : ext;
    }

    function itemKind(item) {
        if (!item) return 'images';
        if (item.type === 'video' || item.type === 'iframe' || item.isVideo || item.expectedVideo) return 'videos';
        const ext = itemExtension(item);
        if (VIDEO_EXTS.indexOf(ext) >= 0) return 'videos';
        return 'images';
    }

    function itemBytes(item) {
        if (!item) return null;
        const raw = item.bytes != null ? item.bytes : (item.fileSize != null ? item.fileSize : item.size);
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }

    function itemAlbumSize(item) {
        if (!item) return null;
        const raw = item.albumSize != null ? item.albumSize : (item.fileCount != null ? item.fileCount : item.albumFileCount);
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }

    function haystackHas(haystack, token) {
        if (token.phrase) return haystack.indexOf(token.value) >= 0;
        return haystack.split(/[^a-z0-9._-]+/i).some((part) => part === token.value)
            || haystack.indexOf(token.value) >= 0;
    }

    function matchGalleryItem(item, state) {
        const filter = normalizeFilterState(state);
        if (filter.hideUnavailable && item && item._msUnavailable === true) return false;
        if (filter.kind !== 'all' && itemKind(item) !== filter.kind) return false;
        if (filter.types.length) {
            const ext = itemExtension(item);
            if (!ext || filter.types.indexOf(ext) < 0) return false;
        }
        const bytes = itemBytes(item);
        if (bytes != null) {
            const mb = bytes / (1024 * 1024);
            if (filter.minMb != null && mb < filter.minMb) return false;
            if (filter.maxMb != null && mb > filter.maxMb) return false;
        }
        const album = itemAlbumSize(item);
        if (album != null) {
            if (filter.minAlbum != null && album < filter.minAlbum) return false;
            if (filter.maxAlbum != null && album > filter.maxAlbum) return false;
        }
        const parsed = parseSearchQuery(filter.query);
        if (!parsed.include.length && !parsed.exclude.length) return true;
        const haystack = itemSearchText(item);
        for (const token of parsed.exclude) {
            if (haystackHas(haystack, token)) return false;
        }
        for (const token of parsed.include) {
            if (!haystackHas(haystack, token)) return false;
        }
        return true;
    }

    function applyGalleryFilter(items, state, getItem) {
        if (!Array.isArray(items)) return [];
        const pick = typeof getItem === 'function' ? getItem : (entry) => entry;
        return items.filter((entry) => matchGalleryItem(pick(entry), state));
    }

    const FILTER_TYPE_OPTIONS = FILE_TYPE_OPTIONS;
    const FILTER_IMAGE_EXTS = IMAGE_EXTS;
    const FILTER_VIDEO_EXTS = VIDEO_EXTS;

    const ICON = {
        search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.34-4.34"/></svg>',
        image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
        video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>',
        copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
        sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/></svg>',
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
    };

    function typeButtonsHtml() {
        return FILE_TYPE_OPTIONS.map((ext) => (
            '<button type="button" class="ms-filter-type" data-ext="' + ext + '">' + ext.toUpperCase() + '</button>'
        )).join('');
    }

    function filterBarMarkup() {
        return [
            '<form class="ms-filter-bar" autocomplete="off" aria-hidden="true">',
            '  <div class="ms-filter-toolbar">',
            '    <div class="ms-filter-kinds">',
            '      <button type="button" class="ms-filter-kind" data-kind="all">' + ICON.search + 'All</button>',
            '      <button type="button" class="ms-filter-kind" data-kind="images">' + ICON.image + 'Images</button>',
            '      <button type="button" class="ms-filter-kind" data-kind="videos">' + ICON.video + 'Videos</button>',
            '    </div>',
            '    <div class="ms-filter-toolbar-end">',
            '      <button class="ms-filter-reset" type="button">Reset filters</button>',
            '    </div>',
            '  </div>',
            '  <div class="ms-filter-extras">',
            '    <div class="ms-filter-field" role="group" aria-labelledby="ms-filter-types-label"><span id="ms-filter-types-label">File types</span><div class="ms-filter-types">' + typeButtonsHtml() + '</div></div>',
            '    <div class="ms-filter-field" role="group" aria-labelledby="ms-filter-size-label"><span id="ms-filter-size-label">File size</span><div class="ms-filter-pair">',
            '      <input class="ms-filter-min-mb" type="number" min="0" inputmode="numeric" placeholder="Min MB">',
            '      <input class="ms-filter-max-mb" type="number" min="0" inputmode="numeric" placeholder="Max MB">',
            '    </div></div>',
            '    <button type="button" class="ms-filter-type ms-filter-hide-unavailable" aria-pressed="false">Hide unavailable</button>',
            '  </div>',
            '  <div class="ms-filter-chips" hidden></div>',
            '</form>'
        ].join('');
    }

    function paintChips(root, state) {
        const wrap = root.querySelector('.ms-filter-chips');
        if (!wrap) return;
        const chips = state.types.map((ext) => '.' + ext);
        wrap.hidden = !chips.length;
        wrap.innerHTML = chips.map((label) => (
            '<button type="button" class="ms-filter-chip" data-ext="' + label.slice(1) + '">' + label + ICON.close + '</button>'
        )).join('');
    }

    function isActiveControl(control) {
        if (!control) return false;
        const root = control.getRootNode && control.getRootNode();
        return document.activeElement === control || !!(root && root.activeElement === control);
    }

    function paint(root, state) {
        const input = root.querySelector('.ms-filter-input');
        if (input && input.value !== state.query && !isActiveControl(input)) input.value = state.query;
        root.querySelectorAll('.ms-filter-kind').forEach((btn) => {
            btn.classList.toggle('is-active', btn.getAttribute('data-kind') === state.kind);
        });
        root.querySelectorAll('.ms-filter-type').forEach((btn) => {
            const ext = btn.getAttribute('data-ext');
            btn.classList.toggle('is-active', state.types.indexOf(ext) >= 0);
        });
        const minMb = root.querySelector('.ms-filter-min-mb');
        const maxMb = root.querySelector('.ms-filter-max-mb');
        const minAlbum = root.querySelector('.ms-filter-min-album');
        const maxAlbum = root.querySelector('.ms-filter-max-album');
        if (minMb && !isActiveControl(minMb)) minMb.value = state.minMb == null ? '' : String(state.minMb);
        if (maxMb && !isActiveControl(maxMb)) maxMb.value = state.maxMb == null ? '' : String(state.maxMb);
        if (minAlbum && !isActiveControl(minAlbum)) minAlbum.value = state.minAlbum == null ? '' : String(state.minAlbum);
        if (maxAlbum && !isActiveControl(maxAlbum)) maxAlbum.value = state.maxAlbum == null ? '' : String(state.maxAlbum);
        const hideUnavailable = root.querySelector('.ms-filter-hide-unavailable');
        if (hideUnavailable) {
            hideUnavailable.classList.toggle('is-active', state.hideUnavailable);
            hideUnavailable.setAttribute('aria-pressed', String(state.hideUnavailable));
        }
        const overlay = root.closest('.ms-gallery-overlay');
        const trigger = overlay && overlay.querySelector('[data-act="filter-toggle"]');
        if (trigger) {
            const active = isFilterStateActive(state);
            trigger.classList.toggle('active', active);
            trigger.setAttribute('aria-pressed', active ? 'true' : 'false');
            const count = (state.kind !== 'all' ? 1 : 0)
                + state.types.length
                + (state.minMb != null || state.maxMb != null ? 1 : 0)
                + (String(state.query || '').trim() ? 1 : 0)
                + (state.hideUnavailable ? 1 : 0);
            const badge = trigger.querySelector('.ms-filter-count');
            if (badge) {
                badge.hidden = !count;
                badge.textContent = String(count);
            }
        }
        paintChips(root, state);
    }

    function readForm(root, extrasOpen) {
        const types = [];
        root.querySelectorAll('.ms-filter-type.is-active').forEach((btn) => {
            const ext = btn.getAttribute('data-ext');
            if (ext) types.push(ext);
        });
        const input = root.querySelector('.ms-filter-input');
        const kindBtn = root.querySelector('.ms-filter-kind.is-active');
        return normalizeFilterState({
            query: input ? input.value : '',
            kind: kindBtn ? kindBtn.getAttribute('data-kind') : 'all',
            types: types,
            minMb: root.querySelector('.ms-filter-min-mb') && root.querySelector('.ms-filter-min-mb').value,
            maxMb: root.querySelector('.ms-filter-max-mb') && root.querySelector('.ms-filter-max-mb').value,
            minAlbum: root.querySelector('.ms-filter-min-album') && root.querySelector('.ms-filter-min-album').value,
            maxAlbum: root.querySelector('.ms-filter-max-album') && root.querySelector('.ms-filter-max-album').value,
            extrasOpen: extrasOpen,
            hideUnavailable: root.querySelector('.ms-filter-hide-unavailable')?.getAttribute('aria-pressed') === 'true'
        });
    }

    function syncFilterHeight(root) {
        const overlay = root.closest('.ms-gallery-overlay');
        if (!overlay) return;
        overlay.style.setProperty('--ms-filter-h', '0px');
    }

    function setFilterOpen(root, open) {
        const overlay = root.closest('.ms-gallery-overlay');
        if (!overlay) return false;
        const next = !!open;
        overlay.classList.toggle('ms-filter-open', next);
        root.setAttribute('aria-hidden', next ? 'false' : 'true');
        const trigger = overlay.querySelector('[data-act="filter-toggle"]');
        if (trigger) {
            trigger.setAttribute('aria-expanded', next ? 'true' : 'false');
            trigger.classList.toggle('is-open', next);
        }
        syncFilterHeight(root);
        return next;
    }

    function bindFilterBar(root, options = {}) {
        if (!root) return null;
        let state = normalizeFilterState(options.state);
        const emit = () => {
            paint(root, state);
            syncFilterHeight(root);
            if (typeof options.onChange === 'function') options.onChange(normalizeFilterState(state));
        };
        paint(root, state);
        syncFilterHeight(root);

        root.addEventListener('submit', (event) => {
            event.preventDefault();
            state = readForm(root, state.extrasOpen);
            emit();
        });
        const input = root.querySelector('.ms-filter-input');
        let debounce = null;
        if (input) {
            input.addEventListener('input', () => {
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                    state = readForm(root, state.extrasOpen);
                    emit();
                }, 120);
            });
        }
        root.addEventListener('click', (event) => {
            if (event.target.closest('.ms-filter-hide-unavailable')) {
                state.hideUnavailable = !state.hideUnavailable;
                emit();
                return;
            }
            const kind = event.target.closest('.ms-filter-kind');
            if (kind) {
                state.kind = kind.getAttribute('data-kind') || 'all';
                emit();
                return;
            }
            const typeBtn = event.target.closest('.ms-filter-type, .ms-filter-chip');
            if (typeBtn) {
                const ext = typeBtn.getAttribute('data-ext');
                if (!ext) return;
                const next = state.types.slice();
                const at = next.indexOf(ext);
                if (at >= 0) next.splice(at, 1);
                else next.push(ext);
                state.types = next;
                emit();
                return;
            }
            if (event.target.closest('.ms-filter-reset')) {
                state = normalizeFilterState({});
                emit();
                return;
            }
        });
        root.addEventListener('change', (event) => {
            if (!event.target.closest('.ms-filter-extras')) return;
            state = readForm(root, state.extrasOpen);
            emit();
        });

        return {
            getState: () => normalizeFilterState(state),
            setState: (next) => {
                state = normalizeFilterState(next);
                paint(root, state);
                syncFilterHeight(root);
            },
            open: () => setFilterOpen(root, true),
            close: () => setFilterOpen(root, false),
            toggle: () => setFilterOpen(root, !root.closest('.ms-gallery-overlay').classList.contains('ms-filter-open')),
            isOpen: () => !!(root.closest('.ms-gallery-overlay') && root.closest('.ms-gallery-overlay').classList.contains('ms-filter-open')),
            focus: () => {
                setFilterOpen(root, true);
                if (input) input.focus();
            },
            destroy: () => setFilterOpen(root, false)
        };
    }

    // Reading a public Google Drive folder, for adapters that meet Drive links in
    // someone else's page. Drive serves a plain HTML listing for embedding at
    // /embeddedfolderview, which needs no API key and carries the signed-in
    // session when the folder is private. Nothing here fetches: the caller passes
    // a request function, because a userscript's own request is the one that
    // escapes the page's cross-origin rules.
    const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;
    const GOOGLE_DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

    function driveUrl(value) {
        try {
            const parsed = new URL(String(value || ''), 'https://drive.google.com/');
            return /^(?:drive|docs)\.google\.com$/i.test(parsed.hostname)
                || /^drive\.usercontent\.google\.com$/i.test(parsed.hostname) ? parsed : null;
        } catch (e) {
            return null;
        }
    }

    function googleDriveFolderId(value) {
        const parsed = driveUrl(value);
        if (!parsed || !/^drive\.google\.com$/i.test(parsed.hostname)) return '';
        const path = parsed.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)/i);
        if (path && DRIVE_ID.test(path[1])) return path[1];
        if (/^\/(?:embedded)?folderview$/i.test(parsed.pathname)) {
            const id = parsed.searchParams.get('id') || '';
            return DRIVE_ID.test(id) ? id : '';
        }
        return '';
    }

    function googleDriveFileId(value) {
        const parsed = driveUrl(value);
        if (!parsed) return '';
        const path = parsed.pathname.match(/^\/(?:a\/[^/]+\/)?file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/i);
        if (path && DRIVE_ID.test(path[1])) return path[1];
        if (/^\/(?:open|uc|download|thumbnail)$/i.test(parsed.pathname)) {
            const id = parsed.searchParams.get('id') || '';
            return DRIVE_ID.test(id) ? id : '';
        }
        return '';
    }

    function googleDriveListingUrl(folderId, resourceKey) {
        return 'https://drive.google.com/embeddedfolderview?id=' + encodeURIComponent(folderId)
            + (resourceKey ? '&resourcekey=' + encodeURIComponent(resourceKey) : '');
    }

    // Images: the thumbnail endpoint at size s0 redirects to the untouched
    // original, signed for the current session. GIFs and videos go through the
    // download endpoint - a GIF keeps its animation there, and video answers range
    // requests (confirm=t skips the "can't scan this for viruses" page).
    function googleDriveFileUrls(id, options) {
        const kind = (options && options.kind) || 'image';
        const thumb = 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w400';
        if (kind === 'video') {
            return { src: 'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(id) + '&export=download&confirm=t', thumb: thumb };
        }
        if (kind === 'gif') {
            return { src: 'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(id) + '&export=view', thumb: thumb };
        }
        if (kind === 'file') {
            return { src: 'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(id) + '&export=download&confirm=t', thumb: '' };
        }
        return { src: 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=s0', thumb: thumb };
    }

    function parseGoogleDriveFolderListing(html, doc) {
        const parser = doc || (typeof document !== 'undefined' ? document : null);
        if (!parser) return { title: '', entries: [] };
        const parsed = new (parser.defaultView || window).DOMParser().parseFromString(String(html || ''), 'text/html');
        const title = String((parsed.querySelector('title') || {}).textContent || '')
            .replace(/\s*[-–]\s*Google Drive\s*$/i, '').trim();
        const entries = Array.from(parsed.querySelectorAll('.flip-entry[id^="entry-"]')).map((entry) => {
            const id = entry.id.replace(/^entry-/, '');
            const link = entry.querySelector('a[href]');
            const href = link ? String(link.getAttribute('href') || '') : '';
            const icon = entry.querySelector('.flip-entry-list-icon img, .flip-entry-icon img');
            const iconMime = icon ? (String(icon.getAttribute('src') || '').match(/\/type\/(.+)$/) || [])[1] || '' : '';
            const folder = /\/drive\/(?:u\/\d+\/)?folders\//i.test(href) || iconMime === GOOGLE_DRIVE_FOLDER_MIME;
            return {
                id: id,
                name: String((entry.querySelector('.flip-entry-title') || {}).textContent || '').trim(),
                mime: folder ? GOOGLE_DRIVE_FOLDER_MIME : decodeURIComponent(iconMime),
                folder: folder
            };
        }).filter((entry) => DRIVE_ID.test(entry.id));
        return { title: title, entries: entries };
    }

    // Walks a folder and its subfolders, in listing order. `request(url)` returns
    // the listing HTML (or rejects). Every entry comes back typed, so the caller
    // decides what belongs in a gallery and what is just a file.
    async function readGoogleDriveFolder(request, folderUrl, options) {
        const rootId = googleDriveFolderId(folderUrl);
        if (!rootId || typeof request !== 'function') return { name: '', files: [] };
        const settings = options || {};
        const maxDepth = Number.isFinite(settings.maxDepth) ? settings.maxDepth : 3;
        const maxFolders = Number.isFinite(settings.maxFolders) ? settings.maxFolders : 25;
        const visited = new Set();
        let name = '';

        const walk = async (folderId, depth, path, resourceKey) => {
            if (depth > maxDepth || visited.size >= maxFolders || visited.has(folderId)) return [];
            visited.add(folderId);
            const listing = parseGoogleDriveFolderListing(await request(googleDriveListingUrl(folderId, resourceKey)), settings.document);
            if (!name) name = listing.title;
            const files = [];
            for (const entry of listing.entries) {
                if (entry.folder) {
                    files.push(...await walk(entry.id, depth + 1, path.concat(entry.name).filter(Boolean), ''));
                    continue;
                }
                files.push({
                    id: entry.id,
                    name: entry.name,
                    mime: entry.mime,
                    folder: path.join(' / '),
                    viewUrl: 'https://drive.google.com/file/d/' + entry.id + '/view'
                });
            }
            return files;
        };

        try {
            const files = await walk(rootId, 0, [], settings.resourceKey || '');
            return { id: rootId, name: name, files: files };
        } catch (error) {
            return { id: rootId, name: name, files: [], error: (error && error.message) || 'failed' };
        }
    }

    const HEART_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8Z"/></svg>';

    function createOverlayShell(options = {}) {
        const doc = options.document || document;
        const overlay = doc.createElement('div');
        const classes = Array.isArray(options.classes) ? options.classes.filter(Boolean) : [];
        overlay.className = ['ms-gallery-overlay'].concat(classes).join(' ');
        if (options.fontFamily) overlay.style.fontFamily = options.fontFamily;

        overlay.innerHTML = [
            '<div class="ms-gallery-topbar">',
            '  <div class="ms-gallery-info"></div>',
            '  <div class="ms-gallery-center">',
            '    <div class="ms-position-group">',
    '      <label class="ms-position-control" title="Go to image"><input type="text" inputmode="numeric" pattern="[0-9]*" class="ms-index-input" value="1" aria-label="Go to image"><span aria-hidden="true">/</span><span class="ms-position-total">1</span></label>',
    '      <button class="ms-btn ms-btn-pinned ms-grid-btn" data-act="view-toggle" title="Grid"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><span class="ms-btn-label">Grid</span></button>',
    '    </div>',
            '    <div class="ms-topbar-spinner" title="Loading full image..."></div>',
            '    <button class="ms-mode-viewer ms-btn ms-icon-btn ms-fullscreen-btn" data-act="fullscreen-toggle" title="Fit to page"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg></button>',
            '    <button class="ms-mode-viewer ms-btn ms-icon-btn ms-fav-btn" data-act="fav-toggle" style="display:none;" title="Favorite"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg></button>',
            '    <button class="ms-mode-viewer ms-btn ms-icon-btn ms-x-action" data-act="x-like" style="display:none;" title="Like post"><svg viewBox="0 0 24 24"><path d="M16.7 5.5c-1.3 0-2.7.6-3.9 2.2L12 8.8l-.8-1.1C10 6.1 8.6 5.5 7.3 5.5 5 5.6 3.4 7.8 4.4 10.4c.8 2.2 3.2 5.3 7.6 8 4.4-2.7 6.8-5.8 7.6-8 1-2.6-.6-4.8-2.9-4.9Z"/></svg></button>',
            '    <button class="ms-mode-viewer ms-btn ms-icon-btn ms-x-action" data-act="x-bookmark" style="display:none;" title="Bookmark post"><svg viewBox="0 0 24 24"><path d="M6.5 3h11c.8 0 1.5.7 1.5 1.5V21l-7-5-7 5V4.5C5 3.7 5.7 3 6.5 3Z"/></svg></button>',
            '    <div class="ms-mode-viewer ms-zoom-slider-wrap ms-zoom-idle">',
            '      <b class="ms-zoom-value"></b>',
            '      <input type="range" class="ms-zoom-slider" min="0.1" max="3" step="0.01">',
            '    </div>',
            '  </div>',
            '  <div class="ms-gallery-controls">',
            '    <button class="ms-mode-viewer ms-btn ms-hd-btn" data-act="hd" style="display:none;"><span class="ms-hd-spinner"></span>HD</button>',
            '    <button class="ms-mode-viewer ms-btn ms-tags-btn" data-act="show-tags" style="display:' + (options.showInfo ? '' : 'none') + ';"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg><span class="ms-btn-label">' + String(options.infoLabel || 'Info') + '</span></button>',
            '    <button class="ms-mode-viewer ms-btn ms-loop-btn" data-act="loop-toggle" style="display:none;" title="Loop"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg><span class="ms-btn-label">Loop</span></button>',
                    '    <button class="ms-mode-viewer ms-btn" data-act="pan-toggle" title="Zoom &amp; pan"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg><span class="ms-btn-label">Zoom</span></button>',
            '    <div class="ms-mode-viewer ms-dropdown">',
            '      <button class="ms-btn ms-dropdown-trigger" data-act="fit-trigger"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M8 7l4-4 4 4"/><path d="M8 17l4 4 4-4"/></svg><span class="ms-btn-label">Fit: Std</span></button>',
            '      <div class="ms-dropdown-menu">',
            '    <button class="ms-dropdown-item" data-act="fit" data-val="standard">Standard</button>',
            '    <button class="ms-dropdown-item" data-act="fit" data-val="vertical">Vertical</button>',
            '      </div>',
            '    </div>',
            '    <button class="ms-mode-viewer ms-btn" data-act="thumbs-toggle" title="Toggle thumbnails"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="5.5" height="10" rx="1"/><rect x="9.25" y="7" width="5.5" height="10" rx="1"/><rect x="16.5" y="7" width="5.5" height="10" rx="1"/></svg><span class="ms-btn-label">Thumbs</span></button>',
            '    <button class="ms-btn ms-filter-trigger" data-act="filter-toggle" aria-expanded="false" title="Filter gallery"><svg class="ms-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/></svg><span class="ms-btn-label">FILTER</span><span class="ms-filter-count" hidden></span></button>',
            '    <button class="ms-btn" data-act="download" title="Download"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg><span class="ms-btn-label">DL</span></button>',
            '    <button class="ms-btn ms-close-btn" data-act="close" title="Close"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg><span class="ms-btn-label">Close</span></button>',
            '  </div>',
            '</div>',
            filterBarMarkup(),
            '<div class="ms-gallery-stage">',
            '  <div class="ms-tags-overlay">',
            '    <div class="ms-tags-panel">',
            '      <div class="ms-tags-header">',
            '    <h3>Info</h3>',
            '    <div class="ms-tags-header-tools">',
            '      <button class="ms-tags-font-btn" data-act="tags-font" data-val="-1" title="Smaller description">A&minus;</button>',
            '      <button class="ms-tags-font-btn" data-act="tags-font" data-val="1" title="Larger description">A+</button>',
            '      <button class="ms-tags-close" data-act="tags-close">&times;</button>',
            '    </div>',
            '      </div>',
            '      <div class="ms-tags-content"></div>',
            '    </div>',
            '    <div class="ms-tags-resizer" title="Drag to resize"></div>',
            '  </div>',
            '  <button class="ms-nav prev" data-act="prev" aria-label="Previous image"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg></button>',
            '  <div class="ms-media-wrap"></div>',
            '  <button class="ms-nav next" data-act="next" aria-label="Next image"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>',
            '</div>',
            '<div class="ms-reddit-info-row">',
            '  <div class="ms-reddit-card">',
            '    <div class="ms-reddit-resizer" title="Drag to resize"></div>',
            '    <div class="ms-reddit-postinfo">',
            '      <a class="ms-reddit-title" target="_blank" rel="noopener" href="#"></a>',
            '      <div class="ms-reddit-meta"></div>',
            '    </div>',
            '  </div>',
            '  <div class="ms-reddit-actions">',
            '    <div class="ms-reddit-votes">',
            '      <button class="ms-reddit-vote" data-rdvote="upvote" title="Upvote"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3l8 9h-5v9H9v-9H4z"/></svg></button>',
            '      <span class="ms-reddit-score">&#8226;</span>',
            '      <button class="ms-reddit-vote" data-rdvote="downvote" title="Downvote"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 21l-8-9h5V3h6v9h5z"/></svg></button>',
            '    </div>',
            '    <button class="ms-reddit-save" data-rdsave="1" title="Save post"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 2h12a1 1 0 0 1 1 1v19l-7-4.5L5 22V3a1 1 0 0 1 1-1z"/></svg><span class="ms-reddit-save-label">Save</span></button>',
            '  </div>',
            '</div>',
            '<div class="ms-grid-wrap"><div class="ms-grid"></div><button type="button" class="ms-grid-loadmore">Load more</button></div>',
            '<div class="ms-grid-controls"><span>Thumb size <b class="ms-grid-size-value"></b></span><input type="range" class="ms-grid-size-slider" min="90" max="340" step="10"></div>',
            '<div class="ms-thumbs-wrap"><div class="ms-thumbs-track"></div></div>'
        ].join('');

        overlay.querySelectorAll('[data-act="x-like"], [data-act="fav-toggle"]').forEach(button => { button.innerHTML = HEART_ICON; });
        if (options.shadowCss && typeof overlay.attachShadow === 'function') {
            const host = doc.createElement('xgallery-root');
            host.className = 'ms-gallery-root';
            host.style.setProperty('all', 'initial', 'important');
            host.style.setProperty('position', 'fixed', 'important');
            host.style.setProperty('inset', '0', 'important');
            host.style.setProperty('z-index', '2147483646', 'important');
            host.style.setProperty('pointer-events', 'none', 'important');
            host.style.setProperty('display', 'block', 'important');
            const shadow = host.attachShadow({ mode: 'open' });
            const style = doc.createElement('style');
            // Dark Reader rewrites the colours of every stylesheet it can reach,
            // shadow roots included. It maps light values to dark ones, so the
            // overlay's white-alpha hairlines, drawn on an already dark surface,
            // come out dark and vanish. Its style manager skips any sheet carrying
            // the class "darkreader" (shouldManageStyle), which leaves this one
            // alone. This must stay on the shadow sheet only: when Dark Reader is
            // turned off it removes every .darkreader node it finds in the light
            // DOM, but it does not search shadow roots.
            style.className = 'darkreader';
            style.textContent = String(options.shadowCss);
            shadow.append(style, overlay);
            Object.defineProperty(overlay, 'msRootHost', { value: host });
        }

        return overlay;
    }

    const SVG_NS = 'http://www.w3.org/2000/svg';

    function domainFromUrl(value) {
        try {
            return new URL(value).hostname.replace(/^www\./, '') || 'unknown';
        } catch (error) {
            return value ? 'error' : 'unknown';
        }
    }

    function createSvgElement(doc, name, attributes) {
        const element = doc.createElementNS(SVG_NS, name);
        Object.entries(attributes || {}).forEach(([key, value]) => element.setAttribute(key, String(value)));
        return element;
    }

    function createPlaceholderIcon(doc, isVideo) {
        const svg = createSvgElement(doc, 'svg', { viewBox: '0 0 24 24', width: 32, height: 32 });
        const frame = createSvgElement(doc, 'rect', {
            x: 2,
            y: isVideo ? 4 : 3,
            width: 20,
            height: isVideo ? 16 : 18,
            fill: 'none',
            stroke: '#666',
            'stroke-width': 1.5,
            rx: 2
        });
        svg.appendChild(frame);

        if (isVideo) {
            svg.appendChild(createSvgElement(doc, 'polygon', {
                points: '10,8 10,16 16,12',
                fill: '#666'
            }));
            return svg;
        }

        svg.appendChild(createSvgElement(doc, 'circle', { cx: 6, cy: 7, r: 1.5, fill: '#666' }));
        svg.appendChild(createSvgElement(doc, 'path', {
            d: 'M 2 17 L 10 10 L 18 18 L 22 14 L 22 21 L 2 21 Z',
            fill: '#666',
            opacity: 0.3
        }));
        return svg;
    }

    function appendDomain(doc, host, sourceUrl) {
        const label = doc.createElement('div');
        label.className = 'ms-domain';
        label.textContent = domainFromUrl(sourceUrl);
        host.appendChild(label);
    }

    function showPlaceholder(options) {
        const host = options.host;
        host.classList.add(options.placeholderClass);
        host.replaceChildren(createPlaceholderIcon(options.document, options.isVideo));
        if (options.showDomain) appendDomain(options.document, host, options.sourceUrl);
        appendTypeBadge(options);
    }

    function appendTypeBadge(options) {
        const doc = options.document;
        options.host.querySelectorAll('.ms-thumb-video-icon, .ms-thumb-gif-icon').forEach(node => node.remove());
        if (options.isVideo && !options.isAnimated) {
            const badge = doc.createElement('div');
            badge.className = 'ms-thumb-video-icon';
            badge.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="#fff"/></svg>';
            options.host.appendChild(badge);
        } else if (options.isAnimated) {
            const badge = doc.createElement('div');
            badge.className = 'ms-thumb-gif-icon';
            badge.textContent = options.animatedLabel || 'GIF';
            options.host.appendChild(badge);
        }
    }

    function lockThumbnailFill(host) {
        host.querySelectorAll(':scope > img, :scope > video').forEach(media => {
            media.style.setProperty('width', '100%', 'important');
            media.style.setProperty('height', '100%', 'important');
            media.style.setProperty('min-width', '100%', 'important');
            media.style.setProperty('min-height', '100%', 'important');
            media.style.setProperty('max-width', 'none', 'important');
            media.style.setProperty('max-height', 'none', 'important');
            media.style.setProperty('object-fit', 'cover', 'important');
            media.style.setProperty('margin', '0', 'important');
        });
    }

    function renderThumbnailCell(options) {
        const doc = options.document || document;
        const host = options.host;
        const placeholderClass = options.placeholderClass || 'ms-placeholder';
        const activeClass = options.active ? ' active' : '';
        const baseClass = options.baseClass || 'ms-thumb';
        const absoluteClass = options.absoluteClass || '';
        const sourceClass = options.sourceClass || '';
        const cacheClass = options.cacheClass || '';

        host.className = baseClass + absoluteClass + sourceClass + cacheClass + activeClass;
        if (options.hdSrc) host.setAttribute('data-hd-src', options.hdSrc);

        const shared = {
            document: doc,
            host,
            isVideo: !!options.isVideo,
            isAnimated: !!options.isAnimated,
            animatedLabel: options.animatedLabel,
            sourceUrl: options.sourceUrl,
            showDomain: options.showDomain !== false,
            placeholderClass
        };

        if (options.isPlaceholder) {
            showPlaceholder(shared);
        } else if (options.isVideoThumb) {
            options.appendVideo(host, () => showPlaceholder(shared));
        } else {
            const img = doc.createElement('img');
            img.loading = 'eager';
            img.decoding = 'async';
            // Off-screen pad cells yield to everything else; cells the user can
            // see should not queue behind the full-size preloads of neighbours.
            img.fetchPriority = options.active ? 'high' : (options.visible === false ? 'low' : 'auto');
            img.referrerPolicy = 'no-referrer';
            img.onload = () => img.classList.add('ms-loaded');
            img.onerror = () => {
                if (img.parentNode === host && !host.classList.contains(placeholderClass)) showPlaceholder(shared);
            };
            options.loadImage(img);
            if (img.complete && img.naturalWidth) img.classList.add('ms-loaded');
            host.appendChild(img);
        }

        appendTypeBadge({
            document: doc,
            host,
            isVideo: !!options.isVideo,
            isAnimated: !!options.isAnimated,
            animatedLabel: options.animatedLabel
        });
        lockThumbnailFill(host);

        if (options.indexLabel !== undefined) {
            const index = doc.createElement('div');
            index.className = 'ms-grid-idx';
            index.textContent = String(options.indexLabel);
            host.appendChild(index);
        }
        return host;
    }

    function ensureMediaBox(doc, wrap) {
        if (!wrap) return null;
        let box = wrap.querySelector(':scope > .ms-media-box');
        if (!box) {
            box = doc.createElement('div');
            box.className = 'ms-media-box';
            wrap.insertBefore(box, wrap.firstChild);
        }
        return box;
    }

    function prepareMediaSlot(options) {
        const wrap = options.wrap;
        const item = options.item;
        if (!wrap) return false;
        // Retiring once avoids resetting a decoder here and then resetting it a
        // second time when the runtime replaces the old player and its listeners.
        const keepVideo = null;
        wrap.querySelectorAll('video, audio').forEach((element) => {
            if (element === keepVideo) return;
            // The runtime keeps its stage videos for the whole session and parks
            // them between items; destroying one here would only make it build
            // another, which is the thing the pool exists to avoid.
            if (typeof options.retireVideo === 'function' && options.retireVideo(element)) return;
            try {
                element.pause();
                element.removeAttribute('src');
                element.load();
            } catch (error) { }
            element.remove();
        });
        wrap.querySelectorAll('iframe, .ms-btn-expand-album, .ms-resolve-loading, .ms-media-error-banner, .ms-iframe-shield, .ms-caption-overlay')
            .forEach((element) => element.remove());

        if (keepVideo) {
            try {
                keepVideo.pause();
                keepVideo.removeAttribute('src');
                keepVideo.removeAttribute('poster');
                keepVideo.load();
            } catch (error) { }
            keepVideo.classList.remove('ms-ready');
            keepVideo.style.opacity = '0';
            wrap.querySelectorAll('img').forEach((element) => element.remove());
            ensureMediaBox(options.document || document, wrap).appendChild(keepVideo);
            return false;
        }
        if (item && item.type === 'video') {
            wrap.replaceChildren();
            return false;
        }
        const keepStill = !!(item && item.type === 'img' && !item.needsResolve
            && wrap.querySelector('img.ms-media:not(.ms-loading-thumb)'));
        if (!keepStill) {
            wrap.replaceChildren();
            return false;
        }
        wrap.querySelectorAll('img.ms-loading-thumb').forEach((element) => element.remove());
        const keepBox = wrap.querySelector(':scope > .ms-media-box');
        Array.from(wrap.children).forEach((element) => { if (element !== keepBox) element.remove(); });
        if (keepBox) Array.from(keepBox.children).forEach((element, index) => { if (index > 0) element.remove(); });
        return true;
    }

    function warningIcon(size) {
        return '<svg style="width:' + size + 'px;height:' + size + 'px;vertical-align:middle;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    }

    function renderErrorBanner(options) {
        if (!options.container || !options.message) return null;
        const doc = options.document || document;
        const banner = doc.createElement('div');
        banner.className = 'ms-media-error-banner';
        banner.innerHTML = '<span>' + warningIcon(14) + '</span>';
        const message = doc.createElement('span');
        message.textContent = options.message;
        banner.appendChild(message);
        options.container.appendChild(banner);
        return banner;
    }

    function renderErrorStage(options) {
        const container = options.container;
        if (!container) return null;
        const doc = options.document || document;
        container.replaceChildren();

        const stage = doc.createElement('div');
        stage.className = 'ms-media-error-stage';
        const icon = doc.createElement('span');
        icon.innerHTML = warningIcon(32);
        const message = doc.createElement('div');
        message.className = 'ms-media-error-message';
        message.textContent = options.message || 'Failed to load media';
        const url = doc.createElement('div');
        url.className = 'ms-media-error-url';
        url.textContent = 'URL: ' + (options.url || '');
        stage.append(icon, message, url);

        if (options.canRetry) {
            const retry = doc.createElement('button');
            retry.type = 'button';
            retry.className = 'ms-retry-btn';
            retry.textContent = 'Retry';
            retry.addEventListener('click', (event) => {
                event.stopPropagation();
                if (typeof options.onRetry === 'function') options.onRetry();
            });
            stage.appendChild(retry);
        }
        container.appendChild(stage);
        return stage;
    }

    function createLoadingPreview(options) {
        const doc = options.document || document;
        const image = doc.createElement('img');
        image.className = 'ms-media ms-loading-thumb';
        image.referrerPolicy = 'no-referrer';
        image.src = options.src;
        if (typeof options.onLoad === 'function') image.addEventListener('load', () => options.onLoad(image));
        return image;
    }

    function createImageMedia(options) {
        const doc = options.document || document;
        const image = doc.createElement('img');
        image.className = options.className || 'ms-media ms-ready';
        image.referrerPolicy = 'no-referrer';
        if (options.src) image.src = options.src;
        if (typeof options.onLoad === 'function') image.addEventListener('load', () => options.onLoad(image), { once: true });
        return image;
    }

    function createResolveIndicator(doc) {
        const indicator = doc.createElement('div');
        indicator.className = 'ms-resolve-loading';
        indicator.innerHTML = '<div class="ms-resolve-spinner"></div><div class="ms-resolve-text">Resolving high-res...</div>';
        return indicator;
    }

    function configureVideoElement(options) {
        const video = options.video || (options.document || document).createElement('video');
        video.className = 'ms-media';
        video.controls = true;
        video.playsInline = true;
        video.referrerPolicy = 'no-referrer';
        video.removeAttribute('poster');
        if (options.poster) video.poster = options.poster;
        video.style.opacity = options.poster ? '1' : '0';
        video.classList.remove('ms-ready');
        video.volume = options.volume;
        video.muted = options.muted;
        video.loop = options.loop;
        if (options.preload) video.preload = options.preload;
        return video;
    }

    function createIframeMedia(options) {
        const doc = options.document || document;
        const iframe = doc.createElement('iframe');
        iframe.className = 'ms-media ms-ready';
        iframe.src = options.src;
        iframe.allowFullscreen = true;
        iframe.referrerPolicy = 'origin';
        iframe.setAttribute('width', '100%');
        iframe.setAttribute('height', '100%');
        if (typeof options.onLoad === 'function') iframe.addEventListener('load', options.onLoad, { once: true });
        return iframe;
    }

    function createIframeShield(options = {}) {
        const doc = options.document || document;
        const shield = doc.createElement('div');
        shield.className = 'ms-iframe-shield';
        shield.addEventListener('click', () => {
            shield.style.pointerEvents = 'none';
            setTimeout(() => {
                shield.style.pointerEvents = 'auto';
                if (typeof options.onRelease === 'function') options.onRelease();
            }, options.releaseDelay || 2000);
        });
        return shield;
    }

    function createExpandButton(options) {
        const doc = options.document || document;
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'ms-btn ms-btn-expand-album';
        button.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><span></span>';
        const label = button.querySelector('span');
        label.textContent = options.label || 'Expand album';
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            button.disabled = true;
            label.textContent = options.pendingLabel || 'Expanding…';
            if (typeof options.onExpand === 'function') options.onExpand();
        });
        return button;
    }

    function renderPosition(options) {
        const current = Math.max(0, Number(options.currentIndex) || 0);
        const length = Math.max(0, Number(options.length) || 0);
        if (options.counter) options.counter.textContent = (current + 1) + ' / ' + length;
        const disabled = length <= 1;
        if (options.previous) options.previous.disabled = disabled;
        if (options.next) options.next.disabled = disabled;
    }

    const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
    const SHA_RE = /^[a-f0-9]{64}$/;

    const CORE_MANIFEST_URL = 'https://github.com/loliXn/xg-core/releases/latest/download/latest.json';
    const CORE_UPDATE_INTERVAL_MS = 0; // check GitHub latest.json on every load

    function parseCoreManifest(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new TypeError('manifest must be an object');
        }
        const version = String(data.version || '').trim();
        const url = String(data.url || '').trim();
        const sha256 = String(data.sha256 || '').trim().toLowerCase();
        if (!VERSION_RE.test(version)) throw new TypeError('manifest version is invalid');
        if (!/^https:\/\//i.test(url)) throw new TypeError('manifest url must be https');
        if (!SHA_RE.test(sha256)) throw new TypeError('manifest sha256 is invalid');
        if (!isTrustedCoreUrl(url)) throw new TypeError('manifest url is not a trusted core host');
        return { version: version, url: url, sha256: sha256 };
    }

    function compareCoreVersions(a, b) {
        const pa = String(a || '').split('.').map((part) => parseInt(part, 10) || 0);
        const pb = String(b || '').split('.').map((part) => parseInt(part, 10) || 0);
        for (let i = 0; i < 3; i++) {
            if (pa[i] > pb[i]) return 1;
            if (pa[i] < pb[i]) return -1;
        }
        return 0;
    }

    function isTrustedCoreUrl(url) {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:') return false;
            if (parsed.hostname === 'cdn.jsdelivr.net') {
                return /\/gh\/loliXn\/xg-core@v?\d+\.\d+\.\d+\//i.test(parsed.pathname);
            }
            if (parsed.hostname === 'github.com') {
                return parsed.pathname.indexOf('/loliXn/xg-core/') === 0;
            }
            if (parsed.hostname === 'objects.githubusercontent.com' || parsed.hostname === 'release-assets.githubusercontent.com') {
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function bytesToSha256Hex(buffer) {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
        return hex;
    }

    async function sha256Hex(source) {
        const cryptoApi = globalThis.crypto && globalThis.crypto.subtle;
        if (!cryptoApi || typeof cryptoApi.digest !== 'function') {
            throw new Error('Web Crypto SHA-256 is unavailable');
        }
        const bytes = typeof source === 'string'
            ? new TextEncoder().encode(source)
            : (source instanceof Uint8Array ? source : new Uint8Array(source));
        const digest = await cryptoApi.digest('SHA-256', bytes);
        return bytesToSha256Hex(digest);
    }

    function shouldInstallCore(currentVersion, nextVersion) {
        return compareCoreVersions(nextVersion, currentVersion) > 0;
    }

    function verifiedCoreRecord(manifest, code, sha256) {
        if (!manifest || manifest.sha256 !== sha256) return null;
        if (typeof code !== 'string' || !code.includes('XGalleryCore')) return null;
        return {
            version: manifest.version,
            url: manifest.url,
            sha256: sha256,
            code: code
        };
    }

    // Mount hidden but fully laid out, then drop the class on the next frame so
    // the transition runs. Toggling straight out of display:none cannot animate.
    function revealOnNextFrame(el, className) {
        if (!el || !className) return;
        const view = el.ownerDocument && el.ownerDocument.defaultView;
        if (view && view.matchMedia && view.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        el.classList.add(className);
        // Reading layout commits the hidden starting style, so removing the class
        // afterwards transitions whether that happens on a frame or a timer.
        void el.offsetWidth;
        let done = false;
        const reveal = () => {
            if (done) return;
            done = true;
            el.classList.remove(className);
        };
        // requestAnimationFrame is paused in background tabs and undrawn views;
        // content must never be left invisible waiting for a frame.
        if (view && view.requestAnimationFrame) view.requestAnimationFrame(reveal);
        setTimeout(reveal, 50);
    }

    // Rapid navigation (held arrow keys) re-renders the panel faster than a fade
    // can finish; fading each step would read as flicker, so only settled
    // changes animate.
    const POST_ENTER_MIN_GAP_MS = 180;

    const REPOST_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>';

    function panelElement(doc, tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = String(text);
        return node;
    }

    function panelLinks(root) {
        root.querySelectorAll('a').forEach(link => {
            if (!/^(https?:|\/|#)/i.test(link.getAttribute('href') || '')) link.removeAttribute('href');
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.addEventListener('click', e => e.stopPropagation());
        });
    }

    function panelHtml(doc, html, className) {
        const node = panelElement(doc, 'div', className);
        node.innerHTML = html || '';
        node.querySelectorAll('script,style,iframe,object,embed,form').forEach(el => el.remove());
        node.querySelectorAll('*').forEach(el => {
            Array.from(el.attributes).forEach(attr => {
                if (/^on/i.test(attr.name) || attr.name === 'style' || attr.name === 'id') el.removeAttribute(attr.name);
            });
            if (el.hasAttribute('class')) {
                const owned = Array.from(el.classList).filter(name => name.startsWith('ms-'));
                if (owned.length) el.className = owned.join(' ');
                else el.removeAttribute('class');
            }
        });
        panelLinks(node);
        return node;
    }

    // No class attributes inside these: panelHtml rewrites element.className,
    // which is read-only on SVG nodes.
    const ATTACHMENT_ICONS = {
        image: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 5"/></svg>',
        video: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>',
        audio: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
        archive: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M3 3h18v4H3z"/><path d="M11 11h2v3h-2z"/></svg>',
        document: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/></svg>',
        design: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.1 0-1 .8-1.7 1.8-1.7H16a5 5 0 0 0 5-5c0-4-4-7.3-9-7.3z"/><circle cx="7.5" cy="11.5" r="1.1"/><circle cx="11" cy="7.5" r="1.1"/><circle cx="15.5" cy="9.5" r="1.1"/></svg>',
        link: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1"/></svg>',
        file: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>'
    };
    const ATTACHMENT_DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/></svg>';

    function renderPostPanel(options) {
        const { content, model } = options;
        const doc = content.ownerDocument;
        const previousScrollTop = options.preserveState ? content.scrollTop : 0;
        const wasLoading = content.dataset.msPostLoading === '1';
        const isLoading = !!model.loading;
        const now = Date.now();
        const lastRender = Number(content.dataset.msPostRenderedAt || 0);
        content.dataset.msPostLoading = isLoading ? '1' : '';
        content.dataset.msPostRenderedAt = String(now);
        content.replaceChildren();
        const panel = panelElement(doc, 'div', 'ms-post-panel');
        const body = panelElement(doc, 'div', 'ms-post-body');
        content.append(panel);
        panel.append(body);
        // One link covers avatar and name, so both react together, both open the
        // profile, and it is a single tab stop. A user without a profile URL gets
        // no link at all and does not react.
        const user = (data, small = false) => {
            const row = panelElement(doc, small ? 'span' : 'div', 'ms-info-user' + (small ? ' ms-info-user-sm' : ''));
            const target = data.profileUrl ? panelElement(doc, 'a', 'ms-info-user-link') : row;
            if (data.profileUrl) { target.href = data.profileUrl; row.append(target); }
            if (data.avatarUrl) {
                const avatar = panelElement(doc, 'img', 'ms-info-desc-avatar');
                avatar.src = data.avatarUrl;
                avatar.alt = '';
                avatar.referrerPolicy = 'no-referrer';
                target.append(avatar);
            }
            target.append(panelElement(doc, 'span', 'ms-info-desc-username', data.username || data.name || '\u00a0'));
            panelLinks(row);
            return row;
        };
        const info = model.postInfo || {};
        if (info.author || model.reserveHeader) {
            // Read like a message header: who, when, and where it came from.
            const head = panelElement(doc, 'div', 'ms-info-posthead');
            const byline = panelElement(doc, 'div', 'ms-post-byline');
            byline.append(user(info.author || {}));
            const date = panelElement(doc, 'span', 'ms-info-postmeta', info.time || (model.reserveHeader ? '\u00a0' : ''));
            if (info.time) date.title = info.time;
            byline.append(date);
            head.append(byline);
            if (info.repostedFrom) {
                const repost = panelElement(doc, 'div', 'ms-post-repost');
                const icon = panelElement(doc, 'span', 'ms-post-repost-icon');
                icon.innerHTML = REPOST_ICON;
                repost.append(icon, panelElement(doc, 'span', 'ms-post-repost-label', 'reposted from'), user(info.repostedFrom, true));
                head.append(repost);
            }
            panel.insertBefore(head, body);
        }
        const captions = Array.isArray(info.captions) && info.captions.length ? info.captions : [{ html: model.description }];
        const caption = panelElement(doc, 'div', 'ms-panel-caption');
        captions.forEach(cap => {
            if (!cap.html) return;
            const card = panelHtml(doc, cap.html, 'ms-info-description');
            if (cap.user && !(captions.length === 1 && info.author && cap.user.username === info.author.username)) {
                card.classList.add('ms-info-description-attributed');
                card.prepend(user(cap.user, true));
            }
            caption.append(card);
        });
        if (caption.childNodes.length) body.append(caption);
        // A post's attachments, read the way an email lists them: a row each, with
        // a type icon, the name, and a second line naming the type (and size, when
        // the site says). An adapter passes data; the markup lives here so every
        // adapter gets the same strip.
        //   { name, href, meta?, kind?, downloadHref?, downloadLabel?, title? }
        if (Array.isArray(model.attachments) && model.attachments.length) {
            const section = panelElement(doc, 'section', 'ms-post-section ms-post-attachments');
            const count = model.attachments.length;
            section.append(panelElement(doc, 'div', 'ms-info-tags-label',
                count === 1 ? '1 attachment' : count + ' attachments'));
            const list = panelElement(doc, 'div', 'ms-att-list');
            model.attachments.forEach(attachment => {
                if (!attachment || !attachment.href) return;
                const row = panelElement(doc, 'div', 'ms-att-row');
                const main = panelElement(doc, 'a', 'ms-att-main');
                main.href = attachment.href;
                main.target = '_blank';
                main.rel = 'noopener noreferrer';
                if (attachment.title) main.title = attachment.title;
                const icon = panelElement(doc, 'span', 'ms-att-icon');
                icon.innerHTML = ATTACHMENT_ICONS[attachment.kind] || ATTACHMENT_ICONS.file;
                const text = panelElement(doc, 'span', 'ms-att-text');
                text.append(panelElement(doc, 'span', 'ms-att-name', attachment.name || attachment.href));
                if (attachment.meta) text.append(panelElement(doc, 'span', 'ms-att-meta', attachment.meta));
                main.append(icon, text);
                main.addEventListener('click', event => {
                    event.stopPropagation();
                    if (attachment.onOpen) { event.preventDefault(); attachment.onOpen(); }
                });
                row.append(main);
                // An attachment opened in an editor still needs a plain way down to
                // the file itself.
                if (attachment.downloadHref) {
                    const download = panelElement(doc, 'a', 'ms-att-dl');
                    download.href = attachment.downloadHref;
                    download.target = '_blank';
                    download.rel = 'noopener noreferrer';
                    const label = attachment.downloadLabel || ('Download ' + (attachment.name || 'file'));
                    download.title = label;
                    download.setAttribute('aria-label', label);
                    download.innerHTML = ATTACHMENT_DOWNLOAD_ICON;
                    download.addEventListener('click', event => event.stopPropagation());
                    row.append(download);
                }
                list.append(row);
            });
            if (list.childNodes.length) {
                section.append(list);
                body.append(section);
            }
        }
        const appendTags = (label, tags, profileUrl = '') => {
            if (!tags || !tags.length) return;
            const tagsSection = panelElement(doc, 'section', 'ms-post-section ms-post-tags');
            const heading = panelElement(doc, 'div', 'ms-info-tags-label');
            if (profileUrl) {
                const owner = panelElement(doc, 'a', 'ms-tag-group-owner', label);
                owner.href = profileUrl;
                heading.append(owner, doc.createTextNode(' tags'));
                panelLinks(heading);
            } else heading.textContent = label;
            tagsSection.append(heading);
            const pills = panelElement(doc, 'div', 'ms-tag-pills');
            tags.forEach((tag, index) => {
                const link = panelElement(doc, 'a', 'ms-tag-pill', '#' + tag.label);
                if (index >= 18) {
                    link.classList.add('ms-tag-overflow');
                    link.hidden = true;
                }
                if (tag.category) link.classList.add('ms-tag-pill-' + tag.category);
                link.href = tag.href || '#';
                link.target = tag.onClick ? '_self' : '_blank';
                link.rel = 'noopener noreferrer';
                link.addEventListener('click', e => { e.stopPropagation(); if (tag.onClick) { e.preventDefault(); tag.onClick(); } });
                if (tag.onContext) {
                    link.title = 'Right-click to blacklist this tag';
                    link.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); tag.onContext(); });
                }
                pills.append(link);
            });
            if (tags.length > 18) {
                const more = panelElement(doc, 'button', 'ms-tag-more', '+' + (tags.length - 18) + ' more');
                more.type = 'button';
                more.setAttribute('aria-expanded', 'false');
                more.addEventListener('click', event => {
                    event.stopPropagation();
                    const expanded = more.getAttribute('aria-expanded') === 'true';
                    pills.querySelectorAll('.ms-tag-overflow').forEach(tag => { tag.hidden = expanded; });
                    more.setAttribute('aria-expanded', String(!expanded));
                    more.textContent = expanded ? '+' + (tags.length - 18) + ' more' : 'Show less';
                });
                pills.append(more);
            }
            tagsSection.append(pills);
            body.append(tagsSection);
        };
        if (model.tagGroups && model.tagGroups.length) {
            model.tagGroups.forEach(group => appendTags(group.owner || 'Tags', group.tags, group.profileUrl));
        } else if (model.tags && model.tags.length) {
            appendTags('Tags', model.tags);
        }
        const context = panelElement(doc, 'div', 'ms-post-context');
        if (info.originalPost && info.originalPost.username) {
            const original = panelElement(doc, 'div', 'ms-info-original', 'Originally posted by ');
            original.append(user({ ...info.originalPost, profileUrl: info.originalPost.url }, true));
            context.append(original);
        }
        if (info.stats) {
            const stats = panelElement(doc, 'div', 'ms-info-stats');
            for (const [key, label] of [['views', 'views'], ['reposts', 'reposts']]) {
                if (!info.stats[key]) continue;
                const stat = panelElement(doc, 'span', 'ms-info-stat');
                stat.append(panelElement(doc, 'b', '', info.stats[key]), doc.createTextNode(' ' + label));
                stats.append(stat);
            }
            if (stats.childNodes.length) context.append(stats);
        }
        if (context.childNodes.length) body.append(context);
        const footer = panelElement(doc, 'div', 'ms-post-footer');
        if (model.actions && model.actions.length) {
            const actions = panelElement(doc, 'div', 'ms-tags-actions-bar');
            model.actions.forEach(action => {
                const button = panelElement(doc, action.href ? 'a' : 'button', 'ms-tags-action-btn ms-tags-' + action.kind + '-btn');
                if (!action.href) button.type = 'button';
                else { button.href = action.href; button.target = '_blank'; button.rel = 'noopener noreferrer'; }
                if (action.kind === 'like') {
                    const icon = panelElement(doc, 'span', 'ms-tags-action-icon');
                    icon.innerHTML = HEART_ICON;
                    button.append(icon);
                }
                button.append(panelElement(doc, 'span', 'ms-tags-action-label', action.label));
                button.classList.toggle('active', !!action.active);
                button.setAttribute('aria-label', action.label);
                if (action.count != null && action.count !== '') button.append(panelElement(doc, 'span', 'ms-tags-like-count', action.count));
                button.addEventListener('click', e => { e.stopPropagation(); if (action.run) action.run(button); });
                if (action.hydrate) Promise.resolve(action.hydrate()).then(active => {
                    if (button.isConnected) button.classList.toggle('active', !!active);
                }).catch(() => {});
                actions.append(button);
            });
            footer.append(actions);
        }
        if (options.captionControls) {
            const modes = panelElement(doc, 'div', 'ms-caption-footer');
            modes.setAttribute('role', 'group');
            modes.setAttribute('aria-label', 'Caption display');
            modes.append(panelElement(doc, 'span', 'ms-caption-mode-label', 'Caption'));
            options.captionControls(modes);
            if (modes.childNodes.length > 1) footer.append(modes);
        }
        if (footer.childNodes.length) panel.append(footer);
        if (!body.childNodes.length && isLoading) {
            // Details are still on their way: hold the space with a quiet
            // placeholder instead of claiming there is nothing to show.
            const skeleton = panelElement(doc, 'div', 'ms-post-skeleton');
            skeleton.setAttribute('aria-label', 'Loading post details');
            skeleton.setAttribute('role', 'status');
            ['ms-skel-line ms-skel-wide', 'ms-skel-line', 'ms-skel-line ms-skel-short', 'ms-skel-chips'].forEach(cls => skeleton.append(panelElement(doc, 'span', cls)));
            body.append(skeleton);
        } else if (!body.childNodes.length) {
            body.append(panelElement(doc, 'div', 'ms-info-empty', 'No description or tags available.'));
        }
        // Resolution and size of what is on screen. Filled in by the runtime once the
        // media has decoded; the row keeps its height while empty so nothing moves.
        if (model.mediaMeta) {
            const meta = panelElement(doc, 'div', 'ms-info-meta ms-post-media-meta');
            meta.append(panelElement(doc, 'span', 'ms-info-dims'), panelElement(doc, 'span', 'ms-info-bytes'));
            body.append(meta);
        }
        // A different post, or the same post's details arriving: settle the body in.
        // The header and footer stay put so nothing around the text jumps.
        const arrived = options.preserveState && wasLoading && !isLoading;
        const newPost = !options.preserveState && now - lastRender > POST_ENTER_MIN_GAP_MS;
        if (arrived || newPost) revealOnNextFrame(body, 'ms-post-entering');
        if (options.preserveState) requestAnimationFrame(() => {
            if (content.isConnected) content.scrollTop = previousScrollTop;
        });
        else content.scrollTop = 0;
    }

    function createSettingsPanel(options) {
        const doc = options.document || document;
        if (doc.getElementById('ms-settings-root')) return null;
        const previousFocus = doc.activeElement;
        const host = doc.createElement('xgallery-settings');
        host.id = 'ms-settings-root';
        host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;visibility:visible!important;pointer-events:auto!important;';
        const shadow = host.attachShadow({mode:'open'});
        const sheet = doc.createElement('style');
        // Same reason as the gallery overlay's sheet (see view.js): Dark Reader
        // rewrites stylesheets inside open shadow roots and turns our white-alpha
        // hairlines dark, and its style manager skips any sheet carrying this
        // class. Shadow sheets only - it removes .darkreader nodes from the light
        // DOM when it is switched off, and does not search shadow roots.
        sheet.className = 'darkreader';
        sheet.textContent = OVERLAY_CSS;
        shadow.append(sheet);
        const overlay = panelElement(doc, 'div', 'ms-r34-settings-overlay');
        overlay.id = 'ms-r34-settings-overlay';
        const modal = panelElement(doc, 'div', 'ms-r34-settings-modal');
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
        const heading = panelElement(doc, 'div', 'ms-settings-head');
        heading.append(panelElement(doc, 'h3', '', 'Gallery Settings'));
        const close = panelElement(doc, 'button', 'ms-settings-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close');
        heading.append(close); modal.append(heading);
        const body = panelElement(doc, 'div', 'ms-settings-body');
        const tabs = panelElement(doc, 'div', 'ms-settings-tabs');
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', 'Settings category');
        const names = [...new Set(options.sections.map(section => section.tab || 'General'))];
        const groups = new Map();
        // The tab key is the caller's string, but a bare hostname is a poor label;
        // www. adds nothing the user needs to read.
        const tabLabel = (name) => String(name).replace(/^www\./i, '');
        names.forEach((name, index) => {
            const tab = panelElement(doc, 'button', 'ms-settings-tab', tabLabel(name));
            tab.type = 'button'; tab.setAttribute('role', 'tab');
            tab.id = 'ms-settings-tab-' + index;
            tab.setAttribute('aria-controls', 'ms-settings-page-' + index);
            const group = panelElement(doc, 'div', 'ms-settings-page');
            group.id = 'ms-settings-page-' + index;
            group.setAttribute('role', 'tabpanel'); group.setAttribute('aria-labelledby', tab.id);
            group.hidden = index !== 0;
            tab.tabIndex = index ? -1 : 0; tab.setAttribute('aria-selected', String(!index));
            tab.addEventListener('click', () => {
                groups.forEach(({tab: other, group: pane}, key) => {
                    pane.hidden = key !== name; other.tabIndex = key === name ? 0 : -1;
                    other.setAttribute('aria-selected', String(key === name));
                });
            });
            tab.addEventListener('keydown', event => {
                if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? names.length - 1 :
                    (index + (event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length;
                const target = groups.get(names[next]).tab; target.click(); target.focus();
            });
            groups.set(name, {tab, group}); tabs.append(tab); body.append(group);
        });
        modal.append(tabs);
        const controls = new Map();
        options.sections.forEach(section => {
            const sectionBody = groups.get(section.tab || 'General').group;
            sectionBody.append(panelElement(doc, 'div', 'ms-settings-section-group', section.label));
            const card = panelElement(doc, 'div', 'ms-settings-card');
            section.fields.forEach(field => {
                const row = panelElement(doc, 'div', 'ms-settings-row' + (field.type === 'textarea' ? ' ms-settings-stack' : ''));
                const label = panelElement(doc, 'label', 'ms-settings-label', field.label);
                let note = null;
                if (field.note) {
                    note = panelElement(doc, 'small', '', field.note);
                    label.append(doc.createElement('br'), note);
                }
                row.append(label);
                let input;
                if (field.type === 'button') {
                    input = panelElement(doc, 'button', '', field.buttonLabel || field.label); input.type = 'button';
                    input.addEventListener('click', async () => {
                        input.disabled = true;
                        input.classList.remove('is-success', 'is-error');
                        input.classList.add('is-busy');
                        const original = input.textContent;
                        input.textContent = field.busyLabel || 'Working…';
                        try {
                            const result = await field.run();
                            if (result && typeof result === 'object') {
                                input.textContent = result.buttonLabel || original;
                                if (note && result.note) note.textContent = result.note;
                                input.classList.add(result.ok === false ? 'is-error' : 'is-success');
                            } else if (result) {
                                input.textContent = result;
                                input.classList.add('is-success');
                            } else input.textContent = original;
                        }
                        catch {
                            input.textContent = 'Try again';
                            input.classList.add('is-error');
                        }
                        finally { input.disabled = false; input.classList.remove('is-busy'); }
                    });
                } else if (field.type === 'select') {
                    input = doc.createElement('select');
                    field.options.forEach(([value, text]) => { const option = panelElement(doc, 'option', '', text); option.value = value; input.append(option); });
                    input.value = field.value;
                } else if (field.type === 'checkbox') {
                    const toggle = panelElement(doc, 'label', 'ms-toggle');
                    input = doc.createElement('input'); input.type = 'checkbox'; input.checked = !!field.value;
                    const track = panelElement(doc, 'span', 'ms-toggle-track'); track.append(panelElement(doc, 'span', 'ms-toggle-thumb'));
                    toggle.append(input, track); row.append(toggle);
                } else if (field.type === 'color') {
                    // Preset swatches, a custom colour and Reset. onInput previews
                    // live while the dialog is open; the value is saved like any field.
                    const picker = panelElement(doc, 'div', 'ms-accent-picker');
                    picker.setAttribute('role', 'group');
                    picker.setAttribute('aria-label', field.label);
                    input = doc.createElement('input');
                    input.type = 'color';
                    input.value = field.value || field.defaultValue || '#000000';
                    const swatches = (field.presets || []).map(([name, value]) => {
                        const swatch = panelElement(doc, 'button', 'ms-accent-swatch');
                        swatch.type = 'button';
                        swatch.title = name;
                        swatch.setAttribute('aria-label', name);
                        swatch.dataset.value = String(value).toLowerCase();
                        const dot = panelElement(doc, 'span', 'ms-accent-swatch-dot');
                        dot.style.background = value;
                        swatch.append(dot);
                        return swatch;
                    });
                    const paintSwatches = () => swatches.forEach((swatch) =>
                        swatch.setAttribute('aria-pressed', String(swatch.dataset.value === input.value.toLowerCase())));
                    const emit = () => { paintSwatches(); if (field.onInput) field.onInput(input.value); };
                    swatches.forEach((swatch) => swatch.addEventListener('click', () => { input.value = swatch.dataset.value; emit(); }));
                    input.addEventListener('input', emit);
                    const reset = panelElement(doc, 'button', 'ms-accent-reset', 'Reset');
                    reset.type = 'button';
                    reset.addEventListener('click', () => { input.value = field.defaultValue || input.value; emit(); });
                    picker.append(...swatches, input, reset);
                    row.append(picker);
                    paintSwatches();
                } else {
                    input = doc.createElement(field.type === 'textarea' ? 'textarea' : 'input');
                    if (field.type === 'textarea') input.className = 'ms-settings-textarea';
                    else input.type = field.type || 'text';
                    input.value = field.value == null ? '' : field.value;
                    for (const key of ['min', 'max', 'step', 'placeholder']) if (field[key] != null) input[key] = field[key];
                }
                input.id = field.id; label.htmlFor = field.id;
                if (field.type !== 'checkbox' && field.type !== 'color') row.append(input);
                if (field.onChange) input.addEventListener('change', () => field.onChange(field.type === 'checkbox' ? input.checked : input.value));
                controls.set(field.id, { input, field });
                if (field.suggestions) {
                    const pills = panelElement(doc, 'div', 'ms-blacklist-pills');
                    const lines = () => input.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
                    const paint = () => pills.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(lines().some(v => v.toLowerCase() === button.dataset.tag.toLowerCase()))));
                    field.suggestions.forEach(tag => {
                        const pill = panelElement(doc, 'button', 'ms-blacklist-pill', '#' + tag); pill.type = 'button'; pill.dataset.tag = tag;
                        pill.addEventListener('click', () => { const values = lines(); const i = values.findIndex(v => v.toLowerCase() === tag.toLowerCase()); if (i < 0) values.push(tag); else values.splice(i, 1); input.value = values.join('\n'); paint(); });
                        pills.append(pill);
                    });
                    input.addEventListener('input', paint); row.append(pills); paint();
                }
                card.append(row);
            });
            sectionBody.append(card);
        });
        modal.append(body);
        const footer = panelElement(doc, 'div', 'ms-r34-btn-row');
        const cancel = panelElement(doc, 'button', 'ms-r34-cancel', 'Cancel');
        const save = panelElement(doc, 'button', 'ms-r34-save', 'Save');
        cancel.type = save.type = 'button'; footer.append(cancel, save); modal.append(footer); overlay.append(modal);
        const dismiss = () => {
            host.remove();
            if (previousFocus && previousFocus.isConnected) previousFocus.focus({preventScroll:true});
            if (options.onClose) options.onClose(overlay);
        };
        close.addEventListener('click', dismiss); cancel.addEventListener('click', dismiss);
        overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(); });
        overlay.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
            if (e.key === 'Tab') {
                const targets = Array.from(modal.querySelectorAll('button,input,select,textarea,a[href]')).filter(el => !el.disabled && el.getClientRects().length);
                const first = targets[0], last = targets[targets.length-1];
                if (e.shiftKey && shadow.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && shadow.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        });
        save.addEventListener('click', () => {
            const values = {};
            controls.forEach(({input,field}, id) => { if (field.type !== 'button') values[id] = field.type === 'checkbox' ? input.checked : input.value; });
            options.onSave(values); dismiss();
        });
        shadow.append(overlay);
        doc.body.append(host);
        // Every page gets the height of the tallest one, so switching tabs cannot
        // resize the dialog. Measured after the host is in the document, because
        // a detached subtree has no layout; done synchronously rather than on a
        // frame, since a settings panel opened from a click is always foreground
        // and a resize one frame later would be visible.
        try {
            let tallest = 0;
            groups.forEach(({group}) => {
                const wasHidden = group.hidden;
                if (wasHidden) group.hidden = false;
                tallest = Math.max(tallest, group.scrollHeight);
                if (wasHidden) group.hidden = true;
            });
            if (tallest > 0) {
                groups.forEach(({group}) => { group.style.minHeight = tallest + 'px'; });
            }
        } catch (error) { }
        requestAnimationFrame(() => { overlay.classList.add('ms-settings-open'); close.focus(); });
        return overlay;
    }

    // Shared viewer behavior. Host operations and persisted preferences enter through the bridge.
    function createViewerRuntime(bridge) {
    function protectHostControl(button, compact) {
        const values = {appearance:'none',background:'#191b20',color:'#e7e8eb',border:'1px solid rgba(255,255,255,.24)','border-radius':compact?'8px':'10px',font:'600 12px/1 system-ui, sans-serif','text-shadow':'none','box-shadow':'0 2px 8px rgba(0,0,0,.25)','text-transform':'none',opacity:'1',filter:'none','backdrop-filter':'none','box-sizing':'border-box'};
        for (const [key,value] of Object.entries(values)) button.style.setProperty(key,value,'important');
        if (button.dataset.msProtectedHover !== '1') {
            button.dataset.msProtectedHover = '1';
            const rest = () => {
                button.style.setProperty('background', '#191b20', 'important');
                button.style.setProperty('border-color', 'rgba(255,255,255,.24)', 'important');
            };
            const hover = () => {
                if (button.disabled) return;
                button.style.setProperty('background', '#292c31', 'important');
                button.style.setProperty('border-color', 'rgba(255,255,255,.34)', 'important');
            };
            const press = () => {
                if (!button.disabled) button.style.setProperty('background', '#32353a', 'important');
            };
            button.addEventListener('pointerenter', hover);
            button.addEventListener('pointerleave', rest);
            button.addEventListener('focus', hover);
            button.addEventListener('blur', rest);
            button.addEventListener('pointerdown', press);
            button.addEventListener('pointerup', hover);
        }
    }
    // Rank, not call order: addSiteGalleryButton creates Gallery before the
    // auxiliary button exists, but the auxiliary button has to render leftmost -
    // and CSS order cannot be used, because the seam and the clipped outer corners
    // both key off real DOM order.
    const LAUNCHER_SLOT_ORDER = {aux:10, settings:20, gallery:30};

    // The cluster carries the visible chrome, so it is the thing that needs the
    // shield protectHostControl used to put on each button: inline !important beats
    // a host sheet appended after ours, which author !important does not.
    function protectHostCluster(cluster) {
        const values = {position:'fixed',display:'inline-flex','align-items':'stretch','box-sizing':'border-box',
            background:'#191b20',border:'1px solid rgba(255,255,255,.24)','border-radius':'10px',
            'box-shadow':'0 2px 8px rgba(0,0,0,.25)',overflow:'hidden',opacity:'1',filter:'none','backdrop-filter':'none',
            'z-index':'9999',top:'70px',right:'20px',left:'auto',bottom:'auto',margin:'0',padding:'0',
            'pointer-events':'auto',visibility:'visible',transform:'none'};
        for (const [key,value] of Object.entries(values)) cluster.style.setProperty(key,value,'important');
    }

    function ensureLauncherCluster() {
        let cluster=document.getElementById('ms-site-cluster');
        if(cluster&&cluster.isConnected)return cluster;
        if(!cluster){cluster=document.createElement('div');cluster.id='ms-site-cluster';}
        protectHostCluster(cluster);
        document.body.append(cluster);return cluster;
    }

    // Inline !important is the only thing that outranks a host sheet appended after
    // ours - but it also outranks our own stylesheet, so anything that changes
    // (the seam, hover, press) has to be written inline too. That is the mistake
    // this replaces: the CSS said there was a 1px seam and a hover fill, and the
    // inline shield silently won, so the buttons looked fused and dead.
    const CLUSTER_SEAM = '1px solid rgba(255,255,255,.24)';
    const CLUSTER_REST = 'transparent';
    const CLUSTER_HOVER = 'rgba(255,255,255,.10)';
    const CLUSTER_PRESS = 'rgba(255,255,255,.16)';

    function protectClusterButton(button) {
        const values = {appearance:'none','box-sizing':'border-box',position:'static',margin:'0',
            height:'36px','min-height':'36px','max-height':'36px',display:'inline-flex',
            'align-items':'center','justify-content':'center',gap:'6px',flex:'0 0 auto',
            border:'0','border-radius':'0',background:CLUSTER_REST,color:'#e7e8eb',
            font:'600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif','text-shadow':'none',
            'text-transform':'none','text-decoration':'none','white-space':'nowrap',
            opacity:'1',filter:'none','backdrop-filter':'none','box-shadow':'none',
            transition:'background-color 150ms cubic-bezier(0.4, 0, 0.2, 1)'};
        for (const [key,value] of Object.entries(values)) button.style.setProperty(key,value,'important');
        if (button.dataset.msClusterStates === '1') return;
        button.dataset.msClusterStates = '1';
        const paint = (value) => button.style.setProperty('background', value, 'important');
        button.addEventListener('pointerenter', () => { if (!button.disabled) paint(CLUSTER_HOVER); });
        button.addEventListener('pointerleave', () => paint(CLUSTER_REST));
        button.addEventListener('pointerdown', () => { if (!button.disabled) paint(CLUSTER_PRESS); });
        button.addEventListener('pointerup', () => { if (!button.disabled) paint(CLUSTER_HOVER); });
        button.addEventListener('blur', () => paint(CLUSTER_REST));
        button.addEventListener('focus', () => {
            // Keyboard focus only: a click already painted the hover fill, and
            // repainting it here would strand it after the pointer leaves.
            let visible = false;
            try { visible = button.matches(':focus-visible'); } catch (e) { }
            if (visible) paint(CLUSTER_HOVER);
        });
    }

    // Seams are drawn inline for the same reason, and repainted on every insert so
    // that N buttons always show N-1 divisions - including after one is removed.
    function paintClusterSeams(cluster) {
        Array.prototype.forEach.call(cluster.children, (kid, index) => {
            kid.style.setProperty('border', '0', 'important');
            if (index > 0) kid.style.setProperty('border-left', CLUSTER_SEAM, 'important');
        });
    }

    function placeInCluster(cluster, el, slot) {
        const rank=LAUNCHER_SLOT_ORDER[slot]||LAUNCHER_SLOT_ORDER.gallery;
        el.dataset.msOrder=String(rank);
        const next=Array.prototype.find.call(cluster.children,kid=>Number(kid.dataset.msOrder||0)>rank);
        cluster.insertBefore(el,next||null);
        paintClusterSeams(cluster);
    }

    function createLauncher(options) {
        const cluster=ensureLauncherCluster();
        const existing=document.getElementById(options.id);
        if(existing){if(existing.parentNode!==cluster)placeInCluster(cluster,existing,options.slot);return existing;}
        const button=document.createElement('button');button.type='button';button.id=options.id;
        button.className='ms-site-cluster-btn'+(options.className?' '+options.className:'');
        button.textContent=options.label||'Gallery';button.title=options.title||button.textContent;
        button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();options.onClick();});
        button.addEventListener('pointerdown',event=>event.stopPropagation());
        protectClusterButton(button);
        button.style.setProperty('padding','0 14px','important');
        placeInCluster(cluster,button,options.slot);return button;
    }
    function beginOpen() {
        const overlay=ensureOverlay();
        overlay.style.display='block';overlay.style.pointerEvents='none';overlay.style.removeProperty('visibility');overlay.style.removeProperty('opacity');
        overlay.classList.remove('ms-closing','active','ms-open');overlay.classList.add('ms-opening');
        return overlay;
    }
    function resetLayout() {
        const overlay=bridge.state.overlay;
        overlay.classList.remove('ms-grid-mode','ms-stage-fullscreen','ms-thumbs-hidden');
        const thumbs=overlay.querySelector('.ms-thumbs-wrap');if(thumbs)thumbs.style.display='block';
    }
    function finishOpen() {
        const overlay=bridge.state.overlay;if(!overlay || !bridge.state.open)return;
        overlay.classList.add('ms-open');overlay.classList.remove('ms-opening');overlay.style.pointerEvents='';
        syncVerticalFitMediaBox();
    }
    function clearViewerMedia() {
        const overlay=bridge.state.overlay;if(!overlay)return;
        ++bridge.state.renderToken;
        clearFullscreenIdleTimer();stopThumbTrackAnimation();cancelFlyGhost();
        if(bridge.state.mediaFitObserver){bridge.state.mediaFitObserver.disconnect();bridge.state.mediaFitObserver=null;}
        setStageFetching(false);
        const gateOnClose=mediaGate();if(gateOnClose)gateOnClose.abort();
        for(const key of ['thumbsWindowRaf','gridWindowRaf'])if(bridge.state[key]){cancelAnimationFrame(bridge.state[key]);bridge.state[key]=null;}
        if(bridge.state.thumbEnteringTimer){clearTimeout(bridge.state.thumbEnteringTimer);bridge.state.thumbEnteringTimer=null;}
        bridge.state.thumbKnownKeys=null;bridge.state.thumbEnteringKeys=null;
        bridge.state.gridKnownKeys=null;bridge.state.gridEnteringKeys=null;
        if(bridge.state.gridEnteringTimer){clearTimeout(bridge.state.gridEnteringTimer);bridge.state.gridEnteringTimer=null;}
        overlay.classList.remove('ms-grid-mode','ms-stage-fullscreen');
        // Both pools are torn down cell by cell before the containers are
        // emptied: dropping a node whose <img> or <video> still has a src leaves
        // the request running with nothing left to cancel it.
        (bridge.state.gridPool||[]).forEach(cell=>resetMediaThumbEl(cell));
        const grid=overlay.querySelector('.ms-grid');if(grid)grid.replaceChildren();
        bridge.state.gridPool=[];bridge.state.gridSizer=null;
        (bridge.state.thumbsPool||[]).forEach(cell=>resetMediaThumbEl(cell));
        const track=overlay.querySelector('.ms-thumbs-track');if(track)track.replaceChildren();
        bridge.state.thumbsPool=[];
        // The observers outlived every session, holding on to the cells they were
        // watching and the items behind them.
        if(bridge.lazyThumbObserver){bridge.lazyThumbObserver.disconnect();bridge.lazyThumbObserver=null;}
        if(bridge.state.gridResizeObs){bridge.state.gridResizeObs.disconnect();bridge.state.gridResizeObs=null;}
        const wrap=overlay.querySelector('.ms-media-wrap');
        // The stage videos outlive the session, parked and empty: the next gallery
        // opened on this page reuses them rather than introducing new ones.
        stageVideoPool().forEach(video=>parkStageVideo(video));
        if(wrap){
            delete wrap.dataset.msVerticalFitBound;
            wrap.querySelectorAll('video,audio').forEach(media=>{
                media.pause();media.removeAttribute('src');media.querySelectorAll('source').forEach(source=>source.remove());
                try{media.load();}catch{}
            });
            wrap.querySelectorAll('iframe').forEach(frame=>frame.src='about:blank');wrap.replaceChildren();
        }
    }
    // The editor on its own site, in a window of its own - the default, and the
    // only version that is really the editor: its own origin, its own storage, and
    // whatever folder permissions the user has already granted it. A page of ours
    // wrapping it in a frame (blob: or written-into about:blank) looks the same but
    // is not: the editor cannot reach its saved permissions from inside a frame,
    // so exporting from it fails.
    //
    // Which leaves the file to get in. The editor's startup file config never
    // finishes for some files, while its own File > Open URL loads the very same
    // URL - and a string sent to the window is run by the editor as a script, so
    // that is the way in: ask it to open the URL itself, exactly as its own menu
    // does. The script is idempotent (it does nothing once a document is open), so
    // it can be repeated until the editor is up without risking two copies.
    function openEditorWindow(options) {
        if (!options || !options.url) return null;
        const child = window.open(options.url, '_blank');
        // Blocked by a popup blocker: the caller falls back to the in-gallery frame.
        if (!child) return null;

        let closed = false;
        const closeHandlers = [];
        const attempts = [];
        const script = String(options.script || '');
        const send = () => {
            if (closed || !script) return;
            if (child.closed) { finish(); return; }
            try { child.postMessage(script, '*'); } catch (e) { }
        };
        const finish = () => {
            if (closed) return;
            closed = true;
            attempts.forEach((id) => window.clearTimeout(id));
            window.clearInterval(watch);
            closeHandlers.forEach(fn => { try { fn(); } catch (e) { } });
        };
        // The editor is a big application; it answers nothing until it is up, and
        // a top-level window cannot tell us when that is (it reports to whoever
        // frames it, and nothing frames it here). So: try over the first half
        // minute, and stop.
        const delays = Array.isArray(options.scriptDelays) && options.scriptDelays.length
            ? options.scriptDelays
            : [1500, 3000, 5000, 8000, 12000, 18000, 25000];
        delays.forEach((delay) => attempts.push(window.setTimeout(send, delay)));
        const watch = window.setInterval(() => { if (child.closed) finish(); }, 1000);

        return {
            window: child,
            // Nothing of ours is drawn in that window, so these are no-ops kept for
            // one shape across both ways of opening an editor.
            setStatus: () => { },
            fail: () => { },
            send: () => { },
            close: () => { finish(); try { child.close(); } catch (e) { } },
            onClose: (fn) => { if (typeof fn === 'function') closeHandlers.push(fn); }
        };
    }

    // An external editor (Photopea) in a frame over the gallery, fed the file's
    // bytes rather than a URL. The editor only talks to the page that embeds it,
    // which is why this is a frame and not a new tab: it announces itself with
    // "done", takes the file as an ArrayBuffer, and says "done" again once the
    // document is open. Returns a small session the caller drives; null when the
    // overlay is not up.
    function openEditorFrame(options) {
        const overlay = bridge.state.overlay;
        if (!overlay || !options || !options.url) return null;
        // Inside the overlay, not beside it: as a sibling it sat under the
        // gallery, which owns the top of the stacking order in this root.
        const root = overlay;
        const existing = root.querySelector('.ms-editor-frame-wrap');
        if (existing) existing.remove();

        const wrap = document.createElement('div');
        wrap.className = 'ms-editor-frame-wrap';
        const bar = document.createElement('div');
        bar.className = 'ms-editor-bar';
        const title = document.createElement('div');
        title.className = 'ms-editor-title';
        title.textContent = options.title || 'Editor';
        const status = document.createElement('div');
        status.className = 'ms-editor-status';
        const spacer = document.createElement('div');
        spacer.className = 'ms-editor-spacer';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'ms-editor-close';
        close.textContent = '\u00d7';
        close.title = 'Close the editor';
        close.setAttribute('aria-label', 'Close the editor');
        bar.append(title, status, spacer, close);
        const frame = document.createElement('iframe');
        frame.className = 'ms-editor-frame';
        frame.setAttribute('allow', 'clipboard-read; clipboard-write');
        frame.src = options.url;
        wrap.append(bar, frame);
        root.appendChild(wrap);

        let ready = false;
        let closed = false;
        const closeHandlers = [];
        const onMessage = (event) => {
            if (event.source !== frame.contentWindow) return;
            if (String(event.data) !== 'done') return;
            if (!ready) {
                ready = true;
                if (pending) { post(pending); pending = null; }
            } else {
                setStatus('');
            }
        };
        window.addEventListener('message', onMessage);

        const destroy = () => {
            if (closed) return;
            closed = true;
            window.removeEventListener('message', onMessage);
            clearTimeout(readyTimer);
            wrap.remove();
            closeHandlers.forEach(fn => { try { fn(); } catch (e) { } });
        };
        close.addEventListener('click', destroy);

        const setStatus = (text) => { status.textContent = text || ''; };
        const fail = (message) => {
            setStatus(message || 'The file could not be opened.');
            if (options.fallbackHref && !bar.querySelector('.ms-editor-fallback')) {
                const link = document.createElement('a');
                link.className = 'ms-editor-fallback';
                link.href = options.fallbackHref;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = options.fallbackLabel || 'Download the file instead';
                bar.insertBefore(link, spacer);
            }
        };
        let pending = null;
        const post = (buffer) => {
            try { frame.contentWindow.postMessage(buffer, '*'); }
            catch (e) { fail('The editor did not accept the file.'); }
        };
        // If the editor never announces itself, say so rather than spin.
        const readyTimer = setTimeout(() => {
            if (!ready && !closed) fail('The editor did not respond.');
        }, options.readyTimeout || 40000);

        return {
            frame: frame,
            setStatus: setStatus,
            fail: fail,
            send: (buffer) => { if (ready) post(buffer); else pending = buffer; },
            close: destroy,
            onClose: (fn) => { if (typeof fn === 'function') closeHandlers.push(fn); }
        };
    }

    // Closing the gallery scrolls the page back to the item you were on. On a
    // grid of near-identical thumbnails that still leaves you hunting, so the
    // element is outlined for a moment. The outline is our own element laid over
    // the target rather than a class on the host's node: a class can collide with
    // the site's own styles and its scripts can strip it.
    function flashHostElement(el, options) {
        if (!el || !el.isConnected || typeof el.getBoundingClientRect !== 'function') return null;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const doc = el.ownerDocument || document;
        const view = doc.defaultView || window;
        const previous = doc.querySelector('[data-ms-highlight]');
        if (previous) previous.remove();
        const mark = doc.createElement('div');
        mark.setAttribute('data-ms-highlight', '1');
        mark.setAttribute('aria-hidden', 'true');
        const pad = 3;
        const values = {
            position: 'absolute',
            left: (rect.left + (view.scrollX || 0) - pad) + 'px',
            top: (rect.top + (view.scrollY || 0) - pad) + 'px',
            width: (rect.width + pad * 2) + 'px',
            height: (rect.height + pad * 2) + 'px',
            'box-sizing': 'border-box',
            border: '2px solid ' + ((options && options.color) || 'var(--ms-accent, hsl(223, 78%, 65%))'),
            'border-radius': ((options && options.radius) || '10px'),
            'box-shadow': '0 0 0 4px rgba(96, 136, 235, 0.18)',
            'pointer-events': 'none',
            'z-index': '2147483646',
            opacity: '1',
            margin: '0',
            padding: '0',
            background: 'transparent',
            transition: prefersReducedMotion() ? 'none' : 'opacity 420ms ease'
        };
        for (const [key, value] of Object.entries(values)) mark.style.setProperty(key, value, 'important');
        (doc.body || doc.documentElement).appendChild(mark);
        const hold = (options && options.hold) || 900;
        const done = () => { if (mark.parentNode) mark.remove(); };
        view.setTimeout(() => {
            if (!mark.parentNode) return;
            if (prefersReducedMotion()) { done(); return; }
            mark.style.setProperty('opacity', '0', 'important');
            view.setTimeout(done, 480);
        }, hold);
        return mark;
    }

    function revealHost() {
        const overlay=bridge.state.overlay;if(!overlay)return;
        overlay.classList.remove('ms-closing');
        if(!bridge.state.open){overlay.classList.remove('active','ms-open');overlay.style.display='none';overlay.style.pointerEvents='none';}
    }
    function showPostPanel(model, item) {
        const panel = bridge.state.overlay && bridge.state.overlay.querySelector('.ms-tags-overlay');
        if (!panel) return;
        panel.querySelector('.ms-tags-header h3').textContent = model.title || 'Info';
        const content = panel.querySelector('.ms-tags-content');
        const itemKey = String((bridge.mediaKey && bridge.mediaKey(item)) || item?.src || '');
        const preserveState = !!itemKey && content.dataset.msPostKey === itemKey;
        const mediaMeta = !!item && (item.type === 'img' || item.type === 'video');
        renderPostPanel({content,model:{...model,mediaMeta},preserveState,captionControls:target => appendCaptionModeControls(target,item)});
        content.dataset.msPostKey = itemKey;
        paintInfoMeta(item);
        updateMediaCaptionOverlay(item);
    }
    function setInfoPanelVisible(show) {
        const overlay=bridge.state.overlay;if(!overlay)return;
        overlay.classList.toggle('ms-has-tags-panel',!!show);
        overlay.querySelector('.ms-tags-overlay').classList.toggle('active',!!show);
        overlay.querySelector('[data-act="show-tags"]').classList.toggle('active',!!show);
        requestAnimationFrame(() => syncVerticalFitMediaBox());
    }
    function isInfoPanelVisible() {return !!(bridge.state.overlay && bridge.state.overlay.querySelector('.ms-tags-overlay.active'));}
    function setTitlePanelVisible(show) {
        if(!bridge.state.overlay)return;
        bridge.state.overlay.classList.toggle('ms-reddit-row-open',!!show);
        bridge.state.overlay.querySelector('[data-act="show-tags"]').classList.toggle('active',!!show);
        requestAnimationFrame(() => syncVerticalFitMediaBox());
    }
    function refreshGridSize() {
        if(!bridge.state.overlay)return;
        bridge.state.overlay.style.setProperty('--ms-grid-size',bridge.gridThumbSize+'px');
        const slider=bridge.state.overlay.querySelector('.ms-grid-size-slider');
        if(slider)slider.value=bridge.gridThumbSize;
        const label=bridge.state.overlay.querySelector('.ms-grid-size-value');if(label)label.textContent=bridge.gridThumbSize+'px';
        if(bridge.state.gridMode)syncGridWindow();
    }
    function renderTitleRow(model) {
        const overlay=bridge.state.overlay;if(!overlay)return;
        setTitlePanelVisible(bridge.state.tagsPanelWanted && model);
        if(!model)return;
        const row=overlay.querySelector('.ms-reddit-info-row');
        const title=row.querySelector('.ms-reddit-title');title.textContent=model.title||'';title.href=model.permalink||'#';
        const meta=row.querySelector('.ms-reddit-meta');meta.replaceChildren();
        (model.links||[]).forEach((data,index) => {
            if(index)meta.append(document.createTextNode(' • '));
            const link=document.createElement(data.href?'a':'span');link.textContent=data.label;
            if(data.href){link.href=data.href;link.target='_blank';link.rel='noopener noreferrer';}
            meta.append(link);
        });
        row.querySelector('[data-rdvote="upvote"]').classList.toggle('upvoted',!!model.upvoted);
        row.querySelector('[data-rdvote="downvote"]').classList.toggle('downvoted',!!model.downvoted);
        row.querySelector('.ms-reddit-score').textContent=model.score==null || model.score===''?'•':String(model.score).replace(/\s*points?\s*$/i,'');
        row.querySelector('[data-rdsave]').classList.toggle('saved',!!model.saved);
        row.querySelector('.ms-reddit-save-label').textContent=model.saved?'Saved':'Save';
    }
    function paintTopbar(model) {
        const overlay=bridge.state.overlay;if(!overlay)return;
        const loop=overlay.querySelector('[data-act="loop-toggle"]');loop.style.display=model.video?'':'none';loop.classList.toggle('active',!!model.loop);
        const favorite=overlay.querySelector('[data-act="fav-toggle"]');favorite.style.display=model.favoriteVisible?'':'none';favorite.title=model.favoriteTitle;favorite.classList.toggle('active',!!model.favoriteActive);
        const info=overlay.querySelector('[data-act="show-tags"]');info.style.display=model.infoVisible?'':'none';setBtnLabel(info,model.infoLabel);
        if(isInfoPanelVisible())toggleTagsPanel(true);
        updateTopbarCompact();
    }
    function showStageNotice(wrap, text) {
            if (!wrap) return;
            let pill = wrap.querySelector('.ms-stage-notice');
            if (!pill) {
                pill = document.createElement('div');
                pill.className = 'ms-stage-notice ms-resolve-loading';
                pill.innerHTML = '<div class="ms-resolve-spinner"></div><div class="ms-resolve-text"></div>';
                wrap.appendChild(pill);
            }
            const txt = pill.querySelector('.ms-resolve-text');
            if (txt) txt.textContent = text;
        }

    function hideStageNotice(wrap) {
            if (!wrap) return;
            const pill = wrap.querySelector('.ms-stage-notice');
            if (pill) pill.remove();
        }

    function showGalleryEndNotice() {
            const now = Date.now();
            if (now - bridge.galleryEndNoticeLastAt < 5000) return;
            bridge.galleryEndNoticeLastAt = now;

            if (bridge.state.overlay) {
                let toast = bridge.state.overlay.querySelector('.ms-gallery-end-toast');
                if (!toast) {
                    toast = document.createElement('div');
                    toast.className = 'ms-gallery-end-toast';
                    toast.textContent = 'End of gallery - no more media found';
                    bridge.state.overlay.appendChild(toast);
                }
                requestAnimationFrame(() => toast.classList.add('active'));
                if (bridge.galleryEndNoticeTimer) clearTimeout(bridge.galleryEndNoticeTimer);
                bridge.galleryEndNoticeTimer = setTimeout(() => {
                    toast.classList.remove('active');
                    setTimeout(() => { if (toast.isConnected) toast.remove(); }, 220);
                }, 1600);
            }
        }

    function getLoadingOverlay() {
            let overlay = document.getElementById('ms-loading-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'ms-loading-overlay';
                document.body.appendChild(overlay);
            }
            return overlay;
        }

    function showLoadingOverlay(mainText, subText) {
            bridge.ensureMsStyles();
            const overlay = getLoadingOverlay();
            overlay.innerHTML = '<div class="ms-loading-main"></div><div class="ms-loading-sub"></div>';
            overlay.querySelector('.ms-loading-main').textContent = mainText || 'Loading gallery...';
            overlay.querySelector('.ms-loading-sub').textContent = subText || '';
            overlay.style.display = 'flex';
        }

    function updateLoadingOverlay(mainText, subText) {
            const overlay = document.getElementById('ms-loading-overlay');
            if (!overlay || overlay.style.display === 'none') return;
            const main = overlay.querySelector('.ms-loading-main');
            const sub = overlay.querySelector('.ms-loading-sub');
            if (main && typeof mainText === 'string') main.textContent = mainText;
            if (sub && typeof subText === 'string') sub.textContent = subText;
        }

    function hideLoadingOverlay() {
            const overlay = document.getElementById('ms-loading-overlay');
            if (overlay) overlay.style.display = 'none';
        }

    function ensureOverlay() {
            bridge.ensureMsStyles();
            if (bridge.state.overlay) return bridge.state.overlay;

            const coreApi = bridge.xgalleryCoreApi();
            const overlay = globalThis.XGalleryCore.createOverlayShell({
                document: document,
                shadowCss: coreApi && coreApi.OVERLAY_CSS,
                classes: [
                    bridge.captionFeed || bridge.reservedPostHeader ? 'ms-rich-info' : '',
                    bridge.captionFeed ? 'ms-imaglr' : '',
                    bridge.reservedPostHeader ? 'ms-bdsmlr' : '',
                    bridge.resetHostStyles ? 'ms-reset-host ms-pixeldrain' : '',
                    bridge.titleCard && bridge.legacyHost() ? 'ms-old-reddit' : ''
                ],
                fontFamily: bridge.folderFavorites ? '"Space Grotesk", ui-sans-serif, system-ui, sans-serif' : '',
                showInfo: bridge.categorizedTags || bridge.reservedPostHeader || bridge.captionFeed || bridge.titleCard,
                infoLabel: 'Info'
            });

            if (coreApi && typeof coreApi.bindFilterBar === 'function') {
                bridge.state.filterBar = coreApi.bindFilterBar(overlay.querySelector('.ms-filter-bar'), {
                    state: bridge.galleryFilter,
                    onChange: (next) => {
                        bridge.galleryFilter = next;
                        bridge.filterMode = next.kind === 'videos' ? 2 : (next.kind === 'images' ? 1 : 0);
                        try {
                            bridge.savePreference(bridge.FILTER_MODE_KEY, bridge.filterMode);
                            bridge.savePreference(bridge.GALLERY_FILTER_KEY, JSON.stringify(next));
                        } catch (e) { }
                        if (bridge.state.open) bridge.rebuildFilteredAndRender();
                    }
                });
            }

            overlay.style.setProperty('--ms-grid-size', bridge.gridThumbSize + 'px');
            const sizeSlider = overlay.querySelector('.ms-grid-size-slider');
            const sizeValueEl = overlay.querySelector('.ms-grid-size-value');
            if (sizeValueEl) sizeValueEl.textContent = bridge.gridThumbSize + 'px';
            if (sizeSlider) {
                sizeSlider.value = bridge.gridThumbSize;
                let sizeApplyRaf = null;
                let sizePersistTimer = null;
                sizeSlider.addEventListener('input', () => {
                    const val = parseInt(sizeSlider.value, 10) || 160;
                    bridge.gridThumbSize = val;
                    if (sizeValueEl) sizeValueEl.textContent = val + 'px';

                    if (sizeApplyRaf === null) {
                        sizeApplyRaf = requestAnimationFrame(() => {
                            sizeApplyRaf = null;
                            overlay.style.setProperty('--ms-grid-size', bridge.gridThumbSize + 'px');
                            if (bridge.state.gridMode) syncGridWindow();
                        });
                    }

                    if (sizePersistTimer) clearTimeout(sizePersistTimer);
                    sizePersistTimer = setTimeout(() => {
                        bridge.savePreference('MS_BETTER_GRID_SIZE', bridge.gridThumbSize);
                    }, 250);
                });
                sizeSlider.addEventListener('click', (e) => e.stopPropagation());
            }

            const gridWrap = overlay.querySelector('.ms-grid-wrap');
            if (gridWrap) {
                gridWrap.addEventListener('scroll', () => {
                    if (!bridge.state.gridMode) return;
                    if (gridWrap.scrollTop + gridWrap.clientHeight >= gridWrap.scrollHeight - 600) {
                        bridge.checkTriggerInfiniteScroll(true);
                    }
                }, { passive: true });

                gridWrap.addEventListener('click', (e) => {
                    const cell = e.target.closest('.ms-grid-cell');
                    if (cell) {
                        e.preventDefault();
                        e.stopPropagation();
                        const index = parseInt(cell.getAttribute('data-grid-index'), 10);
                        if (Number.isFinite(index) && index >= 0 && index < bridge.state.items.length) {
                            bridge.rememberNavigationDirection(bridge.state.currentIndex, index, bridge.state.items.length);
                            bridge.state.currentIndex = index;
                            bridge.state.activeNode = bridge.state.items[index] ? bridge.state.items[index].node : null;
                            setGridMode(false);
                        }
                    }
                });

                const loadMoreBtn = gridWrap.querySelector('.ms-grid-loadmore');
                if (loadMoreBtn) {
                    if (!bridge.categorizedTags && !bridge.remotePhotoAlbums && !bridge.timelineFeed && !bridge.folderFavorites && !bridge.reservedPostHeader) loadMoreBtn.classList.add('ms-hidden');
                    loadMoreBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        loadMoreBtn.textContent = 'Loading...';
                        setTimeout(() => { loadMoreBtn.textContent = 'Load more'; }, 5000);
                        bridge.requestMoreAtGalleryEnd();
                    });
                }
            }

            overlay.addEventListener('click', onOverlayClick);
            overlay.addEventListener('wheel', onOverlayWheel, { passive: false });
            overlay.addEventListener('mousemove', (e) => { if (bridge.state.stageFullscreen && e.clientY <= 120) wakeFullscreenTopbar(); });
            bridge.state.overlay = overlay;
            bindTagsPanelResizer();
            bindTitleRowResizer();
            applyTagsFontSize(bridge.tagsFontSize, false);
            bindTopbarCompactObserver();

            const mediaWrap = overlay.querySelector('.ms-media-wrap');
            if (mediaWrap) {
                mediaWrap.addEventListener('wheel', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (bridge.panWheelScroll && bridge.state.pan && bridge.state.pan.active) {
                        bridge.state.pan.panBy(e.shiftKey ? -e.deltaY : -(e.deltaX || 0), e.shiftKey ? 0 : -e.deltaY);
                        return;
                    }
                    const direction = getWheelNavigationDirection(e);
                    if (direction) navigateFromWheel(direction);
                }, { passive: false, capture: true });

                mediaWrap.addEventListener('mouseleave', () => {
                    const shield = mediaWrap.querySelector('.ms-iframe-shield');
                    if (shield) {
                        shield.style.pointerEvents = 'auto';
                    }
                });

                let swipeStartX = 0;
                let swipeStartY = 0;
                let swipeTime = 0;
                mediaWrap.addEventListener('touchstart', (e) => {
                    if (e.touches.length === 1) {
                        swipeStartX = e.touches[0].clientX;
                        swipeStartY = e.touches[0].clientY;
                        swipeTime = Date.now();
                    }
                }, { passive: true });
                mediaWrap.addEventListener('touchend', (e) => {
                    if (e.changedTouches.length === 1) {
                        const endX = e.changedTouches[0].clientX;
                        const endY = e.changedTouches[0].clientY;
                        const diffX = swipeStartX - endX;
                        const diffY = Math.abs(swipeStartY - endY);
                        if (Date.now() - swipeTime < 500 && Math.abs(diffX) > 50 && Math.abs(diffX) > diffY) {
                            bridge.navigate(diffX > 0 ? 1 : -1);
                        }
                    }
                }, { passive: true });
            }

            const thumbsWrap = overlay.querySelector('.ms-thumbs-wrap');
            if (thumbsWrap) {
                thumbsWrap.addEventListener('wheel', (e) => {

                    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                        e.preventDefault();
                        e.stopPropagation();
                        const direction = getWheelNavigationDirection(e);
                        if (direction) navigateFromWheel(direction);
                    }
                }, { passive: false, capture: true });
            }

            bindPositionControl();

            const zoomSlider = overlay.querySelector('.ms-zoom-slider');
            if (zoomSlider) {
                let zoomApplyRaf = null;
                let pendingZoomScale = null;
                zoomSlider.addEventListener('input', () => {
                    const requestedScale = zoomScaleFromSlider(zoomSlider);
                    pendingZoomScale = requestedScale;
                    const valueEl = overlay.querySelector('.ms-zoom-value');
                    if (valueEl) valueEl.textContent = Math.round(requestedScale * 100) + '%';
                    paintZoomSlider(zoomSlider);
                    const renderToken = bridge.state.renderToken;
                    const wrap = overlay.querySelector('.ms-media-wrap');
                    const img = wrap ? wrap.querySelector('img.ms-media.ms-ready') : null;
                    if (!bridge.state.pan || !bridge.state.pan.active) {
                        if (wrap && img) {
                            enablePanForImage(wrap, img, { zoom: true, scale: displayedImageScale(wrap, img), returnToFill: false });
                        }
                    }

                    if (zoomApplyRaf !== null) return;
                    zoomApplyRaf = requestAnimationFrame(() => {
                        zoomApplyRaf = null;
                        if (renderToken !== bridge.state.renderToken || !img || bridge.state.pan?.img !== img) return;
                        if (bridge.state.pan && bridge.state.pan.active && typeof bridge.state.pan.updateZoom === 'function') {
                            bridge.state.pan.updateZoom(pendingZoomScale);
                        }
                    });
                });
                zoomSlider.addEventListener('pointerdown', (e) => e.stopPropagation());
                zoomSlider.addEventListener('click', (e) => e.stopPropagation());
            }

            document.body.appendChild(overlay.msRootHost || overlay);
            bridge.state.overlay = overlay;
            return overlay;
        }

    function onOverlayClick(e) {

            const filterApi = bridge.state.filterBar;
            const filterPopup = e.target.closest('.ms-filter-bar');
            const filterTrigger = e.target.closest('[data-act="filter-toggle"]');
            if (filterApi && filterApi.isOpen && filterApi.isOpen() && !filterPopup && !filterTrigger) {
                filterApi.close();
                if (!e.target.closest('[data-act]')) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
            }

            const rdVote = e.target.closest('[data-rdvote]');
            const rdSave = e.target.closest('[data-rdsave]');
            if (rdVote || rdSave) {
                e.preventDefault();
                e.stopPropagation();
                const rdEntry = bridge.state.items[bridge.state.currentIndex];
                const rdItem = rdEntry ? (rdEntry.item || rdEntry) : null;
                if (bridge.hasTitleMetadata(rdItem)) {
                    if (rdVote) bridge.vote(rdItem, rdVote.getAttribute('data-rdvote'));
                    else bridge.savePost(rdItem);
                }
                return;
            }

            const actionNode = e.target.closest('[data-act]');
            if (actionNode) {
                const act = actionNode.getAttribute('data-act');

                if (act === 'close') bridge.closeGallery();
                else if (act === 'prev') bridge.navigate(-1);
                else if (act === 'next') bridge.navigate(1);
                else if (act === 'x-like' || act === 'x-bookmark') {
                    const entry = bridge.state.items[bridge.state.currentIndex];
                    const item = entry ? (entry.item || entry) : null;
                    if (bridge.actionPostId(item)) bridge.performPostAction(act === 'x-like' ? 'like' : 'bookmark', bridge.actionPostId(item));
                }
                else if (act === 'loop-toggle') {
                    bridge.globalLoop = !bridge.globalLoop;
                    bridge.savePreference('MS_BETTER_VIDEO_LOOP', bridge.globalLoop);
                    const video = bridge.state.overlay ? bridge.state.overlay.querySelector('.ms-media-wrap video') : null;
                    const loopEntry = bridge.state.items[bridge.state.currentIndex];
                    const loopItem = loopEntry ? (loopEntry.item || loopEntry) : null;
                    if (video) video.loop = bridge.globalLoop || !!(loopItem && loopItem.imageFallbackSrc);
                    bridge.updateTopbarStates();
                } else if (act === 'fav-toggle') {
                    const entry = bridge.state.items[bridge.state.currentIndex];
                    const item = entry ? (entry.item || entry) : null;
                    if (bridge.folderFavorites && item) {
                        bridge.openFavoriteFolders(item, actionNode);
                    } else if (item && item.postId) {
                        item.isFavorited = !item.isFavorited;
                        bridge.toggleFavoriteOnSite(item.postId, item.isFavorited);
                        bridge.updateTopbarStates();
                    }
                } else if (act === 'show-tags') {
                    if (bridge.titleCard) {

                        toggleTagsPanel(!bridge.state.overlay.classList.contains('ms-reddit-row-open'));
                    } else {
                        const tagsOverlay = bridge.state.overlay.querySelector('.ms-tags-overlay');
                        toggleTagsPanel(!(tagsOverlay && tagsOverlay.classList.contains('active')));
                    }
                } else if (act === 'tags-font') {
                    const step = parseInt(actionNode.getAttribute('data-val'), 10) || 0;
                    applyTagsFontSize(bridge.tagsFontSize + step, true);
                } else if (act === 'tags-close') {
                    toggleTagsPanel(false);
                } else if (act === 'view-toggle') {
                    setGridMode(!bridge.state.gridMode);
                } else if (act === 'filter-toggle') {
                    if (bridge.state.filterBar && bridge.state.filterBar.toggle) bridge.state.filterBar.toggle();
                } else if (act === 'pan-toggle') {
                    togglePanMode();
                } else if (act === 'fullscreen-toggle') {
                    toggleStageFullscreen();
                } else if (act === 'hd') {
                    if (typeof bridge.state.hdUpgradeRun === 'function') {
                        const run = bridge.state.hdUpgradeRun;
                        bridge.state.hdUpgradeRun = null;
                        run();
                    }
                } else if (act === 'thumbs' || act === 'thumbs-toggle') {
                    const val = actionNode.getAttribute('data-val');
                    if (val) toggleThumbs(val === 'off');
                    else toggleThumbs();
                } else if (act === 'download') {
                    bridge.downloadCurrentItem();
                } else if (act === 'link') {
                    const currentItem = bridge.state.items[bridge.state.currentIndex];
                    if (currentItem && currentItem.item && currentItem.item.src) {
                        window.open(currentItem.item.src, '_blank');
                    }
                } else if (act === 'filter') {
                    const val = parseInt(actionNode.getAttribute('data-val'), 10);
                    bridge.filterMode = val;
                    bridge.savePreference(bridge.FILTER_MODE_KEY, bridge.filterMode);
                    bridge.rebuildFilteredAndRender();
                } else if (act === 'fit') {
                    const val = actionNode.getAttribute('data-val');
                    bridge.fitVertical = val === 'vertical';
                    bridge.savePreference('MS_BETTER_FIT_VERTICAL', bridge.fitVertical);
                    disablePan();
                    applyFitClass();
                    updateButtons();
                }

                return;
            }

            if (e.target.closest('.ms-tags-panel, .ms-tags-resizer')) return;

            const clickedMedia = e.target.closest('.ms-media-wrap img, .ms-media-wrap video, .ms-media-wrap iframe, .ms-iframe-shield, .ms-media-box');
            const clickedNav = e.target.closest('.ms-nav, .ms-gallery-topbar, .ms-filter-bar, .ms-thumbs-wrap, .ms-counter, .ms-dropdown, .ms-grid-cell, .ms-grid-loadmore, .ms-grid-controls, .ms-grid-wrap, .ms-grid, .ms-reddit-info-row');
            if (!clickedMedia && !clickedNav) {

                if (bridge.state.gridMode) {
                    bridge.closeGallery();
                    return;
                }

                if (bridge.state.cameFromGrid) {
                    setGridMode(true);
                    return;
                }
                bridge.closeGallery();
            }
        }

    function tagsPanelIsScrollable(panel) {
            if (!panel) return false;
            const scroller = panel.querySelector('.ms-tags-content') || panel;
            return (scroller.scrollHeight - scroller.clientHeight) > 1;
        }

    function onOverlayWheel(e) {
            e.stopPropagation();
            if (bridge.state.gridMode) return;
            const target = e.target;
            if (target && target.closest('.ms-thumbs-wrap, .ms-gallery-controls, .ms-gallery-center, .ms-filter-bar')) return;
            const tagsPanel = target && target.closest('.ms-tags-overlay');
            if (tagsPanel && tagsPanelIsScrollable(tagsPanel)) return;
            e.preventDefault();
            if (bridge.panWheelScroll && bridge.state.pan && bridge.state.pan.active && target && target.closest('.ms-media-wrap')) {
                bridge.state.pan.panBy(0, -e.deltaY);
                return;
            }
            const direction = getWheelNavigationDirection(e);
            if (direction) navigateFromWheel(direction);
        }

    function navigateFromWheel(direction) {
            bridge.wheelNavPending += direction;
            if (bridge.wheelNavRaf) return;
            bridge.wheelNavRaf = requestAnimationFrame(() => {
                bridge.wheelNavRaf = 0;
                const delta = bridge.wheelNavPending;
                bridge.wheelNavPending = 0;
                if (delta) bridge.navigate(delta);
            });
        }

    function getWheelNavigationDirection(e) {
            if (!e || typeof e.deltaY !== 'number' || e.deltaY === 0) return 0;

            const direction = e.deltaY > 0 ? 1 : -1;
            if (bridge.state.wheelDirection && bridge.state.wheelDirection !== direction) {
                bridge.state.wheelDeltaCarry = 0;
            }
            bridge.state.wheelDirection = direction;

            let deltaAmount = Math.abs(e.deltaY);
            if (e.deltaMode === 1) deltaAmount *= 16;
            else if (e.deltaMode === 2) deltaAmount *= (window.innerHeight || 900);

            bridge.state.wheelDeltaCarry += deltaAmount;
            if (bridge.state.wheelDeltaCarry < 64) return 0;

            bridge.state.wheelDeltaCarry = 0;
            return direction;
        }

    function updateDropdownActiveStates() {
            if (!bridge.state.overlay) return;

            bridge.state.overlay.querySelectorAll('.ms-dropdown-item[data-act="filter"]').forEach(item => {
                const val = parseInt(item.getAttribute('data-val'), 10);
                item.classList.toggle('active', val === bridge.filterMode);
            });

            bridge.state.overlay.querySelectorAll('.ms-dropdown-item[data-act="fit"]').forEach(item => {
                const val = item.getAttribute('data-val');
                item.classList.toggle('active', (val === 'vertical') === bridge.fitVertical);
            });

            const hidden = bridge.state.overlay.classList.contains('ms-thumbs-hidden');
            bridge.state.overlay.querySelectorAll('.ms-dropdown-item[data-act="thumbs"]').forEach(item => {
                const val = item.getAttribute('data-val');
                item.classList.toggle('active', (val === 'off') === hidden);
            });

        }

    function setBtnLabel(btn, text) {
            if (!btn) return;
            const label = btn.querySelector(".ms-btn-label");
            if (label) label.textContent = text;
            else btn.textContent = text;
            btn.title = text;
        }

    function measureRowContentWidth(row) {
            let total = 0;
            let shown = 0;
            for (let i = 0; i < row.children.length; i++) {
                const kid = row.children[i];
                if (kid.offsetParent === null && !kid.getClientRects().length) continue;
                total += kid.getBoundingClientRect().width;
                shown++;
            }
            if (shown > 1) {
                // Called with an explicit window: the adapter hands over the
                // page's own getComputedStyle unbound, and a native method invoked
                // off a plain object is an illegal invocation. Tampermonkey's
                // sandbox happens to hand over a bound one, which is why this only
                // ever bit outside it - the same trap as building a MouseEvent
                // with the sandbox's stand-in window.
                const styleOf = bridge.getComputedStyle || globalThis.getComputedStyle;
                const gap = parseFloat(styleOf.call(globalThis, row).columnGap) || 0;
                total += gap * (shown - 1);
            }
            return total;
        }

    function topbarLayoutSignature(topbar, controls) {
            const center = topbar.querySelector('.ms-gallery-center');
            const vis = (el) => el
                ? Array.prototype.map.call(el.children, (k) => (k.style.display === 'none' ? '0' : '1')).join('')
                : '';
            // A pinned button keeps its label at every tier, so its text is a real
            // input to the layout and has to invalidate the memo - Grid becomes
            // Viewer and back, and that is a real width change now that the label
            // is never hidden.
            const pinned = topbar.querySelector('.ms-btn-pinned .ms-btn-label');
            // No width here on purpose. Reading one costs a layout, this runs on
            // every render, and it was the most expensive thing the gallery did on
            // a big page. The only other input is the bar's own width, and a
            // ResizeObserver already re-runs the fit when that changes.
            return vis(controls) + '|' + vis(center) + '|' + (pinned ? pinned.textContent : '');
        }

    function updateTopbarCompact(force) {
            if (!bridge.state.overlay) return;
            const topbar = bridge.state.overlay.querySelector('.ms-gallery-topbar');
            const controls = bridge.state.overlay.querySelector('.ms-gallery-controls');
            if (!topbar || !controls) return;

            const sig = topbarLayoutSignature(topbar, controls);
            // force: the bar itself changed width, which the signature no longer
            // watches, so the fit has to be measured again.
            if (!force && topbar.dataset.msCompactSig === sig) return;
            topbar.dataset.msCompactSig = sig;

            topbar.classList.remove('ms-icons-only');
            topbar.classList.remove('ms-topbar-tight');

            const room = controls.clientWidth + 1;
            if (measureRowContentWidth(controls) > room) {
                topbar.classList.add('ms-icons-only');
                if (measureRowContentWidth(controls) > room) {
                    topbar.classList.add('ms-topbar-tight');
                }
            }
        }

    function bindTopbarCompactObserver() {
            if (!bridge.state.overlay) return;
            const topbar = bridge.state.overlay.querySelector('.ms-gallery-topbar');
            if (!topbar || topbar.dataset.msCompactBound === '1') return;
            topbar.dataset.msCompactBound = '1';

            let pending = false;
            const ro = new ResizeObserver(() => {
                if (pending) return;
                pending = true;
                requestAnimationFrame(() => {
                    pending = false;
                    updateTopbarCompact(true);
                });
            });
            ro.observe(topbar);
            updateTopbarCompact();
        }

    function updateButtons() {
            if (!bridge.state.overlay) return;
            const triggerFilter = bridge.state.overlay.querySelector('[data-act="filter-trigger"]');
            const triggerFit = bridge.state.overlay.querySelector('[data-act="fit-trigger"]');
            const triggerThumbs = bridge.state.overlay.querySelector('[data-act="thumbs-trigger"], [data-act="thumbs-toggle"]');

            if (triggerFilter) {
                setBtnLabel(triggerFilter, 'FILTER');
            }
            if (triggerFit) {
                setBtnLabel(triggerFit, bridge.fitVertical ? 'Fit: Vert' : 'Fit: Std');
            }
            if (triggerThumbs) {
                const hidden = bridge.state.overlay.classList.contains('ms-thumbs-hidden');
                triggerThumbs.classList.toggle('active', !hidden);
            }
            const triggerView = bridge.state.overlay.querySelector('[data-act="view-toggle"]');
            if (triggerView) {
                setBtnLabel(triggerView, bridge.state.gridMode ? 'Viewer' : 'Grid');
            }
            const triggerPan = bridge.state.overlay.querySelector('[data-act="pan-toggle"]');
            if (triggerPan) {
                const panActive = !!(bridge.state.pan && bridge.state.pan.active);
                triggerPan.classList.toggle('active', panActive);
            }
            const triggerFullscreen = bridge.state.overlay.querySelector('[data-act="fullscreen-toggle"]');
            if (triggerFullscreen) {
                triggerFullscreen.classList.toggle('active', !!bridge.state.stageFullscreen);
            }

            // Viewer-only controls keep their slots in grid mode and fade out, via
            // .ms-grid-mode in CSS. Hiding them with display used to re-centre the
            // centre column and move the counter, and often flipped the compaction
            // tier as well - relabelling every button at once. display stays the
            // tool for "this item or site does not have it", which is per item,
            // not per mode. inert covers the fade and takes them out of tab order.
            bridge.state.overlay.querySelectorAll('.ms-gallery-topbar .ms-mode-viewer')
                .forEach((el) => { el.inert = !!bridge.state.gridMode; });
            if (bridge.state.gridMode) toggleTagsPanel(false, true);
            updateDropdownActiveStates();
            updateTopbarCompact();
        }

    function updatePositionControl(force) {
            if (!bridge.state.overlay) return;
            const input = bridge.state.overlay.querySelector('.ms-position-control .ms-index-input');
            const total = bridge.state.overlay.querySelector('.ms-position-total');
            if (!input || !total) return;
            const position = bridge.galleryPositionSnapshot();
            const length = position.length;
            const currentIndex = position.currentIndex;
            const inputRoot = input.getRootNode && input.getRootNode();
            const editing = (document.activeElement === input || (inputRoot && inputRoot.activeElement === input)) && input.dataset.msDirty === '1';
            if (force || !editing) input.value = length ? String(currentIndex + 1) : '0';
            const digits = String(Math.max(1, length)).length;
            input.style.setProperty('width', Math.max(1, digits) + 'ch', 'important');
            input.maxLength = digits;
            total.textContent = String(length);
            input.setAttribute('aria-label', length
                ? 'Go to image, ' + (currentIndex + 1) + ' of ' + length
                : 'No images');
        }

    function commitPositionInput(input) {
            const raw = String(input.value || '').trim();
            const parsed = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
            input.dataset.msDirty = '0';
            if (!bridge.state.items.length || !Number.isFinite(parsed)) {
                updatePositionControl(true);
                return;
            }
            const target = Math.max(1, Math.min(bridge.state.items.length, parsed)) - 1;
            if (target === bridge.state.currentIndex) {
                updatePositionControl(true);
                return;
            }
            bridge.rememberNavigationDirection(bridge.state.currentIndex, target, bridge.state.items.length);
            bridge.state.currentIndex = target;
            bridge.state.activeNode = bridge.state.items[target] ? bridge.state.items[target].node : null;
            bridge.renderCurrent();
        }

    function bindPositionControl() {
            if (!bridge.state.overlay) return;
            const control = bridge.state.overlay.querySelector('.ms-position-control');
            const input = control && control.querySelector('.ms-index-input');
            if (!control || !input || control.dataset.msBound === '1') return;
            control.dataset.msBound = '1';
            control.addEventListener('click', (event) => event.stopPropagation());
            input.addEventListener('focus', () => input.select());
            input.addEventListener('input', () => { input.dataset.msDirty = '1'; });
            input.addEventListener('blur', () => commitPositionInput(input));
            input.addEventListener('keydown', (event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commitPositionInput(input);
                    input.blur();
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    input.dataset.msDirty = '0';
                    updatePositionControl(true);
                    input.blur();
                } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'PageUp' || event.key === 'PageDown') {
                    event.preventDefault();
                    const step = event.key.indexOf('Page') === 0 ? 10 : 1;
                    const direction = event.key === 'ArrowDown' || event.key === 'PageDown' ? -1 : 1;
                    input.value = String(Math.max(1, Math.min(bridge.state.items.length, (parseInt(input.value, 10) || bridge.state.currentIndex + 1) + direction * step)));
                    input.dataset.msDirty = '1';
                }
            });
            updatePositionControl(true);
        }

    function ensureMediaBox(wrap) {
            return globalThis.XGalleryCore.ensureMediaBox(document, wrap);
        }

    function syncVerticalFitMediaBox(media) {
            if (!bridge.state.overlay) return;
            const wrap = bridge.state.overlay.querySelector('.ms-media-wrap');
            if (!wrap) return;
            if (wrap.dataset.msVerticalFitBound !== '1' && typeof ResizeObserver !== 'undefined') {
                wrap.dataset.msVerticalFitBound = '1';
                let pending = false;
                const observer = new ResizeObserver(() => {
                    if (pending) return;
                    pending = true;
                    requestAnimationFrame(() => {
                        pending = false;
                        syncVerticalFitMediaBox();
                    });
                });
                observer.observe(wrap);
                bridge.state.mediaFitObserver = observer;
            }
            const box = ensureMediaBox(wrap);
            const target = (media && wrap.contains(media) ? media : null) || (box && box.querySelector('img.ms-media, video.ms-media')) ||
                (wrap && wrap.querySelector('img.ms-media, video.ms-media'));
            if (!box) return;
            if (!target || target.classList.contains('ms-pannable')) {
                box.style.removeProperty('width');
                box.style.removeProperty('height');
                return;
            }
            if (target.parentElement !== box) box.appendChild(target);

            const naturalWidth = target.videoWidth || target.naturalWidth || 0;
            const naturalHeight = target.videoHeight || target.naturalHeight || 0;
            const wrapWidth = wrap.clientWidth;
            const wrapHeight = wrap.clientHeight;
            if (!naturalWidth || !naturalHeight || !wrapWidth || !wrapHeight) return;

            const scale = Math.min(wrapWidth / naturalWidth, wrapHeight / naturalHeight);
            box.style.width = Math.max(1, Math.round(naturalWidth * scale)) + 'px';
            box.style.height = Math.max(1, Math.round(naturalHeight * scale)) + 'px';
            target.style.removeProperty('width');
            target.style.removeProperty('height');
            syncCaptionBounds();
        }

    function applyFitClass() {
            if (!bridge.state.overlay) return;
            if (bridge.fitVertical) bridge.state.overlay.classList.add('ms-fit-vertical');
            else bridge.state.overlay.classList.remove('ms-fit-vertical');
            syncVerticalFitMediaBox();
        }

    function toggleThumbs(forceHide) {
            if (!bridge.state.overlay) return;
            const el = bridge.state.overlay.querySelector('.ms-thumbs-wrap');

            const btn = bridge.state.overlay.querySelector('[data-act="thumbs-trigger"], [data-act="thumbs-toggle"]');
            if (!el) return;
            const hide = typeof forceHide === 'boolean' ? forceHide : !bridge.state.overlay.classList.contains('ms-thumbs-hidden');
            el.style.display = 'block';
            el.inert = hide;
            bridge.state.overlay.classList.toggle('ms-thumbs-hidden', hide);
            if (btn) btn.classList.toggle('active', !hide);
            updateDropdownActiveStates();
        }

    function prefersReducedMotion() {
            return !!bridge.minimalMotion || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        }

        // The flight ghost is the one piece of our UI that lives in the light DOM:
        // it has to sit above the overlay, and the overlay stylesheet is inside a
        // shadow root that cannot reach it. So every rule here is inline, and the
        // reduced-motion opt-out has to be a JS check rather than a media query.
    function releaseFlyHidden() {
            if (!bridge.state.overlay) return;
            bridge.state.overlay.querySelectorAll('[data-ms-fly-hidden]').forEach((node) => {
                node.removeAttribute('data-ms-fly-hidden');
                node.style.removeProperty('visibility');
            });
        }

    function cancelFlyGhost() {
            const live = bridge.state.flyGhost;
            bridge.state.flyGhost = null;
            if (live) {
                try { if (live.anim) live.anim.cancel(); } catch (e) { }
                try { live.ghost.remove(); } catch (e) { }
                if (live.timer) clearTimeout(live.timer);
            }
            releaseFlyHidden();
        }

        // What the ghost shows. A URL is not good enough: grid thumbnails are blob
        // URLs that get revoked as soon as the cell has loaded them, so a ghost
        // built from the cell's currentSrc failed to load and flew an empty box -
        // the flight ran, it just had nothing in it. The element in hand is already
        // decoded, so copy its pixels into a canvas instead: that cannot fail to
        // load, and it is on screen on the very first frame. Capped in size, since
        // the viewer's image can be many thousands of pixels wide.
    function snapshotGhostSource(el) {
            if (!el) return null;
            try {
                const w = el.tagName === 'VIDEO' ? el.videoWidth : el.naturalWidth;
                const h = el.tagName === 'VIDEO' ? el.videoHeight : el.naturalHeight;
                if (!w || !h) return null;
                if (el.tagName === 'IMG' && !el.complete) return null;
                const scale = Math.min(1, 1024 / Math.max(w, h));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(w * scale));
                canvas.height = Math.max(1, Math.round(h * scale));
                canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
                return canvas;
            } catch (e) {
                return null;
            }
        }

        // A FLIP between two on-screen rectangles. Animating the box itself rather
        // than a transform keeps an object-fit: cover ghost honest on every frame:
        // scaling one bitmap between a 3:2 stage and a 1:1 cell squashed it for the
        // whole flight, which is what the previous version did.
    function flyGhost(fromRect, toRect, src, options) {
            const opts = options || {};
            if (!src || !fromRect || !toRect) { releaseFlyHidden(); return; }
            if (!fromRect.width || !fromRect.height || !toRect.width || !toRect.height) { releaseFlyHidden(); return; }
            if (prefersReducedMotion() || typeof Element.prototype.animate !== 'function') { releaseFlyHidden(); return; }

            cancelFlyGhost();
            const fromRadius = typeof opts.fromRadius === 'number' ? opts.fromRadius : 6;
            const toRadius = typeof opts.toRadius === 'number' ? opts.toRadius : 4;
            let ghost;
            if (src && src.tagName === 'CANVAS') {
                ghost = src;
            } else {
                ghost = document.createElement('img');
                ghost.src = String(src);
            }
            ghost.setAttribute('aria-hidden', 'true');
            // Marked so the host-isolation rules, which hide every other child of
            // body while the gallery is open, leave the ghost visible.
            ghost.setAttribute('data-ms-fly-ghost', '1');
            ghost.style.cssText = 'position:fixed; z-index:2147483647; pointer-events:none; margin:0;'
                + ' object-fit:cover; visibility:visible;'
                + ' will-change:left, top, width, height, opacity;'
                + ' left:' + fromRect.left + 'px; top:' + fromRect.top + 'px;'
                + ' width:' + fromRect.width + 'px; height:' + fromRect.height + 'px;'
                + ' border-radius:' + fromRadius + 'px;';
            document.body.appendChild(ghost);

            if (opts.hide && opts.hide.style) {
                opts.hide.setAttribute('data-ms-fly-hidden', '1');
                opts.hide.style.visibility = 'hidden';
            }

            // 200ms on the layout easing, the pair the motion table allows for
            // anything that moves or resizes. The token itself only exists inside
            // the shadow sheet, so the value is repeated rather than referenced.
            const frames = [
                { left: fromRect.left + 'px', top: fromRect.top + 'px',
                  width: fromRect.width + 'px', height: fromRect.height + 'px',
                  borderRadius: fromRadius + 'px', opacity: 1 },
                { left: toRect.left + 'px', top: toRect.top + 'px',
                  width: toRect.width + 'px', height: toRect.height + 'px',
                  borderRadius: toRadius + 'px', opacity: opts.fadeOut ? 0 : 1 }
            ];
            if (opts.fadeOut) frames.splice(1, 0, { opacity: 1, offset: 0.55 });
            let anim = null;
            try {
                anim = ghost.animate(frames, {
                    duration: typeof opts.duration === 'number' ? opts.duration : 200,
                    easing: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
                    fill: 'both'
                });
            } catch (e) {
                try { ghost.remove(); } catch (e2) { }
                releaseFlyHidden();
                return;
            }

            const live = { ghost: ghost, anim: anim, timer: null };
            bridge.state.flyGhost = live;
            const done = () => {
                if (bridge.state.flyGhost !== live) return;
                bridge.state.flyGhost = null;
                if (live.timer) clearTimeout(live.timer);
                try { ghost.remove(); } catch (e) { }
                releaseFlyHidden();
            };
            anim.addEventListener('finish', done);
            anim.addEventListener('cancel', done);
            // Animations are throttled in a background tab, so never let the ghost
            // or the hidden cell depend on a frame that may never arrive.
            live.timer = setTimeout(done, 900);
        }

        // The grid wrap is display:none outside grid mode, so its scrollTop is
        // always 0 on the way in and the window painted only the first rows. Past
        // the first screenful that left no active cell to scroll to and no cell to
        // fly into, so both the scroll and the animation were silently skipped.
        // Scroll before the paint, not after it.
    function scrollGridToCurrent() {
            if (!bridge.state.overlay) return;
            const wrap = bridge.state.overlay.querySelector('.ms-grid-wrap');
            const grid = bridge.state.overlay.querySelector('.ms-grid');
            if (!wrap || !grid) return;
            const sizer = ensureGridWindow(grid, wrap);
            const m = gridMetrics(wrap, grid);
            const rows = Math.ceil(bridge.state.items.length / m.cols);
            // scrollTop is clamped to the current scrollHeight, so the sizer has to
            // be tall before the scroll rather than when paintGridWindow gets to it.
            sizer.style.height = Math.max(0, rows * m.rowH - m.gap) + 'px';
            const row = Math.floor(Math.max(0, bridge.state.currentIndex) / m.cols);
            const target = row * m.rowH - Math.max(0, (wrap.clientHeight - m.cell) / 2);
            const limit = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
            wrap.scrollTop = Math.max(0, Math.min(target, limit));
        }

        // Coming back out of the grid, renderCurrent is asynchronous: the media does
        // not exist, and is not sized, until the image decodes. Waiting for it meant
        // the flight only began after the user had already seen the image appear,
        // which reads as a teleport followed by a stray flash - so predict the
        // landing box instead and start immediately. The grid cell's own image is
        // already decoded, and its aspect ratio is the full image's, so a contain
        // fit inside the stage gives the destination to within a pixel or two; the
        // real media then arrives underneath and the ghost fades out over it.
    function flyFromCell(fromRect, src, aspect) {
            const overlay = bridge.state.overlay;
            if (!overlay || prefersReducedMotion()) return;
            const wrap = overlay.querySelector('.ms-media-wrap');
            if (!wrap) return;
            const wrapRect = wrap.getBoundingClientRect();
            if (wrapRect.width < 4 || wrapRect.height < 4) return;
            const ratio = (aspect > 0 ? aspect : (fromRect.height ? fromRect.width / fromRect.height : 1));
            let width = wrapRect.width;
            let height = width / ratio;
            if (height > wrapRect.height) {
                height = wrapRect.height;
                width = height * ratio;
            }
            flyGhost(fromRect, {
                left: wrapRect.left + (wrapRect.width - width) / 2,
                top: wrapRect.top + (wrapRect.height - height) / 2,
                width: width,
                height: height
            }, src, { fadeOut: true, fromRadius: 6, toRadius: 4, duration: 180 });
        }

    function setGridMode(on) {
            if (!bridge.state.overlay) return;
            const enable = !!on;
            if (enable === !!bridge.state.gridMode) return;

            let flyRect = null;
            let flySrc = '';
            let backRect = null;
            let backSrc = '';
            let backAspect = 0;
            if (enable) {
                disablePan();
                const mediaEl = bridge.state.overlay.querySelector('.ms-media-wrap img.ms-media.ms-ready, .ms-media-wrap video.ms-media');
                if (mediaEl) {
                    const r = mediaEl.getBoundingClientRect();
                    if (r.width > 2 && r.height > 2) {
                        flyRect = { left: r.left, top: r.top, width: r.width, height: r.height };
                        // Snapshot now: the stage is emptied below, and a URL
                        // would still have to decode before the ghost showed it.
                        flySrc = snapshotGhostSource(mediaEl)
                            || (mediaEl.tagName === 'IMG' ? (mediaEl.currentSrc || mediaEl.src || '') : (mediaEl.getAttribute('poster') || ''));
                    }
                }
                if (flyRect && !flySrc) {
                    const curEntry = bridge.state.items[bridge.state.currentIndex];
                    const curItem = curEntry ? (curEntry.item || curEntry) : null;
                    if (curItem) flySrc = curItem.thumbSrc || '';
                }
            } else {
                // Measure before ms-grid-mode is flipped below: after that the grid
                // is display:none and every rect reads zero. The grid is windowed
                // and pooled, so the cell for the current item may simply not be
                // painted (Escape after scrolling away) - that is a skip, not a
                // failure, and the return just happens without a flight.
                const grid = bridge.state.overlay.querySelector('.ms-grid');
                const cell = grid ? grid.querySelector('[data-grid-index="' + bridge.state.currentIndex + '"]') : null;
                const cellImg = cell ? cell.querySelector('img, video') : null;
                if (cell && cellImg) {
                    const r = cell.getBoundingClientRect();
                    if (r.width > 2 && r.height > 2) {
                        backRect = { left: r.left, top: r.top, width: r.width, height: r.height };
                        backSrc = snapshotGhostSource(cellImg);
                        // The cell is square and covers, so its own rect says
                        // nothing about the image's shape - the decoded thumbnail
                        // does.
                        const nw = cellImg.naturalWidth || cellImg.videoWidth || 0;
                        const nh = cellImg.naturalHeight || cellImg.videoHeight || 0;
                        backAspect = (nw && nh) ? nw / nh : 0;
                    }
                }
            }

            bridge.state.gridMode = enable;
            bridge.state.overlay.classList.toggle('ms-grid-mode', enable);
            if (enable) {
                const wrap = bridge.state.overlay.querySelector('.ms-media-wrap');
                if (wrap) {
                    const existingMedia = wrap.querySelectorAll('video, audio, iframe');
                    existingMedia.forEach(media => {
                        if (media.tagName === 'VIDEO' || media.tagName === 'AUDIO') {
                            media.pause();
                            media.removeAttribute('src');
                        }
                    });
                    wrap.innerHTML = '';
                }
                setTopbarLoading(false);
                // Scroll first, then paint: that is what makes the active cell
                // exist at all, and it drops the scrollIntoView that used to
                // repaint - and so re-pool - the cell a frame after the flight
                // had already started from it.
                scrollGridToCurrent();
                renderGrid();
                syncZoomSliderAvailability();
                const grid = bridge.state.overlay.querySelector('.ms-grid');
                const active = grid ? grid.querySelector('.ms-grid-cell.active') : null;
                if (active && flyRect && flySrc) {
                    flyGhost(flyRect, active.getBoundingClientRect(), flySrc, {
                        hide: active, fromRadius: 4, toRadius: 6
                    });
                }
            } else {
                bridge.state.cameFromGrid = true;
                renderThumbs();
                bridge.renderCurrent();
                if (backRect && backSrc) flyFromCell(backRect, backSrc, backAspect);

                if (bridge.state.tagsPanelWanted) bridge.applyTagsPanel(true);
            }
            updateButtons();
        }

    function renderGrid(options) {
            if (!bridge.state.overlay) return;
            bridge.syncCoreItems('grid-render');
            // Same rule as the strip: only items that were never in the gallery
            // before get an entrance. Cells are pooled and refilled on scroll, so
            // keying the animation to "cell filled" would animate every scroll.
            const gridKeys = new Set(bridge.state.items.map(thumbItemKey).filter(Boolean));
            if (!bridge.state.gridKnownKeys) bridge.state.gridKnownKeys = new Set(gridKeys);
            bridge.state.gridEnteringKeys = options && options.animateNew
                ? new Set(Array.from(gridKeys).filter((key) => !bridge.state.gridKnownKeys.has(key)))
                : null;
            gridKeys.forEach((key) => bridge.state.gridKnownKeys.add(key));
            const grid = bridge.state.overlay.querySelector('.ms-grid');
            const gridWrap = bridge.state.overlay.querySelector('.ms-grid-wrap');
            if (!grid) return;
            const loadMoreBtn = gridWrap ? gridWrap.querySelector('.ms-grid-loadmore') : null;
            if (loadMoreBtn) loadMoreBtn.textContent = 'Load more';
            syncGridWindow();
        }

        // ms-zoom-idle means "zoom does not apply to what is on the stage" - a
        // video, an iframe, nothing loaded yet, grid mode. It does NOT mean "zoom
        // mode is off": turning the Zoom button off leaves a still image on screen
        // that the slider still drives, because the slider's own input handler
        // re-enters pan mode. disablePan used to add the class unconditionally,
        // which is why the slider vanished when Zoom was switched off.
    function syncZoomSliderAvailability() {
            if (!bridge.state.overlay) return;
            const sliderWrap = bridge.state.overlay.querySelector('.ms-zoom-slider-wrap');
            const slider = bridge.state.overlay.querySelector('.ms-zoom-slider');
            if (!sliderWrap || !slider) return;
            const wrap = bridge.state.gridMode ? null : bridge.state.overlay.querySelector('.ms-media-wrap');
            const img = wrap ? wrap.querySelector('img.ms-media.ms-ready') : null;
            const usable = !!(img && img.naturalWidth && img.naturalHeight && wrap.clientWidth && wrap.clientHeight);
            sliderWrap.classList.toggle('ms-zoom-idle', !usable);
            sliderWrap.classList.toggle('ms-zoom-off', usable && !bridge.state.pan);
            if (usable && !bridge.state.pan) {
                // Also re-reads the value: zooming to 250% and then switching Zoom
                // off left the slider showing 250% for an image back at fit.
                const fitScale = containedImageScale(wrap, img);
                configureZoomSlider(slider, fitScale, fitScale, isTallStripImage(img) ? 12 : 4);
            }
        }

    function disablePan() {
            if (bridge.state.pan && bridge.state.pan.cleanup) {
                try { bridge.state.pan.cleanup(); } catch (e) { }
            }
            bridge.state.pan = null;
            syncVerticalFitMediaBox();
            updateButtons();
            syncZoomSliderAvailability();
        }

    function containedImageScale(wrap, img) {
            if (!wrap || !img || !img.naturalWidth || !img.naturalHeight) return 1;
            return Math.min(1, wrap.clientWidth / img.naturalWidth, wrap.clientHeight / img.naturalHeight);
        }

    function displayedImageScale(wrap, img) {
            if (!img || !img.naturalWidth) return 1;
            const rect = img.getBoundingClientRect();
            return rect.width > 0 ? rect.width / img.naturalWidth : containedImageScale(wrap, img);
        }

    function zoomScaleFromSlider(slider) {
            const min = Math.max(0.001, parseFloat(slider.dataset.scaleMin) || 0.01);
            const max = Math.max(min, parseFloat(slider.dataset.scaleMax) || 1);
            const position = Math.max(0, Math.min(1, (parseFloat(slider.value) || 0) / 1000));
            return min * Math.pow(max / min, position);
        }

    function paintZoomSlider(slider) {
            const progress = Math.max(0, Math.min(100, (parseFloat(slider.value) || 0) / 10));
            slider.style.setProperty('--ms-zoom-progress', progress + '%');
        }

    function configureZoomSlider(slider, scale, fitScale, fitMultiplier) {
            if (!slider) return;
            const fit = Math.max(0.005, fitScale || scale || 1);
            const multiplier = Math.max(4, Number(fitMultiplier) || Number(slider.dataset.fitMultiplier) || 4);
            const min = Math.max(0.005, fit * 0.25);
            const max = Math.max(1, fit * multiplier, scale || fit);
            const bounded = Math.max(min, Math.min(max, scale || fit));
            slider.min = 0;
            slider.max = 1000;
            slider.step = 2;
            slider.dataset.scaleMin = String(min);
            slider.dataset.scaleMax = String(max);
            slider.dataset.fitMultiplier = String(multiplier);
            slider.value = max === min ? 0 : Math.log(bounded / min) / Math.log(max / min) * 1000;
            paintZoomSlider(slider);
            const valueEl = bridge.state.overlay && bridge.state.overlay.querySelector('.ms-zoom-value');
            if (valueEl) valueEl.textContent = Math.round(bounded * 100) + '%';
        }

    function applyTitleRowHeight(px) {
            if (!bridge.state.overlay) return;
            const h = Math.round(Math.min(bridge.TITLE_ROW_MAX, Math.max(bridge.TITLE_ROW_MIN, px)));
            bridge.state.overlay.style.setProperty('--ms-reddit-row-h', h + 'px');

            const fs = Math.round(Math.min(28, Math.max(15, 15 + (h - bridge.TITLE_ROW_MIN) * 0.055)));
            bridge.state.overlay.style.setProperty('--ms-reddit-title-fs', fs + 'px');

            const lines = Math.max(1, Math.floor((h - 43) / Math.round(fs * 1.4)));
            bridge.state.overlay.style.setProperty('--ms-reddit-lines', String(lines));
            return h;
        }

    function applyTagsFontSize(px, persist) {
            if (!bridge.state.overlay) return;
            const size = Math.round(Math.min(bridge.MS_TAGS_FONT_MAX, Math.max(bridge.MS_TAGS_FONT_MIN, px || 15)));
            bridge.tagsFontSize = size;
            bridge.state.overlay.style.setProperty('--ms-tags-font', size + 'px');
            if (persist) {
                if (typeof bridge.savePreference === 'function') {
                    try { bridge.savePreference('MS_BETTER_TAGS_FONT', size); } catch (err) { }
                }
            }
        }

    function bindTitleRowResizer() {
            if (!bridge.state.overlay) return;
            const grip = bridge.state.overlay.querySelector('.ms-reddit-resizer');
            const row = bridge.state.overlay.querySelector('.ms-reddit-info-row');
            if (!grip || !row || grip.dataset.msBound === '1') return;
            grip.dataset.msBound = '1';

            let dragging = false;
            const onDown = (e) => {
                if (e.button !== 0) return;
                dragging = true;
                bridge.state.overlay.classList.add('ms-reddit-resizing');
                try { grip.setPointerCapture(e.pointerId); } catch (err) { }
                e.preventDefault();
                e.stopPropagation();
            };
            const onMove = (e) => {
                if (!dragging) return;

                const bottom = row.getBoundingClientRect().bottom;
                applyTitleRowHeight(bottom - e.clientY);
                e.preventDefault();
            };
            const onUp = (e) => {
                if (!dragging) return;
                dragging = false;
                bridge.state.overlay.classList.remove('ms-reddit-resizing');
                try { grip.releasePointerCapture(e.pointerId); } catch (err) { }
                const val = parseInt(bridge.state.overlay.style.getPropertyValue('--ms-reddit-row-h'), 10) || 0;
                if (val) {
                    bridge.titleRowHeight = val;
                    if (typeof bridge.savePreference === 'function') {
                        try { bridge.savePreference('MS_BETTER_REDDIT_H', val); } catch (err) { }
                    }
                }
            };
            grip.addEventListener('pointerdown', onDown);
            grip.addEventListener('pointermove', onMove);
            grip.addEventListener('pointerup', onUp);
            grip.addEventListener('pointercancel', onUp);
            grip.addEventListener('click', (e) => e.stopPropagation());

            if (bridge.titleRowHeight >= bridge.TITLE_ROW_MIN) applyTitleRowHeight(bridge.titleRowHeight);
        }

    function bindTagsPanelResizer() {
            if (!bridge.state.overlay) return;
            const grip = bridge.state.overlay.querySelector('.ms-tags-resizer');
            const overlayEl = bridge.state.overlay.querySelector('.ms-tags-overlay');
            if (!grip || !overlayEl || grip.dataset.msBound === '1') return;
            grip.dataset.msBound = '1';

            let dragging = false;
            const MIN_W = 240;
            const onDown = (e) => {
                if (e.button !== 0) return;
                dragging = true;
                bridge.state.overlay.classList.add('ms-tags-resizing');
                try { grip.setPointerCapture(e.pointerId); } catch (err) { }
                e.preventDefault();
                e.stopPropagation();
            };
            const onMove = (e) => {
                if (!dragging) return;
                const rect = overlayEl.getBoundingClientRect();
                const right = /right$/.test(bridge.state.overlay.dataset.infoLayout || '');
                const maxW = Math.max(MIN_W, window.innerWidth - 240);
                const next = Math.round(Math.min(maxW, Math.max(MIN_W, right ? rect.right - e.clientX : e.clientX - rect.left)));
                bridge.state.overlay.style.setProperty('--ms-tags-w', next + 'px');
                e.preventDefault();
            };
            const onUp = (e) => {
                if (!dragging) return;
                dragging = false;
                bridge.state.overlay.classList.remove('ms-tags-resizing');
                try { grip.releasePointerCapture(e.pointerId); } catch (err) { }
                const val = bridge.state.overlay.style.getPropertyValue('--ms-tags-w');
                if (val && typeof bridge.savePreference === 'function') {
                    try { bridge.savePreference('MS_BETTER_TAGS_W', parseInt(val, 10) || 0); } catch (err) { }
                }
            };
            grip.addEventListener('pointerdown', onDown);
            grip.addEventListener('pointermove', onMove);
            grip.addEventListener('pointerup', onUp);
            grip.addEventListener('pointercancel', onUp);
            grip.addEventListener('click', (e) => e.stopPropagation());

            if (typeof bridge.tagsPanelWidth === 'number' && bridge.tagsPanelWidth >= MIN_W) {
                bridge.state.overlay.style.setProperty('--ms-tags-w', bridge.tagsPanelWidth + 'px');
            }
            const shell = bridge.state.overlay;
            const layouts = ['left', 'right', 'edge-left', 'edge-right'];
            shell.dataset.infoLayout = layouts.includes(bridge.infoPanelLayout) ? bridge.infoPanelLayout : 'left';
            const setHeight = (height) => {
                const bounded = Math.max(160, Math.min(height, overlayEl.parentElement.clientHeight));
                shell.style.setProperty('--ms-info-height', bounded + 'px');
            };
            if (bridge.infoPanelHeight > 0) setHeight(bridge.infoPanelHeight);
            const bottom = document.createElement('div');
            bottom.className = 'ms-info-height-grip';
            bottom.title = 'Drag to resize height';
            overlayEl.appendChild(bottom);
            let heightDrag = null;
            bottom.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                heightDrag = { y: event.clientY, height: overlayEl.getBoundingClientRect().height };
                bottom.setPointerCapture(event.pointerId);
                event.preventDefault(); event.stopPropagation();
            });
            bottom.addEventListener('pointermove', (event) => {
                if (heightDrag) setHeight(heightDrag.height + event.clientY - heightDrag.y);
            });
            const finishHeight = () => {
                if (!heightDrag) return;
                heightDrag = null;
                bridge.savePreference('MS_INFO_HEIGHT', overlayEl.getBoundingClientRect().height);
                syncVerticalFitMediaBox();
            };
            bottom.addEventListener('pointerup', finishHeight);
            bottom.addEventListener('pointercancel', finishHeight);
            bottom.addEventListener('click', (event) => event.stopPropagation());
            const header = overlayEl.querySelector('.ms-tags-header');
            if (header) {
                header.title = 'Drag to dock left, right, or near either screen edge';
                let moving = false;
                header.addEventListener('pointerdown', (event) => {
                    if (event.button !== 0 || event.target.closest('button, a, input')) return;
                    moving = true;
                    header.setPointerCapture(event.pointerId);
                    event.preventDefault(); event.stopPropagation();
                });
                header.addEventListener('pointermove', (event) => {
                    if (!moving) return;
                    const x = event.clientX / window.innerWidth;
                    shell.dataset.infoLayout = x < .2 ? 'edge-left' : x > .8 ? 'edge-right' : x < .5 ? 'left' : 'right';
                });
                const finishMove = () => {
                    if (!moving) return;
                    moving = false;
                    bridge.savePreference('MS_INFO_LAYOUT', shell.dataset.infoLayout);
                    syncVerticalFitMediaBox();
                };
                header.addEventListener('pointerup', finishMove);
                header.addEventListener('pointercancel', finishMove);
                header.addEventListener('click', (event) => event.stopPropagation());
            }
        }

    function toggleTagsPanel(show, keepWanted) {
            if (!keepWanted) bridge.state.tagsPanelWanted = !!show;
            return bridge.applyTagsPanel(show);
        }

    function captionHtmlFromItem(item) {
            if (!item) return '';
            const postInfo = item.postInfo || null;
            const captions = (postInfo && Array.isArray(postInfo.captions)) ? postInfo.captions : [];
            let html = captions.map((cap) => cap && cap.html).filter(Boolean).join('');
            if (!html) html = item.description || item.caption || '';
            return html || '';
        }

    function captionFitsSnapchat(el) {
            if (!el) return false;
            const cs = window.getComputedStyle(el);
            const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.25) || 28;
            return el.scrollHeight <= (lh * 3) + 4;
        }

    function setCaptionMode(mode, item, fromRemote, edge) {
            bridge.captionMode = bridge.normalizeCaptionMode(mode);
            if (edge !== undefined) bridge.captionEdge = bridge.normalizeCaptionEdge(edge);
            if (!fromRemote && typeof bridge.savePreference === 'function') {
                try {
                    bridge.savePreference(bridge.CAPTION_MODE_KEY, bridge.captionMode);
                    bridge.savePreference(bridge.CAPTION_EDGE_KEY, bridge.captionEdge);
                } catch (e) { }
            }
            const current = item || (bridge.state.items[bridge.state.currentIndex] && (bridge.state.items[bridge.state.currentIndex].item || bridge.state.items[bridge.state.currentIndex]));
            updateMediaCaptionOverlay(current);
            if (bridge.state.overlay) {
                bridge.state.overlay.querySelectorAll('.ms-caption-mode button').forEach((btn) => {
                    const active = btn.getAttribute('data-caption-mode') === bridge.captionMode;
                    btn.classList.toggle('active', active);
                    btn.setAttribute('aria-pressed', String(active));
                });
            }
        }

    function clickCaptionModeButton(mode, item) {
            const next = bridge.nextCaptionPlacement(bridge.captionMode, bridge.captionEdge, mode);
            bridge.captionMode = next.mode;
            bridge.captionEdge = next.edge;
            setCaptionMode(bridge.captionMode, item, false, bridge.captionEdge);
        }

    function handleCaptionModeMessage(event) {
            if (!event || !event.data || event.data.type !== 'ms-gallery-caption-mode') return;
            setCaptionMode(event.data.mode, null, true, event.data.edge);
        }

    function applyCaptionSnapInset(overlay) {
            if (!overlay) return;
            const box = overlay.parentElement;
            const boxH = (box && box.clientHeight) || 0;
            const barH = overlay.offsetHeight || 40;
            const range = Math.max(1, boxH - barH);
            const y = bridge.normalizeCaptionSnapY(bridge.captionSnapY);
            overlay.style.top = Math.round(y * range) + 'px';
            overlay.style.bottom = 'auto';
        }

    function bindCaptionSnapDrag(overlay) {
            if (!overlay || overlay.dataset.msSnapDrag === '1') return;
            overlay.dataset.msSnapDrag = '1';
            let dragging = false;
            let startY = 0;
            let startTop = 0;
            let range = 1;
            overlay.addEventListener('pointerdown', (e) => {
                if (e.target.closest && e.target.closest('a')) return;
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                overlay.style.cursor = 'grabbing';
                try { overlay.setPointerCapture(e.pointerId); } catch (err) { }
                const box = overlay.parentElement;
                const boxH = (box && box.clientHeight) || 0;
                const barH = overlay.offsetHeight || 40;
                range = Math.max(1, boxH - barH);
                startY = e.clientY;
                startTop = overlay.offsetTop || 0;
            });
            overlay.addEventListener('pointermove', (e) => {
                if (!dragging) return;
                e.preventDefault();
                const top = Math.max(0, Math.min(range, startTop + (e.clientY - startY)));
                bridge.captionSnapY = bridge.normalizeCaptionSnapY(top / range);
                overlay.style.top = Math.round(top) + 'px';
                overlay.style.bottom = 'auto';
            });
            const endDrag = () => {
                if (!dragging) return;
                dragging = false;
                overlay.style.cursor = 'grab';
                if (typeof bridge.savePreference === 'function') {
                    try { bridge.savePreference('MS_CAPTION_SNAP_Y', bridge.captionSnapY); } catch (err) { }
                }
            };
            overlay.addEventListener('pointerup', endDrag);
            overlay.addEventListener('pointercancel', endDrag);
            overlay.addEventListener('click', (e) => e.stopPropagation());
        }

    let captionBoundsObserver = null;
    function syncCaptionBounds() {
            const wrap = bridge.state.overlay && bridge.state.overlay.querySelector('.ms-media-wrap');
            const caption = wrap && wrap.querySelector(':scope > .ms-caption-overlay');
            const media = wrap && wrap.querySelector('img.ms-media:not(.ms-loading-thumb), video.ms-media');
            if (!caption || !media) return;
            const outer = wrap.getBoundingClientRect();
            const rect = media.getBoundingClientRect();
            const left = Math.max(outer.left, rect.left), right = Math.min(outer.right, rect.right);
            const top = Math.max(outer.top, rect.top), bottom = Math.min(outer.bottom, rect.bottom);
            caption.style.left = Math.max(0, left - outer.left) + 'px';
            caption.style.right = 'auto';
            caption.style.width = Math.max(0, right - left) + 'px';
            const videoControlsInset = caption.classList.contains('ms-caption-video')
                && bridge.captionEdge !== 'top' ? 48 : 0;
            caption.style.maxHeight = Math.max(0, (bottom - top - videoControlsInset) * .38) + 'px';
            if (!caption.classList.contains('ms-caption-snapchat')) {
                caption.style.top = bridge.captionEdge === 'top' ? Math.max(0, top - outer.top) + 'px' : 'auto';
                caption.style.bottom = bridge.captionEdge === 'top'
                    ? 'auto'
                    : Math.max(0, outer.bottom - bottom + videoControlsInset) + 'px';
            }
        }
    function updateMediaCaptionOverlay(item) {
            if (captionBoundsObserver) { captionBoundsObserver.disconnect(); captionBoundsObserver = null; }
            if (!bridge.state.overlay) return;
            const wrap = bridge.state.overlay.querySelector('.ms-media-wrap');
            if (!wrap) return;
            wrap.querySelectorAll('.ms-caption-overlay').forEach((el) => el.remove());
            const slot = bridge.state.overlay.querySelector('.ms-panel-caption');
            const html = captionHtmlFromItem(item);
            let mode = bridge.captionMode;
            if (mode === 'popup' || !html || (!bridge.reservedPostHeader && !bridge.captionFeed)) {
                if (slot) slot.hidden = false;
                return;
            }
            const host = wrap;
            const overlay = document.createElement('div');
            const edge = bridge.captionEdge === 'top' ? 'top' : 'bottom';
            overlay.className = 'ms-caption-overlay ms-caption-' + edge
                + (item.type === 'video' ? ' ms-caption-video' : '')
                + (mode === 'snapchat' ? ' ms-caption-snapchat' : '');
            overlay.innerHTML = html;
            overlay.querySelectorAll('a').forEach((a) => {
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.addEventListener('click', (e) => e.stopPropagation());
            });
            host.appendChild(overlay);
            captionBoundsObserver = new ResizeObserver(syncCaptionBounds);
            captionBoundsObserver.observe(wrap);
            const media = wrap.querySelector('img.ms-media, video.ms-media');
            if (media) captionBoundsObserver.observe(media);
            syncCaptionBounds();
            if (mode === 'snapchat' && !captionFitsSnapchat(overlay)) {
                overlay.remove();
                mode = 'popup';
            } else if (mode === 'snapchat') {
                applyCaptionSnapInset(overlay);
                bindCaptionSnapDrag(overlay);
            }
            if (slot) slot.hidden = mode === 'popup' ? false : true;
        }

    function appendCaptionModeControls(content, item) {
            if (!content || (!bridge.reservedPostHeader && !bridge.captionFeed)) return;
            const row = document.createElement('div');
            row.className = 'ms-caption-mode';
            row.setAttribute('role', 'group');
            row.setAttribute('aria-label', 'Caption display mode');
            [['popup', 'Popup'], ['overlay', 'Overlay'], ['snapchat', 'Snapchat']].forEach(([mode, label]) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.setAttribute('data-caption-mode', mode);
                btn.setAttribute('aria-pressed', String(bridge.captionMode === mode));
                btn.textContent = label;
                if (bridge.captionMode === mode) btn.classList.add('active');
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    clickCaptionModeButton(mode, item);
                    row.querySelectorAll('button').forEach((button) => {
                        button.setAttribute('aria-pressed', String(button.getAttribute('data-caption-mode') === mode));
                    });
                });
                row.appendChild(btn);
            });
            content.appendChild(row);
        }

    function setTopbarLoading(on) {
            if (!bridge.state.overlay) return;
            const spinner = bridge.state.overlay.querySelector('.ms-topbar-spinner');

            if (spinner) spinner.style.visibility = on ? 'visible' : 'hidden';
        }

    function updateHdButton(status) {
            if (!bridge.state.overlay) return;
            const btn = bridge.state.overlay.querySelector('[data-act="hd"]');
            if (!btn) return;
            if (status === 'ready') {
                btn.style.display = '';
                btn.classList.remove('loading');
                btn.classList.remove('ms-hd-max');
                btn.title = 'Load full resolution';
            } else if (status === 'loading') {
                btn.style.display = '';
                btn.classList.add('loading');
                btn.classList.remove('ms-hd-max');
                btn.title = 'Loading full resolution...';
            } else if (status === 'max') {

                btn.style.display = '';
                btn.classList.remove('loading');
                btn.classList.add('ms-hd-max');
                btn.title = 'Showing the highest resolution available';
            } else {
                btn.style.display = 'none';
                btn.classList.remove('loading');
                btn.classList.remove('ms-hd-max');
            }

            updateTopbarCompact();
        }

    function enablePanForImage(wrap, img, opts) {
            if (!wrap || !img || !img.naturalWidth || !img.naturalHeight) return false;
            disablePan();

            const zoomMode = !!(opts && opts.zoom);
            let wrapW = wrap.clientWidth;
            let wrapH = wrap.clientHeight;
            if (!wrapW || !wrapH) return false;

            let scale;
            if (opts && typeof opts.scale === 'number') {

                scale = opts.scale;
            } else if (zoomMode) {
                scale = Math.min(1, displayedImageScale(wrap, img) * 1.5);
            } else if (bridge.fitVertical) {
                scale = Math.min(1, wrapH / img.naturalHeight);
            } else {
                scale = Math.min(1, wrapW / img.naturalWidth);
            }

            let dispW = Math.round(img.naturalWidth * scale);
            let dispH = Math.round(img.naturalHeight * scale);

            img.classList.add('ms-pannable');
            if (img.parentElement && img.parentElement.classList.contains('ms-media-box')) wrap.appendChild(img);

            img.style.width = img.naturalWidth + 'px';
            img.style.height = img.naturalHeight + 'px';
            img.style.transformOrigin = '0 0';
            img.style.setProperty('inset', '0 auto auto 0', 'important');
            img.style.setProperty('margin', '0', 'important');
            wrap.classList.add('ms-pan-enabled');

            let x = (wrapW - dispW) / 2;
            let y = dispH <= wrapH ? (wrapH - dispH) / 2 : 0;
            if (opts && typeof opts.initialX === 'number') x = opts.initialX;
            if (opts && typeof opts.initialY === 'number') y = opts.initialY;

            let panRaf = null;
            const clampAndApply = () => {
                if (dispW <= wrapW) x = (wrapW - dispW) / 2;
                else x = Math.min(0, Math.max(wrapW - dispW, x));
                if (dispH <= wrapH) y = (wrapH - dispH) / 2;
                else y = Math.min(0, Math.max(wrapH - dispH, y));
                const s = img.naturalWidth ? dispW / img.naturalWidth : 1;
                img.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + s + ')';
                syncCaptionBounds();
            };

            const scheduleClampAndApply = () => {
                if (panRaf !== null) return;
                panRaf = requestAnimationFrame(() => {
                    panRaf = null;
                    clampAndApply();
                });
            };
            clampAndApply();

            const panResize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
                const focalX = dispW ? (wrapW / 2 - x) / dispW : 0.5;
                const focalY = dispH ? (wrapH / 2 - y) / dispH : 0.5;
                wrapW = wrap.clientWidth;
                wrapH = wrap.clientHeight;
                if (wrapW && wrapH) {
                    x = wrapW / 2 - focalX * dispW;
                    y = wrapH / 2 - focalY * dispH;
                    scheduleClampAndApply();
                }
            }) : null;
            if (panResize) panResize.observe(wrap);

            const sliderWrap = bridge.state.overlay.querySelector('.ms-zoom-slider-wrap');
            const slider = bridge.state.overlay.querySelector('.ms-zoom-slider');
            if (sliderWrap && slider) {
                sliderWrap.classList.remove('ms-zoom-idle');
                configureZoomSlider(slider, scale, containedImageScale(wrap, img), isTallStripImage(img) ? 12 : 4);
            }

            let dragging = false;
            let lastX = 0;
            let lastY = 0;
            let downX = 0;
            let downY = 0;

            const onPointerDown = (e) => {
                if (e.button !== 0) return;
                dragging = true;
                lastX = e.clientX;
                lastY = e.clientY;
                downX = e.clientX;
                downY = e.clientY;
                if (bridge.state.pan) bridge.state.pan.moved = false;
                wrap.classList.add('ms-pan-dragging');
                try { img.setPointerCapture(e.pointerId); } catch (err) { }
                e.preventDefault();
            };
            const onPointerMove = (e) => {
                if (!dragging) return;
                x += e.clientX - lastX;
                y += e.clientY - lastY;
                lastX = e.clientX;
                lastY = e.clientY;
                if (bridge.state.pan && Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) {
                    bridge.state.pan.moved = true;
                }
                scheduleClampAndApply();
                e.preventDefault();
            };
            const onPointerUp = (e) => {
                dragging = false;
                wrap.classList.remove('ms-pan-dragging');
                try { img.releasePointerCapture(e.pointerId); } catch (err) { }
            };
            const onDragStart = (e) => e.preventDefault();

            img.addEventListener('pointerdown', onPointerDown);
            img.addEventListener('pointermove', onPointerMove);
            img.addEventListener('pointerup', onPointerUp);
            img.addEventListener('pointercancel', onPointerUp);
            img.addEventListener('dragstart', onDragStart);

            const hint = document.createElement('div');
            hint.className = 'ms-pan-hint';
            hint.textContent = bridge.panWheelScroll ? 'Hand tool: drag or scroll to pan' : 'Hand tool: drag to pan';
            if (!zoomMode) {
                wrap.appendChild(hint);
                setTimeout(() => { if (hint.parentNode) hint.remove(); }, 2200);
            }

            bridge.state.pan = {
                active: true,
                img: img,
                zoomed: zoomMode,
                returnToFill: !!(opts && opts.returnToFill),
                moved: false,
                view: () => ({ x: x, y: y, dispW: dispW, dispH: dispH }),
                panBy: (dx, dy) => {
                    x += dx;
                    y += dy;
                    scheduleClampAndApply();
                },
                updateZoom: (newScale) => {
                    const cx = dispW ? (wrapW / 2 - x) / dispW : 0.5;
                    const cy = dispH ? (wrapH / 2 - y) / dispH : 0.5;
                    dispW = img.naturalWidth * newScale;
                    dispH = img.naturalHeight * newScale;
                    x = wrapW / 2 - cx * dispW;
                    y = wrapH / 2 - cy * dispH;
                    clampAndApply();
                    if (slider) {
                        configureZoomSlider(slider, newScale, containedImageScale(wrap, img));
                    }
                },
                cleanup: () => {
                    if (panResize) panResize.disconnect();
                    if (panRaf !== null) { cancelAnimationFrame(panRaf); panRaf = null; }
                    img.removeEventListener('pointerdown', onPointerDown);
                    img.removeEventListener('pointermove', onPointerMove);
                    img.removeEventListener('pointerup', onPointerUp);
                    img.removeEventListener('pointercancel', onPointerUp);
                    img.removeEventListener('dragstart', onDragStart);
                    img.classList.remove('ms-pannable');
                    img.style.width = '';
                    img.style.height = '';
                    img.style.transform = '';
                    img.style.transformOrigin = '';
                    img.style.removeProperty('inset');
                    img.style.removeProperty('margin');
                    wrap.classList.remove('ms-pan-enabled', 'ms-pan-dragging');
                    if (hint.parentNode) hint.remove();
                }
            };
            updateButtons();
            return true;
        }

    function shouldAutoPan(wrap, img) {
            if (!wrap || !img || !img.naturalWidth || !img.naturalHeight) return false;
            const wrapW = wrap.clientWidth;
            const wrapH = wrap.clientHeight;
            if (!wrapW || !wrapH) return false;

            if (img.naturalHeight < img.naturalWidth * 3.5) return false;
            const fillScale = Math.min(1, Math.max(wrapW / img.naturalWidth, wrapH / img.naturalHeight));
            return img.naturalHeight * fillScale > wrapH * 1.15;
        }

    function isTallStripImage(img) {
            return !!(img && img.naturalWidth && img.naturalHeight / Math.max(1, img.naturalWidth) >= 2.2);
        }

    function togglePanMode() {
            if (!bridge.state.overlay || bridge.state.gridMode) return;
            const entry = bridge.state.items[bridge.state.currentIndex];
            const item = entry ? (entry.item || entry) : null;
            if (bridge.state.pan && bridge.state.pan.active) {
                if (item) item.msNoAutoPan = true;
                disablePan();
                updateButtons();
                return;
            }
            const wrap = bridge.state.overlay.querySelector('.ms-media-wrap');
            const img = wrap ? wrap.querySelector('img.ms-media.ms-ready') : null;
            if (wrap && img) {
                if (item) delete item.msNoAutoPan;
                enablePanForImage(wrap, img);
            }
        }

    function clearFullscreenIdleTimer() {
            if (bridge.fullscreenIdleTimer) {
                clearTimeout(bridge.fullscreenIdleTimer);
                bridge.fullscreenIdleTimer = null;
            }
        }

    function scheduleFullscreenIdleHide() {
            clearFullscreenIdleTimer();
            bridge.fullscreenIdleTimer = setTimeout(() => {
                if (!bridge.state.overlay || !bridge.state.stageFullscreen) return;
                if (bridge.state.overlay.querySelector('.ms-gallery-topbar:hover')) {
                    scheduleFullscreenIdleHide();
                    return;
                }
                bridge.state.overlay.classList.add('ms-topbar-idle');
            }, bridge.FULLSCREEN_IDLE_MS);
        }

    function wakeFullscreenTopbar() {
            if (!bridge.state.overlay || !bridge.state.stageFullscreen) return;
            bridge.state.overlay.classList.remove('ms-topbar-idle');
            scheduleFullscreenIdleHide();
        }

    function toggleStageFullscreen() {
            if (!bridge.state.overlay || bridge.state.gridMode) return;
            bridge.state.stageFullscreen = !bridge.state.stageFullscreen;
            bridge.state.overlay.classList.toggle('ms-stage-fullscreen', bridge.state.stageFullscreen);
            disablePan();
            updateButtons();
            if (bridge.state.stageFullscreen) {
                wakeFullscreenTopbar();
            } else {
                clearFullscreenIdleTimer();
                bridge.state.overlay.classList.remove('ms-topbar-idle');
            }
        }

    function handleImageZoomClick(wrap, img, item, e) {
            if (bridge.state.pan && bridge.state.pan.moved) {
                bridge.state.pan.moved = false;
                return;
            }

            if (bridge.state.pan && bridge.state.pan.active && bridge.state.pan.zoomed) {
                const returnToFill = bridge.state.pan.returnToFill;
                disablePan();
                if (returnToFill) enablePanForImage(wrap, img);
                return;
            }

            const rect = img.getBoundingClientRect();
            if (!img.naturalWidth || !rect.width) return;
            const wasFill = !!(bridge.state.pan && bridge.state.pan.active);
            const px = (e.clientX - rect.left) / rect.width;
            const py = (e.clientY - rect.top) / rect.height;
            const wrapRect = wrap.getBoundingClientRect();
            const currentScale = rect.width / img.naturalWidth;
            const isTallStrip = isTallStripImage(img);
            // Click zoom used to stop at 100% of the source pixels, so on a large
            // screen - where a photo already fits at close to 1:1 - a click moved
            // almost nothing, and on an image smaller than the stage it did
            // nothing at all. The slider has always gone further (see
            // configureZoomSlider: fit x 4, or x 12 for a tall strip), so match it
            // and let both controls reach the same place.
            const maxScale = Math.max(1, containedImageScale(wrap, img) * (isTallStrip ? 12 : 4));
            const nextScale = Math.min(maxScale, currentScale * (isTallStrip ? 4 : 1.5));
            if (nextScale <= currentScale * 1.01) return;
            enablePanForImage(wrap, img, {
                zoom: true,
                scale: nextScale,
                initialX: (e.clientX - wrapRect.left) - px * img.naturalWidth * nextScale,
                initialY: (!wasFill && isTallStrip) ? 0 : (e.clientY - wrapRect.top) - py * img.naturalHeight * nextScale,
                returnToFill: false
            });
        }

    function createPlaceholderIcon(isVideo) {
            return globalThis.XGalleryCore.createPlaceholderIcon(document, isVideo);
        }

    function getPastelColorForGroupId(groupId, alpha) {
            if (!groupId) return 'rgba(255, 255, 255, 0.25)';
            let hash = 0;
            for (let i = 0; i < groupId.length; i++) {
                hash = groupId.charCodeAt(i) + ((hash << 5) - hash);
            }
            const hue = Math.abs(hash % 360);
            if (typeof alpha === 'number' && alpha >= 0 && alpha < 1) return `hsla(${hue}, 35%, 85%, ${alpha})`;
            return `hsl(${hue}, 35%, 85%)`;
        }

    function getSourceClass(item) {
            return bridge.sourcePresentationClass(item);
        }

    function promoteLazyThumbVideo(vid) {
            const url = vid && vid.dataset ? vid.dataset.msLazySrc : '';
            // The observer fires a frame late; by then the cell may already have
            // been refilled with something else, and starting a fetch for a node
            // nobody will show is pure waste.
            if (!url || vid.src || !vid.isConnected) return;
            delete vid.dataset.msLazySrc;
            vid.preload = 'metadata';
            vid.src = url;
        }

    function promoteLazyMp4Poster(img) {
            if (!img || !img.isConnected || img.dataset.msMp4Started) return;
            img.dataset.msMp4Started = '1';
            bridge.mp4PosterForItem(img._msPosterItem).then((dataUrl) => {
                if (!img.isConnected) return;
                img.src = dataUrl;
                img.classList.add('ms-loaded');
            }).catch(() => {
                if (typeof img._msPosterFail === 'function') img._msPosterFail();
            });
        }

    function observeLazyThumb(el) {
            if (typeof IntersectionObserver === 'undefined') {
                if (el.tagName === 'VIDEO') promoteLazyThumbVideo(el);
                else promoteLazyMp4Poster(el);
                return;
            }
            if (!bridge.lazyThumbObserver) {
                bridge.lazyThumbObserver = new IntersectionObserver((entries, obs) => {
                    entries.forEach((e) => {
                        if (!e.isIntersecting) return;
                        obs.unobserve(e.target);
                        if (e.target.tagName === 'VIDEO') promoteLazyThumbVideo(e.target);
                        else promoteLazyMp4Poster(e.target);
                    });
                }, { rootMargin: '300px' });
            }
            bridge.lazyThumbObserver.observe(el);
        }

    function createLazyThumbVideo(url, onError) {
            const vid = document.createElement('video');
            vid.preload = 'none';
            vid.muted = true;
            vid.playsInline = true;
            vid.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;display:block;background:#111;';
            vid.dataset.msLazySrc = url;
            if (onError) vid.onerror = onError;
            observeLazyThumb(vid);
            return vid;
        }

    function createLazyMp4PosterImg(item, onError) {
            const img = document.createElement('img');
            img.referrerPolicy = 'no-referrer';
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;display:block;background:#111;';
            img.dataset.msLazyMp4 = '1';
            img._msPosterItem = item;
            img._msPosterFail = onError;
            observeLazyThumb(img);
            return img;
        }

    function isStaticVideoThumbUrl(url) {
            if (!url) return false;
            if (typeof bridge.isPlaceholderUrl === 'function' && bridge.isPlaceholderUrl(url)) return false;
            if (/^data:image\/(jpeg|jpg|png|gif|webp)/i.test(url)) return true;
            return typeof bridge.isImageThumbSource === 'function' && bridge.isImageThumbSource(url);
        }

    function mayBeAnimatedImageUrl(url) {
            const value = String(url || '');
            if (/^data:image\/(?:gif|webp)/i.test(value)) return true;
            if (/^(?:data|blob):/i.test(value)) return false;
            return /\.(?:gif|webp)(?:[?#]|$)/i.test(value.split('?')[0]) || /[?&]format=(?:gif|webp)/i.test(value);
        }

    function appendFrozenVideoThumb(host, url, item, onError) {
            const img = document.createElement('img');
            img.referrerPolicy = 'no-referrer';
            img.onload = () => img.classList.add('ms-loaded');
            if (onError) img.onerror = () => onError(img);
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;display:block;background:#111;';
            host.appendChild(img);
            bridge.setCachedImgSrc(img, url, item);
        }

    function appendStaticVideoThumb(host, url, onError) {
            const img = document.createElement('img');
            img.referrerPolicy = 'no-referrer';
            if (onError) img.onerror = () => onError(img);
            img.src = url;
            img.classList.add('ms-loaded');
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;display:block;background:#111;';
            host.appendChild(img);
        }

    function thumbPlanInput(item, thumbSrc) {
            return {
                frozen: item && item._frozenThumb,
                thumbSrc: thumbSrc,
                itemThumbSrc: item && item.thumbSrc,
                src: item && item.src,
                isPlaceholderUrl: (url) => typeof bridge.isPlaceholderUrl === 'function' && bridge.isPlaceholderUrl(url),
                isImageUrl: isStaticVideoThumbUrl,
                mayAnimate: mayBeAnimatedImageUrl,
                canExtract: () => !!(bridge.canExtractMp4Poster && bridge.canExtractMp4Poster(item, (item && item.src) || thumbSrc)),
                // A <video> in a cell is opt-in and nothing opts in: see thumbs.js.
                allowVideoElement: bridge.allowThumbVideoElements === true
            };
        }

    function planThumbFor(item, thumbSrc) {
            return globalThis.XGalleryCore.planVideoThumb(thumbPlanInput(item, thumbSrc));
        }

    function thumbMediaIsPlaceholder(item, thumbSrc) {
            return planThumbFor(item, thumbSrc).kind === 'placeholder';
        }

    function appendVideoThumbMedia(host, item, thumbSrc, isVideo, placeholderClass) {
            const fail = function (el) {
                if (el && el.parentNode !== host) return;
                if (!host.classList.contains(placeholderClass)) {
                    host.classList.add(placeholderClass);
                    host.innerHTML = '';
                    host.appendChild(createPlaceholderIcon(isVideo));
                }
            };
            // A poster that 404s is not the end of the road: the file itself still
            // has a first frame in it.
            const fallBackToExtract = (failedImage) => {
                if (failedImage && failedImage.parentNode !== host) return;
                if (!bridge.canExtractMp4Poster || !bridge.canExtractMp4Poster(item, item && item.src)) {
                    fail(failedImage);
                    return;
                }
                if (failedImage) failedImage.remove();
                const img = createLazyMp4PosterImg(item, function () { fail(img); });
                host.appendChild(img);
            };
            const plan = planThumbFor(item, thumbSrc);
            if (plan.kind === 'frozen') {
                appendStaticVideoThumb(host, plan.url);
                return;
            }
            if (plan.kind === 'still') {
                appendStaticVideoThumb(host, plan.url, fallBackToExtract);
                return;
            }
            if (plan.kind === 'freeze') {
                // The poster is a GIF or a WebP - the very thing that used to end
                // up playing in the strip. It goes through the inspect-and-freeze
                // path, which paints one frame and never the moving original.
                if (typeof bridge.setCachedImgSrc === 'function') {
                    appendFrozenVideoThumb(host, plan.url, item, fallBackToExtract);
                    return;
                }
                fallBackToExtract(null);
                return;
            }
            if (plan.kind === 'extract') {
                const img = createLazyMp4PosterImg(item, function () { fail(img); });
                host.appendChild(img);
                return;
            }
            if (plan.kind === 'video') {
                const playUrl = plan.url.includes('#t=') ? plan.url : (plan.url + '#t=0.1');
                const vid = createLazyThumbVideo(playUrl, function () { fail(vid); });
                host.appendChild(vid);
                return;
            }
            host.classList.add(placeholderClass);
            host.appendChild(createPlaceholderIcon(isVideo));
        }

    function stopThumbTrackAnimation() {
            if (bridge.state.thumbScrollRaf === null) return;
            cancelAnimationFrame(bridge.state.thumbScrollRaf);
            bridge.state.thumbScrollRaf = null;
        }

    function animateThumbTrackTo(track, target) {
            stopThumbTrackAnimation();
            const start = track.scrollLeft;
            const distance = target - start;
            const reducedMotion = prefersReducedMotion();
            if (reducedMotion || Math.abs(distance) < 1) {
                track.scrollLeft = target;
                return;
            }
            // Hand-run, not the browser's own smooth scrolling. Native smooth
            // scroll has its own pace - about twice as long as this - and there is
            // no way to cut it short, so moving quickly through a gallery left the
            // strip still travelling to the item before last. These frames are
            // cheap now that a scroll read no longer lays out the page.
            const started = bridge.performance.now();
            const duration = Math.min(180, 110 + Math.abs(distance) / 8);
            const step = (now) => {
                const progress = Math.min(1, (now - started) / duration);
                const eased = 1 - Math.pow(1 - progress, 3);
                track.scrollLeft = start + distance * eased;
                if (progress < 1) bridge.state.thumbScrollRaf = requestAnimationFrame(step);
                else bridge.state.thumbScrollRaf = null;
            };
            bridge.state.thumbScrollRaf = requestAnimationFrame(step);
        }

    function setActiveThumb(thumbs, scroll) {
            if (!bridge.state.overlay) return;
            if (scroll) {
                bridge.state.thumbsFollowCenter = true;
                syncThumbsWindow({ center: true });
            }
            const track = bridge.state.overlay.querySelector('.ms-thumbs-track');
            if (!track) return;
            const activeThumb = track.querySelector('.ms-thumb[data-index="' + bridge.state.currentIndex + '"]');
            const prev = track.querySelector('.ms-thumb.active');
            if (prev && prev !== activeThumb) prev.classList.remove('active');
            if (activeThumb) activeThumb.classList.add('active');
        }

    function thumbStripCenterTarget(track, index) {
            const n = bridge.state.items.length;
            if (!track || !n) return 0;
            const sizer = track.querySelector('.ms-thumbs-sizer');
            const width = track.clientWidth;
            const span = (sizer && sizer.offsetWidth) || (n * bridge.MS_THUMB_STRIDE);
            const maxScroll = Math.max(0, span - width);
            return Math.max(0, Math.min(maxScroll, index * bridge.MS_THUMB_STRIDE - width / 2 + bridge.MS_THUMB_STRIDE / 2));
        }

    function applyThumbStripCenter(track, animate) {
            if (!track) return;
            if (!track.clientWidth) {
                if (bridge.state.thumbsCenterRetry) return;
                bridge.state.thumbsCenterRetry = requestAnimationFrame(() => {
                    bridge.state.thumbsCenterRetry = null;
                    if (!bridge.state.overlay) return;
                    const next = bridge.state.overlay.querySelector('.ms-thumbs-track');
                    if (next && next.clientWidth) applyThumbStripCenter(next, false);
                });
                return;
            }
            const target = thumbStripCenterTarget(track, bridge.state.currentIndex);
            if (animate) animateThumbTrackTo(track, target);
            else {
                stopThumbTrackAnimation();
                if (Math.abs(track.scrollLeft - target) >= 1) track.scrollLeft = target;
            }
        }

    function thumbSourceClass(item) {
            return getSourceClass(item);
        }

    function thumbItemKey(entry) {
            const item = entry && (entry.item || entry);
            if (!item) return '';
            item._msCoreThumbKey = String(bridge.mediaKey(item));
            return item._msCoreThumbKey;
        }

    function thumbPreviewRevision(entry) {
            const item = entry && (entry.item || entry);
            if (!item) return '';
            const rawSource = String(item._frozenThumb || item.thumbSrc || item.src || '');
            const source = bridge.thumbnailIdentity ? bridge.thumbnailIdentity(rawSource) : rawSource;
            const token = source.length > 180
                ? source.length + ':' + source.slice(0, 96) + ':' + source.slice(-48)
                : source;
            // Only an animated result changes what the cell should show (a frozen
            // frame). Learning that a thumbnail is static used to bump the
            // revision too, so the next repaint rebuilt a cell that was already
            // showing the right picture - with a new, spinning image. The MIME
            // learned from the bytes was still in here: on hosts where the
            // thumbnail is the original, a JPEG is classified from its first bytes
            // long before it finishes loading, and the refill restarted that
            // download from zero.
            const animated = (bridge.isFreezableAnimatedThumb && bridge.isFreezableAnimatedThumb(item)) || !!item.thumbnailAnimated;
            return token + '|' + String(item.type || '') + '|' + Number(!!item.isVideo)
                + '|' + Number(animated) + '|' + (animated ? String(item.thumbnailFormat || item.detectedFormat || '') : '');
        }

    function takeThumbVisual(el) {
            if (!el) return null;
            const visual = Array.from(el.children).reverse().find((child) => {
                if (!child || child.classList.contains('ms-thumb-video-icon') || child.classList.contains('ms-thumb-gif-icon')) return false;
                if (child.matches && child.matches('img')) return child.complete && child.naturalWidth > 0;
                return child.matches && child.matches('svg');
            });
            if (!visual) return null;
            if (bridge.lazyThumbObserver) {
                try { bridge.lazyThumbObserver.unobserve(visual); } catch (e) { }
            }
            visual.remove();
            visual.classList.remove('ms-thumb-handoff-in', 'ms-thumb-handoff-ready', 'ms-thumb-handoff-leaving');
            visual.classList.add('ms-thumb-handoff-old');
            return visual;
        }

    function armThumbHandoff(el, oldVisual, revision) {
            if (!el || !oldVisual) return;
            const incoming = Array.from(el.children).find((child) =>
                child !== oldVisual && child.matches && child.matches('img, video'));
            if (!incoming) {
                oldVisual.remove();
                return;
            }
            incoming.classList.add('ms-thumb-handoff-in');
            el.insertBefore(oldVisual, incoming);
            const finish = async () => {
                if (incoming.tagName === 'IMG' && incoming.decode) {
                    try { await incoming.decode(); } catch (e) { return; }
                }
                if (!incoming.isConnected || incoming.parentNode !== el || el.dataset.msThumbRevision !== revision) return;
                incoming.classList.add('ms-thumb-handoff-ready');
                oldVisual.classList.add('ms-thumb-handoff-leaving');
                if (el._msThumbHandoffTimer) clearTimeout(el._msThumbHandoffTimer);
                el._msThumbHandoffTimer = setTimeout(() => {
                    el._msThumbHandoffTimer = null;
                    if (oldVisual.parentNode === el) oldVisual.remove();
                    incoming.classList.remove('ms-thumb-handoff-in', 'ms-thumb-handoff-ready');
                }, 180);
            };
            if (incoming.tagName === 'IMG') {
                incoming.addEventListener('load', finish, { once: true });
                if (incoming.complete && incoming.naturalWidth) requestAnimationFrame(finish);
            } else {
                incoming.addEventListener('loadeddata', finish, { once: true });
                if (incoming.readyState >= 2) requestAnimationFrame(finish);
            }
        }

    function resetMediaThumbEl(el) {
            if (!el) return;
            el.querySelectorAll('img').forEach(img => {
                // The adapter's cancel is deferred a tick on purpose: a repaint
                // resets a cell and re-queues the very same thumbnail in the same
                // pass, and cancelling on the spot would throw the in-flight bytes
                // away every time the strip scrolls. It releases the gate slot
                // too, so nothing here may abort the gate directly.
                if (img._msCancelThumb) img._msCancelThumb();
                img.removeAttribute('src');
                // The cell is going back in the pool but the img may outlive it in
                // a handoff animation; without this it keeps the whole item alive.
                if (img._msPosterItem) img._msPosterItem = null;
            });
            if (el._msThumbHandoffTimer) {
                clearTimeout(el._msThumbHandoffTimer);
                el._msThumbHandoffTimer = null;
            }
            if (bridge.lazyThumbObserver) el.querySelectorAll('[data-ms-lazy-mp4]').forEach(img => bridge.lazyThumbObserver.unobserve(img));
            const vid = el.querySelector('video');
            if (vid) {
                try {
                    vid.pause();
                    vid.removeAttribute('src');
                    vid.load();
                } catch (e) { }
                if (typeof bridge.lazyThumbObserver !== 'undefined' && bridge.lazyThumbObserver) {
                    try { bridge.lazyThumbObserver.unobserve(vid); } catch (e) { }
                }
            }
            el.innerHTML = '';
            el.classList.remove('ms-thumb-entering');
            el.removeAttribute('data-hd-src');
            delete el.dataset.msKey;
            delete el.dataset.msThumbRevision;
        }

    function onWindowedThumbClick(e) {
            if (bridge.state.dragData && bridge.state.dragData.justDragged) {
                bridge.state.dragData.justDragged = false;
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const btn = e.currentTarget;
            const index = parseInt(btn.getAttribute('data-index'), 10);
            if (!Number.isFinite(index) || index < 0 || index >= bridge.state.items.length) return;
            e.preventDefault();
            e.stopPropagation();
            bridge.rememberNavigationDirection(bridge.state.currentIndex, index, bridge.state.items.length);
            bridge.state.currentIndex = index;
            const entry = bridge.state.items[index];
            if (entry && entry.node) bridge.state.activeNode = entry.node;
            bridge.renderCurrent();
        }

    function onWindowedGridClick(e) {
            const cell = e.currentTarget;
            const index = parseInt(cell.getAttribute('data-grid-index'), 10);
            if (!Number.isFinite(index) || index < 0 || index >= bridge.state.items.length) return;
            e.preventDefault();
            e.stopPropagation();
            bridge.rememberNavigationDirection(bridge.state.currentIndex, index, bridge.state.items.length);
            bridge.state.currentIndex = index;
            const entry = bridge.state.items[index];
            if (entry && entry.node) bridge.state.activeNode = entry.node;
            setGridMode(false);
        }

    function fillThumbButton(btn, entry, index, groupCounts, visible) {
            const key = thumbItemKey(entry);
            const revision = thumbPreviewRevision(entry);
            const oldVisual = btn.dataset.msKey === key && btn.dataset.msThumbRevision !== revision
                ? takeThumbVisual(btn) : null;
            resetMediaThumbEl(btn);
            const item = entry.item || entry;
            const thumbSrc = item.thumbSrc || item.src;
            const hdSrc = bridge.getHdSrc(item);
            if (hdSrc) btn.setAttribute('data-hd-src', hdSrc);
            const cacheClass = (hdSrc && !bridge.state.cachedImageUrls.has(hdSrc) && !item._msMediaLoaded) ? ' ms-uncached' : '';
            const isVideo = item.type === 'video' || item.type === 'iframe' || item.expectedVideo || item.xUnplayable;
            const hasPoster = !!(item.thumbSrc && item.thumbSrc !== item.src && !bridge.isPlaceholderUrl(item.thumbSrc));
            const isPlaceholder = thumbMediaIsPlaceholder(item, thumbSrc);
            btn.setAttribute('data-index', String(index));
            btn.dataset.msKey = key;
            btn.dataset.msThumbRevision = revision;
            btn.style.display = '';
            btn.style.left = (index * bridge.MS_THUMB_STRIDE) + 'px';
            btn.style.boxShadow = '';
            const animated = bridge.isFreezableAnimatedThumb(item);
            globalThis.XGalleryCore.renderThumbnailCell({
                document: document,
                host: btn,
                baseClass: 'ms-thumb',
                absoluteClass: ' ms-thumb-abs',
                placeholderClass: 'ms-placeholder',
                sourceClass: thumbSourceClass(item),
                cacheClass: cacheClass,
                active: index === bridge.state.currentIndex,
                visible: visible !== false,
                hdSrc: hdSrc,
                isVideo: isVideo,
                isAnimated: animated,
                animatedLabel: animated ? bridge.animatedThumbLabel(item) : '',
                isPlaceholder: isPlaceholder,
                isVideoThumb: isVideo,
                sourceUrl: item.src,
                appendVideo: (host) => appendVideoThumbMedia(host, item, thumbSrc, isVideo, 'ms-placeholder'),
                loadImage: (img) => {
                    img._msThumbDistance = Math.abs(index - bridge.state.currentIndex);
                    if (animated) {
                        bridge.freezeAnimatedThumbnail(img, item);
                    } else {
                        bridge.setCachedImgSrc(img, thumbSrc, item);
                    }
                }
            });
            paintThumbAttachmentBadge(btn, item);
            if (oldVisual && !isPlaceholder) armThumbHandoff(btn, oldVisual, revision);
            if (bridge.state.thumbEnteringKeys && bridge.state.thumbEnteringKeys.has(btn.dataset.msKey)) {
                btn.classList.add('ms-thumb-entering');
            }
        }

    // A post can carry files the gallery cannot show (a layered file, an archive,
    // a folder of them). The thumbnail says so with a small count on its corner,
    // so they are findable without opening every post's Info panel.
    function paintThumbAttachmentBadge(host, item) {
            const existing = host.querySelector('.ms-thumb-att-badge');
            const count = Math.max(0, Math.floor(Number(item && item.attachmentCount) || 0));
            if (!count) {
                if (existing) existing.remove();
                return;
            }
            const badge = existing || document.createElement('span');
            badge.className = 'ms-thumb-att-badge';
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.title = count === 1 ? '1 attachment' : count + ' attachments';
            if (!existing) host.appendChild(badge);
        }

    function invalidateThumbGroupData() {
            bridge.state.thumbGroupData = null;
        }

    // A cell was refilled or a mark changed under an unchanged window.
    function invalidateThumbWindow() {
            const track = bridge.state.overlay && bridge.state.overlay.querySelector('.ms-thumbs-track');
            if (track) track._msWindowSignature = '';
        }

    function thumbGroupData() {
            const cached = bridge.state.thumbGroupData;
            if (cached && cached.items === bridge.state.items && cached.length === bridge.state.items.length) return cached;
            // Bumped whenever the data behind the strip is rebuilt, so a window
            // that looks unchanged is still repainted when its contents changed.
            bridge.state.thumbDataRevision = (bridge.state.thumbDataRevision || 0) + 1;
            const counts = new Map();
            const runs = [];
            bridge.state.items.forEach((entry) => {
                const it = entry.item || entry;
                const gid = it.groupId || '';
                if (!gid) return;
                const extra = bridge.extraMediaCount(it);
                counts.set(gid, (counts.get(gid) || 0) + 1 + extra);
            });
            let start = 0;
            while (start < bridge.state.items.length) {
                const gid = (bridge.state.items[start].item || bridge.state.items[start]).groupId || '';
                let end = start + 1;
                while (end < bridge.state.items.length && ((bridge.state.items[end].item || bridge.state.items[end]).groupId || '') === gid) end++;
                if (gid && (counts.get(gid) || 0) > 1) runs.push({ gid: gid, start: start, end: end });
                start = end;
            }
            // Super groups: a block of several posts (site-agnostic; a BDSMLR
            // activity block, say). One level above groupId, drawn as an outer
            // outline around the post outlines.
            const superRuns = [];
            start = 0;
            while (start < bridge.state.items.length) {
                const first = bridge.state.items[start].item || bridge.state.items[start];
                const sid = first.superGroupId ? String(first.superGroupId) : '';
                let end = start + 1;
                while (end < bridge.state.items.length) {
                    const it = bridge.state.items[end].item || bridge.state.items[end];
                    if ((it.superGroupId ? String(it.superGroupId) : '') !== sid) break;
                    end++;
                }
                // Singletons and blocks that coincide with exactly one post
                // outline are skipped: a second ring around the same thumbs is noise.
                const sameAsPost = runs.some((run) => run.start === start && run.end === end);
                if (sid && end - start > 1 && !sameAsPost) superRuns.push({ gid: sid, start: start, end: end });
                start = end;
            }
            bridge.state.thumbGroupData = { items: bridge.state.items, length: bridge.state.items.length, counts: counts, runs: runs, superRuns: superRuns, revision: bridge.state.thumbDataRevision || 0 };
            return bridge.state.thumbGroupData;
        }

    function thumbsGroupCounts() {
            return thumbGroupData().counts;
        }

    function ensureThumbsWindow(track) {
            if (!track.classList.contains('ms-thumbs-windowed')) {
                track.classList.add('ms-thumbs-windowed');
                track.innerHTML = '';
                bridge.state.thumbsPool = [];
                const sizer = document.createElement('div');
                sizer.className = 'ms-thumbs-sizer';
                track.appendChild(sizer);
                track.addEventListener('scroll', onThumbsWindowScroll, { passive: true });
                enableThumbDragScroll(track);
            }
            let sizer = track.querySelector('.ms-thumbs-sizer');
            if (!sizer) {
                sizer = document.createElement('div');
                sizer.className = 'ms-thumbs-sizer';
                track.insertBefore(sizer, track.firstChild);
            }
            return sizer;
        }

    function onThumbsWindowScroll() {
            if (bridge.state.thumbsWindowRaf) return;
            bridge.state.thumbsWindowRaf = requestAnimationFrame(() => {
                bridge.state.thumbsWindowRaf = null;
                if (!bridge.state.overlay) return;
                const track = bridge.state.overlay.querySelector('.ms-thumbs-track');
                if (track) paintThumbsWindow(track, thumbGroupData());
            });
        }

    function takePoolCell(pool, used, key, reservedKeys) {
            if (key) {
                for (let i = 0; i < pool.length; i++) {
                    if (!used.has(pool[i]) && pool[i].dataset.msKey === key) return pool[i];
                }
            }
            for (let i = 0; i < pool.length; i++) {
                if (!used.has(pool[i]) && (!reservedKeys || !reservedKeys.has(pool[i].dataset.msKey))) return pool[i];
            }
            return null;
        }

    function paintThumbsWindow(track, groupData, force) {
            const data = groupData || thumbGroupData();
            const groupCounts = data.counts;
            const n = bridge.state.items.length;
            const pad = 6;
            const start = Math.max(0, Math.floor(track.scrollLeft / bridge.MS_THUMB_STRIDE) - pad);
            const vis = Math.ceil(Math.max(track.clientWidth, 1) / bridge.MS_THUMB_STRIDE) + pad * 2;
            const end = Math.min(n, start + vis);
            // A scroll animation runs a dozen frames and the window it shows
            // changes on one or two of them; the rest used to rewrite every cell's
            // position anyway, which dirties layout and makes the next frame's
            // scroll read force it again. Nothing has moved: leave it alone.
            const signature = start + ':' + end + ':' + n + ':' + bridge.state.currentIndex + ':' + (bridge.state.thumbDataRevision || 0);
            if (!force && track._msWindowSignature === signature) return;
            track._msWindowSignature = signature;
            const want = Math.max(0, end - start);
            // The pad cells are off screen: their thumbnails load at low priority.
            const visStart = start + (start > 0 ? pad : 0);
            const visEnd = end - (end < n ? pad : 0);
            if (!bridge.state.thumbsPool) bridge.state.thumbsPool = [];
            const pool = bridge.state.thumbsPool;
            const used = new Set();
            const reservedKeys = new Set(bridge.state.items.slice(start,end).map(thumbItemKey));
            for (let index = start; index < end; index++) {
                const entry = bridge.state.items[index];
                const key = thumbItemKey(entry);
                let btn = takePoolCell(pool, used, key, reservedKeys);
                if (!btn) {
                    btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'ms-thumb ms-thumb-abs';
                    btn.addEventListener('click', onWindowedThumbClick);
                    track.appendChild(btn);
                    pool.push(btn);
                }
                used.add(btn);
                btn.style.display = '';
                btn.style.left = (index * bridge.MS_THUMB_STRIDE) + 'px';
                if (btn.dataset.msKey === key) {
                    btn.setAttribute('data-index', String(index));
                    btn.classList.toggle('active', index === bridge.state.currentIndex);
                    if (btn.dataset.msThumbRevision !== thumbPreviewRevision(entry)) {
                        fillThumbButton(btn, entry, index, groupCounts, index >= visStart && index < visEnd);
                    }
                    continue;
                }
                fillThumbButton(btn, entry, index, groupCounts, index >= visStart && index < visEnd);
            }
            for (let i = 0; i < pool.length; i++) {
                if (used.has(pool[i])) continue;
                resetMediaThumbEl(pool[i]);
                pool[i].style.display = 'none';
                pool[i].removeAttribute('data-index');
            }
            for (let i = pool.length - 1; pool.length > want + 8 && i >= 0; i--) {
                if (used.has(pool[i])) continue;
                const extra = pool.splice(i, 1)[0];
                try { extra.remove(); } catch (e) { }
            }
            paintThumbGroupOutlines(track, data, start, end);
            paintLoadMarks(track, start, end);
        }

    function paintLoadMarks(track, visibleStart, visibleEnd) {
            let layer = track.querySelector('.ms-load-mark-layer');
            if (!layer) {
                layer = document.createElement('div');
                layer.className = 'ms-load-mark-layer';
                track.appendChild(layer);
            }
            const n = bridge.state.items.length;
            layer.style.width = Math.max(0, n * bridge.MS_THUMB_STRIDE) + 'px';
            const start = Math.max(0, Number.isFinite(visibleStart) ? visibleStart : 0);
            const end = Math.min(n, Number.isFinite(visibleEnd) ? visibleEnd : n);
            const cache = bridge.state;
            if (cache.markItems !== cache.items || cache.markCount !== n || cache.markLength !== bridge.galleryLoadMarks.length) {
                cache.markItems = cache.items;
                cache.markCount = n;
                cache.markLength = bridge.galleryLoadMarks.length;
                cache.markIndexes = new Map();
                if (cache.markLength) for (let i = 0; i < n; i++) {
                    const it = cache.items[i].item || cache.items[i];
                    if (it && it.src && !cache.markIndexes.has(it.src)) cache.markIndexes.set(it.src, i);
                }
            }
            const indexesBySrc = cache.markIndexes || new Map();
            const visibleMarks = bridge.galleryLoadMarks.map((src) => indexesBySrc.get(src))
                .filter((index) => Number.isFinite(index) && index >= 1 && index >= start && index <= end);
            const signature = n + '|' + start + '|' + end + '|' + visibleMarks.join(',');
            if (layer.dataset.msPaintSignature === signature) return;
            layer.dataset.msPaintSignature = signature;
            layer.innerHTML = '';
            if (!visibleMarks.length) return;
            for (let m = 0; m < visibleMarks.length; m++) {
                const index = visibleMarks[m];
                const mark = document.createElement('div');
                mark.className = 'ms-load-mark';
                mark.title = 'Loaded more';
                mark.style.left = (index * bridge.MS_THUMB_STRIDE - 14) + 'px';
                mark.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 1.5 8.5 6l-5 4.5"/></svg>';
                layer.appendChild(mark);
            }
        }

    function paintThumbGroupOutlines(track, groupData, visibleStart, visibleEnd) {
            let layer = track.querySelector('.ms-thumb-group-layer');
            if (!layer) {
                layer = document.createElement('div');
                layer.className = 'ms-thumb-group-layer';
                track.appendChild(layer);
            }
            const data = groupData || thumbGroupData();
            const start = Math.max(0, Number.isFinite(visibleStart) ? visibleStart : 0);
            const end = Math.min(bridge.state.items.length, Number.isFinite(visibleEnd) ? visibleEnd : bridge.state.items.length);
            // Runs are sorted and disjoint. A run only partly inside the window is
            // painted whole at absolute track coordinates, so its far edge sits
            // correctly beside thumbs that are not mounted yet.
            const visibleRunsOf = (runs) => {
                let low = 0;
                let high = runs.length;
                while (low < high) {
                    const mid = (low + high) >> 1;
                    if (runs[mid].end <= start) low = mid + 1;
                    else high = mid;
                }
                const out = [];
                for (let r = low; r < runs.length && runs[r].start < end; r++) out.push(runs[r]);
                return out;
            };
            const visibleRuns = visibleRunsOf(data.runs);
            const visibleSuperRuns = visibleRunsOf(data.superRuns || []);
            const describe = (run) => run.gid + ':' + run.start + ':' + run.end;
            const signature = bridge.state.items.length + '|' + start + '|' + end + '|'
                + visibleRuns.map(describe).join(',') + '#' + visibleSuperRuns.map(describe).join(',');
            if (layer.dataset.msPaintSignature === signature) return;
            layer.dataset.msPaintSignature = signature;
            layer.innerHTML = '';
            const stride = bridge.MS_THUMB_STRIDE;
            // Outer level first so the post outline paints on top of it.
            for (let r = 0; r < visibleSuperRuns.length; r++) {
                const run = visibleSuperRuns[r];
                const box = document.createElement('div');
                box.className = 'ms-thumb-supergroup-box';
                // 1px outside the post box on each side; adjacent blocks abut.
                box.style.left = (run.start * stride - 3) + 'px';
                box.style.width = ((run.end - run.start) * stride) + 'px';
                box.style.borderColor = getPastelColorForGroupId(run.gid, 0.55);
                layer.appendChild(box);
            }
            for (let r = 0; r < visibleRuns.length; r++) {
                const run = visibleRuns[r];
                const box = document.createElement('div');
                box.className = 'ms-thumb-group-box';

                box.style.left = (run.start * stride - 2) + 'px';
                box.style.width = ((run.end - run.start) * stride - 2) + 'px';
                box.style.borderColor = getPastelColorForGroupId(run.gid);
                layer.appendChild(box);
            }
        }

    function syncThumbsWindow(opts) {
            if (!bridge.state.overlay) return;
            const track = bridge.state.overlay.querySelector('.ms-thumbs-track');
            if (!track) return;
            const sizer = ensureThumbsWindow(track);
            const n = bridge.state.items.length;
            const prevIndex = bridge.state.thumbsPaintIndex;
            sizer.style.width = Math.max(0, n * bridge.MS_THUMB_STRIDE) + 'px';
            if (opts && opts.center) bridge.state.thumbsFollowCenter = true;
            if (bridge.state.thumbsFollowCenter && n) {
                applyThumbStripCenter(track, !!(opts && opts.center));
            }
            bridge.state.thumbsPaintIndex = bridge.state.currentIndex;
            paintThumbsWindow(track, thumbGroupData(), true);
        }

    function gridMetrics(wrap, grid) {
            const size = (typeof bridge.gridThumbSize === 'number' && bridge.gridThumbSize) ? bridge.gridThumbSize : 160;
            const gap = 8;
            let innerW = grid && grid.clientWidth;
            if (!innerW && wrap) {
                const cs = window.getComputedStyle(wrap);
                innerW = wrap.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
            }
            innerW = Math.max(1, innerW || 1);
            const cols = Math.max(1, Math.floor((innerW + gap) / (size + gap)));
            const cell = (innerW - (cols - 1) * gap) / cols;
            return { cols: cols, cell: cell, gap: gap, rowH: cell + gap };
        }

    function ensureGridWindow(grid, wrap) {
            if (!grid.classList.contains('ms-grid-windowed')) {
                grid.classList.add('ms-grid-windowed');
                grid.innerHTML = '';
                bridge.state.gridPool = [];
                const sizer = document.createElement('div');
                sizer.className = 'ms-grid-sizer';
                grid.appendChild(sizer);
                if (wrap && wrap.dataset.msGridWindow !== '1') {
                    wrap.dataset.msGridWindow = '1';
                    wrap.addEventListener('scroll', onGridWindowScroll, { passive: true });
                    if (typeof ResizeObserver !== 'undefined') {
                        const ro = new ResizeObserver(() => {
                            if (bridge.state.gridMode) syncGridWindow();
                        });
                        ro.observe(wrap);
                        bridge.state.gridResizeObs = ro;
                    }
                }
            }
            let sizer = grid.querySelector('.ms-grid-sizer');
            if (!sizer) {
                sizer = document.createElement('div');
                sizer.className = 'ms-grid-sizer';
                grid.insertBefore(sizer, grid.firstChild);
            }
            return sizer;
        }

    function onGridWindowScroll() {
            if (bridge.state.gridWindowRaf) return;
            bridge.state.gridWindowRaf = requestAnimationFrame(() => {
                bridge.state.gridWindowRaf = null;
                if (!bridge.state.overlay || !bridge.state.gridMode) return;
                paintGridWindow();
            });
        }

    function paintGridWindow() {
            if (!bridge.state.overlay) return;
            const grid = bridge.state.overlay.querySelector('.ms-grid');
            const wrap = bridge.state.overlay.querySelector('.ms-grid-wrap');
            if (!grid || !wrap) return;
            const sizer = ensureGridWindow(grid, wrap);
            const n = bridge.state.items.length;
            const m = gridMetrics(wrap, grid);
            const rows = Math.ceil(n / m.cols);
            sizer.style.height = Math.max(0, rows * m.rowH - m.gap) + 'px';
            const pad = 2;
            const startRow = Math.max(0, Math.floor(wrap.scrollTop / m.rowH) - pad);
            const visRows = Math.ceil(Math.max(wrap.clientHeight, 1) / m.rowH) + pad * 2;
            const start = startRow * m.cols;
            const end = Math.min(n, (startRow + visRows) * m.cols);
            const want = Math.max(0, end - start);
            if (!bridge.state.gridPool) bridge.state.gridPool = [];
            const pool = bridge.state.gridPool;
            const used = new Set();
            const reservedKeys = new Set(bridge.state.items.slice(start,end).map(thumbItemKey));
            for (let index = start; index < end; index++) {
                const entry = bridge.state.items[index];
                const key = thumbItemKey(entry);
                const col = index % m.cols;
                const row = Math.floor(index / m.cols);
                let cell = takePoolCell(pool, used, key, reservedKeys);
                if (!cell) {
                    cell = document.createElement('button');
                    cell.type = 'button';
                    cell.className = 'ms-grid-cell ms-grid-abs';
                    cell.addEventListener('click', onWindowedGridClick);
                    grid.appendChild(cell);
                    pool.push(cell);
                }
                used.add(cell);
                cell.style.display = '';
                cell.style.width = m.cell + 'px';
                cell.style.height = m.cell + 'px';
                cell.style.left = (col * (m.cell + m.gap)) + 'px';
                cell.style.top = (row * m.rowH) + 'px';
                if (cell.dataset.msKey === key) {
                    cell.setAttribute('data-grid-index', String(index));
                    cell.classList.toggle('active', index === bridge.state.currentIndex);
                    continue;
                }
                fillGridCell(cell, entry, index);
                if (bridge.state.gridEnteringKeys && bridge.state.gridEnteringKeys.has(key)) {
                    cell.classList.add('ms-grid-entering');
                    if (bridge.state.gridEnteringTimer) clearTimeout(bridge.state.gridEnteringTimer);
                    bridge.state.gridEnteringTimer = setTimeout(() => {
                        bridge.state.gridEnteringTimer = null;
                        bridge.state.gridEnteringKeys = null;
                        const grid = bridge.state.overlay && bridge.state.overlay.querySelector('.ms-grid');
                        if (grid) grid.querySelectorAll('.ms-grid-entering').forEach((node) => node.classList.remove('ms-grid-entering'));
                    }, 260);
                }
            }
            for (let i = 0; i < pool.length; i++) {
                if (used.has(pool[i])) continue;
                pool[i].style.display = 'none';
                pool[i].removeAttribute('data-grid-index');
                // Hiding a cell does not stop its image downloading: an <img> with
                // a src off the window keeps its request, and its slot, against
                // the same host the stage needs. Everything scrolled out is torn
                // down, media element or not.
                resetMediaThumbEl(pool[i]);
            }
            // The pool only ever grew. A tall window, or a column count that
            // changed, left hundreds of cells parked in the DOM for the session.
            const keep = used.size + m.cols * 2;
            for (let i = pool.length - 1; i >= keep; i--) {
                if (used.has(pool[i])) continue;
                resetMediaThumbEl(pool[i]);
                pool[i].remove();
                pool.splice(i, 1);
            }
        }

    function fillGridCell(cell, entry, index) {
            resetMediaThumbEl(cell);
            // Pooled node: a flight that hid it may still owe us its cleanup, and
            // by then this cell can already be showing a different item.
            cell.removeAttribute('data-ms-fly-hidden');
            cell.style.removeProperty('visibility');
            const item = entry.item || entry;
            const hdSrc = bridge.getHdSrc(item);
            if (hdSrc) cell.setAttribute('data-hd-src', hdSrc);
            const cacheClass = (hdSrc && !bridge.state.cachedImageUrls.has(hdSrc) && !item._msMediaLoaded) ? ' ms-uncached' : '';
            cell.setAttribute('data-grid-index', String(index));
            cell.dataset.msKey = thumbItemKey(entry);
            const thumbSrc = item.thumbSrc || item.src;
            const isVideo = item.type === 'video' || item.type === 'iframe' || item.expectedVideo || item.xUnplayable;
            const hasPoster = !!(item.thumbSrc && item.thumbSrc !== item.src && !bridge.isPlaceholderUrl(item.thumbSrc));
            const animated = bridge.isFreezableAnimatedThumb(item);
            globalThis.XGalleryCore.renderThumbnailCell({
                document: document,
                host: cell,
                baseClass: 'ms-grid-cell',
                absoluteClass: ' ms-grid-abs',
                placeholderClass: 'ms-grid-placeholder',
                cacheClass: cacheClass,
                active: index === bridge.state.currentIndex,
                hdSrc: hdSrc,
                isVideo: isVideo,
                isAnimated: animated,
                animatedLabel: animated ? bridge.animatedThumbLabel(item) : '',
                isPlaceholder: thumbMediaIsPlaceholder(item, thumbSrc),
                isVideoThumb: isVideo,
                sourceUrl: item.src,
                appendVideo: (host) => appendVideoThumbMedia(host, item, thumbSrc, isVideo, 'ms-grid-placeholder'),
                loadImage: (img) => {
                    img._msThumbDistance = Math.abs(index - bridge.state.currentIndex);
                    if (animated) {
                        bridge.freezeAnimatedThumbnail(img, item);
                    } else {
                        bridge.setCachedImgSrc(img, thumbSrc, item);
                    }
                },
                indexLabel: index + 1
            });
        }

    function syncGridWindow() {
            paintGridWindow();
        }

    function renderThumbs(options) {
            const track = bridge.state.overlay && bridge.state.overlay.querySelector('.ms-thumbs-track');
            let anchorKey = '';
            let anchorX = 0;
            if (track && options && options.preserveAnchor) {
                const hostRect = track.getBoundingClientRect();
                const visible = Array.from(track.querySelectorAll('.ms-thumb[data-ms-key]')).filter((button) => {
                    const rect = button.getBoundingClientRect();
                    return rect.right > hostRect.left && rect.left < hostRect.right;
                });
                const anchor = visible.find((button) => button.classList.contains('active')) ||
                    visible.reduce((best, button) => {
                        const center = button.getBoundingClientRect().left + button.offsetWidth / 2;
                        const distance = Math.abs(center - (hostRect.left + hostRect.width / 2));
                        return !best || distance < best.distance ? { button: button, distance: distance } : best;
                    }, null)?.button;
                if (anchor) {
                    anchorKey = anchor.dataset.msKey || '';
                    anchorX = anchor.getBoundingClientRect().left;
                }
            }
            const itemKeys = new Set(bridge.state.items.map(thumbItemKey).filter(Boolean));
            if (!bridge.state.thumbKnownKeys) bridge.state.thumbKnownKeys = new Set(itemKeys);
            bridge.state.thumbEnteringKeys = options && options.animateNew
                ? new Set(Array.from(itemKeys).filter((key) => !bridge.state.thumbKnownKeys.has(key)))
                : null;
            itemKeys.forEach((key) => bridge.state.thumbKnownKeys.add(key));
            invalidateThumbGroupData();
            const followedCenter = bridge.state.thumbsFollowCenter;
            if (anchorKey) {
                bridge.state.thumbsFollowCenter = false;
                stopThumbTrackAnimation();
                const index = bridge.state.items.findIndex(entry => thumbItemKey(entry) === anchorKey);
                if (index >= 0) {
                    ensureThumbsWindow(track).style.width = (bridge.state.items.length * bridge.MS_THUMB_STRIDE) + 'px';
                    track.scrollLeft = index * bridge.MS_THUMB_STRIDE - (anchorX - track.getBoundingClientRect().left);
                }
            }
            syncThumbsWindow();
            bridge.state.thumbsFollowCenter = followedCenter;
            if (track && anchorKey) {
                const escaped = globalThis.CSS && CSS.escape ? CSS.escape(anchorKey) : anchorKey.replace(/["\\]/g, '\\$&');
                const next = track.querySelector('.ms-thumb[data-ms-key="' + escaped + '"]');
                if (next) {
                    const delta = next.getBoundingClientRect().left - anchorX;
                    if (Math.abs(delta) > 0.5) {
                        track.scrollLeft += delta;
                        paintThumbsWindow(track, thumbGroupData());
                    }
                }
            }
            if (bridge.state.thumbEnteringKeys && bridge.state.thumbEnteringKeys.size) {
                if (bridge.state.thumbEnteringTimer) clearTimeout(bridge.state.thumbEnteringTimer);
                bridge.state.thumbEnteringTimer = setTimeout(() => {
                    bridge.state.thumbEnteringKeys = null;
                    bridge.state.thumbEnteringTimer = null;
                    if (track) track.querySelectorAll('.ms-thumb-entering').forEach((button) => button.classList.remove('ms-thumb-entering'));
                }, 260);
            }
    }

    function updateSingleThumb(index, entry) {
            invalidateThumbWindow();
            if (!bridge.state.overlay) return;
            const track = bridge.state.overlay.querySelector('.ms-thumbs-track');
            if (!track) return;
            const btn = track.querySelector('[data-index="' + index + '"]');
            if (!btn) return;
            fillThumbButton(btn, entry, index, thumbsGroupCounts());
        }

    const mediaByteSizes = new Map();
    let mediaByteProbeTimer = 0;

    function formatByteSize(bytes) {
            let value = Number(bytes);
            if (!(value > 0)) return '';
            const units = ['B', 'KB', 'MB', 'GB'];
            let unit = 0;
            while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
            return (unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)) + ' ' + units[unit];
        }

    function isCurrentItem(item) {
            const entry = bridge.state.items[bridge.state.currentIndex];
            return !!entry && (entry.item || entry) === item;
        }

        // Date, resolution and size share one line in the topbar and a row in the
        // Info panel. Painted from values cached on the item, so a revisited item
        // shows them at once and a new one fills in when its media decodes - into
        // space that is already reserved.
    function paintInfoMeta(item) {
            const overlay = bridge.state.overlay;
            if (!overlay || !item || !isCurrentItem(item)) return;
            const text = {
                'ms-info-date': (bridge.mediaPresentation(item) || {}).date || '',
                'ms-info-dims': item._msNaturalWidth && item._msNaturalHeight ? item._msNaturalWidth + '\u00d7' + item._msNaturalHeight : '',
                'ms-info-bytes': formatByteSize(Number(item.bytes) > 0 ? item.bytes : item._msBytes)
            };
            overlay.querySelectorAll('.ms-info-date, .ms-info-dims, .ms-info-bytes').forEach((el) => {
                const value = text[el.classList[0]] || '';
                if (el.textContent !== value) el.textContent = value;
            });
        }

        // Size, cheapest source first: the adapter's own number, then the browser's
        // resource timing (zero cross-origin without Timing-Allow-Origin, and partial
        // for range-loaded video, so images only), then one HEAD request per URL,
        // debounced so holding an arrow key does not fire a request per item.
    function requestMediaByteSize(item, url) {
            if (!item || Number(item.bytes) > 0 || !url || /^(data|blob):/i.test(url)) return;
            if (item._msBytesUrl !== url) { item._msBytesUrl = url; item._msBytes = 0; }
            if (mediaByteSizes.has(url)) { item._msBytes = mediaByteSizes.get(url); paintInfoMeta(item); return; }
            if (item.type !== 'video' && typeof performance !== 'undefined' && performance.getEntriesByName) {
                const timing = performance.getEntriesByName(url, 'resource').pop();
                if (timing && timing.encodedBodySize > 0) {
                    mediaByteSizes.set(url, timing.encodedBodySize);
                    item._msBytes = timing.encodedBodySize;
                    paintInfoMeta(item);
                    return;
                }
            }
            if (typeof bridge.mediaContentLength !== 'function') return;
            if (typeof bridge.canProbeMediaSize === 'function' && !bridge.canProbeMediaSize(url)) return;
            clearTimeout(mediaByteProbeTimer);
            mediaByteProbeTimer = setTimeout(() => {
                if (!isCurrentItem(item) || mediaByteSizes.has(url)) return;
                mediaByteSizes.set(url, 0);
                Promise.resolve(bridge.mediaContentLength(url)).then((bytes) => {
                    if (!(bytes > 0)) return;
                    mediaByteSizes.set(url, bytes);
                    if (item._msBytesUrl === url) { item._msBytes = bytes; paintInfoMeta(item); }
                }).catch(() => {});
            }, 700);
        }

    function noteMediaDimensions(item, el) {
            if (!item || !el) return;
            const width = el.videoWidth || el.naturalWidth || 0;
            const height = el.videoHeight || el.naturalHeight || 0;
            if (width && height) { item._msNaturalWidth = width; item._msNaturalHeight = height; }
            paintInfoMeta(item);
            requestMediaByteSize(item, /^(?:blob|data):/i.test(el.currentSrc || el.src || '') ? item.src : (el.currentSrc || el.src || item.src));
        }

    function markItemMediaLoaded(item) {
            if (!item || !bridge.state.overlay) return;
            item._msMediaLoaded = true;
            item._msUnavailable = false;
            try {
                if (typeof bridge.onMediaLoaded === 'function') bridge.onMediaLoaded(item);
            } catch (e) { }
            const index = bridge.state.items.findIndex((entry) => (entry.item || entry) === item);
            if (index < 0) return;

            const track = bridge.state.overlay.querySelector('.ms-thumbs-track');
            let thumb = track ? track.querySelector('[data-index="' + index + '"]') : null;
            const thumbSrc = item.thumbSrc || '';
            if (thumb && thumb.classList.contains('ms-placeholder') && thumbSrc && !bridge.isPlaceholderUrl(thumbSrc)) {
                updateSingleThumb(index, bridge.state.items[index]);
                thumb = track.querySelector('[data-index="' + index + '"]');
            }
            if (thumb) {
                thumb.classList.remove('ms-uncached', 'ms-media-error');
                thumb.classList.add('ms-media-loaded');
            }

            const gridCell = bridge.state.overlay.querySelector('[data-grid-index="' + index + '"]');
            if (gridCell) {
                gridCell.classList.remove('ms-uncached', 'ms-media-error');
                gridCell.classList.add('ms-media-loaded');
            }
        }

    function enableThumbDragScroll(track) {
            if (bridge.state.thumbDragBound) return;
            bridge.state.thumbDragBound = true;

            const onDown = (clientX) => {
                stopThumbTrackAnimation();
                bridge.state.thumbsFollowCenter = false;
                bridge.state.dragData = {
                    startX: clientX,
                    startScroll: track.scrollLeft,
                    moved: false,
                    mouseDown: true,
                    justDragged: false
                };
            };

            const onMove = (clientX) => {
                if (!bridge.state.dragData || !bridge.state.dragData.mouseDown) return;
                const dx = clientX - bridge.state.dragData.startX;
                if (Math.abs(dx) > 4) {
                    bridge.state.dragData.moved = true;
                    bridge.state.dragData.justDragged = true;
                }
                track.scrollLeft = bridge.state.dragData.startScroll - dx;
            };

            const onUp = () => {
                if (!bridge.state.dragData) return;
                bridge.state.dragData.mouseDown = false;
                if (bridge.state.dragData.justDragged) {
                    setTimeout(() => {
                        if (bridge.state.dragData) bridge.state.dragData.justDragged = false;
                    }, 0);
                }
            };

            const onWindowMove = (e) => onMove(e.clientX);
            const endDrag = () => {
                window.removeEventListener('mousemove', onWindowMove);
                onUp();
            };
            track.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                onDown(e.clientX);
                window.addEventListener('mousemove', onWindowMove);
                window.addEventListener('mouseup', endDrag, { once: true });
            });

            track.addEventListener('touchstart', (e) => {
                const t = e.touches && e.touches[0];
                if (!t) return;
                onDown(t.clientX);
            }, { passive: true });
            track.addEventListener('touchmove', (e) => {
                const t = e.touches && e.touches[0];
                if (!t) return;
                onMove(t.clientX);
            }, { passive: true });
            track.addEventListener('touchend', onUp, { passive: true });
            track.addEventListener('touchcancel', onUp, { passive: true });
        }

    function appendErrorBanner(container, errMsg) {
            globalThis.XGalleryCore.renderErrorBanner({
                document: document,
                container: container,
                message: errMsg
            });
        }

    // Every fetch the gallery makes asks this gate for a slot first. Core holds
    // the stage's end of it: while the media on screen is still waiting for its
    // first bytes, thumbnail work is held back. Past the browser's per-host
    // ceiling a fresh video is not slow, it never starts at all, so the one
    // request that matters has to be able to take the whole budget.
    function mediaGate() {
        const core = globalThis.XGalleryCore;
        return core && typeof core.sharedMediaGate === 'function' ? core.sharedMediaGate() : null;
    }

    function setStageFetching(busy) {
        const gate = mediaGate();
        if (gate) gate.setStageBusy(!!busy);
    }

    // The stage is starving: take the network off everything decorative. Queued
    // work never starts and running work is aborted, which is the only thing that
    // frees a connection already held.
    function yieldNetworkToStage() {
        const gate = mediaGate();
        const lanes = globalThis.XGalleryCore && globalThis.XGalleryCore.MEDIA_LANES;
        if (gate && lanes) gate.abort({ laneAtLeast: lanes.VISIBLE });
    }

    // A host that refused or timed out is reported once and every lane backs off.
    function noteStageFailure(url, detail) {
        const gate = mediaGate();
        if (gate) gate.noteResult(url, detail || { timeout: true, status: 0 });
    }

    const STAGE_STALL_NOTICE_MS = 8000;
    // Long enough that a host which is merely slow to send its first byte is not
    // interrupted: restarting resets the download, and a restart loop on a slow
    // host would be a video that never arrives at all.
    const STAGE_STALL_RETRY_MS = 45000;
    const STAGE_STALL_MAX_RETRIES = 2;

    /**
     * The stage could not tell slow from broken. A media element that is starved
     * rather than refused fires no error at all - it sits at readyState 0 with its
     * poster up, forever, saying nothing. This watches for that: first a notice so
     * the gallery stops pretending everything is fine, then the network taken back
     * off the thumbnails, then a restart on a fresh element, which is measurably
     * what makes a starved video load.
     */
    function watchStageMedia(options) {
        const element = options.element;
        const wrap = options.wrap;
        const isCurrent = options.isCurrent;
        const isReady = options.isReady || (() => element.readyState >= 2);
        // Dropped with the rest of this render's listeners when the element is reused.
        const listen = options.signal ? { signal: options.signal } : undefined;
        let lastProgressAt = Date.now();
        let noticed = false;
        let retries = 0;
        let stopped = false;
        let timer = null;

        const stop = (settled) => {
            if (stopped) return;
            stopped = true;
            if (timer) clearInterval(timer);
            timer = null;
            if (noticed && isReady()) hideStageNotice(wrap);
            if (settled !== false) setStageFetching(false);
        };
        // Data arriving after the watchdog gave up still clears the notice.
        element.addEventListener('loadeddata', () => { if (noticed) hideStageNotice(wrap); }, Object.assign({ once: true }, listen || {}));
        const progress = () => { lastProgressAt = Date.now(); };
        ['progress', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'timeupdate']
            .forEach((type) => element.addEventListener(type, progress, listen));

        timer = setInterval(() => {
            if (!isCurrent()) { stop(false); return; }
            if (isReady()) { stop(true); return; }
            const idle = Date.now() - lastProgressAt;
            // The notice alone: the gate has already narrowed everything else to
            // a width the stage tolerates, and cancelling the thumbnails in flight
            // here only made them start over.
            if (!noticed && idle >= STAGE_STALL_NOTICE_MS) {
                noticed = true;
                showStageNotice(wrap, 'Still loading\u2026');
            }
            if (idle >= STAGE_STALL_RETRY_MS) {
                lastProgressAt = Date.now();
                // Out of restarts: leave the element to keep waiting. The host may
                // still answer, and an error stage for a file that is merely slow
                // would be wrong; a real failure fires the element's own error.
                if (retries >= STAGE_STALL_MAX_RETRIES) {
                    showStageNotice(wrap, 'Still loading - the host is slow to answer…');
                    stop(true);
                    return;
                }
                retries += 1;
                noteStageFailure(options.url, { timeout: true, status: 0, attempt: retries });
                yieldNetworkToStage();
                showStageNotice(wrap, 'Still loading - trying again\u2026');
                if (typeof options.onRestart === 'function') options.onRestart(retries);
            }
        }, 1000);

        return { stop: stop, noteProgress: progress };
    }

    function renderErrorStage(container, errMsg, url, item) {
            if (item && /(?:\b404\b|\b410\b|not found|gone|terminal)/i.test(String(errMsg || ''))) {
                item._msUnavailable = true;
            }
            if (item && item.type === 'video' && item._msUnavailable !== true && url && typeof bridge.probeUrlStatus === 'function') {
                bridge.probeUrlStatus(url).then((probe) => {
                    if (probe && (probe.status === 404 || probe.status === 410)) item._msUnavailable = true;
                }).catch(() => { });
            }
            // The failing element is about to be dropped from the DOM; a video
            // detached with its src intact keeps downloading against the same host
            // budget as whatever the user looks at next.
            container.querySelectorAll('video, audio').forEach((element) => {
                if (element._msPooled) { parkStageVideo(element); return; }
                try { element.pause(); element.removeAttribute('src'); element.load(); } catch (e) { }
            });
            globalThis.XGalleryCore.renderErrorStage({
                document: document,
                container: container,
                message: errMsg,
                url: url,
                canRetry: !!(item && (item.resolveUrl || item.src)),
                onRetry: () => {
                    const resolveUrl = item.resolveUrl || item.src;
                    if (resolveUrl) {
                        bridge.resolvedFileUrlCache.delete(resolveUrl);
                        bridge.resolvingFileUrlCache.delete(resolveUrl);
                    }
                    item.needsResolve = true;
                    item._msUnavailable = false;
                    delete item.error;
                    bridge.renderCurrent();
                }
            });
        }

    function prepareMediaWrap(wrap, item) {
            return globalThis.XGalleryCore.prepareMediaSlot({
                document: document,
                wrap: wrap,
                item: item,
                retireVideo: (element) => {
                    if (!element._msPooled) return false;
                    parkStageVideo(element);
                    return true;
                }
            });
        }

    // --- the stage's video elements -----------------------------------------------
    // Two <video> elements, made once and kept for as long as the page lives: one
    // on stage, one prefetching the neighbour, trading places as the user moves.
    //
    // The gallery used to make a new element for every item, and to the gallery
    // that is free. It is not free to everything else on the page. A player
    // userscript initialises every <video> it has not seen before - a toolbar of
    // custom elements, each with a shadow root of its own - and a dark-mode
    // extension then restyles every one of those new shadow roots. In a trace taken
    // on a 550,000-node thread that came to 350 ms of main-thread work per
    // navigation, of which the gallery's own share was under 30; photos never
    // showed it because photos never made a <video>. An element those scripts have
    // already met costs nothing, so the gallery stops introducing new ones.
    const STAGE_VIDEO_POOL_SIZE = 2;

    function stageVideoPark() {
            const overlay = bridge.state.overlay;
            if (!overlay) return null;
            let park = overlay.querySelector(':scope > .ms-video-park');
            if (!park) {
                park = document.createElement('div');
                park.className = 'ms-video-park';
                park.hidden = true;
                park.style.display = 'none';
                overlay.appendChild(park);
            }
            return park;
        }

    // moveBefore keeps a node's state and fires no disconnect/connect steps, which
    // is exactly the quiet this pool is after; older browsers fall back to a plain
    // insert, which still reuses the element.
    function placeNode(parent, node) {
            if (!parent || node.parentNode === parent) return;
            if (typeof parent.moveBefore === 'function' && node.isConnected && parent.isConnected) {
                try { parent.moveBefore(node, null); return; } catch (e) { }
            }
            parent.appendChild(node);
        }

    function resetStageVideo(video) {
            if (video._msRenderAbort) { video._msRenderAbort.abort(); video._msRenderAbort = null; }
            if (video._msEndRecoveryTimer) { clearTimeout(video._msEndRecoveryTimer); video._msEndRecoveryTimer = null; }
            video._msRecovering = false;
            try {
                video.pause();
                video.removeAttribute('src');
                video.removeAttribute('poster');
                video.load();
            } catch (e) { }
            video.classList.remove('ms-ready');
            video.style.opacity = '0';
        }

    function parkStageVideo(video) {
            resetStageVideo(video);
            const park = stageVideoPark();
            if (park) placeNode(park, video);
        }

    function stageVideoPool() {
            // An element something else tore out of the document is forgotten:
            // the pool heals rather than handing back a node nobody can see.
            const pool = (bridge.state.stageVideoPool || []).filter((video) => video.isConnected);
            bridge.state.stageVideoPool = pool;
            return pool;
        }

    // An element that is not on stage right now, made if the pool is not full yet.
    // One of the two may be out on loan to the adapter's prefetch, and the adapter
    // goes on believing it owns that element until it hands it back: it will point
    // it at the neighbour's file when its turn at the gate comes, and clear it
    // when the prediction changes. So the stage never takes the lent one - it
    // takes the other, and with two elements and one loan there always is one.
    function idleStageVideo(forLoan) {
            const pool = stageVideoPool();
            const idle = pool.filter((candidate) => !candidate.closest('.ms-media-wrap'));
            let video = idle.find((candidate) => !!candidate._msLent === !!forLoan) || null;
            if (!video && pool.length < STAGE_VIDEO_POOL_SIZE) {
                video = document.createElement('video');
                video._msPooled = true;
                pool.push(video);
                const park = stageVideoPark();
                if (park) park.appendChild(video);
            }
            if (!video && forLoan) video = idle[0] || null;
            return video;
        }

    // For the adapter's neighbour prefetch: the element it loads into is one the
    // stage will later show, so the handoff introduces nothing new to the page.
    function preloadStageVideo(preloadMode) {
            const video = idleStageVideo(true);
            if (!video) return null;
            resetStageVideo(video);
            video._msLent = true;
            video.muted = true;
            video.playsInline = true;
            video.referrerPolicy = 'no-referrer';
            video.preload = preloadMode || 'metadata';
            return video;
        }

    function bindGlobalGalleryHandlers() {
            if (bridge.state.keyHandler) return;

            bridge.state.keyHandler = function (e) {
                if (!bridge.state.open) return;
                if (document.getElementById('ms-settings-root')) return;
                if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
                    e.preventDefault();
                    if (bridge.state.filterBar && typeof bridge.state.filterBar.focus === 'function') bridge.state.filterBar.focus();
                    return;
                }
                if (e.key === 'Escape' && bridge.state.filterBar && bridge.state.filterBar.isOpen && bridge.state.filterBar.isOpen()) {
                    e.preventDefault();
                    bridge.state.filterBar.close();
                    const focusRoot = bridge.state.overlay && bridge.state.overlay.getRootNode && bridge.state.overlay.getRootNode();
                    const focused = (focusRoot && focusRoot.activeElement) || document.activeElement;
                    if (focused && typeof focused.blur === 'function') focused.blur();
                    return;
                }
                const activeRoot = bridge.state.overlay && bridge.state.overlay.getRootNode && bridge.state.overlay.getRootNode();
                const active = (activeRoot && activeRoot.activeElement) || document.activeElement;
                if (active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable)) return;
                if (e.key === 'Escape') {
                    e.preventDefault();
                    if (!bridge.state.gridMode && bridge.state.cameFromGrid) {
                        setGridMode(true);
                    } else {
                        bridge.closeGallery();
                    }
                } else if (e.key === 'g' || e.key === 'G') {
                    e.preventDefault();
                    setGridMode(!bridge.state.gridMode);
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    if (!bridge.state.gridMode) bridge.navigate(1);
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    if (!bridge.state.gridMode) bridge.navigate(-1);
                }
            };

            window.addEventListener('keydown', bridge.state.keyHandler, { capture: true });
        }

    function unbindGlobalGalleryHandlers() {
            if (bridge.state.keyHandler) {
                window.removeEventListener('keydown', bridge.state.keyHandler, { capture: true });
                bridge.state.keyHandler = null;
            }
        }

    function closeGallerySettings(overlay) {
            if (!overlay || overlay.dataset.msClosing === '1') return;
            overlay.dataset.msClosing = '1';
            overlay.classList.remove('ms-settings-open');
            const finish = () => { if (overlay.parentNode) overlay.remove(); };
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                finish();
                return;
            }
            let done = false;
            const end = () => { if (done) return; done = true; finish(); };
            overlay.addEventListener('transitionend', end);
            setTimeout(end, 280);
        }

    function openInGalleryButtonHtml() {
            return '<span class="ms-btn-label">Open in Gallery</span>'
                + '<svg viewBox="0 0 16 16" aria-hidden="true">'
                + '<path d="M6 3.5h6.5V10M12.5 3.5 3.5 12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
                + '</svg>';
        }

    const OPEN_IN_GALLERY_REPLACED = /^(IMG|VIDEO|AUDIO|IFRAME|EMBED|OBJECT|CANVAS|INPUT|BR|HR)$/;

        // Promoting a static host to relative would steal the containing block
        // from any absolutely positioned descendant, so check before doing it.
        // Bounded: this runs per injected button on pages with many posts.
    function hasOutOfFlowChild(el, depth) {
            if (!el || depth <= 0) return false;
            const kids = el.children || [];
            for (let i = 0; i < kids.length && i < 24; i++) {
                let position = '';
                try { position = window.getComputedStyle(kids[i]).position; } catch (e) { }
                if (position === 'absolute' || position === 'fixed') return true;
                if (hasOutOfFlowChild(kids[i], depth - 1)) return true;
            }
            return false;
        }

        // Mount so the button cannot change the host's box. A block-ish host gets
        // it as an out-of-flow child - the embed wrappers we target are already
        // position: relative, so usually no positioning context is added at all.
        // Inline hosts, and replaced elements that cannot hold children, keep it
        // in the inline flow at text scale instead.
    function mountOpenInGalleryButton(host, btn) {
            if (!host || !btn) return;
            if (host.nodeType === 1 && !OPEN_IN_GALLERY_REPLACED.test(host.tagName)) {
                let position = '';
                let display = '';
                try {
                    const cs = window.getComputedStyle(host);
                    position = cs.position;
                    display = cs.display;
                } catch (e) { }
                const blockish = display && display !== 'inline' && display !== 'contents';
                const positioned = position && position !== 'static';
                if (blockish && (positioned || !hasOutOfFlowChild(host, 3))) {
                    if (!positioned) host.classList.add('ms-open-in-gallery-host');
                    btn.classList.add('ms-open-in-gallery--pinned');
                    btn.style.setProperty('font-size', '11px', 'important');
                    btn.style.setProperty('height', '22px', 'important');
                    host.appendChild(btn);
                    return;
                }
            }
            host.insertAdjacentElement('afterend', btn);
        }

    function createOpenInGalleryButton(startNode, variant) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ms-open-in-gallery' + (variant ? ' ms-open-in-gallery--' + variant : '') +
                (variant === 'unfurl' ? ' fauxBlockLink-link' : '');
            btn.setAttribute('aria-label', 'Open in Gallery');
            btn.innerHTML = openInGalleryButtonHtml();
            protectHostControl(btn,true);
            // protectHostControl writes a font shorthand inline and !important, so
            // it would pin a fixed pixel size and the button would grow the host
            // line box again. A later longhand in the same inline block wins over
            // the earlier shorthand, so re-assert the em size here.
            btn.style.setProperty('font-size', '0.82em', 'important');
            btn.style.setProperty('height', '1.3em', 'important');
            btn.style.setProperty('min-height', '0', 'important');
            btn.style.setProperty('border-radius', '999px', 'important');
            btn.style.setProperty('pointer-events', 'auto', 'important');
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                bridge.launchGallery(startNode, { fromChrome: true });
            });
            btn.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                e.stopImmediatePropagation();
            });
            return btn;
        }
    function renderCurrent() {
            if (!bridge.state.overlay || !bridge.state.items.length) return;
            if (bridge.state.gridMode) return;
            bridge.syncCoreCurrent();
            // Let the current item paint before any host scroll/layout work starts.
            setTimeout(() => { if (bridge.state.open) bridge.checkTriggerInfiniteScroll(); }, 0);
            bridge.scheduleWindowResolution();
            disablePan();

            setTopbarLoading(false);
            bridge.state.hdUpgradeRun = null;
            updateHdButton('hidden');
            const token = ++bridge.state.renderToken;
            // Every render starts with the barrier down; the branch that actually
            // fetches something raises it again. Without this an item that fetches
            // nothing - an embed, an album cover - would leave the previous item's
            // barrier standing until its grace period ran out.
            setStageFetching(false);
            let entry = bridge.state.items[bridge.state.currentIndex];
            if (!entry) return;

            if (bridge.extraMediaCount(entry.item)) {
                bridge.expandResolvedEntry(entry);
                entry = bridge.state.items[bridge.state.currentIndex] || entry;
            }
            const item = entry.item;
            const presentation = bridge.mediaPresentation(item);

            const wrap = bridge.state.overlay.querySelector('.ms-media-wrap');
            const info = bridge.state.overlay.querySelector('.ms-gallery-info');
            const counter = bridge.state.overlay.querySelector('.ms-counter');
            const prevBtn = bridge.state.overlay.querySelector('.ms-nav.prev');
            const nextBtn = bridge.state.overlay.querySelector('.ms-nav.next');
            const thumbs = bridge.state.overlay.querySelectorAll('.ms-thumb');
            prepareMediaWrap(wrap, item);
            // Every value here goes into innerHTML, and URLs and error text come from
            // the page or a remote host - escape all of them, not only the byline.
            const escInfo = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            // The date, resolution and size line. Reserved for any image or video
            // so it does not appear late and push the link up.
            const infoMeta = (date) => (date || (item && (item.type === 'img' || item.type === 'video')))
                ? '<span class="ms-info-meta"><span class="ms-info-date"></span><span class="ms-info-dims"></span><span class="ms-info-bytes"></span></span>'
                : '';
            const buildInfoHtml = () => {
                const hasSourceOverride = !!(item && Object.prototype.hasOwnProperty.call(item, 'sourceUrl'));
                const linkUrl = item ? String(hasSourceOverride ? (item.sourceUrl || '') : (item.resolveUrl || item.src || '')) : '';
                if (item && item.error) {
                    return `<span style="color: #f43f5e;"><a href="${escInfo(linkUrl)}" target="_blank" rel="noopener noreferrer">Error: ${escInfo(item.error)} (${escInfo(linkUrl)})</a></span>`;
                }

                const author = presentation.author;
                if (author && (author.name || author.handle)) {
                    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                    const avatar = author.avatarUrl
                        ? `<img class="ms-info-avatar" src="${esc(author.avatarUrl)}" referrerpolicy="no-referrer" alt="">`
                        : '';
                    const whoHref = author.profileUrl || linkUrl;
                    const who = whoHref
                        ? `<a class="ms-info-author" href="${esc(whoHref)}" target="_blank" rel="noopener noreferrer" title="${esc(author.handle || author.name)}">${esc(author.name || author.handle)}</a>`
                        : `<span class="ms-info-author" title="${esc(author.handle || author.name)}">${esc(author.name || author.handle)}</span>`;
                    const date = presentation.date || '';
                    const source = linkUrl ? `<a href="${esc(linkUrl)}" target="_blank" rel="noopener noreferrer">${esc(linkUrl)}</a>` : '';
                    const meta = infoMeta(date);
                    const details = source || meta
                        ? `<span class="ms-info-sep">:</span><span class="ms-info-source">${source}${meta}</span>`
                        : '';
                    return `<span class="ms-info-byline">${avatar}${who}${details}</span>`;
                }

                if (item && (item.galleryName || item.filename)) {
                    const escG = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                    const galleryHref = item.galleryUrl || linkUrl;
                    // A file host (Gofile, Drive) names the file; the folder it
                    // came from goes in the tooltip.
                    const label = item.filename || item.galleryName;
                    const tip = item.filename && item.galleryName && item.galleryName !== item.filename
                        ? item.galleryName + ' / ' + item.filename : label;
                    return `<span class="ms-info-source"><a class="ms-info-author" href="${escG(galleryHref)}" target="_blank" rel="noopener noreferrer" title="${escG(tip)}">${escG(label)}</a>${infoMeta(presentation.date)}</span>`;
                }

                return linkUrl
                    ? `<span class="ms-info-source" style="color: var(--ms-text-2);"><a href="${escInfo(linkUrl)}" target="_blank" rel="noopener noreferrer">${escInfo(linkUrl)}</a>${infoMeta(presentation.date)}</span>`
                    : '';
            };

            if (item && item.type === 'iframe') bridge.state.overlay.classList.add('ms-iframe-nav-safe');
            else bridge.state.overlay.classList.remove('ms-iframe-nav-safe');

            if (item && item.needsResolve) {
                if (item.thumbSrc && !bridge.isPlaceholderUrl(item.thumbSrc)) {
                    const thumbImg = globalThis.XGalleryCore.createLoadingPreview({
                        document: document,
                        src: item.thumbSrc,
                        onLoad: (image) => {
                            if (image.isConnected) syncVerticalFitMediaBox(image);
                        }
                    });
                    ensureMediaBox(wrap).appendChild(thumbImg);
                    if (thumbImg.complete) syncVerticalFitMediaBox(thumbImg);
                }

                const loadingOverlay = globalThis.XGalleryCore.createResolveIndicator(document);
                wrap.appendChild(loadingOverlay);

                bridge.queueResolve(item.resolveUrl, item.expectedVideo).then((resolved) => {

                    if (resolved === bridge.RESOLVE_CANCELLED) return;
                    let splicedExtras = false;
                    if (resolved && resolved.src) {
                        item.src = resolved.src;
                        item.type = resolved.type || (resolved.isVideo ? 'video' : 'img');
                        if (resolved.thumbSrc) item.thumbSrc = resolved.thumbSrc;
                        item.embedSrc = resolved.embedSrc || item.embedSrc;
                        if (typeof resolved.isFavorited === 'boolean') {
                            item.isFavorited = resolved.isFavorited;
                        }
                        item.error = resolved.error || null;
                        if (item.type === 'video') {
                            item.fallbackSrc = resolved.src;

                            bridge.prepareResolvedVideo(item, resolved);
                        }

                        splicedExtras = bridge.spliceResolvedExtras(entry, resolved);
                    } else {
                        item.error = (resolved && resolved.error) || "Resolution failed. CORS or invalid link.";
                        if (item.fallbackSrc) {

                            item.src = item.fallbackSrc;
                        }
                    }
                    item.needsResolve = false;
                    if (splicedExtras) return;

                    const resolvedIndex = bridge.state.items.findIndex((candidate) => candidate === entry || candidate.item === item);
                    if (resolvedIndex !== -1) updateSingleThumb(resolvedIndex, entry);

                    if (token === bridge.state.renderToken) {
                        renderCurrent();
                    }
                });

                let domain = '';
                try {
                    if (item.resolveUrl) {
                        const parsedUrl = new URL(item.resolveUrl);
                        domain = parsedUrl.hostname.replace('www.', '');
                    }
                } catch (e) {
                    domain = 'unknown';
                }
                info.innerHTML = buildInfoHtml();
                paintInfoMeta(item);
                if (counter) {
                    const position = bridge.galleryPositionSnapshot();
                    counter.textContent = (position.currentIndex + 1) + ' / ' + position.length;
                }
                updatePositionControl();
                const singleItem = bridge.state.items.length <= 1;
                prevBtn.disabled = singleItem;
                nextBtn.disabled = singleItem;
                setActiveThumb(thumbs, true);
                return;
            }

            if (item.type === 'img') {
                const thumbSrc = item.thumbSrc || '';
                if (bridge.isItemGif(item)) showStageNotice(wrap, 'Loading GIF...');

                const candidates = [item.src];
                if (Array.isArray(item.altSrcs)) {
                    item.altSrcs.forEach((s) => {
                        if (s && candidates.indexOf(s) === -1) candidates.push(s);
                    });
                }
                const wrappedSrc = bridge.wrapMediaUrl(item.src);
                if (wrappedSrc !== item.src && candidates.indexOf(wrappedSrc) === -1) candidates.push(wrappedSrc);

                const startUpgrade = (img, force) => {
                    const setHd = (status) => { if (token === bridge.state.renderToken) updateHdButton(status); };
                    const spinnerOff = () => { if (token === bridge.state.renderToken) setTopbarLoading(false); };
                    if (!Array.isArray(item.upgradeSrcs) || !item.upgradeSrcs.length) {

                        setHd((item.atMaxRes || item.xAtMaxRes) ? 'max' : 'hidden');
                        spinnerOff();
                        return;
                    }
                    if (item.upgradeSrcs.indexOf(item.src) !== -1) {
                        item.upgradeSrcs = null;
                        setHd('max');
                        spinnerOff();
                        return;
                    }
                    if (!force && bridge.hdMode === 'off') {
                        setHd('hidden');
                        spinnerOff();
                        return;
                    }
                    if (!force && bridge.hdMode === 'manual') {
                        bridge.state.hdUpgradeRun = () => startUpgrade(img, true);
                        setHd('ready');
                        spinnerOff();
                        return;
                    }
                    if (token === bridge.state.renderToken) setTopbarLoading(true);
                    setHd('loading');
                    const upgrades = item.upgradeSrcs.slice();
                    const tryUpgrade = (i) => {
                        if (i >= upgrades.length) {
                            item.upgradeSrcs = null;
                            setHd('hidden');
                            spinnerOff();
                            return;
                        }

                        const cooldown = bridge.hostCooldownRemaining(upgrades[i]);
                        if (cooldown > 500) {
                            if (i + 1 < upgrades.length) {
                                setTimeout(() => {
                                    if (token === bridge.state.renderToken) tryUpgrade(i + 1);
                                }, 50);
                            } else {
                                setTimeout(() => {
                                    if (token === bridge.state.renderToken) tryUpgrade(i);
                                }, Math.min(cooldown, 30000));
                            }
                            return;
                        }
                        bridge.loadImageFully(upgrades[i])
                            .then(() => {
                                item.src = upgrades[i];
                                item.upgradeSrcs = null;
                                setHd('max');
                                spinnerOff();
                                if (token !== bridge.state.renderToken || !img.parentNode) return;
                                img.addEventListener('load', () => {
                                    if (token !== bridge.state.renderToken) return;
                                    noteMediaDimensions(item, img);

                                    syncVerticalFitMediaBox(img);
                                    if (!bridge.state.pan || bridge.state.pan.img !== img) return;

                                    const zoomed = bridge.state.pan.zoomed;
                                    const returnToFill = bridge.state.pan.returnToFill;
                                    const v = bridge.state.pan.view ? bridge.state.pan.view() : null;
                                    const wrapW = wrap.clientWidth;
                                    const wrapH = wrap.clientHeight;
                                    const cx = (v && v.dispW) ? (wrapW / 2 - v.x) / v.dispW : 0.5;
                                    const cy = (v && v.dispH) ? (wrapH / 2 - v.y) / v.dispH : 0.5;

                                    const newScale = (v && v.dispW && img.naturalWidth)
                                        ? v.dispW / img.naturalWidth
                                        : (zoomed ? 1 : Math.min(1, Math.max(wrapW / img.naturalWidth, wrapH / img.naturalHeight)));
                                    const newDispW = img.naturalWidth * newScale;
                                    const newDispH = img.naturalHeight * newScale;
                                    enablePanForImage(wrap, img, {
                                        zoom: zoomed,
                                        scale: newScale,
                                        initialX: wrapW / 2 - cx * newDispW,
                                        initialY: wrapH / 2 - cy * newDispH,
                                        returnToFill: returnToFill
                                    });
                                }, { once: true });
                                img.src = bridge.wrapMediaUrl(upgrades[i]);
                            })
                            .catch(() => tryUpgrade(i + 1));
                    };
                    tryUpgrade(0);
                };

                const showLoadedImage = (img, winnerSrc) => {
                    if (token !== bridge.state.renderToken) return;
                    if (winnerSrc && winnerSrc !== item.src && winnerSrc !== wrappedSrc) {
                        item.src = winnerSrc;
                    }

                    const box = ensureMediaBox(wrap);
                    box.querySelectorAll('video').forEach((element) => { if (element._msPooled) parkStageVideo(element); });
                    box.replaceChildren(img);
                    Array.from(wrap.children).forEach((el) => {
                        if (el !== box && !el.classList.contains('ms-caption-overlay')) el.remove();
                    });
                    syncVerticalFitMediaBox(img);
                    markItemMediaLoaded(item);
                    noteMediaDimensions(item, img);
                    updateMediaCaptionOverlay(item);
                    if (item.error) {
                        appendErrorBanner(wrap, item.error);
                    }
                    if (bridge.autoPanEnabled && !item.msNoAutoPan && shouldAutoPan(wrap, img)) {
                        enablePanForImage(wrap, img);
                    }
                    syncZoomSliderAvailability();

                    if (item.xUnplayable && item.watchUrl) {
                        const watch = document.createElement('a');
                        watch.href = item.watchUrl;
                        watch.target = '_blank';
                        watch.rel = 'noopener noreferrer';
                        // The label and colour are per-source: this used to be
                        // hardcoded "Watch video on X" in X's own blue, which read as
                        // wrong once other adapters (Bluesky's HLS videos, which no
                        // player here can decode) started reusing the same fallback.
                        const watchLabel = item.watchLabel || 'Watch video on X';
                        const watchColor = item.watchBrandColor || '#1d9bf0';
                        watch.innerHTML = '<svg style="width:14px;height:14px;vertical-align:middle;margin-right:6px;" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>' + watchLabel;
                        watch.style.cssText = 'position:absolute; bottom:24px; left:50%; transform:translateX(-50%); z-index:12; background:' + watchColor + '; color:#fff; text-decoration:none; font-size:14px; font-weight:700; padding:10px 22px; border-radius:22px; box-shadow:0 4px 16px rgba(0,0,0,0.4); font-family:system-ui,-apple-system,Segoe UI,sans-serif;';
                        watch.addEventListener('click', (e) => e.stopPropagation());
                        wrap.appendChild(watch);
                    }
                    img.addEventListener('click', (clickEvent) => {
                        clickEvent.stopPropagation();
                        handleImageZoomClick(wrap, img, item, clickEvent);
                    });
                    startUpgrade(img);
                };

                let lastFailure = '';
                const MAX_TRANSIENT_RETRIES = 2;
                const tryCandidate = (idx, attempt) => {
                    if (token !== bridge.state.renderToken) return;
                    const candidate = candidates[idx];
                    const startLoad = () => {
                        if (token !== bridge.state.renderToken) return;
                        bridge.loadImageFully(candidate, 10000)
                            .then((img) => {
                                bridge.noteHostSuccess(candidate);
                                setStageFetching(false);
                                showLoadedImage(img, candidate);
                            })
                            .catch((err) => {
                                if (token !== bridge.state.renderToken) return;
                                const timedOut = !!(err && /^timeout:/.test(err.message || ''));
                                bridge.probeUrlStatus(candidate).then((probe) => {
                                    if (token !== bridge.state.renderToken) return;
                                    lastFailure = bridge.describeLoadFailure(probe.status, timedOut);
                                    if (probe.status === 429 || probe.status === 503) {
                                        bridge.backoffHost(candidate, probe.retryAfterMs);
                                    }
                                    if (bridge.isTransientStatus(probe.status, timedOut) && attempt < MAX_TRANSIENT_RETRIES) {
                                        const delayMs = Math.max(bridge.hostCooldownRemaining(candidate), bridge.retryDelayMs(attempt));
                                        showStageNotice(wrap, lastFailure + ' - retrying in ' + Math.ceil(delayMs / 1000) + 's');
                                        setTimeout(() => tryCandidate(idx, attempt + 1), delayMs);
                                        return;
                                    }
                                    if (idx + 1 < candidates.length) {
                                        tryCandidate(idx + 1, 0);
                                    } else {
                                        hideStageNotice(wrap);
                                        setTopbarLoading(false);
                                        setStageFetching(false);
                                        noteStageFailure(candidate, { status: probe.status, timeout: timedOut });
                                        renderErrorStage(wrap, (item.error || 'Failed to load media') + ' (' + lastFailure + ')', item.src, item);
                                    }
                                });
                            });
                    };
                    const cooldown = bridge.hostCooldownRemaining(candidate);
                    if (cooldown > 500 && attempt === 0) {
                        if (idx + 1 < candidates.length) {
                            tryCandidate(idx + 1, 0);
                        } else {

                            showStageNotice(wrap, 'Rate limited - waiting ' + Math.ceil(cooldown / 1000) + 's');
                            setTimeout(startLoad, Math.min(cooldown, 20000));
                        }
                    } else {
                        startLoad();
                    }
                };
                setTopbarLoading(true);
                setStageFetching(true);
                tryCandidate(0, 0);
            } else if (item.type === 'video') {
                const predictedVideo = bridge.takePredictedVideo(item);
                let video;
                if (predictedVideo && !predictedVideo._msPooled) {
                    // An adapter that still prefetches into an element of its own.
                    video = bridge.takeStageVideo(wrap, predictedVideo);
                } else if (predictedVideo) {
                    // Handed back by the adapter: the loan is over.
                    video = predictedVideo;
                    video._msLent = false;
                } else {
                    video = idleStageVideo();
                    if (video) resetStageVideo(video);
                }
                const usedPredicted = !!video && video === predictedVideo;
                // Everything this render listens for is dropped in one go when the
                // element is next reused, or the listeners of every item it ever
                // showed would all still be answering.
                if (video && video._msRenderAbort) video._msRenderAbort.abort();
                const renderAbort = new AbortController();
                const on = (type, fn, opts) => video.addEventListener(type, fn, Object.assign({ signal: renderAbort.signal }, opts || {}));
                if (usedPredicted && video.error) {
                    video.removeAttribute('src');
                    try { video.load(); } catch (e) { }
                }
                const primaryVideoSrc = bridge.wrapMediaUrl(item.src);
                const bufferedVideo = bridge.requiresBufferedVideo(item);
                const videoPoster = item.thumbSrc && item.thumbSrc !== item.src && !bridge.isPlaceholderUrl(item.thumbSrc)
                    ? item.thumbSrc : '';
                video = globalThis.XGalleryCore.configureVideoElement({
                    document: document,
                    video: video,
                    poster: videoPoster,
                    volume: bridge.globalVolume,
                    muted: bridge.globalMuted,
                    // A video that stands in for an animated image (it carries the
                    // image as its fallback) loops like the image would, whatever
                    // the Loop preference for real videos says.
                    loop: bridge.globalLoop || !!item.imageFallbackSrc,
                    preload: usedPredicted ? '' : (bufferedVideo ? 'auto' : 'metadata')
                });
                video._msRenderAbort = renderAbort;
                // The same element showed the last item too, and the browser keeps
                // its controls' state with it: a set of controls that had faded
                // out while the previous video played stayed faded for this one
                // until it was clicked. Turning them off and on builds them fresh.
                if (video._msPooled) { video.controls = false; video.controls = true; }

                let lastPlayTime = 0;
                let lastSeekAt = 0;
                let seekRecoveries = 0;
                let stageRetried = false;
                let stallWatch = null;
                const ownsVideoSession = () => token === bridge.state.renderToken && video.isConnected && wrap.contains(video);
                // Starting over on the same element. A starved element recovers on
                // its own once the pressure is off, but clearing the src and asking
                // again is what stepping back and returning does by hand, and it is
                // the sequence measured to work.
                const restartStageVideo = () => {
                    if (!ownsVideoSession()) return;
                    video._msRecovering = true;
                    try { video.pause(); } catch (e) { }
                    video.removeAttribute('src');
                    try { video.load(); } catch (e) { }
                    video.src = primaryVideoSrc;
                    try { video.load(); } catch (e) { }
                    const resumed = video.play();
                    if (resumed && typeof resumed.catch === 'function') resumed.catch(() => { });
                    setTimeout(() => { video._msRecovering = false; }, 250);
                };
                on('timeupdate', () => {
                    if (video.currentTime > 0) lastPlayTime = video.currentTime;
                });
                on('seeking', () => { lastSeekAt = Date.now(); });
                on('seeked', () => { lastSeekAt = Date.now(); });

                if (bridge.state.lastPlayTime && bridge.state.lastPlayTime > 0) {
                    const seekToTime = bridge.state.lastPlayTime;
                    bridge.state.lastPlayTime = 0;
                    const onCanPlay = () => {
                        if (!ownsVideoSession()) return;
                        video.currentTime = seekToTime;
                        video.removeEventListener('loadedmetadata', onCanPlay);
                        video.removeEventListener('canplay', onCanPlay);
                    };
                    on('loadedmetadata', onCanPlay);
                    on('canplay', onCanPlay);
                }

                if (video.readyState >= 2) markItemMediaLoaded(item);
                else on('loadeddata', () => {
                    if (!ownsVideoSession()) return;
                    markItemMediaLoaded(item);
                }, { once: true });
                on('loadeddata', () => {
                    if (stallWatch) stallWatch.stop(true);
                    bridge.noteHostSuccess(item.src);
                }, { once: true });

                const retrySources = [];
                if (Array.isArray(item.altSrcs)) {
                    item.altSrcs.forEach((s) => {
                        if (s && s !== item.src) retrySources.push(bridge.wrapMediaUrl(s));
                    });
                }
                if (item.fallbackSrc && item.fallbackSrc !== item.src) retrySources.push(bridge.wrapMediaUrl(item.fallbackSrc));

                let retryIndex = 0;
                on('error', () => {
                    if (!ownsVideoSession() || video._msRecovering) return;
                    const errCode = video.error ? video.error.code : 0;
                    const resumeAt = Math.max(video.currentTime || 0, lastPlayTime || 0);
                    const seekGlitch = video.seeking || (Date.now() - lastSeekAt) < 1500 || errCode === 1;
                    const duration = Number.isFinite(video.duration) ? video.duration : 0;
                    const nearEndFailure = video.ended || (duration > 0 && resumeAt >= Math.max(0, duration - Math.max(0.75, duration * 0.01)));

                    if (nearEndFailure && resumeAt > 0) {
                        video._msRecovering = true;
                        const src = video.currentSrc || video.src || primaryVideoSrc;
                        const resetForReplay = () => {
                            if (!ownsVideoSession()) return;
                            if (video._msEndRecoveryTimer) clearTimeout(video._msEndRecoveryTimer);
                            video._msRecovering = false;
                            try { video.currentTime = 0; } catch (e) { }
                            syncVerticalFitMediaBox(video);
                            if (bridge.globalLoop) {
                                const replay = video.play();
                                if (replay && typeof replay.catch === 'function') replay.catch(() => { });
                            } else {
                                try { video.pause(); } catch (e) { }
                            }
                        };
                        on('loadedmetadata', resetForReplay, { once: true });
                        video._msEndRecoveryTimer = setTimeout(() => { video._msRecovering = false; }, 4000);
                        try {
                            if (src && video.getAttribute('src') !== src) video.src = src;
                            else video.load();
                        } catch (e) { video._msRecovering = false; }
                        return;
                    }

                    if (seekGlitch && resumeAt > 0 && seekRecoveries < 2) {
                        seekRecoveries++;
                        video._msRecovering = true;
                        const src = video.currentSrc || video.src || primaryVideoSrc;
                        const resume = () => {
                            if (!ownsVideoSession()) return;
                            video._msRecovering = false;
                            try { video.currentTime = resumeAt; } catch (e) { }
                            const p = video.play();
                            if (p && typeof p.catch === 'function') p.catch(() => { });
                        };
                        try {
                            if (src && video.getAttribute('src') !== src) video.src = src;
                            else video.load();
                            on('loadedmetadata', resume, { once: true });
                        } catch (e) { video._msRecovering = false; }
                        return;
                    }
                    const failedSrc = video.currentSrc || video.src || item.src;
                    const signedHost = presentation.signedVideo;
                    const neverPlayed = resumeAt < 0.25 && video.readyState < 2;
                    if (signedHost && neverPlayed && item.resolveUrl && !item._signedRefreshTried) {
                        item._signedRefreshTried = true;
                        bridge.resolvedFileUrlCache.delete(item.resolveUrl);
                        bridge.resolvingFileUrlCache.delete(item.resolveUrl);
                        bridge.state.lastPlayTime = resumeAt;
                        item.needsResolve = true;
                        delete item.error;
                        renderCurrent();
                        return;
                    }
                    if (retryIndex >= retrySources.length) {
                        if (presentation.allowImageFallback !== false && item.imageFallbackSrc && !item._imageFallbackTried) {
                            item._imageFallbackTried = true;
                            item.src = item.imageFallbackSrc;
                            item.type = 'img';
                            item.isVideo = false;
                            item.mediaMime = '';
                            item.detectedFormat = '';
                            item.detectedFormatSource = '';
                            item.isGif = /\.gif(?:\?|#|$)/i.test(item.src);
                            item.needsResolve = false;
                            const itemIndex = bridge.state.items.findIndex((entry) => (entry.item || entry) === item);
                            if (itemIndex >= 0) updateSingleThumb(itemIndex, bridge.state.items[itemIndex]);
                            renderCurrent();
                            return;
                        }
                        if (item.embedSrc) {
                            item.src = item.embedSrc;
                            item.type = 'iframe';
                            item.needsResolve = false;
                            renderCurrent();
                            return;
                        }
                        // A host that is refusing the overflow (408, 429, a
                        // dropped connection) looks exactly like a broken file
                        // from here. Try once more, with the decorative fetches
                        // called off, before telling the user it cannot be loaded.
                        if (!stageRetried && resumeAt < 0.25) {
                            stageRetried = true;
                            noteStageFailure(item.src, { status: 0, timeout: true });
                            yieldNetworkToStage();
                            showStageNotice(wrap, 'Retrying\u2026');
                            setTimeout(() => {
                                if (!ownsVideoSession()) return;
                                hideStageNotice(wrap);
                                retryIndex = 0;
                                restartStageVideo();
                            }, 1200);
                            return;
                        }
                        if (stallWatch) stallWatch.stop(true);
                        setStageFetching(false);
                        renderErrorStage(wrap, item.error || 'Failed to load video resource.', item.src, item);
                        return;
                    }
                    const nextSrc = retrySources[retryIndex++];
                    video.src = nextSrc;
                    if (resumeAt > 0) {
                        const seekToTime = resumeAt;
                        const onCanPlay = () => {
                            if (!ownsVideoSession()) return;
                            video.currentTime = seekToTime;
                            video.removeEventListener('loadedmetadata', onCanPlay);
                            video.removeEventListener('canplay', onCanPlay);
                        };
                        on('loadedmetadata', onCanPlay);
                        on('canplay', onCanPlay);
                    }
                    const retry = video.play();
                    if (retry && typeof retry.catch === 'function') retry.catch(() => { });
                });

                on('volumechange', () => {
                    if (!ownsVideoSession()) return;
                    bridge.globalVolume = video.volume;
                    bridge.globalMuted = video.muted;
                    bridge.savePreference('MS_BETTER_VIDEO_VOLUME', bridge.globalVolume);
                    bridge.savePreference('MS_BETTER_VIDEO_MUTED', bridge.globalMuted);
                });
                on('loadedmetadata', () => {
                    if (!ownsVideoSession()) return;
                    syncVerticalFitMediaBox(video);
                    noteMediaDimensions(item, video);
                });
                if (video.readyState >= 1) noteMediaDimensions(item, video);
                if (!video.isConnected || !video.closest('.ms-media-box')) placeNode(ensureMediaBox(wrap), video);
                const revealVideo = () => {
                    if (!ownsVideoSession()) return;
                    video.classList.add('ms-ready');
                    video.style.opacity = '1';
                };
                // One media element owns both poster and playback. An extra image
                // caused a second layout and a blank handoff before the first frame.
                wrap.querySelectorAll('img.ms-media, img.ms-loading-thumb').forEach(el => el.remove());
                video.style.opacity = '1';
                if (video.readyState >= 1) syncVerticalFitMediaBox(video);
                if (video.readyState >= 2) revealVideo();
                else on('loadeddata', revealVideo, { once: true });
                let videoActivated = false;
                const activateVideo = () => {
                    if (videoActivated || token !== bridge.state.renderToken || !video.isConnected) return;
                    videoActivated = true;
                    video.preload = bufferedVideo ? 'auto' : 'metadata';
                    if (!video.getAttribute('src')) video.src = primaryVideoSrc;
                    const promise = video.play();
                    if (promise && typeof promise.catch === 'function') promise.catch(() => { });
                };
                on('pointerdown', activateVideo, { once: true });
                if ((usedPredicted || bufferedVideo) && !video.getAttribute('src')) video.src = primaryVideoSrc;
                if (video.readyState < 2) {
                    setStageFetching(true);
                    stallWatch = watchStageMedia({
                        element: video,
                        signal: renderAbort.signal,
                        wrap: wrap,
                        url: item.src,
                        isCurrent: ownsVideoSession,
                        onRestart: restartStageVideo
                    });
                }
                // Two frames let navigation and the poster reach the screen before
                // stream initialization. Superseded items never start a decoder.
                requestAnimationFrame(() => requestAnimationFrame(activateVideo));
            } else {
                if (presentation.coverAlbum) {
                    const coverImg = globalThis.XGalleryCore.createImageMedia({
                        document: document,
                        src: bridge.wrapMediaUrl(item.thumbSrc || item.src),
                        onLoad: image => { syncVerticalFitMediaBox(image); markItemMediaLoaded(item); }
                    });
                    coverImg.style.cssText = 'max-height: 100%; max-width: 100%; object-fit: contain;';
                    ensureMediaBox(wrap).appendChild(coverImg);
                } else {
                    const iframe = globalThis.XGalleryCore.createIframeMedia({
                        document: document,
                        src: item.src,
                        onLoad: () => markItemMediaLoaded(item)
                    });
                    wrap.appendChild(iframe);

                    const shield = globalThis.XGalleryCore.createIframeShield({
                        document: document,
                        onRelease: () => window.focus()
                    });
                    wrap.appendChild(shield);
                }

                if (presentation.expandable && item.type !== 'img' && item.type !== 'video') {
                    const btn = globalThis.XGalleryCore.createExpandButton({
                        document: document,
                        label: presentation.coverAlbum ? 'Expand gallery' : 'Expand album',
                        onExpand: () => {
                        if (bridge.folderFavorites) bridge.expandPhotoAlbum(item.src, bridge.state.currentIndex);
                        else bridge.expandSingleRemoteAlbum(item.src, bridge.state.currentIndex);
                        }
                    });
                    wrap.appendChild(btn);
                }
            }

            let domain = '';
            try {
                if (item.resolveUrl) {
                    const parsedUrl = new URL(item.resolveUrl);
                    domain = parsedUrl.hostname.replace('www.', '');
                } else if (item.src) {
                    const parsedUrl = new URL(item.src);
                    domain = parsedUrl.hostname.replace('www.', '');
                }
            } catch (e) {
                domain = 'unknown';
            }

            info.innerHTML = buildInfoHtml();
            paintInfoMeta(item);
            const position = bridge.galleryPositionSnapshot();
            globalThis.XGalleryCore.renderPosition({
                counter: counter,
                previous: prevBtn,
                next: nextBtn,
                currentIndex: position.currentIndex,
                length: position.length
            });
            updatePositionControl();

            setActiveThumb(thumbs, true);

            bridge.updateTopbarStates();
            bridge.refreshTitleRow();
            updateMediaCaptionOverlay(item);
            if (bridge.needsPostDetails(item) && typeof bridge.ensurePostDetails === 'function') {
                bridge.ensurePostDetails(item, () => {
                    const current = bridge.state.items[bridge.state.currentIndex];
                    const currentItem = current ? (current.item || current) : null;
                    if (currentItem !== item) return;
                    paintInfoMeta(item);
                    updateMediaCaptionOverlay(item);
                    const tagsOverlay = bridge.state.overlay && bridge.state.overlay.querySelector('.ms-tags-overlay');
                    if (tagsOverlay && tagsOverlay.classList.contains('active')) bridge.applyTagsPanel(true);
                });
            }

            bridge.schedulePreloadAroundCurrent(bridge.state.navigationDirection ? 100 : 250);
        }

    function paintCurrentLikeButton(liked, count) {
            if (!bridge.state.overlay) return;
            const likeEl = bridge.state.overlay.querySelector('.ms-tags-like-btn');
            if (!likeEl) return;
            likeEl.classList.toggle('active', !!liked);
            let countEl = likeEl.querySelector('.ms-tags-like-count');
            if (count !== '' && count != null) {
                if (!countEl) {
                    countEl = document.createElement('span');
                    countEl.className = 'ms-tags-like-count';
                    likeEl.appendChild(countEl);
                }
                countEl.textContent = String(count);
            }
        }

    function paintPostActions(data) {
            if (!bridge.state.overlay) return;
            const entry = bridge.state.items[bridge.state.currentIndex];
            const item = entry ? (entry.item || entry) : null;
            const currentId = bridge.actionPostId(item);
            const likeBtn = bridge.state.overlay.querySelector('[data-act="x-like"]');
            const bookmarkBtn = bridge.state.overlay.querySelector('[data-act="x-bookmark"]');
            const visible = !!currentId;
            if (likeBtn) {
                likeBtn.style.display = visible ? '' : 'none';
                likeBtn.disabled = !visible || !data || data.tweetId !== currentId || !data.likeAvailable;
                likeBtn.classList.toggle('active', !!(data && data.tweetId === currentId && data.liked));
                likeBtn.title = likeBtn.disabled ? 'Like unavailable for this post' : (data.liked ? 'Unlike post' : 'Like post');
            }
            if (bookmarkBtn) {
                bookmarkBtn.style.display = visible ? '' : 'none';
                bookmarkBtn.disabled = !visible || !data || data.tweetId !== currentId || !data.bookmarkAvailable;
                bookmarkBtn.classList.toggle('active', !!(data && data.tweetId === currentId && data.bookmarked));
                bookmarkBtn.title = bookmarkBtn.disabled ? 'Bookmark unavailable for this post' : (data.bookmarked ? 'Remove bookmark' : 'Bookmark post');
            }
        }
    // Hovering the gear slides out which adapter and core are running, so a bug
    // report can name them without opening settings. The cluster is anchored on
    // its right edge, so the label grows the gear leftwards.
    function versionLabelText() {
            let name = '';
            let version = '';
            try { name = String(bridge.adapterName || '').trim(); version = String(bridge.adapterVersion || '').trim(); } catch (e) { }
            const adapter = name ? name + (version ? ' ' + version : '') : '';
            return (adapter ? adapter + ' · ' : '') + 'XG-core ' + XGALLERY_CORE_VERSION;
        }

    function mountVersionLabel(gear) {
            const label = document.createElement('span');
            label.className = 'ms-site-version-label';
            label.textContent = versionLabelText();
            const icon = gear.querySelector('svg');
            const values = {display:'block',overflow:'hidden','white-space':'nowrap','max-width':'0',opacity:'0',
                padding:'0',margin:'0',color:'#b9bcc3',font:'500 11px/36px ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
                'letter-spacing':'0','text-transform':'none','pointer-events':'none',
                transition:'max-width 260ms cubic-bezier(0.23, 1, 0.32, 1), opacity 180ms ease, padding 260ms cubic-bezier(0.23, 1, 0.32, 1)'};
            for (const [key,value] of Object.entries(values)) label.style.setProperty(key,value,'important');
            if (icon) {
                icon.style.setProperty('flex','0 0 36px','important');
                icon.style.setProperty('transition','transform 180ms cubic-bezier(0.23, 1, 0.32, 1)','important');
            }
            gear.insertBefore(label, gear.firstChild);
            const open = (show) => {
                if (show) label.textContent = versionLabelText();
                label.style.setProperty('max-width', show ? '320px' : '0', 'important');
                label.style.setProperty('opacity', show ? '1' : '0', 'important');
                label.style.setProperty('padding', show ? '0 2px 0 12px' : '0', 'important');
                if (icon) icon.style.setProperty('transform', show ? 'rotate(45deg)' : 'none', 'important');
            };
            gear.addEventListener('pointerenter', () => open(true));
            gear.addEventListener('pointerleave', () => open(false));
            gear.addEventListener('focus', () => { let visible = false; try { visible = gear.matches(':focus-visible'); } catch (e) { } if (visible) open(true); });
            gear.addEventListener('blur', () => open(false));
        }

    function addSettingsGearButton() {
            const cluster = ensureLauncherCluster();
            const existingGear = document.getElementById('ms-site-settings-btn');
            if (existingGear) {
                // A rebuilt body can strand it outside the cluster; re-home rather
                // than bail, or the seams and corners come out wrong.
                if (existingGear.parentNode !== cluster) placeInCluster(cluster, existingGear, 'settings');
                return;
            }
            const gear = document.createElement('button');
            gear.type = 'button';
            gear.id = 'ms-site-settings-btn';
            gear.className = 'ms-site-cluster-btn ms-site-settings-btn';
            gear.innerHTML = '<svg style="width:18px;height:18px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" fill="none"/><path fill="none" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
            gear.title = 'Gallery Settings';
            gear.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                bridge.showGallerySettings();
            });
            gear.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
            });
            protectClusterButton(gear);
            gear.style.setProperty('width','auto','important');
            gear.style.setProperty('min-width','36px','important');
            gear.style.setProperty('padding','0','important');
            gear.style.setProperty('gap','0','important');
            mountVersionLabel(gear);
            placeInCluster(cluster, gear, 'settings');
        }

    function closeFavoriteMenu() {
            if (!bridge.state.overlay) return;
            const menu = bridge.state.overlay.querySelector('.ms-imgfap-fav-menu');
            if (menu) menu.remove();
        }

    function positionFavoriteMenu(menu, anchor) {
            if (!menu || !anchor) return;
            const rect = anchor.getBoundingClientRect();
            const top = Math.max(12, Math.min(window.innerHeight - menu.offsetHeight - 12, rect.bottom + 8));
            menu.style.top = top + 'px';
            menu.style.right = Math.max(12, window.innerWidth - rect.right) + 'px';
        }

    function setFavoriteMenuStatus(menu, text, kind) {
            const status = menu && menu.querySelector('.ms-imgfap-fav-status');
            if (!status) return;
            status.textContent = text || '';
            status.className = 'ms-imgfap-fav-status' + (kind ? ' ' + kind : '');
        }

    function addFavoriteMenuSection(menu, item, kind, options) {
            if (!menu || !options || !options.length) return;
            const section = document.createElement('div');
            section.className = 'ms-imgfap-fav-section';
            const label = document.createElement('label');
            label.className = 'ms-imgfap-fav-label';
            label.textContent = kind === 'gallery' ? 'Gallery folder' : 'Image folder';
            section.appendChild(label);

            const controls = document.createElement('div');
            controls.className = 'ms-imgfap-fav-controls';
            const select = document.createElement('select');
            options.forEach((option) => {
                const node = document.createElement('option');
                node.value = option.value;
                node.textContent = option.label;
                select.appendChild(node);
            });
            controls.appendChild(select);

            const add = document.createElement('button');
            add.type = 'button';
            add.textContent = 'Add';
            add.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                const value = select.value;
                const needsName = value === '0' || value === '__NEW_PICTURE__';
                let newName = '';
                if (needsName) {
                    newName = window.prompt(kind === 'gallery' ? 'New gallery folder name' : 'New image folder name', '') || '';
                    if (!newName.trim()) return;
                }
                add.disabled = true;
                select.disabled = true;
                setFavoriteMenuStatus(menu, 'Saving...', '');
                try {
                    const result = await bridge.saveFavorite(item, kind, value, newName);
                    bridge.recordFolderFavorite(item, kind);
                    const favBtn = bridge.state.overlay && bridge.state.overlay.querySelector('[data-act="fav-toggle"]');
                    if (favBtn) favBtn.classList.add('active');
                    setFavoriteMenuStatus(menu, result.message || 'Added to favorites.', 'success');
                } catch (error) {
                    setFavoriteMenuStatus(menu, error && error.message ? error.message : 'Could not add this favorite.', 'error');
                } finally {
                    add.disabled = false;
                    select.disabled = false;
                }
            });
            controls.appendChild(add);
            section.appendChild(controls);
            menu.insertBefore(section, menu.querySelector('.ms-imgfap-fav-status'));
        }

    async function openFavoriteFolders(item, anchor) {
            if (!bridge.state.overlay || !item || !anchor) return;
            const ids = bridge.favoriteIdentifiers(item);
            const key = ids.gid + '|' + ids.photoId;
            const existing = bridge.state.overlay.querySelector('.ms-imgfap-fav-menu');
            if (existing && existing.dataset.key === key) {
                existing.remove();
                return;
            }
            closeFavoriteMenu();

            const menu = document.createElement('div');
            menu.className = 'ms-imgfap-fav-menu';
            menu.dataset.key = key;
            menu.innerHTML = '<div class="ms-imgfap-fav-title">Add to favorites</div><div class="ms-imgfap-fav-status">Loading folders...</div>';
            menu.addEventListener('click', (event) => event.stopPropagation());
            bridge.state.overlay.appendChild(menu);
            positionFavoriteMenu(menu, anchor);

            try {
                const data = await bridge.loadFavoriteFolders(item);
                if (!menu.isConnected || menu.dataset.key !== key) return;
                addFavoriteMenuSection(menu, item, 'gallery', data.galleryFolders || []);
                addFavoriteMenuSection(menu, item, 'image', data.imageFolders || []);
                setFavoriteMenuStatus(menu, data.error || '', data.error ? 'error' : '');
                requestAnimationFrame(() => positionFavoriteMenu(menu, anchor));
            } catch (error) {
                setFavoriteMenuStatus(menu, error && error.message ? error.message : 'Could not load favorite folders.', 'error');
            }
        }
    return { openEditorWindow, openEditorFrame, flashHostElement, snapshotGhostSource, paintClusterSeams, mountOpenInGalleryButton, hasOutOfFlowChild, prefersReducedMotion, flyGhost, cancelFlyGhost, scrollGridToCurrent, flyFromCell, syncZoomSliderAvailability, createLauncher, beginOpen, resetLayout, finishOpen, clearViewerMedia, revealHost, addSettingsGearButton, closeFavoriteMenu, positionFavoriteMenu, setFavoriteMenuStatus, addFavoriteMenuSection, openFavoriteFolders, showPostPanel, setInfoPanelVisible, isInfoPanelVisible, setTitlePanelVisible, refreshGridSize, renderTitleRow, paintTopbar, renderCurrent, paintCurrentLikeButton, paintPostActions, showStageNotice, hideStageNotice, showGalleryEndNotice, getLoadingOverlay, showLoadingOverlay, updateLoadingOverlay, hideLoadingOverlay, ensureOverlay, onOverlayClick, tagsPanelIsScrollable, onOverlayWheel, navigateFromWheel, getWheelNavigationDirection, updateDropdownActiveStates, setBtnLabel, measureRowContentWidth, topbarLayoutSignature, updateTopbarCompact, bindTopbarCompactObserver, updateButtons, updatePositionControl, commitPositionInput, bindPositionControl, ensureMediaBox, syncVerticalFitMediaBox, applyFitClass, toggleThumbs, setGridMode, renderGrid, disablePan, applyTitleRowHeight, applyTagsFontSize, bindTitleRowResizer, bindTagsPanelResizer, toggleTagsPanel, captionHtmlFromItem, captionFitsSnapchat, setCaptionMode, clickCaptionModeButton, handleCaptionModeMessage, applyCaptionSnapInset, bindCaptionSnapDrag, updateMediaCaptionOverlay, appendCaptionModeControls, setTopbarLoading, updateHdButton, enablePanForImage, shouldAutoPan, togglePanMode, clearFullscreenIdleTimer, scheduleFullscreenIdleHide, wakeFullscreenTopbar, toggleStageFullscreen, handleImageZoomClick, createPlaceholderIcon, getPastelColorForGroupId, getSourceClass, promoteLazyThumbVideo, promoteLazyMp4Poster, observeLazyThumb, createLazyThumbVideo, createLazyMp4PosterImg, preloadStageVideo, appendVideoThumbMedia, stopThumbTrackAnimation, animateThumbTrackTo, setActiveThumb, thumbStripCenterTarget, applyThumbStripCenter, thumbSourceClass, thumbItemKey, resetMediaThumbEl, onWindowedThumbClick, onWindowedGridClick, fillThumbButton, invalidateThumbGroupData, thumbGroupData, thumbsGroupCounts, ensureThumbsWindow, onThumbsWindowScroll, takePoolCell, paintThumbsWindow, paintLoadMarks, paintThumbGroupOutlines, syncThumbsWindow, gridMetrics, ensureGridWindow, onGridWindowScroll, paintGridWindow, fillGridCell, syncGridWindow, renderThumbs, updateSingleThumb, markItemMediaLoaded, enableThumbDragScroll, appendErrorBanner, renderErrorStage, prepareMediaWrap, bindGlobalGalleryHandlers, unbindGlobalGalleryHandlers, closeGallerySettings, openInGalleryButtonHtml, createOpenInGalleryButton };
    }

    root.XGalleryCore = Object.freeze({
        BRIDGE_METHODS,
        CORE_EVENTS,
        CORE_MANIFEST_URL,
        CORE_UPDATE_INTERVAL_MS,
        GalleryController,
        inspectImageFormat,
        MEDIA_LANES,
        createMediaGate,
        sharedMediaGate,
        planVideoThumb,
        THUMB_PLANS,
        GOOGLE_DRIVE_FOLDER_MIME,
        googleDriveFolderId,
        googleDriveFileId,
        googleDriveListingUrl,
        googleDriveFileUrls,
        parseGoogleDriveFolderListing,
        readGoogleDriveFolder,
        createViewerRuntime,
        renderPostPanel,
        createSettingsPanel,
        MEDIA_TYPES,
        XGALLERY_CORE_API_VERSION,
        XGALLERY_CORE_VERSION,
        XGALLERY_CORE_LOCAL: false,
        compareCoreVersions,
        OVERLAY_CSS,
        configureVideoElement,
        createExpandButton,
        createImageMedia,
        createIframeMedia,
        createIframeShield,
        createLoadingPreview,
        createPlaceholderIcon,
        createResolveIndicator,
        createOverlayShell,
        createGalleryBridge,
        DEFAULT_FILTER_STATE,
        FILTER_TYPE_OPTIONS,
        applyGalleryFilter,
        bindFilterBar,
        filterBarMarkup,
        itemExtension,
        itemSearchText,
        matchGalleryItem,
        normalizeFilterState,
        parseSearchQuery,
        ensureMediaBox,
        installOverlayStyles,
        installLauncherStyles,
        LAUNCHER_CSS,
        DEFAULT_ACCENT,
        ACCENT_PRESETS,
        accentTokens,
        applyAccent,
        isTrustedCoreUrl,
        normalizeMediaItem,
        parseCoreManifest,
        sha256Hex,
        shouldInstallCore,
        prepareMediaSlot,
        renderErrorBanner,
        renderErrorStage,
        renderPosition,
        renderThumbnailCell,
        validateMediaItem,
        verifiedCoreRecord
    });
})(typeof globalThis !== 'undefined' ? globalThis : this);
