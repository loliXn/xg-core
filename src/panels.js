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

export function renderPostPanel(options) {
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

export function createSettingsPanel(options) {
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
