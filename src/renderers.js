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

export function createPlaceholderIcon(doc, isVideo) {
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
}

function appendTypeBadge(options) {
    const doc = options.document;
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

export function renderThumbnailCell(options) {
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

    if (options.indexLabel !== undefined) {
        const index = doc.createElement('div');
        index.className = 'ms-grid-idx';
        index.textContent = String(options.indexLabel);
        host.appendChild(index);
    }
    return host;
}

export function ensureMediaBox(doc, wrap) {
    if (!wrap) return null;
    let box = wrap.querySelector(':scope > .ms-media-box');
    if (!box) {
        box = doc.createElement('div');
        box.className = 'ms-media-box';
        wrap.insertBefore(box, wrap.firstChild);
    }
    return box;
}

export function prepareMediaSlot(options) {
    const wrap = options.wrap;
    const item = options.item;
    if (!wrap) return false;
    const keepVideo = item && item.type === 'video' ? wrap.querySelector('video.ms-media') : null;
    wrap.querySelectorAll('video, audio').forEach((element) => {
        if (element === keepVideo) return;
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

export function renderErrorBanner(options) {
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

export function renderErrorStage(options) {
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

export function createLoadingPreview(options) {
    const doc = options.document || document;
    const image = doc.createElement('img');
    image.className = 'ms-media ms-loading-thumb';
    image.referrerPolicy = 'no-referrer';
    image.src = options.src;
    if (typeof options.onLoad === 'function') image.addEventListener('load', () => options.onLoad(image));
    return image;
}

export function createImageMedia(options) {
    const doc = options.document || document;
    const image = doc.createElement('img');
    image.className = options.className || 'ms-media ms-ready';
    image.referrerPolicy = 'no-referrer';
    if (options.src) image.src = options.src;
    if (typeof options.onLoad === 'function') image.addEventListener('load', () => options.onLoad(image), { once: true });
    return image;
}

export function createResolveIndicator(doc) {
    const indicator = doc.createElement('div');
    indicator.className = 'ms-resolve-loading';
    indicator.innerHTML = '<div class="ms-resolve-spinner"></div><div class="ms-resolve-text">Resolving high-res...</div>';
    return indicator;
}

export function configureVideoElement(options) {
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

export function createIframeMedia(options) {
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

export function createIframeShield(options = {}) {
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

export function createExpandButton(options) {
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

export function renderPosition(options) {
    const current = Math.max(0, Number(options.currentIndex) || 0);
    const length = Math.max(0, Number(options.length) || 0);
    if (options.counter) options.counter.textContent = (current + 1) + ' / ' + length;
    const disabled = length <= 1;
    if (options.previous) options.previous.disabled = disabled;
    if (options.next) options.next.disabled = disabled;
}
