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
async function saveProject() {
    if (!projectId) return;
    syncEditorToFiles();
    try {
        await putProject(projectId, projectFiles);
        upsertRegistryEntry(projectId, { name: projectName });
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
    $('info-tags').value  = meta.tags.join(', ');
    $('info-desc').value  = meta.description || '';
    infoThumbData = meta.hasThumb ? meta.thumbnailData : null;
    renderInfoThumb();
    $('info-overlay').style.display = 'flex';
    $('info-title').focus();
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
        description: $('info-desc').value
    });
    if (infoThumbData) projectFiles[THUMB_FILE] = infoThumbData;
    else { delete projectFiles[THUMB_FILE]; delete sessions[THUMB_FILE]; }
    delete projMetaCache[projectId];   // Projects modal will reload fresh meta

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
        upsertRegistryEntry(id, { name: finalName, origin });
        if (warnings.length) console.warn('Import warnings:', warnings);
        location.href = `?id=${encodeURIComponent(id)}`;
    } catch (e) {
        alert('Import failed: ' + e.message);
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
const projMetaCache = {};   // id -> { title, tags, hasThumb, thumb } (session cache)

// Load a project's metadata (from its files in IDB) into the session cache.
async function loadProjectMeta(id) {
    if (projMetaCache[id]) return projMetaCache[id];
    let m = { title: '', tags: [], hasThumb: false, thumb: null };
    try {
        const rec = await getProject(id);
        const meta = readProjectMeta(rec && rec.files);
        m = { title: meta.title, tags: meta.tags, hasThumb: meta.hasThumb, thumb: meta.hasThumb ? meta.thumbnailData : null };
    } catch (e) { /* keep defaults */ }
    projMetaCache[id] = m;
    return m;
}

async function openProjectsModal() {
    await saveProject();
    projMetaCache[projectId] = null; delete projMetaCache[projectId];   // current may have just changed
    projectFilter = '';
    $('project-filter').value = '';
    $('projects-overlay').style.display = 'flex';
    renderProjectsModal();                                  // instant, from the registry
    await Promise.all(listProjects().map(p => loadProjectMeta(p.id)));
    renderProjectsModal();                                  // now with thumbnails, tags, filtering
}
function closeProjectsModal() { $('projects-overlay').style.display = 'none'; }

function projectMatchesFilter(p) {
    const f = projectFilter.trim().toLowerCase();
    if (!f) return true;
    if ((p.name || p.id).toLowerCase().includes(f)) return true;
    const m = projMetaCache[p.id];
    if (m) {
        if ((m.title || '').toLowerCase().includes(f)) return true;
        if (m.tags.some(t => t.toLowerCase().includes(f))) return true;
    }
    return false;
}

function renderProjectsModal() {
    const listEl = $('modal-project-list');
    let projs = listProjects();                       // date desc by default
    if (projectSort === 'alpha') {
        projs = projs.slice().sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    }
    $('sort-toggle').textContent = projectSort === 'date' ? 'Sort: Date' : 'Sort: A–Z';

    if (!projs.length) { listEl.innerHTML = '<li class="proj-empty">No projects yet.</li>'; return; }
    projs = projs.filter(projectMatchesFilter);
    if (!projs.length) { listEl.innerHTML = '<li class="proj-empty">No projects match the filter.</li>'; return; }
    listEl.innerHTML = '';
    for (const p of projs) {
        const m = projMetaCache[p.id];
        const thumb = (m && m.thumb)
            ? `<div class="proj-thumb"><img src="${m.thumb}" alt="" /></div>`
            : `<div class="proj-thumb proj-thumb-empty"></div>`;
        const tags = (m && m.tags && m.tags.length)
            ? `<div class="proj-tags">${m.tags.map(t => `<span class="proj-tag">${escapeHtml(t)}</span>`).join('')}</div>`
            : '';
        const li = document.createElement('li');
        li.className = 'proj-row' + (p.id === projectId ? ' current' : '');
        li.innerHTML =
            `${thumb}
             <div class="proj-info">
               <div class="proj-name">${escapeHtml((m && m.title) || p.name || p.id)}</div>
               <div class="proj-meta">${p.origin && p.origin !== 'native' ? escapeHtml(p.origin) + ' · ' : ''}${timeAgo(p.lastModified)}</div>
               ${tags}
             </div>
             <button class="proj-dup ghost icon" title="Duplicate project">
               <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
             </button>
             <button class="proj-del ghost" title="Delete project">🗑</button>`;
        li.querySelector('.proj-info').onclick = () => {
            if (p.id === projectId) { closeProjectsModal(); return; }
            location.href = `?id=${encodeURIComponent(p.id)}`;
        };
        li.querySelector('.proj-dup').onclick = (e) => { e.stopPropagation(); duplicateProject(p.id); };
        li.querySelector('.proj-del').onclick = (e) => {
            e.stopPropagation();
            if (confirm(`Delete "${p.name || p.id}"? This cannot be undone.`)) {
                removeRegistryEntry(p.id);
                delete projMetaCache[p.id];
                renderProjectsModal();
            }
        };
        listEl.appendChild(li);
    }
}

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
    upsertRegistryEntry(newId, { name, origin });
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

    const params = new URLSearchParams(location.search);

    // Shared link: decode the embedded project, store a copy, open it.
    if (params.has('share')) {
        const map = decodeShare(params.get('share'));
        if (map && Object.keys(map).length) {
            const name = params.get('name') || 'Shared Sketch';
            const { id, name: finalName, existing } = await resolveCollision(name, map);
            if (!existing) {                       // already have this exact project → just open it
                await putProject(id, map);
                upsertRegistryEntry(id, { name: finalName, origin: 'shared' });
            }
            location.replace(`?id=${encodeURIComponent(id)}`);
        } else {
            alert('This share link is invalid or corrupted.');
            location.replace(location.pathname);
        }
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
        upsertRegistryEntry(projectId, { name: prettify(projectId), origin: 'native' });
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
        if (v) { projectName = v; upsertRegistryEntry(projectId, { name: v }); }
        else pnameEl.value = projectName;
    };

    window.addEventListener('beforeunload', () => { syncEditorToFiles(); });
}

window.addEventListener('DOMContentLoaded', init);
