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

## In VR: placing, targeting, tools and scenery

- **Work surface placement:** the table carries everything on it (paper, solids, control panel, tool tray). Grab the yellow **bar** at the front edge to slide it and raise or lower it, and the round **knobs** at the corners to turn it. The bar under the control panel moves the panel. **Place in front of me** puts the table at arm's length; **Seated** and **Standing** set a comfortable height. The **Place & view** page also has fine steps (lower/higher, closer/farther, left/right, turn), a **placement lock**, and a choice of surface: **cutting mat**, **plain table** or **no table**.
- **Targeting feedback:** whatever you aim at is highlighted before you press. Panel buttons get a bold outline, with a forgiving snap to the nearest button. Rays thicken and change colour (white idle, amber on a target, green while grabbing) and leave a cursor ring where they land. The fingertip shows a dot, plus a ring on the surface that shrinks as you approach (amber near, green touching). A ring between thumb and index closes as you pinch. Previews: hovering a flap shows the flap and its hinge crease in blue; hovering with the cutter shows the segment it would cut; the crease tool shows its snap point; in Solids, the panel, its hinge or the edge under you.
- **Stable hands:** a pinch that drops for a moment (a tracking blip) keeps the grab. If a hand is lost during a fold, cut, drag or table move, the action is cancelled instead of committed. Hand jitter is smoothed without lag.
- **Hand tools:** a tray at the front right of the table holds a **crease stylus** and a **cutter**. Pinch one, or reach it or point at it with a controller and pull the trigger, to pick it up. It stays in that hand (an extension of the index finger, or out of the front of a controller). Touch the paper with the glowing tip and draw: the crease or crease segment is previewed, and lifting commits it. The cutter only cuts along crease segments. Pinch next to the tray to put the tool down, which returns you to pinch-folding.
- **Scenery:** a quiet **mountain terrace** with a wooden deck, a glass railing and layered ridges in haze (default), or the plain **studio**. It's separate from the work surface. **Face the view** turns the terrace to your current direction without moving the table. All of it is generated in code, so it stays light on a standalone headset.

## Solid → Unfold workspace

Switch with **Paper | Solids** in the header (or open the page with `#solids`). It explores how a 3D form relates to its surface panels and the nets it can unfold into.

- **Panels and hinges:** the shell is a set of rigid panels (the solids' faces). Each shared edge is a **hinge** (green) or a **cut** (red, dashed). Panels never stretch.
- **Fold (Open):** touch or point near an edge of a flap to preview it: the flap that would swing turns blue and its hinge shows as a line. Touching a hinge picks that hinge; touching a free edge picks the crease opposite, the way you lift a flap by its edge. Pinch, pull the trigger or squeeze the grip to hold it, then lift and turn your hand: the flap swings about that hinge, which stays the same for the whole grab. Hand position leads; the palm's turn about the hinge helps, most near the hinge. Panels stay rigid while folding (resizing is only in Shape), and a tag near the hand says which action is active. A hand pinch holds its target at once but its motion counts only after the fingers settle (0.15 s), and gestures hold still while a pinch opens.
- **Move the whole form:** grab the blue Move puck beside it (trigger, grip, pinch or mouse drag). Grabbing a panel never moves the whole form.
- **Open:** tap or pinch a panel to select it. Its usable hinges glow bright green and the one in use is yellow; tap another to choose it. Drag the panel, move your hand, or use the angle slider to swing it. **Group** swings the panel with every panel hinged beyond it. **One panel** keeps only the chosen hinge and releases the panel's other edges. **Open flat**, **Close**, **Unfold all** and **Refold all** animate; **Undo** and **Reset** restore.
- **Solids:** cube, regular tetrahedron, regular octahedron and cuboctahedron, all with the same edge length. Triangles match triangles (tetrahedron, octahedron, cuboctahedron) and squares match squares (cube, cuboctahedron).
- **Default net and its status:** each composition gets a cut-and-hinge layout found by searching spanning trees of the panel graph (coplanar-first, then random trees with a timed repair step that swaps hinges to remove overlaps). Every flattened layout is checked panel against panel. The status is always one of:
  - **verified net**: unfolds flat into one piece with no overlaps;
  - **flat layout with overlaps**: the layout you chose (or loaded) unfolds flat but panels overlap; it is not called a net;
  - **unresolved**: the search ran out of time without finding an overlap-free layout; the overlapping layout shown is not a valid net;
  - **separate pieces** (cuts split the shell) or **closed hinge loop** (cannot unfold).
  **Find net** runs the search again with a longer budget; **Check net** tests the current layout.
- **Edges:** tap an edge to switch hinge ↔ cut. A closed loop of hinges can't move; it's reported and drawn in orange.
- **Build:** tap a face, pick a solid type and press **Add** to attach it flush to that face. Drag a solid to move it; it snaps face to face onto a matching face. Every placement is checked geometrically: a solid that would overlap another, or touch one with only part of a face, is refused and the solid in the way flashes red. **Duplicate**, **Rotate** (by the bottom face's symmetry), **Remove**, **Tip over** and presets are in the toolbar. Changing solids needs the shell closed first.
- **Merging:** when two solids share a complete matching face, both faces are removed from the shell, so the inside is one continuous hollow space. The panel and edge graph is rebuilt without them, and they stay absent through opening, unfolding, refolding, undo, save/load and export/import. The outside keeps its panel divisions.
- **Joints:** around an edge shared by several solids the app adds up their dihedral angles. It reports edges where the solids close a full 360° turn and edges that leave a gap narrower than any solid can fill (for example five tetrahedra leave 7.4°; a cube, a cuboctahedron and an octahedron leave 35.3°). Nothing assumes these solids fill space.
- **Inspect:** turn the whole form freely to look at it from any side. On a screen, drag the form (arrow keys too; dragging empty space still moves the camera). In VR, pull the trigger or pinch on the form and turn your wrist, or grab it with both hands and move them around each other. **Reset orientation**, **Fit view**, **Turn 90°** and **Tip 90°** are in the toolbar. This is only a view turn between the table and the shell: solids, panels, hinges, cuts and fold angles never change, it is not part of undo, and the form keeps resting on the table. Building and the flat layout put it back to rest.
- **Layout (flat net):** entering Layout lays the net on the surface. Each piece is a hinge-connected group of panels, so it is rigid and flat; pieces move and turn only as wholes, which keeps every panel's size and every edge's identity. Drag a piece to move it (in VR it also turns with your hand), select it and use **⟲ 15° / ⟳ 15°**. Tap a hinge to cut it: the smaller piece slides away. Tap a cut whose two sides meet to join it. Dropping a piece near its matching edge snaps the two edges together. Every cut edge carries a number shown on both sides, so equal numbers mark the edges that join; **Panel IDs** adds a number per panel. **Lay net on surface** lays every piece flat (outside down) and checks that each panel lies in the surface plane to 1 µm; pieces already lying flat stay put. **Arrange pieces** packs them side by side. Overlaps are reported separately within a piece (the net itself is invalid) and between pieces (move them apart). **Other nets** cycles through different overlap-free nets before you split one; if the search finds none it says how many layouts it tried and that this does not prove none exists. **Refold all** goes back to the assembled 3D form from any layout, and **Undo** steps back through cuts, joins and moves.
- **Shape, direct (box compositions such as one cube):** entering Shape lays the net on the surface and floats a translucent assembled preview (the ghost) above it, both drawn from the same geometry. Hovering or touching an edge or corner lights it in both views; a seam edge appears twice in the net and a corner up to three times, and all copies light up. Tap a side or corner of the net to pin it, then drag another side (one size changes, across it) or corner (both sizes of its panel). The edges whose length will change turn orange in both views and the ghost shows live sizes. The pin stays exactly where it is on the surface (a pinned side also keeps its length); without a pin, the opposite side or corner stays. The handle follows the pointer exactly, because the net's positions are linear in the sizes. The ghost's base stays fixed. Releasing commits one undoable change and reports that the shell is closed, the faces planar and the seam lengths matched. Works with the mouse, touch, controller rays (dragging along the surface) and hand pinches.
- **Shape → Edit vertices (free-form, every solid; the default when you open Shape):** edit the assembled form itself; its flat net is regenerated on every move. Taps either pin (blue) or select (amber): switch with **Tap: Pins / Selects**. Tapping a face pins or selects all its corners. Dragging a selected corner moves the whole group; a ring appears around a selected group: drag it inward or outward (or press **Shrink 10% / Grow 10%**) to scale the group about its centre within its own plane. Example: Pin base, select the cube's top face, drag the ring inward: a smaller square top, the square bottom and four trapezoid sides, all six faces planar, no triangulation. Corners moved by the solver to keep faces flat show orange, and the message lists the face shapes (squares, trapezoids, scalene triangles …). Drag a corner or an edge of the floating form (on a screen: left/right and up/down in the plane facing you, Shift to slide level; in VR: with the controller or a hand pinch). Tap a corner, edge or face to pin it; Pin base pins the bottom. Edge lengths and angles change. Vertices are named by their unedited positions, so a vertex shared by several faces or solids moves as one, joined faces stay joined, both sides of every seam keep the same length, and cuts and hinges survive edits. Faces with four or more corners stay planar by default: the other free corners of those faces move as little as possible to keep them flat, and they turn orange in the form and in the net. Triangles bend freely, so a tetrahedron edits without moving anything else. When a move cannot be done (pins hold a face that would have to bend, an edge under 5 mm, a corner under 3°, a face folding in on itself, the form turning inside out, faces passing through each other), the drag stops at the furthest valid point and says why. **Triangulate at corner** (explicit) splits the faces at the corner you last pointed at into triangles along the diagonal that avoids it; the new fold lines show green in the form and the net, and that corner can then move alone. Every release is one undo step; Save, Load and the composition file keep the edits and triangulation; **Reset edits** returns to the regular solids. If an edit makes the net overlap itself, its cuts are chosen again (or the message says no overlap-free net was found). Building and Resize work on unedited solids, so they ask you to Reset edits first.
- **Shape (numbers and other solids):** stretch the whole composition along its own X (width, red), Y (height, green) and Z (depth, blue) axes, or type its width, height and depth in millimetres; a single cube becomes a cuboid. The stretch is applied to every vertex when the shell is made, so shared vertices stay shared, joined faces stay joined and removed, and every panel stays planar (checked). Fold angles and the default net are worked out again from the new closed form, and panels stay rigid when folding. Changes need the shell closed. Invalid or degenerate shapes are refused with the reason and nothing changes: edges shorter than 10 mm, a form more than 900 mm across, face corners under 5°, flattened faces, or a stretch outside 0.2×–5×. Building (add, move, turn, remove solids) works on the regular solids, so it asks you to Reset shape first. Editing single edges is not offered yet; it needs constraint rules that are still to be designed. In VR the Shape page has ±10% per axis and Reset shape. Presets: a cuboid, two cubes stretched 2:1, and an octahedron + tetrahedron 1.4× taller.
- **Intersections:** panels that pass through or lie on each other turn red, and the status line counts the pairs.
- **Save / Load** keep one composition in this browser: solids, shape stretch, cuts and hinges, panel poses (so the net pieces and their layout), and the view turn. **Import** reads back a composition file. Saves from earlier versions load unchanged and get their net status re-checked.
- **Export…** offers three files:
  - **Composition (.json)**: everything Save keeps, as a file.
  - **Net drawing (.svg)**: the flat layout at full size in millimetres, seen from the printed (outside) side. Cut lines are solid black, mountain folds red dash-dot, valley folds blue dashed, and divisions between coplanar panels grey dotted (no fold). A hinge is one line shared by two panels and is drawn once; the two sides of a cut are drawn once each, or once in total when they lie on top of each other. Options: matching edge numbers, panel IDs, and glue tabs (one per cut edge, on whichever side overlaps nothing; any that must overlap are counted in the message).
  - **View image (.png)**: the current 3D view at twice the screen resolution without the interface, selection or hover highlights, either object only on a transparent background or with the scene behind it. (Leave VR first.)

Presets cover cube blocks, 1–3 tetrahedra, octahedron + tetrahedron, the big tetrahedron (four tetrahedra around an octahedron), and cuboctahedron compositions with octahedra and cubes, including one closed joint and one with a gap.

## Controls

| | Phone / desktop | VR controllers | VR hands |
|---|---|---|---|
| Paint | drag on the sheet | point + hold trigger | touch with index fingertip, or pinch-and-drag |
| Crease | drag a line | trigger at start, release at end | draw with fingertip, or pinch-drag |
| Cut | tap a crease segment, or drag along a crease | same, with the trigger | touch or pinch on a crease segment, or drag along it |
| Fold | drag a flap across its crease (folds over toward you); tap a flap, then Valley/Mountain | grab a flap with trigger and swing | pinch a flap and move your hand |
| Move sheet | Move tool orbits the camera, or slides a cut-out piece | squeeze grip (whole sheet); trigger in Move mode (one cut-out piece) | pinch in Move mode |
| UI | toolbar | point at the panel + trigger | poke the panel with a fingertip, or pinch-ray |
| Inspect (Solids) | drag the form; arrow keys | trigger on the form and turn the wrist | pinch the form and turn the hand, or pinch with both hands and move them around each other |
| Layout (Solids) | drag a piece; tap a hinge to cut, a met cut to join | trigger-drag a piece (it turns with the controller) | pinch-drag a piece |

Keyboard: `1`–`5` or `P` `C` `X` `F` `M` switch tools, `E` toggles the eraser, `[` `]` change the brush size, and `Ctrl/Cmd+Z` undoes. In Solids: `1` Build, `2` Open, `3` Edges, `4` or `L` Layout, `5` or `I` Inspect, `6` or `S` Shape, `U` unfold all, `R` refold all, arrow keys turn the form in Inspect.

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
- `src/solids/polyhedra.js`: solid templates (faces from the convex hull, unit edge, resting pose).
- `src/solids/composition.js`: solids, face-to-face alignment, placement checks (convex overlap and partial face contact), the joint report and the shape stretch.
- `src/solids/workspace.js`, `src/solids/ui.js`, `src/solids/hinge.js`: rendering, the Inspect view turn, gestures (screen, controller ray, pinch, two hands, fingertip), VR panel rows and the toolbar.
- `src/solids/layout.js`: laying pieces flat, packing them, rigid moves in the surface plane and snapping matching edges.
- `src/solids/resize.js`: direct resizing on the net (handles, anchors, sizes solved from the pointer).
- `src/solids/shapeedit.js`: the Shape editor: ghost, linked highlights, pins and drags (Resize and Edit vertices).
- `src/solids/vertexedit.js`: free-form edits: planar-face solver, validity checks and the valid limit.
- `src/solids/labels.js`: matching edge numbers and panel IDs drawn on the panels.
- `src/solids/exporter.js`: SVG net in millimetres and PNG of the view.
- `src/placement.js`: table and panel placement, handles, seated/standing, lock, surface styles.
- `src/handtools.js`: the tool tray, crease stylus and cutter.
- `src/environment.js`: terrace and studio surroundings.
- `vendor/three/jsm/webxr/XRControllerModelFactory.js` has one small patch: it ignores a controller model that finishes loading after the controller has already disconnected.

## Testing notes

The VR paths are tested in an emulated Meta Quest 3 (the IWER WebXR emulator, driving controllers and tracked hands from a script). They haven't been run on a real headset yet.

Automated checks (Node unit tests on the geometry, Playwright on a desktop and phone viewport, and IWER for controllers and hands) live outside the repository. Checkpoints are kept as branches: `checkpoint/v0.5-placement-tools-terrace`, `checkpoint/v0.6-tetra-octa-cubocta`, `checkpoint/v0.7-inspect-layout-export`.
