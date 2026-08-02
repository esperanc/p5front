// =============================================================================
// FORMATS — universal import/export between zip archives and the canonical model
// =============================================================================
// A single adapter handles p5.js Web Editor AND OpenProcessing exports, because
// both are just "a folder with index.html at the root". No per-origin branching
// on the data path — origin is only a metadata label.
// Depends on: JSZip (global), storage.js (isTextPath, mimeForPath).
// =============================================================================

// p5 version pinned to what the real exports ship with.
const P5_CDN = 'https://cdn.jsdelivr.net/npm/p5@2.2.3/lib/p5.js';

// -----------------------------------------------------------------------------
// DEFAULT PROJECT — seeded for brand-new projects.
// -----------------------------------------------------------------------------
function defaultProjectFiles() {
    return {
        'index.html':
`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <script src="${P5_CDN}"></script>
    <link rel="stylesheet" type="text/css" href="style.css" />
  </head>
  <body>
    <main></main>
    <script src="sketch.js"></script>
  </body>
</html>
`,
        'sketch.js':
`function setup() {
  createCanvas(400, 400);
}

function draw() {
  background(220);
  circle(mouseX, mouseY, 40);
}
`,
        'style.css':
`html, body { margin: 0; padding: 0; }
canvas { display: block; }
`
    };
}

// -----------------------------------------------------------------------------
// ORIGIN DETECTION — best-effort label only, never gates loading.
// -----------------------------------------------------------------------------
function detectOrigin(files) {
    const names = Object.keys(files);
    if (names.includes('mySketch.js')) return 'openprocessing';
    // p5 Web Editor download bundles a large local (unreferenced) p5.js alongside sketch.js
    if (names.includes('sketch.js') &&
        names.some(n => /(^|\/)p5(\.min)?\.js$/i.test(n) && isBinaryValue(files[n]) === false)) {
        return 'p5editor';
    }
    if (names.includes('index.html')) return 'native';
    return 'unknown';
}

// -----------------------------------------------------------------------------
// SYNTHESIZE index.html when a zip has none (Decision A).
// -----------------------------------------------------------------------------
function synthesizeIndexHtml(files) {
    const jsFiles  = Object.keys(files).filter(n => /\.m?js$/i.test(n) && !/p5(\.min)?\.js$/i.test(n));
    const cssFiles = Object.keys(files).filter(n => /\.css$/i.test(n));
    // Prefer a conventional entry first, keep the rest in stable order.
    jsFiles.sort((a, b) => {
        const rank = n => (/(^|\/)(sketch|main|mySketch)\.js$/i.test(n) ? 0 : 1);
        return rank(a) - rank(b) || a.localeCompare(b);
    });
    const links   = cssFiles.map(n => `    <link rel="stylesheet" type="text/css" href="${n}" />`).join('\n');
    const scripts = jsFiles.map(n => `    <script src="${n}"></script>`).join('\n');
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <script src="${P5_CDN}"></script>
${links}
  </head>
  <body>
    <main></main>
${scripts}
  </body>
</html>
`;
}

// -----------------------------------------------------------------------------
// INDEX.HTML TAG WIRING — auto-insert/remove <script>/<link> when files or CDN
// libraries are added to a project, so the user never hand-edits index.html.
// Pure string operations on the raw HTML (like reorder.js): formatting, comments
// and indentation are preserved. All take the project `files` map and mutate its
// 'index.html' entry in place; the caller is responsible for persisting/syncing.
// -----------------------------------------------------------------------------
function _reEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// A local `src`/`href` may appear as `name.js`, `./name.js`, or `name.js?v=2`.
function _resourceSrcPattern(src) { return `\\.?/?${_reEscape(src)}(?:\\?[^"']*)?`; }

// Is this resource already referenced anywhere in the HTML (as src or href)?
function htmlHasResource(html, src) {
    return new RegExp(`(?:src|href)\\s*=\\s*["']${_resourceSrcPattern(src)}["']`, 'i').test(html);
}

// Insert `tag` on its own line immediately before the first match of `anchorRe`,
// copying the anchor line's indentation. Returns the new HTML, or null if the
// anchor isn't found (so callers can try a fallback anchor).
function insertTagBefore(html, anchorRe, tag) {
    const m = anchorRe.exec(html);
    if (!m) return null;
    const lineStart = html.lastIndexOf('\n', m.index) + 1;
    const indent = (html.slice(lineStart, m.index).match(/^[ \t]*/) || [''])[0];
    return html.slice(0, lineStart) + indent + tag + '\n' + html.slice(lineStart);
}

// Add `tag` inside <head>, grouped after the last existing <script>/<link>
// (so an add-on library loads after p5), matching that sibling's indentation.
// Falls back to before </head>, then </body>, then appended.
function insertIntoHead(html, tag) {
    const lines = html.split('\n');
    const closeIdx = lines.findIndex(l => /<\/head>/i.test(l));
    if (closeIdx === -1) {
        return insertTagBefore(html, /<\/body>/i, tag) || (html + `\n${tag}\n`);
    }
    let insertAt = closeIdx, indentSrc = lines[closeIdx];
    for (let i = 0; i < closeIdx; i++) {
        if (/<(?:script|link)\b/i.test(lines[i])) { insertAt = i + 1; indentSrc = lines[i]; }
    }
    const indent = (indentSrc.match(/^[ \t]*/) || [''])[0];
    lines.splice(insertAt, 0, indent + tag);
    return lines.join('\n');
}

// Add a <script> for `src`. External libraries go in <head> (they must load
// before local code); local modules go just before the entry sketch's <script>
// (so a module defining a class/var loads before the sketch that uses it),
// falling back to end-of-<body>. No-op (returns false) if already present.
function addScriptToIndexHtml(files, src, opts = {}) {
    const { external = false, moduleType = false, beforeSrc = null } = opts;
    const html = files['index.html'];
    if (typeof html !== 'string' || htmlHasResource(html, src)) return false;
    const tag = `<script${moduleType ? ' type="module"' : ''} src="${src}"></script>`;
    let out = null;
    if (external) {
        out = insertIntoHead(html, tag);
    } else {
        if (beforeSrc && htmlHasResource(html, beforeSrc)) {
            const anchor = new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["']${_resourceSrcPattern(beforeSrc)}["'][^>]*>`, 'i');
            out = insertTagBefore(html, anchor, tag);
        }
        out = out || insertTagBefore(html, /<\/body>/i, tag)
                  || insertTagBefore(html, /<\/html>/i, tag);
    }
    files['index.html'] = out || (html + `\n${tag}\n`);
    return true;
}

// Add a <link rel="stylesheet"> for `href` in <head>. No-op if already present.
function addStyleToIndexHtml(files, href) {
    const html = files['index.html'];
    if (typeof html !== 'string' || htmlHasResource(html, href)) return false;
    files['index.html'] = insertIntoHead(html, `<link rel="stylesheet" href="${href}" />`);
    return true;
}

// Remove the <script>/<link> line(s) referencing `src` (used when a file is
// deleted, so no broken tag is left behind).
function removeResourceFromIndexHtml(files, src) {
    const html = files['index.html'];
    if (typeof html !== 'string') return;
    const p = _resourceSrcPattern(src);
    const scriptRe = new RegExp(`[ \\t]*<script\\b[^>]*\\bsrc\\s*=\\s*["']${p}["'][^>]*>\\s*</script>[ \\t]*\\r?\\n?`, 'gi');
    const linkRe   = new RegExp(`[ \\t]*<link\\b[^>]*\\bhref\\s*=\\s*["']${p}["'][^>]*>[ \\t]*\\r?\\n?`, 'gi');
    files['index.html'] = html.replace(scriptRe, '').replace(linkRe, '');
}

// Point any tag referencing `oldSrc` at `newSrc` (used when a file is renamed).
function renameResourceInIndexHtml(files, oldSrc, newSrc) {
    const html = files['index.html'];
    if (typeof html !== 'string') return;
    const re = new RegExp(`((?:src|href)\\s*=\\s*["'])${_resourceSrcPattern(oldSrc)}(["'])`, 'gi');
    files['index.html'] = html.replace(re, (m, pre, post) => pre + newSrc + post);
}

// -----------------------------------------------------------------------------
// IMPORT — zip Blob → { files, name, origin, warnings }
// -----------------------------------------------------------------------------
async function importArchive(blob, filenameHint) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded');

    const zip   = await JSZip.loadAsync(blob);
    const files = {};
    const warnings = [];

    for (const path in zip.files) {
        const entry = zip.files[path];
        if (entry.dir) continue;
        // Skip archive cruft.
        if (path.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(path)) continue;

        if (isTextPath(path)) {
            files[path] = await entry.async('string');
        } else {
            const b64 = await entry.async('base64');
            files[path] = `data:${mimeForPath(path)};base64,${b64}`;
        }
    }

    // Enforce the index.html invariant (Decision A: synthesize if missing).
    if (!files['index.html']) {
        const hasCode = Object.keys(files).some(n => /\.m?js$/i.test(n));
        if (hasCode) {
            files['index.html'] = synthesizeIndexHtml(files);
            warnings.push('No index.html found at root — a minimal one was generated.');
        } else {
            warnings.push('No index.html and no JavaScript found — project may not run.');
            if (Object.keys(files).length === 0) throw new Error('Archive is empty.');
        }
    }

    const name = (filenameHint || 'imported')
        .replace(/\.zip$/i, '')
        .replace(/[_\-]+/g, ' ')
        .trim() || 'Imported Project';

    return { files, name, origin: detectOrigin(files), warnings };
}

// -----------------------------------------------------------------------------
// EXPORT — canonical model → zip Blob
// -----------------------------------------------------------------------------
async function exportArchive(files, { omitUnreferenced = false } = {}) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded');

    let out = files;
    if (omitUnreferenced && files['index.html']) {
        const keep = referencedFiles(files);
        out = {};
        for (const path in files) if (keep.has(path)) out[path] = files[path];
    }

    const zip = new JSZip();
    for (const path in out) {
        const v = out[path];
        if (isBinaryValue(v)) {
            const comma = v.indexOf(',');
            zip.file(path, v.slice(comma + 1), { base64: true });
        } else {
            zip.file(path, v);
        }
    }
    return zip.generateAsync({ type: 'blob' });
}

// Set of paths referenced (transitively, shallowly) from index.html — used to
// drop dead weight like the p5 editor's unreferenced 4.4 MB p5.js.
function referencedFiles(files) {
    const keep = new Set(['index.html']);
    const html = files['index.html'] || '';
    const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        let ref = m[1].trim();
        if (/^(https?:)?\/\//i.test(ref) || ref.startsWith('data:') || ref.startsWith('#')) continue;
        ref = ref.replace(/^\.\//, '').split(/[?#]/)[0];
        if (files[ref] !== undefined) keep.add(ref);
    }
    // Always keep any CSS the HTML links, plus assets are best-effort; conservative:
    return keep;
}
