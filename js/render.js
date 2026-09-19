// Builds a clean SVG schematic of the whole implement from every view's measurements —
// the "finished" output once marking is done, independent of any one photo's perspective.
import {
  computeCenterOffset,
  computeImplementCenterX,
  lateralCoordOf,
  seriesStatsFromOffsets,
  spanStatsFromOffsets,
  computeEqualSpacingCorrections,
  characteristicResult,
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

function round(value, decimals = 2) {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
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
