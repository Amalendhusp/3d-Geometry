# Paper Fold Studio

A WebXR paper-folding app. You get a sheet of paper at a size you choose. You can paint on both sides, draw crease lines, and fold the sheet along them. It works in VR with hand tracking or controllers, and on phones and desktops with touch or a mouse.

Built with [three.js](https://threejs.org) r170. It's a static site with no build step, and all libraries and 3D models are bundled in `vendor/`.

## Features

- **Custom sheet:** set width and height in cm (5–150) or use a preset (15 × 15, A4, Letter, and others). You can also pick the front and back colours and the paint resolution.
- **Paint:** draw on whichever side faces you, including the back of folded flaps. There are 8 colours plus a custom colour picker, an eraser, brush sizes from 1 to 35 mm, and undo.
- **Crease:** drag a straight line across the sheet. Its ends snap to corners, edge midpoints and crease crossings, and its angle snaps to 22.5° steps. The crease cuts through every layer in the stack, so it works on already-folded paper too.
- **Cut:** cutting follows crease lines. Tap a crease segment (the part between two crossings) to cut it, or drag along a crease to cut just part of it; the ends snap to crossings. Cuts go through every layer under them, like scissors, so you can make slits for kirigami flaps. Once a piece is cut free, the Move tool carries that piece on its own. On a screen it slides across the table; in VR it follows your hand and settles flat when you put it down.
- **Fold:** grab the paper next to a crease and swing it to any angle. Near flat, it snaps into a 180° fold. Valley, Mountain, Flatten buttons and an angle slider give exact folds.
  - **All layers** folds every layer on the side you grab.
  - **Top flap** folds only the piece you grab.
  - Stacked layers keep a correct order.
- **Move:** carry the sheet in VR (grip button, or pinch in Move mode). Use **Flip over** to turn it, **Unfold all** to see the crease pattern, and **Recenter** to reposition the table.
- **VR:** a table appears in front of you at a height based on yours, with a control panel on the left. Hands and controllers render as 3D models. AR passthrough is available on headsets that support it.

## Solid → Unfold workspace

Switch with **Paper | Solids** in the header (or open the page with `#solids`). It explores how a 3D form relates to its surface panels and the nets it can unfold into.

- **Panels and hinges:** the shell is a set of rigid panels (the solids' faces). Each shared edge is a **hinge** (green) or a **cut** (red, dashed). Panels never stretch.
- **Open:** tap or pinch a panel to select it. Its usable hinges glow bright green and the one in use is yellow; tap another to choose it. Drag the panel, move your hand, or use the angle slider to swing it. **Group** swings the panel with every panel hinged beyond it. **One panel** keeps only the chosen hinge and releases the panel's other edges. **Open flat**, **Close**, **Unfold all** and **Refold all** animate; **Undo** and **Reset** restore.
- **Default net:** each composition gets a cut-and-hinge layout that unfolds flat without overlaps. It's found by searching spanning trees of the panel graph and checking each flattened layout for overlaps.
- **Edges:** tap an edge to switch hinge ↔ cut. A closed loop of hinges can't move; it's reported and drawn in orange. **Check net** tests whether the current layout unfolds without overlaps.
- **Build:** tap a face, then **Add cube** to attach a cube flush to it. Drag a cube to move it; it snaps face to face, and positions that would overlap another cube are refused. **Duplicate**, **Rotate**, **Remove**, **Tip over** and presets are in the toolbar. Changing solids needs the shell closed first.
- **Merging:** when two cubes share a complete face, both faces are removed from the shell, so the inside is one hollow space. This is a real topology change: the panel and edge graph is rebuilt without them, and they stay absent through opening, unfolding, refolding, undo and save/load. The outside keeps its square panel divisions.
- **Intersections:** panels that pass through or lie on each other turn red, and the status line counts the pairs.
- **Save / Load** keep one composition, with its layout and pose, in this browser.

Stage 4 (tetrahedra, octahedra, cuboctahedra) isn't enabled yet. The templates, face matching and snapping code are written to take any convex polyhedron with a consistent edge length.

## Controls

| | Phone / desktop | VR controllers | VR hands |
|---|---|---|---|
| Paint | drag on the sheet | point + hold trigger | touch with index fingertip, or pinch-and-drag |
| Crease | drag a line | trigger at start, release at end | draw with fingertip, or pinch-drag |
| Cut | tap a crease segment, or drag along a crease | same, with the trigger | touch or pinch on a crease segment, or drag along it |
| Fold | drag a flap across its crease (folds over toward you); tap a flap, then Valley/Mountain | grab a flap with trigger and swing | pinch a flap and move your hand |
| Move sheet | Move tool orbits the camera, or slides a cut-out piece | squeeze grip (whole sheet); trigger in Move mode (one cut-out piece) | pinch in Move mode |
| UI | toolbar | point at the panel + trigger | poke the panel with a fingertip, or pinch-ray |

Keyboard: `1`–`5` or `P` `C` `X` `F` `M` switch tools, `E` toggles the eraser, `[` `]` change the brush size, and `Ctrl/Cmd+Z` undoes.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

WebXR needs HTTPS, except on `localhost`. To try VR on a desktop without a headset, install the **Immersive Web Emulator** browser extension.

## Hosting (GitHub Pages)

1. The repository must be public, or your account needs GitHub Pro, Team or Enterprise for Pages on a private repository.
2. Go to **Settings → Pages → Build and deployment**, set **Source: Deploy from a branch**, and pick the branch with this code and `/ (root)`.
3. Open `https://<user>.github.io/<repo>/` in the Meta Quest Browser and press **Enter VR**.

Any static host works too, for example Netlify, Vercel or Cloudflare Pages. Point it at the repository root and leave the build command empty.

## Code map

- `src/paper.js`: folding model. Convex faces are split by creases. Adjacency is computed in sheet coordinates minus any cut segments, folds are rigid rotations about crease lines, and flat layers are re-stacked after each fold. Cut pieces are the connected groups of faces.
- `src/geom2d.js`: polygon helpers (split, clip, overlap, shared edges).
- `src/paint.js`: front and back paint canvases, with partial texture uploads so painting stays fast in VR.
- `src/tools.js`: paint, crease, fold and move gestures, shared by every input type.
- `src/xr.js`: controllers, hand pinch rays, fingertip touch and panel poking.
- `src/vrpanel.js`: in-VR control panel.
- `src/ui.js`, `index.html`: phone and desktop interface.
- `src/solids/shell.js`: panel-and-hinge shell. It removes internal faces, sorts edges into hinge, cut or locked, holds rigid panel poses, handles group and single-panel opening, the hinge forest for unfold/refold, the default-net search and intersection tests.
- `src/solids/composition.js`, `src/solids/polyhedra.js`: solids, face-to-face alignment and convex overlap tests.
- `src/solids/workspace.js`, `src/solids/ui.js`, `src/solids/hinge.js`: rendering, gestures (screen, controller ray, pinch, fingertip), VR panel rows and the toolbar.

## Testing notes

The VR paths are tested in an emulated Meta Quest 3 (the IWER WebXR emulator, driving controllers and tracked hands from a script). They haven't been run on a real headset yet.
