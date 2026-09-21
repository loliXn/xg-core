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
