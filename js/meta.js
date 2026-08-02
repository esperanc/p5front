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

// Serialize a front-matter block (only when there's something to record) + body.
function serializeFrontMatter(data, body) {
    const lines = [];
    if (data.title) lines.push(`title: ${data.title}`);
    if (data.tags && data.tags.length) lines.push(`tags: [${data.tags.join(', ')}]`);
    const front = lines.length ? `---\n${lines.join('\n')}\n---\n\n` : '';
    return front + (body || '');
}

// Read a project's metadata from its files map.
// → { title, tags:[], description, hasThumb, thumbnailData }
function readProjectMeta(files) {
    const { data, body } = parseFrontMatter(files ? files[META_FILE] : '');
    const thumb = files ? files[THUMB_FILE] : null;
    return {
        title: data.title || '',
        tags: Array.isArray(data.tags) ? data.tags : [],
        description: (body || '').trim(),
        hasThumb: typeof thumb === 'string' && thumb.startsWith('data:'),
        thumbnailData: thumb || null
    };
}

// Write title/tags/description back into files[README.md] (mutates `files`).
// Removes the file entirely when nothing is left, to avoid an empty README.
function writeProjectMeta(files, { title = '', tags = [], description = '' } = {}) {
    const cleanTags = (tags || []).map(t => String(t).trim()).filter(Boolean);
    const body = String(description || '').trim();
    if (!title && !cleanTags.length && !body) { delete files[META_FILE]; return; }
    files[META_FILE] = serializeFrontMatter({ title, tags: cleanTags }, body ? body + '\n' : '');
}

// Normalise a free-text tag input ("a, b ,,c") into a clean list.
function parseTagInput(str) {
    return String(str || '').split(',').map(s => s.trim()).filter(Boolean);
}
