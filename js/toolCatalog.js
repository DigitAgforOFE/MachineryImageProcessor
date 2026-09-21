// Catalog of individual tillage/planting tool components, grounded in the NRCS
// "Tillage Equipment Pocket Identification Guide." Each entry drives the marker
// workflow for one tool: which dimension it's characterized by (diameter/length/width),
// what to click to get it, and a small icon so a non-expert can pick the right one.
//
// A tool's REPEATING POSITIONS on the implement (one click per instance) always give
// count / spacing / width, regardless of tool type. `dimension` + `prompts` describe the
// ADDITIONAL one-time "characteristic size" click pair (e.g. a coulter's center-to-edge
// radius, or a shank's top-to-tip length).

const ICONS = {
  diskSmooth: `<circle cx="20" cy="20" r="14"/><circle cx="20" cy="20" r="3" fill="currentColor" stroke="none"/>`,
  diskFluted: `<circle cx="20" cy="20" r="14"/>${Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    const x1 = 20 + Math.cos(a) * 10, y1 = 20 + Math.sin(a) * 10;
    const x2 = 20 + Math.cos(a) * 14, y2 = 20 + Math.sin(a) * 14;
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }).join("")}`,
  diskNotched: `<path d="${Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    const r = i % 2 === 0 ? 14 : 10;
    const x = 20 + Math.cos(a) * r, y = 20 + Math.sin(a) * r;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ")} Z"/>`,
  diskBubble: `<circle cx="20" cy="20" r="13"/><circle cx="15" cy="16" r="2"/><circle cx="25" cy="16" r="2"/><circle cx="15" cy="24" r="2"/><circle cx="25" cy="24" r="2"/><circle cx="20" cy="20" r="2"/>`,
  diskDouble: `<circle cx="15" cy="20" r="11"/><circle cx="25" cy="20" r="11"/>`,
  shankStraight: `<path d="M20 4 L20 32" /><path d="M13 36 L27 36"/>`,
  shankParabolic: `<path d="M22 4 C22 20 10 24 9 36"/>`,
  shankBentLeg: `<path d="M20 4 L20 20 L31 36"/>`,
  shankC: `<path d="M27 5 C11 5 11 35 27 35"/>`,
  tine: `<path d="M20 4 Q29 20 20 36"/>`,
  pointNarrow: `<path d="M20 4 L14 36 L26 36 Z"/>`,
  shovel: `<path d="M20 4 L7 34 L33 34 Z"/>`,
  sweep: `<path d="M4 12 L20 30 L36 12"/>`,
  knife: `<rect x="16" y="4" width="8" height="32" rx="2"/>`,
  wheelBasket: `<circle cx="20" cy="20" r="14"/><path d="M6 20 L34 20 M20 6 L20 34 M10 10 L30 30 M30 10 L10 30"/>`,
  wheelPacker: `<circle cx="20" cy="20" r="13" stroke-width="5"/>`,
  wheelSpider: `<circle cx="20" cy="20" r="6"/>${Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2;
    const x = 20 + Math.cos(a) * 15, y = 20 + Math.sin(a) * 15;
    return `<line x1="20" y1="20" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5"/>`;
  }).join("")}`,
  wheelGauge: `<circle cx="20" cy="20" r="13" stroke-width="3"/><path d="M20 4 L20 10 M20 30 L20 36" stroke-width="3"/>`,
};

function icon(key) {
  return `<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;
}

const DIAMETER_PROMPTS = ["Center", "Edge"];
const LENGTH_PROMPTS = ["Top (soil surface)", "Bottom (tip)"];
const WIDTH_PROMPTS = ["Left tip", "Right tip"];

export const TOOL_CATEGORIES = ["Disks & Coulters", "Shanks & Tines", "Points, Shovels & Sweeps", "Rollers & Wheels"];

// The 5 tillage-pass types the OFE Cross-Section Tool's schema accepts
// (github.com/DigitAgforOFE/OFEDashbaord_CCCrossSectionTool, ALLOWED_TILLAGE_TYPES in
// lib/crop-section-validation.ts). Every tool type below carries a static NRCS-informed
// default mapping to one of these (or null for tools, like a gauge wheel, that don't
// themselves define a pass) plus whether it inverts soil — both overridable per-tool in
// the Render → Profile tab once actually measured.
export const TILLAGE_TYPES = ["strip_till", "vertical", "conventional", "chisel", "ridge_till"];

// Discs/coulters don't disturb a wide swath the way a shank or sweep does — the blade
// is thin, so it cuts a narrow near-vertical trench. A smooth/straight/concave edge
// runs true and cuts the narrowest slot; a fluted/rippled/notched/bubbled edge wobbles
// side to side as it spins, so it cuts a visibly wider trench. These are representative
// real-world widths (mm), independent of the disc's own diameter — used by the Profile
// tab's cross-section to draw a trench instead of a wide strip (see toolCatalog's
// `trenchWidthMm` and render.js's buildTillageCrossSectionSvg).
const NARROW_TRENCH_MM = 12; // smooth/straight/concave edge
const WIDE_TRENCH_MM = 30; // fluted/rippled/notched/bubbled edge

export const TOOL_TYPES = [
  // ── Disks & Coulters (diameter) ──────────────────────────────────────────
  { id: "fluted_coulter", name: "Fluted Coulter", category: "Disks & Coulters", dimension: "diameter", prompts: DIAMETER_PROMPTS, icon: icon("diskFluted"), tillageType: "vertical", soilInversion: false, trenchWidthMm: WIDE_TRENCH_MM },
  { id: "bubble_coulter", name: "Bubble Coulter", category: "Disks & Coulters", dimension: "diameter", prompts: DIAMETER_PROMPTS, icon: icon("diskBubble"), tillageType: "vertical", soilInversion: false, trenchWidthMm: WIDE_TRENCH_MM },
  { id: "ripple_coulter", name: "Ripple Coulter", category: "Disks & Coulters", dimension: "diameter", prompts: DIAMETER_PROMPTS, icon: icon("diskNotched"), tillageType: "vertical", soilInversion: false, trenchWidthMm: WIDE_TRENCH_MM },
  { id: "concave_disk", name: "Concave Disk Blade", category: "Disks & Coulters", dimension: "diameter", prompts: DIAMETER_PROMPTS, icon: icon("diskSmooth"), tillageType: "conventional", soilInversion: true, trenchWidthMm: NARROW_TRENCH_MM },
  { id: "notched_disk", name: "Notched Disk Blade", category: "Disks & Coulters", dimension: "diameter", prompts: DIAMETER_PROMPTS, icon: icon("diskNotched"), tillageType: "conventional", soilInversion: true, trenchWidthMm: WIDE_TRENCH_MM },
  { id: "straight_disk", name: "Straight Disk Blade", category: "Disks & Coulters", dimension: "diameter", prompts: DIAMETER_PROMPTS, icon: icon("diskSmooth"), tillageType: "conventional", soilInversion: true, trenchWidthMm: NARROW_TRENCH_MM },
  { id: "single_disk_opener", name: "Single Disk Opener", category: "Disks & Coulters", dimension: "diameter", prompts: DIAMETER_PROMPTS, icon: icon("diskSmooth"), tillageType: "vertical", soilInversion: false, trenchWidthMm: NARROW_TRENCH_MM },
  { id: "double_disk_opener", name: "Double Disk Opener", category: "Disks & Coulters", dimension: "diameter", prompts: DIAMETER_PROMPTS, icon: icon("diskDouble"), tillageType: "vertical", soilInversion: false, trenchWidthMm: NARROW_TRENCH_MM },

  // ── Shanks & Tines (length) ──────────────────────────────────────────────
  { id: "subsoiler_straight", name: "Subsoiler Shank — Straight", category: "Shanks & Tines", dimension: "length", prompts: LENGTH_PROMPTS, icon: icon("shankStraight"), tillageType: "chisel", soilInversion: false },
  { id: "subsoiler_parabolic", name: "Subsoiler Shank — Parabolic", category: "Shanks & Tines", dimension: "length", prompts: LENGTH_PROMPTS, icon: icon("shankParabolic"), tillageType: "chisel", soilInversion: false },
  { id: "subsoiler_bentleg", name: "Subsoiler Shank — Bent Leg", category: "Shanks & Tines", dimension: "length", prompts: LENGTH_PROMPTS, icon: icon("shankBentLeg"), tillageType: "chisel", soilInversion: false },
  { id: "c_shank", name: "C-Shank / Spring Shank", category: "Shanks & Tines", dimension: "length", prompts: LENGTH_PROMPTS, icon: icon("shankC"), tillageType: "chisel", soilInversion: false },
  { id: "spike_tine", name: "Spike-Tooth Harrow Tine", category: "Shanks & Tines", dimension: "length", prompts: LENGTH_PROMPTS, icon: icon("tine"), tillageType: "vertical", soilInversion: false },

  // ── Points, Shovels & Sweeps (width) ─────────────────────────────────────
  { id: "chisel_point", name: "Reversible Spike / Chisel Point", category: "Points, Shovels & Sweeps", dimension: "width", prompts: WIDTH_PROMPTS, icon: icon("pointNarrow"), tillageType: "chisel", soilInversion: false },
  { id: "twisted_shovel", name: "Twisted Shovel", category: "Points, Shovels & Sweeps", dimension: "width", prompts: WIDTH_PROMPTS, icon: icon("shovel"), tillageType: "chisel", soilInversion: true },
  { id: "chisel_sweep", name: "Chisel Sweep", category: "Points, Shovels & Sweeps", dimension: "width", prompts: WIDTH_PROMPTS, icon: icon("sweep"), tillageType: "chisel", soilInversion: false },
  { id: "field_cult_sweep", name: "Field Cultivator Sweep", category: "Points, Shovels & Sweeps", dimension: "width", prompts: WIDTH_PROMPTS, icon: icon("sweep"), tillageType: "vertical", soilInversion: false },
  { id: "goosefoot", name: "Goosefoot Point", category: "Points, Shovels & Sweeps", dimension: "width", prompts: WIDTH_PROMPTS, icon: icon("sweep"), tillageType: "chisel", soilInversion: false },
  { id: "anhydrous_knife", name: "Anhydrous / Fertilizer Knife", category: "Points, Shovels & Sweeps", dimension: "width", prompts: WIDTH_PROMPTS, icon: icon("knife"), tillageType: "strip_till", soilInversion: false },

  // ── Rollers & Wheels (diameter) ──────────────────────────────────────────
  // Rolling baskets and packer/cultipacker wheels are usually one or two wide barrels
  // spanning most/all of the implement — not discrete per-instance points — so their
  // repeating clicks are edge pairs (one barrel = left edge + right edge) rather than
  // one click per instance. Their rolling diameter is still a separate characteristic,
  // set the usual way (best from a Side/Top view, per its dimension below).
  { id: "rolling_basket", name: "Rolling Basket", category: "Rollers & Wheels", dimension: "diameter", prompts: DIAMETER_PROMPTS, icon: icon("wheelBasket"), instanceMode: "span", spanPrompts: ["Left edge", "Right edge"], tillageType: "vertical", soilInversion: false },
  { id: "packer_wheel", name: "Packer / Cultipacker Wheel", category: "Rollers & Wheels", dimension: "diameter", prompts: DIAMETER_PROMPTS, icon: icon("wheelPacker"), instanceMode: "span", spanPrompts: ["Left edge", "Right edge"], tillageType: "vertical", soilInversion: false },
  { id: "rotary_hoe_wheel", name: "Rotary Hoe Spider Wheel", category: "Rollers & Wheels", dimension: "diameter", prompts: DIAMETER_PROMPTS, icon: icon("wheelSpider"), tillageType: "vertical", soilInversion: false },
  { id: "row_cleaner_wheel", name: "Residue Row Cleaner Wheel", category: "Rollers & Wheels", dimension: "diameter", prompts: DIAMETER_PROMPTS, icon: icon("wheelSpider"), tillageType: "strip_till", soilInversion: false },
  // Not a soil-disturbing tool — it rides on the soil surface to set/hold the implement's
  // working depth, so its lowest point (see "Set lowest point") is the ground-level
  // reference every other tool's depth is measured against. Excluded from "dominant
  // tillage tool" selection in the Profile tab via `isDepthReference`.
  { id: "gauge_wheel", name: "Gauge / Leveling Wheel", category: "Rollers & Wheels", dimension: "diameter", prompts: DIAMETER_PROMPTS, icon: icon("wheelGauge"), tillageType: null, soilInversion: false, isDepthReference: true },
];

export function getToolType(id) {
  return TOOL_TYPES.find((t) => t.id === id) || null;
}

export const DIMENSION_LABELS = { diameter: "diameter", length: "length", width: "width" };

// A round tool (diameter) or an angled one (length) shows its true size in profile — a
// disk/coulter/wheel's face, or a shank's full drop, is only visible edge-on from a Side
// view; a flat tool's working width (sweeps, points, knives) is only visible head-on from
// a Front/Back/Top view. This drives a soft "you're probably in the wrong view" hint.
export function preferredAxisFor(dimension) {
  return dimension === "width" ? "lateral" : "depth";
}
