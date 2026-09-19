/**
 * What a video's thumbnail should be, decided in one place.
 *
 * This used to be a ladder of ifs inside the painting code, and every adapter
 * met a slightly different rung of it. Two things went wrong there and both
 * were visible:
 *
 *   - a cell could end up with a real <video> element, which costs a decoder
 *     and a connection per thumbnail and, when the item's own file was the
 *     preview, fetched the very file the stage was streaming;
 *   - a cell could end up with the original animated GIF in an <img>, playing,
 *     because the freeze pipeline had a timeout that fell back to the raw URL.
 *
 * So the rule is now stated rather than implied: **a thumbnail is one still
 * frame.** Five outcomes, in order of what they cost:
 *
 *   frozen      - a frame we already extracted for this item; free.
 *   still       - a poster image the site gave us; one cheap image request.
 *   freeze      - a poster that may itself animate, so it goes through the
 *                 inspect-and-freeze path and is painted as a single frame.
 *   extract     - no poster at all: pull the first frame out of the file.
 *   placeholder - nothing is available, or extraction is not possible here.
 *
 * `video` is a sixth outcome that an adapter has to ask for explicitly, for a
 * host that has no poster and no extractable container. Nothing opts in today.
 */

export const THUMB_PLANS = Object.freeze(['frozen', 'still', 'freeze', 'extract', 'video', 'placeholder']);

/**
 * @param {object} input
 * @param {string} [input.frozen] a frame already extracted for this item.
 * @param {string} [input.thumbSrc] the thumbnail URL the painter was handed.
 * @param {string} [input.itemThumbSrc] the item's own thumbnail URL.
 * @param {string} [input.src] the media's URL.
 * @param {function} input.isPlaceholderUrl
 * @param {function} input.isImageUrl an image URL, by the adapter's rules.
 * @param {function} [input.mayAnimate] the URL could be an animated image.
 * @param {function} [input.canExtract] a first frame can be pulled from this item.
 * @param {boolean} [input.allowVideoElement] adapter opt-in, off by default.
 * @param {boolean} [input.preferExtract] extraction beats a poster here.
 * @returns {{kind: string, url: string}}
 */
export function planVideoThumb(input) {
    const spec = input || {};
    const isPlaceholderUrl = spec.isPlaceholderUrl || (() => false);
    const isImageUrl = spec.isImageUrl || (() => false);
    const mayAnimate = spec.mayAnimate || (() => false);
    const canExtract = typeof spec.canExtract === 'function' ? spec.canExtract : () => !!spec.canExtract;

    if (spec.frozen) return { kind: 'frozen', url: String(spec.frozen) };

    const posterCandidates = [spec.thumbSrc, spec.itemThumbSrc];
    let poster = '';
    for (let i = 0; i < posterCandidates.length; i++) {
        const candidate = String(posterCandidates[i] || '');
        if (!candidate) continue;
        if (isPlaceholderUrl(candidate)) continue;
        // Only an image can be a poster. That is also what keeps a cell from
        // pointing at the media file itself, which is how a thumbnail ended up
        // streaming the very thing the stage was streaming, twice over the
        // same host budget - while a still, or a GIF standing in for a video,
        // is legitimately its own poster and still gets frozen below.
        if (!isImageUrl(candidate) && !/^data:image\//i.test(candidate)) continue;
        poster = candidate;
        break;
    }

    // A feed whose posters are known to be worse than the real first frame
    // (a blurred or letterboxed placeholder) can ask for extraction first.
    if (poster && !(spec.preferExtract && canExtract())) {
        return { kind: mayAnimate(poster) ? 'freeze' : 'still', url: poster };
    }
    if (canExtract()) return { kind: 'extract', url: String(spec.src || '') };
    if (spec.allowVideoElement === true) {
        const playable = String(spec.src || spec.thumbSrc || '');
        if (playable && !isPlaceholderUrl(playable)) return { kind: 'video', url: playable };
    }
    return { kind: 'placeholder', url: '' };
}
