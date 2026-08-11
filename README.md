# p5front

A browser-based IDE for creative coding in **JavaScript** with **[p5.js](https://p5js.org) v2** — no accounts, no build step, no server. Everything runs in your browser and your projects are stored locally.

p5front can **import and export project zips** from the [p5.js Web Editor](https://editor.p5js.org) and [OpenProcessing](https://openprocessing.org), so you can move sketches in and out of those tools freely. It is designed to be deployed as **static files** (e.g. GitHub Pages).

**▶ Live demo: <https://esperanc.github.io/p5front/>**

> Inspired by **Py5Script** ([repo](https://github.com/esperanc/Py5Script) · [live](https://esperanc.github.io/Py5Script/)) — a similar IDE for Python + p5.js via PyScript. p5front is its JavaScript counterpart.

---

## Features

- 🎨 **Write & run p5.js v2 sketches** entirely in the browser, with live preview.
- 📦 **Import / export zips** compatible with the p5.js Web Editor and OpenProcessing — a single, format-agnostic adapter (any folder with an `index.html` at its root works).
- 💾 **Local project storage** — files live in IndexedDB, a project registry in `localStorage`. Nothing leaves your machine, and multiple windows stay consistent. Opens the project you were last editing (or a fresh one on first visit); switch or create projects from the **Projects** dialog.
- 🗂️ **Multi-file projects** with subfolders (JS, CSS, HTML, GLSL shaders, images, fonts, JSON, …).
- 🧩 **Add files & libraries in a click** — the New-file dialog can auto-insert a module's `<script>` into `index.html`, and **Add library** wires a CDN URL into `<head>`. Renaming or deleting a referenced file updates its tag.
- 🏷️ **Per-sketch metadata** — give each sketch a title, tags, a **collection** (folder-like path), a **Markdown description**, and a **thumbnail** snapped from the running canvas, all edited in the **Info** dialog. Stored inside the project, so they travel with export/import.
- 🔎 **Organize with collections & tags** — the **Projects** browser has a collections tree, tag facets and a name filter, and lets you read a sketch's rendered description before opening it.
- 🧑‍💻 **Ace editor** with per-language syntax highlighting, **per-file undo history & cursor position**, and a modern **linter** (Acorn — understands ES2022+ like static/private class fields).
- 🖼️ **View mode** — open a sketch full-window in a separate tab, with a collapsible console.
- 🔗 **Share via URL** — the whole project is compressed into a link (unreferenced assets are stripped to keep it small). Or load a project from a hosted zip/repository (see [URL parameters](#url-parameters)).
- 🗄️ **Export / import all projects** — download every project as a single zip that unzips into a **directly hostable, runnable repository** with a **visual gallery** (thumbnails, rendered descriptions, and "Edit in p5front" links); re-import it anywhere.
- 🎛️ **Preferences** — theme (auto / light / dark), editor font family & size, tab size, soft tabs, word wrap, show invisibles, syntax checking.
- ↔️ **Resizable, collapsible panels** and a drag-and-drop file sidebar.
- 🚀 **Static deploy** — works from any static host, including GitHub Pages.

---

## How it works

p5front is plain HTML/CSS/JS with no bundler. A few ideas make it tick:

### Projects as a canonical file map

Every project is a map of `path → content`:

```js
{
  "index.html": "…",
  "sketch.js":  "…",
  "assets/cat.png": "data:image/png;base64,…"
}
```

Text files are stored as strings; binary assets (images, fonts, audio) as `data:` URLs. The entry point is always **`index.html`** at the root — the same convention the p5.js Web Editor and OpenProcessing use, which is why a single importer handles both.

- **Files** are persisted in **IndexedDB** (`p5front_db` → `files` store).
- **A project registry** (name, origin, timestamp) lives in `localStorage` (`p5front_projects_index`). It also caches each project's derived metadata (title, tags, collection, whether it has a thumbnail/description) so the **Projects** browser can list, filter and group without opening every project's files. Registry writes are serialized across tabs with the **Web Locks API**, and open windows stay in sync via the `storage` event.
- **Per-sketch metadata is a file**: a project's title, tags, collection and Markdown description live in a `README.md` front-matter block, and its thumbnail in `thumbnail.png`. Keeping them in the project (rather than a separate database) means they travel through export, import and share with no extra bookkeeping. The registry cache above is just a derived index over these.

### Running sketches: a Service Worker as a virtual filesystem

When you press **Run**, an `<iframe>` is pointed at a virtual URL like `runner/<project-id>/index.html`. A **Service Worker** (`sw.js`) intercepts every request under `runner/<id>/…` and serves the file straight from IndexedDB — decoding `data:` URLs for binary assets and injecting a tiny console/error bridge into the served `index.html`.

This means your sketch's relative references — `loadImage('assets/cat.png')`, `<script src="lib/foo.js">`, `loadFont('fonts/x.ttf')` — **just work**, including in subfolders, with no code rewriting. Cross-origin requests (like p5.js itself from a CDN) pass straight through to the network.

> Because it relies on a Service Worker, p5front must be served over **`https://` or `http://localhost`** (Service Workers don't run on `file://`).

---

## Running locally

Any static file server works. For example, with Python:

```bash
python3 -m http.server 5177
```

Then open <http://localhost:5177>.

There is also a `launch.json` in the project root describing the same dev server.

> Opening `index.html` directly from disk (`file://`) will **not** work, because the sketch runner needs a Service Worker.

---

## Deploying to GitHub Pages

p5front is entirely static, so deployment is just publishing the files. This project is deployed at **<https://esperanc.github.io/p5front/>** ([repository](https://github.com/esperanc/p5front)). To host your own copy:

1. Push the repository to GitHub.
2. In **Settings → Pages**, serve from your branch (root).
3. Visit `https://<user>.github.io/<repo>/`.

Notes:

- GitHub Pages serves over HTTPS, which is all the Service Worker needs.
- The site lives under a subpath (`/<repo>/`); `sw.js` is at the repo root and registered with a relative path, so its scope covers the app automatically. No configuration required.

---

## Adding files & libraries

The file sidebar has three actions:

- **＋ New file** — asks for a path (subfolders allowed, e.g. `shaders/tex.frag`). For a `.js`/`.mjs` file it offers to **insert its `<script>` into `index.html`** for you (before the main sketch, so a module a sketch depends on loads first), and optionally as `type="module"`.
- **🔗 Add library** — paste a CDN URL; p5front adds it to `<head>` as a `<script>` (or a `<link>` for a `.css`, or a module for `.mjs`). Handy for p5 add-ons and helper libraries.
- **⤒ Upload** — add files (text or binary) to the current project.

Renaming or deleting a file that's referenced from `index.html` **updates or removes its `<script>`/`<link>` tag** automatically, so you never hand-edit `index.html` to keep it in sync.

---

## Organizing & documenting sketches

Click the **ⓘ Info** button (next to the project name) to describe a sketch:

- **Title**, **Tags** (comma-separated) and a **Collection** — a folder-like path such as `course/2026/generative` that gives your sketches a single-home hierarchy (tags stay for cross-cutting facets).
- A **Markdown description** for notes and usage instructions.
- A **Thumbnail** captured straight from the running canvas (**Capture from canvas** — run the sketch first).

All of this is saved *inside* the project (`README.md` front-matter + `thumbnail.png`), so it travels through export, import and share.

The **Projects** dialog (**Open**) is a browser over this metadata:

- A **collections rail** on the left — a tree built from your collection paths, with counts; pick one to narrow the list (including its sub-collections), or **Uncollected**.
- **Tag facets** that combine (AND) with the selected collection, plus a name/title filter and date / A–Z sorting.
- Each row shows its thumbnail, collection and tags; an **ⓘ** button opens a reading view with the description **rendered as Markdown**, so you can read a sketch's instructions before opening it.

Renaming a project keeps its `?id=` in sync (the id follows the name), and the whole browser stays fast because it reads the registry's derived cache rather than opening every project.

---

## Importing & exporting

### Import

- Drag a `.zip` onto the editor's file sidebar, or use **Import**.
- Supported: exports from the **p5.js Web Editor** and **OpenProcessing**, plus any zip that contains an `index.html` at its root.
- If a zip has no `index.html`, p5front synthesizes a minimal one (loading p5.js from a CDN plus the JavaScript/CSS it finds) so the project still runs.

### Export

- **Export zip** downloads the project, preserving folder structure. Round-tripping (import → export → import) is lossless.

Both editors reference **p5.js v2 from a CDN** in their `index.html`, and p5front keeps it that way — so an imported sketch runs exactly as it did in its original editor.

### Export / import all projects (backup)

Storage is per-browser and per-origin, so the **Projects** dialog has **Export all** and **Import…** to back everything up or move it between machines.

**Export all** downloads a single zip that unzips into a runnable static repository:

```
p5front-export-2026-07-25/
├── index.html          # a visual gallery of all the projects
├── p5front.json        # manifest (per-project metadata + file lists)
├── .nojekyll           # so GitHub Pages serves every file verbatim
├── Bauhaus Grid/       # one folder per project (folder name = project name)
│   ├── index.html      # runs the sketch standalone
│   ├── README.md       # description (front-matter + Markdown)
│   ├── thumbnail.png
│   └── …
└── …
```

Each project folder is self-contained, so you can **host the unzipped folder on any static server** (e.g. GitHub Pages) and every sketch runs directly — no p5front and no Service Worker needed.

The generated `index.html` is a **gallery**: a card per sketch with its thumbnail, tags and title. Clicking a card opens a **reading view** with the full **Markdown-rendered** description; a **▶ Run** button runs the sketch standalone, and an **Edit in p5front** button opens it for editing in a p5front instance (via [`?repo=`](#url-parameters)) whose URL you can set at the top of the page.

> The `.nojekyll` file matters on GitHub Pages: without it, Jekyll turns front-matter `README.md` files into HTML and stops serving the raw `.md`, which would break metadata loading over `?repo=`.

**Import…** reads such a zip back in. `p5front.json` is **optional**: any zip of projects works, where a project is any folder that directly contains an `index.html`. This covers folders at the top level, folders inside a wrapping container folder, and a single project at the archive root. Without a manifest, each project's name comes from its folder. When a project already exists, you choose once how to resolve it: keep both (import as copies), overwrite, or skip.

---

## URL parameters

p5front reads a few query parameters on load to decide what to open. With **no** parameter it reopens the project you were last editing (or the most recent, or a fresh one on first visit).

| Parameter | Example | Effect |
|---|---|---|
| `id` | `?id=bauhaus-grid` | Open a **local** project by its id (from this browser's IndexedDB). |
| `share` | `?share=<data>&name=<name>` | Open a project **embedded in the link** (produced by **Share**). `name` is optional. |
| `zip` | `?zip=https://host/sketch.zip` | Fetch a **hosted zip** and import it as a project (name taken from the filename). |
| `repo` | `?repo=https://host/export/&project=<folder>` | Import one project from an **exported repository** — fetches the files listed for that `folder` in the repo's `p5front.json`. |

Notes:

- `id` only finds projects already stored in **this** browser — it fetches nothing. To load a project hosted elsewhere, use `zip` or `repo`.
- `zip` and `repo` **import** the project into local storage and then open it, so it becomes a normal, editable project. They do **not** run it automatically. If a project of the same name already exists, a dialog offers **Overwrite existing**, **Import as a copy**, or **Cancel**.
- The gallery produced by **Export all** builds `repo` links for its **Edit in p5front** buttons, pointing at a configurable p5front instance (the "Edit opens in:" field).
- **Cross-origin fetches (`zip` / `repo`) require CORS**: the server hosting the zip/repo must send `Access-Control-Allow-Origin` (GitHub Pages does, with `*`). You can avoid CORS altogether by hosting the p5front instance and the zip/repo on the **same origin** (same scheme + host + port) — then any static server, even `python3 -m http.server`, suffices. Note the mixed-content rule: a page served over `https://` can only fetch `https://` URLs.

---

## Editor & p5.js v2 notes

- The Ace linter is **Acorn-based** and reports real syntax errors only — it won't false-flag modern syntax (static class fields, private `#fields`, `??`, optional chaining, etc.). Toggle it in **Preferences → Check JS syntax**.
- Each open file keeps its own **undo history, cursor and scroll position**.
- **Script order is auto-repaired.** Some multi-file exports (notably a few from OpenProcessing) list their `<script>` tags in an order that doesn't match dependency order — a symbol defined at the top level of one file is used at the top level of another that loads first (e.g. `class B extends A` with `A` loaded later). p5front analyses the local scripts and reorders them by dependency on load, so these sketches run without manual fixing.
- **p5.js 2.0 removed `preload()`.** Load assets inside an `async setup()` instead:

  ```js
  let img;
  async function setup() {
    createCanvas(400, 400);
    img = await loadImage('assets/cat.png');
    image(img, 0, 0);
  }
  ```

---

## Project structure

```
p5front/
├── index.html        # The editor (sidebar, Ace, preview, console) — the app entry point
├── view.html         # Full-window "view mode" runner
├── sw.js             # Service Worker — virtual filesystem for the runner
├── css/
│   └── app.css       # Shared, theme-aware styles
└── js/
    ├── util.js       # Helpers: slugify, name generator, theme
    ├── storage.js    # IndexedDB + registry (Web-Locks-safe) + the canonical file model
    ├── meta.js       # Per-sketch metadata (README front-matter, thumbnail) + Markdown renderer
    ├── formats.js    # Import/export adapters, default template, <script>/<link> auto-wiring
    ├── share.js      # URL sharing (LZString compression)
    ├── backup.js     # Export/import all projects; the gallery generator
    ├── settings.js   # Editor preferences
    ├── reorder.js    # Dependency-order repair for multi-file <script> tags
    └── ide_ui.js     # Editor wiring: file tree, run/stop, panels, linter, Projects browser
```

---

## Dependencies

All loaded from CDNs at runtime — there is nothing to install or build:

| Library | Purpose |
|---|---|
| [p5.js](https://p5js.org) v2 | The creative-coding runtime (referenced by each sketch's `index.html`) |
| [Ace](https://ace.c9.io) | Code editor |
| [Acorn](https://github.com/acornjs/acorn) | JavaScript parser used for linting |
| [JSZip](https://stuk.github.io/jszip/) | Reading/writing project zips |
| [LZ-String](https://pieroxy.net/blog/pages/lz-string/) | Compressing projects into share URLs |

---

## Browser support

A modern browser with **Service Worker** and **IndexedDB** support (all current versions of Chrome, Firefox, Safari and Edge). Must be served over HTTPS or `localhost`.

---

## Limitations

- The linter reports the **first** syntax error at a time (it's a parser, not a style checker) — no unused-variable/style warnings.
- Very large projects (e.g. a vendored multi-MB `p5.js`) make share URLs impractically long; use **Export zip** instead. Share links automatically drop files not referenced by `index.html`.
- Storage is per-browser and per-origin; projects are not synced across devices. Export zips to back up or move work.

---

## License

p5front is released under a **noncommercial license** (see [LICENSE](LICENSE)).
Academic, research, educational and other noncommercial use is free, provided the
license file is kept intact. **Commercial use requires prior written permission** —
contact <claudio.esperanca@gmail.com>.

Copyright © 2026 Claudio Esperança.
