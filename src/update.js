const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA_RE = /^[a-f0-9]{64}$/;

export const CORE_MANIFEST_URL = 'https://github.com/loliXn/xg-core/releases/latest/download/latest.json';
export const CORE_UPDATE_INTERVAL_MS = 0; // check GitHub latest.json on every load

export function parseCoreManifest(data) {
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

export function compareCoreVersions(a, b) {
    const pa = String(a || '').split('.').map((part) => parseInt(part, 10) || 0);
    const pb = String(b || '').split('.').map((part) => parseInt(part, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if (pa[i] > pb[i]) return 1;
        if (pa[i] < pb[i]) return -1;
    }
    return 0;
}

export function isTrustedCoreUrl(url) {
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

export function bytesToSha256Hex(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
}

export async function sha256Hex(source) {
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

export function shouldInstallCore(currentVersion, nextVersion) {
    return compareCoreVersions(nextVersion, currentVersion) > 0;
}

export function verifiedCoreRecord(manifest, code, sha256) {
    if (!manifest || manifest.sha256 !== sha256) return null;
    if (typeof code !== 'string' || !code.includes('XGalleryCore')) return null;
    return {
        version: manifest.version,
        url: manifest.url,
        sha256: sha256,
        code: code
    };
}
