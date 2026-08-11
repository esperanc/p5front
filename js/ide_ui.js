// =============================================================================
// IDE UI — wiring: Ace editor, file tree, run/stop, import/export
// Depends on: util.js, storage.js, formats.js, Ace (global), JSZip (global)
// =============================================================================

// ---- state ----
const LS_LAST_PROJECT = 'p5front_last_project';
let projectId    = null;
let projectName  = 'Untitled';
let projectFiles = {};
let currentFile  = 'index.html';
let bufferFile   = null;   // which file is actually loaded in the Ace buffer (null until first load)
let editor       = null;
let sessions     = {};   // path → Ace EditSession (own undo history, cursor, scroll)
let _saveTimer   = null;
let _lintTimer   = null;

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const treeEl        = $('filetree');
const pnameEl       = $('pname');
const runner        = $('runner');
const placeholder   = $('preview-placeholder');
const consoleEl     = $('console');

// -----------------------------------------------------------------------------
// EDITOR
// -----------------------------------------------------------------------------
const ACE_MODE = {
    js: 'javascript', mjs: 'javascript', json: 'json',
    css: 'css', html: 'html', htm: 'html', svg: 'html', xml: 'xml',
    glsl: 'glsl', vert: 'glsl', frag: 'glsl', vs: 'glsl', fs: 'glsl', glslv: 'glsl', glslf: 'glsl',
    md: 'markdown', txt: 'text'
};
function aceModeFor(path) {
    const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
    return 'ace/mode/' + (ACE_MODE[ext] || 'text');
}

function setupEditor() {
    ace.config.set('basePath', 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.3/');
    editor = ace.edit('ace-editor');
    editor.setTheme(effectiveTheme() === 'dark' ? 'ace/theme/tomorrow_night' : 'ace/theme/tomorrow');
    // Ace's JS linter is an old JSHint worker that false-flags modern syntax
    // (static class fields, etc.). Disable it — it only produces error
    // annotations and doesn't affect syntax highlighting.
    editor.setOption('useWorker', false);
    editor.setOptions({
        fontSize: '13px', showPrintMargin: false, useSoftTabs: true, tabSize: 2,
        wrap: false, highlightActiveLine: true
    });
    // Editor-level change fires for whichever session is current.
    editor.on('change', () => {
        if (!bufferFile) return;   // binary placeholder or nothing loaded
        scheduleSave();
        scheduleLint();
    });
}

// One EditSession per file — preserves undo history, cursor and scroll on switch.
function getSession(path) {
    if (sessions[path]) return sessions[path];
    const content = isBinaryValue(projectFiles[path]) ? '' : (projectFiles[path] || '');
    const session = ace.createEditSession(content, aceModeFor(path));
    sessions[path] = session;
    applyEditorSettings();   // font (editor) + per-session opts incl. the new one
    return session;
}

function scheduleSave() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveProject, 500);
}

// -----------------------------------------------------------------------------
// LINT — Acorn parser: real syntax errors, understands modern ES (class fields,
// private fields, etc.). Reports the first syntax error as an Ace annotation.
// -----------------------------------------------------------------------------
function scheduleLint() {
    clearTimeout(_lintTimer);
    _lintTimer = setTimeout(lintCurrentFile, 400);
}

// Parse as a classic script first (how the SW serves sketches); if that fails
// but the code is valid as a module (import/export/top-level await), treat it as
// clean. Returns the script-mode SyntaxError, or null when the code parses.
function parseJS(code) {
    const base = { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true };
    try {
        acorn.parse(code, { ...base, sourceType: 'script' });
        return null;
    } catch (scriptErr) {
        try {
            acorn.parse(code, { ...base, sourceType: 'module', allowAwaitOutsideFunction: true });
            return null;   // valid ES module — not an error
        } catch (moduleErr) {
            return scriptErr;
        }
    }
}

function lintCurrentFile() {
    if (!editor) return;
    const path = bufferFile || currentFile;
    const isJs = /\.m?js$/i.test(path || '');
    if (!isJs || !editorSettings.lint || typeof acorn === 'undefined') {
        editor.session.setAnnotations([]);
        return;
    }
    const err = parseJS(editor.getValue());
    if (err && err.loc) {
        editor.session.setAnnotations([{
            row: err.loc.line - 1,
            column: err.loc.column,
            text: err.message.replace(/\s*\(\d+:\d+\)\s*$/, ''),   // strip "(line:col)" suffix
            type: 'error'
        }]);
    } else {
        editor.session.setAnnotations([]);
    }
}

// -----------------------------------------------------------------------------
// FILE TREE
// -----------------------------------------------------------------------------
function renderTree() {
    const paths = Object.keys(projectFiles).sort((a, b) => {
        // index.html first, then alphabetical
        if (a === 'index.html') return -1;
        if (b === 'index.html') return 1;
        return a.localeCompare(b);
    });
    treeEl.innerHTML = '';
    for (const path of paths) {
        const item = document.createElement('div');
        item.className = 'file-item' + (path === currentFile ? ' active' : '');
        item.innerHTML = `<span class="fname">${escapeHtml(path)}</span>
                          <span class="fx" data-act="rename" title="Rename">✎</span>
                          <span class="fx" data-act="delete" title="Delete">✕</span>`;
        item.querySelector('.fname').onclick = () => openFile(path);
        item.querySelector('[data-act="rename"]').onclick = (e) => { e.stopPropagation(); renameFile(path); };
        item.querySelector('[data-act="delete"]').onclick = (e) => { e.stopPropagation(); deleteFile(path); };
        treeEl.appendChild(item);
    }
}

function openFile(path) {
    if (!(path in projectFiles)) return;
    currentFile = path;
    if (isBinaryValue(projectFiles[path])) {
        // Binary asset: throwaway read-only session, not tracked for editing.
        const s = ace.createEditSession(
            `[binary file: ${path}]\n\nPreview and editing of binary assets is not supported.`,
            'ace/mode/text');
        s.setUseWorker(false);
        editor.setSession(s);
        editor.setReadOnly(true);
        bufferFile = null;
    } else {
        editor.setReadOnly(false);
        editor.setSession(getSession(path));   // keeps undo/cursor/scroll per file
        bufferFile = path;
    }
    const label = $('current-file-label');
    if (label) label.textContent = path;
    lintCurrentFile();
    renderTree();
}

// Pull the latest content from every live session back into the model (for save/export/run).
function syncEditorToFiles() {
    for (const path in sessions) {
        if ((path in projectFiles) && !isBinaryValue(projectFiles[path])) {
            projectFiles[path] = sessions[path].getValue();
        }
    }
}

// -----------------------------------------------------------------------------
// FILE OPERATIONS
// -----------------------------------------------------------------------------
// A path that can be wired into index.html as a local <script>.
function isScriptPath(p) { return /\.m?js$/i.test(p); }

// Push a programmatic change to a text file into its live Ace session too, so
// syncEditorToFiles() (on the next save/run) doesn't clobber it with stale text.
function syncFileSession(path) {
    if (sessions[path] && !isBinaryValue(projectFiles[path])) {
        sessions[path].setValue(projectFiles[path] || '', -1);
    }
}
function syncIndexHtmlSession() { syncFileSession('index.html'); }

// --- New file modal (replaces the old prompt) --------------------------------
function openNewFileModal() {
    $('newfile-path').value = '';
    $('newfile-include').checked = true;
    $('newfile-module').checked = false;
    updateNewFileOpts();
    $('newfile-overlay').style.display = 'flex';
    $('newfile-path').focus();
}
function closeNewFileModal() { $('newfile-overlay').style.display = 'none'; }

// Reveal the <script> wiring options only when the path looks like JS.
function updateNewFileOpts() {
    const path = $('newfile-path').value.trim().replace(/^\/+/, '');
    $('newfile-js-opts').style.display = isScriptPath(path) ? 'block' : 'none';
}

function submitNewFile() {
    const path = $('newfile-path').value.trim().replace(/^\/+/, '');
    if (!path) return;
    if (path in projectFiles) { alert('A file with that path already exists.'); return; }
    const isJs = isScriptPath(path);
    const include    = isJs && $('newfile-include').checked;
    const moduleType = isJs && $('newfile-module').checked;

    projectFiles[path] = '';
    if (include) {
        syncEditorToFiles();   // capture pending index.html edits before mutating it
        addScriptToIndexHtml(projectFiles, path, { moduleType, beforeSrc: pickMainSketch() });
        syncIndexHtmlSession();
    }
    closeNewFileModal();
    openFile(path);            // land the user in the new module, ready to type
    saveProject();
}

// --- Add library modal (CDN URL → <script>/<link> in index.html) -------------
function openLibModal() {
    $('addlib-url').value = '';
    $('addlib-overlay').style.display = 'flex';
    $('addlib-url').focus();
}
function closeLibModal() { $('addlib-overlay').style.display = 'none'; }

function submitAddLib() {
    const url = $('addlib-url').value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url) && !url.startsWith('//')) {
        alert('Please enter an absolute URL (starting with https://).');
        return;
    }
    syncEditorToFiles();       // capture pending index.html edits before mutating it
    const clean = url.split(/[?#]/)[0];
    const added = /\.css$/i.test(clean)
        ? addStyleToIndexHtml(projectFiles, url)
        : addScriptToIndexHtml(projectFiles, url, { external: true, moduleType: /\.mjs$/i.test(clean) });
    syncIndexHtmlSession();
    closeLibModal();
    if (!added) { alert('That URL is already included in index.html.'); return; }
    openFile('index.html');    // show the inserted tag as confirmation
    saveProject();
}

function deleteFile(path) {
    if (path === 'index.html') { alert('index.html is the entry point and cannot be deleted.'); return; }
    if (!confirm(`Delete "${path}"?`)) return;
    if (/\.(m?js|css)$/i.test(path)) {
        syncEditorToFiles();   // don't lose pending index.html edits when we rewrite it
        removeResourceFromIndexHtml(projectFiles, path);
        syncIndexHtmlSession();
    }
    delete projectFiles[path];
    delete sessions[path];
    if (currentFile === path) currentFile = 'index.html';
    openFile(currentFile);
    saveProject();
}

function renameFile(path) {
    if (path === 'index.html') { alert('index.html cannot be renamed (it is the entry point).'); return; }
    const next = prompt('Rename file to:', path);
    if (!next || next.trim() === path) return;
    const np = next.trim().replace(/^\/+/, '');
    if (np in projectFiles) { alert('A file with that path already exists.'); return; }
    syncEditorToFiles();
    projectFiles[np] = projectFiles[path];
    delete projectFiles[path];
    // Move the session (preserving its undo/cursor) and update its mode for the new extension.
    if (sessions[path]) {
        sessions[np] = sessions[path];
        sessions[np].setMode(aceModeFor(np));
        delete sessions[path];
    }
    // Keep any <script>/<link> in index.html pointing at the renamed file.
    if (/\.(m?js|css)$/i.test(path)) {
        renameResourceInIndexHtml(projectFiles, path, np);
        syncIndexHtmlSession();
    }
    if (currentFile === path) currentFile = np;
    openFile(currentFile);
    saveProject();
}

function uploadFiles(fileList) {
    const files = Array.from(fileList);
    let pending = files.length;
    if (!pending) return;
    files.forEach(file => {
        const reader = new FileReader();
        const asText = isTextPath(file.name);
        reader.onload = (e) => {
            projectFiles[file.name] = e.target.result;   // text OR data URL
            if (--pending === 0) { renderTree(); saveProject(); }
        };
        reader.onerror = () => { if (--pending === 0) { renderTree(); saveProject(); } };
        asText ? reader.readAsText(file) : reader.readAsDataURL(file);
    });
}

// -----------------------------------------------------------------------------
// PERSISTENCE
// -----------------------------------------------------------------------------
// The derived-cache fields the registry keeps for fast Projects-browser listing.
function derivedMeta(files) {
    const m = (typeof readProjectMeta === 'function') ? readProjectMeta(files) : {};
    return { title: m.title || '', tags: m.tags || [], collection: m.collection || '', hasThumb: !!m.hasThumb, hasDesc: !!m.description };
}

async function saveProject() {
    if (!projectId) return;
    syncEditorToFiles();
    try {
        await putProject(projectId, projectFiles);
        await upsertRegistryEntry(projectId, { name: projectName, ...derivedMeta(projectFiles) });
    } catch (e) {
        console.error('save failed', e);
    }
}

// -----------------------------------------------------------------------------
// RUN / STOP  — Service Worker serves runner/<id>/* from IndexedDB.
// -----------------------------------------------------------------------------
async function runSketch() {
    await saveProject();
    consoleEl.innerHTML = '';
    if (!('serviceWorker' in navigator)) {
        logLine('Service Worker not supported in this browser — cannot run sketches.', 'err');
        return;
    }
    try {
        await navigator.serviceWorker.ready;   // ensure the SW controls new frames
    } catch (e) {
        logLine('Service Worker not ready: ' + e.message, 'err');
        return;
    }
    placeholder.style.display = 'none';
    runner.src = `runner/${encodeURIComponent(projectId)}/index.html?t=${Date.now()}`;
}

function stopSketch() {
    runner.src = 'about:blank';
    placeholder.style.display = 'flex';
}

// Open the sketch full-window in a separate view-mode window.
async function openViewWindow() {
    await saveProject();
    window.open(`view.html?id=${encodeURIComponent(projectId)}`, '_blank');
}

function logLine(text, cls) {
    const el = document.createElement('div');
    el.className = 'line' + (cls ? ' ' + cls : '');
    el.textContent = text;
    consoleEl.appendChild(el);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

// -----------------------------------------------------------------------------
// CANVAS SNAPSHOT — grab a PNG of the running sketch for the thumbnail.
// -----------------------------------------------------------------------------
// Ask the running sketch (via the SW-injected handler) for a PNG of its canvas;
// it forces a redraw first so WEBGL reads populated. Falls back to reading the
// same-origin canvas directly (fine for 2D). Rejects if nothing is running.
function requestRawSnapshot(timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const rid = 'snap-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        const onMsg = (e) => {
            const d = e.data;
            if (!d || d.__p5front !== true || d.type !== 'snapshot' || d.rid !== rid) return;
            settled = true; window.removeEventListener('message', onMsg);
            d.error ? reject(new Error(d.error)) : resolve(d.dataUrl);
        };
        window.addEventListener('message', onMsg);
        try { runner.contentWindow.postMessage({ __p5front_cmd: 'snapshot', rid }, '*'); }
        catch (e) { /* cross-origin/no window → fall through to the timeout fallback */ }
        setTimeout(() => {
            if (settled) return;
            window.removeEventListener('message', onMsg);
            try {
                const cv = runner.contentDocument && runner.contentDocument.querySelector('canvas');
                if (cv) return resolve(cv.toDataURL('image/png'));
            } catch (e) { /* tainted or inaccessible */ }
            reject(new Error('Could not read the canvas — run the sketch first.'));
        }, timeoutMs);
    });
}

// Downscale a data URL so its longest side is <= maxDim. Returns a PNG data URL.
function downscaleDataUrl(dataUrl, maxDim = 480) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            try { resolve(c.toDataURL('image/png')); } catch (e) { reject(e); }
        };
        img.onerror = () => reject(new Error('Snapshot image failed to load.'));
        img.src = dataUrl;
    });
}

async function captureThumbnail() {
    const raw = await requestRawSnapshot();
    if (!raw || !raw.startsWith('data:image')) throw new Error('Empty snapshot.');
    return downscaleDataUrl(raw, 480);
}

// -----------------------------------------------------------------------------
// SKETCH INFO MODAL — title, tags, markdown description, thumbnail (README.md +
// thumbnail.png inside the project; see meta.js).
// -----------------------------------------------------------------------------
let infoThumbData = null;   // working thumbnail (data URL or null) for the modal

function openInfoModal() {
    syncEditorToFiles();
    const meta = readProjectMeta(projectFiles);
    $('info-title').value = meta.title || '';
    $('info-title').placeholder = projectName || 'Sketch title';
    $('info-collection').value = meta.collection || '';
    populateCollectionSuggestions();
    $('info-tags').value  = meta.tags.join(', ');
    $('info-desc').value  = meta.description || '';
    infoThumbData = meta.hasThumb ? meta.thumbnailData : null;
    renderInfoThumb();
    $('info-overlay').style.display = 'flex';
    $('info-title').focus();
}

// Autocomplete the Collection input from collections already in use (registry cache).
function populateCollectionSuggestions() {
    const set = new Set();
    for (const p of listProjects()) if (p.collection) set.add(p.collection);
    $('collection-suggestions').innerHTML =
        [...set].sort().map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
}
function closeInfoModal() { $('info-overlay').style.display = 'none'; }

function renderInfoThumb() {
    const box = $('info-thumb');
    if (infoThumbData) box.innerHTML = `<img src="${infoThumbData}" alt="thumbnail" />`;
    else box.innerHTML = `<span class="info-thumb-empty">No thumbnail yet</span>`;
    $('info-thumb-clear').style.display = infoThumbData ? '' : 'none';
}

async function infoCaptureThumb() {
    const btn = $('info-thumb-capture');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Capturing…';
    try {
        infoThumbData = await captureThumbnail();
        renderInfoThumb();
    } catch (e) {
        alert('Snapshot failed: ' + e.message);
    } finally {
        btn.disabled = false; btn.textContent = label;
    }
}

function infoClearThumb() { infoThumbData = null; renderInfoThumb(); }

function submitInfo() {
    writeProjectMeta(projectFiles, {
        title:       $('info-title').value.trim(),
        tags:        parseTagInput($('info-tags').value),
        collection:  $('info-collection').value,
        description: $('info-desc').value
    });
    if (infoThumbData) projectFiles[THUMB_FILE] = infoThumbData;
    else { delete projectFiles[THUMB_FILE]; delete sessions[THUMB_FILE]; }
    delete projThumbCache[projectId];   // thumbnail may have changed; registry cache refreshes on save

    // Keep any open editor session for README.md consistent with what we wrote.
    if (META_FILE in projectFiles) syncFileSession(META_FILE);
    else delete sessions[META_FILE];
    if (!(currentFile in projectFiles)) currentFile = 'index.html';

    closeInfoModal();
    openFile(currentFile);   // refresh editor + file tree
    saveProject();
}

// -----------------------------------------------------------------------------
// IMPORT / EXPORT
// -----------------------------------------------------------------------------
async function exportProject() {
    await saveProject();
    try {
        const blob = await exportArchive(projectFiles);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (slugify(projectName) || 'sketch') + '.zip';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
    } catch (e) {
        alert('Export failed: ' + e.message);
    }
}

async function importZip(blob, filename) {
    try {
        const { files, name, origin, warnings } = await importArchive(blob, filename);
        const { id, name: finalName } = await resolveCollision(name, files);
        await putProject(id, files);
        await upsertRegistryEntry(id, { name: finalName, origin });
        if (warnings.length) console.warn('Import warnings:', warnings);
        location.href = `?id=${encodeURIComponent(id)}`;
    } catch (e) {
        alert('Import failed: ' + e.message);
    }
}

// Derive a project filename ("test.zip") from a URL's last path segment.
function zipFilenameFromUrl(url) {
    try {
        const seg = new URL(url, location.href).pathname.split('/').filter(Boolean).pop();
        return seg ? decodeURIComponent(seg) : 'imported.zip';
    } catch (e) { return 'imported.zip'; }
}

// Find an existing project whose name maps to the same slug (an id collision, or
// a renamed project whose name slugifies the same). Returns its id, or null.
function findProjectByName(name) {
    const reg = getRegistry();
    const slug = slugify(name);
    if (reg[slug]) return slug;
    const hit = Object.values(reg).find(e => slugify(e.name || e.id) === slug);
    return hit ? hit.id : null;
}

// Ask how to resolve a name collision for a single incoming project.
// Resolves to 'overwrite' | 'copy' | null (cancel).
function askProjectConflict(name) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML =
            `<div class="modal-dialog" style="width:420px">
               <div class="modal-head"><strong>Project already exists</strong></div>
               <div class="modal-body">
                 <p style="margin:0 0 12px">A project named &ldquo;${escapeHtml(name)}&rdquo; already exists. What would you like to do?</p>
                 <div style="display:flex; flex-direction:column; gap:8px">
                   <button data-v="overwrite" class="primary">Overwrite existing</button>
                   <button data-v="copy">Import as a copy</button>
                   <button data-v="cancel" class="ghost">Cancel</button>
                 </div>
               </div>
             </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => {
            const v = e.target && e.target.getAttribute && e.target.getAttribute('data-v');
            if (!v) return;
            document.body.removeChild(overlay);
            resolve(v === 'cancel' ? null : v);
        });
    });
}

// Fetch a zip from a URL (?zip=...) and import it as a project, asking how to
// resolve a name collision. Always ends by navigating away (to the imported or
// existing project, or back to a clean URL on cancel/failure).
async function loadProjectFromURL(zipUrl) {
    let imported;
    try {
        const res = await fetch(zipUrl, { mode: 'cors' });
        if (!res.ok) throw new Error(`server responded ${res.status} ${res.statusText}`);
        const blob = await res.blob();
        imported = await importArchive(blob, zipFilenameFromUrl(zipUrl));
    } catch (e) {
        alert(`Could not load the project from:\n${zipUrl}\n\n${e.message}\n\n` +
              `Check the URL is reachable, points to a valid .zip, and that the server ` +
              `allows cross-origin requests (CORS).`);
        location.replace(location.pathname);
        return;
    }
    if (imported.warnings && imported.warnings.length) console.warn('Import warnings:', imported.warnings);
    await storeImportedProject(imported);
}

// fetch that rejects on a non-2xx response (with a useful message).
async function fetchOk(url) {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
    return res;
}

// ArrayBuffer → base64 (chunked, so large assets don't blow the call stack).
function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

// Load a project from an exported p5front repository (?repo=<root>&project=<folder>):
// read the repo's p5front.json, then fetch that project's listed files from its
// folder and import them (same conflict handling as a zip load).
async function loadProjectFromRepo(repoUrl, folder) {
    let imported;
    try {
        if (!repoUrl || !folder) throw new Error('missing repo or project reference');
        const root = new URL(repoUrl, location.href);
        if (!root.pathname.endsWith('/')) root.pathname += '/';
        const manifestUrl = new URL('p5front.json', root).href;
        const manifest = await (await fetchOk(manifestUrl)).json();
        const entry = (manifest.projects || []).find(p => p.folder === folder || p.id === folder);
        if (!entry) throw new Error(`project "${folder}" is not listed in ${manifestUrl}`);
        const fileList = entry.files || [];
        if (!fileList.length) throw new Error('the manifest lists no files for this project (re-export with a newer p5front)');

        // Best-effort per file: a file listed in the manifest may be missing on the
        // host — notably README.md, which GitHub Pages' Jekyll renders to README.html
        // (so the raw .md 404s). Skip such files instead of aborting the whole load.
        const folderBase = new URL(encodeURIComponent(entry.folder) + '/', root).href;
        const files = {};
        const skipped = [];
        for (const rel of fileList) {
            const fileUrl = new URL(rel.split('/').map(encodeURIComponent).join('/'), folderBase).href;
            let res;
            try { res = await fetch(fileUrl, { mode: 'cors' }); } catch (e) { skipped.push(rel); continue; }
            if (!res.ok) { skipped.push(rel); continue; }
            files[rel] = isTextPath(rel)
                ? await res.text()
                : `data:${mimeForPath(rel)};base64,${arrayBufferToBase64(await res.arrayBuffer())}`;
        }
        if (!files['index.html']) {
            if (typeof synthesizeIndexHtml === 'function' && Object.keys(files).length) {
                files['index.html'] = synthesizeIndexHtml(files);
            } else {
                throw new Error('the project has no index.html and none of its files could be fetched');
            }
        }
        // If README.md couldn't be fetched, rebuild it from the manifest so the
        // project's title/tags/description survive the import.
        if (!files['README.md'] && typeof writeProjectMeta === 'function' &&
            (entry.title || (entry.tags && entry.tags.length) || entry.description)) {
            writeProjectMeta(files, { title: entry.title, tags: entry.tags, description: entry.description });
        }
        if (skipped.length) console.warn('Files listed in the manifest were not fetchable and were skipped:', skipped);
        imported = { files, name: entry.name || entry.folder || folder, origin: entry.origin || 'imported' };
    } catch (e) {
        alert(`Could not load the project from the repository:\n${e.message}\n\n` +
              `Check the URL points to a p5front export and that its server allows ` +
              `cross-origin requests (CORS).`);
        location.replace(location.pathname);
        return;
    }
    await storeImportedProject(imported);
}

// Given { files, name, origin }, resolve a name collision (via dialog) and store
// the project, then open it. Shared by the zip (?zip=) and repo (?repo=) loaders.
async function storeImportedProject({ files, name, origin }) {
    const existingId = findProjectByName(name);
    let targetId = slugify(name) || ('project-' + Date.now());
    let targetName = name;
    if (existingId) {
        const choice = await askProjectConflict(name);
        if (!choice) { location.replace(`?id=${encodeURIComponent(existingId)}`); return; }   // cancel → open existing
        if (choice === 'overwrite') { targetId = existingId; }
        else { const r = await resolveCollision(name, files); targetId = r.id; targetName = r.name; }
    }
    await putProject(targetId, files);
    await upsertRegistryEntry(targetId, { name: targetName, origin: origin || 'imported', ...derivedMeta(files) });
    location.replace(`?id=${encodeURIComponent(targetId)}`);
}

// -----------------------------------------------------------------------------
// PROJECT ID ↔ NAME — the id (also the ?id= handle) is a slug of the name. It is
// assigned at creation and, without this, never changes — so a renamed project
// keeps a stale id unrelated to its name. These keep the id tracking the name.
// (?id= is a local handle; sharing uses ?share=/?zip=/?repo=, so re-keying is safe.)
// -----------------------------------------------------------------------------

// Move the current project from its id to `newId` (IDB record + registry entry +
// the address bar), preserving files and origin. Copies before deleting the old.
async function migrateProjectId(newId) {
    const oldId = projectId;
    if (!newId || newId === oldId) return;
    const origin = (getRegistry()[oldId] || {}).origin;
    syncEditorToFiles();
    await putProject(newId, projectFiles);
    await upsertRegistryEntry(newId, { name: projectName, origin, ...derivedMeta(projectFiles) });
    await removeRegistryEntry(oldId);                 // registry entry + old IDB record
    projectId = newId;
    localStorage.setItem(LS_LAST_PROJECT, newId);
    history.replaceState(null, '', `?id=${encodeURIComponent(newId)}`);
}

// Rename the current project. Migrate the id to the new name's slug when that slug
// is free; on a clash with a *different* project, keep the id and just relabel.
async function renameProject(newName) {
    newName = String(newName || '').trim();
    if (!newName || newName === projectName) return;
    projectName = newName;
    const desired = slugify(newName);
    if (desired && desired !== projectId && !getRegistry()[desired]) {
        await migrateProjectId(desired);
    } else {
        await upsertRegistryEntry(projectId, { name: newName });
    }
}

// On load, self-heal a stale id (from a past rename) to the current name's slug
// when that slug is free — so opening a renamed project fixes its ?id=.
async function maybeMigrateIdOnLoad() {
    const desired = slugify(projectName);
    if (desired && desired !== projectId && !getRegistry()[desired]) {
        await migrateProjectId(desired);
    }
}

// -----------------------------------------------------------------------------
// SHARE — copy a URL that embeds the whole project.
// -----------------------------------------------------------------------------
async function shareProject() {
    await saveProject();
    const url = buildShareURL(projectFiles, projectName);
    if (url.length > SHARE_URL_WARN) {
        const kb = Math.round(url.length / 1024);
        if (!confirm(`This project is large — the share link is ~${kb} KB and may not work everywhere.\n` +
                     `Export zip is more reliable for big projects. Copy the link anyway?`)) return;
    }
    try {
        await navigator.clipboard.writeText(url);
        logLine('Share link copied to clipboard.', '');
    } catch (e) {
        prompt('Copy this share link:', url);
    }
}

// -----------------------------------------------------------------------------
// PROJECTS MODAL — open / delete / new, with date or A–Z sorting.
// -----------------------------------------------------------------------------
let projectSort = localStorage.getItem('p5front_sort') || 'date';
let projectFilter = '';
let projectCollection = '';               // '' = all; UNCOLLECTED = only projects with no collection
let projectTags = new Set();              // selected tag facets (AND)
const projThumbCache = {};                // id -> dataURL | null (lazy, only for shown rows)
const UNCOLLECTED = ' none';

const projTagsOf = (p) => Array.isArray(p.tags) ? p.tags : [];
const projCollOf = (p) => p.collection || '';

// Backfill the registry's derived cache for projects saved before it existed
// (one blob read each, only the first time). Cached entries are skipped.
async function backfillProjectMeta() {
    // hasDesc is the newest derived field; its absence flags an entry that predates
    // the cache (or a schema addition) and needs a one-time refresh from its files.
    for (const p of listProjects().filter(p => p.hasDesc === undefined)) {
        let m = { title: '', tags: [], collection: '', hasThumb: false, description: '' };
        try { const rec = await getProject(p.id); m = readProjectMeta(rec && rec.files); } catch (e) { /* defaults */ }
        await cacheRegistryMeta(p.id, { title: m.title, tags: m.tags, collection: m.collection, hasThumb: m.hasThumb, hasDesc: !!m.description });
    }
}

async function openProjectsModal() {
    await saveProject();
    projectFilter = ''; projectCollection = ''; projectTags = new Set();
    $('project-filter').value = '';
    $('projects-overlay').style.display = 'flex';
    renderProjectsModal();                    // instant, from the registry cache
    await backfillProjectMeta();              // fill any missing derived meta once
    renderProjectsModal();
}
function closeProjectsModal() { $('projects-overlay').style.display = 'none'; }

function projInCollection(p) {
    if (projectCollection === UNCOLLECTED) return !projCollOf(p);
    if (!projectCollection) return true;
    const c = projCollOf(p);
    return c === projectCollection || c.startsWith(projectCollection + '/');
}

function projectMatchesFilter(p) {
    const f = projectFilter.trim().toLowerCase();
    if (f && !((p.title || '') + ' ' + (p.name || p.id)).toLowerCase().includes(f)) return false;
    if (!projInCollection(p)) return false;
    for (const t of projectTags) if (!projTagsOf(p).includes(t)) return false;
    return true;
}

// Left rail: All / each collection path (with ancestor prefixes, indented by
// depth) / Uncollected — each with a count; clicking selects it.
function renderCollectionsRail() {
    const rail = $('proj-rail');
    if (!rail) return;
    const all = listProjects();
    const nodes = new Set();
    let uncollected = 0;
    for (const p of all) {
        const c = projCollOf(p);
        if (!c) { uncollected++; continue; }
        const parts = c.split('/');
        for (let i = 1; i <= parts.length; i++) nodes.add(parts.slice(0, i).join('/'));
    }
    const countUnder = (n) => all.filter(p => { const c = projCollOf(p); return c === n || c.startsWith(n + '/'); }).length;
    const item = (label, value, count, depth, active) =>
        `<button class="rail-item${active ? ' active' : ''}" data-coll="${escapeHtml(value)}" style="padding-left:${8 + depth * 14}px">` +
        `<span class="rail-label">${escapeHtml(label)}</span><span class="rail-count">${count}</span></button>`;

    const out = [item('All sketches', '', all.length, 0, projectCollection === '')];
    for (const n of [...nodes].sort())
        out.push(item(n.split('/').pop(), n, countUnder(n), n.split('/').length, projectCollection === n));
    if (uncollected) out.push(item('Uncollected', UNCOLLECTED, uncollected, 0, projectCollection === UNCOLLECTED));
    rail.innerHTML = out.join('');
    rail.querySelectorAll('.rail-item').forEach(b => b.onclick = () => { projectCollection = b.dataset.coll; renderProjectsModal(); });
}

// Tag facets present in the current collection scope, as AND-combining toggles.
function renderTagFacets() {
    const el = $('proj-facets');
    if (!el) return;
    const counts = {};
    for (const p of listProjects()) if (projInCollection(p)) for (const t of projTagsOf(p)) counts[t] = (counts[t] || 0) + 1;
    const tags = Object.keys(counts).sort();
    if (!tags.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = tags.map(t =>
        `<button class="facet${projectTags.has(t) ? ' active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)} <span class="facet-n">${counts[t]}</span></button>`).join('');
    el.querySelectorAll('.facet').forEach(b => b.onclick = () => {
        const t = b.dataset.tag;
        projectTags.has(t) ? projectTags.delete(t) : projectTags.add(t);
        renderProjectsModal();
    });
}

function renderProjectsModal() {
    renderCollectionsRail();
    renderTagFacets();

    const listEl = $('modal-project-list');
    let projs = listProjects();
    if (projectSort === 'alpha') {
        projs = projs.slice().sort((a, b) => (a.title || a.name || a.id).localeCompare(b.title || b.name || b.id));
    }
    $('sort-toggle').textContent = projectSort === 'date' ? 'Sort: Date' : 'Sort: A–Z';

    if (!projs.length) { listEl.innerHTML = '<li class="proj-empty">No projects yet.</li>'; return; }
    projs = projs.filter(projectMatchesFilter);
    if (!projs.length) { listEl.innerHTML = '<li class="proj-empty">No projects match.</li>'; return; }

    listEl.innerHTML = '';
    for (const p of projs) {
        const cached = projThumbCache[p.id];
        const thumbInner = (p.hasThumb && cached) ? `<img src="${cached}" alt="" />` : '';
        const tags = projTagsOf(p).length
            ? `<div class="proj-tags">${projTagsOf(p).map(t => `<span class="proj-tag">${escapeHtml(t)}</span>`).join('')}</div>` : '';
        const coll = projCollOf(p);
        const li = document.createElement('li');
        li.className = 'proj-row' + (p.id === projectId ? ' current' : '');
        li.innerHTML =
            `<div class="proj-thumb${p.hasThumb ? '' : ' proj-thumb-empty'}" data-thumb="${escapeHtml(p.id)}">${thumbInner}</div>
             <div class="proj-info">
               <div class="proj-name">${escapeHtml(p.title || p.name || p.id)}</div>
               <div class="proj-meta">${coll ? escapeHtml(coll) + ' · ' : ''}${p.origin && p.origin !== 'native' ? escapeHtml(p.origin) + ' · ' : ''}${timeAgo(p.lastModified)}</div>
               ${tags}
             </div>
             ${p.hasDesc ? `<button class="proj-read ghost icon" title="Read description">ⓘ</button>` : ''}
             <button class="proj-dup ghost icon" title="Duplicate project">
               <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
             </button>
             <button class="proj-del ghost" title="Delete project">🗑</button>`;
        li.querySelector('.proj-info').onclick = () => {
            if (p.id === projectId) { closeProjectsModal(); return; }
            location.href = `?id=${encodeURIComponent(p.id)}`;
        };
        const rb = li.querySelector('.proj-read');
        if (rb) rb.onclick = (e) => { e.stopPropagation(); openReadModal(p.id); };
        li.querySelector('.proj-dup').onclick = (e) => { e.stopPropagation(); duplicateProject(p.id); };
        li.querySelector('.proj-del').onclick = async (e) => {
            e.stopPropagation();
            if (confirm(`Delete "${p.title || p.name || p.id}"? This cannot be undone.`)) {
                await removeRegistryEntry(p.id);
                delete projThumbCache[p.id];
                renderProjectsModal();
            }
        };
        listEl.appendChild(li);
    }
    loadVisibleThumbnails();
}

// Fetch thumbnails only for the rows currently shown that have one and aren't cached.
async function loadVisibleThumbnails() {
    const boxes = [...document.querySelectorAll('#modal-project-list .proj-thumb[data-thumb]')]
        .filter(b => !b.classList.contains('proj-thumb-empty') && !(b.dataset.thumb in projThumbCache));
    for (const box of boxes) {
        const id = box.dataset.thumb;
        try {
            const rec = await getProject(id);
            const t = rec && rec.files && rec.files[THUMB_FILE];
            projThumbCache[id] = (typeof t === 'string' && t.startsWith('data:')) ? t : null;
        } catch (e) { projThumbCache[id] = null; }
        if (projThumbCache[id]) {
            const cur = document.querySelector(`#modal-project-list .proj-thumb[data-thumb="${CSS.escape(id)}"]`);
            if (cur) cur.innerHTML = `<img src="${projThumbCache[id]}" alt="" />`;
        }
    }
}

// Reading view for a sketch's description (rendered markdown) from the Projects
// browser — so you can read the instructions without opening the raw README.
async function openReadModal(id) {
    let meta = {};
    try { const rec = await getProject(id); meta = readProjectMeta(rec && rec.files); } catch (e) { /* keep empty */ }
    const reg = getRegistry()[id] || {};
    $('read-title').textContent = meta.title || reg.name || id;
    $('read-open').onclick = () => { location.href = `?id=${encodeURIComponent(id)}`; };
    const tb = $('read-thumb');
    tb.style.display = meta.hasThumb ? '' : 'none';
    tb.innerHTML = meta.hasThumb ? `<img src="${meta.thumbnailData}" alt="" />` : '';
    $('read-meta').textContent = meta.collection || '';
    $('read-meta').style.display = meta.collection ? '' : 'none';
    $('read-tags').innerHTML = (meta.tags || []).map(t => `<span class="proj-tag">${escapeHtml(t)}</span>`).join('');
    $('read-desc').innerHTML = meta.description
        ? mdToHtml(meta.description)
        : '<p class="muted">No description.</p>';
    $('read-overlay').style.display = 'flex';
}
function closeReadModal() { $('read-overlay').style.display = 'none'; }

function newProject() {
    location.href = `?id=${encodeURIComponent(generateProjectName())}`;
}

// Duplicate an existing project into a fresh copy and open it.
async function duplicateProject(id) {
    let rec;
    try { rec = await getProject(id); } catch (e) { alert('Could not read project: ' + e.message); return; }
    if (!rec || !rec.files) { alert('Project has no data to duplicate.'); return; }

    const reg     = getRegistry();
    const srcName = (reg[id] && reg[id].name) || id;
    const origin  = (reg[id] && reg[id].origin) || 'native';

    // Find a free "<name> copy" id (always a new copy, never reusing an existing one).
    const baseName = `${srcName} copy`;
    let name = baseName, newId = slugify(baseName) || ('project-' + Date.now()), n = 2;
    while (getRegistry()[newId]) { name = `${baseName} ${n}`; newId = slugify(name) || `${newId}-${n}`; n++; }

    await putProject(newId, { ...rec.files });
    await upsertRegistryEntry(newId, { name, origin, ...derivedMeta(rec.files) });
    location.href = `?id=${encodeURIComponent(newId)}`;
}

// -----------------------------------------------------------------------------
// PREFERENCES MODAL — theme + editor font/size/tabs (settings.js owns editor prefs).
// -----------------------------------------------------------------------------
function setupSettingsModal() {
    const overlay = $('settings-overlay');

    function populate() {
        $('set-theme').value       = getTheme();
        $('set-font-family').value = editorSettings.fontFamily;
        $('set-font-size').value   = editorSettings.fontSize;
        $('set-tab-size').value    = editorSettings.tabSize;
        $('set-soft-tabs').checked = editorSettings.softTabs;
        $('set-wrap').checked      = editorSettings.wrap;
        $('set-invisibles').checked = editorSettings.showInvisibles;
        $('set-lint').checked      = editorSettings.lint;
    }

    $('settings-btn').onclick   = () => { populate(); overlay.style.display = 'flex'; };
    $('close-settings').onclick = () => { overlay.style.display = 'none'; };
    overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = 'none'; };

    $('set-theme').onchange       = (e) => setTheme(e.target.value);
    $('set-font-family').onchange = (e) => updateSetting('fontFamily', e.target.value);
    $('set-font-size').onchange   = (e) => updateSetting('fontSize', parseInt(e.target.value, 10) || 13);
    $('set-tab-size').onchange    = (e) => updateSetting('tabSize', parseInt(e.target.value, 10) || 2);
    $('set-soft-tabs').onchange   = (e) => updateSetting('softTabs', e.target.checked);
    $('set-wrap').onchange        = (e) => updateSetting('wrap', e.target.checked);
    $('set-invisibles').onchange  = (e) => updateSetting('showInvisibles', e.target.checked);
    $('set-lint').onchange        = (e) => { updateSetting('lint', e.target.checked); lintCurrentFile(); };
}

// -----------------------------------------------------------------------------
// SIDEBAR DRAG-AND-DROP — drop files to add them; a single .zip imports as new.
// -----------------------------------------------------------------------------
function setupSidebarDrop() {
    const side = document.querySelector('.ide-side');
    if (!side) return;
    ['dragenter', 'dragover'].forEach(ev => side.addEventListener(ev, (e) => {
        e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; side.classList.add('drop-target');
    }));
    side.addEventListener('dragleave', (e) => {
        if (!side.contains(e.relatedTarget)) side.classList.remove('drop-target');
    });
    side.addEventListener('drop', (e) => {
        e.preventDefault();
        side.classList.remove('drop-target');
        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;
        if (files.length === 1 && files[0].name.toLowerCase().endsWith('.zip')) {
            if (confirm(`Import "${files[0].name}" as a new project?`)) importZip(files[0], files[0].name);
            return;
        }
        uploadFiles(files);   // add to current project
    });
}

// -----------------------------------------------------------------------------
// PANELS — collapsible file list + drag-to-resize handles (persisted)
// -----------------------------------------------------------------------------
const UI_KEY = 'p5front_ui';
function loadUiPrefs() { try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (e) { return {}; } }
function saveUiPrefs(p) { try { localStorage.setItem(UI_KEY, JSON.stringify(p)); } catch (e) {} }

function setupPanels() {
    const grid    = document.querySelector('.ide-grid');
    const preview = document.querySelector('.ide-preview');
    const prefs   = loadUiPrefs();

    const sideW = prefs.sideW || 210;
    // Collapsed by default on first visit; respect the user's choice once made.
    const startCollapsed = prefs.sideCollapsed !== false;
    applySideCollapsed(grid, startCollapsed, sideW);
    if (prefs.previewW) grid.style.setProperty('--preview-w', prefs.previewW + 'px');
    if (prefs.consoleH) preview.style.setProperty('--console-h', prefs.consoleH + 'px');

    $('toggle-side').onclick = () => {
        const collapsed = !grid.classList.contains('side-collapsed');
        applySideCollapsed(grid, collapsed, loadUiPrefs().sideW || 210);
        const p = loadUiPrefs(); p.sideCollapsed = collapsed; saveUiPrefs(p);
        if (editor) editor.resize();
    };

    makeResizer('rz1', (e) => {
        const r = grid.getBoundingClientRect();
        const w = Math.max(120, Math.min(e.clientX - r.left, r.width - 300));
        grid.style.setProperty('--side-w', w + 'px');
    }, () => {
        const p = loadUiPrefs();
        p.sideW = parseInt(getComputedStyle(grid).getPropertyValue('--side-w')) || 210;
        saveUiPrefs(p);
    });

    makeResizer('rz2', (e) => {
        const r = grid.getBoundingClientRect();
        const w = Math.max(200, Math.min(r.right - e.clientX, r.width - 300));
        grid.style.setProperty('--preview-w', w + 'px');
    }, () => {
        const p = loadUiPrefs();
        p.previewW = parseInt(getComputedStyle(grid).getPropertyValue('--preview-w'));
        saveUiPrefs(p);
    });

    makeResizer('rz3', (e) => {
        const r = preview.getBoundingClientRect();
        const h = Math.max(40, Math.min(r.bottom - e.clientY, r.height - 80));
        preview.style.setProperty('--console-h', h + 'px');
    }, () => {
        const p = loadUiPrefs();
        p.consoleH = parseInt(getComputedStyle(preview).getPropertyValue('--console-h'));
        saveUiPrefs(p);
    });
}

function applySideCollapsed(grid, collapsed, sideW) {
    grid.classList.toggle('side-collapsed', collapsed);
    grid.style.setProperty('--side-w', collapsed ? '0px' : sideW + 'px');
    grid.style.setProperty('--rz1-w', collapsed ? '0px' : '5px');
}

// Attach a drag handler to a resizer element; onMove(e) updates layout, onEnd() persists.
function makeResizer(id, onMove, onEnd) {
    const h = $(id);
    if (!h) return;
    h.addEventListener('mousedown', (e) => {
        e.preventDefault();
        h.classList.add('resizing');
        runner.style.pointerEvents = 'none';   // keep the iframe from swallowing the drag
        document.body.style.userSelect = 'none';
        const move = (ev) => onMove(ev);
        const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            h.classList.remove('resizing');
            runner.style.pointerEvents = '';
            document.body.style.userSelect = '';
            if (editor) editor.resize();
            if (onEnd) onEnd();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    });
}

// -----------------------------------------------------------------------------
// INIT
// -----------------------------------------------------------------------------
async function init() {
    setupEditor();
    applyEditorSettings();   // font size/family/tabs from saved preferences

    // Register the runner service worker early so it controls the preview iframe.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW registration failed:', e));
    }

    // Console/error messages forwarded from the sketch runner.
    window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || d.__p5front !== true) return;
        if (d.type === 'snapshot') return;   // handled per-request in captureThumbnail()
        const cls = d.type === 'error' ? 'err' : (d.type === 'warn' ? 'warn' : '');
        logLine(d.text, cls);
    });

    // Live cross-tab sync: another window changed the registry (create/delete/
    // rename). Refresh the open Projects list and this tab's header name. (Fires
    // only in OTHER tabs; per-project FILE edits live in IndexedDB and don't emit
    // a storage event, so those aren't reflected here.)
    window.addEventListener('storage', (e) => {
        if (e.key !== null && e.key !== LS_REGISTRY_KEY) return;
        const reg = getRegistry();
        if (reg[projectId] && reg[projectId].name && reg[projectId].name !== projectName) {
            projectName = reg[projectId].name;
            pnameEl.value = projectName;
        }
        if ($('projects-overlay').style.display === 'flex') {
            // Registry (incl. the derived meta cache) is already fresh in listProjects().
            renderProjectsModal();
        }
    });

    const params = new URLSearchParams(location.search);

    // Shared link: decode the embedded project, store a copy, open it.
    if (params.has('share')) {
        const map = decodeShare(params.get('share'));
        if (map && Object.keys(map).length) {
            const name = params.get('name') || 'Shared Sketch';
            const { id, name: finalName, existing } = await resolveCollision(name, map);
            if (!existing) {                       // already have this exact project → just open it
                await putProject(id, map);
                await upsertRegistryEntry(id, { name: finalName, origin: 'shared' });
            }
            location.replace(`?id=${encodeURIComponent(id)}`);
        } else {
            alert('This share link is invalid or corrupted.');
            location.replace(location.pathname);
        }
        return;
    }

    // ?zip=<url>: fetch a hosted project zip and import it (asks on name clash).
    if (params.get('zip')) {
        await loadProjectFromURL(params.get('zip'));
        return;
    }

    // ?repo=<root>&project=<folder>: import a project from an exported p5front
    // repository (fetches its files from the folder listed in p5front.json).
    if (params.get('repo')) {
        await loadProjectFromRepo(params.get('repo'), params.get('project'));
        return;
    }

    projectId = params.get('id');
    if (!projectId) {
        // No project specified: reopen the last one edited, else the most recent,
        // else start a fresh project (first visit).
        const reg0 = getRegistry();
        const last = localStorage.getItem(LS_LAST_PROJECT);
        let target = (last && reg0[last]) ? last : null;
        if (!target) {
            const projs = listProjects();
            target = projs.length ? projs[0].id : generateProjectName();
        }
        location.replace(`?id=${encodeURIComponent(target)}`);
        return;
    }

    const rec = await getProject(projectId);
    if (rec && rec.files && Object.keys(rec.files).length) {
        projectFiles = rec.files;
    } else {
        // New project: seed the default template.
        projectFiles = defaultProjectFiles();
        await putProject(projectId, projectFiles);
        await upsertRegistryEntry(projectId, { name: prettify(projectId), origin: 'native', ...derivedMeta(projectFiles) });
    }

    // Repair broken <script> ordering (e.g. some OpenProcessing exports) once, up
    // front — before any editor session is created from these files.
    if (typeof reorderScriptsByDependency === 'function' && projectFiles['index.html']) {
        const fixed = reorderScriptsByDependency(projectFiles);
        if (fixed && fixed !== projectFiles['index.html']) {
            projectFiles['index.html'] = fixed;
            try { await putProject(projectId, projectFiles); } catch (e) { console.warn('reorder save failed', e); }
        }
    }

    const reg = getRegistry();
    projectName = (reg[projectId] && reg[projectId].name) || prettify(projectId);
    pnameEl.value = projectName;

    // Self-heal a stale id (from a past rename) so ?id= matches the project name.
    await maybeMigrateIdOnLoad();

    localStorage.setItem(LS_LAST_PROJECT, projectId);   // remember for the next no-id visit

    currentFile = pickMainSketch();
    openFile(currentFile);
    renderTree();

    setupPanels();
    setupSidebarDrop();
    wireControls();
}

// Pick the file to show first: the main sketch by conventional name, else the
// first JS file that defines setup(), else index.html (or any file as fallback).
function pickMainSketch() {
    const names = Object.keys(projectFiles);
    const byName = names.find(n => /(^|\/)(sketch|mySketch)\.js$/i.test(n));
    if (byName) return byName;

    const jsFiles = names.filter(n => /\.m?js$/i.test(n) && !isBinaryValue(projectFiles[n]));
    const bySetup = jsFiles.find(n => /(^|[^.\w])setup\s*\(/.test(projectFiles[n]));
    if (bySetup) return bySetup;

    return projectFiles['index.html'] ? 'index.html' : names[0];
}

function prettify(id) {
    return id.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
}

function wireControls() {
    $('run-btn').onclick    = runSketch;
    $('stop-btn').onclick   = stopSketch;
    $('view-btn').onclick   = openViewWindow;
    $('export-btn').onclick = exportProject;
    $('share-btn').onclick  = shareProject;
    $('add-file').onclick   = openNewFileModal;
    setupSettingsModal();

    // New file modal
    $('newfile-path').oninput   = updateNewFileOpts;
    $('close-newfile').onclick  = closeNewFileModal;
    $('newfile-cancel').onclick = closeNewFileModal;
    $('newfile-create').onclick = submitNewFile;
    $('newfile-overlay').onclick = (e) => { if (e.target === $('newfile-overlay')) closeNewFileModal(); };
    $('newfile-path').onkeydown = (e) => {
        if (e.key === 'Enter') submitNewFile();
        else if (e.key === 'Escape') closeNewFileModal();
    };

    // Sketch info modal
    $('info-btn').onclick           = openInfoModal;
    $('close-info').onclick         = closeInfoModal;
    $('info-cancel').onclick        = closeInfoModal;
    $('info-save').onclick          = submitInfo;
    $('info-thumb-capture').onclick = infoCaptureThumb;
    $('info-thumb-clear').onclick   = infoClearThumb;
    $('info-overlay').onclick = (e) => { if (e.target === $('info-overlay')) closeInfoModal(); };

    // Read (description) modal
    $('close-read').onclick = closeReadModal;
    $('read-overlay').onclick = (e) => { if (e.target === $('read-overlay')) closeReadModal(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReadModal(); });

    // Add library modal
    $('add-lib').onclick       = openLibModal;
    $('close-addlib').onclick  = closeLibModal;
    $('addlib-cancel').onclick = closeLibModal;
    $('addlib-add').onclick    = submitAddLib;
    $('addlib-overlay').onclick = (e) => { if (e.target === $('addlib-overlay')) closeLibModal(); };
    $('addlib-url').onkeydown = (e) => {
        if (e.key === 'Enter') submitAddLib();
        else if (e.key === 'Escape') closeLibModal();
    };

    // Projects modal
    $('projects-btn').onclick   = openProjectsModal;
    $('close-projects').onclick = closeProjectsModal;
    $('modal-new').onclick      = newProject;
    $('sort-toggle').onclick = () => {
        projectSort = (projectSort === 'date') ? 'alpha' : 'date';
        localStorage.setItem('p5front_sort', projectSort);
        renderProjectsModal();
    };
    $('projects-overlay').onclick = (e) => { if (e.target === $('projects-overlay')) closeProjectsModal(); };
    $('project-filter').oninput = (e) => { projectFilter = e.target.value; renderProjectsModal(); };

    // Export / import all projects (see backup.js)
    $('export-all').onclick = () => exportProjects();
    $('import-all').onclick = () => $('import-all-input').click();
    $('import-all-input').onchange = async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        try {
            const res = await importProjects(f, f.name);
            if (res && res.cancelled) return;
            renderProjectsModal();
            alert(`Import complete — ${res.imported} new, ${res.copied} copied, ` +
                  `${res.overwritten} overwritten, ${res.skipped} skipped.`);
        } catch (err) {
            alert('Import failed: ' + err.message);
        }
    };

    $('upload-file').onclick = () => $('upload-input').click();
    $('upload-input').onchange = (e) => { uploadFiles(e.target.files); e.target.value = ''; };

    $('import-btn').onclick = () => $('file-input').click();
    $('file-input').onchange = (e) => { const f = e.target.files[0]; if (f) importZip(f, f.name); e.target.value = ''; };

    pnameEl.onchange = () => {
        const v = pnameEl.value.trim();
        if (v) renameProject(v);              // relabels and migrates the id to match
        else pnameEl.value = projectName;
    };

    window.addEventListener('beforeunload', () => { syncEditorToFiles(); });
}

window.addEventListener('DOMContentLoaded', init);
