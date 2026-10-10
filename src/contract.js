export const XGALLERY_CORE_API_VERSION = 1;
export const XGALLERY_CORE_VERSION = '0.13.0';

export const MEDIA_TYPES = Object.freeze([
    'img',
    'video',
    'iframe',
    'album'
]);

const MEDIA_TYPE_SET = new Set(MEDIA_TYPES);

export function validateMediaItem(item) {
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
    if (item.resourceRef != null && (!item.resourceRef || typeof item.resourceRef !== 'object'
        || typeof item.resourceRef.archiveKey !== 'string' || !item.resourceRef.archiveKey
        || typeof item.resourceRef.entryId !== 'string' || !item.resourceRef.entryId)) {
        errors.push('resourceRef requires archiveKey and entryId');
    }
    if (/^xg-archive:/i.test(item.src || '') && !item.resourceRef) {
        errors.push('archive sources require a managed resource reference');
    }
    return errors;
}

export function normalizeMediaItem(item) {
    const errors = validateMediaItem(item);
    if (errors.length) throw new TypeError(errors.join('; '));
    return {
        ...item,
        id: item.id.trim(),
        src: item.src.trim(),
        thumbSrc: String(item.thumbSrc || item.src).trim()
    };
}
