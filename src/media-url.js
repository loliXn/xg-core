// URL and media-type helpers that every adapter needs and none should own.
//
// These grew up inside the XGallery userscript and were copied, in spirit if
// not in text, by whatever came after it. They take a string and answer a
// question about it - is this a picture, is this a placeholder, what host is
// this, what does this proxy really point at - and touch nothing else, so
// they belong in the core where a second adapter gets the same answers.

// An inlined image shorter than this is a lazy-load shim (a 1px GIF, a blur,
// an SVG spacer), not a picture. Real inlined pictures run to kilobytes.
export const PLACEHOLDER_DATA_URI_MAX = 512;

export function ensureHttpsUrl(u) {
    if (!u) return u;
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('http://')) return u.replace(/^http:/, 'https:');
    return u;
}

export function absoluteUrl(base, relative) {
    try { return new URL(relative, base).href; }
    catch (e) { return relative; }
}

export function hostOfUrl(url, fallback, base) {
    try { return new URL(url, base || (typeof location !== 'undefined' ? location.href : undefined)).hostname.replace(/^www\./i, ''); }
    catch (e) { return fallback || ''; }
}

export function isPlaceholderUrl(urlStr) {
    if (!urlStr) return true;
    if (urlStr.startsWith('data:image/')) return urlStr.length <= PLACEHOLDER_DATA_URI_MAX;
    if (/clear\.gif|placeholder|transparent\.gif|blank\.gif/i.test(urlStr)) return true;
    return false;
}

// The extension of a media URL, or of an inlined image's type. Query and
// fragment are dropped first, so `a.jpg?x=1` is still jpg.
export function mediaThumbExtension(url) {
    const value = String(url || '');
    // An inlined image has no extension and splitting it allocates the whole
    // string twice; the type is in its first few characters.
    if (value.startsWith('data:')) {
        const type = /^data:image\/([a-z0-9.+-]+)/i.exec(value);
        return type ? type[1].toLowerCase().replace('jpeg', 'jpg') : '';
    }
    const clean = value.split('?')[0].split('#')[0];
    const dot = clean.lastIndexOf('.');
    return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

export function isVideoExt(ext) {
    return /^(mp4|m4v|mov|webm|ogg|ts)$/i.test(ext || '');
}

export function isVideoThumbSource(url) {
    return ['mp4', 'webm', 'ogg', 'm4v', 'mov', 'ts'].includes(mediaThumbExtension(url));
}

export function isImageThumbSource(url) {
    return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(mediaThumbExtension(url));
}

// The extension a file most likely has, from its name first and its
// thumbnail's name second; jpg when nothing says otherwise.
export function inferMediaExt(filename, thumbSrc) {
    const safeFilename = (filename || '').trim();
    const safeThumb = thumbSrc || '';
    let ext = '';
    const extMatch = safeFilename.match(/\.([0-9a-z]{2,5})(?:\s|\.\.\.)*$/i);
    if (extMatch) ext = extMatch[1].toLowerCase();
    if (!ext) {
        const thumbExtMatch = safeThumb.match(/\.([a-z0-9]{2,5})\.(png|jpg|jpeg|webp)(?:$|\?)/i);
        if (thumbExtMatch) ext = thumbExtMatch[1].toLowerCase();
    }
    if (!ext) {
        const simpleExtMatch = safeThumb.match(/\.([a-z0-9]{2,5})(?:$|\?)/i);
        if (simpleExtMatch) ext = simpleExtMatch[1].toLowerCase();
    }
    return ext || 'jpg';
}

// A page that is a browser check rather than the page asked for.
export function htmlLooksLikeCloudflare(html, status) {
    if (status === 403 || status === 503 || status === 429) return true;
    const text = String(html || '');
    return /just a moment|cf-browser-verification|challenge-platform|cdn-cgi\/challenge|attention required|enable javascript and cookies/i.test(text);
}

// What a link through an anonymiser or a ?url= redirector actually points
// at, unwrapped up to three layers deep.
export function unwrapProxiedUrl(urlStr, base) {
    if (!urlStr) return '';
    let current = String(urlStr).trim();
    const from = base || (typeof location !== 'undefined' ? location.href : undefined);
    for (let i = 0; i < 3; i++) {
        let next = current;
        try {
            const parsed = new URL(current, from);
            const host = parsed.hostname.toLowerCase();
            if (host === 'anonym.es' || host.endsWith('.anonym.es')) {
                const rawQuery = (parsed.search || '').replace(/^\?/, '');
                if (rawQuery) {
                    let candidate = rawQuery;
                    try { candidate = decodeURIComponent(rawQuery); } catch (e) { }
                    if (/^https?:\/\//i.test(candidate)) next = candidate;
                }
            }
            const nested = parsed.searchParams.get('url') || parsed.searchParams.get('link') || parsed.searchParams.get('target');
            if (nested && /^https?:\/\//i.test(nested)) next = nested;
        } catch (e) { }
        if (next === current) break;
        current = next;
    }
    return current;
}
