// Screen UI for phones and desktop. The VR panel mirrors the same actions.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PRESETS = [
  { label: '15 × 15', w: 15, h: 15 },
  { label: '24 × 24', w: 24, h: 24 },
  { label: '30 × 30', w: 30, h: 30 },
  { label: 'A4', w: 21, h: 29.7 },
  { label: 'Letter', w: 21.6, h: 27.9 },
  { label: '50 × 35', w: 50, h: 35 },
];

export class UI {
  constructor(app) {
    this.app = app;
    this.a = app.actions;
    this.toastTimer = 0;
    this.build();
    app.listeners.add(() => this.render());
    this.render();
  }

  build() {
    const a = this.a;
    const st = this.app.state;

    $$('[data-tool]').forEach((b) => b.addEventListener('click', () => a.setTool(b.dataset.tool)));

    const sw = $('#swatches');
    for (const c of this.app.palette) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.setProperty('--c', c);
      b.dataset.color = c;
      b.setAttribute('aria-label', `Colour ${c}`);
      b.addEventListener('click', () => a.setColor(c));
      sw.appendChild(b);
    }
    $('#customColor').addEventListener('input', (e) => a.setColor(e.target.value));
    $('#eraserBtn').addEventListener('click', () => a.toggleEraser());
    const size = $('#brushSize');
    size.addEventListener('input', () => a.setBrush(Number(size.value)));
    $('#clearPaintBtn').addEventListener('click', () => a.clearPaint());

    $('#snapBtn').addEventListener('click', () => a.toggleSnap());
    $('#removeCreasesBtn').addEventListener('click', () => a.removeCreases());
    $$('.unfoldBtn').forEach((b) => b.addEventListener('click', () => a.unfoldAll()));

    $('#valleyBtn').addEventListener('click', () => a.valley());
    $('#mountainBtn').addEventListener('click', () => a.mountain());
    $('#flattenBtn').addEventListener('click', () => a.flatten());
    const ang = $('#foldAngle');
    ang.addEventListener('input', () => { a.setAngle(Number(ang.value), false); this.setAngleLabel(Number(ang.value)); });
    ang.addEventListener('change', () => a.setAngle(Number(ang.value), true));
    $$('[data-layers]').forEach((b) => b.addEventListener('click', () => a.setLayerMode(b.dataset.layers)));

    $('#flipBtn').addEventListener('click', () => a.flip());
    $('#resetViewBtn').addEventListener('click', () => a.resetView());

    $('#undoBtn').addEventListener('click', () => a.undo());
    $('#vrBtn').addEventListener('click', () => a.enterXR('immersive-vr'));
    $('#arBtn').addEventListener('click', () => a.enterXR('immersive-ar'));

    // Sheet dialog
    const dlg = $('#sheetDialog');
    const pw = $('#paperW'), ph = $('#paperH');
    const pr = $('#presets');
    for (const p of PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = p.label;
      b.addEventListener('click', () => { pw.value = p.w; ph.value = p.h; });
      pr.appendChild(b);
    }
    $('#paperBtn').addEventListener('click', () => {
      pw.value = st.widthCm;
      ph.value = st.heightCm;
      $('#frontColor').value = st.frontColor;
      $('#backColor').value = st.backColor;
      $('#detail').value = String(st.detail);
      dlg.hidden = false;
      pw.focus();
    });
    const close = () => { dlg.hidden = true; };
    $('#sheetCancel').addEventListener('click', close);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    $('#sheetForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const w = clampNum(pw.value, 5, 150, 30);
      const h = clampNum(ph.value, 5, 150, 30);
      close();
      a.newPaper({
        widthCm: w, heightCm: h,
        frontColor: $('#frontColor').value,
        backColor: $('#backColor').value,
        detail: Number($('#detail').value),
      });
    });
    const scene = $('#sceneDialog');
    $('#sceneBtn').addEventListener('click', () => {
      $('#surfaceSel').value = this.app.state.surface;
      const env = $('#envSel');
      env.innerHTML = '';
      for (const [k, label] of Object.entries(this.app.environments ? this.app.environments.labels : { studio: 'Studio' })) env.appendChild(new Option(label, k));
      env.value = this.app.environments ? this.app.environments.current : 'studio';
      env.disabled = !this.app.environments;
      scene.hidden = false;
    });
    $('#surfaceSel').addEventListener('change', (e) => this.app.setSurface(e.target.value));
    $('#envSel').addEventListener('change', (e) => this.app.setEnvironment?.(e.target.value));
    $('#sceneClose').addEventListener('click', () => { scene.hidden = true; });
    scene.addEventListener('click', (e) => { if (e.target === scene) scene.hidden = true; });
    const help = $('#helpDialog');
    $('#helpBtn').addEventListener('click', () => { help.hidden = false; $('#helpClose').focus(); });
    $('#helpClose').addEventListener('click', () => { help.hidden = true; });
    help.addEventListener('click', (e) => { if (e.target === help) help.hidden = true; });
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!dlg.hidden) close();
      help.hidden = true;
      scene.hidden = true;
    });
  }

  setAngleLabel(deg) {
    $('#foldAngleLabel').textContent = `${deg > 0 ? '+' : ''}${Math.round(deg)}°`;
  }

  syncAngle(theta) {
    const deg = Math.round((theta * 180) / Math.PI);
    const el = $('#foldAngle');
    if (document.activeElement !== el) el.value = String(deg);
    this.setAngleLabel(deg);
  }

  render() {
    const app = this.app;
    const st = app.state;
    $$('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === st.tool)));
    $$('#paperDock .context').forEach((c) => { c.hidden = c.dataset.for !== st.tool; });
    $$('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(!st.eraser && b.dataset.color === st.color)));
    $('#eraserBtn').setAttribute('aria-pressed', String(st.eraser));
    $('#brushSize').value = String(st.brushMM);
    $('#brushLabel').textContent = `${st.brushMM} mm`;
    $('#brushDot').style.setProperty('--d', `${Math.min(26, 4 + st.brushMM * 0.7)}px`);
    $('#brushDot').style.setProperty('--c', st.eraser ? 'transparent' : st.color);
    $('#snapBtn').setAttribute('aria-pressed', String(st.snap));
    $('#snapBtn').textContent = st.snap ? 'Snap on' : 'Snap off';
    $$('[data-layers]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layers === st.layerMode)));
    $('#undoBtn').disabled = !app.history.canUndo;
    $('#sheetLabel').textContent = `${fmt(app.paper.W * 100)} × ${fmt(app.paper.H * 100)} cm sheet`;
    const sel = !!app.tools.session;
    for (const id of ['valleyBtn', 'mountainBtn', 'flattenBtn', 'foldAngle']) $('#' + id).disabled = !sel;
    $('#foldHint').hidden = sel;
    const vr = $('#vrBtn');
    vr.classList.toggle('unavailable', !app.xrSupport?.vr);
    vr.title = app.xrSupport?.vr ? 'Enter VR' : 'VR needs a WebXR browser such as the Meta Quest Browser';
    $('#arBtn').hidden = !app.xrSupport?.ar;
  }

  toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n * 10) / 10));
}

function fmt(v) { return Math.round(v * 10) / 10; }
