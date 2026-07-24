// =============================================================================
// SETTINGS — editor preferences (persisted). Theme lives in util.js (p5front_theme);
// this module owns the Ace-specific prefs: font size/family, tabs, invisibles.
// Depends on: Ace editor (global `editor`, may not exist yet at load).
// =============================================================================

const SETTINGS_KEY = 'p5front_settings';

const DEFAULT_SETTINGS = {
    fontSize: 13,
    fontFamily: 'mono',
    tabSize: 2,
    softTabs: true,
    showInvisibles: false,
    wrap: false,
    lint: true          // Acorn-based JS syntax check (see ide_ui.js lintCurrentFile)
};

// Friendly key → CSS font stack (all rely on locally installed fonts).
const FONT_FAMILIES = {
    mono:     'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    menlo:    'Menlo, monospace',
    monaco:   'Monaco, monospace',
    consolas: 'Consolas, "Liberation Mono", monospace',
    courier:  '"Courier New", Courier, monospace',
    sfmono:   '"SF Mono", ui-monospace, monospace',
    jetbrains:'"JetBrains Mono", ui-monospace, monospace',
    fira:     '"Fira Code", ui-monospace, monospace'
};

let editorSettings = { ...DEFAULT_SETTINGS };

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        editorSettings = { ...DEFAULT_SETTINGS, ...saved };
    } catch (e) {
        editorSettings = { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(editorSettings)); } catch (e) {}
}

// Apply the current prefs to the Ace editor (no-op until it exists).
// Editor/renderer options are global; tab/wrap/worker are per-session, so apply
// them to every open session (one per file — see ide_ui.js).
function applyEditorSettings() {
    if (typeof editor === 'undefined' || !editor) return;
    editor.setFontSize(parseInt(editorSettings.fontSize, 10) || 13);
    editor.setOption('fontFamily', FONT_FAMILIES[editorSettings.fontFamily] || FONT_FAMILIES.mono);
    editor.setShowInvisibles(!!editorSettings.showInvisibles);

    const applyToSession = (s) => {
        if (!s) return;
        s.setUseSoftTabs(!!editorSettings.softTabs);
        s.setTabSize(parseInt(editorSettings.tabSize, 10) || 2);
        s.setUseWrapMode(!!editorSettings.wrap);
        s.setUseWorker(false);
    };
    if (typeof sessions !== 'undefined' && sessions && Object.keys(sessions).length) {
        Object.values(sessions).forEach(applyToSession);
    } else if (editor.session) {
        applyToSession(editor.session);
    }
}

function updateSetting(key, value) {
    editorSettings[key] = value;
    saveSettings();
    applyEditorSettings();
}

loadSettings();
