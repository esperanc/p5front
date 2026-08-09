// =============================================================================
// BACKUP — export every project as a single, directly-runnable static repository,
// and import such a repository back into p5front.
// =============================================================================
// Export layout (one folder per project, folder name = project name):
//
//   index.html            ← auto-generated gallery linking to each project
//   p5front.json          ← p5front metadata (auxiliary; folders run without it)
//   <Project Name>/
//     index.html          ← runs directly when hosted (p5 via CDN, relative paths)
//     sketch.js …
//
// Each project folder is self-contained: unzip and host the parent folder and it
// works — no p5front, no Service Worker required.
//
// Depends on: JSZip (global), storage.js (getProject/putProject/listProjects/
// getRegistry/upsertRegistryEntry/resolveCollision/isBinaryValue/isTextPath/
// mimeForPath), formats.js (synthesizeIndexHtml), util.js (slugify/escapeHtml).
// =============================================================================

// ---- Folder-name sanitising ------------------------------------------------
// Strip characters that are illegal in file paths / on common filesystems,
// keep spaces and accents, and avoid trailing dots/spaces (Windows).
function sanitizeFolderName(name) {
    let s = String(name || '')
        .replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/, '')
        .trim();
    return s || 'project';
}

function addFilesToZip(folder, files) {
    for (const path in files) {
        const v = files[path];
        if (isBinaryValue(v)) {
            const comma = v.indexOf(',');
            folder.file(path, v.slice(comma + 1), { base64: true });   // real bytes, no base64 bloat
        } else {
            folder.file(path, v);
        }
    }
}

// ---- Auto-generated root gallery -------------------------------------------
// Plain-text excerpt of a markdown description for a gallery card.
function descExcerpt(md, max = 160) {
    let s = String(md || '')
        .replace(/```[\s\S]*?```/g, ' ')          // code fences
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')     // images
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // links → text
        .replace(/[#>*_`~-]+/g, ' ')               // md punctuation
        .replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max).replace(/\s+\S*$/, '') + '…' : s;
}

// Canonical p5front instance the gallery's "Edit" links point at by default
// (overridable in the exported gallery's UI, persisted to localStorage there).
const CANONICAL_P5FRONT = 'https://esperanc.github.io/p5front/';

// Minimal, dependency-free Markdown → HTML for the gallery's reading view. Covers
// headings, bold/italic, inline & fenced code, links, lists and blockquotes —
// enough for typical sketch READMEs. Source is HTML-escaped first, so only the
// tags we insert are live (no injection from a project's own README).
function mdToHtml(md) {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = s => esc(s)
        .replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${t}</a>`);
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0, para = [], listType = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
    while (i < lines.length) {
        const line = lines[i];
        if (/^```/.test(line)) {
            flushPara(); closeList();
            const buf = []; i++;
            while (i < lines.length && !/^```/.test(lines[i])) { buf.push(esc(lines[i])); i++; }
            i++;   // skip closing fence
            out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
            continue;
        }
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) { flushPara(); closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
        const ul = /^[-*+]\s+(.*)$/.exec(line);
        const ol = /^\d+\.\s+(.*)$/.exec(line);
        if (ul || ol) {
            flushPara();
            const want = ul ? 'ul' : 'ol';
            if (listType && listType !== want) closeList();
            if (!listType) { listType = want; out.push(`<${want}>`); }
            out.push(`<li>${inline((ul || ol)[1])}</li>`);
            i++; continue;
        }
        const bq = /^>\s?(.*)$/.exec(line);
        if (bq) { flushPara(); closeList(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); i++; continue; }
        if (/^\s*$/.test(line)) { flushPara(); closeList(); i++; continue; }
        para.push(line); i++;
    }
    flushPara(); closeList();
    return out.join('\n');
}

function buildGalleryHtml(projects) {
    const data = projects.map(p => ({
        folder: p.folder,
        title: p.title || p.name,
        tags: p.tags || [],
        hasThumb: !!p.hasThumb,
        descHtml: p.description ? mdToHtml(p.description) : '',
        excerpt: descExcerpt(p.description || '')
    }));
    const cards = data.map((p, idx) => {
        const href  = encodeURIComponent(p.folder) + '/';
        const title = escapeHtml(p.title);
        const thumb = p.hasThumb
            ? `<img loading="lazy" src="${href}thumbnail.png" alt="${title}" />`
            : `<span class="thumb-ph">${title}</span>`;
        const tags = p.tags.length
            ? `<div class="tags">${p.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`
            : '';
        const desc = p.excerpt ? `<p class="desc">${escapeHtml(p.excerpt)}</p>` : '';
        return `      <article class="card">
        <button class="thumb" data-detail="${idx}" aria-label="Details for ${title}">${thumb}</button>
        <h2><button class="linkish" data-detail="${idx}">${title}</button></h2>
        ${tags}
        ${desc}
        <div class="actions">
          <a class="btn" href="${href}" target="_blank" rel="noopener" title="Run this sketch standalone">▶ Run</a>
          <a class="btn primary" data-edit="${idx}" href="#" title="Open in a p5front editor">Edit</a>
        </div>
      </article>`;
    }).join('\n');
    const payload = JSON.stringify(data).replace(/</g, '\\u003c');
    const count = data.length;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>p5front projects</title>
  <style>
    :root { --fg:#1a1c20; --soft:#888; --line:#e2e5ea; --accent:#d63384; --card:#fff; --bg:#fafbfc; --soft-bg:#eef0f3; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 1080px; margin: 0 auto; padding: 40px 20px; line-height: 1.5; background: var(--bg); color: var(--fg); }
    h1 { font-size: 1.5rem; margin: 0 0 .2rem; }
    .meta { color: var(--soft); font-size: .85rem; margin: 0 0 1rem; }
    .instance { display: flex; align-items: center; gap: 8px; font-size: .82rem; color: var(--soft); margin: 0 0 1.8rem; flex-wrap: wrap; }
    .instance input { font: inherit; font-size: .82rem; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; min-width: 280px; flex: 1; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
    .thumb { border: 0; padding: 0; cursor: pointer; display: block; width: 100%; aspect-ratio: 1 / 1; background: var(--soft-bg); overflow: hidden; }
    .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .thumb-ph { display: flex; width: 100%; height: 100%; align-items: center; justify-content: center; color: var(--accent); font-weight: 700; padding: 12px; text-align: center; }
    .card h2 { font-size: 1rem; margin: 12px 14px 6px; }
    .linkish { border: 0; background: none; padding: 0; font: inherit; font-weight: 700; color: var(--fg); cursor: pointer; text-align: left; }
    .linkish:hover { color: var(--accent); }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 14px 8px; }
    .tag { font-size: .72rem; color: var(--accent); background: rgba(214,51,132,.1); border-radius: 999px; padding: 2px 9px; }
    .desc { font-size: .82rem; color: var(--soft); margin: 0 14px 12px; }
    .actions { margin: auto 14px 14px; display: flex; gap: 8px; }
    .btn { flex: 1; text-align: center; font-size: .82rem; text-decoration: none; padding: 6px 10px; border-radius: 7px; border: 1px solid var(--line); color: var(--fg); background: var(--card); cursor: pointer; }
    .btn:hover { border-color: var(--accent); color: var(--accent); }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.primary:hover { color: #fff; opacity: .9; }
    /* Reading modal */
    .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); align-items: flex-start; justify-content: center; padding: 5vh 16px; z-index: 10; }
    .sheet { position: relative; background: var(--card); border: 1px solid var(--line); border-radius: 14px; width: 680px; max-width: 100%; max-height: 90vh; overflow-y: auto; padding: 22px 24px 24px; }
    .close { position: absolute; top: 12px; right: 12px; border: 0; background: none; font-size: 18px; color: var(--soft); cursor: pointer; }
    .d-thumb { border-radius: 10px; overflow: hidden; background: var(--soft-bg); margin-bottom: 14px; max-height: 340px; }
    .d-thumb img { width: 100%; height: auto; display: block; object-fit: contain; }
    .sheet h2 { margin: 0 0 8px; font-size: 1.3rem; }
    .d-actions { display: flex; gap: 10px; margin: 16px 0 4px; }
    .d-actions .btn { flex: 0 0 auto; padding: 8px 18px; }
    .md { color: var(--fg); font-size: .92rem; }
    .md h1, .md h2, .md h3 { margin: 1.1em 0 .4em; line-height: 1.25; }
    .md h1 { font-size: 1.25rem; } .md h2 { font-size: 1.1rem; } .md h3 { font-size: 1rem; }
    .md p { margin: .6em 0; }
    .md ul, .md ol { margin: .6em 0; padding-left: 1.4em; }
    .md code { background: var(--soft-bg); border-radius: 4px; padding: 1px 5px; font-size: .88em; }
    .md pre { background: var(--soft-bg); border-radius: 8px; padding: 12px; overflow-x: auto; }
    .md pre code { background: none; padding: 0; }
    .md blockquote { margin: .6em 0; padding-left: 12px; border-left: 3px solid var(--line); color: var(--soft); }
    .md a { color: var(--accent); }
    .muted { color: var(--soft); }
    @media (prefers-color-scheme: dark) {
      :root { --fg:#e6e8eb; --soft:#9aa0aa; --line:#2c313a; --accent:#ef6fb0; --card:#1c1f26; --bg:#16181d; --soft-bg:#23262e; }
    }
  </style>
</head>
<body>
  <h1>p5front projects</h1>
  <p class="meta">${count} sketch${count === 1 ? '' : 'es'} &middot; exported ${new Date().toISOString().slice(0, 10)}</p>
  <label class="instance">Edit opens in: <input id="p5front-url" type="url" spellcheck="false" placeholder="https://your-p5front-instance/" /></label>
  <div class="grid">
${cards}
  </div>

  <div id="detail" class="modal" role="dialog" aria-modal="true">
    <div class="sheet">
      <button id="d-close" class="close" aria-label="Close">✕</button>
      <div id="d-thumb" class="d-thumb"></div>
      <h2 id="d-title"></h2>
      <div id="d-tags" class="tags"></div>
      <div class="d-actions">
        <a id="d-run" class="btn" target="_blank" rel="noopener">▶ Run</a>
        <a id="d-edit" class="btn primary" href="#">Edit in p5front</a>
      </div>
      <div id="d-desc" class="md"></div>
    </div>
  </div>

  <script>
  (function () {
    var PROJECTS = ${payload};
    var CANONICAL_DEFAULT = ${JSON.stringify(CANONICAL_P5FRONT)};
    var LS_KEY = 'p5front_gallery_instance';
    var repoRoot = new URL('.', location.href).href;
    var urlInput = document.getElementById('p5front-url');
    urlInput.value = localStorage.getItem(LS_KEY) || CANONICAL_DEFAULT;
    urlInput.addEventListener('change', function () { localStorage.setItem(LS_KEY, urlInput.value.trim()); });

    function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    function runUrl(folder) { return encodeURIComponent(folder) + '/'; }
    function editUrl(folder) {
      var base = (urlInput.value || CANONICAL_DEFAULT).trim();
      try {
        var u = new URL(base);
        u.searchParams.set('repo', repoRoot);
        u.searchParams.set('project', folder);
        return u.href;
      } catch (e) { return '#'; }
    }
    function openEdit(folder) { var u = editUrl(folder); if (u !== '#') window.open(u, '_blank', 'noopener'); }

    var modal = document.getElementById('detail');
    function openDetail(idx) {
      var p = PROJECTS[idx];
      document.getElementById('d-title').textContent = p.title;
      document.getElementById('d-tags').innerHTML = p.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('');
      var tb = document.getElementById('d-thumb');
      tb.innerHTML = p.hasThumb ? '<img src="' + encodeURIComponent(p.folder) + '/thumbnail.png" alt="">' : '';
      tb.style.display = p.hasThumb ? '' : 'none';
      document.getElementById('d-desc').innerHTML = p.descHtml || '<p class="muted">No description.</p>';
      document.getElementById('d-run').href = runUrl(p.folder);
      document.getElementById('d-edit').onclick = function (e) { e.preventDefault(); openEdit(p.folder); };
      modal.style.display = 'flex';
    }
    function closeDetail() { modal.style.display = 'none'; }

    document.querySelectorAll('[data-detail]').forEach(function (el) {
      el.addEventListener('click', function () { openDetail(+el.dataset.detail); });
    });
    document.querySelectorAll('[data-edit]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); openEdit(PROJECTS[+a.dataset.edit].folder); });
    });
    document.getElementById('d-close').addEventListener('click', closeDetail);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeDetail(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });
  })();
  </script>
</body>
</html>
`;
}

// ---- Export -----------------------------------------------------------------
async function exportProjects() {
    const projs = listProjects();
    if (!projs.length) { alert('No projects to export.'); return; }

    const zip = new JSZip();
    const manifest = {
        format: 'p5front-export', version: 1,
        createdAt: new Date().toISOString(),
        projects: []
    };
    const usedFolders = new Set();

    for (const p of projs) {
        let rec;
        try { rec = await getProject(p.id); } catch (e) { console.warn('skip', p.id, e); continue; }
        if (!rec || !rec.files) continue;

        // Unique, filesystem-safe folder name derived from the project name.
        let folder = sanitizeFolderName(p.name || p.id);
        const base = folder;
        let n = 2;
        while (usedFolders.has(folder.toLowerCase())) folder = `${base} (${n++})`;
        usedFolders.add(folder.toLowerCase());

        addFilesToZip(zip.folder(folder), rec.files);
        const meta = (typeof readProjectMeta === 'function') ? readProjectMeta(rec.files) : { tags: [], hasThumb: false };
        manifest.projects.push({
            folder, id: p.id, name: p.name || p.id,
            origin: p.origin || 'native', lastModified: p.lastModified || Date.now(),
            title: meta.title || '', tags: meta.tags || [],
            description: meta.description || '', hasThumb: !!meta.hasThumb,
            files: Object.keys(rec.files)   // for ?repo= loading into a canonical p5front
        });
    }

    if (!manifest.projects.length) { alert('Nothing to export.'); return; }

    zip.file('p5front.json', JSON.stringify(manifest, null, 2));
    zip.file('index.html', buildGalleryHtml(manifest.projects));
    // Disable GitHub Pages' Jekyll so every file (notably front-matter README.md)
    // is served verbatim — otherwise Jekyll renders README.md to README.html and
    // the raw .md 404s, breaking ?repo= loading of that project's metadata.
    zip.file('.nojekyll', '');

    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `p5front-export-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
}

// ---- Conflict dialog (one choice for the whole import) ----------------------
// Resolves to 'both' | 'overwrite' | 'skip' | null (cancel).
function askConflictPolicy() {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML =
            `<div class="modal-dialog" style="width:420px">
               <div class="modal-head"><strong>Some projects already exist</strong></div>
               <div class="modal-body">
                 <p style="margin:0 0 12px">How should projects that already exist be handled?</p>
                 <div style="display:flex; flex-direction:column; gap:8px">
                   <button data-v="both" class="primary">Keep both (import as copies)</button>
                   <button data-v="overwrite">Overwrite existing</button>
                   <button data-v="skip">Skip existing</button>
                   <button data-v="cancel" class="ghost">Cancel import</button>
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

// ---- Import -----------------------------------------------------------------
// Accepts a p5front export (with p5front.json) OR any zip of projects — one per
// folder — with NO manifest. A "project" is any directory that directly contains
// an index.html; this handles folders at the top level, folders inside a wrapping
// container folder, and a single project at the archive root. A root-level
// index.html (a gallery) is ignored when deeper projects exist. Without any
// index.html at all, each top-level folder is taken as a project (index.html is
// then synthesized).
// Returns { imported, copied, overwritten, skipped } or { cancelled:true }.
async function importProjects(blob, filenameHint) {
    const zip = await JSZip.loadAsync(blob);

    // Manifest (optional) — keyed by folder name.
    const metaByFolder = {};
    const mf = zip.file('p5front.json');
    if (mf) {
        try {
            const manifest = JSON.parse(await mf.async('string'));
            if (manifest && Array.isArray(manifest.projects)) {
                for (const p of manifest.projects) metaByFolder[p.folder] = p;
            }
        } catch (e) { console.warn('Bad p5front.json, ignoring:', e); }
    }

    // Index the archive and find directories that directly hold an index.html.
    const allFiles = {};
    const rootsWithIndex = new Set();
    for (const path in zip.files) {
        const entry = zip.files[path];
        if (entry.dir) continue;
        if (path.startsWith('__MACOSX/') || /(^|\/)\.(DS_Store|nojekyll)$/.test(path)) continue;
        allFiles[path] = entry;
        const parts = path.split('/');
        if (/^index\.html?$/i.test(parts[parts.length - 1])) {
            rootsWithIndex.add(parts.slice(0, -1).join('/'));   // '' = archive root
        }
    }

    // Decide the project roots.
    let roots;
    if (rootsWithIndex.size) {
        const nonRoot = [...rootsWithIndex].filter(d => d !== '');
        roots = nonRoot.length ? nonRoot : [''];   // ignore a root gallery when deeper projects exist
    } else {
        const top = new Set();
        for (const path in allFiles) { const i = path.indexOf('/'); if (i > 0) top.add(path.slice(0, i)); }
        roots = [...top];
    }
    if (!roots.length) throw new Error('No projects found in the archive.');

    const rootPrefixes = roots.map(d => (d ? d + '/' : ''));
    const results = { imported: 0, copied: 0, overwritten: 0, skipped: 0 };
    let policy = null;

    for (const dir of roots) {
        const prefix = dir ? dir + '/' : '';
        const deeper = rootPrefixes.filter(p => p !== prefix && p.startsWith(prefix));

        // Collect this project's files, excluding anything owned by a nested project.
        const files = {};
        for (const path in allFiles) {
            if (!path.startsWith(prefix)) continue;
            if (deeper.some(dp => path.startsWith(dp))) continue;
            const rel = path.slice(prefix.length);
            if (!rel) continue;
            const entry = allFiles[path];
            if (isTextPath(rel)) files[rel] = await entry.async('string');
            else                 files[rel] = `data:${mimeForPath(rel)};base64,${await entry.async('base64')}`;
        }
        if (!Object.keys(files).length) continue;
        if (!files['index.html'] && typeof synthesizeIndexHtml === 'function') {
            files['index.html'] = synthesizeIndexHtml(files);
        }

        // Name / id: manifest first, else the folder's own name (or the zip name
        // for a single project sitting at the archive root).
        const segs = dir.split('/').filter(Boolean);
        const folderName = segs.length
            ? segs[segs.length - 1]
            : ((filenameHint || '').replace(/\.zip$/i, '').trim() || 'Imported Sketch');
        const meta   = metaByFolder[dir] || metaByFolder[folderName] || {};
        const name   = meta.name || folderName;
        const origin = meta.origin || 'imported';
        let id       = meta.id || slugify(name) || ('project-' + Date.now());

        // Find the existing project this one corresponds to. Without a manifest the
        // id is derived from the name, which won't match a project that was renamed
        // (its id is fixed) — so also match an existing project whose name maps to
        // the same slug. Otherwise "skip" would fail to see the conflict and import
        // a duplicate.
        const reg = getRegistry();
        const existingId =
              (meta.id && reg[meta.id]) ? meta.id
            : reg[id]                   ? id
            : (Object.values(reg).find(e => slugify(e.name || e.id) === id) || {}).id || null;

        if (existingId) {
            if (!policy) {
                policy = await askConflictPolicy();
                if (!policy) return { cancelled: true };
            }
            if (policy === 'skip')      { results.skipped++; continue; }
            if (policy === 'overwrite') { id = existingId; results.overwritten++; }
            else {  // both
                const r = await resolveCollision(name, files);
                if (r.existing) { results.skipped++; continue; }   // identical copy already present
                id = r.id; results.copied++;
            }
        } else {
            results.imported++;
        }

        await putProject(id, files);
        await upsertRegistryEntry(id, { name, origin });
    }

    return results;
}
