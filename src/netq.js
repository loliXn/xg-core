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

export const MEDIA_LANES = Object.freeze({
    STAGE: 0,       // the media on screen; never waits for anything
    VISIBLE: 1,     // thumbnails the user can see
    PREFETCH: 2,    // the next item, neighbour images, resolves
    BACKGROUND: 3   // off-screen thumbnails, probes, first-frame extraction
});

const LANE_NAMES = ['stage', 'visible', 'prefetch', 'background'];

// How much else may run while the stage is still waiting for its first
// bytes. Two concurrent fetches never delayed the stage in the measurements;
// six starved it. So the barrier is a narrowing, not a stop: the stage can be
// slow for honest reasons - a big file on a slow host - and a strip that
// froze for as long as a video took to start would be its own bug. The
// first version did exactly that, then let one request through at a time,
// and on a slow host that was a minute of nothing followed by everything.
const BARRIER_WIDTH = 2;

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
export function createMediaGate(options) {
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
export function sharedMediaGate(options) {
    if (!sharedGate) sharedGate = createMediaGate(options);
    return sharedGate;
}
