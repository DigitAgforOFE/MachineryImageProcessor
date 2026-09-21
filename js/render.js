// Builds a clean SVG schematic of the whole implement from every view's measurements —
// the "finished" output once marking is done, independent of any one photo's perspective.
import {
  computeCenterOffset,
  computeImplementCenterX,
  lateralCoordOf,
  verticalCoordOf,
  seriesStatsFromOffsets,
  spanStatsFromOffsets,
  computeEqualSpacingCorrections,
  characteristicResult,
  pxToMm,
  fromMm,
  round,
} from "./measurements.js";
import { getToolType } from "./toolCatalog.js";

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Views that hold links but have no scale of their own — every one of those links
// silently computes to 0, which is the "everything ends up in the same place" failure.
export function findUnscaledDepthViews(session) {
  return session.views.filter((v) => v.depthAnchors && v.depthAnchors.length && !v.scale.pixelsPerMm);
}

// Same failure mode, for the Profile tab: a view can have "lowest point" clicks on it
// but no scale of its own, in which case buildToolDepthProfile skips that whole view
// (it has no pixelsPerMm to convert with) and the Profile tab would otherwise show a
// generic "nothing measured" message that doesn't explain why the point you set isn't
// showing up.
export function findUnscaledLowestPointViews(session) {
  // A depthPoint's group isn't necessarily native to the Side view it was recorded on
  // (see buildToolDepthProfile) — search every group session-wide, not just v.groups.
  const allGroups = session.views.flatMap((v) => v.groups);
  return session.views.filter((v) => v.role === "side" && !v.scale.pixelsPerMm && allGroups.some((g) => g.depthPoint && g.depthPoint.viewId === v.id));
}

// A tool's own native photo doesn't have to be able to supply every axis: a coulter's
// diameter is only visible in profile, a sweep's width only visible head-on. So a tool
// created in ANY view can be linked from ANY other view, and which axis a view supplies
// depends only on its role — never on which view happened to create the tool.
function isLateralRole(role) {
  return role === "front" || role === "back" || role === "top" || role === "other";
}
function isDepthRole(role) {
  return role === "side";
}

// Every point recorded IN a view: its own native groups' positions, plus any point it
// links from a group native to a different view. For a "top" view, which pixel axis is
// lateral depends on how that photo was framed (see lateralCoordOf) — every other role
// always reads x, since side/depth views only ever go through here for their own x too.
function allPointsInView(v) {
  const pts = [];
  for (const g of v.groups) {
    g.positions.forEach((pt, i) => pts.push({ nativeViewId: v.id, groupId: g.id, positionIndex: i, x: lateralCoordOf(v, pt) }));
  }
  for (const a of v.depthAnchors || []) {
    if (a.kind === "instance") pts.push({ nativeViewId: a.viewId, groupId: a.groupId, positionIndex: a.positionIndex, x: lateralCoordOf(v, a) });
  }
  return pts;
}

// Converts every point recorded in a view to a real-unit offset from a stable origin:
// a linked scale-reference if this view has one, else the midpoint of every point
// recorded in it (native and linked together, so the view's sense of "center" reflects
// everything visible in it, not just what was created there).
function offsetsInView(v, unit) {
  const map = new Map();
  const pts = allPointsInView(v);
  if (!pts.length) return map;
  const linkedRef = (v.depthAnchors || []).find((a) => a.kind === "reference");
  const centerX = linkedRef ? lateralCoordOf(v, linkedRef) : (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2;
  for (const p of pts) {
    const off = computeCenterOffset(p.x, centerX, v.scale.pixelsPerMm, unit);
    map.set(`${p.nativeViewId}:${p.groupId}:${p.positionIndex}`, off.pxOnly ? null : off.value);
  }

  // Native points from groups this view has declared "equally spaced" get snapped to
  // the idealized uniform sequence instead of their raw measured position.
  const corrections = computeEqualSpacingCorrections(v, unit);
  for (const [key, value] of corrections) {
    if (map.has(`${v.id}:${key}`)) map.set(`${v.id}:${key}`, value);
  }
  return map;
}

function mergeMaps(maps) {
  const merged = new Map();
  for (const m of maps) for (const [k, val] of m) if (val != null && !merged.has(k)) merged.set(k, val);
  return merged;
}

// A tool's measured characteristic size (diameter/length/width) becomes its vertical
// extent in the scatter — a shank draws as a stem from the toolbar down to its measured
// length, a coulter as a stem the length of its diameter, and so on. Same borrowing rule
// as the schematic: if this exact group has no characteristic, use any other view's
// group of the same tool type that does.
function characteristicHeight(session, group, unit) {
  const own = characteristicResult(session, group, unit);
  if (own && !own.pxOnly) return own.value;
  for (const v of session.views) {
    const match = v.groups.find((g) => g.toolTypeId === group.toolTypeId && g.characteristic);
    if (match) {
      const r = characteristicResult(session, match, unit);
      if (r && !r.pxOnly) return r.value;
    }
  }
  return null;
}

// Builds the 3D scatter's points: one per measured tool instance, with X (lateral, from
// whichever Front/Back/Top view has it — natively or linked), Z (depth, from whichever
// Side/Top view has it — natively or linked), and a vertical stem down to Y =
// -characteristic size (a flat dot if no size is known yet). A tool can be created in
// ANY view — its own axis comes natively from there, the other axis has to be linked
// from a view of the right role. If only some instances of a group have a given axis,
// the rest fall back to that group's average rather than snapping to 0, since a rigid
// tool bar usually shares one true position. Each linked scale reference also shows up
// as its own landmark point at Z=0.
export function buildScatterPoints(session) {
  const unit = session.displayUnit;
  const points = [];
  const legend = new Map();

  const lateralMap = mergeMaps(session.views.filter((v) => isLateralRole(v.role)).map((v) => offsetsInView(v, unit)));
  const depthMap = mergeMaps(session.views.filter((v) => isDepthRole(v.role)).map((v) => offsetsInView(v, unit)));

  for (const v of session.views) {
    if (!v.scale.p1 || !v.scale.p2) continue;
    const linkedSomewhere = session.views.some((ov) => (ov.depthAnchors || []).some((a) => a.kind === "reference" && a.viewId === v.id));
    if (!linkedSomewhere) continue;
    const midX = (lateralCoordOf(v, v.scale.p1) + lateralCoordOf(v, v.scale.p2)) / 2;
    const centerX = computeImplementCenterX(v);
    const xOff = centerX != null ? computeCenterOffset(midX, centerX, v.scale.pixelsPerMm, unit).value : 0;
    legend.set(`ref:${v.id}`, { name: `Reference (${v.label})`, color: "#ffd93d" });
    points.push({ x: xOff || 0, z: 0, length: null, color: "#ffd93d", isReference: true });
  }

  for (const v of session.views) {
    for (const g of v.groups) {
      if (!g.positions.length) continue;
      legend.set(g.id, { name: g.name, color: g.color });
      const length = characteristicHeight(session, g, unit);

      const xs = g.positions.map((_, i) => lateralMap.get(`${v.id}:${g.id}:${i}`));
      const zs = g.positions.map((_, i) => depthMap.get(`${v.id}:${g.id}:${i}`));
      const knownX = xs.filter((x) => x != null);
      const knownZ = zs.filter((z) => z != null);
      const fallbackX = knownX.length ? knownX.reduce((a, b) => a + b, 0) / knownX.length : 0;
      const fallbackZ = knownZ.length ? knownZ.reduce((a, b) => a + b, 0) / knownZ.length : 0;

      g.positions.forEach((pt, i) => {
        const x = xs[i] != null ? xs[i] : fallbackX;
        const z = zs[i] != null ? zs[i] : fallbackZ;
        points.push({ x: x || 0, z: z || 0, length, color: g.color, hasDepth: zs[i] != null });
      });
    }
  }

  return { points, legend: [...legend.values()], unit };
}

// Builds one row per measured tool ("lane"), ranked by how deep its lowest point
// (`group.depthPoint`) sits below the Gauge/Leveling Wheel's own lowest point in the
// SAME Side-view photo (`isDepthReference` in toolCatalog.js) — the wheel rides the
// soil surface, so its lowest point is the ground datum everything else is measured
// against. Without a gauge wheel in a given Side view, that view's lanes fall back to
// depth relative to their own shallowest tool (flagged via `hasAbsoluteReference:
// false`) rather than a real ground reference — this also covers the common real case
// where several tools' lowest points genuinely photograph at nearly the same pixel row
// (the photo is usually a parked/raised implement, not one actually in the ground).
//
// The RELATIVE depth between tools is real geometry read off the photo and never
// user-editable per tool — that's the entire point of measuring each one's lowest
// point. What IS adjustable is the implement's real operating depth as a whole
// (`session.profileDepthOverride`, set once in the Profile tab): every lane shifts by
// the same amount, preserving the measured relative structure exactly, the same way
// raising/lowering the whole toolbar in the field does.
//
// Each lane also carries this profile's tillage-pass attributes (from the tool
// catalog, or `group.profileOverride` if the user corrected them — tillage
// type/soil inversion/full width only; NOT depth), and the single deepest lane becomes
// `dominant` — the one collapsed into a single OFE-style TillageInput by the caller
// (js/app.js's Profile tab export).
//
// A tool's depthPoint is recorded on whichever Side view it was clicked in — usually
// NOT the tool's own native view (the normal path is: create the tool in Back/Front,
// then set its lowest point from the Side view via the Link Points From Other Views
// panel, exactly like setting its diameter/length from a different view already
// works). So this can't just walk `sideView.groups` — it has to search every group in
// the session and resolve each one's depthPoint back to whichever Side view recorded
// it, the same "linked from elsewhere" pattern offsetsInView/lateralMap already use
// for lateral (X) position below.
// `unitOverride` lets the Profile tab use its own display unit (e.g. inches, to match
// the OFE tool's own convention) independent of the session's main displayUnit used
// for photo measurements elsewhere in the app.
export function buildToolDepthProfile(session, unitOverride) {
  const unit = unitOverride || session.displayUnit;
  const lanes = [];

  // Real-unit lateral (left-right) offset for every position, keyed by
  // "<nativeViewId>:<groupId>:<positionIndex>" — merged across every lateral-capable
  // view (Front/Back/Top/Other), so a tool's own positions resolve correctly no matter
  // which view(s) actually supplied/linked them. Same helper buildScatterPoints uses.
  const lateralMap = mergeMaps(session.views.filter((v) => isLateralRole(v.role)).map((v) => offsetsInView(v, unit)));
  const allLateralValues = [...lateralMap.values()];
  const implementWidth = allLateralValues.length >= 2 ? Math.max(...allLateralValues) - Math.min(...allLateralValues) : null;

  // Ground reference per Side view: the Gauge/Leveling Wheel's lowest point, found by
  // scanning every group session-wide (same reasoning as above — the wheel isn't
  // necessarily native to the Side view either). Read via verticalCoordOf, not raw
  // .y, so a Side view with a centerline set (js/app.js's "Set Direction") gets its
  // tilt corrected here too, not just its lateral/depth-axis readings. An implement
  // can have more than one gauge wheel measured in the same view (e.g. separate
  // Left/Right groups) — average every reading found for a view instead of letting
  // the last one processed silently win, since the whole point of multiple readings
  // is to average out small measurement/levelness differences, not discard all but one.
  const referenceReadingsByView = new Map(); // Side view id -> array of reference vertical coordinates
  for (const nativeView of session.views) {
    for (const g of nativeView.groups) {
      const t = getToolType(g.toolTypeId);
      if (!t || !t.isDepthReference || !g.depthPoint) continue;
      const sideView = session.views.find((sv) => sv.id === g.depthPoint.viewId && sv.role === "side" && sv.scale.pixelsPerMm);
      if (!sideView) continue;
      if (!referenceReadingsByView.has(sideView.id)) referenceReadingsByView.set(sideView.id, []);
      referenceReadingsByView.get(sideView.id).push(verticalCoordOf(sideView, g.depthPoint));
    }
  }
  const referenceYByView = new Map();
  for (const [viewId, readings] of referenceReadingsByView) {
    referenceYByView.set(viewId, readings.reduce((a, b) => a + b, 0) / readings.length);
  }

  for (const nativeView of session.views) {
    for (const g of nativeView.groups) {
      const tool = getToolType(g.toolTypeId);
      if (!tool || tool.isDepthReference) continue;
      if (!g.depthPoint) continue;
      const sideView = session.views.find((sv) => sv.id === g.depthPoint.viewId);
      if (!sideView || sideView.role !== "side" || !sideView.scale.pixelsPerMm) continue;

      const override = g.profileOverride || {};

      // Without a gauge wheel, there's no reference to subtract yet — leave `depth` as
      // this view's own raw (unit-converted) coordinate for now; the "renormalize to
      // the shallowest tool in this view" pass below turns it into a real relative
      // depth. (Subtracting each lane's own point from itself here — a bug this
      // session's testing caught — would make every no-reference lane compute to
      // exactly 0 regardless of how far apart the clicks actually were.)
      const depthV = verticalCoordOf(sideView, g.depthPoint);
      const hasAbsoluteReference = referenceYByView.has(sideView.id);
      const referenceY = hasAbsoluteReference ? referenceYByView.get(sideView.id) : 0;
      const depth = round(fromMm(pxToMm(depthV - referenceY, sideView.scale.pixelsPerMm), unit));

      const isSpan = tool.instanceMode === "span";
      const offsets = g.positions.map((_, i) => lateralMap.get(`${nativeView.id}:${g.id}:${i}`)).filter((x) => x != null);
      const widthStats = offsets.length ? (isSpan ? spanStatsFromOffsets(offsets, unit) : seriesStatsFromOffsets(offsets, unit)) : null;
      const laneWidth = offsets.length >= 2 ? Math.max(...offsets) - Math.min(...offsets) : null;
      const widthRatio = implementWidth && laneWidth != null ? laneWidth / implementWidth : null;
      // Where this lane sits left-right, for drawing it on the cross-section: the
      // midpoint of its own resolved offsets, or the implement's own center (0) as a
      // last resort if it has no positions placed anywhere yet.
      const lateralCenter = offsets.length ? (Math.min(...offsets) + Math.max(...offsets)) / 2 : 0;

      lanes.push({
        group: g,
        view: sideView,
        tool,
        depth,
        hasAbsoluteReference,
        widthStats,
        laneWidth,
        lateralCenter,
        instanceOffsets: offsets,
        implementWidth,
        fullWidth: override.fullWidth != null ? override.fullWidth : widthRatio != null ? widthRatio > 0.85 : false,
        tillageType: override.tillageType || tool.tillageType,
        soilInversion: override.soilInversion != null ? override.soilInversion : tool.soilInversion,
      });
    }
  }

  // Without a gauge wheel, "depth" above is only meaningful relative to other tools in
  // the SAME view (no ground datum) — renormalize so that view's shallowest tool reads
  // as 0 rather than an arbitrary photo-pixel offset.
  const byView = new Map();
  for (const lane of lanes) {
    if (lane.hasAbsoluteReference) continue;
    if (!byView.has(lane.view.id)) byView.set(lane.view.id, []);
    byView.get(lane.view.id).push(lane);
  }
  for (const groupLanes of byView.values()) {
    const shallowest = Math.min(...groupLanes.map((l) => l.depth));
    for (const lane of groupLanes) lane.depth = round(lane.depth - shallowest);
  }

  // Prefer ground-referenced depths (real gauge-wheel datum) over relative-only ones
  // when picking the dominant (deepest) tool, since they're on a comparable absolute
  // scale across views — relative-only depths are each view's own private baseline.
  const referenced = lanes.filter((l) => l.hasAbsoluteReference);
  const pool = referenced.length ? referenced : lanes;
  const dominant = pool.length ? pool.reduce((best, l) => (l.depth > best.depth ? l : best), pool[0]) : null;
  const measuredDominantDepth = dominant ? dominant.depth : null;
  // If no view anywhere has a gauge wheel, `pool` above still has to pick something,
  // but comparing .depth across lanes from DIFFERENT views compares two
  // independently-zeroed baselines (each just renormalized to its own shallowest tool
  // above) as if they were one shared scale — never actually measured against each
  // other. Flag it so the caller can warn, instead of presenting the pick with the
  // same confidence as a real gauge-wheel-referenced one.
  const dominantSpansUnreferencedViews = !referenced.length && new Set(pool.map((l) => l.view.id)).size > 1;

  // The implement's real operating depth, set once for the whole profile (not per
  // tool) — shifts every lane by the same amount so the dominant tool lands exactly on
  // the requested depth while every other tool keeps its measured offset from it.
  let depthOverrideApplied = false;
  if (dominant && session.profileDepthOverride != null && session.profileDepthOverride !== "") {
    const delta = Number(session.profileDepthOverride) - dominant.depth;
    if (Number.isFinite(delta) && delta !== 0) {
      for (const lane of lanes) {
        lane.depth = round(lane.depth + delta);
        lane.hasAbsoluteReference = true;
      }
      depthOverrideApplied = true;
    } else if (Number.isFinite(delta)) {
      for (const lane of lanes) lane.hasAbsoluteReference = true;
      depthOverrideApplied = true;
    }
  }

  return { lanes, dominant, unit, measuredDominantDepth, depthOverrideApplied, dominantSpansUnreferencedViews };
}

// Smallest "round" step (1/2/2.5/5 × a power of ten) that keeps a ruler to roughly
// `targetTicks` marks over `range` — the standard nice-axis-ticks trick, unit-agnostic
// so it works whether the profile's display unit is mm, cm, in, or ft.
function niceStep(range, targetTicks = 6) {
  if (!(range > 0)) return 1;
  const rough = range / targetTicks;
  const pow10 = 10 ** Math.floor(Math.log10(rough));
  for (const c of [1, 2, 2.5, 5, 10]) {
    if (c * pow10 >= rough) return c * pow10;
  }
  return 10 * pow10;
}

// Draws the soil cross-section the way the OFE Cross-Section Tool itself renders a
// tillage pass — soil layers, a depth ruler, a bed-width axis, and one dashed strip per
// measured tool at its own depth/lateral position — so this is a WYSIWYG preview of
// what importing the exported JSON will actually look like there, not just a data
// table. Every VISIBLE lane with a depth gets drawn (not just `dominant`) — pass
// `hiddenLaneIds` (a Set of group ids, from the Profile table's per-tool "Show"
// checkboxes) to isolate one or a few tools at a time, since several overlapping
// dashed strips can be hard to read individually. The `dominant` lane (the one the
// JSON export is built from) is drawn with a solid border instead of dashed, whether
// or not it happens to be visible right now. Bed width defaults to a measured estimate
// but `bedWidthOverride` (the Profile tab's "Bed width" field) replaces it outright —
// the OFE tool's own bed width is a plain typed-in number too (e.g. "90 in"), not
// derived from anything, so matching that is more useful than trusting a noisy
// photo-based estimate. Returns `{svg, measuredBedWidth}` (null if nothing to draw) so
// the caller can show "measured: Xin" next to the override field.
export function buildTillageCrossSectionSvg(profileResult, { bedWidthOverride, hiddenLaneIds } = {}) {
  const hidden = hiddenLaneIds || new Set();
  const allLanes = profileResult.lanes;
  // The dominant lane always draws (see the doc comment above) even if its own "Show"
  // checkbox is unchecked — otherwise unchecking it silently contradicts that promise
  // instead of just dropping its highlight, and can make the diagram claim "every
  // tool is hidden" while the table and export both still center on it.
  const lanes = allLanes.filter((l) => !hidden.has(l.group.id) || l === profileResult.dominant);
  if (!lanes.length) return null;
  const unit = profileResult.unit;

  // Numbered deepest-first, matching the Profile table's own sort order, so "#1" means
  // the same tool whether you're reading the table or this diagram.
  const numbered = [...lanes].sort((a, b) => b.depth - a.depth);
  numbered.forEach((l, i) => (l.number = i + 1));

  const maxDepth = Math.max(0, ...lanes.map((l) => l.depth));
  const minDepth = Math.min(0, ...lanes.map((l) => l.depth));
  const depthRange = Math.max(maxDepth - minDepth, maxDepth * 0.15, 1);

  const defaultLaneWidth = () => Math.max(depthRange * 0.15, 1);
  // A disc/coulter draws at its fixed real-world trench width (toolCatalog.js), not its
  // instance-spacing width — see the drawing loop below. Bed width has to account for
  // that too, and — since there may be no Front/Back/Top view at all to supply a real
  // `implementWidth` (Profile only strictly needs a Side view) — must never collapse
  // smaller than a few widths of its own widest element, or that element's rectangle
  // balloons past the plot entirely.
  const laneSegmentWidth = (lane) => (lane.tool.trenchWidthMm != null ? fromMm(lane.tool.trenchWidthMm, unit) : lane.laneWidth || defaultLaneWidth());

  // Measured from EVERY tool, not just whichever ones are currently toggled visible —
  // the bed width is a property of the whole implement, so hiding a tool to inspect
  // others shouldn't shrink this estimate. That means its own fallback lane width
  // can't reuse `defaultLaneWidth` above either, since that's deliberately derived
  // from the VISIBLE depth range (shrinking to fit is the whole point when isolating
  // a tool in the drawing) — reusing it here would let a hidden tool's width still
  // leak in via a smaller fallback. Use a separate range computed from every tool.
  const allMaxDepth = Math.max(0, ...allLanes.map((l) => l.depth));
  const allMinDepth = Math.min(0, ...allLanes.map((l) => l.depth));
  const allDepthRange = Math.max(allMaxDepth - allMinDepth, allMaxDepth * 0.15, 1);
  const defaultLaneWidthForBedWidth = () => Math.max(allDepthRange * 0.15, 1);
  const bedWidthSegmentWidth = (lane) => (lane.tool.trenchWidthMm != null ? fromMm(lane.tool.trenchWidthMm, unit) : lane.laneWidth || defaultLaneWidthForBedWidth());
  const widestSegment = Math.max(1, ...allLanes.map(bedWidthSegmentWidth));
  const measuredBedWidth = Math.max(
    widestSegment * 4,
    1,
    ...allLanes.map((l) => l.implementWidth || 0),
    ...allLanes.map((l) => Math.abs(l.lateralCenter) * 2 + bedWidthSegmentWidth(l)),
  );
  const overrideNum = Number(bedWidthOverride);
  const bedWidth = bedWidthOverride != null && bedWidthOverride !== "" && Number.isFinite(overrideNum) && overrideNum > 0 ? overrideNum : measuredBedWidth;

  const marginLeft = 70;
  const marginRight = 30;
  const marginTop = 50;
  const marginBottom = 60;
  const plotWidth = 620;
  const plotHeight = 260;
  const totalWidth = marginLeft + plotWidth + marginRight;
  const legendRowHeight = 20;
  const totalHeight = marginTop + plotHeight + marginBottom + lanes.length * legendRowHeight + 20;

  const depthPad = depthRange * 0.12;
  const yMin = minDepth - depthPad;
  const yMax = maxDepth + depthPad;
  const yRange = yMax - yMin;
  const depthToY = (d) => marginTop + ((d - yMin) / yRange) * plotHeight;
  const xToPixel = (offset) => marginLeft + plotWidth / 2 + (offset / (bedWidth / 2)) * (plotWidth / 2 - 10);

  const svg = svgEl("svg", { viewBox: `0 0 ${totalWidth} ${totalHeight}`, width: totalWidth, height: totalHeight });
  svg.appendChild(svgEl("rect", { x: 0, y: 0, width: totalWidth, height: totalHeight, fill: "#f4ede1" }));

  // Soil layers — a lighter topsoil band over a darker subsoil band. Purely a visual
  // convention borrowed from the OFE tool's own diagram (it doesn't know true soil
  // horizons either); the split sits at a fixed fraction of the drawn depth range.
  const groundY = depthToY(0);
  const subsoilStartDepth = Math.max(0, maxDepth * 0.35);
  const subsoilY = depthToY(subsoilStartDepth);
  svg.appendChild(svgEl("rect", { x: marginLeft, y: groundY, width: plotWidth, height: Math.max(0, subsoilY - groundY), fill: "#d9c398" }));
  svg.appendChild(svgEl("rect", { x: marginLeft, y: subsoilY, width: plotWidth, height: Math.max(0, marginTop + plotHeight - subsoilY), fill: "#9c7a4f" }));
  if (yMin < 0) {
    svg.appendChild(svgEl("rect", { x: marginLeft, y: marginTop, width: plotWidth, height: Math.max(0, groundY - marginTop), fill: "#eaf3e3" }));
  }

  // Ground line — the gauge wheel's own lowest point when one was measured, the
  // implement's overall depth when the user set one (same relative structure, just
  // shifted — see buildToolDepthProfile), otherwise just the shallowest measured tool.
  svg.appendChild(svgEl("line", { x1: marginLeft, y1: groundY, x2: marginLeft + plotWidth, y2: groundY, stroke: "#3a3226", "stroke-width": 2 }));
  const groundLabel = svgEl("text", { x: marginLeft + 6, y: groundY - 6, "font-size": 11, "font-family": "sans-serif", fill: "#3a3226" });
  const anyGaugeWheel = !profileResult.depthOverrideApplied && lanes.some((l) => l.hasAbsoluteReference);
  groundLabel.textContent = profileResult.depthOverrideApplied
    ? `ground level (implement depth set to ${round(profileResult.dominant.depth)} ${unit})`
    : anyGaugeWheel
    ? "ground level (gauge wheel)"
    : "relative reference (shallowest tool)";
  svg.appendChild(groundLabel);

  // Depth ruler.
  const step = niceStep(yRange);
  for (let d = Math.ceil(yMin / step) * step; d <= yMax + 1e-9; d += step) {
    const y = depthToY(d);
    svg.appendChild(svgEl("line", { x1: marginLeft, y1: y, x2: marginLeft + plotWidth, y2: y, stroke: "#3a3226", "stroke-width": 0.5, opacity: 0.25 }));
    const label = svgEl("text", { x: marginLeft - 8, y: y + 4, "text-anchor": "end", "font-size": 10, "font-family": "sans-serif", fill: "#3a3226" });
    label.textContent = `${round(d)}${unit}`;
    svg.appendChild(label);
  }
  const axisTitle = svgEl("text", {
    x: 16, y: marginTop + plotHeight / 2, "font-size": 10, "font-family": "sans-serif", fill: "#3a3226",
    "text-anchor": "middle", transform: `rotate(-90 16 ${marginTop + plotHeight / 2})`,
  });
  axisTitle.textContent = `depth (${unit})`;
  svg.appendChild(axisTitle);

  // Bed-width axis.
  const axisY = marginTop + plotHeight + 22;
  svg.appendChild(svgEl("line", { x1: marginLeft, y1: axisY, x2: marginLeft + plotWidth, y2: axisY, stroke: "#3a3226", "stroke-width": 1 }));
  for (const x of [marginLeft, marginLeft + plotWidth]) {
    svg.appendChild(svgEl("line", { x1: x, y1: axisY - 4, x2: x, y2: axisY + 4, stroke: "#3a3226", "stroke-width": 1 }));
  }
  const bedLabel = svgEl("text", { x: marginLeft + plotWidth / 2, y: axisY + 18, "text-anchor": "middle", "font-size": 11, "font-family": "sans-serif", fill: "#3a3226" });
  bedLabel.textContent = `${round(bedWidth)} ${unit} bed`;
  svg.appendChild(bedLabel);

  // One dashed shape per measured tool, at its own depth. The dominant lane (the one
  // the JSON export is built from) gets a solid, thicker border so it reads as "this
  // one" at a glance, matching its highlight in the Profile table.
  //
  // A disc/coulter (`tool.trenchWidthMm` set — see toolCatalog.js) doesn't disturb a
  // wide swath the way a shank or sweep does: it's a thin blade that cuts one narrow
  // near-vertical trench PER PHYSICAL DISC, not one wide zone spanning the whole row —
  // so it draws one narrow rectangle at each measured instance position instead of a
  // single strip across the group's whole footprint.
  lanes.forEach((lane) => {
    const isDominant = lane === profileResult.dominant;
    const yTop = depthToY(Math.min(0, lane.depth));
    const yBottom = depthToY(Math.max(0, lane.depth));

    const isTrench = lane.tool.trenchWidthMm != null;
    const segmentCenters = isTrench && lane.instanceOffsets.length ? lane.instanceOffsets : [lane.lateralCenter];
    const segmentWidth = laneSegmentWidth(lane);

    for (const center of segmentCenters) {
      const x1 = xToPixel(center - segmentWidth / 2);
      const x2 = xToPixel(center + segmentWidth / 2);
      svg.appendChild(
        svgEl("rect", {
          x: Math.min(x1, x2),
          y: yTop,
          width: Math.max(2, Math.abs(x2 - x1)),
          height: Math.max(2, yBottom - yTop),
          fill: lane.group.color,
          "fill-opacity": 0.3,
          stroke: lane.group.color,
          "stroke-width": isDominant ? 2.5 : 1.5,
          "stroke-dasharray": isDominant ? "none" : "4,3",
        })
      );
    }

    // A text label per shape collides badly whenever two tools sit close together
    // (common — that's the whole point of a tillage pass) — so the diagram only gets a
    // small numbered marker (one per lane, at its overall center), matched to the same
    // number in the legend below, exactly the way the 3D Scatter/Schematic tabs already
    // separate markers from their legend.
    const markerCenter = segmentCenters.reduce((a, b) => a + b, 0) / segmentCenters.length;
    const markerX = xToPixel(markerCenter);
    const r = 8;
    svg.appendChild(svgEl("circle", { cx: markerX, cy: yTop, r, fill: lane.group.color, stroke: "#f4ede1", "stroke-width": 1.5 }));
    const numberLabel = svgEl("text", {
      x: markerX, y: yTop + 3.5, "text-anchor": "middle", "font-size": 10, "font-weight": "700",
      "font-family": "sans-serif", fill: "#f4ede1",
    });
    numberLabel.textContent = String(lane.number);
    svg.appendChild(numberLabel);
  });

  // Legend — one row per lane (not a fixed 2-column grid), since row height needs to
  // fit whatever the longest name/depth text turns out to be without measuring it.
  const legendY0 = marginTop + plotHeight + marginBottom;
  numbered.forEach((lane, i) => {
    const ly = legendY0 + i * legendRowHeight + 10;
    svg.appendChild(svgEl("circle", { cx: marginLeft + 6, cy: ly - 4, r: 8, fill: lane.group.color }));
    const numberLabel = svgEl("text", { x: marginLeft + 6, y: ly - 0.5, "text-anchor": "middle", "font-size": 9, "font-weight": "700", "font-family": "sans-serif", fill: "#f4ede1" });
    numberLabel.textContent = String(lane.number);
    svg.appendChild(numberLabel);
    const text = svgEl("text", { x: marginLeft + 20, y: ly, "font-size": 11, "font-family": "sans-serif", fill: "#2a2318" });
    const depthLabel = `${round(lane.depth)} ${unit} deep`;
    text.textContent = `${lane.group.name}${lane === profileResult.dominant ? " ★ (dominant/exported)" : ""} — ${depthLabel}`;
    svg.appendChild(text);
  });

  return { svg, measuredBedWidth };
}

// Returns {svg, unplaced} or null if there's nothing to render yet.
export function buildImplementRender(session) {
  const unit = session.displayUnit;
  const lanes = [];
  const looseCharacteristics = [];

  const lateralMap = mergeMaps(session.views.filter((v) => isLateralRole(v.role)).map((v) => offsetsInView(v, unit)));
  const depthMap = mergeMaps(session.views.filter((v) => isDepthRole(v.role)).map((v) => offsetsInView(v, unit)));

  for (const v of session.views) {
    for (const g of v.groups) {
      const tool = getToolType(g.toolTypeId);
      const isSpan = tool && tool.instanceMode === "span";
      if (g.positions.length > 0) {
        const xs = g.positions.map((_, i) => lateralMap.get(`${v.id}:${g.id}:${i}`));
        const known = xs.filter((x) => x != null);
        if (!known.length) {
          if (g.characteristic) looseCharacteristics.push({ group: g, view: v, tool });
          continue;
        }
        const fallback = known.reduce((a, b) => a + b, 0) / known.length;
        const filled = xs.map((x) => (x != null ? x : fallback)); // original order — span pairing needs this
        const offsets = [...filled].sort((a, b) => a - b); // for drawing dots/line

        const zs = g.positions.map((_, i) => depthMap.get(`${v.id}:${g.id}:${i}`)).filter((z) => z != null);
        const avgZ = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null;
        const charResult = g.characteristic ? characteristicResult(session, g, unit) : null;
        const charView = g.characteristic ? session.views.find((sv) => sv.id === g.characteristic.viewId) || v : null;

        lanes.push({
          group: g,
          view: v,
          tool,
          offsets,
          avgZ,
          series: isSpan ? null : seriesStatsFromOffsets(offsets, unit),
          span: isSpan ? spanStatsFromOffsets(filled, unit) : null,
          characteristic: charResult,
          characteristicView: charView,
        });
      } else if (g.characteristic) {
        looseCharacteristics.push({ group: g, view: v, tool });
      }
    }
  }

  // Borrow a characteristic dimension from any other view measuring the same tool type.
  for (const lane of lanes) {
    if (lane.characteristic) continue;
    for (const v of session.views) {
      const match = v.groups.find((g) => g.toolTypeId === lane.group.toolTypeId && g.characteristic);
      if (match) {
        lane.characteristic = characteristicResult(session, match, unit);
        lane.characteristicView = session.views.find((sv) => sv.id === match.characteristic.viewId) || v;
        break;
      }
    }
  }

  const lanedToolTypeIds = new Set(lanes.map((l) => l.group.toolTypeId));
  const unplaced = looseCharacteristics.filter((u) => !lanedToolTypeIds.has(u.group.toolTypeId));

  // Stack lanes in real front-to-back order when depth is known, so the vertical layout
  // itself means something — lanes with no linked depth just sit after the known ones.
  const orderedLanes = [...lanes].sort((a, b) => {
    if (a.avgZ == null && b.avgZ == null) return 0;
    if (a.avgZ == null) return 1;
    if (b.avgZ == null) return -1;
    return a.avgZ - b.avgZ;
  });

  if (!lanes.length && !unplaced.length) return null;
  return { svg: renderSvg(orderedLanes, unit), lanes: orderedLanes, unplaced, unit };
}

// Vertical position of each lane is proportional to its real depth (front-to-back)
// separation from its neighbor, floored at a minimum so lanes at nearly the same depth
// (or with no depth data at all) stay legible — but the exact gap is always labeled, so
// the number is accurate even where the drawn height can't shrink further.
function layoutLaneY(lanes, laneHeight, marginTop) {
  const realGaps = [];
  for (let i = 1; i < lanes.length; i++) {
    if (lanes[i].avgZ != null && lanes[i - 1].avgZ != null) realGaps.push(lanes[i].avgZ - lanes[i - 1].avgZ);
  }
  const avgRealGap = realGaps.length ? realGaps.reduce((a, b) => a + b, 0) / realGaps.length : 0;
  const scaleZ = avgRealGap > 0 ? (laneHeight * 1.4) / avgRealGap : 0;

  const positions = [marginTop + laneHeight / 2];
  for (let i = 1; i < lanes.length; i++) {
    const z = lanes[i].avgZ, pz = lanes[i - 1].avgZ;
    let gapPx = laneHeight;
    if (z != null && pz != null) gapPx = Math.max(laneHeight, (z - pz) * scaleZ);
    positions.push(positions[i - 1] + gapPx);
  }
  return positions;
}

function renderSvg(lanes, unit) {
  const laneHeight = 68;
  const marginTop = 30;
  const marginLeft = 260;
  const drawWidth = 560;

  let maxAbs = 5;
  for (const lane of lanes) {
    for (const off of lane.offsets) maxAbs = Math.max(maxAbs, Math.abs(off));
  }
  const scale = (drawWidth / 2 - 20) / maxAbs;
  const laneY = layoutLaneY(lanes, laneHeight, marginTop);

  const totalHeight = Math.max(laneHeight, laneY[laneY.length - 1] + laneHeight / 2 + 20);
  const totalWidth = marginLeft + drawWidth + 20;
  const centerPx = marginLeft + drawWidth / 2;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${totalWidth} ${totalHeight}`,
    width: totalWidth,
    height: totalHeight,
  });

  svg.appendChild(svgEl("rect", { x: 0, y: 0, width: totalWidth, height: totalHeight, fill: "#171a20" }));
  svg.appendChild(
    svgEl("line", {
      x1: centerPx, y1: 6, x2: centerPx, y2: totalHeight - 6,
      stroke: "#4a4f5a", "stroke-width": 1, "stroke-dasharray": "4,4",
    })
  );

  // Depth-gap labels between consecutive lanes, drawn first so lane content sits on top.
  for (let i = 1; i < lanes.length; i++) {
    if (lanes[i].avgZ == null || lanes[i - 1].avgZ == null) continue;
    const yTop = laneY[i - 1];
    const yBottom = laneY[i];
    const gapX = marginLeft - 20;
    svg.appendChild(svgEl("line", { x1: gapX, y1: yTop, x2: gapX, y2: yBottom, stroke: "#5c6270", "stroke-width": 1 }));
    svg.appendChild(svgEl("line", { x1: gapX - 4, y1: yTop, x2: gapX + 4, y2: yTop, stroke: "#5c6270", "stroke-width": 1 }));
    svg.appendChild(svgEl("line", { x1: gapX - 4, y1: yBottom, x2: gapX + 4, y2: yBottom, stroke: "#5c6270", "stroke-width": 1 }));
    const gapValue = round(lanes[i].avgZ - lanes[i - 1].avgZ);
    const gapLabel = svgEl("text", {
      x: gapX, y: (yTop + yBottom) / 2, fill: "#c9ced8", "font-size": 10, "font-family": "sans-serif",
      "text-anchor": "middle", transform: `rotate(-90 ${gapX} ${(yTop + yBottom) / 2})`,
    });
    gapLabel.textContent = `${gapValue} ${unit} depth`;
    svg.appendChild(gapLabel);
  }

  lanes.forEach((lane, i) => {
    const y = laneY[i];
    const color = lane.group.color;

    const label = svgEl("text", { x: 10, y: y - 8, fill: "#e9ecf1", "font-size": 13, "font-family": "sans-serif", "font-weight": "600" });
    label.textContent = lane.group.name;
    svg.appendChild(label);

    const stats = lane.span || lane.series;
    const bits = lane.span ? [`${stats.count} barrel(s)`, `width ${stats.barrelWidths.join(", ")}`] : [`${stats.count}×`];
    const laneUnit = stats.unit || (lane.characteristic && lane.characteristic.unit) || "px";
    if (!lane.span && stats.width) bits.push(`width ${stats.width}`);
    if (!lane.span && stats.avgGap != null) bits.push(`spacing ${stats.avgGap}`);
    if (lane.span && stats.count > 1) bits.push(`total ${stats.totalWidth}`);
    if (lane.characteristic) {
      const dimLabel = lane.tool ? lane.tool.dimension : "size";
      bits.push(`${dimLabel} ${lane.characteristic.value}`);
    }
    const sub = svgEl("text", { x: 10, y: y + 8, fill: "#9aa3b2", "font-size": 10.5, "font-family": "sans-serif" });
    sub.textContent = `${bits.join(" · ")} (${laneUnit})`;
    svg.appendChild(sub);

    const viewTag = svgEl("text", { x: 10, y: y + 22, fill: "#5c6270", "font-size": 10, "font-family": "sans-serif" });
    viewTag.textContent = `from ${lane.view.label}${lane.characteristicView && lane.characteristicView !== lane.view ? ` + ${lane.characteristicView.label}` : ""}`;
    svg.appendChild(viewTag);

    if (lane.offsets.length > 1) {
      const x1 = centerPx + lane.offsets[0] * scale;
      const x2 = centerPx + lane.offsets[lane.offsets.length - 1] * scale;
      svg.appendChild(svgEl("line", { x1, y1: y, x2, y2: y, stroke: color, "stroke-width": 2, opacity: 0.55 }));
    }

    lane.offsets.forEach((off) => {
      const x = centerPx + off * scale;
      svg.appendChild(svgEl("circle", { cx: x, cy: y, r: 7, fill: color, stroke: "#171a20", "stroke-width": 1.5 }));
    });
  });

  return svg;
}

export function svgToString(svg) {
  return new XMLSerializer().serializeToString(svg);
}

export function downloadSvg(svg, filename) {
  const blob = new Blob([svgToString(svg)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadSvgAsPng(svg, filename) {
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  const blob = new Blob([svgToString(svg)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = width * 2;
    canvas.height = height * 2;
    const ctx = canvas.getContext("2d");
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(url);
    canvas.toBlob((pngBlob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(pngBlob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, "image/png");
  };
  img.src = url;
}
