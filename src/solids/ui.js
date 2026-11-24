import { PRESETS } from './workspace.js';
import { netSVG, viewPNG } from './exporter.js';
import { refusalText } from './validate.js';
import { exportGLB, exportOBJ } from './export3d.js';
import { BUILD } from '../version.js';

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
    app.solidsPresets = PRESETS;
    $$('[data-space]').forEach((b) => b.addEventListener('click', () => app.setSpace(b.dataset.space)));
    $$('[data-stool]').forEach((b) => b.addEventListener('click', () => { ws.setTool(b.dataset.stool); this.sheetFor(b); }));
    $$('[data-omode]').forEach((b) => b.addEventListener('click', () => ws.setOpenMode(b.dataset.omode)));
    $$('[data-addtype]').forEach((b) => b.addEventListener('click', () => ws.setAddType(b.dataset.addtype)));
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('#unfoldAllBtn', () => ws.unfoldAll());
    on('#refoldAllBtn', () => ws.refoldAll());
    on('#resetShellBtn', () => ws.resetLayout());
    on('#addCubeBtn', () => ws.addSolid(ws.addType));
    $('#addTypeSel').addEventListener('change', (e) => ws.setAddType(e.target.value));
    on('#exportClose', () => { $('#exportDialog').hidden = true; });
    on('#exportJsonBtn', () => this.exportFile());
    on('#exportSvgBtn', () => this.exportSVG());
    on('#exportPngBtn', () => this.exportPNG());
    // View toolbar (every workspace and tab).
    on('#navFit', () => app.nav.fitAll());
    on('#navFocus', () => app.nav.focusSelected());
    on('#navReset', () => app.nav.resetView());
    on('#navTurn', () => ws.setNavTurn());
    on('#navTurn90', () => ws.stepView('up', 90));
    on('#navTip90', () => ws.stepView('tip', 90));
    on('#navMore', () => { const p = $('#navMorePanel'); p.hidden = !p.hidden; $('#navMore').setAttribute('aria-expanded', String(!p.hidden)); app.layoutChanged?.(); });
    on('#navLabels', () => { const nb = $('#navBar'); nb.classList.toggle('labelled'); this.store('navLabels', nb.classList.contains('labelled') ? '1' : ''); this.render(); app.layoutChanged?.(); });
    if (this.load('navLabels') === '1') $('#navBar').classList.add('labelled');
    on('#layFlatBtn', () => ws.layFlat());
    on('#arrangeBtn', () => ws.arrangePieces());
    on('#otherNetsBtn', () => ws.otherNets());
    on('#rotLeftBtn', () => ws.rotatePiece(15));
    on('#rotRightBtn', () => ws.rotatePiece(-15));
    on('#labelsBtn', () => ws.toggleLabels());
    on('#clearSelBtn', () => ws.shapeEdit.clearSelection());
    on('#triBtn', () => ws.shapeEdit.triangulateAt());
    on('#triPrevBtn', () => ws.triStep(-1));
    on('#triNextBtn', () => ws.triStep(1));
    on('#triApplyBtn', () => ws.triApply());
    on('#triCancelBtn', () => ws.triCancel());
    $$('[data-jmode]').forEach((b) => b.addEventListener('click', () => ws.setJoinMode(b.dataset.jmode)));
    on('#resetEditsBtn', () => ws.resetToRegular());
    // Solid Modeling sub-tools: Add / Remove, Symmetry, Scale.
    $$('[data-ssub]').forEach((b) => b.addEventListener('click', () => { ws.setSolidSub(b.dataset.ssub); this.sheetFor(b); }));
    $$('[data-mpick]').forEach((b) => b.addEventListener('click', () => ws.setMirrorPick(b.dataset.mpick)));
    on('#mirrorBtn', () => ws.reflectSelected());
    $$('.allModsBtn').forEach((b) => b.addEventListener('click', () => ws.selectAllModules()));
    $$('.clearModsBtn').forEach((b) => b.addEventListener('click', () => ws.clearModules()));
    on('#scaleDownBtn', () => ws.scaleSelected(0.8));
    on('#scaleUpBtn', () => ws.scaleSelected(1.25));
    on('#scaleHalfBtn', () => ws.scaleSelected(0.5));
    on('#scaleDoubleBtn', () => ws.scaleSelected(2));
    on('#idsBtn', () => ws.toggleIds());
    on('#suggestBtn', () => ws.resolveOverlaps());
    on('#altApplyBtn', () => ws.applyAlternative());
    on('#altMineBtn', () => { ws.endAlternatives(); app.toast('Kept my layout.'); });
    $$('[data-etap]').forEach((b) => b.addEventListener('click', () => ws.setEdgeTap(b.dataset.etap)));
    on('#exportGlbBtn', () => this.exportModel('glb'));
    on('#exportObjBtn', () => this.exportModel('obj'));
    on('#focusIssueBtn', () => ws.focusIssue());
    on('#nextIssueBtn', () => ws.nextIssue(1));
    on('#clearIssueBtn', () => ws.clearIssueFocus());
    on('#svgIssuesBtn', () => {
      $('#exportDialog').hidden = true;
      if (ws.state.tool !== 'layout') ws.setTool('layout');
      this.openDrop('errors');
      ws.focusIssue(0);
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
    const ang = $('#hingeAngle');
    ang.addEventListener('input', () => { ws.setAngle(Number(ang.value), false); this.label(Number(ang.value)); });
    ang.addEventListener('change', () => ws.setAngle(Number(ang.value), true));

    // Undo / Redo (both workspaces).
    // (Undo is bound by the Paper UI through the shared action.)
    on('#redoBtn', () => app.actions.redo());

    // Project menu.
    const menu = $('#projectMenu');
    const closeMenu = () => { menu.hidden = true; $('#menuBtn').setAttribute('aria-expanded', 'false'); };
    on('#menuBtn', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; $('#menuBtn').setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) menu.querySelector('button')?.focus(); });
    document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== $('#menuBtn') && !$('#menuBtn').contains(e.target)) closeMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); this.closeDrops(); } });
    const item = (id, fn) => on(id, () => { closeMenu(); fn(); });
    menu.addEventListener('click', (e) => { if (e.target.closest('button')) closeMenu(); });
    item('#newBtn', () => this.newProject());
    item('#loadShellBtn', () => this.openGallery());
    item('#saveShellBtn', () => this.saveProject());
    item('#importShellBtn', () => this.importFile());
    item('#exportShellBtn', () => this.openExport());
    $('#importShellFile').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      let data = null;
      try { data = JSON.parse(await f.text()); } catch { app.toast('That file could not be read as a composition.'); return; }
      if (app.space !== 'solids') app.setSpace('solids');
      ws.importProject(data, f.name);
    });
    on('#galleryClose', () => { $('#galleryDialog').hidden = true; });
    on('#galleryImport', () => { $('#galleryDialog').hidden = true; this.importFile(); });
    on('#newCancel', () => { $('#newDialog').hidden = true; });
    on('#saveCancel', () => { $('#saveDialog').hidden = true; this.afterSave = null; });
    on('#saveConfirm', () => this.confirmSave());
    $('#saveName').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.confirmSave(); });
    on('#confirmCancel', () => this.answerConfirm('cancel'));
    on('#confirmDiscard', () => this.answerConfirm('discard'));
    on('#confirmSave', () => this.answerConfirm('save'));
    const grid = $('#presetGrid');
    for (const [k, p] of Object.entries(PRESETS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.label;
      b.dataset.preset = k;
      b.addEventListener('click', () => { $('#newDialog').hidden = true; this.protect(() => { if (app.space !== 'solids') app.setSpace('solids'); ws.newProject(k); app.toast(`New project: ${p.label}.`); }); });
      grid.appendChild(b);
    }
    window.addEventListener('beforeunload', (e) => { if (ws.isDirty() && ws.changes > 0) { e.preventDefault(); e.returnValue = ''; } });

    // Diagnostics chips: collapsed by default.
    on('#infoChip', () => this.toggleDrop('info'));
    on('#errChip', () => this.toggleDrop('errors'));

    // Phone: tools in an expandable sheet.
    on('#sheetToggle', () => { this.sheetOpen = !this.sheetOpen; this.render(); app.layoutChanged?.(); });
    // Crossing the phone width (rotating a tablet, resizing a window):
    // the sheet starts collapsed on a phone and is always open on desktop.
    let wasPhone = window.innerWidth <= 640;
    window.addEventListener('resize', () => {
      const phone = window.innerWidth <= 640;
      if (phone !== wasPhone) { wasPhone = phone; this.sheetOpen = false; this.renderSheet(); app.layoutChanged?.(); }
    });
  }

  store(k, v) { try { localStorage.setItem(`pfs.ui.${k}`, v); } catch { /* ignore */ } }
  load(k) { try { return localStorage.getItem(`pfs.ui.${k}`); } catch { return null; } }

  // On phones, choosing a tab or a Net sub-tool opens its tools.
  sheetFor(b) {
    if (window.innerWidth > 640) return;
    if (b.closest('#solidTabs') || b.closest('.subtools')) { this.sheetOpen = true; this.render(); this.app.layoutChanged?.(); }
  }

  toggleDrop(which) { this.drop = this.drop === which ? null : which; this.render(); this.app.layoutChanged?.(); }
  openDrop(which) { this.drop = which; this.render(); this.app.layoutChanged?.(); }
  closeDrops() { if (this.drop) { this.drop = null; this.render(); this.app.layoutChanged?.(); } }

  // ------------------------------------------------------------- projects

  // Run `fn` once unsaved changes are dealt with (Save / Don't save / Cancel).
  protect(fn) {
    const ws = this.ws;
    if (this.app.space !== 'solids' || !ws.isDirty() || !ws.changes) { fn(); return; }
    const info = ws.projectInfo();
    $('#confirmText').textContent = `“${info.name}” has changes that are not saved. Save them before replacing it?`;
    $('#confirmDialog').hidden = false;
    this.pendingConfirm = fn;
    $('#confirmSave').focus();
  }

  answerConfirm(choice) {
    const fn = this.pendingConfirm;
    this.pendingConfirm = null;
    $('#confirmDialog').hidden = true;
    if (!fn || choice === 'cancel') return;
    if (choice === 'discard') { fn(); return; }
    this.saveProject(fn);
  }

  saveProject(after = null) {
    const ws = this.ws;
    if (this.app.space !== 'solids') { this.app.toast('Projects are saved from Solids. Paper sheets are kept while this page is open.'); return; }
    if (ws.projectInfo().id) { if (ws.saveProject() && after) after(); return; }
    this.afterSave = after;
    const inp = $('#saveName');
    inp.value = ws.projectInfo().name === 'Untitled' ? ws.autoName() : ws.projectInfo().name;
    $('#saveDialog').hidden = false;
    inp.focus(); inp.select();
  }

  confirmSave() {
    const name = $('#saveName').value.trim() || this.ws.autoName();
    $('#saveDialog').hidden = true;
    const ok = this.ws.saveProject(name);
    const after = this.afterSave;
    this.afterSave = null;
    if (ok && after) after();
  }

  newProject() {
    if (this.app.space !== 'solids') { this.app.ui?.openSheet?.(); $('#paperBtn')?.click(); return; }
    $('#newDialog').hidden = false;
  }

  importFile() { this.protect(() => $('#importShellFile').click()); }

  openGallery() {
    const ws = this.ws;
    const cards = $('#galleryCards');
    cards.replaceChildren();
    const list = ws.projectList();
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'No saved projects yet. Save puts the current project here.';
      cards.appendChild(p);
    }
    for (const e of list) {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.id = e.id;
      const th = document.createElement('div');
      th.className = 'thumb';
      if (e.thumb) th.style.backgroundImage = `url(${e.thumb})`;
      const b = document.createElement('b'); b.textContent = e.name;
      const sm = document.createElement('small'); sm.textContent = `${new Date(e.savedAt).toLocaleString()}${e.summary ? ` · ${e.summary}` : ''}`;
      const row = document.createElement('div'); row.className = 'row';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'primary'; open.textContent = 'Open';
      open.addEventListener('click', () => { $('#galleryDialog').hidden = true; this.protect(() => { if (this.app.space !== 'solids') this.app.setSpace('solids'); ws.openProject(e.id); }); });
      const del = document.createElement('button'); del.type = 'button'; del.textContent = 'Delete';
      del.addEventListener('click', () => { if (window.confirm(`Delete “${e.name}” from this browser? This cannot be undone.`)) { ws.deleteProject(e.id); this.openGallery(); } });
      row.append(open, del);
      card.append(th, b, sm, row);
      cards.appendChild(card);
    }
    $('#galleryDialog').hidden = false;
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
    if (closed) t = 'The form is closed: unfold it (Net → Arrange, Arrange net on surface) to export the net.';
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
    const show = this.app.space === 'solids' && this.drop === 'errors';
    card.hidden = !show;
    if (!show) return;
    if (ws.shell.isClosed() || ws.anim) {
      $('#issueSummary').textContent = ws.anim ? 'checking…' : `${ws.overlapPairs || 0} intersecting pair${ws.overlapPairs === 1 ? '' : 's'}`;
      $('#issueText').textContent = ws.anim ? 'Waiting for the movement to finish.' : `The form is closed. ${ws.overlapPairs ? 'Panels that pass through each other are red. ' : 'No panels pass through each other. '}The layout check (folds, overlaps, flatness) applies once the net is unfolded.`;
      $('#issueCard .iacts').hidden = true;
      $('#issueList').hidden = true;
      this.issueSig = null;
      return;
    }
    const check = ws.layoutCheck();
    this.listOpen = true;
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
    $('#focusIssueBtn').textContent = cur ? 'Focus' : 'Highlight first';
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
      // Highlight its panels, edges or corners; Focus brings it into view.
      b.addEventListener('click', () => ws.focusIssue(i, { camera: false }));
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

  // 3D model from the panels themselves (never the scene), real size.
  exportModel(kind) {
    const ws = this.ws;
    const pose = (document.querySelector('input[name="modelPose"]:checked') || {}).value === 'current' ? 'current' : 'assembled';
    const base = `model-${this.stamp()}-${pose}`;
    const header = [`Paper Fold Studio ${BUILD.version} (${BUILD.commit})`, ws.solidsText(), `${ws.shell.panels.length} panels`];
    const size = (v) => v.toArray().map((x) => x.toFixed(1)).join(' × ');
    const poseText = pose === 'assembled' ? 'assembled form' : 'current folded pose';
    if (kind === 'glb') {
      const r = exportGLB(ws.shell, ws.comp, { pose, generator: `Paper Fold Studio ${BUILD.version}`, meta: { solids: ws.solidsText(), build: BUILD.commit } });
      this.lastModel = { kind, pose, bytes: r.bytes.length, triangles: r.triangles, sizeMM: r.sizeMM.toArray(), name: `${base}.glb` };
      if (this.download(new Blob([r.bytes], { type: 'model/gltf-binary' }), `${base}.glb`)) this.note(`3D model saved (${poseText}): ${r.parts} solid${r.parts > 1 ? 's' : ''}, ${r.panels} panels, ${r.triangles} triangles, ${size(r.sizeMM)} mm. glTF units are metres.`);
      return;
    }
    const r = exportOBJ(ws.shell, ws.comp, { pose, name: base, header });
    this.lastModel = { kind, pose, faces: r.faces, vertices: r.vertices, sizeMM: r.sizeMM.toArray(), name: `${base}.obj`, mtl: `${base}.mtl`, obj: r.obj, mtlText: r.mtl };
    const ok = this.download(new Blob([r.obj], { type: 'text/plain' }), `${base}.obj`);
    // The .mtl goes alongside (keep both files in the same folder).
    setTimeout(() => this.download(new Blob([r.mtl], { type: 'text/plain' }), `${base}.mtl`), 400);
    if (ok) this.note(`3D model saved (${poseText}): ${base}.obj and ${base}.mtl, ${r.faces} faces, ${size(r.sizeMM)} mm. OBJ units are millimetres; keep the two files together.`);
  }

  // Compare "My layout" with the suggestions.
  renderAlternatives() {
    const ws = this.ws;
    const a = ws.alt;
    const card = $('#altCard');
    card.hidden = !a || this.app.space !== 'solids';
    if (!a) { this.altSig = null; return; }
    if (this.drop) { this.drop = null; }
    const res = a.result;
    $('#altSummary').textContent = a.searching ? `trying ${a.level} cut${a.level === 1 ? '' : 's'}… ${a.nodes} checked` : res ? `${res.pairs.length} overlapping pair${res.pairs.length === 1 ? '' : 's'} · ${a.list.length} option${a.list.length === 1 ? '' : 's'} · ${(res.ms / 1000).toFixed(1)} s` : '';
    $('#altNote').textContent = a.searching ? 'Keeping your hinges and cuts: one additional cut is tried first, then two, and so on.' : res ? res.note : '';
    const cur = a.idx >= 0 ? a.list[a.idx] : null;
    $('#altApplyBtn').disabled = a.searching || !cur || !cur.valid;
    $('#altApplyBtn').textContent = cur && !cur.valid ? 'Not valid' : 'Accept';
    const sig = `${a.searching}|${a.idx}|${a.list.length}`;
    if (sig === this.altSig) return;
    this.altSig = sig;
    const ol = $('#altList');
    ol.replaceChildren();
    if (a.searching) return;
    const best = a.result && a.result.proven.count ? 'fewest cuts, proven' : 'best found';
    const rows = [{ name: 'My layout', s: a.mine.stats, i: -1, mine: true }, ...a.list.map((s, i) => ({ name: `Option ${i + 1}${i === 0 ? ` (${best})` : ''}`, s, i }))];
    for (const r of rows) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'alt';
      const k = document.createElement('span'); k.className = 'k'; k.textContent = r.name;
      const st = document.createElement('span'); st.className = 's'; st.textContent = r.s ? ws.altStatsText(r.s, !!r.mine) : '';
      b.append(k, st);
      b.setAttribute('aria-current', String(r.i === a.idx));
      b.addEventListener('click', () => ws.previewAlternative(r.i));
      li.appendChild(b);
      ol.appendChild(li);
    }
    if (cur) {
      // Why each additional cut was chosen.
      for (const t of ws.altWhy(cur)) {
        const li = document.createElement('li');
        li.className = 'legend-alt';
        li.textContent = t;
        ol.appendChild(li);
      }
      const lg = document.createElement('li');
      lg.className = 'legend-alt';
      lg.innerHTML = 'On the net: <i style="background:#ff3df0"></i>additional cut. Everything else keeps its hinges, cuts and place; only the freed part moves.';
      ol.appendChild(lg);
    }
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
    const labelled = $('#navBar').classList.contains('labelled');
    $('#navLabels').setAttribute('aria-pressed', String(labelled));
    $('#navLabels .nl').textContent = labelled ? 'Hide labels' : 'Show labels';
    // Undo / Redo for the active workspace.
    $('#undoBtn').disabled = solids ? ws.history.length === 0 : !app.history.canUndo;
    $('#redoBtn').disabled = solids ? !ws.canRedo() : !app.history.canRedo;
    // Project title.
    const info = ws.projectInfo();
    $('#projectName').textContent = solids ? info.name : 'Paper sheet';
    const st = $('#projectState');
    const dirty = solids && info.dirty && !!ws.changes;
    st.textContent = !solids ? `${(app.paper.W * 100).toFixed(0)} × ${(app.paper.H * 100).toFixed(0)} cm` : dirty ? 'Unsaved changes' : info.savedAt ? `Saved ${new Date(info.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not saved yet';
    st.classList.toggle('dirty', dirty);
    $('#menuTitle').textContent = `${$('#projectName').textContent} · ${st.textContent}`;
    $('#saveShellBtn').disabled = !solids;
    $('#diagChips').hidden = !solids;
    if (!solids) { $('#issueCard').hidden = true; $('#infoPanel').hidden = true; $('#altCard').hidden = true; this.renderSheet(); return; }
    const tool = ws.state.tool;
    const netTools = ['open', 'edges', 'join', 'tri', 'layout'];
    const tab = tool === 'build' || tool === 'inspect' ? 'solid' : tool === 'shape' ? 'surface' : netTools.includes(tool) ? 'net' : 'solid';
    const sub = tab === 'net' ? (tool === 'layout' && ws.state.netSub === 'alts' ? 'alts' : tool) : null;
    $$('#solidTabs [data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    $$('.subtools [data-stool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.stool === sub)));
    $$('[data-tabfor]').forEach((g) => { g.hidden = g.dataset.tabfor !== tab; });
    const ssub = ws.solidSub;
    $$('[data-ssub]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ssub === ssub)));
    $$('[data-mpick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mpick === (ws.state.mirrorPick || 'modules'))));
    $$('[data-jmode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.jmode === ws.joinMode)));
    const tsel = ws.triSel;
    ['#triPrevBtn', '#triNextBtn', '#triApplyBtn', '#triCancelBtn'].forEach((id) => { $(id).disabled = !tsel; });
    $('#triHint').textContent = tsel ? ws.triText() : 'Tap a face in the net or on the floating form. A four-sided face shows its two diagonals (◀ ▶ to switch); a face with more corners shows a full split into triangles from one corner (◀ ▶ to move that corner). Apply adds the fold lines; nothing changes before that.';
    const ctx = tab === 'net' ? sub : tab === 'solid' ? (ssub === 'add' ? 'build' : ssub) : tool === 'inspect' ? 'build' : tool;
    $$('[data-sfor]').forEach((c) => { c.hidden = c.dataset.sfor !== ctx; });
    const subName = { open: 'Open', edges: 'Edit edge', join: 'Join edge', tri: 'Triangulate', layout: 'Arrange', alts: 'Alternate nets' };
    $('#sheetTitle').textContent = tab === 'solid' ? `Solid Modeling · ${{ add: 'Add / Remove', mirror: 'Symmetry', scale: 'Scale' }[ssub]}` : tab === 'surface' ? 'Surface Modeling · Modify' : `Net · ${subName[sub] || ''}`;
    $('#navTurn').setAttribute('aria-pressed', String(!!ws.navTurn));
    $$('[data-omode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.omode === ws.state.openMode)));
    $$('[data-addtype]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.addtype === ws.addType)));
    if ($('#addTypeSel').value !== ws.addType) $('#addTypeSel').value = ws.addType;
    $('#labelsBtn').setAttribute('aria-pressed', String(!!ws.state.showLabels));
    $('#idsBtn').setAttribute('aria-pressed', String(!!ws.state.showIds));
    $$('[data-etap]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.etap === (ws.state.edgeTap || 'switch'))));
    this.syncSolidAngle();
    // Diagnostics: Info and Errors chips, collapsed by default.
    const closed = ws.shell.isClosed();
    const check = !closed && !ws.anim ? ws.layoutCheck() : null;
    const nErr = check ? check.errors : (ws.overlapPairs || 0);
    const nWarn = check ? check.warnings : 0;
    const badge = $('#errCount');
    badge.textContent = String(nErr + nWarn);
    badge.className = `n${nErr ? ' bad' : nWarn ? ' warn' : ''}`;
    $('#errChip .cl').textContent = nErr || nWarn ? (nErr ? 'Errors' : 'Warnings') : 'No errors';
    $('#infoChip').setAttribute('aria-expanded', String(this.drop === 'info'));
    $('#errChip').setAttribute('aria-expanded', String(this.drop === 'errors'));
    const ip = $('#infoPanel');
    ip.hidden = this.drop !== 'info';
    if (!ip.hidden) {
      $('#infoText').textContent = ws.infoText();
      $('#infoNet').textContent = [ws.netSentence ? ws.netSentence() : '', ws.viewText ? ws.viewText() : ''].filter(Boolean).join(' ');
    }
    this.renderAlternatives();
    this.renderIssues();
    if (ws.alt) { $('#issueCard').hidden = true; $('#infoPanel').hidden = true; }
    if (!$('#exportDialog').hidden) this.renderExportCheck();
    this.renderSheet();
  }

  // Phone: the tools sheet opens and closes; desktop: always open.
  renderSheet() {
    const phone = window.innerWidth <= 640;
    $('#toolSheet').classList.toggle('open', !phone || !!this.sheetOpen);
    document.body.classList.toggle('sheet-open', phone && !!this.sheetOpen);
    $('#sheetToggle').setAttribute('aria-expanded', String(!!this.sheetOpen));
    $('#sheetToggleLabel').textContent = this.sheetOpen ? 'Hide tools' : 'Show tools';
  }
}
