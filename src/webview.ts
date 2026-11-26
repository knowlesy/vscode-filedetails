// HTML shell shared by the Details view and the Compare Details panel.
// The page receives { type: 'render', html, fonts } and { type: 'fill', values } messages.

export function shellHtml(cspSource: string): string {
  const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${cspSource}; font-src data:; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { padding: 0 12px 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .empty { color: var(--vscode-descriptionForeground); padding: 8px 0; }
  .header { display: flex; align-items: center; gap: 10px; padding: 8px 0 6px; }
  .icon { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; flex: none; font-size: 20px; line-height: 1; }
  .icon img, .icon svg { width: 32px; height: 32px; }
  .icon svg { fill: none; stroke: var(--vscode-icon-foreground, currentColor); stroke-width: 1; }
  .icon.small { width: 18px; height: 18px; font-size: 13px; }
  .icon.small img, .icon.small svg { width: 18px; height: 18px; }
  .title { flex: 1; min-width: 0; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub, .hsize { color: var(--vscode-descriptionForeground); font-size: 0.92em; }
  .hsize { white-space: nowrap; align-self: flex-start; padding-top: 2px; }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
  .tag { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 7px; font-size: 0.9em; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 8px; }
  .actions button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: 2px; padding: 3px 8px; cursor: pointer; font: inherit; }
  .actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  details { border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, transparent)); padding: 4px 0; }
  summary { cursor: pointer; font-weight: 600; padding: 2px 0; user-select: none; }
  .row { display: grid; grid-template-columns: minmax(90px, 38%) 1fr; gap: 8px; padding: 1px 0 1px 12px; }
  .row.full { grid-template-columns: 1fr; }
  .k { color: var(--vscode-descriptionForeground); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v { overflow-wrap: anywhere; cursor: copy; }
  .v:hover { text-decoration: underline dotted; }
  .v.openable { color: var(--vscode-textLink-foreground); cursor: pointer; user-select: none; }
  .v.openable:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .mono { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
  button.link { background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; text-align: left; }
  button.link:hover { text-decoration: underline; }
  .preview { padding: 4px 0 0 12px; }
  .preview img { max-width: 100%; max-height: 220px; border: 1px solid var(--vscode-panel-border, transparent);
    background: repeating-conic-gradient(#8882 0% 25%, transparent 0% 50%) 50% / 12px 12px; }
  #toast { position: fixed; left: 50%; bottom: 10px; transform: translateX(-50%); padding: 3px 10px; border-radius: 4px; pointer-events: none;
    background: var(--vscode-notifications-background, var(--vscode-editorWidget-background)); color: var(--vscode-notifications-foreground, inherit);
    border: 1px solid var(--vscode-notifications-border, var(--vscode-widget-border, transparent)); opacity: 0; transition: opacity .15s; white-space: nowrap; }
  #toast.show { opacity: 1; }
  .ctoolbar { display: flex; gap: 16px; align-items: center; padding: 10px 0; }
  .summary { font-weight: 600; }
  table.compare { border-collapse: collapse; width: 100%; }
  table.compare th, table.compare td { text-align: left; vertical-align: top; padding: 2px 10px 2px 0; }
  table.compare thead th { position: sticky; top: 0; background: var(--vscode-editor-background); padding-bottom: 6px; }
  table.compare tbody th { color: var(--vscode-descriptionForeground); font-weight: normal; white-space: nowrap; width: 1%; }
  .chead { display: flex; gap: 6px; align-items: center; }
  tr.sect td { font-weight: 600; padding-top: 10px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
  tr.diff td { background: var(--vscode-diffEditor-insertedTextBackground, rgba(255, 200, 0, .12)); }
  body.only-diff tr.same { display: none; }
  .none { color: var(--vscode-disabledForeground); }
</style>
</head>
<body>
<div id="root"><div class="empty">Loading…</div></div>
<div id="toast"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const toastEl = document.getElementById('toast');
  const state = vscode.getState() || { closed: [], onlyDiff: false };
  const loadedFonts = new Set();
  let toastTimer;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
  }
  function applyFonts(fonts) {
    for (const f of fonts || []) {
      if (loadedFonts.has(f.family)) continue;
      loadedFonts.add(f.family);
      const face = new FontFace(f.family, 'url(' + f.src + ')', { weight: f.weight || 'normal', style: f.style || 'normal' });
      face.load().then(x => document.fonts.add(x)).catch(() => {});
    }
    for (const el of root.querySelectorAll('.ficon')) {
      el.textContent = el.dataset.char;
      el.style.fontFamily = el.dataset.family;
      if (el.dataset.color) el.style.color = el.dataset.color;
      if (el.dataset.size) el.style.fontSize = el.dataset.size;
    }
  }
  root.addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (btn) { vscode.postMessage({ type: 'action', action: btn.dataset.action }); return; }
    const v = e.target.closest('[data-copy]');
    if (v && !window.getSelection().toString()) {
      vscode.postMessage({ type: 'copy', text: v.dataset.copy });
      toast(v.dataset.open ? 'Copied · double-click to open' : 'Copied');
    }
  });
  root.addEventListener('dblclick', e => {
    const v = e.target.closest('[data-open]');
    if (v) { vscode.postMessage({ type: 'openNative', target: v.dataset.open }); toast('Opening…'); }
  });
  root.addEventListener('toggle', e => {
    const id = e.target.dataset && e.target.dataset.id;
    if (!id) return;
    state.closed = state.closed.filter(x => x !== id);
    if (!e.target.open) state.closed.push(id);
    vscode.setState(state);
  }, true);
  root.addEventListener('change', e => {
    if (e.target.id === 'onlyDiff') {
      state.onlyDiff = e.target.checked;
      document.body.classList.toggle('only-diff', state.onlyDiff);
      vscode.setState(state);
    }
  });
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'render') {
      root.innerHTML = data.html;
      for (const id of state.closed) { const d = root.querySelector('details[data-id="' + id + '"]'); if (d) d.open = false; }
      const od = document.getElementById('onlyDiff');
      if (od) { od.checked = !!state.onlyDiff; document.body.classList.toggle('only-diff', od.checked); }
      applyFonts(data.fonts);
    } else if (data.type === 'fill') {
      for (const [id, html] of Object.entries(data.values)) {
        const row = root.querySelector('[data-fill="' + id + '"]');
        const target = row && row.querySelector('button, .v');
        if (target) target.outerHTML = html;
      }
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
