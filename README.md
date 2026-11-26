# File Details

Adds a **Details** panel to the Explorer sidebar, next to Timeline and Outline. It shows Finder-style "Get Info" for the file you click.

## What it shows

| Section | Fields |
|---|---|
| Header | The icon from your active file icon theme, name, size, "Modified: Yesterday, 05:13", Finder tags, plus **Reveal in Finder**, **Copy Path** and **Open** buttons |
| General | Kind, Size (bytes and on disk), Where, Created, Modified, Last accessed, Locked, Hidden. Folders show an item count and an on-demand size. |
| More Info | Content type (UTI), image dimensions, media duration and codecs, PDF pages, version, line count, encoding, line endings, Where-from URLs |
| Name & Extension | Name, extension, Hide extension |
| Comments | Finder comment, if one is set |
| Open With | Default app (macOS) |
| Git | Repository, branch, status, whether it's ignored (and by which `.gitignore` rule), commit count, when it was added, last commit, blame share per author (top committers for folders) |
| VS Code | Workspace, relative path, language, Problems count (errors and warnings, which opens the Problems panel), whether it's hidden by `files.exclude` or `search.exclude` |
| Sharing & Permissions | Owner, group and everyone, with Finder-style privileges. Also the mode (`-rwxr-xr-x (755)`), BSD flags and extended attribute names. |
| Security | Quarantine status (which app downloaded it, and when), provenance, code signature and Team ID for binaries and bundles, Gatekeeper assessment for `.app` |
| Checksums | MD5, SHA-1 and SHA-256, calculated on demand |
| Advanced | Full path, `file://` URL, symlink target, real path, status changed (ctime), inode, hard links, block size |
| Preview | A thumbnail for images |

- **Values:** click any value to copy it.
- **Paths and URLs** (link-coloured): click to copy, or double-click to open with the macOS default app, the same as double-clicking in Finder. Web URLs open in your browser.
- **Sections:** each one can be collapsed, and that choice is remembered.

## How it picks the file

- It follows the active editor tab. Clicking a file in the Explorer opens a preview tab, so the panel updates. This works for images, PDFs and notebooks as well as text files.
- **Right-click → Show Details** shows any file or folder in the sidebar panel without opening it. It doesn't take focus away from the Explorer.
- **Right-click → Compare Details** opens an editor tab that compares items side by side, with differences highlighted and an "Only differences" filter. Multi-select 2–6 items first. If you pick a single item, it asks you what to compare it with. Checksums are calculated automatically, so the tab says whether the contents are identical.
- It refreshes when the file is saved and when its problems change. You can also use the refresh icon in the panel title.

Settings:
- `fileDetails.followActiveEditor` (default `true`)
- `fileDetails.lineCountMaxBytes` (default 5 MB)

## Platform notes

The full detail list needs macOS, because it comes from `mdls`, `stat -f`, `xattr` and `osascript`. On Linux you get the basic fields plus owner, group and Git. Remote and virtual files (SSH, WSL, `vscode-vfs`) show only basic fields from `vscode.workspace.fs`.

## Develop

```bash
npm install
npm run compile
```

To debug, press **F5**, which opens an Extension Development Host. To build the installable package, run `npm run package`, which produces `vscode-filedetails-<version>.vsix`.
