// Range transport and authentication belong to the adapter. This module only
// demuxes MP4 bytes into bounded MediaSource buffers for the active player.
export function createMp4RangePlayback(options) {
    const { video, parserFactory, readRange, signal } = options;
    if (!globalThis.MediaSource || !parserFactory || !video || signal?.aborted) return null;
    const mediaSource = new MediaSource();
    const src = URL.createObjectURL(mediaSource);
    const controller = new AbortController();
    const parser = parserFactory();
    const tracks = new Map();
    const chunkSize = 1024 * 1024;
    const startupChunkSize = 128 * 1024;
    let disposed = false, failed = false, pendingSeek = null, total = 0;
    let receivedRanges = [];
    let parsingReady = false;
    const abortError = () => new DOMException('Playback cancelled', 'AbortError');
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        controller.abort();
        parser.stop();
        video.removeEventListener('seeking', seeking);
        signal?.removeEventListener('abort', dispose);
        mediaSource.removeEventListener('sourceopen', open);
        tracks.forEach(track => { try { if (track.buffer.updating) track.buffer.abort(); } catch (_) {} });
        URL.revokeObjectURL(src);
    };
    const fail = error => {
        if (disposed || failed) return;
        failed = true;
        dispose();
        options.onError?.(error instanceof Error ? error.message : String(error));
    };
    const wait = ms => new Promise(resolve => {
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, ms);
        controller.signal.addEventListener('abort', done, { once: true });
        if (disposed) done();
    });
    const buffered = time => {
        for (let i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= time + 0.1 && video.buffered.end(i) > time) return video.buffered.end(i) - time;
        }
        return 0;
    };
    function seeking() {
        if (!disposed && !buffered(video.currentTime)) pendingSeek = video.currentTime;
    }
    const update = (buffer, action) => new Promise((resolve, reject) => {
        if (disposed) { reject(abortError()); return; }
        const finish = error => {
            buffer.removeEventListener('updateend', done);
            buffer.removeEventListener('error', bad);
            controller.signal.removeEventListener('abort', cancel);
            error ? reject(error) : resolve();
        };
        const done = () => finish();
        const bad = () => finish(new Error('Could not decode video segment'));
        const cancel = () => finish(abortError());
        buffer.addEventListener('updateend', done, { once: true });
        buffer.addEventListener('error', bad, { once: true });
        controller.signal.addEventListener('abort', cancel, { once: true });
        try { action(); } catch (error) { finish(error); }
    });
    const enqueue = (track, buffer, sampleNumber) => {
        track.pending = track.pending.then(async () => {
            if (disposed) throw abortError();
            // Prune before appending to keep long videos from filling the MSE quota.
            const cut = video.currentTime - 20;
            if (cut > 0 && track.buffer.buffered.length && track.buffer.buffered.start(0) < cut - 5) {
                await update(track.buffer, () => track.buffer.remove(0, cut));
            }
            await update(track.buffer, () => track.buffer.appendBuffer(buffer));
            if (sampleNumber !== undefined) parser.releaseUsedSamples(track.id, sampleNumber);
        });
        track.pending.catch(fail);
    };
    const drain = () => Promise.all([...tracks.values()].map(track => track.pending));
    const read = async offset => {
        // A GM range resolves only once its entire payload arrives. Give the
        // parser small initial reads, then grow requests after playback starts.
        const size = video.readyState >= 2 ? chunkSize : startupChunkSize;
        const result = await readRange(offset, total ? Math.min(total - 1, offset + size - 1) : offset + size - 1, controller.signal);
        if (disposed) throw abortError();
        if (Object.prototype.toString.call(result.buffer) !== '[object ArrayBuffer]' || !result.buffer.byteLength || result.start !== offset) {
            throw new Error('The server returned an invalid video range');
        }
        if (Number.isFinite(result.total) && result.total > 0) total = result.total;
        if (!total) throw new Error('The server did not provide the video length');
        // Seeking and reading the index may revisit bytes. Only count unique
        // ranges, so a transfer percentage cannot claim completion twice.
        const ranges = [...receivedRanges, [offset, offset + result.buffer.byteLength]].sort((a, b) => a[0] - b[0]);
        receivedRanges = [];
        for (const range of ranges) {
            const last = receivedRanges[receivedRanges.length - 1];
            if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
            else receivedRanges.push(range);
        }
        const received = receivedRanges.reduce((sum, range) => sum + range[1] - range[0], 0);
        options.onProgress?.({ loadedBytes: received, totalBytes: total, streaming: true });
        result.buffer.fileStart = offset;
        return result.buffer;
    };
    async function open() {
        if (disposed || tracks.size || parsingReady) return;
        try {
            let info = null, parserError = null;
            parser.onError = error => { parserError = new Error(String(error || 'Invalid MP4')); if (parsingReady) fail(parserError); };
            parser.onReady = value => { info = value; };
            let offset = 0, metadataBytes = 0, firstEnd = 0;
            // appendBuffer returns the next useful offset, skipping a large mdat
            // to find a trailing moov without transferring the whole video.
            while (!info && !disposed) {
                const bytes = await read(offset);
                metadataBytes += bytes.byteLength;
                if (offset === 0) firstEnd = bytes.byteLength;
                const next = parser.appendBuffer(bytes);
                if (parserError) throw parserError;
                if (info) break;
                if (metadataBytes > 16 * chunkSize) throw new Error('Video index is too large');
                offset = Number.isFinite(next) && next > offset ? next : offset + bytes.byteLength;
                if (offset >= total) throw new Error('Video index was not found');
            }
            if (disposed) return;
            const supported = (info.tracks || []).filter(track => track.type === 'video' || track.type === 'audio');
            if (!supported.some(track => track.type === 'video')) throw new Error('No playable video track');
            for (const track of supported) {
                const mime = (track.type === 'audio' ? 'audio/mp4' : 'video/mp4') + '; codecs="' + track.codec + '"';
                if (!MediaSource.isTypeSupported(mime)) throw new Error('Unsupported video codec: ' + track.codec);
                tracks.set(track.id, { id: track.id, buffer: mediaSource.addSourceBuffer(mime), pending: Promise.resolve() });
                const samples = track.type === 'video' ? 8 : 16;
                parser.setSegmentOptions(track.id, null, { nbSamples: samples });
            }
            if (info.duration > 0 && info.timescale > 0) mediaSource.duration = info.duration / info.timescale;
            parser.onSegment = (id, _user, buffer, sampleNumber) => {
                const track = tracks.get(id);
                if (track && !disposed) enqueue(track, buffer, sampleNumber);
            };
            for (const segment of parser.initializeSegmentation()) enqueue(tracks.get(segment.id), segment.buffer);
            parsingReady = true;
            parser.start();
            offset = firstEnd;
            let eof = false;
            while (!disposed) {
                await drain();
                if (disposed) return;
                if (pendingSeek !== null) {
                    const target = pendingSeek;
                    pendingSeek = null;
                    parser.stop();
                    const position = parser.seek(target, true);
                    offset = position.offset;
                    eof = false;
                    parser.start();
                } else if (eof || buffered(video.currentTime) > 30) {
                    await wait(200);
                    continue;
                }
                if (offset >= total) {
                    parser.flush();
                    await drain();
                    if (mediaSource.readyState === 'open') mediaSource.endOfStream();
                    eof = true;
                    continue;
                }
                const bytes = await read(offset);
                parser.appendBuffer(bytes);
                offset += bytes.byteLength;
                if (parserError) throw parserError;
            }
        } catch (error) { if (!disposed) fail(error); }
    }
    signal?.addEventListener('abort', dispose, { once: true });
    video.addEventListener('seeking', seeking);
    mediaSource.addEventListener('sourceopen', open);
    return { src, streaming: true, dispose };
}
