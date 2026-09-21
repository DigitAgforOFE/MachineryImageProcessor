// Geometry, unit conversion, and per-group measurement math.

export const UNITS = ["mm", "cm", "in", "ft"];

const MM_PER_UNIT = { mm: 1, cm: 10, in: 25.4, ft: 304.8 };

export function toMm(value, unit) {
  return value * MM_PER_UNIT[unit];
}

export function fromMm(mm, unit) {
  return mm / MM_PER_UNIT[unit];
}

export function pixelDistance(p1, p2) {
  return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

// pixelsPerMm: how many image pixels correspond to one millimeter.
export function computePixelsPerMm(scaleP1, scaleP2, knownDistanceValue, knownDistanceUnit) {
  const px = pixelDistance(scaleP1, scaleP2);
  const mm = toMm(knownDistanceValue, knownDistanceUnit);
  if (!px || !mm) return null;
  return px / mm;
}

export function pxToMm(px, pixelsPerMm) {
  return px / pixelsPerMm;
}

export function round(value, decimals = 2) {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

// Computes results for a "series" group (ordered features: teeth, shanks, disks...).
// Sorts points left-to-right by x, then reports count, per-gap spacing, and overall width.
export function computeSeriesResult(points, pixelsPerMm, displayUnit) {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const count = sorted.length;
  const gapsPx = [];
  for (let i = 1; i < sorted.length; i++) {
    gapsPx.push(pixelDistance(sorted[i - 1], sorted[i]));
  }
  const widthPx = count >= 2 ? pixelDistance(sorted[0], sorted[count - 1]) : 0;

  if (!pixelsPerMm) {
    return { count, unit: null, gaps: gapsPx.map((g) => round(g, 1)), width: round(widthPx, 1), avgGap: null, pxOnly: true };
  }

  const gaps = gapsPx.map((g) => round(fromMm(pxToMm(g, pixelsPerMm), displayUnit), 2));
  const width = round(fromMm(pxToMm(widthPx, pixelsPerMm), displayUnit), 2);
  const avgGap = gaps.length ? round(gaps.reduce((a, b) => a + b, 0) / gaps.length, 2) : null;
  return { count, unit: displayUnit, gaps, width, avgGap, pxOnly: false };
}

// For "span" tools (wide continuous rollers/baskets that don't have discrete repeating
// instances the way disks or shanks do): points come in pairs — left edge, right edge —
// one pair per barrel, so "count" means barrels, each with its own width, and "gaps"
// means the space between one barrel's edge and the next's, not point-to-point spacing.
export function computeSpanResult(points, pixelsPerMm, displayUnit) {
  const barrels = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const left = points[i], right = points[i + 1];
    barrels.push({ leftX: Math.min(left.x, right.x), rightX: Math.max(left.x, right.x), centerX: (left.x + right.x) / 2, widthPx: pixelDistance(left, right) });
  }
  barrels.sort((a, b) => a.centerX - b.centerX);
  const count = barrels.length;
  const incomplete = points.length % 2 === 1;
  const gapsPx = [];
  for (let i = 1; i < barrels.length; i++) gapsPx.push(barrels[i].leftX - barrels[i - 1].rightX);
  const totalWidthPx = count ? Math.max(...barrels.map((b) => b.rightX)) - Math.min(...barrels.map((b) => b.leftX)) : 0;

  if (!pixelsPerMm) {
    return {
      count, unit: null, incomplete,
      barrelWidths: barrels.map((b) => round(b.widthPx, 1)),
      gaps: gapsPx.map((g) => round(g, 1)),
      totalWidth: round(totalWidthPx, 1),
      pxOnly: true,
    };
  }

  return {
    count, unit: displayUnit, incomplete,
    barrelWidths: barrels.map((b) => round(fromMm(pxToMm(b.widthPx, pixelsPerMm), displayUnit), 2)),
    gaps: gapsPx.map((g) => round(fromMm(pxToMm(g, pixelsPerMm), displayUnit), 2)),
    totalWidth: round(fromMm(pxToMm(totalWidthPx, pixelsPerMm), displayUnit), 2),
    pxOnly: false,
  };
}

// Same barrel-pairing idea as computeSpanResult, but starting from already-real-unit
// offsets (e.g. ones that came from a cross-view lateral link) rather than raw pixels.
export function spanStatsFromOffsets(offsets, unit) {
  const barrels = [];
  for (let i = 0; i + 1 < offsets.length; i += 2) {
    const a = offsets[i], b = offsets[i + 1];
    barrels.push({ left: Math.min(a, b), right: Math.max(a, b), center: (a + b) / 2 });
  }
  barrels.sort((x, y) => x.center - y.center);
  const count = barrels.length;
  const incomplete = offsets.length % 2 === 1;
  const gaps = [];
  for (let i = 1; i < barrels.length; i++) gaps.push(round(barrels[i].left - barrels[i - 1].right));
  const totalWidth = count ? round(Math.max(...barrels.map((b) => b.right)) - Math.min(...barrels.map((b) => b.left))) : 0;
  return { count, unit, incomplete, barrelWidths: barrels.map((b) => round(b.right - b.left)), gaps, totalWidth };
}

// Generic two-point distance, used for quick measurements and a tool's characteristic
// dimension (diameter / length / width, depending on the tool type).
export function computePairDistance(p1, p2, pixelsPerMm, displayUnit) {
  const px = pixelDistance(p1, p2);
  if (!pixelsPerMm) return { value: round(px, 1), unit: null, pxOnly: true };
  return { value: round(fromMm(pxToMm(px, pixelsPerMm), displayUnit), 2), unit: displayUnit, pxOnly: false };
}

// A characteristic can now be set from a DIFFERENT view than the group's own (e.g. a
// disk native to a Back view, but its diameter set from a Side view where it's actually
// visible face-on) — so its two points are only meaningful with the scale of whichever
// view they were clicked in. Falls back to the group's native view for older data saved
// before `characteristic.viewId` existed.
export function characteristicResult(session, group, displayUnit) {
  if (!group.characteristic) return null;
  const viewId = group.characteristic.viewId;
  const view = viewId ? session.views.find((v) => v.id === viewId) : session.views.find((v) => v.groups.includes(group));
  if (!view) return null;
  return computePairDistance(group.characteristic.p1, group.characteristic.p2, view.scale.pixelsPerMm, displayUnit);
}

// Projects a point onto a view's own local axes instead of trusting raw image x/y.
// With a `centerline` set (two points: hitch + the implement's farthest-back point
// along its own centerline, placed to mark its true fore-aft direction in this photo —
// see the "Set Direction" mode in js/app.js) this corrects for the camera/implement
// not being held perfectly level: `along` is the component along hitch→rear, `perp` is
// perpendicular to it, via ordinary 2D vector projection, so it's correct for ANY tilt
// angle, not just the axis-aligned case. A Side view's own primary axis is front-to-
// back (`along`, running down the centerline); every other role's primary axis is
// left-right (`perp`, across the implement). Without a centerline, falls back to the
// exact previous behavior — raw x, or swapped x/y for a "top" view framed with its
// lateral axis running down the photo (`topLateralAxis === "y"`) — so any profile
// saved before this feature existed renders identically.
function localAxesOf(view, pt) {
  if (view && view.centerline) {
    const { hitch, rear } = view.centerline;
    const dx = rear.x - hitch.x;
    const dy = rear.y - hitch.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len; // unit vector along hitch->rear
    // The 90°-rotated perpendicular's sign depends entirely on which way hitch->rear
    // happens to point in THIS photo — i.e. which side of the implement the camera
    // was standing on, an arbitrary framing choice, not anything physical. Left
    // unanchored, the identical real implement photographed from the opposite side
    // (an equally normal shot, hitch still clicked first either time) flips every
    // depth sign — this broke buildToolDepthProfile's dominant-tool selection. For a
    // Side view, anchor to gravity instead: "deeper into the soil" is always further
    // DOWN the image (+y) regardless of which side the photo was shot from, so flip
    // the perpendicular to always point downward — this is a real fix, not just a
    // convention choice. Every other role (lateral position) has no equivalent
    // physical anchor for left/right — a mirrored photo genuinely can't be corrected
    // from 2 points alone, same as with plain pixel x before centerlines existed — so
    // this just picks image +x (rightward) as a fixed, arbitrary-but-consistent
    // convention, purely for tidiness (e.g. "offset from center" sign in the UI).
    let vx = -uy, vy = ux; // perpendicular unit vector, sign TBD
    const anchor = view.role === "side" ? vy : vx;
    if (anchor < 0) {
      vx = -vx;
      vy = -vy;
    }
    const px = pt.x - hitch.x, py = pt.y - hitch.y;
    const along = px * ux + py * uy;
    const perp = px * vx + py * vy;
    return view.role === "side" ? { primary: along, secondary: perp } : { primary: perp, secondary: along };
  }
  const swapped = view && view.role === "top" && view.topLateralAxis === "y";
  return swapped ? { primary: pt.y, secondary: pt.x } : { primary: pt.x, secondary: pt.y };
}

// A "top" photo can be framed either way — implement running across the frame or down
// it — so unlike front/back/side (where the meaningful axis is normally the photo's
// own x), a top view has to say which pixel axis its lateral (left-right)
// measurements live on — via `topLateralAxis`, or precisely via a `centerline`
// (see localAxesOf above). Every other role's primary axis is x (or, with a
// centerline, whatever's perpendicular to the implement's true fore-aft direction).
export function lateralCoordOf(view, pt) {
  return localAxesOf(view, pt).primary;
}

// For a Side view with a centerline set, the axis perpendicular to the implement's
// fore-aft direction is vertical (soil depth) — this is what corrects the "lowest
// point" depth measurement (js/render.js's buildToolDepthProfile) for a tilted photo.
// Without a centerline, falls back to raw pt.y, matching prior behavior.
export function verticalCoordOf(view, pt) {
  if (view && view.centerline && view.role === "side") return localAxesOf(view, pt).secondary;
  return pt.y;
}

// computeSeriesResult/computeSpanResult always order and label along a point's x — fine
// when a view's primary axis IS the photo's own x, but wrong otherwise (a "top" view
// framed with its lateral axis running down the photo, or any view with a tilted
// centerline). Rather than teach those functions about axes, remap each point to
// {x: primary, y: secondary} going in: pixelDistance is rotation-invariant, so gap/
// width magnitudes come out correct either way — this only fixes the sort order.
export function seriesPoints(view, positions) {
  return positions.map((p) => {
    const { primary, secondary } = localAxesOf(view, p);
    return { ...p, x: primary, y: secondary };
  });
}

// A group's own lateral anchor in pixel space: the midpoint of its repeating instances,
// or of its characteristic pair if it has no positions yet. A characteristic set from a
// DIFFERENT view than `view` lives in that other view's pixel space and can't be mixed
// in here, so it's skipped in that case.
export function groupAnchorX(group, view) {
  if (group.positions && group.positions.length) {
    const xs = group.positions.map((p) => lateralCoordOf(view, p));
    return (Math.min(...xs) + Math.max(...xs)) / 2;
  }
  if (group.characteristic && (!view || !group.characteristic.viewId || group.characteristic.viewId === view.id)) {
    return (lateralCoordOf(view, group.characteristic.p1) + lateralCoordOf(view, group.characteristic.p2)) / 2;
  }
  return null;
}

// The implement's overall centerline in pixel space, from every group's points combined.
// Only a characteristic set IN this view contributes — one set from a different view
// lives in that view's own pixel space and would skew this view's centerline if mixed in.
export function computeImplementCenterX(view) {
  const xs = [];
  for (const g of view.groups) {
    for (const p of g.positions || []) xs.push(lateralCoordOf(view, p));
    if (g.characteristic && (!g.characteristic.viewId || g.characteristic.viewId === view.id)) {
      xs.push(lateralCoordOf(view, g.characteristic.p1), lateralCoordOf(view, g.characteristic.p2));
    }
  }
  if (!xs.length) return null;
  return (Math.min(...xs) + Math.max(...xs)) / 2;
}

// Signed lateral offset of a group's anchor from the implement's overall centerline —
// this is what lets multiple tool groups on one implement keep a fixed relative position
// when the whole implement is later repositioned/offset in a downstream tool.
export function computeCenterOffset(anchorX, centerX, pixelsPerMm, displayUnit) {
  const px = anchorX - centerX;
  if (!pixelsPerMm) return { value: round(px, 1), unit: null, pxOnly: true };
  const mm = px / pixelsPerMm;
  return { value: round(fromMm(mm, displayUnit), 2), unit: displayUnit, pxOnly: false };
}

// Count/spacing/width computed straight from already-real-unit offsets rather than raw
// pixels — used wherever the offsets may have been corrected or sourced from a different
// view's scale, so recomputing from a single group's own pixels would be inconsistent
// with what's actually being reported.
export function seriesStatsFromOffsets(offsets, unit) {
  const sorted = [...offsets].sort((a, b) => a - b);
  const count = sorted.length;
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(round(sorted[i] - sorted[i - 1]));
  const width = count >= 2 ? round(sorted[count - 1] - sorted[0]) : 0;
  const avgGap = gaps.length ? round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;
  return { count, gaps, width, avgGap, unit };
}

// Least-squares fit of x = intercept + spacing*k over k = 0..n-1 — the best single
// uniform spacing that explains a sorted sequence of positions. Used to snap measured
// positions (which carry ordinary click imprecision) to a perfectly even sequence, once
// the user has said the tools really should be evenly spaced.
export function fitUniformSequence(sortedValues) {
  const n = sortedValues.length;
  if (!n) return { spacing: 0, intercept: 0 };
  if (n === 1) return { spacing: 0, intercept: sortedValues[0] };
  const meanK = (n - 1) / 2;
  const meanX = sortedValues.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanK) * (sortedValues[i] - meanX);
    den += (i - meanK) ** 2;
  }
  const spacing = den ? num / den : 0;
  const intercept = meanX - spacing * meanK;
  return { spacing, intercept };
}

// For every set of groups a view has linked as "equally spaced," pools their real-unit
// lateral offsets, fits one uniform sequence across the pooled set, and returns each
// instance's corrected offset — replacing raw measured positions with the idealized even
// spacing the user asserted, e.g. row units split across two staggered toolbars that
// together form one evenly-spaced pattern. Keyed by "<groupId>:<positionIndex>".
export function computeEqualSpacingCorrections(view, unit) {
  const corrections = new Map();
  const links = view.equalSpacingGroups || {};
  const byLinkId = new Map();
  for (const [groupId, linkId] of Object.entries(links)) {
    if (!byLinkId.has(linkId)) byLinkId.set(linkId, []);
    byLinkId.get(linkId).push(groupId);
  }
  if (!byLinkId.size) return corrections;

  const centerX = computeImplementCenterX(view);
  const pixelsPerMm = view.scale.pixelsPerMm;

  for (const groupIds of byLinkId.values()) {
    const entries = [];
    for (const groupId of groupIds) {
      const group = view.groups.find((g) => g.id === groupId);
      if (!group) continue;
      group.positions.forEach((pt, index) => {
        if (centerX == null) return;
        const off = computeCenterOffset(lateralCoordOf(view, pt), centerX, pixelsPerMm, unit);
        if (!off.pxOnly) entries.push({ groupId, index, offset: off.value });
      });
    }
    if (entries.length < 2) continue;
    entries.sort((a, b) => a.offset - b.offset);
    const { spacing, intercept } = fitUniformSequence(entries.map((e) => e.offset));
    entries.forEach((e, rank) => {
      corrections.set(`${e.groupId}:${e.index}`, round(intercept + spacing * rank));
    });
  }
  return corrections;
}
