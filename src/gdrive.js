// Reading a public Google Drive folder, for adapters that meet Drive links in
// someone else's page. Drive serves a plain HTML listing for embedding at
// /embeddedfolderview, which needs no API key and carries the signed-in
// session when the folder is private. Nothing here fetches: the caller passes
// a request function, because a userscript's own request is the one that
// escapes the page's cross-origin rules.
const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;
export const GOOGLE_DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

function driveUrl(value) {
    try {
        const parsed = new URL(String(value || ''), 'https://drive.google.com/');
        return /^(?:drive|docs)\.google\.com$/i.test(parsed.hostname)
            || /^drive\.usercontent\.google\.com$/i.test(parsed.hostname) ? parsed : null;
    } catch (e) {
        return null;
    }
}

export function googleDriveFolderId(value) {
    const parsed = driveUrl(value);
    if (!parsed || !/^drive\.google\.com$/i.test(parsed.hostname)) return '';
    const path = parsed.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)/i);
    if (path && DRIVE_ID.test(path[1])) return path[1];
    if (/^\/(?:embedded)?folderview$/i.test(parsed.pathname)) {
        const id = parsed.searchParams.get('id') || '';
        return DRIVE_ID.test(id) ? id : '';
    }
    return '';
}

export function googleDriveFileId(value) {
    const parsed = driveUrl(value);
    if (!parsed) return '';
    const path = parsed.pathname.match(/^\/(?:a\/[^/]+\/)?file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/i);
    if (path && DRIVE_ID.test(path[1])) return path[1];
    if (/^\/(?:open|uc|download|thumbnail)$/i.test(parsed.pathname)) {
        const id = parsed.searchParams.get('id') || '';
        return DRIVE_ID.test(id) ? id : '';
    }
    return '';
}

export function googleDriveListingUrl(folderId, resourceKey) {
    return 'https://drive.google.com/embeddedfolderview?id=' + encodeURIComponent(folderId)
        + (resourceKey ? '&resourcekey=' + encodeURIComponent(resourceKey) : '');
}

// Images: the thumbnail endpoint at size s0 redirects to the untouched
// original, signed for the current session. GIFs and videos go through the
// download endpoint - a GIF keeps its animation there, and video answers range
// requests (confirm=t skips the "can't scan this for viruses" page).
export function googleDriveFileUrls(id, options) {
    const kind = (options && options.kind) || 'image';
    const thumb = 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w400';
    if (kind === 'video') {
        return { src: 'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(id) + '&export=download&confirm=t', thumb: thumb };
    }
    if (kind === 'gif') {
        return { src: 'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(id) + '&export=view', thumb: thumb };
    }
    if (kind === 'file') {
        return { src: 'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(id) + '&export=download&confirm=t', thumb: '' };
    }
    return { src: 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=s0', thumb: thumb };
}

export function parseGoogleDriveFolderListing(html, doc) {
    const parser = doc || (typeof document !== 'undefined' ? document : null);
    if (!parser) return { title: '', entries: [] };
    const parsed = new (parser.defaultView || window).DOMParser().parseFromString(String(html || ''), 'text/html');
    const title = String((parsed.querySelector('title') || {}).textContent || '')
        .replace(/\s*[-–]\s*Google Drive\s*$/i, '').trim();
    const entries = Array.from(parsed.querySelectorAll('.flip-entry[id^="entry-"]')).map((entry) => {
        const id = entry.id.replace(/^entry-/, '');
        const link = entry.querySelector('a[href]');
        const href = link ? String(link.getAttribute('href') || '') : '';
        const icon = entry.querySelector('.flip-entry-list-icon img, .flip-entry-icon img');
        const iconMime = icon ? (String(icon.getAttribute('src') || '').match(/\/type\/(.+)$/) || [])[1] || '' : '';
        const folder = /\/drive\/(?:u\/\d+\/)?folders\//i.test(href) || iconMime === GOOGLE_DRIVE_FOLDER_MIME;
        return {
            id: id,
            name: String((entry.querySelector('.flip-entry-title') || {}).textContent || '').trim(),
            mime: folder ? GOOGLE_DRIVE_FOLDER_MIME : decodeURIComponent(iconMime),
            folder: folder
        };
    }).filter((entry) => DRIVE_ID.test(entry.id));
    return { title: title, entries: entries };
}

// Walks a folder and its subfolders, in listing order. `request(url)` returns
// the listing HTML (or rejects). Every entry comes back typed, so the caller
// decides what belongs in a gallery and what is just a file.
export async function readGoogleDriveFolder(request, folderUrl, options) {
    const rootId = googleDriveFolderId(folderUrl);
    if (!rootId || typeof request !== 'function') return { name: '', files: [] };
    const settings = options || {};
    const maxDepth = Number.isFinite(settings.maxDepth) ? settings.maxDepth : 3;
    const maxFolders = Number.isFinite(settings.maxFolders) ? settings.maxFolders : 25;
    const visited = new Set();
    let name = '';

    const walk = async (folderId, depth, path, resourceKey) => {
        if (depth > maxDepth || visited.size >= maxFolders || visited.has(folderId)) return [];
        visited.add(folderId);
        const listing = parseGoogleDriveFolderListing(await request(googleDriveListingUrl(folderId, resourceKey)), settings.document);
        if (!name) name = listing.title;
        const files = [];
        for (const entry of listing.entries) {
            if (entry.folder) {
                files.push(...await walk(entry.id, depth + 1, path.concat(entry.name).filter(Boolean), ''));
                continue;
            }
            files.push({
                id: entry.id,
                name: entry.name,
                mime: entry.mime,
                folder: path.join(' / '),
                viewUrl: 'https://drive.google.com/file/d/' + entry.id + '/view'
            });
        }
        return files;
    };

    try {
        const files = await walk(rootId, 0, [], settings.resourceKey || '');
        return { id: rootId, name: name, files: files };
    } catch (error) {
        return { id: rootId, name: name, files: [], error: (error && error.message) || 'failed' };
    }
}
