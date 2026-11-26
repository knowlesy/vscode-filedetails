// Resolves the active file icon theme's icon for a file, so the header matches the Explorer.
// Pure Node: the caller supplies the theme JSON path (found via vscode.extensions).
import { promises as fsp } from 'fs';
import * as path from 'path';

export type HeaderIcon =
  | { kind: 'img'; src: string }
  | { kind: 'font'; char: string; color?: string; family: string; size?: string; fontSrc: string; weight?: string; style?: string };

interface IconDef { iconPath?: string; fontCharacter?: string; fontColor?: string; fontId?: string; fontSize?: string }
interface Associations {
  file?: string; folder?: string; rootFolder?: string;
  fileExtensions?: Record<string, string>; fileNames?: Record<string, string>;
  languageIds?: Record<string, string>; folderNames?: Record<string, string>;
}
interface Theme extends Associations {
  iconDefinitions?: Record<string, IconDef>;
  fonts?: { id: string; src: { path: string; format?: string }[]; weight?: string; style?: string; size?: string }[];
  light?: Associations;
}

const themeCache = new Map<string, Promise<Theme | undefined>>();
const dataUriCache = new Map<string, Promise<string | undefined>>();

/** Strips // and /* comments and trailing commas outside strings. */
export function stripJsonc(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') { j += s[j] === '\\' ? 2 : 1; }
      out += s.slice(i, j + 1);
      i = j;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') { i++; }
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2);
      if (i < 0) { break; }
      i++;
    } else if (c === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) { j++; }
      if (s[j] !== '}' && s[j] !== ']') { out += c; }
    } else {
      out += c;
    }
  }
  return out;
}

function loadTheme(file: string): Promise<Theme | undefined> {
  let p = themeCache.get(file);
  if (!p) {
    p = fsp.readFile(file, 'utf8').then(t => JSON.parse(stripJsonc(t)) as Theme).catch(() => undefined);
    themeCache.set(file, p);
  }
  return p;
}

export function clearIconCaches() {
  themeCache.clear();
  dataUriCache.clear();
}

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

export function toDataUri(file: string, maxBytes = 10_000_000): Promise<string | undefined> {
  let p = dataUriCache.get(file);
  if (!p) {
    p = (async () => {
      const mime = MIME[path.extname(file).toLowerCase()];
      if (!mime) { return undefined; }
      const st = await fsp.stat(file);
      if (st.size > maxBytes) { return undefined; }
      return `data:${mime};base64,${(await fsp.readFile(file)).toString('base64')}`;
    })().catch(() => undefined);
    // Only theme assets are long-lived; don't pin user images in memory.
    if (maxBytes <= 1_000_000) { dataUriCache.set(file, p); }
  }
  return p;
}

export const THUMBNAIL_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.avif']);

export async function resolveIcon(
  themeFile: string, name: string, isDir: boolean, languageId: string | undefined, isLight: boolean, isRoot = false,
): Promise<HeaderIcon | undefined> {
  const theme = await loadTheme(themeFile);
  if (!theme?.iconDefinitions) { return undefined; }
  const layers: Associations[] = isLight && theme.light ? [theme.light, theme] : [theme];
  const pick = (map: keyof Associations, key?: string): string | undefined => {
    for (const l of layers) {
      const v = key === undefined ? l[map] : (l[map] as Record<string, string> | undefined)?.[key];
      if (typeof v === 'string') { return v; }
    }
    return undefined;
  };

  const lower = name.toLowerCase();
  let id: string | undefined;
  if (isDir) {
    id = pick('folderNames', lower) ?? (isRoot ? pick('rootFolder') : undefined) ?? pick('folder');
  } else {
    id = pick('fileNames', lower);
    // Longest compound extension first: "a.d.ts" tries "d.ts" then "ts".
    const parts = lower.split('.');
    for (let i = 1; !id && i < parts.length; i++) { id = pick('fileExtensions', parts.slice(i).join('.')); }
    id ??= languageId ? pick('languageIds', languageId) : undefined;
    id ??= pick('file');
  }
  const def = id ? theme.iconDefinitions[id] : undefined;
  if (!def) { return undefined; }
  const base = path.dirname(themeFile);

  if (def.iconPath) {
    const src = await toDataUri(path.resolve(base, def.iconPath), 1_000_000);
    return src ? { kind: 'img', src } : undefined;
  }
  if (def.fontCharacter) {
    const font = theme.fonts?.find(f => f.id === def.fontId) ?? theme.fonts?.[0];
    const fontPath = font?.src?.[0]?.path;
    if (!font || !fontPath) { return undefined; }
    const fontSrc = await toDataUri(path.resolve(base, fontPath), 1_000_000);
    if (!fontSrc) { return undefined; }
    const fc = def.fontCharacter;
    const char = fc.startsWith('\\') ? String.fromCodePoint(parseInt(fc.slice(1), 16)) : fc;
    return {
      kind: 'font', char, color: def.fontColor, family: `fdicon-${font.id}`, size: def.fontSize ?? font.size,
      fontSrc, weight: font.weight, style: font.style,
    };
  }
  return undefined;
}
