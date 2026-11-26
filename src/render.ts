// Renders Details into HTML fragments for the webviews. All values are escaped here.
import { Details, Row, Section } from './details';
import { HeaderIcon } from './iconTheme';

export interface FontFaceSpec { family: string; src: string; weight?: string; style?: string }
export interface Rendered { html: string; fonts: FontFaceSpec[] }

export interface ViewModel {
  details: Details;
  icon?: HeaderIcon;
  /** data: URI of an image preview, when the file is an image. */
  thumbnail?: string;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const OPEN_HINT = 'Click to copy · Double-click to open';

export function renderValue(r: Row): string {
  if (r.action) {
    return `<button class="link" data-action="${esc(r.action)}">${esc(r.value)}</button>`;
  }
  const copy = esc(r.full ?? r.value);
  if (r.open) {
    return `<span class="v openable${r.mono ? ' mono' : ''}" title="${copy}\n${OPEN_HINT}" data-copy="${copy}" data-open="${esc(r.open)}">${esc(r.value)}</span>`;
  }
  return `<span class="v${r.mono ? ' mono' : ''}" title="${copy}" data-copy="${copy}">${esc(r.value)}</span>`;
}

function renderRow(r: Row): string {
  const label = r.label ? `<span class="k" title="${esc(r.label)}">${esc(r.label)}</span>` : '';
  const fill = r.action ? ` data-fill="${esc(r.fillId ?? r.action)}"` : '';
  return `<div class="row${r.label ? '' : ' full'}"${fill}>${label}${renderValue(r)}</div>`;
}

function iconHtml(icon: HeaderIcon | undefined, isDir: boolean, fonts: FontFaceSpec[]): string {
  if (icon?.kind === 'img') { return `<img src="${esc(icon.src)}" alt="">`; }
  if (icon?.kind === 'font') {
    if (!fonts.some(f => f.family === icon.family)) {
      fonts.push({ family: icon.family, src: icon.fontSrc, weight: icon.weight, style: icon.style });
    }
    return `<span class="ficon" data-family="${esc(icon.family)}" data-char="${esc(icon.char)}"`
      + ` data-color="${esc(icon.color ?? '')}" data-size="${esc(icon.size ?? '')}"></span>`;
  }
  return isDir
    ? '<svg viewBox="0 0 16 16"><path d="M1.5 3h4l1.5 1.5h7.5v9h-13z"/></svg>'
    : '<svg viewBox="0 0 16 16"><path d="M3 1.5h6.5l3.5 3.5v9.5h-10z M9.5 1.5v3.5h3.5"/></svg>';
}

function sectionHtml(s: Section, body: string): string {
  return `<details data-id="${esc(s.id)}" open><summary>${esc(s.title)}</summary>${body}</details>`;
}

export function renderDetails(vm: ViewModel): Rendered {
  const d = vm.details;
  const fonts: FontFaceSpec[] = [];
  const tags = d.tags.length
    ? `<div class="tags">${d.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>`
    : '';
  const header = `
    <div class="header">
      <div class="icon">${iconHtml(vm.icon, d.isDirectory, fonts)}</div>
      <div class="title">
        <div class="name" title="${esc(d.path)}">${esc(d.name)}</div>
        <div class="sub">${esc(d.headerModified)}</div>
      </div>
      <div class="hsize">${esc(d.headerSize)}</div>
    </div>
    ${tags}
    <div class="actions">
      <button data-action="reveal">Reveal in Finder</button>
      <button data-action="copyPath">Copy Path</button>
      ${d.isDirectory ? '' : '<button data-action="open">Open</button>'}
    </div>`;
  const preview = vm.thumbnail
    ? sectionHtml({ id: 'preview', title: 'Preview', rows: [] }, `<div class="preview"><img src="${esc(vm.thumbnail)}" alt=""></div>`)
    : '';
  const sections = d.sections
    .filter(s => s.rows.length)
    .map(s => sectionHtml(s, s.rows.map(renderRow).join('')))
    .join('');
  return { html: header + sections + preview, fonts };
}

export function renderMessage(msg: string): Rendered {
  return { html: `<div class="empty">${esc(msg)}</div>`, fonts: [] };
}

/** Side-by-side table of several files' details; rows whose values differ are highlighted. */
export function renderCompare(vms: ViewModel[], summary: string): Rendered {
  const fonts: FontFaceSpec[] = [];
  // Union of rows, keyed by section + (key ?? label), in first-seen order.
  const order: { section: Section; key: string }[] = [];
  const seen = new Set<string>();
  const lookup = vms.map(vm => {
    const m = new Map<string, Row>();
    for (const s of vm.details.sections) {
      for (const r of s.rows) {
        const key = r.key ?? r.label;
        const id = `${s.id}\u0000${key}`;
        m.set(id, r);
        if (!seen.has(id)) { seen.add(id); order.push({ section: s, key }); }
      }
    }
    return m;
  });

  const head = vms.map(vm => `<th><div class="chead"><span class="icon small">${iconHtml(vm.icon, vm.details.isDirectory, fonts)}</span>`
    + `<span class="v openable mono" title="${esc(vm.details.path)}\n${OPEN_HINT}" data-copy="${esc(vm.details.path)}"`
    + ` data-open="${esc(vm.details.path)}">${esc(vm.details.name)}</span></div></th>`).join('');

  let body = '';
  let lastSection = '';
  for (const { section, key } of order) {
    if (section.id !== lastSection) {
      body += `<tr class="sect"><td colspan="${vms.length + 1}">${esc(section.title)}</td></tr>`;
      lastSection = section.id;
    }
    const id = `${section.id}\u0000${key}`;
    const cells = lookup.map(m => {
      const r = m.get(id);
      if (!r) { return { text: '', html: '<span class="none">—</span>' }; }
      const shown: Row = r.key ? { ...r, value: `${r.label}: ${r.value}` } : r;
      return { text: shown.value, html: renderValue(shown) };
    });
    const differs = new Set(cells.map(c => c.text)).size > 1;
    body += `<tr class="${differs ? 'diff' : 'same'}"><th scope="row">${esc(key)}</th>${cells.map(c => `<td>${c.html}</td>`).join('')}</tr>`;
  }

  const html = `
    <div class="ctoolbar">
      <span class="summary">${esc(summary)}</span>
      <label><input type="checkbox" id="onlyDiff"> Only differences</label>
    </div>
    <table class="compare"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
  return { html, fonts };
}
