// Gathers Finder-style "Get Info" details for a path.
// Pure Node (no `vscode` import) so it can be exercised from a plain node script.
import { ChildProcess, execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, promises as fsp, Stats } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

export interface Row {
  label: string;
  value: string;
  /** Stable identity for comparing rows across files when `label` varies (e.g. owner name). */
  key?: string;
  /** Full value shown on hover / used for copy, when `value` is abbreviated. */
  full?: string;
  mono?: boolean;
  /** Renders as a button that posts this action back to the extension. */
  action?: string;
  /** Element id filled in when `action` completes (defaults to the action name). */
  fillId?: string;
  /** Absolute path or URL: click copies, double-click opens it with the OS default handler. */
  open?: string;
}

export interface Section {
  id: string;
  title: string;
  rows: Row[];
}

export interface Details {
  path: string;
  name: string;
  isDirectory: boolean;
  headerSize: string;
  headerModified: string;
  tags: string[];
  sections: Section[];
  /** Signature of the stat result; cached details are reused while it is unchanged. */
  signature: string;
  xattrs: string[];
  /** False until the slow Git and Security sections have been added. */
  complete: boolean;
}

export interface DetailOptions {
  lineCountMaxBytes?: number;
  /** Include Git and Security (slower: blame, codesign, spctl). Default true. */
  includeSlow?: boolean;
}

const SECTION_ORDER = ['general', 'more', 'name', 'comments', 'openwith', 'git', 'loading', 'vscode', 'perms', 'security', 'checksums', 'advanced'];

export function sortSections(sections: Section[]): Section[] {
  const rank = (s: Section) => { const i = SECTION_ORDER.indexOf(s.id); return i < 0 ? SECTION_ORDER.length : i; };
  return [...sections].sort((a, b) => rank(a) - rank(b));
}

/** Adds the Git and Security sections to details gathered with includeSlow: false. */
export async function withSlowSections(d: Details): Promise<Details> {
  if (d.complete) { return d; }
  const st = await fsp.stat(d.path).catch(() => fsp.lstat(d.path));
  const [git, security] = await Promise.all([
    gitInfo(d.path, d.isDirectory, st.size).catch(() => [] as Row[]),
    securityInfo(d.path, st, d.xattrs).catch(() => [] as Row[]),
  ]);
  const sections = d.sections.filter(s => s.id !== 'loading');
  if (git.length) { sections.push({ id: 'git', title: 'Git', rows: git }); }
  if (security.length) { sections.push({ id: 'security', title: 'Security', rows: security }); }
  return { ...d, sections: sortSections(sections), complete: true };
}

interface ExecResult { code: number | null; stdout: string; stderr: string }

/** Runs a command with array args (no shell). Never rejects; code is null on spawn failure/timeout. */
export function exec(cmd: string, args: string[], opts: { input?: string; cwd?: string; timeout?: number } = {}): Promise<ExecResult> {
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); }
    };
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return finish(null);
    }
    timer = setTimeout(() => { child.kill(); finish(null); }, opts.timeout ?? 3000);
    child.stdout!.on('data', d => (stdout += d));
    child.stderr!.on('data', d => (stderr += d));
    child.on('error', () => finish(null));
    child.on('close', code => finish(code));
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(opts.input ?? '');
  });
}

/** stdout of a successful run, else undefined. */
export async function run(cmd: string, args: string[], opts: { input?: string; cwd?: string; timeout?: number } = {}): Promise<string | undefined> {
  const r = await exec(cmd, args, opts);
  return r.code === 0 ? r.stdout : undefined;
}

// ---------- formatting ----------

/** Finder-style size: base 1000, "1,531 bytes" / "2 KB" / "1.5 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1000) { return `${bytes} byte${bytes === 1 ? '' : 's'}`; }
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  const n = i === 0 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${n.toLocaleString()} ${units[i]}`;
}

function formatBytesExact(bytes: number): string {
  return `${bytes.toLocaleString()} byte${bytes === 1 ? '' : 's'}`;
}

let cachedLocale: string | undefined | null = null;

/** The Mac's region (e.g. en_GB → en-GB), so dates match Finder; the extension host's default may differ. */
function locale(): string | undefined {
  if (cachedLocale === null) {
    cachedLocale = undefined;
    if (isMac) {
      try {
        const raw = execFileSync('defaults', ['read', '-g', 'AppleLocale'], { encoding: 'utf8', timeout: 1000 });
        const tag = raw.trim().split('@')[0].replace(/_/g, '-');
        if (tag && Intl.DateTimeFormat.supportedLocalesOf(tag).length) { cachedLocale = tag; }
      } catch { /* fall back to default locale */ }
    }
  }
  return cachedLocale;
}

export function formatDate(d: Date): string {
  if (!d || isNaN(d.getTime()) || d.getTime() <= 0) { return '—'; }
  const date = d.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  return `${date} at ${time}`;
}

/** "Today, 05:13" / "Yesterday, 05:13" / full date, like Finder's header line. */
function formatRelative(d: Date): string {
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days === 0) { return `Today, ${time}`; }
  if (days === 1) { return `Yesterday, ${time}`; }
  return formatDate(d);
}

export function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

function modeString(st: Stats): string {
  const type = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : st.isFIFO() ? 'p' : st.isSocket() ? 's'
    : st.isCharacterDevice() ? 'c' : st.isBlockDevice() ? 'b' : '-';
  const m = st.mode;
  const bits = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'].map((c, i) => (m & (1 << (8 - i)) ? c : '-'));
  if (m & 0o4000) { bits[2] = bits[2] === 'x' ? 's' : 'S'; }
  if (m & 0o2000) { bits[5] = bits[5] === 'x' ? 's' : 'S'; }
  if (m & 0o1000) { bits[8] = bits[8] === 'x' ? 't' : 'T'; }
  return type + bits.join('');
}

/** Finder's privilege wording for one rwx triplet. */
function privilege(bits: number): string {
  const r = bits & 4, w = bits & 2;
  return r && w ? 'Read & Write' : r ? 'Read only' : w ? 'Write only (Drop Box)' : 'No Access';
}

function pathRow(label: string, p: string, extra: Partial<Row> = {}): Row {
  return { label, value: tildify(p), full: p, open: p, mono: true, ...extra };
}

// ---------- macOS / unix helpers ----------

interface Spotlight {
  kMDItemKind?: string;
  kMDItemContentType?: string;
  kMDItemUserTags?: string[];
  kMDItemWhereFroms?: string[];
  kMDItemFinderComment?: string;
  kMDItemFSIsExtensionHidden?: number | boolean;
  kMDItemPixelWidth?: number;
  kMDItemPixelHeight?: number;
  kMDItemDurationSeconds?: number;
  kMDItemNumberOfPages?: number;
  kMDItemVersion?: string;
  kMDItemCodecs?: string[];
}

// Date-valued keys must not be requested: plutil can't convert plist <date> to JSON.
const MDLS_KEYS: (keyof Spotlight)[] = [
  'kMDItemKind', 'kMDItemContentType', 'kMDItemUserTags', 'kMDItemWhereFroms', 'kMDItemFinderComment',
  'kMDItemFSIsExtensionHidden', 'kMDItemPixelWidth', 'kMDItemPixelHeight', 'kMDItemDurationSeconds',
  'kMDItemNumberOfPages', 'kMDItemVersion', 'kMDItemCodecs',
];

async function spotlight(p: string): Promise<Spotlight> {
  if (!isMac) { return {}; }
  const args = ['-plist', '-'];
  for (const k of MDLS_KEYS) { args.push('-name', k); }
  args.push(p);
  const plist = await run('mdls', args);
  if (!plist) { return {}; }
  const json = await run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist });
  try { return json ? JSON.parse(json) : {}; } catch { return {}; }
}

async function ownerInfo(p: string): Promise<{ user?: string; group?: string; flags?: string }> {
  if (isWin) { return {}; }
  const out = isMac
    ? await run('stat', ['-f', '%Su|%Sg|%Sf', p])
    : await run('stat', ['-c', '%U|%G|', p]);
  if (!out) { return {}; }
  const [user, group, flags] = out.trim().split('|');
  return { user, group, flags: flags && flags !== '-' ? flags : undefined };
}

async function xattrNames(p: string): Promise<string[]> {
  if (!isMac) { return []; }
  const out = await run('xattr', ['-s', p]);
  return out ? out.split('\n').map(s => s.trim()).filter(Boolean) : [];
}

async function defaultApp(p: string): Promise<string | undefined> {
  if (!isMac) { return undefined; }
  const script = 'function run(argv){ObjC.import("AppKit");'
    + 'var u=$.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(argv[0]));'
    + 'return u.isNil()?"":u.path.js;}';
  const out = (await run('osascript', ['-l', 'JavaScript', '-e', script, p]))?.trim();
  return out || undefined;
}

const BUNDLE_RE = /\.(app|framework|bundle|appex|kext|plugin|xpc)$/i;
const MACHO_MAGIC = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca']);

async function isMachO(p: string): Promise<boolean> {
  const fh = await fsp.open(p, 'r').catch(() => undefined);
  if (!fh) { return false; }
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(4), 0, 4, 0);
    return bytesRead === 4 && MACHO_MAGIC.has(buffer.toString('hex'));
  } finally {
    await fh.close();
  }
}

/** Quarantine, code signature and Gatekeeper rows (macOS only). */
async function securityInfo(p: string, st: Stats, xattrs: string[]): Promise<Row[]> {
  if (!isMac) { return []; }
  const rows: Row[] = [];

  if (xattrs.includes('com.apple.quarantine')) {
    // flags;hex-timestamp;agent;uuid
    const q = (await run('xattr', ['-p', 'com.apple.quarantine', p]))?.trim().split(';') ?? [];
    const when = q[1] ? formatDate(new Date(parseInt(q[1], 16) * 1000)) : '';
    rows.push({ label: 'Quarantined', value: ['Yes', q[2], when].filter(Boolean).join(' · ') });
  } else {
    rows.push({ label: 'Quarantined', value: 'No' });
  }
  if (xattrs.includes('com.apple.provenance')) {
    rows.push({ label: 'Provenance', value: 'Yes (com.apple.provenance)' });
  }

  const signable = st.isDirectory() ? BUNDLE_RE.test(p) : st.isFile() && (/\.(dylib|so)$/i.test(p) || await isMachO(p));
  if (signable) {
    const cs = await exec('codesign', ['-dv', '--verbose=2', p], { timeout: 5000 });
    const out = cs.stderr;
    if (cs.code === 0) {
      const authority = /^Authority=(.+)$/m.exec(out)?.[1];
      const team = /^TeamIdentifier=(.+)$/m.exec(out)?.[1];
      const adhoc = /Signature=adhoc/.test(out);
      rows.push({ label: 'Code signature', value: adhoc ? 'Ad-hoc signed' : authority ?? 'Signed' });
      if (team && team !== 'not set') { rows.push({ label: 'Team ID', value: team, mono: true }); }
    } else {
      rows.push({ label: 'Code signature', value: /not signed/.test(out) ? 'Not signed' : 'Invalid or unreadable' });
    }
    if (st.isDirectory() && /\.app$/i.test(p)) {
      const gk = await exec('spctl', ['--assess', '--type', 'execute', '-vv', p], { timeout: 8000 });
      const source = /source=(.+)$/m.exec(gk.stderr)?.[1];
      if (gk.code !== null) {
        rows.push({ label: 'Gatekeeper', value: `${gk.code === 0 ? 'Accepted' : 'Rejected'}${source ? ` (${source})` : ''}` });
      }
    }
  }
  return rows;
}

async function gitInfo(p: string, isDir: boolean, size: number): Promise<Row[]> {
  const cwd = isDir ? p : path.dirname(p);
  const target = isDir ? '.' : path.basename(p);
  const root = (await run('git', ['rev-parse', '--show-toplevel'], { cwd }))?.trim();
  if (!root) { return []; }
  const git = (args: string[], timeout?: number) => run('git', args, { cwd, timeout });

  const [branch, status, ignored, log, count, added, authors] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    isDir ? Promise.resolve(undefined) : git(['status', '--porcelain=v1', '--ignored', '--', target]),
    git(['check-ignore', '-v', '--', target]),
    git(['log', '-1', '--format=%h%x1f%an%x1f%ar%x1f%s', '--', target]),
    git(['rev-list', '--count', 'HEAD', '--', target]),
    isDir ? Promise.resolve(undefined) : git(['log', '--diff-filter=A', '--follow', '--format=%ar%x1f%an', '--', target], 5000),
    isDir ? topCommitters(cwd, target) : size <= 2_000_000 ? topBlameAuthors(cwd, target) : Promise.resolve(undefined),
  ]);

  const rows: Row[] = [pathRow('Repository', root, { value: path.basename(root), mono: false })];
  if (branch) { rows.push({ label: 'Branch', value: branch.trim() }); }
  if (status !== undefined) {
    const code = status.slice(0, 2);
    const map: Record<string, string> = {
      '??': 'Untracked', '!!': 'Ignored', 'A ': 'Added', 'M ': 'Modified (staged)', ' M': 'Modified',
      'MM': 'Modified (partly staged)', 'R ': 'Renamed', 'D ': 'Deleted', ' D': 'Deleted', 'AM': 'Added, modified',
    };
    rows.push({ label: 'Status', value: status.trim() === '' ? 'Unmodified' : map[code] ?? code.trim() });
  }
  // check-ignore -v: "<source>:<line>:<pattern>\t<path>"
  const ig = ignored?.split('\t')[0].trim();
  if (ig) {
    const m = /^(.*):(\d+):(.*)$/.exec(ig);
    rows.push({ label: 'Ignored', value: m ? `Yes — ${m[1]}:${m[2]} (${m[3]})` : 'Yes' });
  } else {
    rows.push({ label: 'Ignored', value: 'No' });
  }
  if (count && count.trim() !== '0') { rows.push({ label: 'Commits', value: Number(count.trim()).toLocaleString() }); }
  const firstAdd = added?.trim().split('\n').pop();
  if (firstAdd) {
    const [when, who] = firstAdd.split('\x1f');
    rows.push({ label: 'Added to Git', value: `${when} · ${who}` });
  }
  if (log?.trim()) {
    const [hash, author, when, subject] = log.trim().split('\x1f');
    rows.push({ label: 'Last commit', value: `${hash} · ${when} · ${author}` });
    rows.push({ label: 'Message', value: subject });
  }
  if (authors) { rows.push({ label: isDir ? 'Top committers' : 'Blame', value: authors }); }
  return rows;
}

function summariseCounts(counts: Map<string, number>, unit: (n: number, total: number) => string): string | undefined {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!total) { return undefined; }
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 3).map(([name, n]) => `${name} ${unit(n, total)}`);
  if (sorted.length > 3) { top.push(`+${sorted.length - 3} more`); }
  return top.join(', ');
}

/** Share of lines per author, e.g. "Alice 62%, Bob 38%". */
async function topBlameAuthors(cwd: string, target: string): Promise<string | undefined> {
  const out = await run('git', ['blame', '--line-porcelain', '--', target], { cwd, timeout: 5000 });
  if (!out) { return undefined; }
  const counts = new Map<string, number>();
  for (const line of out.split('\n')) {
    if (line.startsWith('author ')) {
      const a = line.slice(7) === 'Not Committed Yet' ? 'Uncommitted' : line.slice(7);
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
  }
  return summariseCounts(counts, (n, total) => `${Math.round((n / total) * 100)}%`);
}

/** Commits per author for a folder, e.g. "Alice (40), Bob (12)". */
async function topCommitters(cwd: string, target: string): Promise<string | undefined> {
  const out = await run('git', ['shortlog', '-sn', 'HEAD', '--', target], { cwd, timeout: 5000 });
  if (!out) { return undefined; }
  const counts = new Map<string, number>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) { counts.set(m[2], Number(m[1])); }
  }
  return summariseCounts(counts, n => `(${n})`);
}

// ---------- text analysis ----------

interface TextInfo { lines: number; endings: string; encoding: string }

async function textInfo(p: string, size: number, maxBytes: number): Promise<TextInfo | undefined> {
  if (size === 0 || size > maxBytes) { return undefined; }
  const buf = await fsp.readFile(p);
  const head = buf.subarray(0, 8000);
  if (head.includes(0)) { return undefined; }
  let encoding: string;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    encoding = 'UTF-8 with BOM';
  } else {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
      encoding = buf.every(b => b < 0x80) ? 'ASCII' : 'UTF-8';
    } catch {
      return undefined;
    }
  }
  let lf = 0, crlf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) { if (i > 0 && buf[i - 1] === 0x0d) { crlf++; } else { lf++; } }
  }
  const lines = lf + crlf + (buf[buf.length - 1] === 0x0a ? 0 : 1);
  const endings = crlf && lf ? 'Mixed (LF + CRLF)' : crlf ? 'CRLF' : lf ? 'LF' : '—';
  return { lines, endings, encoding };
}

function fallbackKind(name: string, st: Stats): string {
  if (st.isDirectory()) { return 'Folder'; }
  if (st.isSymbolicLink()) { return 'Alias'; }
  const ext = path.extname(name).slice(1);
  return ext ? `${ext.toUpperCase()} file` : 'Document';
}

export function statSignature(st: Stats): string {
  return `${st.mtimeMs}|${st.ctimeMs}|${st.size}|${st.ino}`;
}

// ---------- main ----------

export async function getDetails(p: string, opts: DetailOptions = {}): Promise<Details> {
  const lst = await fsp.lstat(p);
  const isLink = lst.isSymbolicLink();
  let st = lst;
  let linkTarget: string | undefined;
  if (isLink) {
    linkTarget = await fsp.readlink(p).catch(() => undefined);
    st = await fsp.stat(p).catch(() => lst);
  }
  const isDir = st.isDirectory();
  const name = path.basename(p) || p;

  const [md, owner, xattrs, app, text, children, real] = await Promise.all([
    spotlight(p),
    ownerInfo(p),
    xattrNames(p),
    isDir && !p.endsWith('.app') ? Promise.resolve(undefined) : defaultApp(p),
    st.isFile() ? textInfo(p, st.size, opts.lineCountMaxBytes ?? 5_000_000).catch(() => undefined) : Promise.resolve(undefined),
    isDir ? fsp.readdir(p).then(e => e.length).catch(() => undefined) : Promise.resolve(undefined),
    fsp.realpath(p).catch(() => undefined),
  ]);

  const tags = (md.kMDItemUserTags ?? []).map(t => t.split('\n')[0]);
  const onDisk = (st.blocks ?? 0) * 512;
  const kind = md.kMDItemKind || fallbackKind(name, lst);

  // General
  const general: Row[] = [{ label: 'Kind', value: kind }];
  if (isDir) {
    general.push({ label: 'Items', value: children === undefined ? '—' : children.toLocaleString() });
    general.push({ label: 'Size', value: 'Calculate…', action: 'folderSize' });
  } else {
    general.push({ label: 'Size', value: `${formatBytesExact(st.size)} (${formatSize(onDisk)} on disk)` });
  }
  general.push(pathRow('Where', path.dirname(p), { mono: false }));
  general.push({ label: 'Created', value: formatDate(st.birthtime) });
  general.push({ label: 'Modified', value: formatDate(st.mtime) });
  general.push({ label: 'Last accessed', value: formatDate(st.atime) });
  if (owner.flags !== undefined || isMac) {
    const flags = owner.flags ?? '';
    general.push({ label: 'Locked', value: /uchg/.test(flags) ? 'Yes' : 'No' });
    if (/hidden/.test(flags) || name.startsWith('.')) { general.push({ label: 'Hidden', value: 'Yes' }); }
  }

  // More Info
  const more: Row[] = [];
  if (md.kMDItemContentType) { more.push({ label: 'Content type', value: md.kMDItemContentType, mono: true }); }
  if (md.kMDItemPixelWidth && md.kMDItemPixelHeight) {
    more.push({ label: 'Dimensions', value: `${md.kMDItemPixelWidth} × ${md.kMDItemPixelHeight}` });
  }
  if (md.kMDItemDurationSeconds) {
    const s = Math.round(md.kMDItemDurationSeconds);
    more.push({ label: 'Duration', value: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` });
  }
  if (md.kMDItemCodecs?.length) { more.push({ label: 'Codecs', value: md.kMDItemCodecs.join(', ') }); }
  if (md.kMDItemNumberOfPages) { more.push({ label: 'Pages', value: String(md.kMDItemNumberOfPages) }); }
  if (md.kMDItemVersion) { more.push({ label: 'Version', value: md.kMDItemVersion }); }
  if (text) {
    more.push({ label: 'Lines', value: text.lines.toLocaleString() });
    more.push({ label: 'Encoding', value: text.encoding });
    more.push({ label: 'Line endings', value: text.endings });
  }
  for (const w of (md.kMDItemWhereFroms ?? []).filter(Boolean)) {
    more.push({ label: 'Where from', value: w, mono: true, open: /^(https?|ftp):\/\//i.test(w) ? w : undefined });
  }

  // Name & Extension
  const ext = isDir ? '' : path.extname(name);
  const nameRows: Row[] = [
    { label: 'Name', value: name, mono: true },
    { label: 'Extension', value: ext || '—' },
  ];
  if (isMac && !isDir) {
    nameRows.push({ label: 'Hide extension', value: md.kMDItemFSIsExtensionHidden ? 'Yes' : 'No' });
  }

  // Sharing & Permissions
  const me = typeof process.getuid === 'function' ? process.getuid() : -1;
  const perms: Row[] = [];
  if (!isWin) {
    const m = st.mode;
    perms.push({ key: 'Owner', label: `${owner.user ?? st.uid}${st.uid === me ? ' (Me)' : ''}`, value: privilege((m >> 6) & 7) });
    perms.push({ key: 'Group', label: owner.group ?? String(st.gid), value: privilege((m >> 3) & 7) });
    perms.push({ key: 'Everyone', label: 'everyone', value: privilege(m & 7) });
    perms.push({ label: 'Mode', value: `${modeString(lst)}  (${(m & 0o7777).toString(8).padStart(3, '0')})`, mono: true });
    if (owner.flags) { perms.push({ label: 'Flags', value: owner.flags, mono: true }); }
  }
  perms.push({ label: 'Extended attrs', value: xattrs.length ? xattrs.join(', ') : 'None', mono: xattrs.length > 0 });

  // Checksums (computed on demand)
  const sums: Row[] = isDir ? [] : [
    { label: 'MD5', value: 'Calculate…', action: 'hashes', fillId: 'md5' },
    { label: 'SHA-1', value: 'Calculate…', action: 'hashes', fillId: 'sha1' },
    { label: 'SHA-256', value: 'Calculate…', action: 'hashes', fillId: 'sha256' },
  ];

  // Advanced
  const adv: Row[] = [pathRow('Full path', p)];
  const fileUrl = pathToFileURL(p).href;
  adv.push({ label: 'File URL', value: fileUrl, full: fileUrl, open: p, mono: true });
  if (isLink && linkTarget) { adv.push(pathRow('Symlink to', path.resolve(path.dirname(p), linkTarget), { value: linkTarget })); }
  if (real && real !== p) { adv.push(pathRow('Real path', real)); }
  adv.push({ label: 'Status changed', value: formatDate(st.ctime) });
  adv.push({ label: 'Inode', value: String(st.ino), mono: true });
  adv.push({ label: 'Hard links', value: String(st.nlink) });
  adv.push({ label: 'Block size', value: formatBytesExact(st.blksize) });

  const sections: Section[] = [
    { id: 'general', title: 'General', rows: general },
    { id: 'more', title: 'More Info', rows: more },
    { id: 'name', title: 'Name & Extension', rows: nameRows },
  ];
  if (md.kMDItemFinderComment) {
    sections.push({ id: 'comments', title: 'Comments', rows: [{ label: '', value: md.kMDItemFinderComment }] });
  }
  if (app) {
    sections.push({ id: 'openwith', title: 'Open With', rows: [pathRow('Default app', app, { value: path.basename(app, '.app'), mono: false })] });
  }
  sections.push({ id: 'loading', title: 'Git & Security', rows: [{ label: '', value: 'Loading…' }] });
  sections.push({ id: 'perms', title: 'Sharing & Permissions', rows: perms });
  if (sums.length) { sections.push({ id: 'checksums', title: 'Checksums', rows: sums }); }
  sections.push({ id: 'advanced', title: 'Advanced', rows: adv });

  const fast: Details = {
    path: p,
    name,
    isDirectory: isDir,
    headerSize: isDir ? `${children ?? 0} item${children === 1 ? '' : 's'}` : formatSize(st.size),
    headerModified: `Modified: ${formatRelative(st.mtime)}`,
    tags,
    sections,
    signature: statSignature(lst),
    xattrs,
    complete: false,
  };
  return opts.includeSlow === false ? fast : withSlowSections(fast);
}

export interface Hashes { md5: string; sha1: string; sha256: string }

/** MD5, SHA-1 and SHA-256 in a single read. */
export function hashes(p: string): Promise<Hashes> {
  return new Promise((resolve, reject) => {
    const hs = { md5: createHash('md5'), sha1: createHash('sha1'), sha256: createHash('sha256') };
    createReadStream(p)
      .on('data', d => { hs.md5.update(d); hs.sha1.update(d); hs.sha256.update(d); })
      .on('error', reject)
      .on('end', () => resolve({ md5: hs.md5.digest('hex'), sha1: hs.sha1.digest('hex'), sha256: hs.sha256.digest('hex') }));
  });
}

/** Folder disk usage via `du -sk`; undefined on timeout / unsupported. */
export async function folderSize(p: string): Promise<string | undefined> {
  if (isWin) { return undefined; }
  const out = await run('du', ['-sk', p], { timeout: 30000 });
  const kb = out ? parseInt(out, 10) : NaN;
  return isNaN(kb) ? undefined : `${formatSize(kb * 1024)} on disk`;
}
