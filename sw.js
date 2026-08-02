// =============================================================================
// SERVICE WORKER — virtual filesystem for the sketch runner
// =============================================================================
// Serves  <scope>/runner/<projectId>/<relPath>  from the project's files in
// IndexedDB. Cross-origin requests (p5 CDN, addon libs) are NOT intercepted, so
// they hit the network normally. Same-origin requests outside /runner/ pass
// through untouched (ide.html, its assets, etc.).
//
// index.html responses get a small instrumentation script injected at the top of
// <head> so console output and errors reach the IDE via postMessage.
// Keep DB_NAME / STORE / VERSION in sync with js/storage.js.
// =============================================================================

const DB_NAME    = 'p5front_db';
const DB_VERSION = 1;
const STORE      = 'files';
const RUNNER_RE  = /\/runner\/([^/]+)\/(.*)$/;

// -----------------------------------------------------------------------------
// LIFECYCLE — activate immediately and take control of open clients.
// -----------------------------------------------------------------------------
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// -----------------------------------------------------------------------------
// MINIMAL IDB (SW cannot import js/storage.js)
// -----------------------------------------------------------------------------
function idbGetProject(id) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = (e) => {
            const db = e.target.result;
            const tx = db.transaction(STORE, 'readonly');
            const g  = tx.objectStore(STORE).get(id);
            g.onsuccess = () => { resolve(g.result || null); db.close(); };
            g.onerror   = () => { reject(g.error); db.close(); };
        };
        req.onerror = () => reject(req.error);
    });
}

// -----------------------------------------------------------------------------
// MIME (mirror of storage.js mimeForPath, minimal)
// -----------------------------------------------------------------------------
const MIME = {
    html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript',
    css: 'text/css', json: 'application/json', txt: 'text/plain', csv: 'text/csv',
    md: 'text/markdown', xml: 'application/xml', svg: 'image/svg+xml',
    vert: 'text/plain', frag: 'text/plain', glsl: 'text/plain', vs: 'text/plain', fs: 'text/plain'
};
function mimeFor(path) {
    const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
    return MIME[ext] || 'application/octet-stream';
}

// -----------------------------------------------------------------------------
// INSTRUMENTATION — injected into index.html so console/errors reach the IDE.
// Runs before p5 and the sketch, so early errors are captured.
// -----------------------------------------------------------------------------
const INSTR = `<script>
(function(){
  function post(type, text){ try{ parent.postMessage({ __p5front:true, type:type, text:text }, '*'); }catch(e){} }
  ['log','info','warn','error','debug'].forEach(function(k){
    var orig = console[k] ? console[k].bind(console) : function(){};
    console[k] = function(){
      orig.apply(null, arguments);
      post(k, Array.prototype.map.call(arguments, function(a){
        try { return (typeof a === 'object') ? JSON.stringify(a) : String(a); } catch(e){ return String(a); }
      }).join(' '));
    };
  });
  window.addEventListener('error', function(e){
    post('error', (e.message || 'Error') + (e.filename ? ' ('+e.filename.split('/').pop()+':'+e.lineno+')' : ''));
  });
  window.addEventListener('unhandledrejection', function(e){
    var r = e.reason; post('error', 'Unhandled rejection: ' + ((r && r.message) || r));
  });
  // Snapshot: the IDE asks for a PNG of the canvas. Force a fresh frame first so
  // WEBGL (whose drawing buffer is cleared after compositing) is read populated.
  window.addEventListener('message', function(e){
    var d = e.data;
    if (!d || d.__p5front_cmd !== 'snapshot') return;
    var out = { __p5front:true, type:'snapshot', rid:d.rid, dataUrl:null, error:null };
    try {
      var cv = document.querySelector('canvas');
      if (!cv) { out.error = 'no-canvas'; }
      else {
        if (typeof window.redraw === 'function') { try { window.redraw(); } catch(_){} }
        out.dataUrl = cv.toDataURL('image/png');
      }
    } catch(err){ out.error = (err && err.name || 'Error') + ': ' + (err && err.message || err); }
    try { parent.postMessage(out, '*'); } catch(_){}
  });
})();
</script>`;

function injectInstrumentation(html) {
    if (/<head[^>]*>/i.test(html)) {
        return html.replace(/<head[^>]*>/i, (m) => m + '\n' + INSTR);
    }
    // No <head> — prepend so it still runs first.
    return INSTR + '\n' + html;
}

// -----------------------------------------------------------------------------
// FETCH
// -----------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;        // CDN / cross-origin → network
    const m = url.pathname.match(RUNNER_RE);
    if (!m) return;                                          // not a runner request → passthrough

    const id      = decodeURIComponent(m[1]);
    const relPath = decodeURIComponent(m[2]) || 'index.html';
    event.respondWith(serveProjectFile(id, relPath));
});

async function serveProjectFile(id, relPath) {
    let rec;
    try { rec = await idbGetProject(id); }
    catch (e) { return new Response('Storage error: ' + e, { status: 500 }); }

    if (!rec || !rec.files) return notFound(`project "${id}"`);
    const v = rec.files[relPath];
    if (v == null) return notFound(relPath);

    const headers = { 'Cache-Control': 'no-store' };

    // Binary stored as data: URL → let the platform decode it into a Response.
    if (typeof v === 'string' && v.startsWith('data:')) {
        return fetch(v);
    }

    let body = v;
    if (/\.html?$/i.test(relPath)) body = injectInstrumentation(body);
    headers['Content-Type'] = mimeFor(relPath);
    return new Response(body, { headers });
}

function notFound(what) {
    return new Response(`p5front runner: not found — ${what}`, {
        status: 404, headers: { 'Content-Type': 'text/plain' }
    });
}
