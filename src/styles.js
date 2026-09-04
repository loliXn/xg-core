export const OVERLAY_CSS = String.raw`
        :root {
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
        .ms-gallery-overlay.ms-opening .ms-filter-bar,
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
        .ms-btn {
            border: none;
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
        }
        /* The display:inline-flex !important above exists to survive hostile
           host-page button styling, but it also beat every inline
           style.display='none' we set - so the Favorite heart, Loop and HD
           buttons were visible on sites that never support them. Re-hide via
           a higher-specificity rule that matches the inline style itself. */
        .ms-btn[style*="display:none"],
        .ms-btn[style*="display: none"],
        .ms-icon-btn[style*="display:none"],
        .ms-icon-btn[style*="display: none"] {
            display: none !important;
        }
        .ms-btn:hover {
            background: var(--ms-hover);
            color: var(--ms-text);
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
            top: 64px;
            left: 50%;
            transform: translateX(-50%);
            width: calc(100% - 40px);
            max-width: 1100px;
            z-index: 90;
            box-sizing: border-box;
            padding: 14px 16px;
            border: 1px solid var(--ms-line);
            border-radius: 16px;
            background: hsla(220, 7%, 10%, 0.94);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            box-shadow: var(--ms-shadow-md);
            display: flex;
            flex-direction: column;
            gap: 12px;
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
            display: none;
            grid-template-columns: 1fr;
            gap: 14px;
            padding-top: 12px;
            border-top: 1px solid var(--ms-hairline);
        }
        .ms-filter-extras-open .ms-filter-extras {
            display: grid;
        }
        @media (min-width: 900px) {
            .ms-filter-extras-open .ms-filter-extras {
                grid-template-columns: 1.4fr 1fr 1fr;
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
        body.ms-host-isolation > :not(.ms-gallery-overlay):not(#ms-site-gallery-btn):not(#ms-site-settings-btn):not(#ms-site-redirect-btn),
        body.ms-reddit-isolation > :not(.ms-gallery-overlay):not(#ms-site-gallery-btn):not(#ms-site-settings-btn):not(#ms-site-redirect-btn) {
            visibility: hidden !important;
            pointer-events: none !important;
            contain: layout paint style;
            content-visibility: hidden;
        }
        body.ms-host-isolation-layout > :not(.ms-gallery-overlay):not(#ms-site-gallery-btn):not(#ms-site-settings-btn):not(#ms-site-redirect-btn),
        body.ms-bdsmlr-isolation > :not(.ms-gallery-overlay):not(#ms-site-gallery-btn):not(#ms-site-settings-btn):not(#ms-site-redirect-btn) {
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

        .ms-gallery-overlay.ms-old-reddit .ms-btn,
        .ms-gallery-overlay.ms-old-reddit .ms-icon-btn {
            border: 1px solid var(--ms-line) !important;
        }

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
        .ms-btn.active {
            color: var(--ms-accent);
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
        .ms-tags-like-btn svg,
        .ms-tags-hide-btn svg,
        .adv-hide-btn-list svg {
            width: 15px;
            height: 15px;
            stroke: currentColor;
            fill: none;
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
    `;

export function installOverlayStyles(addStyle) {
    if (typeof addStyle !== 'function') throw new TypeError('addStyle must be a function');
    return addStyle(OVERLAY_CSS);
}
