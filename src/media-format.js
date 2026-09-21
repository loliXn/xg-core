// Content signatures outrank filenames and server MIME labels.
export async function inspectImageFormat(blob) {
    const bytes = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    const text = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = (format, animated = false, size = null) => ({ format, animated,
        mime: 'image/' + (format === 'jpg' ? 'jpeg' : format),
        width: size ? size.width : 0, height: size ? size.height : 0 });

    // Every one of these formats declares its size within the first bytes, so
    // the answer is already in hand: the caller reads at most 64 KB to
    // classify the file and can now learn how big the picture is without
    // fetching, let alone decoding, the rest of it.
    const safe = (fn) => { try { return fn(); } catch (e) { return null; } };
    const gifSize = () => ({ width: view.getUint16(6, true), height: view.getUint16(8, true) });
    const pngSize = () => ({ width: view.getUint32(16), height: view.getUint32(20) });
    const jpegSize = () => {
        // Walk the segment chain to the frame header, which carries the size.
        for (let at = 2; at + 9 < bytes.length;) {
            if (bytes[at] !== 0xFF) { at += 1; continue; }
            const marker = bytes[at + 1];
            if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { at += 2; continue; }
            const length = view.getUint16(at + 2);
            const isFrame = marker >= 0xC0 && marker <= 0xCF
                && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
            if (isFrame) return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
            if (marker === 0xDA) break;
            at += 2 + length;
        }
        return null;
    };
    const webpSize = () => {
        const chunk = text(12, 4);
        if (chunk === 'VP8X') return { width: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1, height: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1 };
        if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3FFF, height: view.getUint16(28, true) & 0x3FFF };
        if (chunk === 'VP8L') {
            const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
            return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
        }
        return null;
    };
    if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return result('gif', true, safe(gifSize));
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return result('jpg', false, safe(jpegSize));
    if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
        return result('webp', text(12, 4) === 'VP8X' && !!(bytes[20] & 2), safe(webpSize));
    }
    if (bytes[0] === 137 && text(1, 3) === 'PNG') {
        const view = new DataView(bytes.buffer);
        for (let at = 8; at + 8 <= bytes.length;) {
            const type = text(at + 4, 4);
            if (type === 'acTL') return result('png', true, safe(pngSize));
            if (type === 'IDAT' || type === 'IEND') break;
            at += 12 + view.getUint32(at);
        }
        return result('png', false, safe(pngSize));
    }
    return null;
}

// A still of the first frame, cut out of the bytes already in hand.
//
// Freezing an animated thumbnail used to mean downloading the whole file: a
// few megabytes per cell, and a page of them took minutes to fill while the
// original had been on screen for ages. But the first frame sits at the front
// of both formats, well inside the 64 KB the sniff reads to classify the file,
// so the frame can be cut out of that and the rest never asked for.
//
// Returns bytes that are a valid one-frame file of the same format, or null
// when the first frame runs past what was read - then the caller falls back to
// fetching the whole thing.
export function firstFrameStill(bytes) {
    if (!bytes || bytes.length < 16) return null;
    const text = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
    if (text(0, 3) === 'GIF') return gifFirstFrame(bytes);
    if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return webpFirstFrame(bytes);
    return null;
}

function gifFirstFrame(bytes) {
    const packed = bytes[10];
    let at = 13;
    if (packed & 0x80) at += 3 * (1 << ((packed & 7) + 1));
    // Extensions (graphic control, loop, comments) then the first image.
    const skipSubBlocks = (from) => {
        let cursor = from;
        while (cursor < bytes.length) {
            const size = bytes[cursor];
            if (size === 0) return cursor + 1;
            cursor += size + 1;
        }
        return -1;
    };
    while (at < bytes.length) {
        const marker = bytes[at];
        if (marker === 0x21) {
            const next = skipSubBlocks(at + 2);
            if (next < 0) return null;
            at = next;
            continue;
        }
        if (marker === 0x2C) {
            const local = bytes[at + 9];
            let cursor = at + 10;
            if (local & 0x80) cursor += 3 * (1 << ((local & 7) + 1));
            cursor += 1; // LZW minimum code size
            const end = skipSubBlocks(cursor);
            if (end < 0 || end > bytes.length) return null;
            const still = new Uint8Array(end + 1);
            still.set(bytes.subarray(0, end));
            still[end] = 0x3B; // trailer, in place of every frame after this one
            return still;
        }
        return null;
    }
    return null;
}

function webpFirstFrame(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
    let at = 12;
    let frame = null;
    while (at + 8 <= bytes.length && !frame) {
        const type = text(at, 4);
        const size = view.getUint32(at + 4, true);
        const body = at + 8;
        if (body + size > bytes.length) break;
        if (type === 'ANMF') {
            // The frame's own image data starts after its 16-byte header, as
            // an ordinary VP8 or VP8L chunk - which is a whole WebP on its own.
            let inner = body + 16;
            while (inner + 8 <= body + size) {
                const innerType = text(inner, 4);
                const innerSize = view.getUint32(inner + 4, true);
                if (innerType === 'VP8 ' || innerType === 'VP8L') {
                    frame = bytes.subarray(inner, inner + 8 + innerSize + (innerSize & 1));
                    break;
                }
                inner += 8 + innerSize + (innerSize & 1);
            }
            break;
        }
        at = body + size + (size & 1);
    }
    if (!frame) return null;
    const still = new Uint8Array(12 + frame.length);
    still.set([0x52, 0x49, 0x46, 0x46]); // RIFF
    new DataView(still.buffer).setUint32(4, 4 + frame.length, true);
    still.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    still.set(frame, 12);
    return still;
}
