// =============================================================================
// HELP — the Shortcuts and About panels of the Preferences modal.
// =============================================================================
// The shortcut list stores command NAMES, never key text: the keys shown are
// read from Ace's live keymap (editor.commands) when the panel is rendered, so
// they cannot drift from what actually happens. A row whose command is missing
// or unbound is skipped, which keeps the panel honest across Ace upgrades.
// Depends on: Ace (global), ide_ui.js (globals `editor`, `listProjects`),
// formats.js (P5_CDN).
// =============================================================================

// [command name, label]. Commands marked `app` are p5front's own (see setupEditor).
const SHORTCUT_GROUPS = [
    ['Sketch', [
        ['runsketch',          'Run the sketch'],
        ['stopsketch',         'Stop the sketch'],
        ['savesketch',         'Save now (edits also autosave)'],
        ['showpreferences',    'Open Preferences'],
    ]],
    ['Editing', [
        ['reindent',           'Reindent file or selection'],
        ['togglecomment',      'Comment / uncomment lines'],
        ['toggleBlockComment', 'Block comment'],
        ['removeline',         'Delete line'],
        ['duplicateSelection', 'Duplicate line or selection'],
        ['movelinesup',        'Move lines up'],
        ['movelinesdown',      'Move lines down'],
        ['blockindent',        'Indent block'],
        ['blockoutdent',       'Outdent block'],
        ['undo',               'Undo'],
        ['redo',               'Redo'],
    ]],
    ['Search & navigation', [
        ['find',               'Find'],
        ['findnext',           'Find next'],
        ['findprevious',       'Find previous'],
        ['replace',            'Replace'],
        ['gotoline',           'Go to line'],
        ['jumptomatching',     'Jump to matching bracket'],
        ['fold',               'Fold selection'],
        ['unfold',             'Unfold'],
    ]],
    ['Multiple cursors & selection', [
        ['addCursorAbove',     'Add cursor above'],
        ['addCursorBelow',     'Add cursor below'],
        ['selectMoreAfter',    'Select next occurrence'],
        ['expandtoline',       'Select whole line'],
        ['selectall',          'Select all'],
    ]],
];

// Modifier names as Ace writes them → the symbols macOS users expect.
const KEY_SYMBOLS = { Command: '⌘', Cmd: '⌘', Option: '⌥', Alt: '⌥', Ctrl: '⌃', Shift: '⇧' };
const KEY_NAMES   = { Left: '←', Right: '→', Up: '↑', Down: '↓', Return: '↵', Enter: '↵' };

function isMacPlatform() {
    try { return !!ace.require('ace/lib/useragent').isMac; } catch (e) { return false; }
}

// The binding Ace would actually fire on this platform, as display text.
// bindKey is "Ctrl-X", { win, mac }, or alternatives joined by "|" (first wins).
function formatBinding(name) {
    const cmd = editor && editor.commands.commands[name];
    if (!cmd || !cmd.bindKey) return null;
    const mac = isMacPlatform();
    const raw = typeof cmd.bindKey === 'string' ? cmd.bindKey : (mac ? cmd.bindKey.mac : cmd.bindKey.win);
    if (!raw) return null;
    const keys = raw.split('|')[0].split('-')
        .map(k => (mac && KEY_SYMBOLS[k]) || KEY_NAMES[k] || k);
    return mac ? keys.join('') : keys.join('+');
}

function renderShortcuts() {
    const host = document.getElementById('tab-shortcuts');
    if (!host) return;
    let html = '';
    for (const [group, rows] of SHORTCUT_GROUPS) {
        const items = rows
            .map(([name, label]) => [formatBinding(name), label])
            .filter(([keys]) => keys)
            .map(([keys, label]) =>
                `<div class="key-row"><span>${escapeHtml(label)}</span><kbd>${escapeHtml(keys)}</kbd></div>`)
            .join('');
        if (items) html += `<div class="key-group"><h4>${escapeHtml(group)}</h4>${items}</div>`;
    }
    html += `<p class="modal-hint">Shortcuts act on the editor, so click in it first.
             Dialogs close with <kbd>Esc</kbd>, and the New file / Add library dialogs
             submit with <kbd>${isMacPlatform() ? '↵' : 'Enter'}</kbd>.</p>`;
    host.innerHTML = html;
}

// --- About -------------------------------------------------------------------
// Versions are read from the page and from formats.js rather than restated here,
// so this panel cannot go stale when a CDN URL is bumped.
// Ace injects extra <script> tags for the modes and extensions it lazy-loads, so
// the same library shows up several times — keep the first of each.
const LIB_NAMES = { ace: 'Ace', jszip: 'JSZip', acorn: 'Acorn', 'lz-string': 'LZ-String' };

function cdnLibraries() {
    const seen = new Map();
    document.querySelectorAll('script[src^="https://"]').forEach(s => {
        const m = s.src.match(/\/ajax\/libs\/([^/]+)\/([^/]+)\//)      // cdnjs
               || s.src.match(/\/npm\/([^@/]+)@([^/]+)\//);            // jsdelivr
        if (m && !seen.has(m[1])) seen.set(m[1], { name: LIB_NAMES[m[1]] || m[1], version: m[2] });
    });
    return [...seen.values()];
}

async function renderAbout() {
    const host = document.getElementById('tab-about');
    if (!host) return;

    const p5v = (typeof P5_CDN === 'string' && (P5_CDN.match(/p5@([^/]+)/) || [])[1]) || '2.x';
    const libs = cdnLibraries()
        .map(l => `<div class="key-row"><span>${escapeHtml(l.name)}</span><code>${escapeHtml(l.version)}</code></div>`)
        .join('');

    const projects = (typeof listProjects === 'function') ? listProjects().length : 0;
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller ? 'active' : 'not controlling this page';

    host.innerHTML = `
      <div class="about-lede">
        <strong>p5front</strong> — a browser-based IDE for creative coding with p5.js v2.
        No accounts, no build step, no server: projects live in this browser.
      </div>
      <div class="key-group">
        <h4>Runtime</h4>
        <div class="key-row"><span>p5.js used by new sketches</span><code>${escapeHtml(p5v)}</code></div>
        ${libs}
      </div>
      <div class="key-group">
        <h4>This browser</h4>
        <div class="key-row"><span>Projects stored</span><code>${projects}</code></div>
        <div class="key-row"><span>Storage used</span><code id="about-storage">…</code></div>
        <div class="key-row"><span>Service Worker</span><code>${escapeHtml(sw)}</code></div>
      </div>
      <p class="modal-hint">
        <a href="https://github.com/esperanc/p5front" target="_blank" rel="noopener">Source on GitHub</a>
        · Released under a noncommercial license — see <code>LICENSE</code> in the repository.
      </p>`;

    // Quota is async and may be unavailable (Safari, private windows).
    const cell = document.getElementById('about-storage');
    try {
        const { usage, quota } = await navigator.storage.estimate();
        const size = (n) => n < 1048576 ? Math.round(n / 1024) + ' KB'
                                        : (n / 1048576).toFixed(1) + ' MB';
        cell.textContent = quota ? `${size(usage)} of ${size(quota)}` : size(usage);
    } catch (e) {
        cell.textContent = 'unavailable';
    }
}
