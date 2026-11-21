import { PRESETS } from './workspace.js';

// Screen controls for the Solid → Unfold workspace.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

export class SolidsUI {
  constructor(app) {
    this.app = app;
    this.ws = app.solids;
    this.build();
    app.listeners.add(() => this.render());
    this.render();
  }

  build() {
    const ws = this.ws;
    const app = this.app;
    $$('[data-space]').forEach((b) => b.addEventListener('click', () => app.setSpace(b.dataset.space)));
    $$('[data-stool]').forEach((b) => b.addEventListener('click', () => ws.setTool(b.dataset.stool)));
    $$('[data-omode]').forEach((b) => b.addEventListener('click', () => ws.setOpenMode(b.dataset.omode)));
    const on = (id, fn) => $(id).addEventListener('click', fn);
    on('#unfoldAllBtn', () => ws.unfoldAll());
    on('#refoldAllBtn', () => ws.refoldAll());
    on('#resetShellBtn', () => ws.resetLayout());
    on('#saveShellBtn', () => ws.save());
    on('#loadShellBtn', () => ws.load());
    on('#addCubeBtn', () => ws.addSolid($('#addTypeSel').value));
    $('#addTypeSel').addEventListener('change', (e) => ws.setAddType(e.target.value));
    on('#exportShellBtn', () => this.exportFile());
    on('#importShellBtn', () => $('#importShellFile').click());
    $('#importShellFile').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try { ws.loadData(JSON.parse(await f.text()), 'Imported'); } catch { app.toast('That file could not be read as a composition.'); }
    });
    on('#dupCubeBtn', () => ws.duplicate());
    on('#rotCubeBtn', () => ws.rotateSolid());
    on('#delCubeBtn', () => ws.removeSolid());
    on('#tipBtn', () => ws.turnAll('x'));
    on('#openFlatBtn', () => ws.openFlat());
    on('#closePanelBtn', () => ws.close());
    on('#setBaseBtn', () => ws.setBase());
    on('#defaultNetBtn', () => ws.defaultNet());
    on('#checkNetBtn', () => ws.checkNet());
    const sel = $('#presetSel');
    sel.appendChild(new Option('Choose…', ''));
    for (const [k, p] of Object.entries(PRESETS)) sel.appendChild(new Option(p.label, k));
    sel.addEventListener('change', () => {
      if (sel.value) ws.preset(sel.value);
      sel.value = '';
    });
    const ang = $('#hingeAngle');
    ang.addEventListener('input', () => { ws.setAngle(Number(ang.value), false); this.label(Number(ang.value)); });
    ang.addEventListener('change', () => ws.setAngle(Number(ang.value), true));
  }

  // Download the composition (works on a normal web page; embedded
  // previews may block downloads).
  exportFile() {
    try {
      const blob = new Blob([this.ws.exportText()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `composition-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      this.app.toast('Composition exported as a file.');
    } catch {
      this.app.toast('This browser view blocks downloads.');
    }
  }

  label(v) { $('#hingeAngleLabel').textContent = v === null ? '—' : `${Math.round(v)}°`; }

  syncSolidAngle() {
    const a = this.ws.selectedAngle();
    const el = $('#hingeAngle');
    el.disabled = a === null;
    if (a !== null && document.activeElement !== el) el.value = String(Math.round(a));
    this.label(a);
  }

  render() {
    const app = this.app;
    const ws = this.ws;
    const solids = app.space === 'solids';
    $('#paperDock').hidden = solids;
    $('#solidsDock').hidden = !solids;
    $('#paperBtn').hidden = solids;
    $$('[data-space]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.space === app.space)));
    if (!solids) return;
    $$('[data-stool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.stool === ws.state.tool)));
    $$('[data-sfor]').forEach((c) => { c.hidden = c.dataset.sfor !== ws.state.tool; });
    $$('[data-omode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.omode === ws.state.openMode)));
    $('#solidsStats').textContent = ws.statusLine();
    $('#undoBtn').disabled = ws.history.length === 0;
    $('#sheetLabel').textContent = `${ws.solidsText()} · ${ws.shell.panels.length} panels`;
    if ($('#addTypeSel').value !== ws.addType) $('#addTypeSel').value = ws.addType;
    this.syncSolidAngle();
  }
}
