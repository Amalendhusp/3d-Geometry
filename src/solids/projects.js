// Saved projects, kept in this browser (localStorage). Each entry holds a
// name, the time it was saved, a short summary, a small thumbnail and the
// composition itself (the same data as an exported .json file).
//
// The single save slot of earlier versions is never removed: the first time
// the gallery is used it is copied in as "Saved composition (earlier
// version)", and Save keeps writing that slot too, so older builds still
// find the latest save.

export const OLD_KEY = 'paper-fold-studio.solids.v1';
const LIST_KEY = 'paper-fold-studio.projects.v1';
const MIGRATED_KEY = 'paper-fold-studio.projects.migrated';

function read() {
  try { const v = JSON.parse(localStorage.getItem(LIST_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

function write(list) {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(list)); return true; } catch {
    // Out of space: keep the projects, drop the oldest thumbnails first.
    for (const p of list.slice().sort((a, b) => a.savedAt - b.savedAt)) {
      if (!p.thumb) continue;
      p.thumb = null;
      try { localStorage.setItem(LIST_KEY, JSON.stringify(list)); return true; } catch { /* keep trying */ }
    }
    return false;
  }
}

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const projects = {
  // Copy the earlier single save into the gallery once.
  migrate() {
    try {
      if (localStorage.getItem(MIGRATED_KEY)) return;
      const old = localStorage.getItem(OLD_KEY);
      if (old) {
        const data = JSON.parse(old);
        if (data && data.comp) {
          const list = read();
          list.push({ id: newId(), name: 'Saved composition (earlier version)', savedAt: Date.now(), summary: describe(data), thumb: null, data });
          write(list);
        }
      }
      localStorage.setItem(MIGRATED_KEY, '1');
    } catch { /* storage unavailable */ }
  },

  list() {
    this.migrate();
    return read().sort((a, b) => b.savedAt - a.savedAt);
  },

  get(id) { return read().find((p) => p.id === id) || null; },

  // Save (new when no id). Returns the entry, or null if storage refused.
  save({ id, name, data, summary, thumb }) {
    this.migrate();
    const list = read();
    let entry = id && list.find((p) => p.id === id);
    if (!entry) { entry = { id: newId() }; list.push(entry); }
    Object.assign(entry, { name: name || entry.name || 'Untitled', savedAt: Date.now(), summary: summary || describe(data), thumb: thumb ?? entry.thumb ?? null, data });
    if (!write(list)) return null;
    try { localStorage.setItem(OLD_KEY, JSON.stringify(data)); } catch { /* the gallery copy is what counts */ }
    return entry;
  },

  remove(id) { const list = read().filter((p) => p.id !== id); write(list); },

  latest() { return this.list()[0] || null; },
};

// "15 cuboctahedra · 20 octahedra" from the saved composition data.
export function describe(data) {
  try {
    const counts = new Map();
    for (const s of data.comp.solids) counts.set(s.type, (counts.get(s.type) || 0) + 1);
    const names = { cube: ['cube', 'cubes'], tetra: ['tetrahedron', 'tetrahedra'], octa: ['octahedron', 'octahedra'], cubocta: ['cuboctahedron', 'cuboctahedra'], cylinder: ['cylinder', 'cylinders'] };
    const parts = [...counts].map(([t, n]) => `${n} ${(names[t] || [t, `${t}s`])[n === 1 ? 0 : 1]}`);
    if (data.comp.edits && data.comp.edits.length) parts.push('edited');
    return parts.join(' · ');
  } catch { return ''; }
}
