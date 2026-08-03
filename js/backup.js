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

function buildGalleryHtml(projects) {
    const cards = projects.map(p => {
        const href  = encodeURIComponent(p.folder) + '/';
        const title = escapeHtml(p.title || p.name);
        const thumb = p.hasThumb
            ? `<a href="${href}" class="thumb"><img loading="lazy" src="${href}thumbnail.png" alt="${title}" /></a>`
            : `<a href="${href}" class="thumb thumb-empty"><span>${title}</span></a>`;
        const tags = (p.tags && p.tags.length)
            ? `<div class="tags">${p.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`
            : '';
        const desc = p.description ? `<p class="desc">${escapeHtml(descExcerpt(p.description))}</p>` : '';
        return `      <article class="card">
        ${thumb}
        <h2><a href="${href}">${title}</a></h2>
        ${tags}
        ${desc}
      </article>`;
    }).join('\n');
    const count = projects.length;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>p5front projects</title>
  <style>
    :root { --fg:#1a1c20; --soft:#888; --line:#e2e5ea; --accent:#d63384; --card:#fff; --bg:#fafbfc; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 1080px; margin: 0 auto; padding: 40px 20px; line-height: 1.5; background: var(--bg); color: var(--fg); }
    h1 { font-size: 1.5rem; margin: 0 0 .2rem; }
    .meta { color: var(--soft); font-size: .85rem; margin: 0 0 1.8rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
    .thumb { display: block; aspect-ratio: 1 / 1; background: #f0f1f4; overflow: hidden; }
    .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .thumb-empty { display: flex; align-items: center; justify-content: center; color: var(--accent); font-weight: 700; text-decoration: none; padding: 12px; text-align: center; }
    .card h2 { font-size: 1rem; margin: 12px 14px 6px; }
    .card h2 a { color: var(--fg); text-decoration: none; }
    .card h2 a:hover { color: var(--accent); }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 14px 8px; }
    .tag { font-size: .72rem; color: var(--accent); background: rgba(214,51,132,.1); border-radius: 999px; padding: 2px 9px; }
    .desc { font-size: .82rem; color: var(--soft); margin: 0 14px 14px; }
    @media (prefers-color-scheme: dark) {
      :root { --fg:#e6e8eb; --soft:#9aa0aa; --line:#2c313a; --accent:#ef6fb0; --card:#1c1f26; --bg:#16181d; }
      .thumb { background: #23262e; }
    }
  </style>
</head>
<body>
  <h1>p5front projects</h1>
  <p class="meta">${count} sketch${count === 1 ? '' : 'es'} &middot; exported ${new Date().toISOString().slice(0, 10)}</p>
  <div class="grid">
${cards}
  </div>
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
            description: meta.description || '', hasThumb: !!meta.hasThumb
        });
    }

    if (!manifest.projects.length) { alert('Nothing to export.'); return; }

    zip.file('p5front.json', JSON.stringify(manifest, null, 2));
    zip.file('index.html', buildGalleryHtml(manifest.projects));

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
        if (path.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(path)) continue;
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
