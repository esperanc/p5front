// =============================================================================
// INDENT — reindent the current file (or the selection) with the Ace mode's own
// indentation rules.
// =============================================================================
// This is a stricter version of Ace's built-in editor.autoIndent(): that one
// runs on every mode, but modes without real indentation logic (html, xml,
// markdown, text) inherit the text-mode rule "copy the previous line's indent",
// which collapses a whole file to column 0 — it would flatten index.html and
// destroy nested lists in README.md. So the modes are whitelisted here, and the
// places where the JavaScript mode's own rules fall short are patched:
//   * closing ) and ] are aligned to their opener (the mode only outdents });
//   * `default:` gets the indent step the mode only gives to `case x:`;
//   * lines continuing a template literal are left alone (their leading
//     whitespace is program data, not layout);
//   * lines inside a block comment are shifted with the comment rather than
//     re-flowed, so ASCII art and commented-out code keep their alignment.
// Only indentation changes — no line is joined, split or otherwise reflowed.
// Depends on: Ace (global), ide_ui.js (globals `editor`, `bufferFile`).
// =============================================================================

// Modes whose getNextLineIndent() actually computes an indent. A mode that has
// not finished loading yet reports "ace/mode/text", so this also guards against
// reindenting a file whose real mode isn't in memory.
const REINDENTABLE_MODE = /^ace\/mode\/(javascript|json|css|scss|less|glsl|c_cpp)$/;

function isReindentable(session) {
    return !!session && REINDENTABLE_MODE.test(session.getMode().$id);
}

// Reindent rows [firstRow, lastRow] in place. All edits land in a single undo
// group, so one undo restores the file. Returns false when the mode is unknown.
function reindentSession(session, firstRow, lastRow) {
    if (!isReindentable(session)) return false;

    const Range    = ace.require('ace/range').Range;
    const mode     = session.getMode();
    const tab      = session.getTabString();
    const indentOf = (line) => line.match(/^[ \t]*/)[0];

    // The tokenizer state at the END of a row says what the next row starts
    // inside. (Ace reports either a state name or a stack whose head is the
    // current state.) Token types can't answer this: a line ending in a
    // complete 'string' literal looks the same as one opening a template.
    const stateAfter = (row) => {
        const st = session.getState(row);
        return (Array.isArray(st) ? st[0] : st) || '';
    };
    const opensString  = (row) => /string|quasi/.test(stateAfter(row));
    const opensComment = (row) => /comment/.test(stateAfter(row));

    // Move a row bodily by `delta` characters, preserving its own alignment.
    const shiftRow = (row, delta) => {
        if (!delta) return;
        const line = session.getLine(row);
        if (!line.trim()) return;
        const lead = indentOf(line);
        const next = delta > 0
            ? tab[0].repeat(delta) + lead
            : lead.slice(Math.min(-delta, lead.length));
        if (next !== lead) session.replace(new Range(row, 0, row, lead.length), next);
    };

    lastRow = Math.min(lastRow, session.getLength() - 1);

    // The first row has no previous line to derive an indent from: it belongs at
    // the left margin (this matches Ace's own autoIndent).
    if (firstRow <= 0) {
        const lead = indentOf(session.getLine(0)).length;
        if (lead) session.replace(new Range(0, 0, 0, lead), '');
    }

    let delta   = 0;                        // how far the last reindented row moved
    let prevRow = Math.max(0, firstRow - 1);   // last row that was actually reindented
    for (let row = Math.max(1, firstRow); row <= lastRow; row++) {
        // Skipped rows don't become the reference for the next one: the indent
        // of a template-literal body is data, not layout.
        if (opensString(row - 1)) continue;            // inside a template literal
        if (opensComment(row - 1)) { shiftRow(row, delta); continue; }

        const line = session.getLine(row);
        const body = line.replace(/^\s+/, '');
        if (!body) {                                   // blank line: drop trailing whitespace
            if (line.length) session.replace(new Range(row, 0, row, line.length), '');
            continue;
        }
        const lead = line.length - body.length;

        const prev = session.getLine(prevRow);
        let indent = mode.getNextLineIndent(session.getState(prevRow), prev, tab);

        // The mode indents the body of `case x:` but knows nothing of `default:`.
        if (/^\s*default\s*:/.test(prev)) indent += tab;
        // ...and a case/default label itself sits one step out from that body.
        if (/^(case\b|default\b)/.test(body) && !/\bswitch\s*\(.*\)\s*\{\s*$/.test(prev))
            indent = indent.slice(0, Math.max(0, indent.length - tab.length));

        session.replace(new Range(row, 0, row, lead), indent);

        // The mode's autoOutdent only handles `}` — align every closer with the
        // line that opened it, which also keeps multi-line calls from drifting.
        if (/^[}\)\]]/.test(body)) {
            const open = session.findMatchingBracket({ row, column: indent.length + 1 });
            if (open && open.row !== row) {
                const want = indentOf(session.getLine(open.row));
                if (want !== indent) {
                    session.replace(new Range(row, 0, row, indent.length), want);
                    indent = want;
                }
            }
        }
        delta   = indent.length - lead;
        prevRow = row;
    }
    return true;
}

// Command entry point: the selected rows, or the whole file when nothing is
// selected. Cursor and scroll survive the rewrite; an Anchor tracks the cursor
// through the edits so it stays on the same character.
function reindentCurrentFile() {
    if (!editor || !bufferFile) return false;       // nothing loaded, or a binary preview
    const session = editor.session;
    if (!isReindentable(session)) {
        if (typeof logLine === 'function')
            logLine(`Reindent: not available for ${bufferFile} — this file type has no indentation rules.`, 'warn');
        return false;
    }

    const Range  = ace.require('ace/range').Range;
    const sel    = editor.getSelectionRange();
    const whole  = sel.isEmpty();
    const cursor = editor.getCursorPosition();
    const anchor = session.doc.createAnchor(cursor.row, cursor.column);
    const scroll = session.getScrollTop();

    let firstRow = 0, lastRow = session.getLength() - 1;
    if (!whole) {
        firstRow = sel.start.row;
        lastRow  = sel.end.row;
        // A selection ending at column 0 doesn't really include that last row.
        if (sel.end.column === 0 && lastRow > firstRow) lastRow--;
    }

    reindentSession(session, firstRow, lastRow);

    if (whole) {
        editor.clearSelection();
        editor.moveCursorToPosition({ row: anchor.row, column: anchor.column });
    } else {
        // Keep the same rows selected, now full-width.
        editor.selection.setSelectionRange(
            new Range(firstRow, 0, lastRow, session.getLine(lastRow).length));
    }
    session.setScrollTop(scroll);
    anchor.detach();
    return true;
}

// Enable/disable the toolbar button for the file currently in the buffer. Modes
// load asynchronously from the CDN, so re-check once the session's real mode
// arrives (also covers a mode change after a rename).
function updateReindentButton() {
    const btn = document.getElementById('reindent-btn');
    if (!btn) return;
    const session = editor && editor.session;
    if (session && !session.$reindentModeHook) {
        session.$reindentModeHook = true;
        session.on('changeMode', updateReindentButton);
    }
    const ok = !!bufferFile && !!editor && isReindentable(session);
    btn.disabled = !ok;
    btn.title = ok
        ? 'Reindent file (or selection) — Ctrl/Cmd + Shift + F'
        : 'Reindent is not available for this file type';
}
