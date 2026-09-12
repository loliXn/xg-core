// Content signatures outrank filenames and server MIME labels.
export async function inspectImageFormat(blob) {
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
