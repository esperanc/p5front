# p5front

A browser-based IDE for creative coding in **JavaScript** with **[p5.js](https://p5js.org) v2** — no accounts, no build step, no server. Everything runs in your browser and your projects are stored locally.

p5front can **import and export project zips** from the [p5.js Web Editor](https://editor.p5js.org) and [OpenProcessing](https://openprocessing.org), so you can move sketches in and out of those tools freely. It is designed to be deployed as **static files** (e.g. GitHub Pages).

> Inspired by **Py5Script** — a similar IDE for Python + p5.js via PyScript. p5front is its JavaScript counterpart.

---

## Features

- 🎨 **Write & run p5.js v2 sketches** entirely in the browser, with live preview.
- 📦 **Import / export zips** compatible with the p5.js Web Editor and OpenProcessing — a single, format-agnostic adapter (any folder with an `index.html` at its root works).
- 💾 **Local project storage** — files live in IndexedDB, project metadata in `localStorage`. Nothing leaves your machine.
- 🗂️ **Multi-file projects** with subfolders (JS, CSS, HTML, GLSL shaders, images, fonts, JSON, …).
- 🧑‍💻 **Ace editor** with per-language syntax highlighting, **per-file undo history & cursor position**, and a modern **linter** (Acorn — understands ES2022+ like static/private class fields).
- 🖼️ **View mode** — open a sketch full-window in a separate tab, with a collapsible console.
- 🔗 **Share via URL** — the whole project is compressed into a link (unreferenced assets are stripped to keep it small).
- 🎛️ **Preferences** — theme (auto / light / dark), editor font family & size, tab size, soft tabs, word wrap, show invisibles, syntax checking.
- 🧩 **Resizable, collapsible panels** and a drag-and-drop file sidebar.
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
- **Project metadata** (name, origin, timestamp) lives in `localStorage` (`p5front_projects_index`).

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

p5front is entirely static, so deployment is just publishing the files:

1. Push this repository to GitHub.
2. In **Settings → Pages**, serve from your branch (root).
3. Visit `https://<user>.github.io/<repo>/`.

Notes:

- GitHub Pages serves over HTTPS, which is all the Service Worker needs.
- The site lives under a subpath (`/<repo>/`); `sw.js` is at the repo root and registered with a relative path, so its scope covers the app automatically. No configuration required.

---

## Importing & exporting

### Import

- Drag a `.zip` onto the projects page (or the file sidebar in the editor), or use **Import**.
- Supported: exports from the **p5.js Web Editor** and **OpenProcessing**, plus any zip that contains an `index.html` at its root.
- If a zip has no `index.html`, p5front synthesizes a minimal one (loading p5.js from a CDN plus the JavaScript/CSS it finds) so the project still runs.

### Export

- **Export zip** downloads the project, preserving folder structure. Round-tripping (import → export → import) is lossless.

Both editors reference **p5.js v2 from a CDN** in their `index.html`, and p5front keeps it that way — so an imported sketch runs exactly as it did in its original editor.

---

## Editor & p5.js v2 notes

- The Ace linter is **Acorn-based** and reports real syntax errors only — it won't false-flag modern syntax (static class fields, private `#fields`, `??`, optional chaining, etc.). Toggle it in **Preferences → Check JS syntax**.
- Each open file keeps its own **undo history, cursor and scroll position**.
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
├── index.html        # Landing page: project list + import
├── ide.html          # The editor (sidebar, Ace, preview, console)
├── view.html         # Full-window "view mode" runner
├── sw.js             # Service Worker — virtual filesystem for the runner
├── css/
│   └── app.css       # Shared, theme-aware styles
└── js/
    ├── util.js       # Helpers: slugify, name generator, theme
    ├── storage.js    # IndexedDB + registry + the canonical file model
    ├── formats.js    # Import/export adapters, default project template
    ├── share.js      # URL sharing (LZString compression)
    ├── settings.js   # Editor preferences
    └── ide_ui.js     # Editor wiring: file tree, run/stop, panels, linter
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

_TODO: add a license (e.g. MIT)._
