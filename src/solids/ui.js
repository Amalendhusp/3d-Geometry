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
    on('#addCubeBtn', () => ws.addCube());
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
    const n = ws.comp.solids.length;
    $('#sheetLabel').textContent = `${n} cube${n === 1 ? '' : 's'} · ${ws.shell.panels.length} panels`;
    this.syncSolidAngle();
  }
}
