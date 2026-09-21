import {
  computeSeriesResult,
  computeSpanResult,
  computeImplementCenterX,
  computeCenterOffset,
  groupAnchorX,
  seriesStatsFromOffsets,
  computeEqualSpacingCorrections,
  characteristicResult,
  seriesPoints,
  lateralCoordOf,
} from "./measurements.js";
import { getToolType } from "./toolCatalog.js";

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Exports the whole multi-view tool profile: every view's photo (as a data URL) plus
// its scale and tool measurements, self-contained and re-importable by reading it back.
export async function exportSessionJSON(session) {
  const views = await Promise.all(
    session.views.map(async (v) => ({
      ...v,
      imageBlob: undefined,
      imageDataURL: v.imageBlob ? await blobToDataURL(v.imageBlob) : null,
    }))
  );
  const payload = { ...session, views };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  download(blob, `${session.name || "tool-profile"}.json`);
}

export function exportSessionCSV(session) {
  const rows = [["Tool Profile", "View", "Group", "Tool Type", "Metric", "Value", "Unit"]];
  const unit = session.displayUnit;
  const name = session.name || "tool-profile";

  for (const v of session.views) {
    const pixelsPerMm = v.scale.pixelsPerMm;

    if (v.scale.p1 && v.scale.p2) {
      rows.push([name, v.label, "Scale", "reference", "known distance", v.scale.knownDistanceValue, v.scale.knownDistanceUnit]);
    }

    const centerX = computeImplementCenterX(v);
    const corrections = computeEqualSpacingCorrections(v, unit);

    for (const g of v.groups) {
      const tool = getToolType(g.toolTypeId);
      const toolName = tool ? tool.name : g.name;

      if (g.positions.length && tool && tool.instanceMode === "span") {
        const r = computeSpanResult(seriesPoints(v, g.positions), pixelsPerMm, unit);
        rows.push([name, v.label, g.name, toolName, "barrel count", r.count, ""]);
        r.barrelWidths.forEach((w, i) => rows.push([name, v.label, g.name, toolName, `barrel ${i + 1} width`, w, r.unit || "px"]));
        r.gaps.forEach((gap, i) => rows.push([name, v.label, g.name, toolName, `gap between barrel ${i + 1} and ${i + 2}`, gap, r.unit || "px"]));
        rows.push([name, v.label, g.name, toolName, "total width", r.totalWidth, r.unit || "px"]);
      } else if (g.positions.length) {
        const linked = g.positions.some((_, i) => corrections.has(`${g.id}:${i}`));
        const r = linked
          ? seriesStatsFromOffsets(
              g.positions.map((pt, i) => {
                const key = `${g.id}:${i}`;
                if (corrections.has(key)) return corrections.get(key);
                return centerX != null ? computeCenterOffset(lateralCoordOf(v, pt), centerX, pixelsPerMm, unit).value : 0;
              }),
              unit
            )
          : computeSeriesResult(seriesPoints(v, g.positions), pixelsPerMm, unit);
        rows.push([name, v.label, g.name, toolName, "count", r.count, ""]);
        r.gaps.forEach((gap, i) => rows.push([name, v.label, g.name, toolName, `gap ${i + 1}`, gap, r.unit || "px"]));
        rows.push([name, v.label, g.name, toolName, "width", r.width, r.unit || "px"]);
        if (r.avgGap != null) rows.push([name, v.label, g.name, toolName, "avg gap", r.avgGap, r.unit]);
        if (linked) rows.push([name, v.label, g.name, toolName, "note", "evened out via equal-spacing link", ""]);
      }

      if (g.characteristic && tool) {
        const r = characteristicResult(session, g, unit);
        if (r) rows.push([name, v.label, g.name, toolName, tool.dimension, r.value, r.unit || "px"]);
      }

      const anchorX = groupAnchorX(g, v);
      if (anchorX != null && centerX != null) {
        const off = computeCenterOffset(anchorX, centerX, pixelsPerMm, unit);
        rows.push([name, v.label, g.name, toolName, "offset from implement center", off.value, off.unit || "px"]);
      }
    }
  }

  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  download(blob, `${name}.csv`);
}

// Renders one view's full-resolution photo plus its markers/lines to an offscreen canvas
// and downloads a PNG.
export function exportAnnotatedPNG(session, sessionView, image, markers, lines) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);

  for (const line of lines) {
    ctx.beginPath();
    ctx.moveTo(line.p1.x, line.p1.y);
    ctx.lineTo(line.p2.x, line.p2.y);
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  for (const m of markers) {
    ctx.beginPath();
    ctx.arc(m.x, m.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = m.color;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  }

  const name = session.name || "tool-profile";
  const label = sessionView && sessionView.label ? sessionView.label : "view";
  canvas.toBlob((blob) => download(blob, `${name}-${label}.png`), "image/png");
}
