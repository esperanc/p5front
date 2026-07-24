// =============================================================================
// SHARE — encode/decode a whole project into a URL parameter (LZString)
// =============================================================================
// A shared link carries the entire file map compressed in ?share=. Opening it
// imports a *copy* into the recipient's projects. Large binary assets (e.g. a
// vendored 4.4 MB p5.js) blow up the URL, so callers can drop unreferenced files
// and we warn past a safe length threshold.
// Depends on: LZString (global), formats.js (referencedFiles).
// =============================================================================

// Practical ceiling — most browsers/servers handle far more, but links this long
// are unwieldy. Beyond it, we advise exporting a zip instead.
const SHARE_URL_WARN = 60000;

// Serialize + compress a file map into the ?share= value.
function encodeShare(files, { omitUnreferenced = true } = {}) {
    let map = files;
    if (omitUnreferenced && files['index.html'] && typeof referencedFiles === 'function') {
        const keep = referencedFiles(files);
        map = {};
        for (const k in files) if (keep.has(k)) map[k] = files[k];
    }
    return LZString.compressToEncodedURIComponent(JSON.stringify(map));
}

// Decompress a ?share= value back into a file map (or null on failure).
function decodeShare(param) {
    try {
        const json = LZString.decompressFromEncodedURIComponent(param);
        if (!json) return null;
        const map = JSON.parse(json);
        return (map && typeof map === 'object') ? map : null;
    } catch (e) {
        console.error('decodeShare failed:', e);
        return null;
    }
}

// Build a full share URL that opens the IDE with the embedded project.
function buildShareURL(files, name, opts) {
    const share = encodeShare(files, opts);
    const base  = location.origin + location.pathname.replace(/[^/]*$/, 'ide.html');
    return `${base}?share=${share}&name=${encodeURIComponent(name || 'Shared Sketch')}`;
}
