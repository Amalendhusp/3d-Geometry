import { SHAPES, shapeByKey } from './solids/pieces.js';
import { MODE_TOOLS, POLYHEDRA } from './solids/modes.js';
import { TEMPLATES } from './solids/polyhedra.js';
import { checkImport } from './solids/importcheck.js';

// The workspace interface: menu (top left), net tools (top), Web / AR / VR
// (top right), the add picker with From Gallery and Undo / Redo (left), the
// mode's tools with Info and Error (right), and the Shape / Solid tabs.

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const TOOL_ICON = { modify: 't-modify', remove: 't-remove', move: 't-move', rotate: 't-rotate', fold: 't-fold', cut: 't-cut', mirror: 't-mirror' };
const SOLID_ICON = { cube: 'p-cube', tetra: 'p-tetra', octa: 'p-octa', cubocta: 'p-cubocta' };

export class WorkspaceUI {
  constructor(app) {
    this.app = app;
    this.ws = app.solids;
    if (app.space !== 'solids') return;
    document.body.classList.add('ws');
    this.build();
    app.listeners.add(() => this.render());
    this.render();
  }

  build() {
    const app = this.app, ws = this.ws;
    const on = (sel, fn) => $(sel).addEventListener('click', fn);
    // Menu
    const menu = $('#wsMenu');
    const setMenu = (open) => { menu.hidden = !open; $('#wsMenuBtn').setAttribute('aria-expanded', String(open)); };
    on('#wsMenuBtn', (e) => { e.stopPropagation(); setMenu(menu.hidden); this.render(); });
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !$('#wsMenuBtn').contains(e.target)) setMenu(false);
      const pk = $('#wsPickerPanel');
      if (!pk.hidden && !pk.contains(e.target) && !$('#wsPicker').contains(e.target) && !$('#wsPickerMore').contains(e.target)) this.closePicker();
    }, true);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenu(false); this.closePicker(); } });
    const item = (sel, fn) => on(sel, () => { setMenu(false); fn(); });
    const sui = app.solidsUI;
    item('#wsNew', () => sui.protect(() => { ws.newEmpty(); app.toast('New: an empty workspace. Shape (2D) is selected; tap the picker on the left to place a square.', 5000); }));
    item('#wsOpen', () => sui.openGallery());
    item('#wsSave', () => sui.saveProject());
    item('#wsSaveAs', () => {
      const inp = $('#saveName');
      const cur = ws.projectInfo().name;
      sui.afterSave = null;
      inp.value = cur === 'Untitled' ? ws.autoName() : `${cur} copy`;
      $('#saveDialog').hidden = false;
      inp.focus(); inp.select();
    });
    item('#wsExport', () => $('#exportShellBtn').click());
    item('#wsImport', () => sui.protect(() => $('#wsImportFile').click()));
    item('#wsHelp', () => { $('#helpDialog').hidden = false; });
    $('#wsImportFile').addEventListener('change', (e) => this.importFile(e));
    $$('[data-surface]').forEach((b) => b.addEventListener('click', () => { app.setSurface(b.dataset.surface); this.render(); }));
    $$('[data-env]').forEach((b) => b.addEventListener('click', () => { app.setEnvironment?.(b.dataset.env); this.render(); }));
    // Net tools (top)
    on('#wsUnfold', () => ws.topUnfold());
    on('#wsRefold', () => ws.topRefold());
    on('#wsArrange', () => ws.arrangeAll());
    on('#wsAlternate', () => ws.alternateNet());
    // Web / AR / VR
    $$('[data-session]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.session;
      if (k === 'web') { const s = app.renderer.xr.getSession?.(); if (s) s.end(); return; }
      const sup = app.xrSupport || {};
      if (k === 'ar' && !sup.ar) { app.toast('AR needs a browser and device with WebXR augmented reality (for example Chrome on an ARCore Android phone).', 5000); return; }
      if (k === 'vr' && !sup.vr) { app.toast('VR needs a WebXR browser on a connected headset, such as the Meta Quest Browser.', 5000); return; }
      app.actions.enterXR(k === 'ar' ? 'immersive-ar' : 'immersive-vr');
    }));
    // Left: picker. A tap places the current shape or solid; the small arrow
    // beside it, or a long press on it, opens the catalogue (both modes).
    // Then gallery, undo / redo.
    const pick = $('#wsPicker');
    let timer = null, long = false;
    pick.addEventListener('pointerdown', () => {
      long = false;
      clearTimeout(timer);
      timer = setTimeout(() => { long = true; this.openPicker(); }, 450);
    });
    const stop = () => clearTimeout(timer);
    pick.addEventListener('pointerup', stop);
    pick.addEventListener('pointerleave', stop);
    pick.addEventListener('pointercancel', stop);
    pick.addEventListener('contextmenu', (e) => e.preventDefault());
    pick.addEventListener('click', () => { if (long) { long = false; return; } this.closePicker(); ws.startPlacing(); });
    on('#wsPickerMore', () => { if ($('#wsPickerPanel').hidden) this.openPicker(); else this.closePicker(); });
    on('#wsGallery', () => app.toast('From Gallery (adding a copy of a saved model) comes in the next stage. Open… in the menu opens a saved model.', 5000));
    on('#wsUndo', () => app.actions.undo());
    on('#wsRedo', () => app.actions.redo());
    // Right: Info and Error
    on('#wsInfoBtn', () => { this.drop = this.drop === 'info' ? null : 'info'; this.render(); app.layoutChanged?.(); });
    on('#wsErrBtn', () => { this.drop = this.drop === 'errors' ? null : 'errors'; this.render(); app.layoutChanged?.(); });
    // Tabs
    $$('[data-mode]').forEach((b) => b.addEventListener('click', () => { this.closePicker(); if (ws.state.mode !== b.dataset.mode) ws.setMode(b.dataset.mode); }));
  }

  closePicker() {
    $('#wsPickerPanel').hidden = true;
    $('#wsPickerMore').setAttribute('aria-expanded', 'false');
  }

  openPicker() {
    const ws = this.ws;
    const pk = $('#wsPickerPanel');
    pk.replaceChildren();
    const solid = ws.state.mode === 'solid';
    const items = solid ? POLYHEDRA.map((k) => ({ key: k, name: TEMPLATES[k].name, icon: SOLID_ICON[k] })) : SHAPES.map((s) => ({ key: s.key, name: s.name, icon: `s-${s.key}` }));
    const cur = solid ? ws.state.solidType : ws.state.shapeType;
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.pick = it.key;
      b.setAttribute('aria-pressed', String(it.key === cur));
      b.innerHTML = `<svg class="i"><use href="#${it.icon}"/></svg>${it.name}`;
      b.addEventListener('click', () => { this.closePicker(); ws.setPickerType(it.key); });
      pk.appendChild(b);
    }
    const r = $('#wsPickerMore').getBoundingClientRect();
    pk.style.left = `${Math.round(r.right + 6)}px`;
    pk.style.top = `${Math.round(Math.max(60, r.top))}px`;
    pk.hidden = false;
    $('#wsPickerMore').setAttribute('aria-expanded', 'true');
  }

  async importFile(e) {
    const app = this.app, ws = this.ws;
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (/\.json$/i.test(f.name)) {
      let data = null;
      try { data = JSON.parse(await f.text()); } catch { app.toast('That file could not be read as a saved model.'); return; }
      ws.importProject(data, f.name);
      return;
    }
    const r = checkImport(f.name, new Uint8Array(await f.arrayBuffer()));
    this.lastImport = { name: f.name, ...r };
    if (!r.ok) {
      app.toast(`Not imported: ${f.name} is not valid. ${r.errors.join(' ')}`, 9000);
    } else {
      app.toast(`Not imported yet: ${f.name} is a valid ${r.kind} (${r.summary}), but it does not say ${r.missing.join('; nor ')}. How such files become a foldable model is still to be decided.`, 11000);
    }
    this.importIssue = { text: `${f.name}: ${r.ok ? `valid ${r.kind}, not imported yet (missing: ${r.missing.join('; ')})` : `rejected: ${r.errors.join(' ')}`}`, ids: [] };
    this.render();
  }

  render() {
    const app = this.app, ws = this.ws;
    if (!ws || app.space !== 'solids') return;
    const mode = ws.state.mode;
    // Name and unsaved state
    const info = ws.projectInfo();
    const dirty = info.dirty && !!ws.changes;
    $('#wsName').innerHTML = '';
    $('#wsName').append(document.createTextNode(info.name));
    if (dirty) { const s = document.createElement('span'); s.className = 'dirty'; s.textContent = 'unsaved'; $('#wsName').append(s); }
    $$('[data-surface]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.surface === app.state.surface)));
    $$('[data-env]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.env === (app.environments ? app.environments.current : 'studio'))));
    // Session
    const pres = app.renderer.xr.isPresenting;
    $$('[data-session]').forEach((b) => {
      const k = b.dataset.session;
      b.setAttribute('aria-pressed', String(k === 'web' ? !pres : false));
      b.classList.toggle('unavailable', (k === 'vr' && !app.xrSupport?.vr) || (k === 'ar' && !app.xrSupport?.ar));
    });
    // Tabs
    $$('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    // Picker
    const pick = $('#wsPicker');
    const icon = mode === 'solid' ? SOLID_ICON[ws.state.solidType] : `s-${ws.state.shapeType}`;
    const name = mode === 'solid' ? TEMPLATES[ws.state.solidType].name : shapeByKey(ws.state.shapeType).name;
    pick.querySelector('use').setAttribute('href', `#${icon}`);
    $('#wsPickerName').textContent = name;
    pick.title = `${mode === 'solid' ? 'Polyhedron' : 'Shapes'}: tap to place a ${name.toLowerCase()}; the arrow or a long press chooses another`;
    $('#wsPickerMore').title = mode === 'solid' ? 'Choose another polyhedron' : 'Choose another shape';
    pick.setAttribute('aria-pressed', String(!!ws.placing));
    $('#wsUndo').disabled = !ws.history.length;
    $('#wsRedo').disabled = !ws.canRedo();
    // Tools
    const box = $('#wsTools');
    const sig = `${mode}|${ws.state.mtool}`;
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.replaceChildren();
      for (const t of MODE_TOOLS[mode]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.mtool = t.key;
        b.title = `${t.name}: ${t.tip}`;
        b.setAttribute('aria-label', t.name);
        b.setAttribute('aria-pressed', String(ws.state.mtool === t.key));
        if (t.later) b.classList.add('later');
        const ic = t.key === 'preview' ? (mode === 'shape' ? 't-3d' : 't-2d') : TOOL_ICON[t.key];
        b.innerHTML = `<svg class="i"><use href="#${ic}"/></svg><span class="sr">${t.name}</span>`;
        b.addEventListener('click', () => ws.setModeTool(t.key));
        box.appendChild(b);
      }
    }
    // Info and Error
    const errs = ws.errorList();
    if (this.importIssue) errs.unshift(this.importIssue);
    const badge = $('#wsErrCount');
    badge.textContent = String(errs.length);
    badge.classList.toggle('bad', errs.length > 0);
    $('#wsInfoBtn').setAttribute('aria-expanded', String(this.drop === 'info'));
    $('#wsErrBtn').setAttribute('aria-expanded', String(this.drop === 'errors'));
    const r = $('#wsRight').getBoundingClientRect();
    for (const id of ['wsInfo', 'wsErrors']) $(`#${id}`).style.top = `${Math.round(Math.max(60, r.top))}px`;
    const ip = $('#wsInfo');
    ip.hidden = this.drop !== 'info';
    if (!ip.hidden) {
      const c = ws.infoCounts();
      ip.innerHTML = `<h3>Info</h3><div>${ws.infoText()}</div><div style="opacity:.75;margin-top:4px">${c.objects} object${c.objects === 1 ? '' : 's'} · ${mode === 'shape' ? 'Shape (2D)' : 'Solid (3D)'}</div>`;
    }
    const ep = $('#wsErrors');
    ep.hidden = this.drop !== 'errors';
    if (!ep.hidden) {
      ep.replaceChildren();
      const h = document.createElement('h3');
      h.textContent = errs.length ? `${errs.length} issue${errs.length === 1 ? '' : 's'}` : 'No issues';
      ep.appendChild(h);
      const ul = document.createElement('ul');
      for (const it of errs) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = it.text;
        b.addEventListener('click', () => { if (it.ids && it.ids.length) ws.focusIds(it.ids); });
        li.appendChild(b);
        ul.appendChild(li);
      }
      ep.appendChild(ul);
    }
  }
}
