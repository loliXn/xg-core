# Optional ZIP resources

`openZipArchive`, `DEFAULT_ARCHIVE_LIMITS` and `ArchiveError` are exported from the
module entry point and the core bundle. Importing core does not load zip.js, start
workers, fetch archives or extract images. The implementation is independent and
uses the official zip.js 2.23.0 reader/writer API. The caller supplies the library
and retains its BSD-3-Clause license notice with distributed dependency assets.

## API

```js
const session = await openZipArchive({
    zip, source, signal, limits, onProgress,
    password, // optional, held only for this session
    requestPassword: async ({ incorrect, filename, signal }) => {
        // Show the caller's password dialog. null cancels this acquisition.
        return obtainPassword({ incorrect, filename, signal });
    }
});
const lease = await session.acquirePage(session.entries[0].id, {
    purpose: 'stage', priority: 'current', signal, onProgress
});
image.src = lease.url;
// Clear the consumer's media reference before releasing its lease.
image.removeAttribute('src');
lease.release();
await session.dispose();
```

`source` is owned by the session after a valid source is supplied, including open
failures. It has `size` (a nonnegative safe integer),
`read(offset, length, signal): Promise<Uint8Array>` and `close()`. Reads must return
exactly the requested length, honor cancellation and refer to the same immutable
object throughout the session. Close must cancel outstanding reads and clear transport buffers;
it may return a promise. Authentication, range validation, download fallback and
transport caches belong to the caller. No transport globals are used here.

`entries` is a frozen array of image candidates. Each frozen entry has `id`,
`path`, `filename` (basename), `extension`, `compressedBytes`, `expandedBytes` and
`encrypted`. IDs are `zip-entry-<zero-based directory ordinal>`, including skipped
entries in that ordinal. Duplicate filenames remain distinct. IDs are local to a
session; combine them with the caller's stable archive identity. Paths sort with
a numeric, case-insensitive `Intl.Collator`, then directory ordinal. Backslashes
become slashes. Entries use a `Map` internally, never path-keyed objects.

`acquirePage(id, { purpose, priority, signal, onProgress })` returns
`Promise<{ url, blob, mime, bytes, format, animated, release() }>`. `format` refers
to the original raster format. `mime` describes the returned Blob. A thumbnail is
PNG with `animated: false`; original leases retain signature-based animation
metadata. GIF is conservatively marked animated, even for a single-frame file.
`release()` is idempotent and clears this lease's Blob and URL properties. Do not
use it afterward. Save archive/entry identity rather than Blob URLs.

| Purpose | Default priority | Returned resource |
| --- | --- | --- |
| `stage` (default) | `current` | Original validated image |
| `download` | `current` | Original validated image |
| `preload` | `adjacent` | Original validated image |
| `thumb` | `visible` | Reduced first-frame PNG, at most 256 px per side |

An explicit priority overrides the default. Two jobs run at a time across all
sessions sharing the injected namespace. Pending jobs sort current, adjacent,
visible, then FIFO. Work already running is not preempted. Requests for one entry
share extraction and thumbnail conversion. Removing one subscriber does not
cancel another; losing the final subscriber aborts the job, including source
reads. A new request waits for a cancelled predecessor to finish before reading
that entry. There is no automatic adjacent-page or full-archive extraction.

## Bounds and lifecycle

All limits are positive safe integers. Overrides use these exact property names.

| Limit | Default |
| --- | --- |
| `maxEntries` | 10,000, including skipped records |
| `maxDirectoryBytes` | 16 MiB |
| `maxImageBytes` | 64 MiB expanded per image |
| `maxTotalExpandedBytes` | 4 GiB declared across all entries |
| `maxExpansionRatio` | 1,000:1 per entry, including skipped records |
| `maxPageCacheBytes` | 128 MiB |
| `maxThumbCacheBytes` | 16 MiB |
| `maxDecodedBytes` | 96 MiB estimated concurrent stage and thumbnail decoding |
| `thumbnailSize` | 256 px |

EOCD/ZIP64 and every central record are validated before zip.js enumerates the
directory. A second read budget bounds library index reads. Enumeration uses
`getEntriesGenerator`, with a count cap and metadata agreement check. Extraction
accepts chunks through a custom `zip.Writer`; it checks declared length, image
size, ratio and cache capacity before retaining each chunk. Progress is measured
from bytes accepted by that writer, not compressed-input percentages.

Original and thumbnail caches are separate Blob LRUs. Original accounting includes
in-flight writer output. Thumbnail output is admitted after the bounded canvas
encoder finishes. Active leases and thumbnail-conversion source Blobs are pinned.
When pins exhaust capacity, acquisition rejects `CACHE_LIMIT`; live resources are
never evicted to accommodate a new page. These budgets do not include the caller's
transport buffer, library directory copies, temporary chunk-to-Blob copies, codec
buffers or browser image memory.

Thumbnails use `createImageBitmap` and canvas to capture one frame, resize it and
encode a PNG. They never return the animated original as a fallback. Unknown or
excessive dimensions reject `DECODE_LIMIT`. AVIF dimensions require complete
metadata boxes within the first 64 KiB; other AVIF pages can still be acquired as
originals. Missing bitmap/canvas support rejects
`THUMBNAIL_UNAVAILABLE`. The caller can display its usual placeholder. Bitmap and
canvas storage are cleared when conversion finishes or cancellation is observed.
Stage leases reserve the declared raster estimate before handing an image URL
to a decoder and return that reservation on release. Unknown or excessive stage
dimensions reject `DECODE_LIMIT`; downloads still acquire the validated original
bytes. Stage and thumbnail decoding share the session budget. This is an estimate,
not a browser allocator cap; the viewer must also clear its image/cache references.

Release mounted resources before disposing a session. `dispose(): Promise<void>`
is idempotent: it rejects pending subscribers, aborts jobs and password prompts,
closes the source, drains running work, closes the reader and drops unpinned
resources. Existing live leases remain usable until released, including after
dispose; their final release revokes their URL. Disposed sessions cannot acquire
resources. Aborting the open signal also disposes a returned session.

Worker teardown is serialized against new jobs. Idle workers are terminated after
one second without queued/running core work, or on disposal when the pool is idle.
Use a dedicated zip.js namespace: global worker termination must not affect
unrelated users of the same library instance.

## Passwords, formats and actionable errors

`requestPassword({ incorrect, filename, signal, attempt })` returns
`Promise<string | null>`. The extra `signal` and `attempt` fields are optional for
the dialog to consume. Concurrent requests share one prompt. An incorrect
password clears only that attempted session password and offers another prompt;
there are at most three prompts per acquisition. A null/empty response rejects
`PASSWORD_CANCELLED`. Without a callback, missing/incorrect credentials reject
`PASSWORD_REQUIRED`/`WRONG_PASSWORD`. None of these disposes the session. Retry by
acquiring again. Prompt cancellation does not invalidate a validated cached page.
Passwords are never persisted or logged and are cleared on disposal. The caller
must close its dialog on the supplied signal and avoid retaining submitted values.

Candidates include JPG/JPEG/JFIF, PNG/APNG, GIF, WEBP, AVIF and BMP. Content
signatures determine MIME before creating an image lease. Hidden/metadata paths,
traversal and absolute paths, folders, symbolic links, marked executables and
other extensions are skipped. HTML, SVG and nested archives cannot be returned
as image leases even when renamed to image extensions. Since indexing is lazy,
a misleading candidate remains listed until acquisition rejects
`UNSUPPORTED_IMAGE`. Signature recognition does not prove browser decode support
or a completely valid image; the consumer still handles image decode errors.

Ordinary single-volume ZIP64 and zip.js-supported entry encryption are supported.
Extended ZIP64 records, encrypted directories, split volumes, offset-repaired
archives, trailing data and overlapping/aliased local records are rejected with
actionable errors. Integrity checks are enabled; integrity failure is not treated
as an automatic wrong-password retry because corruption can cause it too.

`ArchiveError.code` is suitable for UI states: `INVALID_SOURCE`, `SOURCE_READ`,
`INVALID_OPTIONS`, `ZIP_UNAVAILABLE`, `INVALID_ZIP`, `ENTRY_LIMIT`,
`DIRECTORY_LIMIT`, `IMAGE_LIMIT`, `TOTAL_LIMIT`, `RATIO_LIMIT`, `CACHE_LIMIT`,
`DECODE_LIMIT`, `THUMBNAIL_UNAVAILABLE`, `UNSUPPORTED_IMAGE`, `UNSUPPORTED_SPLIT`,
`UNSUPPORTED_ZIP64`, `UNSUPPORTED_DIRECTORY`, `UNSUPPORTED_COMPRESSION`,
`UNSUPPORTED_ENCRYPTION`, `PASSWORD_REQUIRED`, `WRONG_PASSWORD`,
`PASSWORD_CANCELLED`, `WORKER_UNAVAILABLE`, `INTEGRITY_FAILED`, `ENTRY_NOT_FOUND`,
`DISPOSED`, `ZIP_FAILED`. Cancellation uses an error named `AbortError`.
Callbacks receive `{ phase, loaded, total? }`: directory and extraction report
real bytes; `thumbnail` has no invented percentage; `cache` describes cached bytes.

## Dependency and verification boundary

The caller configures pinned worker/WASM assets, a suitable `baseURI`,
`maxWorkers: 2`, `useWebWorkers: true` and worker startup/termination timeouts.
The engine requests workers and native asynchronous decompression; it does not
mutate global dependency configuration. Official zip.js can fall back to inline
processing after worker/CSP failures, and its public extraction API does not
report which backend actually ran. Requiring worker-only processing therefore
needs a caller-provided fail-closed library configuration/facade. Permit inline
fallback only when the caller ensures it uses native asynchronous codecs; merely
setting `useWebWorkers: true` does not establish that guarantee. Reported worker
failures become `WORKER_UNAVAILABLE` rather than triggering a core retry inline.

API references: [reader](https://gildas-lormeau.github.io/zip.js/api/classes/ZipReader.html),
[writer](https://gildas-lormeau.github.io/zip.js/api/classes/Writer.html),
[pinned source](https://github.com/gildas-lormeau/zip.js/tree/v2.23.0).
Syntax checks and static review establish source/bundle consistency only.
No archive behavior, worker/CSP execution, password dialog or browser decoding
has been tested by this implementation task.
