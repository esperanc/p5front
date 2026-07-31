// =============================================================================
// UTIL — small shared helpers (classic script, no modules)
// =============================================================================

// Turn arbitrary text into a URL/ID-safe slug.
function slugify(text) {
    return String(text)
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w\-]+/g, '')
        .replace(/\-\-+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
}

// Readable random project name, e.g. "brave-harbor".
const _NAME_ADJ = ['brave', 'calm', 'clever', 'bright', 'lucky', 'mellow', 'swift',
    'gentle', 'bold', 'quiet', 'sunny', 'lively', 'cosmic', 'noble', 'wild'];
const _NAME_NOUN = ['harbor', 'meadow', 'river', 'canyon', 'forest', 'comet', 'lantern',
    'garden', 'pixel', 'ember', 'circuit', 'prism', 'orbit', 'ripple', 'spark'];

function generateProjectName() {
    const a = _NAME_ADJ[Math.floor(Math.random() * _NAME_ADJ.length)];
    const n = _NAME_NOUN[Math.floor(Math.random() * _NAME_NOUN.length)];
    return `${a}-${n}`;
}

// Escape for safe insertion into innerHTML text nodes / attributes.
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// -----------------------------------------------------------------------------
// THEME — 'auto' | 'light' | 'dark' (persisted, shared across pages)
// -----------------------------------------------------------------------------
const THEME_KEY = 'p5front_theme';
const THEME_CYCLE = ['auto', 'light', 'dark'];
const THEME_ICON = { auto: '🌓', light: '☀️', dark: '🌙' };

function getTheme() {
    const t = localStorage.getItem(THEME_KEY);
    return THEME_CYCLE.includes(t) ? t : 'auto';
}

// The effective light/dark after resolving 'auto' against the OS preference.
function effectiveTheme() {
    const t = getTheme();
    if (t !== 'auto') return t;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Logo variant chosen once per page load (1..3); the light/dark image for this
// variant is picked to match the effective theme.
const LOGO_N = 1 + Math.floor(Math.random() * 3);

function updateLogo() {
    const img = document.getElementById('logo-img');
    if (!img) return;
    img.src = effectiveTheme() === 'dark'
        ? `logo/darklogo${LOGO_N}.png`
        : `logo/lightLogo${LOGO_N}.png`;
}

function applyTheme(theme) {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    // Keep any Ace editor in sync (guarded — the landing page has no editor).
    if (typeof editor !== 'undefined' && editor && editor.setTheme) {
        editor.setTheme(effectiveTheme() === 'dark' ? 'ace/theme/tomorrow_night' : 'ace/theme/tomorrow');
    }
    // Swap the logo image to match the effective theme (guarded — not every page has it).
    updateLogo();
    // Refresh the toggle button label if present.
    const btn = document.getElementById('theme-btn');
    if (btn) { btn.textContent = THEME_ICON[getTheme()]; btn.title = `Theme: ${getTheme()}`; }
}

function cycleTheme() {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(getTheme()) + 1) % THEME_CYCLE.length];
    setTheme(next);
}

function setTheme(theme) {
    if (!THEME_CYCLE.includes(theme)) theme = 'auto';
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
}

// Apply the saved theme as early as possible (called at script load on each page).
applyTheme(getTheme());

// In 'auto' mode, follow live OS theme changes.
try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (getTheme() === 'auto') applyTheme('auto');
    });
} catch (e) { /* older browsers: ignore */ }

// Human-friendly relative time for the project list.
function timeAgo(ts) {
    if (!ts) return '';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(ts).toLocaleDateString();
}
