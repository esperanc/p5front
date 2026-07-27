// =============================================================================
// REORDER — fix <script> ordering in index.html by top-level dependency.
// =============================================================================
// Some multi-file sketches (notably several OpenProcessing exports) list their
// <script> tags in an order that does not match dependency order: a symbol
// defined at the top level of script A is used at the top level of script B, but
// B is listed before A. Loaded as separate scripts this throws (e.g.
// `class B extends A` when A isn't defined yet), even though it runs fine on
// OpenProcessing (whose live runtime loads them in a working order).
//
// This analyses each LOCAL script with Acorn and topologically sorts them so a
// definer loads before a top-level user. References inside function bodies don't
// constrain order (they run after every script has loaded). External/CDN scripts
// keep their positions. Stable: an already-correct order is left unchanged.
// Depends on: acorn (global).
// =============================================================================

function reorderScriptsByDependency(files) {
    const html = files && files['index.html'];
    if (!html || typeof acorn === 'undefined') return html;

    const tagRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi;
    const slots = [];
    let m;
    while ((m = tagRe.exec(html)) !== null) {
        const rawSrc = m[1].trim();
        const key = rawSrc.replace(/^\.\//, '').split(/[?#]/)[0];
        const local = !/^(https?:)?\/\//i.test(rawSrc) && !rawSrc.startsWith('data:') &&
                      /\.m?js$/i.test(key) && Object.prototype.hasOwnProperty.call(files, key) &&
                      !isBinaryValue(files[key]);
        slots.push({ full: m[0], key, local, code: local ? files[key] : null });
    }

    const localIdx = slots.map((s, i) => (s.local ? i : -1)).filter(i => i >= 0);
    if (localIdx.length < 2) return html;

    // Analyse each local script → { defines, usesExt }.
    const info = localIdx.map(i => {
        const a = analyzeTopLevel(slots[i].code);
        const usesExt = new Set([...a.uses].filter(u => !a.defines.has(u)));
        return { defines: a.defines, usesExt };
    });

    // Edge a→b (a before b) when b uses, at top level, a symbol a defines.
    const n = info.length;
    const indeg = new Array(n).fill(0);
    const adj = Array.from({ length: n }, () => []);
    for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
            if (a === b) continue;
            let dep = false;
            for (const u of info[b].usesExt) { if (info[a].defines.has(u)) { dep = true; break; } }
            if (dep) { adj[a].push(b); indeg[b]++; }
        }
    }

    // Kahn topological sort, preferring the original order among ready nodes.
    const order = [];
    const ready = [];
    for (let i = 0; i < n; i++) if (indeg[i] === 0) ready.push(i);
    while (ready.length) {
        ready.sort((x, y) => x - y);
        const i = ready.shift();
        order.push(i);
        for (const j of adj[i]) if (--indeg[j] === 0) ready.push(j);
    }
    if (order.length !== n) return html;               // cycle — leave untouched
    if (order.every((v, k) => v === k)) return html;    // already correct

    // Re-emit: local slots take the reordered tags; everything else stays put.
    const sortedTags = order.map(k => slots[localIdx[k]].full);
    let out = '', last = 0, li = 0, sIdx = 0;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(html)) !== null) {
        const slot = slots[sIdx++];
        out += html.slice(last, m.index);
        out += slot.local ? sortedTags[li++] : m[0];
        last = m.index + m[0].length;
    }
    out += html.slice(last);
    return out;
}

// ---- Top-level static analysis (Acorn) --------------------------------------
function analyzeTopLevel(code) {
    const defines = new Set(), uses = new Set();
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true });
    } catch (e) {
        try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }); }
        catch (e2) { return { defines, uses }; }        // unparseable → no constraints
    }
    for (const node of ast.body) collectDeclaredNames(node, defines);
    for (const node of ast.body) collectTopRefs(node, uses);
    return { defines, uses };
}

function collectDeclaredNames(node, out) {
    if (!node) return;
    switch (node.type) {
        case 'VariableDeclaration': node.declarations.forEach(d => bindNames(d.id, out)); break;
        case 'FunctionDeclaration':
        case 'ClassDeclaration': if (node.id) out.add(node.id.name); break;
        case 'ExportNamedDeclaration':
        case 'ExportDefaultDeclaration': if (node.declaration) collectDeclaredNames(node.declaration, out); break;
    }
}

function bindNames(id, out) {
    if (!id) return;
    switch (id.type) {
        case 'Identifier': out.add(id.name); break;
        case 'ObjectPattern': id.properties.forEach(p => bindNames(p.value || p.argument, out)); break;
        case 'ArrayPattern': id.elements.forEach(e => e && bindNames(e, out)); break;
        case 'AssignmentPattern': bindNames(id.left, out); break;
        case 'RestElement': bindNames(id.argument, out); break;
    }
}

// Collect identifier references that execute at the TOP LEVEL — i.e. not inside
// function/arrow bodies or class method/field bodies (those run later). A class's
// `extends` clause DOES run at definition time, so it is included.
function collectTopRefs(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => collectTopRefs(n, out)); return; }
    if (!node.type) return;
    switch (node.type) {
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
            return;                                     // deferred until called
        case 'Identifier': out.add(node.name); return;
        case 'MemberExpression':
            collectTopRefs(node.object, out);
            if (node.computed) collectTopRefs(node.property, out);
            return;
        case 'Property':
            if (node.computed) collectTopRefs(node.key, out);
            collectTopRefs(node.value, out);
            return;
        case 'ClassDeclaration':
        case 'ClassExpression':
            collectTopRefs(node.superClass, out);       // `extends X` runs at definition
            return;                                     // skip method/field bodies
        case 'VariableDeclarator':
            collectTopRefs(node.init, out);             // id is a binding, not a reference
            return;
        case 'LabeledStatement':
            collectTopRefs(node.body, out); return;
        default:
            for (const k in node) {
                if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
                collectTopRefs(node[k], out);
            }
    }
}
