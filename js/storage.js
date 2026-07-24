// =============================================================================
// STORAGE — Hybrid persistence: registry in localStorage, files in IndexedDB
// =============================================================================
// Canonical model:
//   projectFiles = { [relPath]: string | "data:<mime>;base64,..." }
//   entry point is always "index.html"
//
// IndexedDB  (async, large):  store "files" keyPath "id"  →  { id, files }
// localStorage (sync, small): "p5front_projects_index"    →  { [id]: {id,name,origin,lastModified} }
// =============================================================================

const DB_NAME     = 'p5front_db';
const DB_VERSION  = 1;
const STORE_FILES = 'files';
const LS_REGISTRY_KEY = 'p5front_projects_index';

// -----------------------------------------------------------------------------
// MODEL HELPERS
// -----------------------------------------------------------------------------
const TEXT_EXTS = [
    '.html', '.htm', '.js', '.mjs', '.css', '.txt', '.json', '.csv',
    '.md', '.xml', '.svg', '.toml', '.yaml', '.yml',
    '.vert', '.frag', '.glsl', '.glslv', '.glslf', '.vs', '.fs'
];

const MIME_MAP = {
    '.html': 'text/html', '.htm': 'text/html',
    '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json',
    '.txt': 'text/plain', '.csv': 'text/csv', '.md': 'text/markdown',
    '.xml': 'application/xml', '.svg': 'image/svg+xml',
    '.toml': 'text/plain', '.yaml': 'text/plain', '.yml': 'text/plain',
    '.vert': 'text/plain', '.frag': 'text/plain', '.glsl': 'text/plain',
    '.glslv': 'text/plain', '.glslf': 'text/plain', '.vs': 'text/plain', '.fs': 'text/plain',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.ico': 'image/x-icon', '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.obj': 'text/plain', '.mtl': 'text/plain', '.stl': 'application/octet-stream',
    '.pdf': 'application/pdf'
};

function extOf(path) {
    const i = path.lastIndexOf('.');
    return i >= 0 ? path.slice(i).toLowerCase() : '';
}

function isTextPath(path) {
    return TEXT_EXTS.includes(extOf(path));
}

function isBinaryValue(v) {
    return typeof v === 'string' && v.startsWith('data:');
}

function mimeForPath(path) {
    return MIME_MAP[extOf(path)] || 'application/octet-stream';
}

// -----------------------------------------------------------------------------
// INDEXEDDB
// -----------------------------------------------------------------------------
let _dbPromise = null;

function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_FILES)) {
                db.createObjectStore(STORE_FILES, { keyPath: 'id' });
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => { _dbPromise = null; reject(e.target.error); };
        req.onblocked = () => console.warn('[IDB] open blocked — close other tabs.');
    });
    return _dbPromise;
}

function getProject(id) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_FILES, 'readonly');
        const req = tx.objectStore(STORE_FILES).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror   = () => reject(req.error);
    }));
}

// Resolves on tx.oncomplete (fully committed) so later reads never see stale data.
function putProject(id, files) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_FILES, 'readwrite');
        tx.objectStore(STORE_FILES).put({ id, files });
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
    }));
}

function deleteProject(id) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_FILES, 'readwrite');
        tx.objectStore(STORE_FILES).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
    }));
}

// -----------------------------------------------------------------------------
// REGISTRY (localStorage, synchronous)
// -----------------------------------------------------------------------------
function getRegistry() {
    try {
        const raw = localStorage.getItem(LS_REGISTRY_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        console.error('Registry parse error:', e);
        return {};
    }
}

function saveRegistry(reg) {
    try {
        localStorage.setItem(LS_REGISTRY_KEY, JSON.stringify(reg));
    } catch (e) {
        console.warn('Failed to save registry:', e);
    }
}

function upsertRegistryEntry(id, { name, origin } = {}) {
    const reg = getRegistry();
    const entry = reg[id] || { id };
    if (name   !== undefined) entry.name   = name;
    if (origin !== undefined) entry.origin = origin;
    if (entry.name === undefined) entry.name = id;
    entry.id = id;
    entry.lastModified = Date.now();
    reg[id] = entry;
    saveRegistry(reg);
    return entry;
}

// Removes registry entry (sync) and file data from IDB (async, fire-and-forget).
function removeRegistryEntry(id) {
    const reg = getRegistry();
    if (reg[id]) { delete reg[id]; saveRegistry(reg); }
    return deleteProject(id).catch(e => console.warn(`IDB delete failed for "${id}":`, e));
}

function listProjects() {
    const reg = getRegistry();
    return Object.values(reg).sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
}

// -----------------------------------------------------------------------------
// COLLISION RESOLUTION — pick a free ID; reuse an identical existing project.
// Returns { id, name, existing }.
// -----------------------------------------------------------------------------
function areFilesEqual(a, b) {
    if (!a || !b) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (a[k] !== b[k]) return false;
    return true;
}

async function resolveCollision(name, files) {
    const reg = getRegistry();
    const base = slugify(name) || ('project-' + Date.now());
    let id = base, counter = 1;

    while (reg[id]) {
        try {
            const existing = await getProject(id);
            if (existing && areFilesEqual(existing.files, files)) {
                return { id, name: reg[id].name, existing: true };
            }
        } catch (e) { console.error('collision check failed', e); }
        id = `${base}-${counter++}`;
    }

    const finalName = counter > 1 ? `${name} (${counter - 1})` : name;
    return { id, name: finalName, existing: false };
}
