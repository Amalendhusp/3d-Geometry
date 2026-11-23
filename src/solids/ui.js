import { PRESETS } from './workspace.js';
import { netSVG, viewPNG } from './exporter.js';
import { refusalText } from './validate.js';

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
    // Navigation bar (every workspace).
    on('#navFit', () => app.nav.fitAll());
    on('#navFocus', () => app.nav.focusSelected());
    on('#navReset', () => app.nav.resetView());
    on('#navTurn', () => ws.setNavTurn());
    on('#navTurn90', () => ws.stepView('up', 90));
    on('#navTip90', () => ws.stepView('tip', 90));
    $$('[data-netmode]').forEach((b) => b.addEventListener('click', () => ws.setTool(b.dataset.netmode)));
    on('#layFlatBtn', () => ws.layFlat());
    on('#arrangeBtn', () => ws.arrangePieces());
    on('#otherNetsBtn', () => ws.otherNets());
    on('#rotLeftBtn', () => ws.rotatePiece(15));
    on('#rotRightBtn', () => ws.rotatePiece(-15));
    on('#labelsBtn', () => ws.toggleLabels());
    on('#shapeApplyBtn', () => ws.setSizeMM({ x: $('#shapeW').value, y: $('#shapeH').value, z: $('#shapeD').value }));
    on('#shapeResetBtn', () => ws.resetShape());
    $$('[data-smode]').forEach((b) => b.addEventListener('click', () => ws.shapeEdit.setMode(b.dataset.smode)));
    on('#pinBaseBtn', () => ws.shapeEdit.pinBase());
    $$('[data-tapmode]').forEach((b) => b.addEventListener('click', () => ws.shapeEdit.setTapMode(b.dataset.tapmode)));
    on('#clearSelBtn', () => ws.shapeEdit.clearSelection());
    on('#shrinkBtn', () => ws.shapeEdit.stepScale(0.9));
    on('#growBtn', () => ws.shapeEdit.stepScale(1.1));
    on('#clearPinsBtn', () => ws.shapeEdit.clearPins());
    on('#triBtn', () => ws.shapeEdit.triangulateAt());
    on('#resetEditsBtn', () => ws.shapeEdit.resetEdits());
    on('#shapeUnpinBtn', () => (ws.shapeEdit.pin ? ws.shapeEdit.togglePin(ws.shapeEdit.pin) : app.toast('Nothing is pinned. Tap a side or corner of the net to pin it.')));
    on('#idsBtn', () => ws.toggleIds());
    on('#importShellBtn', () => $('#importShellFile').click());
    on('#focusIssueBtn', () => ws.focusIssue());
    on('#nextIssueBtn', () => ws.nextIssue());
    on('#clearIssueBtn', () => ws.clearIssueFocus());
    on('#issueListBtn', () => { this.listOpen = !this.listOpen; this.render(); });
    on('#svgIssuesBtn', () => {
      $('#exportDialog').hidden = true;
      if (ws.state.tool !== 'layout') ws.setTool('layout');
      ws.focusIssue(0);
    });
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
    this.renderExportCheck();
    $('#exportDialog').hidden = false;
  }

  // What the SVG will contain, from the same check as the issue list.
  renderExportCheck() {
    const ws = this.ws;
    const check = ws.layoutCheck();
    const n = check.pieces.length;
    const ex = check.exportable;
    const closed = ws.shell.isClosed();
    let t;
    if (closed) t = 'The form is closed: unfold it (Layout, Lay net on surface) to export the net.';
    else if (ex.length === n) t = `All ${n} piece${n > 1 ? 's' : ''} will be exported${check.allOnTable ? '' : ' (tilted or raised pieces are drawn from their own plane)'}.`;
    else if (ex.length) t = `${ex.length} of ${n} pieces will be exported. Left out: ${check.excluded.map((pc) => `piece ${pc.index} (${pc.valid ? 'not flat' : 'invalid panels'})`).join(', ')}.`;
    else t = `Nothing can be exported yet. ${refusalText(check)}`;
    const ov = check.issues.filter((i) => i.kind === 'overlap').length;
    if (ov && !closed) t += ` ${ov} overlapping panel pair${ov > 1 ? 's' : ''}: check before cutting.`;
    $('#svgCheck').textContent = t;
    $('#svgIssuesBtn').hidden = closed || !check.issues.some((i) => i.severity !== 'info');
    $('#exportSvgBtn').disabled = closed || !ex.length;
  }

  // The persistent issue list (Layout and Shape tools).
  renderIssues() {
    const ws = this.ws;
    const card = $('#issueCard');
    const tool = ws.state.tool;
    const show = this.app.space === 'solids' && (tool === 'layout' || tool === 'shape') && !ws.shell.isClosed() && !ws.anim;
    card.hidden = !show;
    if (!show) return;
    const check = ws.layoutCheck();
    if (this.listOpen === undefined) this.listOpen = window.innerWidth > 640;
    $('#issueSummary').textContent = ws.issueSummary(check);
    card.classList.toggle('ok', !check.errors && !check.warnings);
    const cur = ws.focusedIssue();
    const has = check.issues.length > 0;
    const sevName = { error: 'Error', warning: 'Warning', info: 'Note' };
    $('#issueText').textContent = cur
      ? `${sevName[cur.severity]} ${ws.issueIdx + 1} of ${check.issues.length}: ${cur.text}`
      : has ? `${check.issues.length} item${check.issues.length > 1 ? 's' : ''} to look at. Focus issue highlights the first one.` : 'Nothing to fix: every piece is flat, valid and clear of the others.';
    $('#issueCard .iacts').hidden = !has;
    $('#focusIssueBtn').disabled = !has;
    $('#nextIssueBtn').disabled = !has || (check.issues.length < 2 && !!cur);
    $('#clearIssueBtn').hidden = !cur;
    const btn = $('#issueListBtn');
    btn.hidden = !has;
    btn.setAttribute('aria-expanded', String(!!this.listOpen));
    btn.textContent = this.listOpen ? 'Hide list' : `List (${check.issues.length})`;
    const ol = $('#issueList');
    ol.hidden = !has || !this.listOpen;
    const sig = check.issues.map((i) => i.key).join('|') + `#${cur ? ws.issueIdx : -1}`;
    if (sig === this.issueSig) return;
    this.issueSig = sig;
    ol.replaceChildren();
    check.issues.forEach((is, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      const sev = document.createElement('span');
      sev.className = `sev sev-${is.severity}`;
      sev.textContent = sevName[is.severity];
      b.append(sev, document.createTextNode(is.text));
      b.setAttribute('aria-current', String(!!cur && i === ws.issueIdx));
      b.addEventListener('click', () => ws.focusIssue(i));
      li.appendChild(b);
      ol.appendChild(li);
    });
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
    if (r.error) { this.note(r.error); this.renderExportCheck(); return; }
    this.lastSVG = r;
    const blob = new Blob([r.svg], { type: 'image/svg+xml' });
    if (!this.download(blob, `net-${this.stamp()}.svg`)) return;
    let msg = `Net saved: ${Math.round(r.width)} × ${Math.round(r.height)} mm, ${r.counts.cut} cut, ${r.counts.mountain} mountain, ${r.counts.valley} valley${r.counts.flat ? `, ${r.counts.flat} no-fold` : ''} lines.`;
    if (r.tabs) msg += ` ${r.tabs} glue tabs${r.tabConflicts ? `, ${r.tabConflicts} of them overlap another part (check before cutting)` : ''}.`;
    if (r.moved) msg += ` ${r.moved} tilted or raised piece${r.moved > 1 ? 's were' : ' was'} drawn from ${r.moved > 1 ? 'their' : 'its'} own plane.`;
    if (r.excluded.length) msg += ` Left out (not flat or invalid): ${r.excluded.map((pc) => `piece ${pc.index}`).join(', ')}; see Show issues.`;
    const ov = r.check.issues.filter((i) => i.kind === 'overlap').length;
    if (ov) msg += ` Warning: ${ov} overlapping panel pair${ov > 1 ? 's' : ''} in this layout.`;
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
    $$('[data-nav-solids]').forEach((b) => { b.hidden = !solids; });
    $('#navFocus').hidden = !solids;
    if (!solids) { $('#issueCard').hidden = true; return; }
    const tool = ws.state.tool;
    const netTool = tool === 'layout' || tool === 'shape';
    $$('[data-stool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.stool === tool || (b.dataset.stool === 'net' && netTool) || (b.dataset.stool === 'build' && tool === 'inspect'))));
    $$('[data-netmode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.netmode === tool)));
    $('#navTurn').setAttribute('aria-pressed', String(!!ws.navTurn));
    $$('[data-sfor]').forEach((c) => { c.hidden = c.dataset.sfor !== ws.state.tool; });
    $$('[data-omode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.omode === ws.state.openMode)));
    $('#solidsStats').textContent = ws.statusLine();
    $('#undoBtn').disabled = ws.history.length === 0;
    $('#sheetLabel').textContent = `${ws.solidsText()} · ${ws.shell.panels.length} panels`;
    if ($('#addTypeSel').value !== ws.addType) $('#addTypeSel').value = ws.addType;
    $('#labelsBtn').setAttribute('aria-pressed', String(!!ws.state.showLabels));
    const smode = ws.shapeEdit.mode;
    $$('[data-smode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.smode === smode)));
    $$('[data-smode-for]').forEach((g) => { g.hidden = g.dataset.smodeFor !== smode; });
    $$('[data-tapmode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tapmode === ws.shapeEdit.tapMode)));
    if (ws.state.tool === 'shape') {
      // Refill the size boxes only when the size itself changed, so numbers
      // being typed are never overwritten by an unrelated refresh.
      const size = ws.shapeSize();
      const key = size.toArray().map((v) => v.toFixed(6)).join();
      if (key !== this.sizeKey) {
        this.sizeKey = key;
        for (const [id, v] of [['#shapeW', size.x], ['#shapeH', size.y], ['#shapeD', size.z]]) {
          const el = $(id);
          if (document.activeElement !== el) el.value = (Math.round(v * 10000) / 10).toString();
        }
      }
    } else this.sizeKey = null;
    $('#idsBtn').setAttribute('aria-pressed', String(!!ws.state.showIds));
    this.syncSolidAngle();
    this.renderIssues();
    if (!$('#exportDialog').hidden) this.renderExportCheck();
  }
}
