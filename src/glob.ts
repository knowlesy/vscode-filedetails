// Minimal VS Code-style glob matching for files.exclude / search.exclude patterns.

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  let re = cache.get(glob);
  if (re) { return re; }
  let src = '';
  let inGroup = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        src += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        src += '[^/]*';
      }
    } else if (c === '?') {
      src += '[^/]';
    } else if (c === '{') {
      inGroup++;
      src += '(?:';
    } else if (c === '}' && inGroup) {
      inGroup--;
      src += ')';
    } else if (c === ',' && inGroup) {
      src += '|';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) { src += '\\['; continue; }
      let cls = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
      if (cls.startsWith('!')) { cls = '^' + cls.slice(1); }
      src += `[${cls}]`;
      i = end;
    } else {
      src += c.replace(/[.+^$()|\\/]/g, '\\$&');
    }
  }
  re = new RegExp(`^${src}$`, process.platform === 'linux' ? '' : 'i');
  cache.set(glob, re);
  return re;
}

export type ExcludeConfig = Record<string, boolean | { when?: string }>;

/**
 * First pattern that hides `relPath` or one of its parent folders, or undefined.
 * `siblingExists` checks `when` conditions such as "$(basename).ts".
 */
export function matchExclude(
  relPath: string, config: ExcludeConfig | undefined, siblingExists: (dir: string, name: string) => boolean,
): string | undefined {
  if (!config || !relPath) { return undefined; }
  const segments = relPath.split('/');
  for (const [pattern, value] of Object.entries(config)) {
    if (!value) { continue; }
    const re = globToRegExp(pattern.replace(/^\.\//, ''));
    for (let n = 1; n <= segments.length; n++) {
      const candidate = segments.slice(0, n).join('/');
      if (!re.test(candidate)) { continue; }
      if (typeof value === 'object' && value.when) {
        const name = segments[n - 1];
        const base = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
        const dir = segments.slice(0, n - 1).join('/');
        if (!siblingExists(dir, value.when.replace(/\$\(basename\)/g, base))) { continue; }
      }
      return pattern;
    }
  }
  return undefined;
}
