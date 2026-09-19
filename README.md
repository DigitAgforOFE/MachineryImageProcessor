# Machinery Image Processor

An assisted image-measurement tool for characterizing agricultural implements from
smartphone photos — place markers on a photo the way an echography technician places
markers on an ultrasound frame, and get back real-world measurements.

A **tool profile** can hold several photo **views** of the same implement, each tagged
with a **role** (Front / Back / Side / Top / Other) — since no single angle shows every
tool clearly, and the role tells the app which physical axis that photo's horizontal
pixels represent: Front/Back/Top read as left-right (lateral, X); Side reads as
front-to-back (depth, Z). Each view has its own independent scale calibration and its own
set of measured tools. An **Implement Summary** panel rolls up matching tools across all
views into one combined profile, and the **Render** button produces a real color-coded
**3D scatter** of every tool's position (X from a Front/Back view, Z from depth positions
marked in a Side view) — the fix for the classic case where two rows of the same tool sit
at different distances from the camera and would otherwise look wrong relative to each
other.

Zero build step, zero dependencies: plain HTML/CSS/JS running entirely in the browser.
Tool profile history (all views' photos + markers) is stored locally via IndexedDB.

## Running it

Browsers block ES module imports over `file://`, so serve the folder over local HTTP:

```bash
cd "MachineryImageProcessor"
python3 -m http.server 8000
```

Then open `http://localhost:8000` on your computer, or `http://<your-computer's-LAN-IP>:8000`
from your phone's browser (same Wi-Fi network) to load photos straight from the phone.

## How to use it

1. **Load Photo** — pick your first photo of the implement. This starts a new tool
   profile and its first view: choose its **role** (Front/Back/Side/Top/Other) and a
   label, then choose the photo.
2. **+ Add View** — add more photos of the *same* implement from other angles, same
   role+label+photo flow. Click a view's tab to switch to it — its scale and tools are
   independent of every other view. Double-click a tab to rename it, or click its **×**
   to delete it.
   - Getting at least one **Side** (or Top) view is what unlocks real 3D placement — a
     Front/Back-only profile still measures fine, but every tool renders flat (Z=0) in
     the 3D scatter since nothing has told the app how far forward/back it sits.
3. **Set Scale** (per view) — click "Set Scale", then click the two ends of something in
   the photo with a known real-world width (a tape measure, a marker board, etc.). Enter
   that known distance and unit, click **Apply**. This computes pixels-per-mm for *this
   view*; every measurement in it is derived from it.
   - If there's no reliable reference in this photo at the right distance from the
     camera (e.g. your reference was on the tractor but the implement is several feet
     behind it — perspective will throw off a reference that isn't in the same plane as
     what you're measuring), use the **"— or use a measurement from another view —"**
     dropdown instead. It lists every diameter/length/width you've already measured
     elsewhere (e.g. a closeup where a real reference gave you a disk's diameter), and
     picking one fills in the known-distance field for you. Click the same feature's two
     points in *this* photo and Apply — no separate physical reference needed here.
4. **Add Tool** (per view) — one entry per tool component visible in this photo, picked
   from an icon catalog grounded in the NRCS Tillage Equipment Pocket ID Guide (fluted
   coulters, subsoiler shanks, sweeps, disk blades, rolling baskets...):
   - Click each repeated instance of that tool on the photo (every coulter, every shank)
     — the sidebar reports count, spacing between consecutive instances, average spacing,
     and overall width. **Rolling baskets and packer/cultipacker wheels work
     differently**, since they're usually one or two wide barrels rather than discrete
     per-instance points: click a barrel's left edge, then its right edge, to record one
     barrel's width; click again for a second barrel if there is one. The sidebar reports
     barrel count, each barrel's width, the gap between barrels, and the total width —
     not a fake "instance count."
   - Optionally click "Set diameter/length/width" and place the two points the tool
     prompts for (e.g. a coulter's center + edge, a shank's top + tip) to get that tool's
     characteristic size. A round tool's diameter or a shank's length only shows its true
     size in profile, from a Side view; a flat tool's width (sweeps, points) only shows
     head-on, from a Front/Back/Top view — if you try to set one from the "wrong" view, a
     small hint says so, without blocking you (sometimes the wrong-ish angle is the only
     photo you have). You don't have to switch to the tool's own native view to set
     this — the **Link Points From Other Views** panel (see below) has a "Set
     diameter/length/width" button next to every tool, right where you'd actually want to
     use it (a disk's diameter, set from the Side view even though the disk itself was
     created in Back).
   - Add as many tools as this view shows different components. Because every tool's
     points live on the same calibrated photo, each tool's lateral offset from the
     implement's overall centerline is reported automatically — this is what keeps
     multiple tools' relative positions fixed when the whole implement is later
     repositioned in another tool.
   - Click a tool's header to make it active before clicking points for it. Drag any
     placed marker to correct its position — results update live.
   - **Equal spacing with** — if two tools (in the same view) are known to be evenly
     spaced together — a row split across two staggered toolbars (e.g. a seeder's front
     and rear bars), or just one row you want click-noise smoothed out of — pick the
     other tool here. Both groups' positions are pooled, fit to one perfectly uniform
     sequence, and *that* corrected spacing/width is what's reported and exported from
     then on, replacing the raw, slightly-uneven clicked positions.
5. **Link Points From Other Views** (shown on every view) — this is how you *link* a
   tool measured in another view to this one, point by point, in *either* direction. A
   tool can be created in any view — a coulter's diameter is easiest to set from a Side
   view, but its count/spacing across the bar still needs a Front/Back/Top view, so it
   should be linkable from there too, and vice versa. For every tool with instances
   placed anywhere else in the profile, this panel lists each individual point ("Point
   1", "Point 2"...), plus a **Scale Reference** entry for each other view's calibration
   reference. Click "Link" next to Point 1 — a banner appears over the photo telling you
   what to click next. Click the exact same physical instance, and the banner
   automatically advances to Point 2 with no extra clicks or dialogs in between, so you
   can click straight through every point. Click **Skip** for any point you can't
   positively identify in this photo (it falls back to its group's average rather than
   snapping to zero) or **Done** to stop early.
   - Also link each other view's **Scale Reference** the same way. This anchors depth to
     a stable, meaningful landmark (rather than an arbitrary midpoint of whatever's
     linked so far) and adds the reference itself as its own point in the 3D scatter, so
     you can visually check the tractor/reference sits where it should relative to the
     tools.
6. **Implement Summary** — combines matching tools (by tool type) across every view into
   one profile, e.g. count/width from the Front view alongside length from the Side view
   for the same shank.
7. **Quick Measure** — for one-off distances in the current view that don't belong to a tool.
8. **Render** — click this (Tool Profile panel) any time to check your work, and again
   after fixing something: iterate between tagging photos and rendering until it looks
   right, then Save.
   - **3D Scatter** (default tab): every measured tool as a color-coded vertical stem —
     X (left-right) from a Front/Back/Top view, Z (front-to-back) from a Depth Position
     in a Side view, and Y (the stem's length) from that tool's measured
     diameter/length/width ("Set diameter/length/width" in step 4). A tool with no size
     set yet draws as a flat dot instead of a stem. Drag or use the rotate buttons to
     check it from another angle. Download as PNG.
   - **Schematic**: a lane diagram, one lane per tool with its count/spacing/width and
     characteristic dimension as text. Lanes stack in real front-to-back order once depth
     is linked, with the exact gap between neighboring lanes labeled (e.g. "31.67 cm
     depth") and drawn roughly proportional to that real distance — lanes with no linked
     depth just sit at a default spacing with no gap label. Still useful with zero depth
     data (just no gap labels then). Download as SVG or PNG.
9. **Save** — stores every view's photo and markers as one tool profile in the browser's
   local storage. **History** lists saved profiles to reload or delete later.
10. **Export** — JSON (the full multi-view profile including depth positions,
    portable/re-importable by reading it back), CSV (flat table of every measurement
    across all views, good for spreadsheets — doesn't include 3D depth data), or PNG (the
    *current* view's photo flattened with its markers burned in, for records).

## Notes / limitations

- Each tool gets an automatically-assigned color from a palette chosen for hue
  separation (no two adjacent tools should read as "the same color" at a glance), with
  collision avoidance if the same tool type is used twice (e.g. two rows of the same
  shank). Override any tool's color with the swatch on its card if needed.
- **Perspective**: a 2-point scale assumes the reference object is roughly in the same
  plane (same distance from the camera) as what you're measuring. A reference on the
  tractor with the implement several feet behind it will be systematically off — there's
  no way to correct that from a single ordinary photo (no depth data to work with). The
  fix is to keep the reference in the same plane as the target, or use the "measurement
  from another view" dropdown to chain a known feature (measured with a real reference
  in a closeup) forward as the reference for a wider shot of the same implement.
- Series spacing is computed by sorting points left-to-right (by x-coordinate), so it
  works best on photos taken straight-on to the implement's working width.
- The Schematic render aligns every view's tools on one shared centerline using each
  view's own measurements — accurate within a view, approximate across views if they
  framed the implement differently.
- The 3D scatter's depth (Z) comes from linking individual points to a Side/Top view —
  it's a direct measurement, not a perspective-correction algorithm, so its accuracy is
  only as good as that Side view's own scale and how precisely you identify the same
  physical point in both photos. There's no automatic cross-check yet (e.g. validating
  two rows' depth separation against an "assume equal spacing" constraint) — if the
  render looks off, re-check the Side view's scale and which points you linked first.
  **The Side/Top view needs its own scale set** (its own "Set Scale", same as any other
  view) — without it, every depth link on that view silently computes to Z=0 and
  everything collapses onto one flat line. A red warning appears both in the Depth
  Positions panel and in the 3D Scatter tab if a view with depth links is missing its
  scale, so this failure mode is now visible instead of silent.
- Linking a view's Scale Reference gives depth a stable, meaningful zero point and shows
  the reference itself in the scatter — but it does **not** correct a lateral view's
  measurements for the foreshortening error a distant reference causes (the case from
  earlier: reference on the tractor, tools further back look wrong relative to each
  other). Doing that correction from first principles needs one more absolute anchor
  than linking alone provides — either an estimated camera-to-subject distance, or the
  "assume equal spacing" trick — neither of which is built yet.
- All data lives in the browser's IndexedDB — it's per-browser/per-device. Use JSON
  export if you need to move sessions between devices.
