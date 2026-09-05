(function (root) {
    'use strict';

    const XGALLERY_CORE_API_VERSION = 1;

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
            :root, .ms-gallery-overlay {
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
                --ms-accent: hsl(223, 88%, 57%);
                --ms-accent-tint: hsla(223, 88%, 57%, 0.13);
                --ms-accent-line: hsla(223, 88%, 57%, 0.72);
                --ms-hover: rgba(255, 255, 255, 0.08);
                --ms-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.25);
                --ms-shadow-md: 0 4px 12px rgba(0, 0, 0, 0.35);
                --ms-shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.45);
                --ms-ease: cubic-bezier(0.4, 0, 0.2, 1);
                --ms-ease-out: cubic-bezier(0.215, 0.61, 0.355, 1);
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
                font-family: system-ui, -apple-system, Segoe UI, sans-serif !important;
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
                --ms-topbar-h: 56px;
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
                font-family: system-ui, -apple-system, Segoe UI, sans-serif !important;
            }
            .ms-gallery-overlay,
            .ms-gallery-overlay * {
                box-sizing: border-box;
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
                top: 12px;
                left: 50%;
                transform: translateX(-50%);
                width: calc(100% - 40px);
                max-width: 95%;
                height: 44px;
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
                align-items: center;
                column-gap: 16px;
                z-index: 100;
                pointer-events: auto;
                background: hsla(220, 7%, 9%, 0.92);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border: 1px solid var(--ms-line);
                border-radius: 22px;
                padding: 0 16px;
                box-sizing: border-box;
                box-shadow: var(--ms-shadow-md);
            }
            .ms-gallery-info {
                grid-column: 1;
                min-width: 0;
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
            .ms-info-author:hover { text-decoration: underline; }
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
                border-radius: 14px;
                height: 28px;
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
            .ms-gallery-overlay .ms-gallery-topbar .ms-btn,
            .ms-gallery-overlay .ms-gallery-topbar .ms-icon-btn {
                border: none;
                box-shadow: none;
                outline: none;
            }
            .ms-btn-icon {
                width: 12px;
                height: 12px;
                stroke: currentColor;
                fill: none;
                vertical-align: -1px;
                margin-right: 4px;
                flex-shrink: 0;
            }

            .ms-filter-bar {
                position: absolute;
                top: calc(var(--ms-topbar-h) + 12px);
                right: 20px;
                left: auto;
                transform: translateY(-6px) scale(0.985);
                transform-origin: top right;
                width: min(620px, calc(100% - 24px));
                z-index: 100;
                box-sizing: border-box;
                padding: 12px;
                border: 1px solid var(--ms-line);
                border-radius: 14px;
                background: hsla(220, 7%, 10%, 0.94);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
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
                color: #fff;
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
                color: #fff;
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
                object-fit: contain;
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
            }
            .ms-caption-overlay.ms-caption-bottom {
                top: auto;
                bottom: 0;
                padding: 32px 14px 54px;
                background: linear-gradient(transparent, rgba(0, 0, 0, 0.78));
            }
            .ms-caption-overlay.ms-caption-top {
                top: 0;
                bottom: auto;
                padding: 54px 14px 28px;
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
                gap: 4px;
                margin: 8px 0 10px;
                width: 100%;
            }
            .ms-caption-mode button {
                flex: 1 1 0;
                height: 28px;
                padding: 0 6px;
                border: 1px solid var(--ms-line);
                background: var(--ms-surface-3);
                color: var(--ms-text-3);
                border-radius: 7px;
                font-size: 11px;
                font-weight: 650;
                cursor: pointer;
            }
            .ms-caption-mode button.active {
                color: var(--ms-text);
                border-color: var(--ms-accent-line);
                background: var(--ms-accent-tint);
            }
            .ms-media-wrap iframe.ms-media {
                z-index: 1;
            }
            .ms-media-wrap .ms-media.ms-ready {
                opacity: 1;
                transform: none;
                filter: blur(0);
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
                top: var(--ms-topbar-h);
                bottom: var(--ms-thumbs-h);
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
                width: 40px;
                height: 40px;
                padding: 10px;
                box-sizing: border-box;
                border-radius: 50%;
                background: hsla(220, 7%, 9%, 0.84);
                border: 1px solid var(--ms-line);
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
                background: hsla(220, 7%, 13%, 0.94);
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
                height: var(--ms-thumbs-h);
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
                border-radius: 16px;
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
                text-decoration: underline;
                color: #ff4500;
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
            .ms-thumb.ms-thumb-abs {
                position: absolute;
                top: 10px;
                margin-right: 0 !important;
                z-index: 1;
            }
            .ms-btn-expand-album {
                position: absolute;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 12;
                display: inline-flex !important;
                align-items: center;
                gap: 8px;
                height: 40px;
                padding: 0 16px;
                border-radius: 10px;
                background: hsla(220, 7%, 9%, 0.92);
                border: 1px solid var(--ms-line);
                color: var(--ms-text);
                font-size: 13px;
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
                position: relative;
                display: inline-block;
                width: 70px;
                height: 70px;
                box-sizing: border-box;
                margin-right: 6px;
                border: 2px solid var(--ms-line) !important;
                border-radius: 6px;
                overflow: hidden;
                opacity: 0.7;
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
                opacity: 1;
                border-color: var(--ms-line-strong) !important;
            }
            .ms-thumb.active {
                opacity: 1;
                border-color: var(--ms-accent) !important;
            }
            .ms-thumb img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
                pointer-events: none;
                opacity: 1;
                transition: none;
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
            .ms-site-settings-btn svg path,
            .ms-site-settings-btn svg circle {
                fill: none !important;
                stroke: currentColor !important;
            }
            .ms-site-settings-btn:hover {
                background: var(--ms-surface-3);
                border-color: var(--ms-line-strong);
                box-shadow: var(--ms-shadow-md);
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
            body.ms-host-isolation > :not(.ms-gallery-overlay):not(.ms-gallery-root):not(#ms-site-gallery-btn):not(#ms-site-settings-btn):not(#ms-site-redirect-btn),
            body.ms-reddit-isolation > :not(.ms-gallery-overlay):not(.ms-gallery-root):not(#ms-site-gallery-btn):not(#ms-site-settings-btn):not(#ms-site-redirect-btn) {
                visibility: hidden !important;
                pointer-events: none !important;
                contain: layout paint style;
                content-visibility: hidden;
            }
            body.ms-host-isolation-layout > :not(.ms-gallery-overlay):not(.ms-gallery-root):not(#ms-site-gallery-btn):not(#ms-site-settings-btn):not(#ms-site-redirect-btn),
            body.ms-bdsmlr-isolation > :not(.ms-gallery-overlay):not(.ms-gallery-root):not(#ms-site-gallery-btn):not(#ms-site-settings-btn):not(#ms-site-redirect-btn) {
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
                border: 1px solid var(--ms-line);
                border-radius: 16px;
                padding: 0;
                width: 460px;
                max-width: calc(100vw - 32px);
                max-height: min(85vh, 720px);
                overflow: hidden;
                display: flex;
                flex-direction: column;
                color: var(--ms-text-2);
                font-family: system-ui, -apple-system, "Segoe UI", sans-serif !important;
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
                font-weight: 650;
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
                border-color: var(--ms-line);
            }
            .ms-settings-close svg {
                width: 14px;
                height: 14px;
            }
            .ms-settings-body {
                padding: 14px 16px 8px;
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color: var(--ms-line-strong) transparent;
            }
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
                color: #fff;
            }
            .ms-r34-settings-modal button.ms-r34-save:hover {
                background: hsl(223, 88%, 50%);
                border-color: hsl(223, 88%, 50%);
                color: #fff;
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
                height: 28px;
                min-width: 0;
                padding: 0 7px;
                box-sizing: border-box;
                align-items: center;
                justify-content: center;
                gap: 2px;
                border: 1px solid var(--ms-line);
                border-radius: 14px;
                background: var(--ms-surface-3);
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
                text-decoration: underline;
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
                background: hsla(223, 88%, 57%, 0.22);
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
            }
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
                border-radius: 16px;
                display: flex;
                flex-direction: column;
                box-shadow: var(--ms-shadow-lg);
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
                width: 26px;
                height: 22px;
                cursor: pointer;
                transition: color 150ms var(--ms-ease), background-color 150ms var(--ms-ease);
            }
            .ms-tags-font-btn:hover {
                color: var(--ms-text);
                background: var(--ms-hover);
            }
            .ms-tags-close {
                background: none;
                border: none;
                color: var(--ms-text-4);
                font-size: 22px;
                cursor: pointer;
                transition: color 150ms var(--ms-ease);
                line-height: 1;
                padding: 0 4px;
            }
            .ms-tags-close:hover {
                color: var(--ms-text);
            }
            .ms-tags-content {
                font-size: var(--ms-tags-font, 15px);
                padding: 12px;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                align-items: stretch;
                gap: 5px;
                scrollbar-width: thin;
                scrollbar-color: var(--ms-line-strong) var(--ms-surface-1);
            }
            .ms-tag-pills {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                width: 100%;
            }
            .ms-info-tags-label {
                color: var(--ms-text-3);
                font-size: 0.74em;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin: 4px 0 6px;
                width: 100%;
            }
            .ms-tag-pill {
                display: inline-flex;
                align-items: center;
                max-width: 100%;
                box-sizing: border-box;
                background: var(--ms-surface-3);
                border: 1px solid var(--ms-line);
                color: var(--ms-text-2);
                padding: 5px 10px;
                border-radius: 20px;
                font-size: 0.8em;
                line-height: 1.2;
                text-decoration: none;
                word-break: break-word;
                transition: background 150ms var(--ms-ease), border-color 150ms var(--ms-ease), color 150ms var(--ms-ease);
            }
            .ms-tag-pill:hover {
                background: var(--ms-hover);
                border-color: var(--ms-line-strong);
                color: var(--ms-text);
            }
            /* Optional tag-category tints. Adapters assign these classes. */
            .ms-tag-pill-artist {
                background: rgba(170, 0, 0, 0.18);
                border-color: #a33;
                color: #ffb3b3;
            }
            .ms-tag-pill-copyright {
                background: rgba(153, 0, 153, 0.18);
                border-color: #939;
                color: #e3b3ff;
            }
            .ms-tag-pill-character {
                background: rgba(0, 153, 0, 0.18);
                border-color: #393;
                color: #b3ffb3;
            }
            .ms-tag-pill-general {
                background: rgba(0, 102, 204, 0.16);
                border-color: #369;
                color: #bcdcff;
            }
            .ms-tag-pill-metadata {
                background: rgba(204, 102, 0, 0.18);
                border-color: #b76;
                color: #ffdcb3;
            }
            .ms-info-description p {
                margin: 0 0 6px;
            }
            .ms-info-description p:last-child {
                margin-bottom: 0;
            }
            .ms-gallery-overlay.ms-rich-info .ms-info-description a[href]:not(.ms-info-desc-username),
            .ms-gallery-overlay.ms-imaglr .ms-info-description a[href]:not(.ms-info-desc-username),
            .ms-gallery-overlay.ms-bdsmlr .ms-info-description a[href]:not(.ms-info-desc-username) {
                color: var(--ms-accent) !important;
                font-weight: 600;
                text-decoration: underline !important;
                text-decoration-color: var(--ms-accent-line) !important;
                text-decoration-thickness: 1px;
                text-underline-offset: 2px;
                transition: color 150ms var(--ms-ease), text-decoration-color 150ms var(--ms-ease);
            }
            .ms-gallery-overlay.ms-rich-info .ms-info-description a[href]:not(.ms-info-desc-username):hover,
            .ms-gallery-overlay.ms-imaglr .ms-info-description a[href]:not(.ms-info-desc-username):hover,
            .ms-gallery-overlay.ms-bdsmlr .ms-info-description a[href]:not(.ms-info-desc-username):hover {
                color: hsl(223, 92%, 70%) !important;
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
                width: 22px;
                height: 22px;
                border-radius: 50%;
                object-fit: cover;
                flex-shrink: 0;
                background: var(--ms-surface-3);
            }
            .ms-info-desc-username {
                font-weight: 700;
                font-size: 0.87em;
                color: var(--ms-text);
                text-decoration: none;
            }
            a.ms-info-desc-username:hover {
                text-decoration: underline;
            }
            .ms-info-description {
                color: var(--ms-text-2);
                font-size: 1em;
                line-height: 1.5;
                margin-bottom: 10px;
                width: 100%;
                background: var(--ms-surface-2);
                border-radius: 8px;
                padding: 10px 12px;
                box-sizing: border-box;
                word-break: break-word;
            }
            .ms-gallery-overlay.ms-imaglr .ms-info-description,
            .ms-gallery-overlay.ms-imaglr .ms-tags-content {
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                font-size: 13px;
                line-height: 1.55;
                letter-spacing: 0;
            }
            .ms-gallery-overlay.ms-imaglr .ms-info-postmeta,
            .ms-gallery-overlay.ms-imaglr .ms-info-stats,
            .ms-position-control {
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            }
            .ms-info-posthead {
                width: 100%;
                min-height: 44px;
                margin-bottom: 10px;
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
                margin-top: 4px;
                font-size: 0.74em;
                color: var(--ms-text-4);
                line-height: 1.5;
            }
            .ms-info-description .ms-info-user-sm {
                margin-bottom: 6px;
            }
            .ms-info-original {
                width: 100%;
                margin-top: 10px;
                font-size: 0.74em;
                color: var(--ms-text-4);
            }
            .ms-info-stats {
                display: flex;
                flex-wrap: wrap;
                gap: 12px;
                width: 100%;
                margin-top: 10px;
                font-size: 0.74em;
                color: var(--ms-text-4);
                text-transform: uppercase;
                letter-spacing: 0.4px;
            }
            .ms-info-stats b {
                color: var(--ms-text-2);
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
                color: hsl(223, 96%, 72%);
                background: var(--ms-accent-tint);
            }
            .ms-tags-actions-bar {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-top: 12px;
                margin-bottom: 12px;
                flex-wrap: wrap;
            }
            .ms-tags-action-btn,
            .ms-tags-like-btn,
            .ms-tags-hide-btn,
            .adv-hide-btn-list {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                height: 34px;
                padding: 0 14px;
                gap: 7px;
                background: var(--ms-surface-3);
                border: 1px solid var(--ms-line);
                color: var(--ms-text-2);
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
                border-color: var(--ms-line-strong);
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
                width: 15px;
                height: 15px;
                fill: currentColor;
                stroke: none;
                flex-shrink: 0;
            }
            .ms-tags-like-btn.active {
                color: #ff2a54;
                border-color: rgba(255, 42, 84, 0.45);
                background: rgba(255, 42, 84, 0.14);
            }
            .ms-tags-like-btn.active svg {
                fill: #ff2a54;
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
            .ms-gallery-overlay.ms-rich-info .ms-info-posthead .ms-info-desc-avatar,
            .ms-gallery-overlay.ms-imaglr .ms-info-posthead .ms-info-desc-avatar,
            .ms-gallery-overlay.ms-bdsmlr .ms-info-posthead .ms-info-desc-avatar {
                width: 24px;
                height: 24px;
            }
            .ms-gallery-overlay.ms-rich-info .ms-info-posthead .ms-info-desc-username,
            .ms-gallery-overlay.ms-imaglr .ms-info-posthead .ms-info-desc-username,
            .ms-gallery-overlay.ms-bdsmlr .ms-info-posthead .ms-info-desc-username {
                font-size: 14px;
                font-weight: 600;
            }
            .ms-gallery-overlay.ms-rich-info .ms-info-postmeta,
            .ms-gallery-overlay.ms-imaglr .ms-info-postmeta,
            .ms-gallery-overlay.ms-bdsmlr .ms-info-postmeta {
                font-size: 11px;
            }
            .ms-gallery-overlay.ms-rich-info .ms-info-stats,
            .ms-gallery-overlay.ms-imaglr .ms-info-stats,
            .ms-gallery-overlay.ms-bdsmlr .ms-info-stats {
                font-size: 11px;
                text-transform: none;
                letter-spacing: 0;
            }
            .ms-gallery-overlay.ms-rich-info .ms-tags-content,
            .ms-gallery-overlay.ms-imaglr .ms-tags-content,
            .ms-gallery-overlay.ms-bdsmlr .ms-tags-content {
                font-size: var(--ms-tags-font, 14px);
            }
            .ms-fav-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                background: transparent !important;
                border: none !important;
                cursor: pointer;
                padding: 0 8px !important;
                transition: transform 150ms var(--ms-ease);
            }
            .ms-fav-btn:hover {
                transform: scale(1.15);
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
            .ms-gallery-overlay.ms-stage-fullscreen .ms-gallery-topbar {
                transform: translateX(-50%) translateY(0);
                transition: transform 200ms var(--ms-ease-out);
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
                .ms-nav svg { transition-duration: 0.01ms !important; transform: none !important; }
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
                height: 28px;
                padding: 0 8px;
                box-sizing: border-box;
                border: 1px solid var(--ms-line);
                border-radius: 14px;
                background: var(--ms-surface-3);
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
    .ms-index-input{top:0!important;height:1em!important;display:inline-flex!important;align-items:center!important;}.ms-position-control>span{display:inline-flex;align-items:center;height:1em;line-height:1;}.ms-tags-overlay.active{z-index:20;}.ms-load-mark-layer{position:absolute;left:0;top:0;height:100%;pointer-events:none;z-index:6;}.ms-load-mark{position:absolute;top:10px;width:14px;height:70px;display:flex;align-items:center;justify-content:center;color:var(--ms-accent);}.ms-load-mark::before{content:"";position:absolute;left:50%;top:8px;bottom:8px;width:1px;background:var(--ms-accent);opacity:0.7;}.ms-load-mark svg{width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;position:relative;z-index:1;}.ms-settings-row.ms-settings-stack{flex-direction:column;align-items:stretch;gap:8px;}.ms-settings-textarea{width:100%;min-height:88px;resize:vertical;box-sizing:border-box;background:var(--ms-surface-3,#1b1d24);border:1px solid var(--ms-line,#333);border-radius:8px;color:var(--ms-text-2,#ddd);font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:8px 10px;outline:none;}.ms-settings-textarea:focus{border-color:var(--ms-accent);}.ms-settings-hint{margin:0;font-size:11px;color:var(--ms-text-4,#888);}.ms-blacklist-pills{display:flex;flex-wrap:wrap;gap:6px;}.ms-blacklist-pill{border:1px solid var(--ms-line,#444);background:transparent;color:var(--ms-text-3,#ccc);border-radius:999px;padding:3px 9px;font-size:12px;cursor:pointer;}.ms-blacklist-pill[aria-pressed="true"]{background:hsla(0,72%,46%,0.18);border-color:hsla(0,72%,56%,0.55);color:#f2c0c0;}
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
                --ms-accent: hsl(223, 88%, 57%);
                --ms-accent-line: hsla(223, 88%, 57%, 0.72);
                --ms-hover: rgba(255, 255, 255, 0.08);
                --ms-shadow-md: 0 4px 12px rgba(0, 0, 0, 0.35);
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
                font-family: system-ui, -apple-system, Segoe UI, sans-serif !important;
                font-size: 13px;
                letter-spacing: 0.5px;
            }
            .ms-xcom-gallery-btn { padding: 10px 20px; height: auto; }
            .ms-xcom-gallery-btn:hover, .ms-site-gallery-btn:hover {
                background: var(--ms-surface-3);
                border-color: var(--ms-line-strong);
            }
            .ms-open-in-gallery {
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                gap: 6px !important;
                height: 28px !important;
                min-height: 28px !important;
                box-sizing: border-box !important;
                padding: 0 10px !important;
                margin-inline-start: 12px;
                vertical-align: middle;
                background: var(--ms-surface-1) !important;
                color: var(--ms-text) !important;
                border: 1px solid var(--ms-line) !important;
                border-radius: 8px !important;
                cursor: pointer !important;
                font-family: system-ui, -apple-system, Segoe UI, sans-serif !important;
                font-size: 11px;
                font-weight: 600;
                letter-spacing: 0.5px;
                line-height: 1 !important;
                text-transform: uppercase;
            }
            .ms-open-in-gallery svg {
                width: 12px;
                height: 12px;
                flex-shrink: 0;
            }
            .ms-open-in-gallery--embed {
                margin-inline-start: 0;
                margin-block-start: 8px;
            }
            .ms-open-in-gallery--unfurl {
                margin-inline-start: 8px;
                margin-block-start: 0;
                height: 24px !important;
                min-height: 24px !important;
                padding: 0 8px;
                font-size: 10px;
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
                background: var(--ms-hover);
            }
            .ms-open-in-gallery:active {
                transform: scale(0.97);
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
            .ms-site-settings-btn svg path,
            .ms-site-settings-btn svg circle {
                fill: none !important;
                stroke: currentColor !important;
            }
            .ms-site-settings-btn:hover {
                background: var(--ms-surface-3);
                border-color: var(--ms-line-strong);
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
        `;
    function installLauncherStyles(addStyle) { return addStyle(LAUNCHER_CSS); }

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
        extrasOpen: false
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
            extrasOpen: src.extrasOpen === true
        };
    }

    function isFilterStateActive(input) {
        const state = normalizeFilterState(input);
        return state.kind !== 'all'
            || state.types.length > 0
            || state.minMb != null
            || state.maxMb != null
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
        const overlay = root.closest('.ms-gallery-overlay');
        const trigger = overlay && overlay.querySelector('[data-act="filter-toggle"]');
        if (trigger) {
            const active = isFilterStateActive(state);
            trigger.classList.toggle('active', active);
            trigger.setAttribute('aria-pressed', active ? 'true' : 'false');
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
            '    <label class="ms-position-control" title="Go to image"><input type="text" inputmode="numeric" pattern="[0-9]*" class="ms-index-input" value="1" aria-label="Go to image"><span aria-hidden="true">/</span><span class="ms-position-total">1</span></label>',
            '    <div class="ms-topbar-spinner" title="Loading full image..."></div>',
            '    <button class="ms-btn ms-icon-btn ms-fullscreen-btn" data-act="fullscreen-toggle" title="Fit to page"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg></button>',
            '    <button class="ms-btn ms-icon-btn ms-fav-btn" data-act="fav-toggle" style="display:none;" title="Favorite"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg></button>',
            '    <button class="ms-btn ms-icon-btn ms-x-action" data-act="x-like" style="display:none;" title="Like post"><svg viewBox="0 0 24 24"><path d="M16.7 5.5c-1.3 0-2.7.6-3.9 2.2L12 8.8l-.8-1.1C10 6.1 8.6 5.5 7.3 5.5 5 5.6 3.4 7.8 4.4 10.4c.8 2.2 3.2 5.3 7.6 8 4.4-2.7 6.8-5.8 7.6-8 1-2.6-.6-4.8-2.9-4.9Z"/></svg></button>',
            '    <button class="ms-btn ms-icon-btn ms-x-action" data-act="x-bookmark" style="display:none;" title="Bookmark post"><svg viewBox="0 0 24 24"><path d="M6.5 3h11c.8 0 1.5.7 1.5 1.5V21l-7-5-7 5V4.5C5 3.7 5.7 3 6.5 3Z"/></svg></button>',
            '    <div class="ms-zoom-slider-wrap ms-zoom-idle">',
            '      <b class="ms-zoom-value"></b>',
            '      <input type="range" class="ms-zoom-slider" min="0.1" max="3" step="0.01">',
            '    </div>',
            '  </div>',
            '  <div class="ms-gallery-controls">',
            '    <button class="ms-btn ms-hd-btn" data-act="hd" style="display:none;"><span class="ms-hd-spinner"></span>HD</button>',
            '    <button class="ms-btn ms-tags-btn" data-act="show-tags" style="display:' + (options.showInfo ? '' : 'none') + ';"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41L13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5"/></svg><span class="ms-btn-label">' + String(options.infoLabel || 'Tags') + '</span></button>',
            '    <button class="ms-btn ms-loop-btn" data-act="loop-toggle" style="display:none;" title="Loop"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg><span class="ms-btn-label">Loop</span></button>',
            '    <button class="ms-btn ms-filter-trigger" data-act="filter-toggle" aria-expanded="false" title="Filter gallery"><svg class="ms-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/></svg><span class="ms-btn-label">FILTER</span></button>',
            '    <button class="ms-btn" data-act="view-toggle"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><span class="ms-btn-label">Grid</span></button>',
            '    <button class="ms-btn" data-act="pan-toggle" title="Zoom &amp; pan"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg><span class="ms-btn-label">Zoom</span></button>',
            '    <button class="ms-btn" data-act="download" title="Download"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg><span class="ms-btn-label">DL</span></button>',
            '    <div class="ms-dropdown">',
            '      <button class="ms-btn ms-dropdown-trigger" data-act="fit-trigger"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M8 7l4-4 4 4"/><path d="M8 17l4 4 4-4"/></svg><span class="ms-btn-label">Fit: Std</span></button>',
            '      <div class="ms-dropdown-menu">',
            '    <button class="ms-dropdown-item" data-act="fit" data-val="standard">Standard</button>',
            '    <button class="ms-dropdown-item" data-act="fit" data-val="vertical">Vertical</button>',
            '      </div>',
            '    </div>',
            '    <button class="ms-btn" data-act="thumbs-toggle" title="Toggle thumbnails"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="5.5" height="10" rx="1"/><rect x="9.25" y="7" width="5.5" height="10" rx="1"/><rect x="16.5" y="7" width="5.5" height="10" rx="1"/></svg><span class="ms-btn-label">Thumbs</span></button>',
            '    <button class="ms-btn ms-close-btn" data-act="close" title="Close"><svg class="ms-btn-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg><span class="ms-btn-label">Close</span></button>',
            '  </div>',
            '</div>',
            filterBarMarkup(),
            '<div class="ms-gallery-stage">',
            '  <div class="ms-tags-overlay">',
            '    <div class="ms-tags-panel">',
            '      <div class="ms-tags-header">',
            '    <h3>Image Tags</h3>',
            '    <div class="ms-tags-header-tools">',
            '      <button class="ms-tags-font-btn" data-act="tags-font" data-val="-1" title="Smaller text">A&minus;</button>',
            '      <button class="ms-tags-font-btn" data-act="tags-font" data-val="1" title="Larger text">A+</button>',
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
                if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
            });
        });
        panelLinks(node);
        return node;
    }

    function renderPostPanel(options) {
        const { content, model } = options;
        const doc = content.ownerDocument;
        content.replaceChildren();
        const user = (data, small = false) => {
            const row = panelElement(doc, small ? 'span' : 'div', 'ms-info-user' + (small ? ' ms-info-user-sm' : ''));
            if (data.avatarUrl) {
                const avatar = panelElement(doc, 'img', 'ms-info-desc-avatar');
                avatar.src = data.avatarUrl;
                avatar.referrerPolicy = 'no-referrer';
                row.append(avatar);
            }
            const name = panelElement(doc, data.profileUrl ? 'a' : 'span', 'ms-info-desc-username', data.username || data.name || '\u00a0');
            if (data.profileUrl) name.href = data.profileUrl;
            row.append(name);
            panelLinks(row);
            return row;
        };
        const info = model.postInfo || {};
        if (info.author || model.reserveHeader) {
            const head = panelElement(doc, 'div', 'ms-info-posthead');
            head.append(user(info.author || {}));
            const meta = panelElement(doc, 'div', 'ms-info-postmeta', info.time || (model.reserveHeader ? '\u00a0' : ''));
            if (info.repostedFrom) meta.append(doc.createTextNode(' · reposted from '), user(info.repostedFrom, true));
            head.append(meta);
            content.append(head);
        }
        if (options.captionControls) options.captionControls(content);
        const captions = Array.isArray(info.captions) && info.captions.length ? info.captions : [{ html: model.description }];
        const caption = panelElement(doc, 'div', 'ms-panel-caption');
        captions.forEach(cap => {
            if (!cap.html) return;
            const card = panelHtml(doc, cap.html, 'ms-info-description');
            if (cap.user && !(captions.length === 1 && info.author && cap.user.username === info.author.username)) card.prepend(user(cap.user, true));
            caption.append(card);
        });
        if (caption.childNodes.length) content.append(caption);
        if (model.tags && model.tags.length) {
            content.append(panelElement(doc, 'div', 'ms-info-tags-label', 'Tags'));
            const pills = panelElement(doc, 'div', 'ms-tag-pills');
            model.tags.forEach(tag => {
                const link = panelElement(doc, 'a', 'ms-tag-pill', '#' + tag.label);
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
            content.append(pills);
        }
        if (info.originalPost && info.originalPost.username) {
            const original = panelElement(doc, 'div', 'ms-info-original', 'Originally posted by ');
            original.append(user({ ...info.originalPost, profileUrl: info.originalPost.url }, true));
            content.append(original);
        }
        if (info.stats) {
            const stats = panelElement(doc, 'div', 'ms-info-stats');
            for (const [key, label] of [['views', 'Views'], ['reposts', 'Reposts']]) {
                if (info.stats[key]) stats.append(panelElement(doc, 'span', '', info.stats[key] + ' ' + label));
            }
            if (stats.childNodes.length) content.append(stats);
        }
        if (model.actions && model.actions.length) {
            const actions = panelElement(doc, 'div', 'ms-tags-actions-bar');
            model.actions.forEach(action => {
                const button = panelElement(doc, action.href ? 'a' : 'button', 'ms-tags-action-btn ms-tags-' + action.kind + '-btn');
                if (!action.href) button.type = 'button';
                else { button.href = action.href; button.target = '_blank'; button.rel = 'noopener noreferrer'; }
                if (action.kind === 'like') {
                    const icon = panelElement(doc, 'span', 'ms-tags-action-icon');
                    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8Z"/></svg>';
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
            content.append(actions);
        }
        if (!content.childNodes.length) content.append(panelElement(doc, 'div', 'ms-info-empty', 'No description or tags available.'));
    }

    function createSettingsPanel(options) {
        const doc = options.document || document;
        if (doc.getElementById('ms-r34-settings-overlay')) return null;
        const overlay = panelElement(doc, 'div', 'ms-r34-settings-overlay');
        overlay.id = 'ms-r34-settings-overlay';
        const modal = panelElement(doc, 'div', 'ms-r34-settings-modal');
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
        const heading = panelElement(doc, 'div', 'ms-settings-head');
        heading.append(panelElement(doc, 'h3', '', 'Gallery Settings'));
        const close = panelElement(doc, 'button', 'ms-settings-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close');
        heading.append(close); modal.append(heading);
        const body = panelElement(doc, 'div', 'ms-settings-body');
        const controls = new Map();
        options.sections.forEach(section => {
            body.append(panelElement(doc, 'div', 'ms-settings-section-group', section.label));
            const card = panelElement(doc, 'div', 'ms-settings-card');
            section.fields.forEach(field => {
                const row = panelElement(doc, 'div', 'ms-settings-row' + (field.type === 'textarea' ? ' ms-settings-stack' : ''));
                const label = panelElement(doc, 'label', 'ms-settings-label', field.label);
                if (field.note) { label.append(doc.createElement('br'), panelElement(doc, 'small', '', field.note)); }
                row.append(label);
                let input;
                if (field.type === 'button') {
                    input = panelElement(doc, 'button', '', field.buttonLabel || field.label); input.type = 'button';
                    input.addEventListener('click', async () => {
                        input.disabled = true;
                        try { const text = await field.run(); if (text) input.textContent = text; }
                        catch { input.textContent = 'Try again'; }
                        finally { input.disabled = false; }
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
                } else {
                    input = doc.createElement(field.type === 'textarea' ? 'textarea' : 'input');
                    if (field.type === 'textarea') input.className = 'ms-settings-textarea';
                    else input.type = field.type || 'text';
                    input.value = field.value == null ? '' : field.value;
                    for (const key of ['min', 'max', 'step', 'placeholder']) if (field[key] != null) input[key] = field[key];
                }
                input.id = field.id; label.htmlFor = field.id;
                if (field.type !== 'checkbox') row.append(input);
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
            body.append(card);
        });
        modal.append(body);
        const footer = panelElement(doc, 'div', 'ms-r34-btn-row');
        const cancel = panelElement(doc, 'button', 'ms-r34-cancel', 'Cancel');
        const save = panelElement(doc, 'button', 'ms-r34-save', 'Save');
        cancel.type = save.type = 'button'; footer.append(cancel, save); modal.append(footer); overlay.append(modal);
        const dismiss = () => options.onClose(overlay);
        close.addEventListener('click', dismiss); cancel.addEventListener('click', dismiss);
        overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(); });
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); } });
        save.addEventListener('click', () => {
            const values = {};
            controls.forEach(({input,field}, id) => { if (field.type !== 'button') values[id] = field.type === 'checkbox' ? input.checked : input.value; });
            options.onSave(values); dismiss();
        });
        doc.body.append(overlay);
        requestAnimationFrame(() => { overlay.classList.add('ms-settings-open'); close.focus(); });
        return overlay;
    }

    // Shared viewer behavior. Host operations and persisted preferences enter through the bridge.
    function createViewerRuntime(bridge) {
    function createLauncher(options) {
        if(document.getElementById(options.id))return document.getElementById(options.id);
        const button=document.createElement('button');button.type='button';button.id=options.id;button.className=options.className||options.id;
        button.textContent=options.label||'Gallery';button.title=options.title||button.textContent;
        button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();options.onClick();});
        document.body.append(button);return button;
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
        clearFullscreenIdleTimer();stopThumbTrackAnimation();
        if(bridge.state.mediaFitObserver){bridge.state.mediaFitObserver.disconnect();bridge.state.mediaFitObserver=null;}
        for(const key of ['thumbsWindowRaf','gridWindowRaf'])if(bridge.state[key]){cancelAnimationFrame(bridge.state[key]);bridge.state[key]=null;}
        overlay.classList.remove('ms-grid-mode','ms-stage-fullscreen');
        const grid=overlay.querySelector('.ms-grid');if(grid)grid.replaceChildren();
        bridge.state.gridPool=[];bridge.state.gridSizer=null;
        const wrap=overlay.querySelector('.ms-media-wrap');
        if(wrap){
            delete wrap.dataset.msVerticalFitBound;
            wrap.querySelectorAll('video,audio').forEach(media=>{
                media.pause();media.removeAttribute('src');media.querySelectorAll('source').forEach(source=>source.remove());
                try{media.load();}catch{}
            });
            wrap.querySelectorAll('iframe').forEach(frame=>frame.src='about:blank');wrap.replaceChildren();
        }
    }
    function revealHost() {
        const overlay=bridge.state.overlay;if(!overlay)return;
        overlay.classList.remove('ms-closing');
        if(!bridge.state.open){overlay.classList.remove('active','ms-open');overlay.style.display='none';overlay.style.pointerEvents='none';}
    }
    function showPostPanel(model, item) {
        const panel = bridge.state.overlay && bridge.state.overlay.querySelector('.ms-tags-overlay');
        if (!panel) return;
        panel.querySelector('.ms-tags-header h3').textContent = model.title || 'Post';
        renderPostPanel({content:panel.querySelector('.ms-tags-content'),model,captionControls:content => appendCaptionModeControls(content,item)});
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
                infoLabel: bridge.captionFeed ? 'Description' : (bridge.reservedPostHeader || bridge.titleCard ? 'Info' : 'Tags')
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
                zoomSlider.addEventListener('input', () => {
                    const valueEl = overlay.querySelector('.ms-zoom-value');
                    if (valueEl) valueEl.textContent = Math.round(parseFloat(zoomSlider.value) * 100) + '%';
                    if (!bridge.state.pan || !bridge.state.pan.active) {
                        const wrap = overlay.querySelector('.ms-media-wrap');
                        const img = wrap ? wrap.querySelector('img.ms-media.ms-ready') : null;
                        if (wrap && img) {
                            enablePanForImage(wrap, img);
                        }
                    }

                    if (zoomApplyRaf !== null) return;
                    zoomApplyRaf = requestAnimationFrame(() => {
                        zoomApplyRaf = null;
                        if (bridge.state.pan && bridge.state.pan.active && typeof bridge.state.pan.updateZoom === 'function') {
                            bridge.state.pan.updateZoom(parseFloat(zoomSlider.value));
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
                    if (video) video.loop = bridge.globalLoop;
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
            if (bridge.state.gridMode) return;
            const target = e.target;
            if (target && target.closest('.ms-thumbs-wrap, .ms-gallery-controls, .ms-filter-bar')) return;
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
                const gap = parseFloat(bridge.getComputedStyle(row).columnGap) || 0;
                total += gap * (shown - 1);
            }
            return total;
        }

    function topbarLayoutSignature(topbar, controls) {
            const center = topbar.querySelector('.ms-gallery-center');
            const vis = (el) => el
                ? Array.prototype.map.call(el.children, (k) => (k.style.display === 'none' ? '0' : '1')).join('')
                : '';
            return topbar.clientWidth + '|' + vis(controls) + '|' + vis(center);
        }

    function updateTopbarCompact() {
            if (!bridge.state.overlay) return;
            const topbar = bridge.state.overlay.querySelector('.ms-gallery-topbar');
            const controls = bridge.state.overlay.querySelector('.ms-gallery-controls');
            if (!topbar || !controls) return;

            const sig = topbarLayoutSignature(topbar, controls);
            if (topbar.dataset.msCompactSig === sig) return;
            topbar.dataset.msCompactSig = sig;

            topbar.classList.remove('ms-icons-only');
            topbar.classList.remove('ms-topbar-tight');

            if (measureRowContentWidth(controls) > controls.clientWidth + 1) {
                topbar.classList.add('ms-icons-only');
                if (measureRowContentWidth(controls) > controls.clientWidth + 1) {
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
                    updateTopbarCompact();
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
                if (bridge.filterMode === 1) setBtnLabel(triggerFilter, 'Filter: Img');
                else if (bridge.filterMode === 2) setBtnLabel(triggerFilter, 'Filter: Vid');
                else if (bridge.filterMode === 3) setBtnLabel(triggerFilter, 'Filter: Img+GIF');
                else setBtnLabel(triggerFilter, 'Filter: All');
            }
            if (triggerFit) {
                setBtnLabel(triggerFit, bridge.fitVertical ? 'Fit: Vert' : 'Fit: Std');
                triggerFit.style.display = bridge.state.gridMode ? 'none' : '';
            }
            if (triggerThumbs) {
                const hidden = bridge.state.overlay.classList.contains('ms-thumbs-hidden');
                triggerThumbs.classList.toggle('active', !hidden);
                triggerThumbs.style.display = bridge.state.gridMode ? 'none' : '';
            }
            const triggerView = bridge.state.overlay.querySelector('[data-act="view-toggle"]');
            if (triggerView) {
                setBtnLabel(triggerView, bridge.state.gridMode ? 'Viewer' : 'Grid');
            }
            const triggerPan = bridge.state.overlay.querySelector('[data-act="pan-toggle"]');
            if (triggerPan) {
                const panActive = !!(bridge.state.pan && bridge.state.pan.active);
                triggerPan.classList.toggle('active', panActive);
                triggerPan.style.display = bridge.state.gridMode ? 'none' : '';
            }
            const triggerFullscreen = bridge.state.overlay.querySelector('[data-act="fullscreen-toggle"]');
            if (triggerFullscreen) {
                triggerFullscreen.classList.toggle('active', !!bridge.state.stageFullscreen);
                triggerFullscreen.style.display = bridge.state.gridMode ? 'none' : '';
            }

            if (bridge.state.gridMode) {
                const loopBtn = bridge.state.overlay.querySelector('[data-act="loop-toggle"]');
                if (loopBtn) loopBtn.style.display = 'none';
                const favBtn = bridge.state.overlay.querySelector('[data-act="fav-toggle"]');
                if (favBtn) favBtn.style.display = 'none';
                const tagsBtn = bridge.state.overlay.querySelector('[data-act="show-tags"]');
                if (tagsBtn) tagsBtn.style.display = 'none';
                updateHdButton('hidden');
                toggleTagsPanel(false, true);
            }
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
            const hide = typeof forceHide === 'boolean' ? forceHide : el.style.display !== 'none';
            el.style.display = hide ? 'none' : 'block';
            bridge.state.overlay.classList.toggle('ms-thumbs-hidden', hide);
            if (btn) btn.classList.toggle('active', !hide);
            updateDropdownActiveStates();
        }

    function animateFlyToGrid(fromRect, src, targetCell) {
            try {
                const toRect = targetCell.getBoundingClientRect();
                if (!toRect.width || !toRect.height) return;

                const ghost = document.createElement('img');
                ghost.src = src;
                ghost.style.cssText = 'position:fixed; z-index:2147483647; object-fit:cover; border-radius:6px;'
                    + 'pointer-events:none; margin:0; will-change:transform;'
                    + 'left:' + toRect.left + 'px; top:' + toRect.top + 'px;'
                    + 'width:' + toRect.width + 'px; height:' + toRect.height + 'px;'
                    + 'transform-origin: top left;';
                const dx = fromRect.left - toRect.left;
                const dy = fromRect.top - toRect.top;
                const sx = fromRect.width / toRect.width;
                const sy = fromRect.height / toRect.height;
                ghost.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) scale(' + sx + ', ' + sy + ')';
                document.body.appendChild(ghost);
                targetCell.style.visibility = 'hidden';

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        ghost.style.transition = 'transform 200ms ease';
                        ghost.style.transform = 'none';
                    });
                });
                setTimeout(() => {
                    targetCell.style.visibility = '';
                    ghost.remove();
                }, 260);
            } catch (e) {
                try { targetCell.style.visibility = ''; } catch (e2) { }
            }
        }

    function setGridMode(on) {
            if (!bridge.state.overlay) return;
            const enable = !!on;
            if (enable === !!bridge.state.gridMode) return;

            let flyRect = null;
            let flySrc = '';
            if (enable) {
                disablePan();
                const mediaEl = bridge.state.overlay.querySelector('.ms-media-wrap img.ms-media.ms-ready, .ms-media-wrap video.ms-media');
                if (mediaEl) {
                    const r = mediaEl.getBoundingClientRect();
                    if (r.width > 2 && r.height > 2) {
                        flyRect = { left: r.left, top: r.top, width: r.width, height: r.height };
                        if (mediaEl.tagName === 'IMG') flySrc = mediaEl.currentSrc || mediaEl.src || '';
                        else flySrc = mediaEl.getAttribute('poster') || '';
                    }
                }
                if (flyRect && !flySrc) {
                    const curEntry = bridge.state.items[bridge.state.currentIndex];
                    const curItem = curEntry ? (curEntry.item || curEntry) : null;
                    if (curItem) flySrc = curItem.thumbSrc || '';
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
                renderGrid();
                const grid = bridge.state.overlay.querySelector('.ms-grid');
                const active = grid ? grid.querySelector('.ms-grid-cell.active') : null;
                if (active) active.scrollIntoView({ block: 'center', behavior: 'auto' });
                if (active && flyRect && flySrc) animateFlyToGrid(flyRect, flySrc, active);
            } else {
                bridge.state.cameFromGrid = true;
                renderThumbs();
                bridge.renderCurrent();

                if (bridge.state.tagsPanelWanted) bridge.applyTagsPanel(true);
            }
            updateButtons();
        }

    function buildGridCell(entry, index) {
            const item = entry.item || entry;
            const cell = document.createElement('button');
            cell.type = 'button';
            const hdSrc = bridge.getHdSrc(item);
            if (hdSrc) cell.setAttribute('data-hd-src', hdSrc);
            const cacheClass = (hdSrc && !bridge.state.cachedImageUrls.has(hdSrc) && !item._msMediaLoaded) ? ' ms-uncached' : '';
            cell.className = 'ms-grid-cell' + cacheClass + (index === bridge.state.currentIndex ? ' active' : '');
            cell.setAttribute('data-grid-index', index);

            const thumbSrc = item.thumbSrc || item.src;
            const isVideo = item.type === 'video' || item.type === 'iframe' || item.expectedVideo || item.xUnplayable;
            const hasPoster = !!(item.thumbSrc && item.thumbSrc !== item.src && !bridge.isPlaceholderUrl(item.thumbSrc));

            if (bridge.isPlaceholderUrl(thumbSrc) || (isVideo && !hasPoster && !bridge.canExtractMp4Poster(item, thumbSrc))) {
                cell.classList.add('ms-grid-placeholder');
                cell.appendChild(createPlaceholderIcon(isVideo));
                let domain = 'unknown';
                try {
                    if (item.src) domain = new URL(item.src).hostname.replace('www.', '');
                } catch (err) { domain = 'error'; }
                const domainSpan = document.createElement('div');
                domainSpan.className = 'ms-domain';
                domainSpan.textContent = domain;
                cell.appendChild(domainSpan);
            } else {

                const isVideoThumb = isVideo && !hasPoster &&
                    (bridge.isVideoThumbSource(thumbSrc) || !bridge.isImageThumbSource(thumbSrc));
                if (isVideoThumb) {
                    appendVideoThumbMedia(cell, item, thumbSrc, isVideo, 'ms-grid-placeholder');
                } else {
                    const img = document.createElement('img');
                    img.loading = 'lazy';
                    img.referrerPolicy = 'no-referrer';
                    img.onload = function () { img.classList.add('ms-loaded'); };
                    if (bridge.isFreezableAnimatedThumb(item)) {

                        img.src = thumbSrc;
                        bridge.freezeAnimatedThumbnail(img, item);
                    } else {
                        bridge.setCachedImgSrc(img, thumbSrc);
                    }
                    img.onerror = function () {
                        if (img.parentNode === cell && !cell.classList.contains('ms-grid-placeholder')) {
                            cell.classList.add('ms-grid-placeholder');
                            cell.innerHTML = '';
                            cell.appendChild(createPlaceholderIcon(isVideo));
                        }
                    };
                    cell.appendChild(img);
                }
            }

            if (isVideo && !bridge.isFreezableAnimatedThumb(item)) {
                const videoBadge = document.createElement('div');
                videoBadge.className = 'ms-thumb-video-icon';
                videoBadge.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="#fff"/></svg>';
                cell.appendChild(videoBadge);
            } else if (bridge.isFreezableAnimatedThumb(item)) {
                const gifBadge = document.createElement('div');
                gifBadge.className = 'ms-thumb-gif-icon';
                gifBadge.textContent = bridge.animatedThumbLabel(item);
                cell.appendChild(gifBadge);
            }

            const idxBadge = document.createElement('div');
            idxBadge.className = 'ms-grid-idx';
            idxBadge.textContent = index + 1;
            cell.appendChild(idxBadge);

            cell.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                bridge.rememberNavigationDirection(bridge.state.currentIndex, index, bridge.state.items.length);
                bridge.state.currentIndex = index;
                bridge.state.activeNode = bridge.state.items[index] ? bridge.state.items[index].node : null;
                setGridMode(false);
            });

            return cell;
        }

    function renderGrid() {
            if (!bridge.state.overlay) return;
            bridge.syncCoreItems('grid-render');
            const grid = bridge.state.overlay.querySelector('.ms-grid');
            const gridWrap = bridge.state.overlay.querySelector('.ms-grid-wrap');
            if (!grid) return;
            const loadMoreBtn = gridWrap ? gridWrap.querySelector('.ms-grid-loadmore') : null;
            if (loadMoreBtn) loadMoreBtn.textContent = 'Load more';
            syncGridWindow();
        }

    function disablePan() {
            if (bridge.state.pan && bridge.state.pan.cleanup) {
                try { bridge.state.pan.cleanup(); } catch (e) { }
            }
            bridge.state.pan = null;
            syncVerticalFitMediaBox();
            updateButtons();
            if (bridge.state.overlay) {
                const sliderWrap = bridge.state.overlay.querySelector('.ms-zoom-slider-wrap');
                if (sliderWrap) sliderWrap.classList.add('ms-zoom-idle');
            }
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
                const left = overlayEl.getBoundingClientRect().left;
                const maxW = Math.max(MIN_W, window.innerWidth - left - 220);
                const next = Math.round(Math.min(maxW, Math.max(MIN_W, e.clientX - left)));
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
                    btn.classList.toggle('active', btn.getAttribute('data-caption-mode') === bridge.captionMode);
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

    function updateMediaCaptionOverlay(item) {
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
            const host = wrap.querySelector('.ms-media-box') || wrap;
            const overlay = document.createElement('div');
            const edge = bridge.captionEdge === 'top' ? 'top' : 'bottom';
            overlay.className = 'ms-caption-overlay ms-caption-' + edge + (mode === 'snapchat' ? ' ms-caption-snapchat' : '');
            overlay.innerHTML = html;
            overlay.querySelectorAll('a').forEach((a) => {
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.addEventListener('click', (e) => e.stopPropagation());
            });
            host.appendChild(overlay);
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
            [['popup', 'Popup'], ['overlay', 'Overlay'], ['snapchat', 'Snapchat']].forEach(([mode, label]) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.setAttribute('data-caption-mode', mode);
                btn.textContent = label;
                if (bridge.captionMode === mode) btn.classList.add('active');
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    clickCaptionModeButton(mode, item);
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
                scale = 1;
            } else if (bridge.fitVertical) {

                const margin = Math.round(window.innerHeight * 0.08);
                scale = Math.min(1, (wrapH - margin) / img.naturalHeight);
            } else {
                const margin = Math.round(window.innerWidth * 0.08);
                scale = Math.min(1, (wrapW - margin) / img.naturalWidth);
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
                wrapW = wrap.clientWidth;
                wrapH = wrap.clientHeight;
                if (wrapW && wrapH) scheduleClampAndApply();
            }) : null;
            if (panResize) panResize.observe(wrap);

            const sliderWrap = bridge.state.overlay.querySelector('.ms-zoom-slider-wrap');
            const slider = bridge.state.overlay.querySelector('.ms-zoom-slider');
            if (sliderWrap && slider) {
                sliderWrap.classList.remove('ms-zoom-idle');
                const minScale = Math.min(0.05, scale * 0.1);
                const maxScale = Math.max(5.0, scale * 5.0);
                slider.min = minScale;
                slider.max = maxScale;

                slider.step = (maxScale - minScale) / 200;
                slider.value = scale;
                const valueEl = bridge.state.overlay.querySelector('.ms-zoom-value');
                if (valueEl) valueEl.textContent = Math.round(scale * 100) + '%';
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
                        slider.value = newScale;
                        const valueEl = bridge.state.overlay ? bridge.state.overlay.querySelector('.ms-zoom-value') : null;
                        if (valueEl) valueEl.textContent = Math.round(newScale * 100) + '%';
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
            if (!img.naturalWidth || !rect.width || rect.width >= img.naturalWidth) return;
            const wasFill = !!(bridge.state.pan && bridge.state.pan.active);
            const px = (e.clientX - rect.left) / rect.width;
            const py = (e.clientY - rect.top) / rect.height;
            const wrapRect = wrap.getBoundingClientRect();

            const isTallStrip = img.naturalHeight / Math.max(1, img.naturalWidth) >= 2.2;
            enablePanForImage(wrap, img, {
                zoom: true,
                initialX: (e.clientX - wrapRect.left) - px * img.naturalWidth,
                initialY: (!wasFill && isTallStrip) ? 0 : (e.clientY - wrapRect.top) - py * img.naturalHeight,
                returnToFill: wasFill
            });
        }

    function createPlaceholderIcon(isVideo) {
            return globalThis.XGalleryCore.createPlaceholderIcon(document, isVideo);
        }

    function getPastelColorForGroupId(groupId) {
            if (!groupId) return 'rgba(255, 255, 255, 0.25)';
            let hash = 0;
            for (let i = 0; i < groupId.length; i++) {
                hash = groupId.charCodeAt(i) + ((hash << 5) - hash);
            }
            const hue = Math.abs(hash % 360);
            return `hsl(${hue}, 35%, 85%)`;
        }

    function getSourceClass(item) {
            return bridge.sourcePresentationClass(item);
        }

    function promoteLazyThumbVideo(vid) {
            const url = vid && vid.dataset ? vid.dataset.msLazySrc : '';
            if (!url || vid.src) return;
            delete vid.dataset.msLazySrc;
            vid.preload = 'metadata';
            vid.src = url;
        }

    function promoteLazyMp4Poster(img) {
            if (!img || img.dataset.msMp4Started) return;
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

    function appendVideoThumbMedia(host, item, thumbSrc, isVideo, placeholderClass) {
            if (bridge.reservedPostHeader) {
                host.classList.add(placeholderClass);
                host.appendChild(createPlaceholderIcon(true));
                return;
            }
            const fail = function (el) {
                if (el.parentNode === host && !host.classList.contains(placeholderClass)) {
                    host.classList.add(placeholderClass);
                    host.innerHTML = '';
                    host.appendChild(createPlaceholderIcon(isVideo));
                }
            };
            if (item._frozenThumb) {
                const img = document.createElement('img');
                img.referrerPolicy = 'no-referrer';
                img.src = item._frozenThumb;
                img.classList.add('ms-loaded');
                img.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;display:block;background:#111;';
                host.appendChild(img);
                return;
            }
            if (bridge.isMp4ThumbUrl(item.src || thumbSrc) && bridge.msMp4Box()) {
                const img = createLazyMp4PosterImg(item, function () { fail(img); });
                host.appendChild(img);
                return;
            }
            const vid = createLazyThumbVideo(
                thumbSrc.includes('#t=') ? thumbSrc : (thumbSrc + '#t=0.1'),
                function () { fail(vid); });
            host.appendChild(vid);
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
            const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (reducedMotion || Math.abs(distance) < 1) {
                track.scrollLeft = target;
                return;
            }
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
            return String(bridge.mediaKey(item));
        }

    function resetMediaThumbEl(el) {
            if (!el) return;
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
            el.removeAttribute('data-hd-src');
            delete el.dataset.msKey;
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

    function fillThumbButton(btn, entry, index, groupCounts) {
            resetMediaThumbEl(btn);
            const item = entry.item || entry;
            const thumbSrc = item.thumbSrc || item.src;
            const hdSrc = bridge.getHdSrc(item);
            if (hdSrc) btn.setAttribute('data-hd-src', hdSrc);
            const cacheClass = (hdSrc && !bridge.state.cachedImageUrls.has(hdSrc) && !item._msMediaLoaded) ? ' ms-uncached' : '';
            const isVideo = item.type === 'video' || item.type === 'iframe' || item.expectedVideo || item.xUnplayable;
            const hasPoster = !!(item.thumbSrc && item.thumbSrc !== item.src && !bridge.isPlaceholderUrl(item.thumbSrc));
            const isPlaceholder = bridge.isPlaceholderUrl(thumbSrc) || (isVideo && !hasPoster && !bridge.canExtractMp4Poster(item, thumbSrc));
            btn.setAttribute('data-index', String(index));
            btn.dataset.msKey = thumbItemKey(entry);
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
                hdSrc: hdSrc,
                isVideo: isVideo,
                isAnimated: animated,
                animatedLabel: animated ? bridge.animatedThumbLabel(item) : '',
                isPlaceholder: isPlaceholder,
                isVideoThumb: isVideo && !hasPoster &&
                    (bridge.isVideoThumbSource(thumbSrc) || !bridge.isImageThumbSource(thumbSrc)),
                sourceUrl: item.src,
                appendVideo: (host) => appendVideoThumbMedia(host, item, thumbSrc, isVideo, 'ms-placeholder'),
                loadImage: (img) => {
                    if (animated) {
                        img.src = thumbSrc;
                        bridge.freezeAnimatedThumbnail(img, item);
                    } else {
                        bridge.setCachedImgSrc(img, thumbSrc);
                    }
                }
            });
        }

    function invalidateThumbGroupData() {
            bridge.state.thumbGroupData = null;
        }

    function thumbGroupData() {
            const cached = bridge.state.thumbGroupData;
            if (cached && cached.items === bridge.state.items && cached.length === bridge.state.items.length) return cached;
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
            bridge.state.thumbGroupData = { items: bridge.state.items, length: bridge.state.items.length, counts: counts, runs: runs };
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

    function takePoolCell(pool, used, key) {
            if (key) {
                for (let i = 0; i < pool.length; i++) {
                    if (!used.has(pool[i]) && pool[i].dataset.msKey === key) return pool[i];
                }
            }
            for (let i = 0; i < pool.length; i++) {
                if (!used.has(pool[i])) return pool[i];
            }
            return null;
        }

    function paintThumbsWindow(track, groupData) {
            const data = groupData || thumbGroupData();
            const groupCounts = data.counts;
            const n = bridge.state.items.length;
            const pad = 6;
            const start = Math.max(0, Math.floor(track.scrollLeft / bridge.MS_THUMB_STRIDE) - pad);
            const vis = Math.ceil(Math.max(track.clientWidth, 1) / bridge.MS_THUMB_STRIDE) + pad * 2;
            const end = Math.min(n, start + vis);
            const want = Math.max(0, end - start);
            if (!bridge.state.thumbsPool) bridge.state.thumbsPool = [];
            const pool = bridge.state.thumbsPool;
            const used = new Set();
            for (let index = start; index < end; index++) {
                const entry = bridge.state.items[index];
                const key = thumbItemKey(entry);
                let btn = takePoolCell(pool, used, key);
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
                    continue;
                }
                fillThumbButton(btn, entry, index, groupCounts);
            }
            for (let i = 0; i < pool.length; i++) {
                if (used.has(pool[i])) continue;
                pool[i].style.display = 'none';
                pool[i].removeAttribute('data-index');
            }
            while (pool.length > want + 8) {
                const extra = pool.pop();
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
            layer.innerHTML = '';
            if (!bridge.galleryLoadMarks.length) return;
            const start = Math.max(0, Number.isFinite(visibleStart) ? visibleStart : 0);
            const end = Math.min(n, Number.isFinite(visibleEnd) ? visibleEnd : n);
            for (let m = 0; m < bridge.galleryLoadMarks.length; m++) {
                const atSrc = bridge.galleryLoadMarks[m];
                let index = -1;
                for (let i = 0; i < n; i++) {
                    const it = bridge.state.items[i].item || bridge.state.items[i];
                    if (it && it.src === atSrc) { index = i; break; }
                }
                if (index < 1) continue;
                if (index < start || index > end) continue;
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
            layer.innerHTML = '';
            const data = groupData || thumbGroupData();
            const runs = data.runs;
            const start = Math.max(0, Number.isFinite(visibleStart) ? visibleStart : 0);
            const end = Math.min(bridge.state.items.length, Number.isFinite(visibleEnd) ? visibleEnd : bridge.state.items.length);
            let low = 0;
            let high = runs.length;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (runs[mid].end <= start) low = mid + 1;
                else high = mid;
            }
            for (let r = low; r < runs.length && runs[r].start < end; r++) {
                const run = runs[r];
                const box = document.createElement('div');
                box.className = 'ms-thumb-group-box';

                box.style.left = (run.start * bridge.MS_THUMB_STRIDE - 2) + 'px';
                box.style.width = ((run.end - run.start) * bridge.MS_THUMB_STRIDE - 2) + 'px';
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
            } else if (typeof prevIndex === 'number' && prevIndex !== bridge.state.currentIndex) {
                stopThumbTrackAnimation();
                track.scrollLeft += (bridge.state.currentIndex - prevIndex) * bridge.MS_THUMB_STRIDE;
            }
            bridge.state.thumbsPaintIndex = bridge.state.currentIndex;
            paintThumbsWindow(track, thumbGroupData());
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
            for (let index = start; index < end; index++) {
                const entry = bridge.state.items[index];
                const key = thumbItemKey(entry);
                const col = index % m.cols;
                const row = Math.floor(index / m.cols);
                let cell = takePoolCell(pool, used, key);
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
            }
            for (let i = 0; i < pool.length; i++) {
                if (used.has(pool[i])) continue;
                pool[i].style.display = 'none';
                pool[i].removeAttribute('data-grid-index');
            }
        }

    function fillGridCell(cell, entry, index) {
            resetMediaThumbEl(cell);
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
                isPlaceholder: bridge.isPlaceholderUrl(thumbSrc) ||
                    (isVideo && !hasPoster && !bridge.canExtractMp4Poster(item, thumbSrc)),
                isVideoThumb: isVideo && !hasPoster &&
                    (bridge.isVideoThumbSource(thumbSrc) || !bridge.isImageThumbSource(thumbSrc)),
                sourceUrl: item.src,
                appendVideo: (host) => appendVideoThumbMedia(host, item, thumbSrc, isVideo, 'ms-grid-placeholder'),
                loadImage: (img) => {
                    if (animated) {
                        img.src = thumbSrc;
                        bridge.freezeAnimatedThumbnail(img, item);
                    } else {
                        bridge.setCachedImgSrc(img, thumbSrc);
                    }
                },
                indexLabel: index + 1
            });
        }

    function syncGridWindow() {
            paintGridWindow();
        }

    function renderThumbs() {
            bridge.syncCoreItems('thumb-render');
            invalidateThumbGroupData();
            syncThumbsWindow();
        }

    function updateSingleThumb(index, entry) {
            if (!bridge.state.overlay) return;
            const track = bridge.state.overlay.querySelector('.ms-thumbs-track');
            if (!track) return;
            const btn = track.querySelector('[data-index="' + index + '"]');
            if (!btn) return;
            fillThumbButton(btn, entry, index, thumbsGroupCounts());
        }

    function markItemMediaLoaded(item) {
            if (!item || !bridge.state.overlay) return;
            item._msMediaLoaded = true;
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

    function renderErrorStage(container, errMsg, url, item) {
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
                    delete item.error;
                    bridge.renderCurrent();
                }
            });
        }

    function prepareMediaWrap(wrap, item) {
            return globalThis.XGalleryCore.prepareMediaSlot({
                document: document,
                wrap: wrap,
                item: item
            });
        }

    function bindGlobalGalleryHandlers() {
            if (bridge.state.keyHandler) return;

            bridge.state.keyHandler = function (e) {
                if (!bridge.state.open) return;
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

    function createOpenInGalleryButton(startNode, variant) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ms-open-in-gallery' + (variant ? ' ms-open-in-gallery--' + variant : '') +
                (variant === 'unfurl' ? ' fauxBlockLink-link' : '');
            btn.setAttribute('aria-label', 'Open in Gallery');
            btn.innerHTML = openInGalleryButtonHtml();
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
            bridge.checkTriggerInfiniteScroll();
            bridge.scheduleWindowResolution();
            disablePan();

            setTopbarLoading(false);
            bridge.state.hdUpgradeRun = null;
            updateHdButton('hidden');
            const token = ++bridge.state.renderToken;
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
            const buildInfoHtml = () => {
                const linkUrl = item ? (item.resolveUrl || item.src || '') : '';
                if (item && item.error) {
                    return `<span style="color: #f43f5e;"><a href="${linkUrl}" target="_blank" rel="noopener noreferrer">Error: ${item.error} (${linkUrl})</a></span>`;
                }

                const author = presentation.author;
                if (author && (author.name || author.handle)) {
                    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                    const avatar = author.avatarUrl
                        ? `<img class="ms-info-avatar" src="${esc(author.avatarUrl)}" referrerpolicy="no-referrer" alt="">`
                        : '';
                    const who = `<a class="ms-info-author" href="${esc(author.profileUrl || linkUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(author.handle || author.name)}">${esc(author.name || author.handle)}</a>`;
                    return `<span class="ms-info-byline">${avatar}${who}<span class="ms-info-sep">:</span>` +
                        `<a href="${esc(linkUrl)}" target="_blank" rel="noopener noreferrer">${esc(linkUrl)}</a></span>`;
                }

                if (item && item.galleryName) {
                    const escG = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                    const galleryHref = item.galleryUrl || linkUrl;
                    return `<a class="ms-info-author" href="${escG(galleryHref)}" target="_blank" rel="noopener noreferrer" title="${escG(item.galleryName)}">${escG(item.galleryName)}</a>`;
                }

                return `<span style="color: var(--ms-text-2);"><a href="${linkUrl}" target="_blank" rel="noopener noreferrer">${linkUrl}</a></span>`;
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
                    box.replaceChildren(img);
                    Array.from(wrap.children).forEach((el) => {
                        if (el !== box && !el.classList.contains('ms-caption-overlay')) el.remove();
                    });
                    syncVerticalFitMediaBox(img);
                    markItemMediaLoaded(item);
                    if (item.error) {
                        appendErrorBanner(wrap, item.error);
                    }
                    if (bridge.autoPanEnabled && !item.msNoAutoPan && shouldAutoPan(wrap, img)) {
                        enablePanForImage(wrap, img);
                    }
                    if (!bridge.state.pan) {
                        const sliderWrap = bridge.state.overlay.querySelector('.ms-zoom-slider-wrap');
                        const slider = bridge.state.overlay.querySelector('.ms-zoom-slider');
                        if (sliderWrap && slider) {
                            sliderWrap.classList.remove('ms-zoom-idle');
                            const wrapW = wrap.clientWidth;
                            const wrapH = wrap.clientHeight;
                            const fitScale = Math.min(1, Math.min(wrapW / img.naturalWidth, wrapH / img.naturalHeight));
                            const minScale = Math.min(0.05, fitScale * 0.1);
                            const maxScale = Math.max(5.0, fitScale * 5.0);
                            slider.min = minScale;
                            slider.max = maxScale;
                            slider.step = (maxScale - minScale) / 200;
                            slider.value = fitScale;
                            const valueEl = bridge.state.overlay.querySelector('.ms-zoom-value');
                            if (valueEl) valueEl.textContent = Math.round(fitScale * 100) + '%';
                        }
                    }

                    if (item.xUnplayable && item.watchUrl) {
                        const watch = document.createElement('a');
                        watch.href = item.watchUrl;
                        watch.target = '_blank';
                        watch.rel = 'noopener noreferrer';
                        watch.innerHTML = '<svg style="width:14px;height:14px;vertical-align:middle;margin-right:6px;" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>Watch video on X';
                        watch.style.cssText = 'position:absolute; bottom:24px; left:50%; transform:translateX(-50%); z-index:12; background:#1d9bf0; color:#fff; text-decoration:none; font-size:14px; font-weight:700; padding:10px 22px; border-radius:22px; box-shadow:0 4px 16px rgba(0,0,0,0.4); font-family:system-ui,-apple-system,Segoe UI,sans-serif;';
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
                tryCandidate(0, 0);
            } else if (item.type === 'video') {
                const predictedVideo = bridge.takePredictedVideo(item);
                let video = bridge.takeStageVideo(wrap, predictedVideo);
                const usedPredicted = video === predictedVideo;
                if (usedPredicted && video.error) {
                    video.removeAttribute('src');
                    try { video.load(); } catch (e) { }
                }
                const primaryVideoSrc = bridge.wrapMediaUrl(item.src);
                const bufferedVideo = bridge.requiresBufferedVideo(item);
                const videoPoster = bridge.reservedPostHeader && item.thumbSrc && item.thumbSrc !== item.src && !bridge.isPlaceholderUrl(item.thumbSrc)
                    ? item.thumbSrc : '';
                video = globalThis.XGalleryCore.configureVideoElement({
                    document: document,
                    video: video,
                    poster: videoPoster,
                    volume: bridge.globalVolume,
                    muted: bridge.globalMuted,
                    loop: bridge.globalLoop,
                    preload: usedPredicted ? '' : (bufferedVideo ? 'auto' : 'metadata')
                });

                let lastPlayTime = 0;
                let lastSeekAt = 0;
                let seekRecoveries = 0;
                const ownsVideoSession = () => token === bridge.state.renderToken && video.isConnected && wrap.contains(video);
                video.addEventListener('timeupdate', () => {
                    if (video.currentTime > 0) lastPlayTime = video.currentTime;
                });
                video.addEventListener('seeking', () => { lastSeekAt = Date.now(); });
                video.addEventListener('seeked', () => { lastSeekAt = Date.now(); });

                if (bridge.state.lastPlayTime && bridge.state.lastPlayTime > 0) {
                    const seekToTime = bridge.state.lastPlayTime;
                    bridge.state.lastPlayTime = 0;
                    const onCanPlay = () => {
                        if (!ownsVideoSession()) return;
                        video.currentTime = seekToTime;
                        video.removeEventListener('loadedmetadata', onCanPlay);
                        video.removeEventListener('canplay', onCanPlay);
                    };
                    video.addEventListener('loadedmetadata', onCanPlay);
                    video.addEventListener('canplay', onCanPlay);
                }

                if (video.readyState >= 2) markItemMediaLoaded(item);
                else video.addEventListener('loadeddata', () => {
                    if (!ownsVideoSession()) return;
                    markItemMediaLoaded(item);
                }, { once: true });

                const retrySources = [];
                if (Array.isArray(item.altSrcs)) {
                    item.altSrcs.forEach((s) => {
                        if (s && s !== item.src) retrySources.push(bridge.wrapMediaUrl(s));
                    });
                }
                if (item.fallbackSrc && item.fallbackSrc !== item.src) retrySources.push(bridge.wrapMediaUrl(item.fallbackSrc));

                let retryIndex = 0;
                video.addEventListener('error', () => {
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
                        video.addEventListener('loadedmetadata', resetForReplay, { once: true });
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
                            video.addEventListener('loadedmetadata', resume, { once: true });
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
                        if (item.embedSrc) {
                            item.src = item.embedSrc;
                            item.type = 'iframe';
                            item.needsResolve = false;
                            renderCurrent();
                            return;
                        }
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
                        video.addEventListener('loadedmetadata', onCanPlay);
                        video.addEventListener('canplay', onCanPlay);
                    }
                    const retry = video.play();
                    if (retry && typeof retry.catch === 'function') retry.catch(() => { });
                });

                video.addEventListener('volumechange', () => {
                    if (!ownsVideoSession()) return;
                    bridge.globalVolume = video.volume;
                    bridge.globalMuted = video.muted;
                    bridge.savePreference('MS_BETTER_VIDEO_VOLUME', bridge.globalVolume);
                    bridge.savePreference('MS_BETTER_VIDEO_MUTED', bridge.globalMuted);
                });
                video.addEventListener('loadedmetadata', () => {
                    if (ownsVideoSession()) syncVerticalFitMediaBox(video);
                });
                if (!video.isConnected || !video.closest('.ms-media-box')) ensureMediaBox(wrap).appendChild(video);
                const revealVideo = () => {
                    if (!ownsVideoSession()) return;
                    wrap.querySelectorAll('img.ms-media, img.ms-loading-thumb').forEach((el) => el.remove());
                    video.classList.add('ms-ready');
                    video.style.opacity = '1';
                    syncVerticalFitMediaBox(video);
                };
                if (video.readyState >= 1) revealVideo();
                else video.addEventListener('loadedmetadata', revealVideo, { once: true });
                if (!bridge.reservedPostHeader && !wrap.querySelector('img') && item.thumbSrc && !bridge.isPlaceholderUrl(item.thumbSrc)) {
                    const standIn = globalThis.XGalleryCore.createLoadingPreview({
                        document: document,
                        src: item.thumbSrc,
                        onLoad: (image) => {
                            if (image.isConnected) syncVerticalFitMediaBox(image);
                        }
                    });
                    ensureMediaBox(wrap).insertBefore(standIn, video);
                    if (standIn.complete) syncVerticalFitMediaBox(standIn);
                }
                let videoActivated = false;
                const activateVideo = () => {
                    if (videoActivated || token !== bridge.state.renderToken || !video.isConnected) return;
                    videoActivated = true;
                    video.preload = bufferedVideo ? 'auto' : 'metadata';
                    if (!video.getAttribute('src')) video.src = primaryVideoSrc;
                    const promise = video.play();
                    if (promise && typeof promise.catch === 'function') promise.catch(() => { });
                };
                video.addEventListener('pointerdown', activateVideo, { once: true });
                if ((usedPredicted || bufferedVideo) && !video.getAttribute('src')) video.src = primaryVideoSrc;
                setTimeout(activateVideo, usedPredicted || bufferedVideo ? 0 : presentation.videoDelay);
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
    function addSettingsGearButton() {
            if (document.getElementById('ms-site-settings-btn')) return;
            const gear = document.createElement('button');
            gear.id = 'ms-site-settings-btn';
            gear.className = 'ms-site-settings-btn';
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
            document.body.appendChild(gear);
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
    return { createLauncher, beginOpen, resetLayout, finishOpen, clearViewerMedia, revealHost, addSettingsGearButton, closeFavoriteMenu, positionFavoriteMenu, setFavoriteMenuStatus, addFavoriteMenuSection, openFavoriteFolders, showPostPanel, setInfoPanelVisible, isInfoPanelVisible, setTitlePanelVisible, refreshGridSize, renderTitleRow, paintTopbar, renderCurrent, paintCurrentLikeButton, paintPostActions, showStageNotice, hideStageNotice, showGalleryEndNotice, getLoadingOverlay, showLoadingOverlay, updateLoadingOverlay, hideLoadingOverlay, ensureOverlay, onOverlayClick, tagsPanelIsScrollable, onOverlayWheel, navigateFromWheel, getWheelNavigationDirection, updateDropdownActiveStates, setBtnLabel, measureRowContentWidth, topbarLayoutSignature, updateTopbarCompact, bindTopbarCompactObserver, updateButtons, updatePositionControl, commitPositionInput, bindPositionControl, ensureMediaBox, syncVerticalFitMediaBox, applyFitClass, toggleThumbs, animateFlyToGrid, setGridMode, buildGridCell, renderGrid, disablePan, applyTitleRowHeight, applyTagsFontSize, bindTitleRowResizer, bindTagsPanelResizer, toggleTagsPanel, captionHtmlFromItem, captionFitsSnapchat, setCaptionMode, clickCaptionModeButton, handleCaptionModeMessage, applyCaptionSnapInset, bindCaptionSnapDrag, updateMediaCaptionOverlay, appendCaptionModeControls, setTopbarLoading, updateHdButton, enablePanForImage, shouldAutoPan, togglePanMode, clearFullscreenIdleTimer, scheduleFullscreenIdleHide, wakeFullscreenTopbar, toggleStageFullscreen, handleImageZoomClick, createPlaceholderIcon, getPastelColorForGroupId, getSourceClass, promoteLazyThumbVideo, promoteLazyMp4Poster, observeLazyThumb, createLazyThumbVideo, createLazyMp4PosterImg, appendVideoThumbMedia, stopThumbTrackAnimation, animateThumbTrackTo, setActiveThumb, thumbStripCenterTarget, applyThumbStripCenter, thumbSourceClass, thumbItemKey, resetMediaThumbEl, onWindowedThumbClick, onWindowedGridClick, fillThumbButton, invalidateThumbGroupData, thumbGroupData, thumbsGroupCounts, ensureThumbsWindow, onThumbsWindowScroll, takePoolCell, paintThumbsWindow, paintLoadMarks, paintThumbGroupOutlines, syncThumbsWindow, gridMetrics, ensureGridWindow, onGridWindowScroll, paintGridWindow, fillGridCell, syncGridWindow, renderThumbs, updateSingleThumb, markItemMediaLoaded, enableThumbDragScroll, appendErrorBanner, renderErrorStage, prepareMediaWrap, bindGlobalGalleryHandlers, unbindGlobalGalleryHandlers, closeGallerySettings, openInGalleryButtonHtml, createOpenInGalleryButton };
    }

    root.XGalleryCore = Object.freeze({
        BRIDGE_METHODS,
        CORE_EVENTS,
        CORE_MANIFEST_URL,
        CORE_UPDATE_INTERVAL_MS,
        GalleryController,
        createViewerRuntime,
        renderPostPanel,
        createSettingsPanel,
        MEDIA_TYPES,
        XGALLERY_CORE_API_VERSION,
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
