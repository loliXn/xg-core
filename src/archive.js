// Optional ZIP support. The caller owns dependency configuration and transport.
export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
    maxEntries: 10000,
    maxDirectoryBytes: 16 * 1024 * 1024,
    maxImageBytes: 64 * 1024 * 1024,
    maxTotalExpandedBytes: 4 * 1024 * 1024 * 1024,
    maxExpansionRatio: 1000,
    maxPageCacheBytes: 128 * 1024 * 1024,
    maxThumbCacheBytes: 16 * 1024 * 1024,
    maxDecodedBytes: 96 * 1024 * 1024,
    thumbnailSize: 256
});

export class ArchiveError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ArchiveError';
        this.code = code;
        Object.assign(this, details);
    }
}

const zipArchivePools = new WeakMap();
const zipArchiveExtensions = new Set(['jpg', 'jpeg', 'jfif', 'png', 'apng', 'gif', 'webp', 'avif', 'bmp']);
const zipArchivePriority = new Map([['current', 0], ['adjacent', 1], ['visible', 2]]);
const zipArchivePurposes = new Map([['stage', 0], ['download', 0], ['preload', 1], ['thumb', 2]]);

function zipArchiveAbort(signal) {
    const error = new Error('Archive operation cancelled.');
    error.name = 'AbortError';
    if (signal && signal.reason instanceof Error) error.cause = signal.reason;
    return error;
}

function zipArchiveCheck(signal) {
    if (signal && signal.aborted) throw zipArchiveAbort(signal);
}

function zipArchiveProgress(callback, progress) {
    if (typeof callback !== 'function') return;
    try {
        // Progress observers must not break extraction or leave rejected promises.
        Promise.resolve(callback(progress)).catch(() => {});
    } catch { /* observer failure */ }
}

function zipArchiveBound(condition, code, message) {
    if (!condition) throw new ArchiveError(code, message);
}

function zipArchiveLimits(overrides) {
    const result = { ...DEFAULT_ARCHIVE_LIMITS };
    for (const key of Object.keys(result)) {
        if (overrides && overrides[key] !== undefined) result[key] = overrides[key];
        zipArchiveBound(Number.isSafeInteger(result[key]) && result[key] > 0,
            'INVALID_OPTIONS', 'Archive limits must be positive safe integers: ' + key);
    }
    return Object.freeze(result);
}

function zipArchiveView(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function zipArchiveUint64(view, offset) {
    const low = view.getUint32(offset, true);
    const high = view.getUint32(offset + 4, true);
    const value = high * 0x100000000 + low;
    zipArchiveBound(Number.isSafeInteger(value), 'UNSUPPORTED_ZIP64',
        'ZIP64 values exceed safe random-access offsets. Use a desktop archive reader.');
    return value;
}

async function zipArchiveRead(source, offset, length, signal) {
    zipArchiveCheck(signal);
    zipArchiveBound(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0
        && offset <= source.size && length <= source.size - offset,
    'INVALID_ZIP', 'An archive read falls outside the source.');
    if (!length) return new Uint8Array(0);
    const bytes = await source.read(offset, length, signal);
    zipArchiveCheck(signal);
    zipArchiveBound(bytes instanceof Uint8Array && bytes.byteLength === length,
        'SOURCE_READ', 'Archive source must return exactly the requested bytes.');
    return bytes;
}

// Validate allocation sizes and every record BEFORE handing the source to zip.js.
// Reject offset repair, trailing data and split archives rather than letting a
// tolerant parser turn a small declared directory into an unrestricted read.
async function zipArchivePreflight(source, limits, signal, onProgress) {
    zipArchiveBound(source.size >= 22, 'INVALID_ZIP', 'The source is too short to be a ZIP archive.');
    const tailOffset = Math.max(0, source.size - 22 - 65535);
    const tail = await zipArchiveRead(source, tailOffset, source.size - tailOffset, signal);
    const view = zipArchiveView(tail);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--) {
        if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === tail.length) {
            zipArchiveBound(end === -1, 'INVALID_ZIP', 'Multiple ZIP end records are ambiguous.');
            end = at;
        }
    }
    zipArchiveBound(end >= 0, 'INVALID_ZIP', 'ZIP end record not found. Trailing or incomplete data is unsupported.');
    const endOffset = tailOffset + end;
    let count = view.getUint16(end + 10, true);
    let directoryBytes = view.getUint32(end + 12, true);
    let directoryOffset = view.getUint32(end + 16, true);
    let directoryEnd = endOffset;
    const disk = view.getUint16(end + 4, true);
    const directoryDisk = view.getUint16(end + 6, true);
    const diskCount = view.getUint16(end + 8, true);
    zipArchiveBound(disk === 0 && directoryDisk === 0, 'UNSUPPORTED_SPLIT',
        'Split ZIP archives are unsupported. Combine the volumes with a desktop archive tool.');
    const needs64 = count === 0xffff || diskCount === 0xffff
        || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff;
    const locator = endOffset >= 20 ? await zipArchiveRead(source, endOffset - 20, 20, signal) : null;
    const locatorView = locator && zipArchiveView(locator);
    if (locatorView && locatorView.getUint32(0, true) === 0x07064b50) {
        zipArchiveBound(locatorView.getUint32(4, true) === 0 && locatorView.getUint32(16, true) === 1,
            'UNSUPPORTED_SPLIT', 'Multi-volume ZIP64 archives must be combined before reading.');
        directoryEnd = zipArchiveUint64(locatorView, 8);
        const zip64 = zipArchiveView(await zipArchiveRead(source, directoryEnd, 56, signal));
        zipArchiveBound(zip64.getUint32(0, true) === 0x06064b50, 'INVALID_ZIP', 'Invalid ZIP64 end record.');
        const recordBytes = zipArchiveUint64(zip64, 4);
        zipArchiveBound(recordBytes === 44, 'UNSUPPORTED_ZIP64',
            'Extended or encrypted ZIP64 directories are unsupported. Repack with an ordinary directory.');
        zipArchiveBound(directoryEnd + 56 === endOffset - 20, 'INVALID_ZIP', 'ZIP64 end records are inconsistent.');
        zipArchiveBound(zip64.getUint32(16, true) === 0 && zip64.getUint32(20, true) === 0,
            'UNSUPPORTED_SPLIT', 'Multi-volume ZIP64 archives must be combined before reading.');
        const count64 = zipArchiveUint64(zip64, 32);
        const bytes64 = zipArchiveUint64(zip64, 40);
        const offset64 = zipArchiveUint64(zip64, 48);
        zipArchiveBound(zipArchiveUint64(zip64, 24) === count64 && (count === 0xffff || count === count64)
            && (diskCount === 0xffff || diskCount === count64)
            && (directoryBytes === 0xffffffff || directoryBytes === bytes64)
            && (directoryOffset === 0xffffffff || directoryOffset === offset64),
        'INVALID_ZIP', 'ZIP and ZIP64 directory values disagree.');
        count = count64;
        directoryBytes = bytes64;
        directoryOffset = offset64;
    } else {
        zipArchiveBound(!needs64, 'INVALID_ZIP', 'Required ZIP64 end records are missing.');
        zipArchiveBound(diskCount === count, 'UNSUPPORTED_SPLIT', 'ZIP directory entry counts disagree.');
    }
    zipArchiveBound(count <= limits.maxEntries, 'ENTRY_LIMIT', 'Archive contains too many entries.');
    zipArchiveBound(directoryBytes <= limits.maxDirectoryBytes, 'DIRECTORY_LIMIT', 'ZIP directory exceeds the byte limit.');
    zipArchiveBound(directoryOffset <= directoryEnd && directoryBytes === directoryEnd - directoryOffset,
        'INVALID_ZIP', 'ZIP directory bounds are inconsistent. Offset repair is unsupported.');
    zipArchiveBound(count * 46 <= directoryBytes, 'INVALID_ZIP', 'ZIP directory cannot contain its declared records.');
    const directory = await zipArchiveRead(source, directoryOffset, directoryBytes, signal);
    const dv = zipArchiveView(directory);
    const records = [];
    let at = 0;
    let expandedTotal = 0;
    for (let ordinal = 0; ordinal < count; ordinal++) {
        zipArchiveCheck(signal);
        zipArchiveBound(at + 46 <= directory.length && dv.getUint32(at, true) === 0x02014b50,
            'UNSUPPORTED_DIRECTORY', 'Invalid or encrypted ZIP directory. Repack with visible filenames.');
        const nameBytes = dv.getUint16(at + 28, true);
        const extraBytes = dv.getUint16(at + 30, true);
        const commentBytes = dv.getUint16(at + 32, true);
        const next = at + 46 + nameBytes + extraBytes + commentBytes;
        zipArchiveBound(next <= directory.length, 'INVALID_ZIP', 'Truncated ZIP directory record.');
        let expanded = dv.getUint32(at + 24, true);
        let compressed = dv.getUint32(at + 20, true);
        let offset = dv.getUint32(at + 42, true);
        let startDisk = dv.getUint16(at + 34, true);
        const extraEnd = at + 46 + nameBytes + extraBytes;
        let found64 = false;
        for (let extra = at + 46 + nameBytes; extra < extraEnd;) {
            zipArchiveBound(extra + 4 <= extraEnd, 'INVALID_ZIP', 'Truncated ZIP extra field.');
            const type = dv.getUint16(extra, true);
            const size = dv.getUint16(extra + 2, true);
            const fieldEnd = extra + 4 + size;
            zipArchiveBound(fieldEnd <= extraEnd, 'INVALID_ZIP', 'Invalid ZIP extra field length.');
            if (type === 1) {
                zipArchiveBound(!found64, 'INVALID_ZIP', 'Duplicate ZIP64 extra field.');
                found64 = true;
                let valueAt = extra + 4;
                const take64 = () => {
                    zipArchiveBound(valueAt + 8 <= fieldEnd, 'INVALID_ZIP', 'Incomplete ZIP64 entry metadata.');
                    const value = zipArchiveUint64(dv, valueAt);
                    valueAt += 8;
                    return value;
                };
                if (expanded === 0xffffffff) expanded = take64();
                if (compressed === 0xffffffff) compressed = take64();
                if (offset === 0xffffffff) offset = take64();
                if (startDisk === 0xffff) {
                    zipArchiveBound(valueAt + 4 <= fieldEnd, 'INVALID_ZIP', 'Incomplete ZIP64 disk metadata.');
                    startDisk = dv.getUint32(valueAt, true);
                }
            }
            extra = fieldEnd;
        }
        zipArchiveBound(found64 || (expanded !== 0xffffffff && compressed !== 0xffffffff && offset !== 0xffffffff),
            'INVALID_ZIP', 'Required ZIP64 entry metadata is missing.');
        zipArchiveBound(startDisk === 0, 'UNSUPPORTED_SPLIT', 'An entry refers to another ZIP volume.');
        zipArchiveBound(offset <= directoryOffset - 30 && compressed <= directoryOffset - offset - 30,
            'INVALID_ZIP', 'ZIP entry data falls outside the file region.');
        expandedTotal += expanded;
        zipArchiveBound(expandedTotal <= limits.maxTotalExpandedBytes, 'TOTAL_LIMIT', 'Declared expanded archive size exceeds the limit.');
        zipArchiveBound(expanded <= compressed * limits.maxExpansionRatio, 'RATIO_LIMIT', 'ZIP entry expansion ratio exceeds the limit.');
        records.push({ ordinal, offset, expanded, compressed, end: directoryOffset });
        at = next;
        if ((ordinal + 1) % 128 === 0) {
            zipArchiveProgress(onProgress, { phase: 'directory', loaded: at, total: directoryBytes });
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    // An optional central-directory digital signature is bounded with the directory.
    if (at < directory.length) {
        zipArchiveBound(at + 6 <= directory.length && dv.getUint32(at, true) === 0x05054b50
            && at + 6 + dv.getUint16(at + 4, true) === directory.length,
        'INVALID_ZIP', 'Unexpected data in the ZIP directory.');
    }
    const physical = [...records].sort((a, b) => a.offset - b.offset);
    for (let i = 0; i < physical.length; i++) {
        const record = physical[i];
        record.end = i + 1 < physical.length ? physical[i + 1].offset : directoryOffset;
        zipArchiveBound(record.offset + 30 + record.compressed <= record.end,
            'INVALID_ZIP', 'ZIP entries overlap or alias the same local header.');
    }
    zipArchiveProgress(onProgress, { phase: 'directory', loaded: directoryBytes, total: directoryBytes });
    return { records, directoryOffset };
}

function zipArchiveCandidate(entry) {
    if (entry.directory || entry.symlink || entry.executable || typeof entry.filename !== 'string') return null;
    const path = entry.filename.replace(/\\/g, '/');
    if (/^[\/]|^[a-z]:|[\x00-\x1f\x7f:]/i.test(path)) return null;
    const segments = path.split('/');
    if (segments.some(part => !part || part === '.' || part === '..' || part.startsWith('.')
        || /^__macosx$/i.test(part) || /[. ]$/.test(part))) return null;
    const filename = segments[segments.length - 1];
    const dot = filename.lastIndexOf('.');
    const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
    return zipArchiveExtensions.has(extension) ? { path, filename, extension } : null;
}

function zipArchivePool(zip) {
    if (zipArchivePools.has(zip)) return zipArchivePools.get(zip);
    const pool = { zip, queue: [], active: 0, serial: 0, sessions: new Set(), idleTimer: null, termination: null };
    zipArchivePools.set(zip, pool);
    return pool;
}

function zipArchiveTerminate(pool) {
    clearTimeout(pool.idleTimer);
    pool.idleTimer = null;
    if (pool.active || pool.queue.length) return Promise.resolve();
    if (!pool.termination) {
        pool.termination = Promise.resolve().then(() => pool.zip.terminateWorkers()).catch(() => {
            // Cleanup failure must not turn a completed extraction into a rejection.
        }).finally(() => { pool.termination = null; });
    }
    return pool.termination;
}

function zipArchivePump(pool) {
    clearTimeout(pool.idleTimer);
    pool.idleTimer = null;
    pool.queue.sort((a, b) => a.rank - b.rank || a.serial - b.serial);
    while (pool.active < 2 && pool.queue.length) {
        const job = pool.queue.shift();
        if (job.controller.signal.aborted || !job.subscribers.size) {
            job.finish();
            continue;
        }
        pool.active++;
        job.running = true;
        job.task = (async () => {
            try {
                // Publish job.task before observer callbacks can reenter acquire.
                await Promise.resolve();
                // Never start a task while an idle-worker teardown is in flight.
                if (pool.termination) await pool.termination;
                zipArchiveCheck(job.controller.signal);
                await job.run();
            } catch (error) {
                job.fail(error);
            } finally {
                job.finish();
                pool.active--;
                zipArchivePump(pool);
                if (!pool.active && !pool.queue.length) {
                    pool.idleTimer = setTimeout(() => { void zipArchiveTerminate(pool); }, 1000);
                }
            }
        })();
    }
}

// `used` counts retained blobs AND accepted output chunks, including pinned
// records. Admission fails if live leases leave insufficient room; pins never
// become a hidden exception to the cache's byte limit.
function zipArchiveCache(maxBytes) {
    const cache = { records: new Map(), used: 0, maxBytes, retired: false };
    cache.drop = record => {
        if (record.pins || record.dropped) return;
        record.dropped = true;
        cache.records.delete(record.key);
        cache.used -= record.bytes;
        if (record.url) URL.revokeObjectURL(record.url);
        record.url = null;
        record.blob = null;
    };
    cache.reserve = bytes => {
        zipArchiveBound(!cache.retired, 'DISPOSED', 'Archive session is disposed.');
        for (const record of cache.records.values()) {
            if (cache.used + bytes <= cache.maxBytes) break;
            if (!record.pins) cache.drop(record);
        }
        zipArchiveBound(bytes <= cache.maxBytes - cache.used, 'CACHE_LIMIT',
            'Archive cache is full. Release unused page leases before retrying.');
        cache.used += bytes;
    };
    cache.touch = record => {
        if (record.dropped) return;
        cache.records.delete(record.key);
        cache.records.set(record.key, record);
    };
    cache.put = (key, blob, info) => {
        const record = { key, blob, bytes: blob.size, ...info, pins: 0, url: null, dropped: false };
        // The writer (or thumbnail encoder) has already reserved these bytes.
        cache.records.set(key, record);
        return record;
    };
    cache.pin = record => {
        zipArchiveBound(!record.dropped, 'DISPOSED', 'Archive resource is no longer available.');
        record.pins++;
        cache.touch(record);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            record.pins--;
            if (cache.retired) cache.drop(record);
        };
    };
    cache.lease = record => {
        const unpin = cache.pin(record);
        try {
            if (!record.url) record.url = URL.createObjectURL(record.blob);
        } catch (error) {
            unpin();
            throw error;
        }
        let released = false;
        const lease = {
            url: record.url, blob: record.blob, mime: record.mime, bytes: record.bytes,
            format: record.format, animated: record.animated, width: record.width, height: record.height,
            release() {
                if (released) return;
                released = true;
                unpin();
                // A retained, released lease must not retain a second Blob reference.
                lease.blob = null;
                lease.url = null;
            }
        };
        return lease;
    };
    cache.dispose = () => {
        cache.retired = true;
        for (const record of cache.records.values()) cache.drop(record);
    };
    return cache;
}

function zipArchiveAvifDimensions(bytes, start) {
    const view = zipArchiveView(bytes);
    const text = at => String.fromCharCode(...bytes.subarray(at, at + 4));
    const containers = new Set(['meta', 'iprp', 'ipco']);
    const ranges = [{ start, end: bytes.length, depth: 0 }];
    let width = 0;
    let height = 0;
    let boxes = 0;
    while (ranges.length && boxes < 4096) {
        const range = ranges.pop();
        for (let at = range.start; at + 8 <= range.end && boxes++ < 4096;) {
            let size = view.getUint32(at);
            let header = 8;
            const type = text(at + 4);
            if (size === 1) {
                if (at + 16 > range.end) break;
                const high = view.getUint32(at + 8);
                size = high * 0x100000000 + view.getUint32(at + 12);
                if (!Number.isSafeInteger(size)) break;
                header = 16;
            }
            if (size === 0) size = range.end - at;
            if (size < header || size > range.end - at) break;
            if (type === 'ispe' && size >= header + 12 && view.getUint32(at + header) === 0) {
                // Budget the largest declared properties, including grid images.
                width = Math.max(width, view.getUint32(at + header + 4));
                height = Math.max(height, view.getUint32(at + header + 8));
            } else if (containers.has(type) && range.depth < 8) {
                const childStart = at + header + (type === 'meta' ? 4 : 0);
                if (childStart <= at + size) ranges.push({ start: childStart, end: at + size, depth: range.depth + 1 });
            }
            at += size;
        }
    }
    return { width, height };
}

async function zipArchiveImageInfo(blob) {
    const bytes = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    const view = zipArchiveView(bytes);
    const text = (at, count) => String.fromCharCode(...bytes.subarray(at, at + count));
    const info = (format, mime, width = 0, height = 0, animated = false) => ({ format, mime, width, height, animated });
    if (bytes.length >= 24 && bytes[0] === 0x89 && text(1, 7) === 'PNG\r\n\x1a\n'
        && view.getUint32(8) === 13 && text(12, 4) === 'IHDR') {
        let animated = false;
        for (let at = 8; at + 12 <= bytes.length;) {
            const type = text(at + 4, 4);
            if (type === 'acTL') { animated = true; break; }
            if (type === 'IDAT' || type === 'IEND') break;
            at += 12 + view.getUint32(at);
        }
        return info('png', 'image/png', view.getUint32(16), view.getUint32(20), animated);
    }
    if (bytes.length >= 13 && (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a')) {
        return info('gif', 'image/gif', view.getUint16(6, true), view.getUint16(8, true), true);
    }
    if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
        for (let at = 2; at + 4 <= bytes.length;) {
            if (bytes[at] !== 255) break;
            const marker = bytes[at + 1];
            if (marker === 255) { at++; continue; }
            if (marker === 0xd9 || marker === 0xda) break;
            if (marker === 1 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
            const size = view.getUint16(at + 2);
            if (size < 2 || at + 2 + size > bytes.length) break;
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && size >= 7) {
                return info('jpg', 'image/jpeg', view.getUint16(at + 7), view.getUint16(at + 5));
            }
            at += 2 + size;
        }
        return info('jpg', 'image/jpeg');
    }
    if (bytes.length >= 21 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP'
        && view.getUint32(4, true) + 8 === blob.size) {
        const chunk = text(12, 4);
        if (bytes.length >= 30 && chunk === 'VP8X' && view.getUint32(16, true) === 10) {
            const u24 = at => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
            return info('webp', 'image/webp', u24(24) + 1, u24(27) + 1, !!(bytes[20] & 2));
        }
        if (bytes.length >= 30 && chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
            return info('webp', 'image/webp', view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
        }
        if (bytes.length >= 25 && chunk === 'VP8L' && bytes[20] === 0x2f) {
            const bits = view.getUint32(21, true);
            return info('webp', 'image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        }
    }
    if (bytes.length >= 26 && text(0, 2) === 'BM' && view.getUint32(10, true) < blob.size) {
        const header = view.getUint32(14, true);
        if (header === 12) return info('bmp', 'image/bmp', view.getUint16(18, true), view.getUint16(20, true));
        if (header >= 40 && bytes.length >= 54) return info('bmp', 'image/bmp', view.getInt32(18, true), Math.abs(view.getInt32(22, true)));
    }
    if (bytes.length >= 16 && text(4, 4) === 'ftyp') {
        const boxSize = view.getUint32(0);
        if (boxSize >= 16 && boxSize <= bytes.length && boxSize % 4 === 0) {
            let supported = false;
            let animated = false;
            for (let at = 8; at + 4 <= boxSize; at += at === 8 ? 8 : 4) {
                const brand = text(at, 4);
                supported ||= brand === 'avif' || brand === 'avis';
                animated ||= brand === 'avis';
            }
            if (supported) {
                // Inspect bounded ISO boxes, not strings in compressed data.
                const dimensions = zipArchiveAvifDimensions(bytes, boxSize);
                return info('avif', 'image/avif', dimensions.width, dimensions.height, animated);
            }
        }
    }
    throw new ArchiveError('UNSUPPORTED_IMAGE', 'Entry does not contain a supported raster image.');
}

async function zipArchiveThumbnail(record, state, signal) {
    zipArchiveCheck(signal);
    zipArchiveBound(typeof globalThis.createImageBitmap === 'function', 'THUMBNAIL_UNAVAILABLE',
        'Still thumbnails require createImageBitmap. Omit this thumbnail in the viewer.');
    const { width, height } = record;
    const decodedBytes = width * height * 4;
    const scale = Math.min(1, state.limits.thumbnailSize / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const reservation = decodedBytes + w * h * 8; // Decoder, resized bitmap, canvas.
    zipArchiveBound(width > 0 && height > 0 && Number.isSafeInteger(reservation)
        && reservation <= state.limits.maxDecodedBytes - state.decodedBytes,
    'DECODE_LIMIT', 'Thumbnail dimensions are unknown or exceed the decoded-image budget.');
    state.decodedBytes += reservation;
    let bitmap;
    let canvas;
    try {
        bitmap = await globalThis.createImageBitmap(record.blob, {
            resizeWidth: w, resizeHeight: h, resizeQuality: 'low'
        });
        zipArchiveCheck(signal);
        if (typeof globalThis.OffscreenCanvas === 'function') {
            canvas = new globalThis.OffscreenCanvas(w, h);
        } else if (globalThis.document && typeof globalThis.document.createElement === 'function') {
            canvas = globalThis.document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
        }
        zipArchiveBound(!!canvas, 'THUMBNAIL_UNAVAILABLE', 'Still thumbnail canvas is unavailable.');
        const context = canvas.getContext('2d');
        zipArchiveBound(!!context, 'THUMBNAIL_UNAVAILABLE', 'Still thumbnail drawing context is unavailable.');
        context.drawImage(bitmap, 0, 0, w, h);
        const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' })
            : await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value)
                : reject(new ArchiveError('THUMBNAIL_UNAVAILABLE', 'Could not encode a still thumbnail.')), 'image/png'));
        zipArchiveCheck(signal);
        return blob;
    } finally {
        if (bitmap) bitmap.close();
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        state.decodedBytes -= reservation;
    }
}

function zipArchiveWait(promise, signal) {
    zipArchiveCheck(signal);
    return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(zipArchiveAbort(signal)); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}

function zipArchiveZipError(zip, error) {
    if (error instanceof ArchiveError || (error && error.name === 'AbortError')) return error;
    const is = name => typeof zip[name] === 'string' && error && error.message === zip[name];
    if (is('ERR_ENCRYPTED')) return new ArchiveError('PASSWORD_REQUIRED', 'A password is required for this entry.');
    if (is('ERR_INVALID_PASSWORD')) return new ArchiveError('WRONG_PASSWORD', 'Incorrect archive password. Retry with another password.');
    if (is('ERR_UNSUPPORTED_ENCRYPTION')) return new ArchiveError('UNSUPPORTED_ENCRYPTION', 'This encryption method needs a desktop archive reader.');
    if (is('ERR_UNSUPPORTED_COMPRESSION')) return new ArchiveError('UNSUPPORTED_COMPRESSION', 'This compression method needs a desktop archive reader.');
    if (is('ERR_ENCRYPTED_CENTRAL_DIRECTORY')) return new ArchiveError('UNSUPPORTED_DIRECTORY', 'Encrypted filenames are unsupported. Repack with a visible directory.');
    if (is('ERR_WORKER_STARTUP_TIMEOUT') || (error && /worker|content.security|csp/i.test(error.message))) {
        return new ArchiveError('WORKER_UNAVAILABLE', 'Archive worker could not start. Check the configured worker assets and content security policy.');
    }
    if (is('ERR_INVALID_CRC32') || is('ERR_INVALID_AUTHENTICATION_CODE')) {
        return new ArchiveError('INTEGRITY_FAILED', 'Archive entry failed its integrity check. Download or obtain another copy.');
    }
    return new ArchiveError('ZIP_FAILED', 'Could not read this ZIP entry. Retry or use a desktop archive reader.', { cause: error });
}

/**
 * Open an independently configured zip.js 2.23.0 namespace and owned source.
 * No network, library configuration or image extraction occurs at import time.
 */
export async function openZipArchive({ zip, source, signal, limits, onProgress, password, requestPassword } = {}) {
    zipArchiveBound(source && Number.isSafeInteger(source.size) && source.size >= 0
        && typeof source.read === 'function' && typeof source.close === 'function',
    'INVALID_SOURCE', 'Expected a sized random-access source with read and close methods.');
    const controller = new AbortController();
    const state = {
        limits: null, decodedBytes: 0, disposed: false, ready: false, closing: null,
        reader: null, pool: null, jobs: new Map(), allJobs: new Set(), lookup: new Map(), reads: new Map(),
        pages: null, thumbs: null, password, prompt: null
    };
    const abort = () => {
        controller.abort(signal.reason);
        if (state.ready) void dispose();
    };
    if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', abort, { once: true });
    }

    function dispose() {
        if (state.closing) return state.closing;
        let resolveClose;
        let rejectClose;
        // Abort handlers and source.close may synchronously call dispose again.
        state.closing = new Promise((resolve, reject) => {
            resolveClose = resolve;
            rejectClose = reject;
        });
        state.disposed = true;
        controller.abort();
        if (signal) signal.removeEventListener('abort', abort);
        state.password = undefined;
        if (state.prompt) state.prompt.controller.abort();
        const jobs = [...state.allJobs];
        for (const job of jobs) {
            job.controller.abort();
            job.fail(zipArchiveAbort());
            if (!job.running) job.finish();
        }
        if (state.pages) state.pages.dispose();
        if (state.thumbs) state.thumbs.dispose();
        let sourceClose;
        try { sourceClose = Promise.resolve(source.close()); }
        catch (error) { sourceClose = Promise.reject(error); }
        (async () => {
            await Promise.allSettled([sourceClose, ...jobs.map(job => job.task)]);
            if (state.reader) await Promise.resolve(state.reader.close()).catch(() => {});
            state.lookup.clear();
            state.reads.clear();
            if (state.pool) {
                state.pool.sessions.delete(state);
                if (!state.pool.active && !state.pool.queue.length) await zipArchiveTerminate(state.pool);
            }
        })().then(resolveClose, rejectClose);
        return state.closing;
    }

    async function askPassword(job, attempt, wrong) {
        zipArchiveCheck(job.controller.signal);
        if (typeof requestPassword !== 'function') {
            throw new ArchiveError(wrong ? 'WRONG_PASSWORD' : 'PASSWORD_REQUIRED',
                wrong ? 'Incorrect password. Supply requestPassword to retry within the session.'
                    : 'This entry requires a password. Supply password or requestPassword.');
        }
        if (!state.prompt) {
            const prompt = { controller: new AbortController(), waiters: new Set(), promise: null };
            state.prompt = prompt;
            prompt.promise = Promise.resolve().then(() => requestPassword({
                incorrect: !!wrong, filename: job.item.publicEntry.filename, attempt,
                signal: prompt.controller.signal
            })).then(value => {
                zipArchiveCheck(prompt.controller.signal);
                zipArchiveCheck(controller.signal);
                if (typeof value !== 'string' || !value.length) {
                    throw new ArchiveError('PASSWORD_CANCELLED', 'Password entry cancelled. This archive session can be retried.');
                }
                state.password = value;
                return value;
            }, () => {
                throw new ArchiveError('PASSWORD_CANCELLED', 'Password entry cancelled. This archive session can be retried.');
            }).finally(() => {
                if (state.prompt === prompt) state.prompt = null;
            });
        }
        const prompt = state.prompt;
        prompt.waiters.add(job);
        try {
            return await zipArchiveWait(prompt.promise, job.controller.signal);
        } finally {
            prompt.waiters.delete(job);
            if (!prompt.waiters.size && state.prompt === prompt) {
                prompt.controller.abort();
                state.prompt = null;
            }
        }
    }

    function leaseResource(cache, record, purpose) {
        // Reserve before assigning an image URL, not after the decoder has
        // already allocated an oversized raster. Stage and thumbnail decoding
        // share one session budget; downloads and preloads retain only bytes.
        const decoded = purpose === 'stage' ? record.width * record.height * 4 : 0;
        if (purpose === 'stage') {
            zipArchiveBound(record.width > 0 && record.height > 0 && Number.isSafeInteger(decoded)
                && decoded <= state.limits.maxDecodedBytes - state.decodedBytes,
            'DECODE_LIMIT', 'Page dimensions are unknown or exceed the decoded-image budget. Download the original page instead.');
            state.decodedBytes += decoded;
        }
        let lease;
        try { lease = cache.lease(record); }
        catch (error) { state.decodedBytes -= decoded; throw error; }
        if (decoded) {
            const release = lease.release;
            let released = false;
            lease.release = () => {
                if (released) return;
                released = true;
                release();
                state.decodedBytes -= decoded;
            };
        }
        return lease;
    }

    async function extract(job) {
        const { item } = job;
        const jobSignal = job.controller.signal;
        let attempts = 0;
        let wrong = false;
        while (true) {
            zipArchiveCheck(jobSignal);
            let secret = item.entry.encrypted ? state.password : undefined;
            if (item.entry.encrypted && !secret) secret = await askPassword(job, ++attempts, wrong);
            let reserved = 0;
            let loaded = 0;
            let chunks = [];
            let capError;
            class CappedWriter extends zip.Writer {
                writeUint8Array(chunk) {
                    zipArchiveCheck(jobSignal);
                    const next = loaded + chunk.byteLength;
                    if (next > state.limits.maxImageBytes || next > item.record.expanded
                        || next > item.record.compressed * state.limits.maxExpansionRatio) {
                        capError = new ArchiveError('IMAGE_LIMIT', 'Expanded image exceeds its declared size or output limit.');
                        job.controller.abort(capError);
                        throw capError;
                    }
                    try {
                        state.pages.reserve(chunk.byteLength);
                    } catch (error) {
                        capError = error;
                        job.controller.abort(error);
                        throw error;
                    }
                    reserved += chunk.byteLength;
                    chunks.push(chunk.slice());
                    loaded = next;
                    job.progress({ phase: 'extract', loaded, total: item.record.expanded });
                }
                getData() {
                    zipArchiveCheck(jobSignal);
                    zipArchiveBound(loaded === item.record.expanded, 'INVALID_ZIP', 'Expanded entry length disagrees with its directory.');
                    const blob = new Blob(chunks);
                    chunks = [];
                    return blob;
                }
            }
            try {
                // Bind header reads as well as compressed-stream pulls to this job.
                state.reads.set(job, item.record);
                const header = zipArchiveView(await zipArchiveRead(source, item.record.offset, 30, jobSignal));
                const dataStart = item.record.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
                zipArchiveBound(header.getUint32(0, true) === 0x04034b50
                    && dataStart <= item.record.end && item.record.compressed <= item.record.end - dataStart,
                'INVALID_ZIP', 'ZIP local header or compressed data overlaps another entry.');
                job.progress({ phase: 'extract', loaded: 0, total: item.record.expanded });
                const blob = await item.entry.getData(new CappedWriter(), {
                    signal: jobSignal, password: secret, useWebWorkers: true, useCompressionStream: true,
                    checkSignature: true, checkCrc32: true, checkAuthenticationCode: true,
                    checkOverlappingEntry: false, checkLocalDirectory: true, checkLocalFilename: true
                });
                zipArchiveCheck(jobSignal);
                const info = await zipArchiveImageInfo(blob);
                zipArchiveCheck(jobSignal);
                const typed = blob.slice(0, blob.size, info.mime);
                const record = state.pages.put(item.publicEntry.id, typed, info);
                const unpin = state.pages.pin(record);
                reserved = 0; // Ownership transfers from the writer to the cache.
                return { record, unpin };
            } catch (error) {
                const mapped = capError || zipArchiveZipError(zip, error);
                if (item.entry.encrypted && mapped.code === 'WRONG_PASSWORD') {
                    if (state.password === secret) state.password = undefined;
                    // Discard failed output before awaiting another dialog.
                    chunks = [];
                    state.pages.used -= reserved;
                    reserved = 0;
                    state.reads.delete(job);
                    secret = undefined;
                    wrong = true;
                    if (attempts >= 3) throw mapped;
                    if (!state.password) await askPassword(job, ++attempts, true);
                } else {
                    throw mapped;
                }
            } finally {
                state.reads.delete(job);
                chunks = [];
                state.pages.used -= reserved;
                secret = undefined;
            }
        }
    }

    function makeJob(item) {
        const pool = state.pool;
        const previous = state.jobs.get(item.publicEntry.id);
        const job = {
            item, controller: new AbortController(), subscribers: new Set(),
            rank: 2, serial: pool.serial++, running: false, task: null, lastProgress: null,
            progress(progress) {
                job.lastProgress = progress;
                for (const subscriber of job.subscribers) zipArchiveProgress(subscriber.onProgress, progress);
            },
            settle(subscriber, error, record, cache) {
                if (!job.subscribers.delete(subscriber)) return;
                if (subscriber.signal) subscriber.signal.removeEventListener('abort', subscriber.abort);
                if (error) subscriber.reject(error);
                else {
                    try { subscriber.resolve(leaseResource(cache, record, subscriber.purpose)); }
                    catch (failure) { subscriber.reject(failure); }
                }
            },
            fail(error) {
                for (const subscriber of [...job.subscribers]) job.settle(subscriber, error);
            },
            finish() {
                if (state.jobs.get(item.publicEntry.id) === job) state.jobs.delete(item.publicEntry.id);
                state.allJobs.delete(job);
                const queued = pool.queue.indexOf(job);
                if (queued >= 0) pool.queue.splice(queued, 1);
            },
            async run() {
                if (previous && previous.task) await previous.task;
                zipArchiveCheck(job.controller.signal);
                let record = state.pages.records.get(item.publicEntry.id);
                let unpin;
                if (record) unpin = state.pages.pin(record);
                else ({ record, unpin } = await extract(job));
                try {
                    zipArchiveCheck(job.controller.signal);
                    for (const subscriber of [...job.subscribers]) {
                        if (subscriber.purpose !== 'thumb') job.settle(subscriber, null, record, state.pages);
                    }
                    if (!job.subscribers.size) return;
                    job.progress({ phase: 'thumbnail', loaded: 0 });
                    const blob = await zipArchiveThumbnail(record, state, job.controller.signal);
                    zipArchiveCheck(job.controller.signal);
                    state.thumbs.reserve(blob.size);
                    const thumb = state.thumbs.put(item.publicEntry.id, blob, {
                        mime: 'image/png', format: record.format, animated: false
                    });
                    for (const subscriber of [...job.subscribers]) job.settle(subscriber, null, thumb, state.thumbs);
                } finally {
                    unpin();
                }
            }
        };
        state.jobs.set(item.publicEntry.id, job);
        state.allJobs.add(job);
        pool.queue.push(job);
        return job;
    }

    function acquirePage(entryId, options = {}) {
        try {
            zipArchiveBound(!state.disposed, 'DISPOSED', 'Archive session is disposed.');
            zipArchiveCheck(controller.signal);
            zipArchiveCheck(options.signal);
            const item = state.lookup.get(entryId);
            zipArchiveBound(!!item, 'ENTRY_NOT_FOUND', 'Archive entry ID was not found in this session.');
            const purpose = options.purpose === undefined ? 'stage' : options.purpose;
            zipArchiveBound(zipArchivePurposes.has(purpose) && (options.priority === undefined || zipArchivePriority.has(options.priority)),
                'INVALID_OPTIONS', 'Unknown archive resource purpose or priority.');
            const rank = options.priority === undefined ? zipArchivePurposes.get(purpose) : zipArchivePriority.get(options.priority);
            const cache = purpose === 'thumb' ? state.thumbs : state.pages;
            const cached = cache.records.get(entryId);
            if (cached) {
                const lease = leaseResource(cache, cached, purpose);
                zipArchiveProgress(options.onProgress, { phase: 'cache', loaded: cached.bytes, total: cached.bytes });
                if ((options.signal && options.signal.aborted) || controller.signal.aborted) {
                    lease.release();
                    throw zipArchiveAbort(options.signal || controller.signal);
                }
                return Promise.resolve(lease);
            }
            let job = state.jobs.get(entryId);
            if (!job || job.controller.signal.aborted) job = makeJob(item);
            const promise = new Promise((resolve, reject) => {
                const subscriber = { purpose, rank, signal: options.signal, onProgress: options.onProgress, resolve, reject, abort: null };
                subscriber.abort = () => {
                    job.settle(subscriber, zipArchiveAbort(options.signal));
                    if (!job.subscribers.size) {
                        job.controller.abort();
                        if (!job.running) job.finish();
                    } else {
                        job.rank = Math.min(...[...job.subscribers].map(value => value.rank));
                    }
                    zipArchivePump(state.pool);
                };
                job.subscribers.add(subscriber);
                job.rank = Math.min(...[...job.subscribers].map(value => value.rank));
                if (options.signal) options.signal.addEventListener('abort', subscriber.abort, { once: true });
                if (job.lastProgress) zipArchiveProgress(options.onProgress, job.lastProgress);
                if (options.signal && options.signal.aborted) subscriber.abort();
            });
            zipArchivePump(state.pool);
            return promise;
        } catch (error) {
            return Promise.reject(error);
        }
    }

    try {
        zipArchiveCheck(controller.signal);
        zipArchiveBound(zip && typeof zip.ZipReader === 'function' && typeof zip.Reader === 'function'
            && typeof zip.Writer === 'function' && typeof zip.terminateWorkers === 'function',
        'ZIP_UNAVAILABLE', 'Inject the configured zip.js 2.23.0 reader, writer and worker APIs.');
        zipArchiveBound(password === undefined || typeof password === 'string', 'INVALID_OPTIONS', 'Archive password must be a string.');
        password = undefined; // Only the erasable session field retains it.
        zipArchiveBound(requestPassword === undefined || typeof requestPassword === 'function', 'INVALID_OPTIONS', 'requestPassword must be a function.');
        state.limits = zipArchiveLimits(limits);
        state.pages = zipArchiveCache(state.limits.maxPageCacheBytes);
        state.thumbs = zipArchiveCache(state.limits.maxThumbCacheBytes);
        const preflight = await zipArchivePreflight(source, state.limits, controller.signal, onProgress);
        let indexing = true;
        let indexBytes = 0;
        class BoundedReader extends zip.Reader {
            constructor() {
                super();
                this.size = source.size;
            }
            readUint8Array(offset, length) {
                if (indexing) {
                    indexBytes += length;
                    zipArchiveBound(length <= Math.max(state.limits.maxDirectoryBytes, 65557)
                        && indexBytes <= 4 * state.limits.maxDirectoryBytes + 4 * 65557,
                    'DIRECTORY_LIMIT', 'ZIP parser exceeded its bounded directory read budget.');
                    return zipArchiveRead(source, offset, length, controller.signal);
                }
                for (const [job, record] of state.reads) {
                    if (offset >= record.offset && length <= record.end - offset && offset <= record.end) {
                        zipArchiveBound(length <= 1024 * 1024, 'SOURCE_READ', 'Configure archive input chunks at 1 MiB or less.');
                        return zipArchiveRead(source, offset, length, job.controller.signal);
                    }
                }
                throw new ArchiveError('INVALID_ZIP', 'ZIP extraction attempted to read outside its active entry.');
            }
            createReadable({ offset = 0, size } = {}) {
                zipArchiveBound(Number.isSafeInteger(size) && size >= 0, 'INVALID_ZIP', 'ZIP compressed stream has no bounded length.');
                const match = [...state.reads].find(([, record]) => offset >= record.offset && offset <= record.end && size <= record.end - offset);
                zipArchiveBound(!!match, 'INVALID_ZIP', 'ZIP compressed stream crosses an entry boundary.');
                const readSignal = match[0].controller.signal;
                let loaded = 0;
                return new ReadableStream({
                    async pull(stream) {
                        try {
                            zipArchiveCheck(readSignal);
                            if (loaded === size) { stream.close(); return; }
                            const length = Math.min(256 * 1024, size - loaded);
                            const bytes = await zipArchiveRead(source, offset + loaded, length, readSignal);
                            loaded += length;
                            stream.enqueue(bytes);
                        } catch (error) { stream.error(error); }
                    }
                }, { highWaterMark: 0 });
            }
        }
        state.reader = new zip.ZipReader(new BoundedReader(), {
            strictness: 'balanced', filenameValidation: 'tolerant', maxAppendedDataSize: 0,
            extractPrependedData: false, extractAppendedData: false
        });
        zipArchiveBound(typeof state.reader.getEntriesGenerator === 'function', 'ZIP_UNAVAILABLE', 'zip.js must provide getEntriesGenerator.');
        const entries = [];
        let ordinal = 0;
        for await (const entry of state.reader.getEntriesGenerator({ signal: controller.signal })) {
            zipArchiveCheck(controller.signal);
            zipArchiveBound(ordinal < preflight.records.length && ordinal < state.limits.maxEntries,
                'ENTRY_LIMIT', 'ZIP parser exceeded the preflight entry count.');
            const record = preflight.records[ordinal++];
            if (ordinal % 128 === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
                zipArchiveCheck(controller.signal);
            }
            zipArchiveBound(entry.offset === record.offset && entry.compressedSize === record.compressed
                && entry.uncompressedSize === record.expanded,
            'INVALID_ZIP', 'ZIP parser metadata disagrees with the validated directory.');
            const candidate = zipArchiveCandidate(entry);
            if (!candidate) continue;
            zipArchiveBound(record.expanded <= state.limits.maxImageBytes, 'IMAGE_LIMIT', 'An image exceeds the expanded page limit.');
            const publicEntry = Object.freeze({
                id: 'zip-entry-' + record.ordinal, ...candidate,
                compressedBytes: record.compressed, expandedBytes: record.expanded,
                encrypted: !!entry.encrypted
            });
            state.lookup.set(publicEntry.id, { publicEntry, entry, record });
            entries.push(publicEntry);
        }
        zipArchiveBound(ordinal === preflight.records.length, 'INVALID_ZIP', 'ZIP parser returned an incomplete directory.');
        indexing = false;
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        entries.sort((a, b) => collator.compare(a.path, b.path)
            || state.lookup.get(a.id).record.ordinal - state.lookup.get(b.id).record.ordinal);
        zipArchiveCheck(controller.signal);
        state.pool = zipArchivePool(zip);
        state.pool.sessions.add(state);
        state.ready = true;
        return Object.freeze({ entries: Object.freeze(entries), acquirePage, dispose });
    } catch (error) {
        await dispose();
        throw zipArchiveZipError(zip || {}, error);
    }
}
