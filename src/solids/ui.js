import { PRESETS } from './workspace.js';
import { netSVG, viewPNG } from './exporter.js';

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
    on('#exportShellBtn', () => this.openExport());
    on('#exportClose', () => { $('#exportDialog').hidden = true; });
    on('#exportJsonBtn', () => this.exportFile());
    on('#exportSvgBtn', () => this.exportSVG());
    on('#exportPngBtn', () => this.exportPNG());
    on('#resetOrientBtn', () => ws.resetOrientation());
    on('#fitViewBtn', () => ws.fitView());
    on('#turnViewBtn', () => ws.stepView('up', 90));
    on('#tipViewBtn', () => ws.stepView('tip', 90));
    on('#layFlatBtn', () => ws.layFlat());
    on('#arrangeBtn', () => ws.arrangePieces());
    on('#otherNetsBtn', () => ws.otherNets());
    on('#rotLeftBtn', () => ws.rotatePiece(15));
    on('#rotRightBtn', () => ws.rotatePiece(-15));
    on('#labelsBtn', () => ws.toggleLabels());
    on('#shapeApplyBtn', () => ws.setSizeMM({ x: $('#shapeW').value, y: $('#shapeH').value, z: $('#shapeD').value }));
    on('#shapeResetBtn', () => ws.resetShape());
    on('#shapeUnpinBtn', () => (ws.shapeEdit.pin ? ws.shapeEdit.togglePin(ws.shapeEdit.pin) : app.toast('Nothing is pinned. Tap a side or corner of the net to pin it.')));
    on('#idsBtn', () => ws.toggleIds());
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

  openExport() {
    $('#exportMsg').textContent = '';
    $('#exportDialog').hidden = false;
  }

  note(msg) {
    $('#exportMsg').textContent = msg;
    this.app.toast(msg, 5000);
  }

  // Download a blob (works on a normal web page; embedded previews may
  // block downloads).
  download(blob, name) {
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      this.lastDownload = { name, size: blob.size, type: blob.type };
      return true;
    } catch {
      this.note('This browser view blocks downloads.');
      return false;
    }
  }

  stamp() { return new Date().toISOString().slice(0, 10); }

  exportFile() {
    const blob = new Blob([this.ws.exportText()], { type: 'application/json' });
    if (this.download(blob, `composition-${this.stamp()}.json`)) this.note('Composition saved as a file.');
  }

  exportSVG() {
    const ws = this.ws;
    const r = netSVG(ws.shell, { labels: $('#svgLabels').checked, ids: $('#svgIds').checked, tabs: $('#svgTabs').checked, title: `Net: ${ws.solidsText()}` });
    if (r.error) { this.note(`${r.error} (Layout → Lay net on surface.)`); return; }
    this.lastSVG = r;
    const ov = ws.shell.overlapReport();
    const blob = new Blob([r.svg], { type: 'image/svg+xml' });
    if (!this.download(blob, `net-${this.stamp()}.svg`)) return;
    let msg = `Net saved: ${Math.round(r.width)} × ${Math.round(r.height)} mm, ${r.counts.cut} cut, ${r.counts.mountain} mountain, ${r.counts.valley} valley${r.counts.flat ? `, ${r.counts.flat} no-fold` : ''} lines.`;
    if (r.tabs) msg += ` ${r.tabs} glue tabs${r.tabConflicts ? `, ${r.tabConflicts} of them overlap another part (check before cutting)` : ''}.`;
    if (ov.within || ov.between) msg += ` Warning: ${ov.within + ov.between} overlapping panel pair${ov.within + ov.between > 1 ? 's' : ''} in this layout.`;
    this.note(msg);
  }

  exportPNG() {
    const transparent = (document.querySelector('input[name="pngBg"]:checked') || {}).value !== 'scene';
    const r = viewPNG(this.app, { transparent });
    if (r.error) { this.note(r.error); return; }
    this.lastPNG = { width: r.width, height: r.height, transparent, length: r.url.length };
    fetch(r.url).then((res) => res.blob()).then((blob) => {
      if (this.download(blob, `view-${this.stamp()}.png`)) this.note(`Image saved: ${r.width} × ${r.height} px, ${transparent ? 'object only on a transparent background' : 'with the scene'}.`);
    });
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
    $('#labelsBtn').setAttribute('aria-pressed', String(!!ws.state.showLabels));
    if (ws.state.tool === 'shape') {
      const size = ws.shapeSize();
      for (const [id, v] of [['#shapeW', size.x], ['#shapeH', size.y], ['#shapeD', size.z]]) {
        const el = $(id);
        if (document.activeElement !== el) el.value = (Math.round(v * 10000) / 10).toString();
      }
    }
    $('#idsBtn').setAttribute('aria-pressed', String(!!ws.state.showIds));
    this.syncSolidAngle();
  }
}
