// =============================================================================
// META — per-sketch metadata stored as project files (single source of truth).
// =============================================================================
// Metadata lives inside the project so it travels through zip export/import,
// share links and the self-contained GitHub Pages folder with no schema change:
//
//   README.md        ← YAML-ish front-matter (title, tags) + markdown body
//   thumbnail.png     ← canvas snapshot (data URL, like any binary asset)
//
// The front-matter is intentionally tiny (title + tags); anything richer is just
// markdown in the body. No YAML dependency — a few lines parse what we emit.
// Depends on: nothing (pure helpers on a { [path]: value } files map).
// =============================================================================

const META_FILE  = 'README.md';
const THUMB_FILE = 'thumbnail.png';

// Parse `title:` / `tags:` from a front-matter block and return { data, body }.
// Accepts `tags: [a, b]` or `tags: a, b`. No front-matter → all body.
function parseFrontMatter(md) {
    const text = String(md || '');
    const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
    if (!m) return { data: {}, body: text };
    const data = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (!kv) continue;
        const key = kv[1].toLowerCase();
        let val = kv[2].trim();
        if (key === 'tags') {
            val = val.replace(/^\[|\]$/g, '');                    // strip optional [ ]
            data.tags = val.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        } else {
            data[key] = val.replace(/^["']|["']$/g, '');
        }
    }
    return { data, body: text.slice(m[0].length) };
}

// Normalise a collection path ("/Art//Generative/ " → "Art/Generative"): a
// slash-delimited, single-home classification. Empty → '' (uncollected).
function normalizeCollection(str) {
    return String(str || '').split('/').map(s => s.trim()).filter(Boolean).join('/');
}

// Serialize a front-matter block (only when there's something to record) + body.
function serializeFrontMatter(data, body) {
    const lines = [];
    if (data.title) lines.push(`title: ${data.title}`);
    if (data.tags && data.tags.length) lines.push(`tags: [${data.tags.join(', ')}]`);
    if (data.collection) lines.push(`collection: ${data.collection}`);
    const front = lines.length ? `---\n${lines.join('\n')}\n---\n\n` : '';
    return front + (body || '');
}

// Read a project's metadata from its files map.
// → { title, tags:[], collection, description, hasThumb, thumbnailData }
function readProjectMeta(files) {
    const { data, body } = parseFrontMatter(files ? files[META_FILE] : '');
    const thumb = files ? files[THUMB_FILE] : null;
    return {
        title: data.title || '',
        tags: Array.isArray(data.tags) ? data.tags : [],
        collection: normalizeCollection(data.collection),
        description: (body || '').trim(),
        hasThumb: typeof thumb === 'string' && thumb.startsWith('data:'),
        thumbnailData: thumb || null
    };
}

// Write title/tags/collection/description back into files[README.md] (mutates
// `files`). Removes the file entirely when nothing is left, to avoid an empty README.
function writeProjectMeta(files, { title = '', tags = [], collection = '', description = '' } = {}) {
    const cleanTags = (tags || []).map(t => String(t).trim()).filter(Boolean);
    const coll = normalizeCollection(collection);
    const body = String(description || '').trim();
    if (!title && !cleanTags.length && !coll && !body) { delete files[META_FILE]; return; }
    files[META_FILE] = serializeFrontMatter({ title, tags: cleanTags, collection: coll }, body ? body + '\n' : '');
}

// Normalise a free-text tag input ("a, b ,,c") into a clean list.
function parseTagInput(str) {
    return String(str || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Minimal, dependency-free Markdown → HTML for reading a sketch's description
// (Projects browser + exported gallery). Covers headings, bold/italic, inline &
// fenced code, links, lists and blockquotes — enough for typical READMEs. Source
// is HTML-escaped first, so only the tags we insert are live (no injection).
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
