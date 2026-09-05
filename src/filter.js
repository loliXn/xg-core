const IMAGE_EXTS = Object.freeze(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']);
const VIDEO_EXTS = Object.freeze(['mp4', 'webm', 'm4v', 'mov', 'mkv']);
const FILE_TYPE_OPTIONS = Object.freeze([
    'jpg', 'png', 'gif', 'webp', 'mp4', 'webm', 'm4v', 'zip', 'pdf'
]);

export const DEFAULT_FILTER_STATE = Object.freeze({
    query: '',
    kind: 'all',
    types: Object.freeze([]),
    minMb: null,
    maxMb: null,
    minAlbum: null,
    maxAlbum: null,
    extrasOpen: false
});

function asNumber(value) {
    if (value === '' || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export function normalizeFilterState(input) {
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
        extrasOpen: src.extrasOpen === true
    };
}

export function parseSearchQuery(query) {
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

export function itemSearchText(item) {
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

export function itemExtension(item) {
    if (!item) return '';
    const name = String(item.filename || item.src || item.thumbSrc || '').split('?')[0];
    const match = name.match(/\.([a-z0-9]{2,5})$/i);
    if (!match) return '';
    const ext = match[1].toLowerCase();
    return ext === 'jpeg' ? 'jpg' : ext;
}

export function itemKind(item) {
    if (!item) return 'images';
    if (item.type === 'video' || item.type === 'iframe' || item.isVideo || item.expectedVideo) return 'videos';
    const ext = itemExtension(item);
    if (VIDEO_EXTS.indexOf(ext) >= 0) return 'videos';
    return 'images';
}

export function itemBytes(item) {
    if (!item) return null;
    const raw = item.bytes != null ? item.bytes : (item.fileSize != null ? item.fileSize : item.size);
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

export function itemAlbumSize(item) {
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

export function matchGalleryItem(item, state) {
    const filter = normalizeFilterState(state);
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

export function applyGalleryFilter(items, state, getItem) {
    if (!Array.isArray(items)) return [];
    const pick = typeof getItem === 'function' ? getItem : (entry) => entry;
    return items.filter((entry) => matchGalleryItem(pick(entry), state));
}

export const FILTER_TYPE_OPTIONS = FILE_TYPE_OPTIONS;
export const FILTER_IMAGE_EXTS = IMAGE_EXTS;
export const FILTER_VIDEO_EXTS = VIDEO_EXTS;

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

export function filterBarMarkup() {
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
        '    <label class="ms-filter-field"><span>File types</span><div class="ms-filter-types">' + typeButtonsHtml() + '</div></label>',
        '    <label class="ms-filter-field"><span>File size</span><div class="ms-filter-pair">',
        '      <input class="ms-filter-min-mb" type="number" min="0" inputmode="numeric" placeholder="Min MB">',
        '      <input class="ms-filter-max-mb" type="number" min="0" inputmode="numeric" placeholder="Max MB">',
        '    </div></label>',
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
        extrasOpen: extrasOpen
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
        trigger.classList.toggle('active', next);
    }
    syncFilterHeight(root);
    return next;
}

export function bindFilterBar(root, options = {}) {
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
