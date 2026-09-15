import { OVERLAY_CSS } from './styles.js';
import { HEART_ICON } from './view.js';

// Mount hidden but fully laid out, then drop the class on the next frame so
// the transition runs. Toggling straight out of display:none cannot animate.
export function revealOnNextFrame(el, className) {
    if (!el || !className) return;
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    if (view && view.matchMedia && view.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.classList.add(className);
    // Reading layout commits the hidden starting style, so removing the class
    // afterwards transitions whether that happens on a frame or a timer.
    void el.offsetWidth;
    let done = false;
    const reveal = () => {
        if (done) return;
        done = true;
        el.classList.remove(className);
    };
    // requestAnimationFrame is paused in background tabs and undrawn views;
    // content must never be left invisible waiting for a frame.
    if (view && view.requestAnimationFrame) view.requestAnimationFrame(reveal);
    setTimeout(reveal, 50);
}

// Rapid navigation (held arrow keys) re-renders the panel faster than a fade
// can finish; fading each step would read as flicker, so only settled
// changes animate.
const POST_ENTER_MIN_GAP_MS = 180;

const REPOST_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>';

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
            if (/^on/i.test(attr.name) || attr.name === 'style' || attr.name === 'id') el.removeAttribute(attr.name);
        });
        if (el.hasAttribute('class')) {
            const owned = Array.from(el.classList).filter(name => name.startsWith('ms-'));
            if (owned.length) el.className = owned.join(' ');
            else el.removeAttribute('class');
        }
    });
    panelLinks(node);
    return node;
}

export function renderPostPanel(options) {
    const { content, model } = options;
    const doc = content.ownerDocument;
    const previousScrollTop = options.preserveState ? content.scrollTop : 0;
    const wasLoading = content.dataset.msPostLoading === '1';
    const isLoading = !!model.loading;
    const now = Date.now();
    const lastRender = Number(content.dataset.msPostRenderedAt || 0);
    content.dataset.msPostLoading = isLoading ? '1' : '';
    content.dataset.msPostRenderedAt = String(now);
    content.replaceChildren();
    const panel = panelElement(doc, 'div', 'ms-post-panel');
    const body = panelElement(doc, 'div', 'ms-post-body');
    content.append(panel);
    panel.append(body);
    // One link covers avatar and name, so both react together, both open the
    // profile, and it is a single tab stop. A user without a profile URL gets
    // no link at all and does not react.
    const user = (data, small = false) => {
        const row = panelElement(doc, small ? 'span' : 'div', 'ms-info-user' + (small ? ' ms-info-user-sm' : ''));
        const target = data.profileUrl ? panelElement(doc, 'a', 'ms-info-user-link') : row;
        if (data.profileUrl) { target.href = data.profileUrl; row.append(target); }
        if (data.avatarUrl) {
            const avatar = panelElement(doc, 'img', 'ms-info-desc-avatar');
            avatar.src = data.avatarUrl;
            avatar.alt = '';
            avatar.referrerPolicy = 'no-referrer';
            target.append(avatar);
        }
        target.append(panelElement(doc, 'span', 'ms-info-desc-username', data.username || data.name || '\u00a0'));
        panelLinks(row);
        return row;
    };
    const info = model.postInfo || {};
    if (info.author || model.reserveHeader) {
        // Read like a message header: who, when, and where it came from.
        const head = panelElement(doc, 'div', 'ms-info-posthead');
        const byline = panelElement(doc, 'div', 'ms-post-byline');
        byline.append(user(info.author || {}));
        const date = panelElement(doc, 'span', 'ms-info-postmeta', info.time || (model.reserveHeader ? '\u00a0' : ''));
        if (info.time) date.title = info.time;
        byline.append(date);
        head.append(byline);
        if (info.repostedFrom) {
            const repost = panelElement(doc, 'div', 'ms-post-repost');
            const icon = panelElement(doc, 'span', 'ms-post-repost-icon');
            icon.innerHTML = REPOST_ICON;
            repost.append(icon, panelElement(doc, 'span', 'ms-post-repost-label', 'reposted from'), user(info.repostedFrom, true));
            head.append(repost);
        }
        panel.insertBefore(head, body);
    }
    const captions = Array.isArray(info.captions) && info.captions.length ? info.captions : [{ html: model.description }];
    const caption = panelElement(doc, 'div', 'ms-panel-caption');
    captions.forEach(cap => {
        if (!cap.html) return;
        const card = panelHtml(doc, cap.html, 'ms-info-description');
        if (cap.user && !(captions.length === 1 && info.author && cap.user.username === info.author.username)) {
            card.classList.add('ms-info-description-attributed');
            card.prepend(user(cap.user, true));
        }
        caption.append(card);
    });
    if (caption.childNodes.length) body.append(caption);
    const appendTags = (label, tags, profileUrl = '') => {
        if (!tags || !tags.length) return;
        const tagsSection = panelElement(doc, 'section', 'ms-post-section ms-post-tags');
        const heading = panelElement(doc, 'div', 'ms-info-tags-label');
        if (profileUrl) {
            const owner = panelElement(doc, 'a', 'ms-tag-group-owner', label);
            owner.href = profileUrl;
            heading.append(owner, doc.createTextNode(' tags'));
            panelLinks(heading);
        } else heading.textContent = label;
        tagsSection.append(heading);
        const pills = panelElement(doc, 'div', 'ms-tag-pills');
        tags.forEach((tag, index) => {
            const link = panelElement(doc, 'a', 'ms-tag-pill', '#' + tag.label);
            if (index >= 18) {
                link.classList.add('ms-tag-overflow');
                link.hidden = true;
            }
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
        if (tags.length > 18) {
            const more = panelElement(doc, 'button', 'ms-tag-more', '+' + (tags.length - 18) + ' more');
            more.type = 'button';
            more.setAttribute('aria-expanded', 'false');
            more.addEventListener('click', event => {
                event.stopPropagation();
                const expanded = more.getAttribute('aria-expanded') === 'true';
                pills.querySelectorAll('.ms-tag-overflow').forEach(tag => { tag.hidden = expanded; });
                more.setAttribute('aria-expanded', String(!expanded));
                more.textContent = expanded ? '+' + (tags.length - 18) + ' more' : 'Show less';
            });
            pills.append(more);
        }
        tagsSection.append(pills);
        body.append(tagsSection);
    };
    if (model.tagGroups && model.tagGroups.length) {
        model.tagGroups.forEach(group => appendTags(group.owner || 'Tags', group.tags, group.profileUrl));
    } else if (model.tags && model.tags.length) {
        appendTags('Tags', model.tags);
    }
    const context = panelElement(doc, 'div', 'ms-post-context');
    if (info.originalPost && info.originalPost.username) {
        const original = panelElement(doc, 'div', 'ms-info-original', 'Originally posted by ');
        original.append(user({ ...info.originalPost, profileUrl: info.originalPost.url }, true));
        context.append(original);
    }
    if (info.stats) {
        const stats = panelElement(doc, 'div', 'ms-info-stats');
        for (const [key, label] of [['views', 'views'], ['reposts', 'reposts']]) {
            if (!info.stats[key]) continue;
            const stat = panelElement(doc, 'span', 'ms-info-stat');
            stat.append(panelElement(doc, 'b', '', info.stats[key]), doc.createTextNode(' ' + label));
            stats.append(stat);
        }
        if (stats.childNodes.length) context.append(stats);
    }
    if (context.childNodes.length) body.append(context);
    const footer = panelElement(doc, 'div', 'ms-post-footer');
    if (model.actions && model.actions.length) {
        const actions = panelElement(doc, 'div', 'ms-tags-actions-bar');
        model.actions.forEach(action => {
            const button = panelElement(doc, action.href ? 'a' : 'button', 'ms-tags-action-btn ms-tags-' + action.kind + '-btn');
            if (!action.href) button.type = 'button';
            else { button.href = action.href; button.target = '_blank'; button.rel = 'noopener noreferrer'; }
            if (action.kind === 'like') {
                const icon = panelElement(doc, 'span', 'ms-tags-action-icon');
                icon.innerHTML = HEART_ICON;
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
        footer.append(actions);
    }
    if (options.captionControls) {
        const modes = panelElement(doc, 'div', 'ms-caption-footer');
        modes.setAttribute('role', 'group');
        modes.setAttribute('aria-label', 'Caption display');
        modes.append(panelElement(doc, 'span', 'ms-caption-mode-label', 'Caption'));
        options.captionControls(modes);
        if (modes.childNodes.length > 1) footer.append(modes);
    }
    if (footer.childNodes.length) panel.append(footer);
    if (!body.childNodes.length && isLoading) {
        // Details are still on their way: hold the space with a quiet
        // placeholder instead of claiming there is nothing to show.
        const skeleton = panelElement(doc, 'div', 'ms-post-skeleton');
        skeleton.setAttribute('aria-label', 'Loading post details');
        skeleton.setAttribute('role', 'status');
        ['ms-skel-line ms-skel-wide', 'ms-skel-line', 'ms-skel-line ms-skel-short', 'ms-skel-chips'].forEach(cls => skeleton.append(panelElement(doc, 'span', cls)));
        body.append(skeleton);
    } else if (!body.childNodes.length) {
        body.append(panelElement(doc, 'div', 'ms-info-empty', 'No description or tags available.'));
    }
    // Resolution and size of what is on screen. Filled in by the runtime once the
    // media has decoded; the row keeps its height while empty so nothing moves.
    if (model.mediaMeta) {
        const meta = panelElement(doc, 'div', 'ms-info-meta ms-post-media-meta');
        meta.append(panelElement(doc, 'span', 'ms-info-dims'), panelElement(doc, 'span', 'ms-info-bytes'));
        body.append(meta);
    }
    // A different post, or the same post's details arriving: settle the body in.
    // The header and footer stay put so nothing around the text jumps.
    const arrived = options.preserveState && wasLoading && !isLoading;
    const newPost = !options.preserveState && now - lastRender > POST_ENTER_MIN_GAP_MS;
    if (arrived || newPost) revealOnNextFrame(body, 'ms-post-entering');
    if (options.preserveState) requestAnimationFrame(() => {
        if (content.isConnected) content.scrollTop = previousScrollTop;
    });
    else content.scrollTop = 0;
}

export function createSettingsPanel(options) {
    const doc = options.document || document;
    if (doc.getElementById('ms-settings-root')) return null;
    const previousFocus = doc.activeElement;
    const host = doc.createElement('xgallery-settings');
    host.id = 'ms-settings-root';
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;visibility:visible!important;pointer-events:auto!important;';
    const shadow = host.attachShadow({mode:'open'});
    const sheet = doc.createElement('style');
    // Same reason as the gallery overlay's sheet (see view.js): Dark Reader
    // rewrites stylesheets inside open shadow roots and turns our white-alpha
    // hairlines dark, and its style manager skips any sheet carrying this
    // class. Shadow sheets only - it removes .darkreader nodes from the light
    // DOM when it is switched off, and does not search shadow roots.
    sheet.className = 'darkreader';
    sheet.textContent = OVERLAY_CSS;
    shadow.append(sheet);
    const overlay = panelElement(doc, 'div', 'ms-r34-settings-overlay');
    overlay.id = 'ms-r34-settings-overlay';
    const modal = panelElement(doc, 'div', 'ms-r34-settings-modal');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    const heading = panelElement(doc, 'div', 'ms-settings-head');
    heading.append(panelElement(doc, 'h3', '', 'Gallery Settings'));
    const close = panelElement(doc, 'button', 'ms-settings-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close');
    heading.append(close); modal.append(heading);
    const body = panelElement(doc, 'div', 'ms-settings-body');
    const tabs = panelElement(doc, 'div', 'ms-settings-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Settings category');
    const names = [...new Set(options.sections.map(section => section.tab || 'General'))];
    const groups = new Map();
    // The tab key is the caller's string, but a bare hostname is a poor label;
    // www. adds nothing the user needs to read.
    const tabLabel = (name) => String(name).replace(/^www\./i, '');
    names.forEach((name, index) => {
        const tab = panelElement(doc, 'button', 'ms-settings-tab', tabLabel(name));
        tab.type = 'button'; tab.setAttribute('role', 'tab');
        tab.id = 'ms-settings-tab-' + index;
        tab.setAttribute('aria-controls', 'ms-settings-page-' + index);
        const group = panelElement(doc, 'div', 'ms-settings-page');
        group.id = 'ms-settings-page-' + index;
        group.setAttribute('role', 'tabpanel'); group.setAttribute('aria-labelledby', tab.id);
        group.hidden = index !== 0;
        tab.tabIndex = index ? -1 : 0; tab.setAttribute('aria-selected', String(!index));
        tab.addEventListener('click', () => {
            groups.forEach(({tab: other, group: pane}, key) => {
                pane.hidden = key !== name; other.tabIndex = key === name ? 0 : -1;
                other.setAttribute('aria-selected', String(key === name));
            });
        });
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? names.length - 1 :
                (index + (event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length;
            const target = groups.get(names[next]).tab; target.click(); target.focus();
        });
        groups.set(name, {tab, group}); tabs.append(tab); body.append(group);
    });
    modal.append(tabs);
    const controls = new Map();
    options.sections.forEach(section => {
        const sectionBody = groups.get(section.tab || 'General').group;
        sectionBody.append(panelElement(doc, 'div', 'ms-settings-section-group', section.label));
        const card = panelElement(doc, 'div', 'ms-settings-card');
        section.fields.forEach(field => {
            const row = panelElement(doc, 'div', 'ms-settings-row' + (field.type === 'textarea' ? ' ms-settings-stack' : ''));
            const label = panelElement(doc, 'label', 'ms-settings-label', field.label);
            let note = null;
            if (field.note) {
                note = panelElement(doc, 'small', '', field.note);
                label.append(doc.createElement('br'), note);
            }
            row.append(label);
            let input;
            if (field.type === 'button') {
                input = panelElement(doc, 'button', '', field.buttonLabel || field.label); input.type = 'button';
                input.addEventListener('click', async () => {
                    input.disabled = true;
                    input.classList.remove('is-success', 'is-error');
                    input.classList.add('is-busy');
                    const original = input.textContent;
                    input.textContent = field.busyLabel || 'Working…';
                    try {
                        const result = await field.run();
                        if (result && typeof result === 'object') {
                            input.textContent = result.buttonLabel || original;
                            if (note && result.note) note.textContent = result.note;
                            input.classList.add(result.ok === false ? 'is-error' : 'is-success');
                        } else if (result) {
                            input.textContent = result;
                            input.classList.add('is-success');
                        } else input.textContent = original;
                    }
                    catch {
                        input.textContent = 'Try again';
                        input.classList.add('is-error');
                    }
                    finally { input.disabled = false; input.classList.remove('is-busy'); }
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
        sectionBody.append(card);
    });
    modal.append(body);
    const footer = panelElement(doc, 'div', 'ms-r34-btn-row');
    const cancel = panelElement(doc, 'button', 'ms-r34-cancel', 'Cancel');
    const save = panelElement(doc, 'button', 'ms-r34-save', 'Save');
    cancel.type = save.type = 'button'; footer.append(cancel, save); modal.append(footer); overlay.append(modal);
    const dismiss = () => {
        host.remove();
        if (previousFocus && previousFocus.isConnected) previousFocus.focus({preventScroll:true});
        if (options.onClose) options.onClose(overlay);
    };
    close.addEventListener('click', dismiss); cancel.addEventListener('click', dismiss);
    overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(); });
    overlay.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
        if (e.key === 'Tab') {
            const targets = Array.from(modal.querySelectorAll('button,input,select,textarea,a[href]')).filter(el => !el.disabled && el.getClientRects().length);
            const first = targets[0], last = targets[targets.length-1];
            if (e.shiftKey && shadow.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && shadow.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });
    save.addEventListener('click', () => {
        const values = {};
        controls.forEach(({input,field}, id) => { if (field.type !== 'button') values[id] = field.type === 'checkbox' ? input.checked : input.value; });
        options.onSave(values); dismiss();
    });
    shadow.append(overlay);
    doc.body.append(host);
    // Every page gets the height of the tallest one, so switching tabs cannot
    // resize the dialog. Measured after the host is in the document, because
    // a detached subtree has no layout; done synchronously rather than on a
    // frame, since a settings panel opened from a click is always foreground
    // and a resize one frame later would be visible.
    try {
        let tallest = 0;
        groups.forEach(({group}) => {
            const wasHidden = group.hidden;
            if (wasHidden) group.hidden = false;
            tallest = Math.max(tallest, group.scrollHeight);
            if (wasHidden) group.hidden = true;
        });
        if (tallest > 0) {
            groups.forEach(({group}) => { group.style.minHeight = tallest + 'px'; });
        }
    } catch (error) { }
    requestAnimationFrame(() => { overlay.classList.add('ms-settings-open'); close.focus(); });
    return overlay;
}
