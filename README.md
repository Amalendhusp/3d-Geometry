# Paper Fold Studio

A WebXR paper-folding app. You get a sheet of paper at a size you choose. You can paint on both sides, draw crease lines, and fold the sheet along them. It works in VR with hand tracking or controllers, and on phones and desktops with touch or a mouse.

Built with [three.js](https://threejs.org) r170. It's a static site with no build step, and all libraries and 3D models are bundled in `vendor/`.

## Features

- **Custom sheet:** set width and height in cm (5–150) or use a preset (15 × 15, A4, Letter, and others). You can also pick the front and back colours and the paint resolution.
- **Paint:** draw on whichever side faces you, including the back of folded flaps. There are 8 colours plus a custom colour picker, an eraser, brush sizes from 1 to 35 mm, and undo.
- **Crease:** drag a straight line across the sheet. Its ends snap to corners, edge midpoints and crease crossings, and its angle snaps to 22.5° steps. The crease cuts through every layer in the stack, so it works on already-folded paper too.
- **Fold:** grab the paper next to a crease and swing it to any angle. Near flat, it snaps into a 180° fold. Valley, Mountain, Flatten buttons and an angle slider give exact folds.
  - **All layers** folds every layer on the side you grab.
  - **Top flap** folds only the piece you grab.
  - Stacked layers keep a correct order.
- **Move:** carry the sheet in VR (grip button, or pinch in Move mode). Use **Flip over** to turn it, **Unfold all** to see the crease pattern, and **Recenter** to reposition the table.
- **VR:** a table appears in front of you at a height based on yours, with a control panel on the left. Hands and controllers render as 3D models. AR passthrough is available on headsets that support it.

## Controls

| | Phone / desktop | VR controllers | VR hands |
|---|---|---|---|
| Paint | drag on the sheet | point + hold trigger | touch with index fingertip, or pinch-and-drag |
| Crease | drag a line | trigger at start, release at end | draw with fingertip, or pinch-drag |
| Fold | drag a flap next to a crease (swings toward you); tap a flap, then Valley/Mountain | grab a flap with trigger and swing | pinch a flap and move your hand |
| Move sheet | Move tool orbits the camera | squeeze grip | pinch in Move mode |
| UI | toolbar | point at the panel + trigger | poke the panel with a fingertip, or pinch-ray |

Keyboard: `1`–`4` or `P` `C` `F` `M` switch tools, `E` toggles the eraser, `[` `]` change the brush size, and `Ctrl/Cmd+Z` undoes.

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

- `src/paper.js`: folding model. Convex faces are split by creases. Adjacency is computed in sheet coordinates, folds are rigid rotations about crease lines, and flat layers are re-stacked after each fold.
- `src/geom2d.js`: polygon helpers (split, clip, overlap, shared edges).
- `src/paint.js`: front and back paint canvases, with partial texture uploads so painting stays fast in VR.
- `src/tools.js`: paint, crease, fold and move gestures, shared by every input type.
- `src/xr.js`: controllers, hand pinch rays, fingertip touch and panel poking.
- `src/vrpanel.js`: in-VR control panel.
- `src/ui.js`, `index.html`: phone and desktop interface.
