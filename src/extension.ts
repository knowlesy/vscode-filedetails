import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Details, folderSize, getDetails, hashes, Row, Section, sortSections, statSignature, withSlowSections } from './details';
import { ExcludeConfig, matchExclude } from './glob';
import { clearIconCaches, resolveIcon, THUMBNAIL_EXTS, toDataUri } from './iconTheme';
import { renderCompare, renderDetails, renderMessage, Rendered, renderValue, ViewModel } from './render';
import { shellHtml } from './webview';

export function activate(context: vscode.ExtensionContext) {
  const provider = new DetailsViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('fileDetails.view', provider),
    vscode.commands.registerCommand('fileDetails.show', async (uri?: vscode.Uri) => {
      const target = uri instanceof vscode.Uri ? uri : activeTabUri();
      if (target) { await provider.reveal(target); }
    }),
    vscode.commands.registerCommand('fileDetails.compare', (uri?: vscode.Uri, uris?: vscode.Uri[]) => compareDetails(uri, uris)),
    vscode.commands.registerCommand('fileDetails.refresh', () => provider.refresh(true)),
    vscode.window.tabGroups.onDidChangeTabs(() => provider.followActiveTab()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => provider.followActiveTab()),
    vscode.window.onDidChangeActiveTextEditor(() => provider.followActiveTab()),
    vscode.workspace.onDidSaveTextDocument(doc => provider.refreshIf(doc.uri)),
    vscode.languages.onDidChangeDiagnostics(e => provider.diagnosticsChanged(e.uris)),
    vscode.window.onDidChangeActiveColorTheme(() => provider.refresh(false)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workbench.iconTheme')) { clearIconCaches(); }
      if (['workbench.iconTheme', 'files.exclude', 'search.exclude', 'fileDetails'].some(s => e.affectsConfiguration(s))) {
        provider.refresh(false);
      }
    }),
    vscode.extensions.onDidChange(() => { languageMap = undefined; clearIconCaches(); }),
  );
}

export function deactivate() {}

// ---------- active file ----------

/** URI of the active editor tab, covering text, custom (images/PDF), notebook and diff editors. */
function activeTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
    return input.modified;
  }
  return undefined;
}

// ---------- language + icon theme pass-through ----------

let languageMap: { byName: Map<string, string>; byExt: Map<string, string> } | undefined;

/** Language of an open document, else guessed from installed extensions' language contributions. */
function guessLanguage(uri: vscode.Uri): string | undefined {
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (doc) { return doc.languageId; }
  if (!languageMap) {
    languageMap = { byName: new Map(), byExt: new Map() };
    for (const ext of vscode.extensions.all) {
      for (const l of ext.packageJSON?.contributes?.languages ?? []) {
        for (const f of l.filenames ?? []) { if (!languageMap.byName.has(f.toLowerCase())) { languageMap.byName.set(f.toLowerCase(), l.id); } }
        for (const e of l.extensions ?? []) { if (!languageMap.byExt.has(e.toLowerCase())) { languageMap.byExt.set(e.toLowerCase(), l.id); } }
      }
    }
  }
  const name = path.basename(uri.fsPath).toLowerCase();
  const byName = languageMap.byName.get(name);
  if (byName) { return byName; }
  const parts = name.split('.');
  for (let i = 1; i < parts.length; i++) {
    const id = languageMap.byExt.get('.' + parts.slice(i).join('.'));
    if (id) { return id; }
  }
  return undefined;
}

function iconThemeFile(): string | undefined {
  const id = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
  if (!id) { return undefined; }
  for (const ext of vscode.extensions.all) {
    for (const t of ext.packageJSON?.contributes?.iconThemes ?? []) {
      if (t.id === id && t.path) { return path.join(ext.extensionPath, t.path); }
    }
  }
  return undefined;
}

function isLightTheme(): boolean {
  const k = vscode.window.activeColorTheme.kind;
  return k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight;
}

// ---------- VS Code section ----------

function problemsRow(uri: vscode.Uri, isDir: boolean): Row {
  const diags = isDir
    ? vscode.languages.getDiagnostics()
      .filter(([u]) => u.scheme === uri.scheme && u.fsPath.startsWith(uri.fsPath + path.sep))
      .flatMap(([, d]) => d)
    : vscode.languages.getDiagnostics(uri);
  const n = [0, 0, 0, 0];
  for (const d of diags) { n[d.severity]++; }
  const names = ['error', 'warning', 'info', 'hint'];
  const parts = n.map((c, i) => (c ? `${c} ${names[i]}${c > 1 && i < 2 ? 's' : ''}` : '')).filter(Boolean);
  return parts.length
    ? { label: 'Problems', value: parts.join(', '), action: 'problems' }
    : { label: 'Problems', value: 'None' };
}

function vscodeSection(uri: vscode.Uri, isDir: boolean, languageId: string | undefined): Section {
  const rows: Row[] = [];
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder) {
    const root = folder.uri.fsPath;
    const rel = path.relative(root, uri.fsPath).split(path.sep).join('/');
    rows.push({ label: 'Workspace', value: folder.name, full: root, open: root });
    if (rel) { rows.push({ label: 'Relative path', value: rel, full: rel, open: uri.fsPath, mono: true }); }
    const sibling = (dir: string, name: string) => fs.existsSync(path.join(root, dir, name));
    const fx = matchExclude(rel, vscode.workspace.getConfiguration('files', uri).get<ExcludeConfig>('exclude'), sibling);
    rows.push({ label: 'files.exclude', value: fx ? `Hidden by "${fx}"` : 'No' });
    const sx = matchExclude(rel, vscode.workspace.getConfiguration('search', uri).get<ExcludeConfig>('exclude'), sibling);
    rows.push({ label: 'search.exclude', value: sx ? `Excluded by "${sx}"` : 'No' });
  } else {
    rows.push({ label: 'Workspace', value: 'Outside workspace' });
  }
  if (languageId) { rows.push({ label: 'Language', value: languageId, mono: true }); }
  rows.push(problemsRow(uri, isDir));
  return { id: 'vscode', title: 'VS Code', rows };
}

// ---------- computed (on-demand) values, cached per file version ----------

const computed = new Map<string, Record<string, string>>();

function computedKey(p: string, sig: string) { return `${p}\u0000${sig}`; }

/** Replaces on-demand rows (hashes, folder size) with values already computed for this file version. */
function applyComputed(details: Details): Details {
  const values = computed.get(computedKey(details.path, details.signature));
  if (!values) { return details; }
  return {
    ...details,
    sections: details.sections.map(s => ({
      ...s,
      rows: s.rows.map(r => {
        const v = r.action ? values[r.fillId ?? r.action] : undefined;
        return v === undefined ? r : { label: r.label, value: v, full: v, mono: true };
      }),
    })),
  };
}

async function compute(p: string, action: string): Promise<Record<string, string>> {
  const sig = statSignature(await fs.promises.lstat(p));
  let values: Record<string, string>;
  if (action === 'hashes') {
    values = { ...(await hashes(p)) };
  } else {
    values = { folderSize: (await folderSize(p)) ?? 'Unavailable (timed out)' };
  }
  if (computed.size > 500) { computed.clear(); }
  const key = computedKey(p, sig);
  computed.set(key, { ...computed.get(key), ...values });
  return values;
}

// ---------- view model ----------

const detailsCache = new Map<string, Details>();

/**
 * 'fast' returns without Git/Security (blame, codesign and spctl can take a second or two on a cold
 * cache); 'full' includes them. Results are cached per path until the file's stat changes.
 */
async function loadDetails(uri: vscode.Uri, phase: 'fast' | 'full'): Promise<Details> {
  const p = uri.fsPath;
  const sig = statSignature(await fs.promises.lstat(p));
  const cached = detailsCache.get(p);
  let details = cached && cached.signature === sig ? cached : undefined;
  if (details && (details.complete || phase === 'fast')) { return details; }
  details ??= await getDetails(p, {
    includeSlow: false,
    lineCountMaxBytes: vscode.workspace.getConfiguration('fileDetails').get<number>('lineCountMaxBytes', 5_000_000),
  });
  if (phase === 'full') { details = await withSlowSections(details); }
  if (detailsCache.size > 50) { detailsCache.clear(); }
  detailsCache.set(p, details);
  return details;
}

async function buildViewModel(uri: vscode.Uri, phase: 'fast' | 'full'): Promise<ViewModel> {
  const p = uri.fsPath;
  const details = applyComputed(await loadDetails(uri, phase));
  const languageId = details.isDirectory ? undefined : guessLanguage(uri);
  const sections = sortSections([...details.sections, vscodeSection(uri, details.isDirectory, languageId)]);

  const themeFile = iconThemeFile();
  const isRoot = (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.fsPath === p);
  const [icon, thumbnail] = await Promise.all([
    themeFile ? resolveIcon(themeFile, details.name, details.isDirectory, languageId, isLightTheme(), isRoot).catch(() => undefined) : undefined,
    !details.isDirectory && THUMBNAIL_EXTS.has(path.extname(p).toLowerCase()) ? toDataUri(p, 10_000_000) : undefined,
  ]);
  return { details: { ...details, sections }, icon, thumbnail };
}

/** Non-file schemes (remote, virtual): only what vscode.workspace.fs exposes. */
async function remoteViewModel(uri: vscode.Uri): Promise<ViewModel> {
  const st = await vscode.workspace.fs.stat(uri);
  const isDir = (st.type & vscode.FileType.Directory) !== 0;
  const fmt = (t: number) => (t ? new Date(t).toLocaleString() : '—');
  return {
    details: {
      path: uri.toString(),
      name: path.posix.basename(uri.path) || uri.toString(),
      isDirectory: isDir,
      headerSize: isDir ? '' : `${st.size.toLocaleString()} bytes`,
      headerModified: `Modified: ${fmt(st.mtime)}`,
      tags: [],
      signature: '',
      xattrs: [],
      complete: true,
      sections: [{
        id: 'general', title: 'General', rows: [
          { label: 'Kind', value: isDir ? 'Folder' : 'File' },
          { label: 'Size', value: `${st.size.toLocaleString()} bytes` },
          { label: 'Where', value: uri.with({ path: path.posix.dirname(uri.path) }).toString(), mono: true },
          { label: 'Created', value: fmt(st.ctime) },
          { label: 'Modified', value: fmt(st.mtime) },
          { label: 'Scheme', value: uri.scheme },
        ],
      }],
    },
  };
}

// ---------- messages shared by both webviews ----------

type Msg = { type: string; action?: string; text?: string; target?: string };

const RUNNABLE_RE = /\.(sh|bash|zsh|fish|command|tool|py|pl|rb|scpt|applescript|workflow|terminal|jar|exe|bat|cmd|ps1)$/i;

/** Opens a path with the OS default app (like double-clicking in Finder), or a web URL in the browser. */
async function openNative(target: string) {
  if (/^(https?|ftp):\/\//i.test(target)) {
    await vscode.env.openExternal(vscode.Uri.parse(target));
    return;
  }
  const st = path.isAbsolute(target) ? await fs.promises.stat(target).catch(() => undefined) : undefined;
  if (!st) {
    vscode.window.showWarningMessage(`File Details: ${target} no longer exists.`);
    return;
  }
  // Opening a script or executable with its default app (e.g. a terminal) runs it, as in Finder.
  if (st.isFile() && ((st.mode & 0o111) || RUNNABLE_RE.test(target))) {
    const choice = await vscode.window.showWarningMessage(
      `Open "${path.basename(target)}" with its default app?`,
      { modal: true, detail: 'It looks like a script or program, so opening it may run it.' },
      'Open',
    );
    if (choice !== 'Open') { return; }
  }
  if (process.platform === 'darwin') {
    const child = spawn('open', [target], { detached: true, stdio: 'ignore' });
    child.on('error', e => vscode.window.showErrorMessage(`File Details: couldn't open ${target}: ${e.message}`));
    child.unref();
  } else {
    await vscode.env.openExternal(vscode.Uri.file(target));
  }
}

const filledHtml = (v: string) => renderValue({ label: '', value: v, full: v, mono: true });

async function handleMessage(m: Msg, uri: vscode.Uri | undefined, post: (msg: unknown) => void) {
  if (m.type === 'copy' && m.text) { return vscode.env.clipboard.writeText(m.text); }
  if (m.type === 'openNative' && m.target) { return openNative(m.target); }
  if (m.type === 'action' && m.action === 'problems') { return vscode.commands.executeCommand('workbench.actions.view.problems'); }
  if (m.type !== 'action' || !uri) { return; }
  switch (m.action) {
    case 'reveal':
      return vscode.commands.executeCommand('revealFileInOS', uri);
    case 'copyPath':
      return vscode.env.clipboard.writeText(uri.scheme === 'file' ? uri.fsPath : uri.toString());
    case 'open':
      return vscode.commands.executeCommand('vscode.open', uri);
    case 'hashes':
    case 'folderSize': {
      if (uri.scheme !== 'file') { return; }
      const ids = m.action === 'hashes' ? ['md5', 'sha1', 'sha256'] : ['folderSize'];
      post({ type: 'fill', values: Object.fromEntries(ids.map(id => [id, filledHtml('Calculating…')])) });
      const values = await compute(uri.fsPath, m.action).catch(e => Object.fromEntries(ids.map(id => [id, `Error: ${(e as Error).message}`])));
      post({ type: 'fill', values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, filledHtml(v)])) });
      return;
    }
  }
}

// ---------- sidebar Details view ----------

class DetailsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private uri?: vscode.Uri;
  /** Last active tab we followed: only a real tab switch replaces a right-click selection. */
  private lastActiveTab?: string;
  private timer?: NodeJS.Timeout;
  private seq = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = shellHtml(view.webview.cspSource);
    view.webview.onDidReceiveMessage((m: Msg) => {
      if (m.type === 'ready') { return this.schedule(0); } // page (re)built, e.g. after being hidden
      const uri = this.uri;
      handleMessage(m, uri, msg => { if (this.uri === uri) { this.view?.webview.postMessage(msg); } });
    }, undefined, this.context.subscriptions);
    view.onDidChangeVisibility(() => { if (view.visible) { this.schedule(); } });
    view.onDidDispose(() => { this.view = undefined; });
    if (!this.uri) {
      this.uri = activeTabUri();
      this.lastActiveTab = this.uri?.toString();
    }
  }

  /** Right-click → Show Details: show this item in the sidebar view without stealing focus. */
  async reveal(uri: vscode.Uri) {
    this.uri = uri;
    if (this.view) {
      this.view.show(true);
      this.schedule(0);
    } else {
      await vscode.commands.executeCommand('fileDetails.view.focus');
    }
  }

  followActiveTab() {
    if (!vscode.workspace.getConfiguration('fileDetails').get<boolean>('followActiveEditor', true)) { return; }
    const uri = activeTabUri();
    const key = uri?.toString();
    if (!uri || key === this.lastActiveTab) { return; }
    this.lastActiveTab = key;
    if (key !== this.uri?.toString()) {
      this.uri = uri;
      this.schedule();
    }
  }

  refresh(hard: boolean) {
    if (hard) { detailsCache.clear(); }
    this.schedule();
  }

  refreshIf(uri: vscode.Uri) {
    if (uri.toString() === this.uri?.toString()) { this.schedule(); }
  }

  diagnosticsChanged(uris: readonly vscode.Uri[]) {
    const cur = this.uri;
    if (cur && uris.some(u => u.toString() === cur.toString() || u.fsPath.startsWith(cur.fsPath + path.sep))) {
      this.schedule(500);
    }
  }

  private schedule(delay = 120) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.update(), delay);
  }

  private async update() {
    const view = this.view;
    if (!view || !view.visible) { return; }
    const uri = this.uri;
    const seq = ++this.seq;
    const post = (r: Rendered) => { if (seq === this.seq) { view.webview.postMessage({ type: 'render', ...r }); } };
    if (!uri) { return post(renderMessage('Select a file to see its details.')); }
    try {
      if (uri.scheme !== 'file') { return post(renderDetails(await remoteViewModel(uri))); }
      // Two passes: the quick Finder-style fields first, then Git and Security when they're ready.
      const fast = await buildViewModel(uri, 'fast');
      post(renderDetails(fast));
      if (!fast.details.complete && seq === this.seq) { post(renderDetails(await buildViewModel(uri, 'full'))); }
    } catch (e) {
      post(renderMessage(`Can't read details for ${uri.fsPath || uri.toString()}: ${(e as Error).message}`));
    }
  }
}

// ---------- Compare Details editor tab ----------

const MAX_COMPARE = 6;
const MAX_COMPARE_HASH_BYTES = 1_000_000_000;

async function compareDetails(uri?: vscode.Uri, uris?: vscode.Uri[]) {
  let targets = (uris && uris.length > 1 ? uris : uri ? [uri] : []).filter(u => u.scheme === 'file');
  if (targets.length < 2) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true, canSelectFiles: true, canSelectFolders: true, defaultUri: targets[0],
      openLabel: 'Compare Details', title: targets.length ? `Compare ${path.basename(targets[0].fsPath)} with…` : 'Select items to compare',
    });
    if (!picked) { return; }
    const seen = new Set<string>();
    targets = [...targets, ...picked].filter(u => !seen.has(u.fsPath) && !!seen.add(u.fsPath));
  }
  if (targets.length < 2) {
    vscode.window.showInformationMessage('File Details: select two or more items to compare.');
    return;
  }
  if (targets.length > MAX_COMPARE) {
    vscode.window.showInformationMessage(`File Details: comparing the first ${MAX_COMPARE} of ${targets.length} items.`);
    targets = targets.slice(0, MAX_COMPARE);
  }

  const names = targets.map(u => path.basename(u.fsPath));
  const title = targets.length === 2 ? `${names[0]} ↔ ${names[1]}` : `Compare Details (${targets.length})`;
  const panel = vscode.window.createWebviewPanel('fileDetails.compare', title, vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [] });
  panel.webview.html = shellHtml(panel.webview.cspSource);
  const rendered = buildCompare(targets).catch(e => renderMessage(`Compare failed: ${(e as Error).message}`));
  panel.webview.onDidReceiveMessage(async (m: Msg) => {
    if (m.type === 'ready') { panel.webview.postMessage({ type: 'render', ...(await rendered) }); return; }
    handleMessage(m, undefined, () => undefined);
  });
}

async function buildCompare(targets: vscode.Uri[]): Promise<Rendered> {
  // Fill in hashes / folder sizes up front: they're the most useful thing to compare.
  await Promise.all(targets.map(async u => {
    const st = await fs.promises.stat(u.fsPath);
    if (st.isDirectory() || st.size <= MAX_COMPARE_HASH_BYTES) {
      await compute(u.fsPath, st.isDirectory() ? 'folderSize' : 'hashes').catch(() => undefined);
    }
  }));
  const vms = (await Promise.all(targets.map(u => buildViewModel(u, 'full')))).map(vm => ({
    ...vm,
    // Buttons can't tell which column they belong to here, so anything left uncomputed is marked skipped.
    details: {
      ...vm.details,
      sections: vm.details.sections.map(s => ({
        ...s, rows: s.rows.map(r => (r.action && r.action !== 'problems' ? { label: r.label, value: 'Skipped (large file)' } : r)),
      })),
    },
  }));
  const files = vms.filter(vm => !vm.details.isDirectory);
  let summary = `${vms.length} items`;
  if (files.length === vms.length) {
    const sums = files.map(vm => computed.get(computedKey(vm.details.path, vm.details.signature))?.sha256);
    summary = sums.every(Boolean)
      ? new Set(sums).size === 1 ? 'Contents identical (SHA-256 match)' : 'Contents differ'
      : `${vms.length} files`;
  }
  return renderCompare(vms, summary);
}
