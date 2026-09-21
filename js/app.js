import { CanvasView } from "./canvasView.js";
import * as storage from "./storage.js";
import {
  computePixelsPerMm,
  computeSeriesResult,
  computePairDistance,
  computeImplementCenterX,
  computeCenterOffset,
  groupAnchorX,
  seriesStatsFromOffsets,
  computeEqualSpacingCorrections,
  computeSpanResult,
  characteristicResult,
  seriesPoints,
  lateralCoordOf,
  round,
} from "./measurements.js";
import { exportSessionJSON, exportSessionCSV, exportAnnotatedPNG, download } from "./export.js";
import { TOOL_TYPES, TOOL_CATEGORIES, TILLAGE_TYPES, getToolType, preferredAxisFor } from "./toolCatalog.js";
import { buildImplementRender, buildScatterPoints, buildToolDepthProfile, buildTillageCrossSectionSvg, findUnscaledDepthViews, findUnscaledLowestPointViews, downloadSvg, downloadSvgAsPng } from "./render.js";
import { Scatter3D } from "./scatter3d.js";

// Chosen for maximum hue separation at a glance on the dark background — adjacent
// entries should never read as "the same color." "#ffd93d" (yellow) is reserved for
// scale/reference markers everywhere in the app, so it's deliberately left out here.
const GROUP_COLORS = ["#5b9bff", "#ff5c5c", "#35c759", "#ff8a3d", "#b18aff", "#22d3ee", "#f368e0", "#c9a876"];
const ROLE_LABELS = { front: "Front", back: "Back", side: "Side", top: "Top", other: "Other" };
const ROLE_DEFAULTS = ["back", "side", "front"];

function uid() {
  return crypto.randomUUID();
}

function colorForTool(toolTypeId) {
  let hash = 0;
  for (let i = 0; i < toolTypeId.length; i++) hash = (hash * 31 + toolTypeId.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

// Same tool type gets the same color by default (consistent across views), but if that
// color is already taken by another group in this profile (e.g. two rows of the same
// shank type), pick the next free one so they stay visually distinguishable.
function colorForNewGroup(tool) {
  const used = new Set();
  for (const v of state.session.views) for (const g of v.groups) used.add(g.color);
  const preferred = colorForTool(tool.id);
  if (!used.has(preferred)) return preferred;
  return GROUP_COLORS.find((c) => !used.has(c)) || preferred;
}

function newView(label, role) {
  return {
    id: uid(),
    label,
    role, // 'front' | 'back' | 'side' | 'top' | 'other' — decides which axis this view's positions represent
    topLateralAxis: "y", // 'top' only: which pixel axis is left-right in this photo — 'y' if the implement's length runs across the frame, 'x' if it runs down it — superseded by `centerline` below when one is set
    centerline: null, // {hitch:{x,y}, rear:{x,y}} — hitch (tractor connection) + the implement's farthest-back point along its own centerline, in THIS photo. Gives the true fore-aft direction and corrects for the camera/implement not being held level — see localAxesOf in measurements.js
    imageBlob: null,
    imageWidth: 0,
    imageHeight: 0,
    thumbnail: null,
    scale: { p1: null, p2: null, knownDistanceValue: null, knownDistanceUnit: "cm", pixelsPerMm: null },
    groups: [], // {id, toolTypeId, name, color, positions: [{x,y}], characteristic: {p1,p2}|null, depthPoint: {x,y,viewId}|null, profileOverride: {tillageType?,soilInversion?,fullWidth?}|null}
    depthAnchors: [], // {id, kind:'instance'|'reference', viewId, groupId?, positionIndex?, x, y} — this view's depth (Z) position for a point or scale reference defined in another view
    equalSpacingGroups: {}, // { [groupId]: linkId } — groups native to this view sharing a linkId are pooled and snapped to one perfectly uniform sequence
    quickMeasurements: [],
  };
}

function isLateralRole(role) {
  return role === "front" || role === "back" || role === "top" || role === "other";
}
function isDepthRole(role) {
  return role === "side";
}
function axisCategoryForRole(role) {
  if (isLateralRole(role) && isDepthRole(role)) return "both";
  return isDepthRole(role) ? "depth" : "lateral";
}

function newSessionState() {
  return {
    id: uid(),
    name: "",
    notes: "",
    displayUnit: "cm",
    views: [],
    activeViewId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // The implement's real operating depth (its deepest/dominant tool), overriding the
    // photo-measured value — the photo is usually taken with the implement parked/
    // raised, not actually in the ground, so its absolute depth means nothing, but the
    // RELATIVE depth between tools (which one runs deeper than another) is still real
    // geometry read off the photo. Setting this shifts every tool's depth by the same
    // amount, preserving that relative structure — see buildToolDepthProfile.
    profileDepthOverride: null,
    // Profile tab's own display unit (mm/cm/in/ft) — independent of `displayUnit`
    // above, since the OFE Cross-Section Tool's own convention (inches) may not match
    // whatever unit is convenient for photo measurements elsewhere. Falls back to
    // `displayUnit` when unset.
    profileUnit: null,
    // The bed's real overall width, overriding the photo-measured estimate — the OFE
    // tool's own "Bed width" field is a plain typed number too (e.g. "90 in"), not
    // derived from anything, so this matches that rather than trusting a noisy
    // estimate from whatever happened to be visible/measured in the photo.
    profileBedWidthOverride: null,
  };
}

const state = {
  session: newSessionState(),
  image: null, // HTMLImageElement for the active view
  mode: "pan",
  activeGroupId: null,
  quickPending: null,
  characteristicTarget: null, // group id currently capturing its characteristic pair
  characteristicPending: null, // first click of that pair
  depthAnchorTarget: null, // {kind:'instance'|'reference', viewId, groupId?, positionIndex?} currently being linked on this (side/top) view
  spanPending: null, // first click of a "span" tool's current left/right edge pair
  depthPointTarget: null, // group id currently capturing its single "lowest point" click
  centerlinePending: null, // first click (hitch) of the active view's direction reference pair
};

function activeView() {
  return state.session.views.find((v) => v.id === state.session.activeViewId) || null;
}

function findGroupById(groupId) {
  for (const v of state.session.views) {
    const g = v.groups.find((g) => g.id === groupId);
    if (g) return g;
  }
  return null;
}

const canvas = document.getElementById("mainCanvas");
const emptyState = document.getElementById("emptyState");

const view = new CanvasView(canvas, {
  onClick: handleCanvasClick,
  onMarkerDrag: handleMarkerDrag,
  onMarkerDragEnd: () => refreshSidebar(),
});

// ---------- image / view loading ----------

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function makeThumbnail(img) {
  const c = document.createElement("canvas");
  const targetW = 64;
  const scale = targetW / img.width;
  c.width = targetW;
  c.height = Math.max(1, Math.round(img.height * scale));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.6);
}

// ---------- view setup modal (role + label + photo) ----------

const viewSetupModal = document.getElementById("viewSetupModal");
let viewSetupIsNewProfile = false;

function openViewSetup(isNewProfile) {
  viewSetupIsNewProfile = isNewProfile;
  const count = isNewProfile ? 0 : state.session.views.length;
  const role = ROLE_DEFAULTS[count] || "other";
  document.getElementById("viewSetupTitle").textContent = isNewProfile ? "New Tool Profile — First View" : "Add View";
  document.getElementById("viewRoleSelect").value = role;
  document.getElementById("viewLabelInput").value = ROLE_LABELS[role];
  viewSetupModal.classList.remove("hidden");
}

document.getElementById("loadPhotoBtn").addEventListener("click", () => openViewSetup(true));
document.getElementById("addViewBtn").addEventListener("click", () => openViewSetup(false));
document.getElementById("closeViewSetupBtn").addEventListener("click", () => viewSetupModal.classList.add("hidden"));

document.getElementById("viewRoleSelect").addEventListener("change", (e) => {
  document.getElementById("viewLabelInput").value = ROLE_LABELS[e.target.value];
});

document.getElementById("viewSetupFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const role = document.getElementById("viewRoleSelect").value;
  const label = document.getElementById("viewLabelInput").value || ROLE_LABELS[role];
  viewSetupModal.classList.add("hidden");

  if (viewSetupIsNewProfile) {
    state.session = newSessionState();
    resetInteractionState();
  }
  await addViewToSession(file, label, role);
  if (viewSetupIsNewProfile) syncSessionFieldsToUI();
});

async function addViewToSession(file, label, role) {
  const v = newView(label, role);
  v.imageBlob = file;
  const img = await blobToImage(file);
  v.imageWidth = img.width;
  v.imageHeight = img.height;
  v.thumbnail = makeThumbnail(img);
  state.session.views.push(v);
  await switchView(v.id);
}

async function switchView(id) {
  const v = state.session.views.find((x) => x.id === id);
  if (!v) return;
  state.session.activeViewId = id;
  resetInteractionState();
  state.image = await blobToImage(v.imageBlob);
  view.setImage(state.image);
  emptyState.style.display = "none";
  refreshSidebar();
  refreshOverlay();
  renderViewsBar();
}

async function deleteView(id) {
  if (!confirm("Delete this view? Its scale and measurements will be lost.")) return;
  state.session.views = state.session.views.filter((v) => v.id !== id);
  if (state.session.activeViewId === id) {
    if (state.session.views.length) {
      await switchView(state.session.views[0].id);
    } else {
      state.session.activeViewId = null;
      state.image = null;
      view.image = null;
      view.render();
      emptyState.style.display = "flex";
      resetInteractionState();
      refreshSidebar();
      renderViewsBar();
    }
  } else {
    renderViewsBar();
  }
}

function renameView(id) {
  const v = state.session.views.find((x) => x.id === id);
  if (!v) return;
  const label = prompt("Rename this view:", v.label);
  if (label) {
    v.label = label;
    renderViewsBar();
    refreshSidebar();
  }
}

function renderViewsBar() {
  const bar = document.getElementById("viewsTabs");
  bar.innerHTML = "";
  for (const v of state.session.views) {
    const tab = document.createElement("div");
    tab.className = "view-tab" + (v.id === state.session.activeViewId ? " active" : "");

    const thumb = document.createElement("img");
    thumb.className = "view-thumb";
    thumb.src = v.thumbnail || "";

    const label = document.createElement("span");
    label.className = "view-tab-label";
    label.textContent = `${v.label} (${ROLE_LABELS[v.role] || v.role})`;

    const del = document.createElement("span");
    del.className = "view-tab-del";
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteView(v.id);
    });

    tab.append(thumb, label, del);
    tab.addEventListener("click", () => {
      if (v.id !== state.session.activeViewId) switchView(v.id);
    });
    tab.addEventListener("dblclick", () => renameView(v.id));
    bar.appendChild(tab);
  }
}

function resetInteractionState() {
  state.activeGroupId = null;
  state.quickPending = null;
  state.characteristicTarget = null;
  state.characteristicPending = null;
  state.depthAnchorTarget = null;
  state.spanPending = null;
  state.depthPointTarget = null;
  state.centerlinePending = null;
}

document.getElementById("newSessionBtn").addEventListener("click", () => {
  state.session = newSessionState();
  state.image = null;
  resetInteractionState();
  view.image = null;
  view.render();
  emptyState.style.display = "flex";
  syncSessionFieldsToUI();
  refreshSidebar();
  renderViewsBar();
});

// ---------- mode buttons ----------

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});
setMode("pan");

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
}

document.getElementById("zoomInBtn").addEventListener("click", () => {
  const r = canvas.getBoundingClientRect();
  view.zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.2);
});
document.getElementById("zoomOutBtn").addEventListener("click", () => {
  const r = canvas.getBoundingClientRect();
  view.zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8);
});
document.getElementById("fitBtn").addEventListener("click", () => {
  view.fitToView();
  view.render();
});

// ---------- canvas interaction ----------

function handleCanvasClick(imgPt) {
  const v = activeView();
  if (!state.image || !v) return;
  clampToImage(imgPt);

  if (state.mode === "scale") {
    const s = v.scale;
    if (!s.p1) {
      s.p1 = imgPt;
    } else if (!s.p2) {
      s.p2 = imgPt;
    } else {
      s.p1 = imgPt;
      s.p2 = null;
      s.pixelsPerMm = null;
    }
    refreshSidebar();
    refreshOverlay();
  } else if (state.mode === "centerline") {
    if (!state.centerlinePending) {
      state.centerlinePending = imgPt;
      refreshSidebar();
      refreshOverlay();
    } else {
      v.centerline = { hitch: state.centerlinePending, rear: imgPt };
      state.centerlinePending = null;
      setMode("pan");
      refreshSidebar();
      refreshOverlay();
    }
  } else if (state.mode === "group") {
    const group = v.groups.find((g) => g.id === state.activeGroupId);
    if (!group) {
      alert("Add a tool first (right panel), then click its repeated instances on the photo.");
      return;
    }
    const tool = getToolType(group.toolTypeId);
    if (tool && tool.instanceMode === "span") {
      if (!state.spanPending) {
        state.spanPending = imgPt;
      } else {
        group.positions.push(state.spanPending, imgPt);
        state.spanPending = null;
      }
    } else {
      group.positions.push(imgPt);
    }
    refreshSidebar();
    refreshOverlay();
  } else if (state.mode === "characteristic") {
    // The target group may live in a DIFFERENT view than the one active right now —
    // e.g. a disk created in Back, but its diameter set from Side where it's visible
    // face-on — so search every view, not just this one. Diameter/length are hard-
    // blocked outside a Side view (see renderGroups) — checked here too in case
    // mode/target state goes stale. Width stays allowed from any view.
    const group = findGroupById(state.characteristicTarget);
    if (!group) return;
    const groupTool = getToolType(group.toolTypeId);
    if (groupTool && preferredAxisFor(groupTool.dimension) === "depth" && v.role !== "side") {
      alert(`${groupTool.dimension[0].toUpperCase()}${groupTool.dimension.slice(1)} can only be set from a Side view.`);
      state.characteristicPending = null;
      state.characteristicTarget = null;
      setMode("pan");
      refreshSidebar();
      return;
    }
    if (!state.characteristicPending) {
      state.characteristicPending = imgPt;
      refreshOverlay();
    } else {
      group.characteristic = { p1: state.characteristicPending, p2: imgPt, viewId: v.id };
      state.characteristicPending = null;
      state.characteristicTarget = null;
      setMode("pan");
      refreshSidebar();
      refreshOverlay();
    }
  } else if (state.mode === "depthpoint") {
    // Unlike characteristic, lowest point is only meaningful from a Side view (it's a
    // vertical/photo-Y measurement a Front/Back/Top photo can't show) — hard-blocked
    // here too, not just by hiding the button, in case mode/target state goes stale.
    if (v.role !== "side") {
      alert("A tool's lowest point can only be set from a Side view.");
      state.depthPointTarget = null;
      setMode("pan");
      refreshSidebar();
      return;
    }
    const group = findGroupById(state.depthPointTarget);
    if (!group) return;
    group.depthPoint = { x: imgPt.x, y: imgPt.y, viewId: v.id };
    state.depthPointTarget = null;
    setMode("pan");
    refreshSidebar();
    refreshOverlay();
  } else if (state.mode === "quick") {
    if (!state.quickPending) {
      state.quickPending = imgPt;
      refreshOverlay();
    } else {
      v.quickMeasurements.push({ id: uid(), p1: state.quickPending, p2: imgPt });
      state.quickPending = null;
      refreshSidebar();
      refreshOverlay();
    }
  } else if (state.mode === "depth") {
    const target = state.depthAnchorTarget;
    if (!target) return;
    if (target.kind === "reference") {
      const existing = v.depthAnchors.find((a) => a.kind === "reference" && a.viewId === target.viewId);
      if (existing) {
        existing.x = imgPt.x;
        existing.y = imgPt.y;
      } else {
        v.depthAnchors.push({ id: uid(), kind: "reference", viewId: target.viewId, x: imgPt.x, y: imgPt.y });
      }
    } else {
      const existing = v.depthAnchors.find(
        (a) => a.kind !== "reference" && a.viewId === target.viewId && a.groupId === target.groupId && a.positionIndex === target.positionIndex
      );
      if (existing) {
        existing.x = imgPt.x;
        existing.y = imgPt.y;
      } else {
        v.depthAnchors.push({
          id: uid(),
          kind: "instance",
          viewId: target.viewId,
          groupId: target.groupId,
          positionIndex: target.positionIndex,
          x: imgPt.x,
          y: imgPt.y,
        });
      }
    }
    advanceLinking();
    refreshSidebar();
    refreshOverlay();
  }
}

// Figures out how many steps the current linking target has (a group's positions, or a
// single scale-reference point) and what the next step is, so clicking the photo can
// advance straight through every point without returning to the sidebar each time.
function getLinkingSequenceInfo(target) {
  if (!target) return null;
  if (target.kind === "reference") return { total: 1, next: null };
  const sourceView = state.session.views.find((sv) => sv.id === target.viewId);
  const sourceGroup = sourceView && sourceView.groups.find((g) => g.id === target.groupId);
  if (!sourceGroup) return null;
  const total = sourceGroup.positions.length;
  const next = target.positionIndex + 1 < total ? { ...target, positionIndex: target.positionIndex + 1 } : null;
  return { total, next, sourceGroup, sourceView };
}

function advanceLinking() {
  const info = getLinkingSequenceInfo(state.depthAnchorTarget);
  state.depthAnchorTarget = info && info.next ? info.next : null;
  if (!state.depthAnchorTarget) setMode("pan");
}

document.getElementById("linkingSkipBtn").addEventListener("click", () => {
  advanceLinking();
  refreshSidebar();
  refreshOverlay();
});

document.getElementById("linkingStopBtn").addEventListener("click", () => {
  state.depthAnchorTarget = null;
  setMode("pan");
  refreshSidebar();
  refreshOverlay();
});

function updateLinkingBanner() {
  const banner = document.getElementById("linkingBanner");
  const target = state.depthAnchorTarget;
  if (!target) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
  const ov = state.session.views.find((v) => v.id === target.viewId);
  const text = document.getElementById("linkingBannerText");
  if (target.kind === "reference") {
    text.textContent = `Click where the "${ov ? ov.label : ""}" reference sits on this photo.`;
  } else {
    const info = getLinkingSequenceInfo(target);
    const g = info && info.sourceGroup;
    text.textContent = `Linking ${g ? g.name : "tool"} (${ov ? ov.label : ""}) — click Point ${target.positionIndex + 1} of ${info ? info.total : "?"} on this photo.`;
  }
}

function clampToImage(pt) {
  pt.x = Math.max(0, Math.min(state.image.width, pt.x));
  pt.y = Math.max(0, Math.min(state.image.height, pt.y));
}

function handleMarkerDrag(ref, imgPt) {
  const v = activeView();
  if (!v) return;
  clampToImage(imgPt);
  if (ref.kind === "scale") {
    v.scale[ref.which] = imgPt;
  } else if (ref.kind === "centerline") {
    if (v.centerline) v.centerline[ref.which] = imgPt;
  } else if (ref.kind === "group") {
    const group = v.groups.find((g) => g.id === ref.groupId);
    if (group) group.positions[ref.index] = imgPt;
  } else if (ref.kind === "characteristic") {
    const group = findGroupById(ref.groupId);
    if (group && group.characteristic) group.characteristic[ref.which] = imgPt;
  } else if (ref.kind === "depthpoint") {
    const group = findGroupById(ref.groupId);
    if (group && group.depthPoint) {
      group.depthPoint.x = imgPt.x;
      group.depthPoint.y = imgPt.y;
    }
  } else if (ref.kind === "quick") {
    const qm = v.quickMeasurements.find((q) => q.id === ref.id);
    if (qm) qm[ref.which] = imgPt;
  } else if (ref.kind === "depth") {
    const anchor = v.depthAnchors.find((a) => a.id === ref.id);
    if (anchor) {
      anchor.x = imgPt.x;
      anchor.y = imgPt.y;
    }
  }
  refreshOverlay();
}

// ---------- scale panel ----------

document.getElementById("applyScaleBtn").addEventListener("click", () => {
  const v = activeView();
  if (!v) return;
  const value = parseFloat(document.getElementById("knownDistanceValue").value);
  const unit = document.getElementById("knownDistanceUnit").value;
  const s = v.scale;
  if (!s.p1 || !s.p2) {
    alert('Click "Set Scale" and place both reference points on the photo first.');
    return;
  }
  if (!value || value <= 0) {
    alert("Enter the known real-world distance of your reference object.");
    return;
  }
  s.knownDistanceValue = value;
  s.knownDistanceUnit = unit;
  s.pixelsPerMm = computePixelsPerMm(s.p1, s.p2, value, unit);
  refreshSidebar();
});

document.getElementById("resetScaleBtn").addEventListener("click", () => {
  const v = activeView();
  if (!v) return;
  v.scale = { p1: null, p2: null, knownDistanceValue: null, knownDistanceUnit: "cm", pixelsPerMm: null };
  refreshSidebar();
  refreshOverlay();
});

document.getElementById("clearDirectionBtn").addEventListener("click", () => {
  const v = activeView();
  if (!v) return;
  v.centerline = null;
  refreshSidebar();
  refreshOverlay();
});

document.getElementById("displayUnit").addEventListener("change", (e) => {
  state.session.displayUnit = e.target.value;
  // profileUnit silently inherits displayUnit while unset — if so, changing
  // displayUnit also changes what unit the Profile tab's overrides get interpreted
  // in, so they need clearing the same way changing the Profile tab's own unit
  // selector already does (see profileUnitSelect's handler below).
  if (state.session.profileUnit == null) {
    state.session.profileDepthOverride = null;
    state.session.profileBedWidthOverride = null;
  }
  refreshSidebar();
});

// Lets a view's scale be calibrated from a measurement already taken elsewhere (e.g. a
// closeup with a real reference gives a disk's diameter; a wider shot then uses that
// disk as its own reference) instead of a fresh physical reference every time.
function renderScaleRefOptions() {
  const select = document.getElementById("scaleRefSource");
  select.innerHTML = '<option value="">— or use a measurement from another view —</option>';
  const unit = state.session.displayUnit;

  state.session.views.forEach((v) => {
    v.groups.forEach((g) => {
      if (!g.characteristic) return;
      const tool = getToolType(g.toolTypeId);
      const r = characteristicResult(state.session, g, unit);
      if (!r || r.pxOnly) return;
      const option = document.createElement("option");
      option.value = JSON.stringify({ value: r.value, unit: r.unit });
      option.textContent = `${v.label}: ${tool ? tool.name : g.name} — ${tool ? tool.dimension : "size"} ${r.value} ${r.unit}`;
      select.appendChild(option);
    });
    v.quickMeasurements.forEach((qm, i) => {
      const r = computePairDistance(qm.p1, qm.p2, v.scale.pixelsPerMm, unit);
      if (r.pxOnly) return;
      const option = document.createElement("option");
      option.value = JSON.stringify({ value: r.value, unit: r.unit });
      option.textContent = `${v.label}: Quick measurement #${i + 1} — ${r.value} ${r.unit}`;
      select.appendChild(option);
    });
  });
}

document.getElementById("scaleRefSource").addEventListener("change", (e) => {
  if (!e.target.value) return;
  const { value, unit } = JSON.parse(e.target.value);
  document.getElementById("knownDistanceValue").value = value;
  document.getElementById("knownDistanceUnit").value = unit;
});

// ---------- tool picker ----------

const toolPickerModal = document.getElementById("toolPickerModal");
document.getElementById("addToolBtn").addEventListener("click", () => {
  if (!state.image) {
    alert("Load a photo first.");
    return;
  }
  renderToolPicker();
  toolPickerModal.classList.remove("hidden");
});
document.getElementById("closeToolPickerBtn").addEventListener("click", () => toolPickerModal.classList.add("hidden"));

function renderToolPicker() {
  const body = document.getElementById("toolPickerBody");
  body.innerHTML = "";
  for (const category of TOOL_CATEGORIES) {
    const heading = document.createElement("div");
    heading.className = "tool-category";
    heading.textContent = category;
    body.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "tool-grid";
    for (const tool of TOOL_TYPES.filter((t) => t.category === category)) {
      const option = document.createElement("div");
      option.className = "tool-option";
      option.innerHTML = `${tool.icon}<span>${tool.name}</span>`;
      option.addEventListener("click", () => {
        addGroup(tool);
        toolPickerModal.classList.add("hidden");
      });
      grid.appendChild(option);
    }
    body.appendChild(grid);
  }
}

function addGroup(tool) {
  const v = activeView();
  if (!v) return;
  const group = {
    id: uid(),
    toolTypeId: tool.id,
    name: tool.name,
    color: colorForNewGroup(tool),
    positions: [],
    characteristic: null,
    depthPoint: null,
    profileOverride: null,
  };
  v.groups.push(group);
  state.activeGroupId = group.id;
  setMode("group");
  refreshSidebar();
  refreshOverlay();
}

function renderGroups() {
  const v = activeView();
  const container = document.getElementById("groupsList");
  container.innerHTML = "";
  if (!v) return;
  const unit = state.session.displayUnit;
  const centerX = computeImplementCenterX(v);
  const pxPerMm = v.scale.pixelsPerMm;
  const corrections = computeEqualSpacingCorrections(v, unit);

  for (const group of v.groups) {
    const tool = getToolType(group.toolTypeId);
    const isSpan = tool && tool.instanceMode === "span";
    const card = document.createElement("div");
    card.className = "group-card";
    if (group.id === state.activeGroupId) card.style.borderColor = group.color;

    const header = document.createElement("div");
    header.className = "group-card-header";

    const iconWrap = document.createElement("span");
    iconWrap.className = "group-card-icon";
    iconWrap.style.color = group.color;
    iconWrap.innerHTML = tool ? tool.icon : "";

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = group.color;
    colorInput.addEventListener("input", (e) => {
      group.color = e.target.value;
      refreshOverlay();
    });

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = group.name;
    nameInput.addEventListener("input", (e) => (group.name = e.target.value));

    const delBtn = document.createElement("button");
    delBtn.className = "btn danger";
    delBtn.textContent = "×";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      v.groups = v.groups.filter((g) => g.id !== group.id);
      if (state.activeGroupId === group.id) {
        state.activeGroupId = null;
        state.spanPending = null;
      }
      // Clear any pending click-target state that pointed at the now-deleted group —
      // otherwise the next canvas click silently no-ops through that mode's own
      // `if (!group) return;` guard (findGroupById can no longer find it), leaving
      // the app stuck swallowing every click with no error until the user happens to
      // pick a different mode button.
      if (state.depthPointTarget === group.id) {
        state.depthPointTarget = null;
        setMode("pan");
      }
      if (state.characteristicTarget === group.id) {
        state.characteristicTarget = null;
        state.characteristicPending = null;
        setMode("pan");
      }
      if (state.depthAnchorTarget && state.depthAnchorTarget.groupId === group.id) {
        state.depthAnchorTarget = null;
        setMode("pan");
      }
      refreshSidebar();
      refreshOverlay();
    });

    header.append(iconWrap, colorInput, nameInput, delBtn);
    header.addEventListener("click", (e) => {
      if (e.target === colorInput || e.target === nameInput) return;
      state.activeGroupId = group.id;
      setMode("group");
      refreshSidebar();
    });

    const chips = document.createElement("div");
    if (tool && tool.instanceMode === "span") {
      for (let b = 0; b * 2 < group.positions.length; b++) {
        const chip = document.createElement("span");
        chip.className = "point-chip";
        const complete = b * 2 + 1 < group.positions.length;
        chip.textContent = complete ? `Barrel ${b + 1}` : `Barrel ${b + 1} (left edge only)`;
        const x = document.createElement("span");
        x.className = "x";
        x.textContent = "×";
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          group.positions.splice(b * 2, complete ? 2 : 1);
          refreshSidebar();
          refreshOverlay();
        });
        chip.appendChild(x);
        chips.appendChild(chip);
      }
      if (state.spanPending && state.activeGroupId === group.id) {
        const chip = document.createElement("span");
        chip.className = "point-chip";
        chip.textContent = "click right edge...";
        chips.appendChild(chip);
      }
    } else {
      group.positions.forEach((pt, i) => {
        const chip = document.createElement("span");
        chip.className = "point-chip";
        chip.textContent = `#${i + 1}`;
        const x = document.createElement("span");
        x.className = "x";
        x.textContent = "×";
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          group.positions.splice(i, 1);
          refreshSidebar();
          refreshOverlay();
        });
        chip.appendChild(x);
        chips.appendChild(chip);
      });
    }

    const otherPointGroups = v.groups.filter((other) => {
      if (other.id === group.id) return false;
      const otherTool = getToolType(other.toolTypeId);
      return !(otherTool && otherTool.instanceMode === "span");
    });
    let equalRow = null;
    if (!isSpan && otherPointGroups.length) {
      equalRow = document.createElement("div");
      equalRow.className = "equal-spacing-row";
      const equalLabel = document.createElement("span");
      equalLabel.className = "hint";
      equalLabel.style.margin = "0";
      equalLabel.textContent = "Equal spacing with:";
      const equalSelect = document.createElement("select");
      const noneOpt = document.createElement("option");
      noneOpt.value = "";
      noneOpt.textContent = "— none —";
      equalSelect.appendChild(noneOpt);
      for (const other of otherPointGroups) {
        const opt = document.createElement("option");
        opt.value = other.id;
        opt.textContent = other.name;
        equalSelect.appendChild(opt);
      }
      const myLinkId = v.equalSpacingGroups[group.id];
      if (myLinkId) {
        const partner = v.groups.find((g) => g.id !== group.id && v.equalSpacingGroups[g.id] === myLinkId);
        if (partner) equalSelect.value = partner.id;
      }
      equalSelect.addEventListener("change", (e) => {
        const otherId = e.target.value;
        if (!otherId) {
          delete v.equalSpacingGroups[group.id];
        } else {
          const linkId = v.equalSpacingGroups[otherId] || v.equalSpacingGroups[group.id] || uid();
          v.equalSpacingGroups[group.id] = linkId;
          v.equalSpacingGroups[otherId] = linkId;
        }
        refreshSidebar();
        refreshOverlay();
      });
      equalRow.append(equalLabel, equalSelect);
    }

    const results = document.createElement("div");
    results.className = "group-results";
    results.innerHTML = formatGroupResults(group, unit, pxPerMm, centerX, v.groups.length, corrections, v);

    // Diameter/length (dimension whose preferred axis is "depth") only shows its true
    // size in profile, so — like lowest point — it's hard-restricted to the Side view,
    // not just hinted. Width stays allowed from any view with just a soft hint: a flat
    // tool's width is visible from several lateral angles (Front/Back/Top), so there's
    // no single "only correct" photo the way there is for a round/depth tool.
    const charAllowed = !tool || preferredAxisFor(tool.dimension) !== "depth" || v.role === "side";
    let charRow = null;
    let mismatchHint = null;
    if (charAllowed) {
      charRow = document.createElement("div");
      charRow.className = "characteristic-row";
      const charBtn = document.createElement("button");
      charBtn.className = "btn";
      charBtn.textContent = group.characteristic ? `Update ${tool ? tool.dimension : "size"}` : `Set ${tool ? tool.dimension : "size"}`;
      charBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.characteristicTarget = group.id;
        state.characteristicPending = null;
        state.activeGroupId = group.id;
        setMode("characteristic");
        refreshSidebar();
        if (tool) alert(`Click on the photo: 1) ${tool.prompts[0]}  2) ${tool.prompts[1]}`);
      });
      charRow.appendChild(charBtn);
      if (state.characteristicTarget === group.id) {
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.style.margin = "0";
        hint.textContent = state.characteristicPending ? "Click the second point..." : "Click the first point...";
        charRow.appendChild(hint);
      } else if (tool) {
        const axisNow = axisCategoryForRole(v.role);
        const preferred = preferredAxisFor(tool.dimension);
        if (axisNow !== "both" && axisNow !== preferred) {
          mismatchHint = document.createElement("p");
          mismatchHint.className = "hint axis-mismatch-hint";
          mismatchHint.textContent = `💡 ${tool.dimension} is usually clearer from a ${preferred === "depth" ? "Side" : "Front/Back/Top"} view — this is a ${ROLE_LABELS[v.role] || v.role} view.`;
        }
      }
    } else if (group.characteristic) {
      charRow = document.createElement("p");
      charRow.className = "hint";
      charRow.style.margin = "8px 0 0";
      const dimensionLabel = `${tool.dimension[0].toUpperCase()}${tool.dimension.slice(1)}`;
      // Name whichever view it was ACTUALLY measured in, not just "a Side view" — a
      // session saved before this restriction existed could have it set from any
      // view (Top/Front/Back), and hard-coding "Side" there would misinform the user
      // about where the value actually came from.
      const charView = state.session.views.find((sv) => sv.id === group.characteristic.viewId);
      charRow.textContent = charView ? `${dimensionLabel} set (from "${charView.label}").` : `${dimensionLabel} set (from another view).`;
    }

    // Every tool gets a "lowest point" button — including a gauge/leveling wheel, since
    // its own lowest point is exactly what other tools' depths get measured against
    // (see toolCatalog.js `isDepthReference` and render.js buildToolDepthProfile). It's
    // vertical position in a photo, only meaningful in profile — a Front/Back/Top photo
    // doesn't show it at all — so unlike characteristic (diameter/length/width), this is
    // a hard restriction to the active view being a Side view, not just a hint.
    let depthRow = null;
    if (v.role === "side") {
      depthRow = document.createElement("div");
      depthRow.className = "characteristic-row";
      const depthBtn = document.createElement("button");
      depthBtn.className = "btn";
      depthBtn.textContent = group.depthPoint ? "Update lowest point" : "Set lowest point";
      depthBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.depthPointTarget = group.id;
        state.activeGroupId = group.id;
        setMode("depthpoint");
        refreshSidebar();
      });
      depthRow.appendChild(depthBtn);
      if (state.depthPointTarget === group.id) {
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.style.margin = "0";
        hint.textContent = tool && tool.isDepthReference
          ? "Click where this wheel touches the ground..."
          : "Click this tool's lowest point...";
        depthRow.appendChild(hint);
      }
    } else if (group.depthPoint) {
      depthRow = document.createElement("p");
      depthRow.className = "hint";
      depthRow.style.margin = "8px 0 0";
      depthRow.textContent = "Lowest point set (from the Side view).";
    }

    card.append(header, chips);
    if (equalRow) card.appendChild(equalRow);
    card.appendChild(results);
    if (charRow) card.appendChild(charRow);
    if (mismatchHint) card.appendChild(mismatchHint);
    if (depthRow) card.appendChild(depthRow);
    container.appendChild(card);
  }
}

function formatGroupResults(group, unit, pxPerMm, centerX, groupCount, corrections, view) {
  const tool = getToolType(group.toolTypeId);
  const isSpan = tool && tool.instanceMode === "span";
  const parts = [];

  if (isSpan) {
    if (group.positions.length) {
      const r = computeSpanResult(seriesPoints(view, group.positions), pxPerMm, unit);
      const u = r.unit || "px";
      let html = `<b>${r.count}</b> barrel(s)`;
      if (r.barrelWidths.length) html += ` &middot; width: ${r.barrelWidths.join(", ")} ${u}`;
      if (r.gaps.length) html += `<br/>gap between barrels: ${r.gaps.join(", ")} ${u}`;
      if (r.count >= 2) html += `<br/>total width: <b>${r.totalWidth} ${u}</b>`;
      if (r.incomplete) html += `<br/><span style="color:var(--danger)">Odd number of points — click a right edge to complete the last barrel.</span>`;
      parts.push(html);
    } else {
      parts.push('<span class="hint" style="margin:0">No barrels placed yet — click a barrel\'s left edge, then its right edge.</span>');
    }
  } else if (group.positions.length) {
    const linked = group.positions.some((_, i) => corrections && corrections.has(`${group.id}:${i}`));
    let r;
    if (linked) {
      const offsets = group.positions.map((pt, i) => {
        const key = `${group.id}:${i}`;
        if (corrections.has(key)) return corrections.get(key);
        return centerX != null ? computeCenterOffset(lateralCoordOf(view, pt), centerX, pxPerMm, unit).value : 0;
      });
      r = seriesStatsFromOffsets(offsets, unit);
    } else {
      r = computeSeriesResult(seriesPoints(view, group.positions), pxPerMm, unit);
    }
    const u = r.unit || "px";
    let html = `<b>${r.count}</b> instance(s)`;
    if (r.gaps.length) html += ` &middot; spacing: ${r.gaps.join(", ")} ${u}`;
    if (r.avgGap != null) html += ` (avg ${r.avgGap} ${u})`;
    if (r.count >= 2) html += `<br/>width: <b>${r.width} ${u}</b>`;
    if (linked) html += `<br/><span style="color:var(--accent-hover)">evened out to a uniform sequence (equal-spacing link)</span>`;
    parts.push(html);
  } else {
    parts.push('<span class="hint" style="margin:0">No instances placed yet — click each one on the photo.</span>');
  }

  if (group.characteristic) {
    const r = characteristicResult(state.session, group, unit);
    const label = tool ? tool.dimension : "size";
    const charView = state.session.views.find((sv) => sv.id === group.characteristic.viewId);
    const fromNote = charView && charView.id !== activeView()?.id ? ` (from ${charView.label})` : "";
    parts.push(`${label}: <b>${r ? r.value : "?"} ${r ? r.unit || "px" : ""}</b>${fromNote}`);
  }

  const anchorX = groupAnchorX(group, view);
  if (anchorX != null && centerX != null && groupCount > 1) {
    const off = computeCenterOffset(anchorX, centerX, pxPerMm, unit);
    const side = off.value === 0 ? "" : off.value > 0 ? " (right of center)" : " (left of center)";
    parts.push(`offset from implement center: <b>${Math.abs(off.value)} ${off.unit || "px"}</b>${side}`);
  }

  if (!pxPerMm) parts.push('<span style="color:var(--danger)">Set the reference scale for real units.</span>');

  return parts.join("<br/>");
}

// ---------- depth positions (side/top views mark where other views' tools sit in depth) ----------

function renderDepthPanel() {
  const v = activeView();
  const panel = document.getElementById("depthPanel");
  if (!v) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  const axis = axisCategoryForRole(v.role);
  const hint = document.getElementById("depthPanelHint");
  if (axis === "depth") {
    hint.textContent = `This view's role is ${ROLE_LABELS[v.role] || v.role}, so its horizontal axis is depth (front-to-back), not left-right. Mark where each tool from other views sits along that axis — this is what lets the 3D render place tools front-to-back correctly.`;
  } else if (v.role === "top") {
    const axisWord = v.topLateralAxis === "y" ? "vertical" : "horizontal";
    hint.textContent = `This view's role is Top, and left-right is set to run ${axisWord} in this photo (change below if that's wrong). Mark where each tool from other views (e.g. one measured in a Side view) sits laterally in this photo. Depth for tools placed here still needs to come from a Side view.`;
  } else {
    hint.textContent = `This view's role is ${ROLE_LABELS[v.role] || v.role}, so its horizontal axis is left-right. Mark where each tool from other views (e.g. one measured in a Side view) sits laterally in this photo.`;
  }

  const topAxisControl = document.getElementById("topAxisControl");
  topAxisControl.innerHTML = "";
  if (v.role === "top") {
    const row = document.createElement("label");
    row.className = "top-axis-row";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.margin = "0 0 10px";
    const span = document.createElement("span");
    span.textContent = "Implement's width runs:";
    const select = document.createElement("select");
    select.innerHTML = `
      <option value="y">Down the photo (implement's length runs across it)</option>
      <option value="x">Across the photo (implement's length runs down it)</option>
    `;
    select.value = v.topLateralAxis === "x" ? "x" : "y";
    select.addEventListener("change", () => {
      v.topLateralAxis = select.value;
      refreshSidebar();
    });
    row.append(span, select);
    topAxisControl.appendChild(row);
  }

  const list = document.getElementById("depthAnchorList");
  list.innerHTML = "";

  if (!v.scale.pixelsPerMm) {
    const warning = document.createElement("p");
    warning.className = "hint depth-scale-warning";
    warning.textContent = '⚠ This view\'s own scale isn\'t set yet ("Set Scale" above). Without it, every point you link here will compute to the same position (0) — set it first.';
    list.appendChild(warning);
  }

  // Scale references: knowing where each view's physical reference sits on the depth
  // axis too (not just its tools) anchors depth to a stable, meaningful landmark instead
  // of an arbitrary midpoint, and shows up in the 3D scatter as its own point.
  const referenceableViews = state.session.views.filter((ov) => ov.id !== v.id && ov.scale.p1 && ov.scale.p2);
  if (referenceableViews.length) {
    const heading = document.createElement("div");
    heading.className = "depth-group-heading";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = "#ffd93d";
    heading.append(swatch, document.createTextNode(" Scale References"));
    list.appendChild(heading);

    for (const ov of referenceableViews) {
      const anchor = v.depthAnchors.find((a) => a.kind === "reference" && a.viewId === ov.id);
      const row = buildDepthRow({
        label: `Reference (${ov.label})`,
        anchor,
        onLink: () => {
          state.depthAnchorTarget = { kind: "reference", viewId: ov.id };
          setMode("depth");
          refreshOverlay();
          refreshSidebar();
        },
      });
      list.appendChild(row);
    }
  }

  const otherGroups = [];
  for (const ov of state.session.views) {
    if (ov.id === v.id) continue;
    for (const g of ov.groups) otherGroups.push({ view: ov, group: g });
  }

  if (!otherGroups.length && !referenceableViews.length) {
    list.innerHTML = '<p class="hint">No tools or scale references in other views yet — add them there first, then come back here to link each point.</p>';
    return;
  }

  for (const { view: ov, group: g } of otherGroups) {
    const tool = getToolType(g.toolTypeId);
    const heading = document.createElement("div");
    heading.className = "depth-group-heading";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = g.color;
    heading.append(swatch, document.createTextNode(` ${g.name} (${ov.label})`));

    // A tool's characteristic size is a single 2-click measurement, not tied to any one
    // view — set it from wherever it's actually visible (a disk's diameter from a Side
    // view, even though the disk itself lives in a Back view). Diameter/length are a
    // hard Side-view-only restriction, same reasoning as lowest point below — only width
    // (visible from several lateral angles) stays offered regardless of the active view.
    // Requires a resolved `tool` (dimension/prompts come from the catalog); lowest point
    // below does not, so it stays offered even for a group whose toolTypeId no longer
    // resolves (e.g. stale/hand-edited data) — matching renderGroups' own version of
    // this button, which is unconditional on `tool` for exactly that reason.
    if (tool) {
      const charAllowed = preferredAxisFor(tool.dimension) !== "depth" || v.role === "side";
      if (charAllowed) {
        if (state.characteristicTarget === g.id) {
          const status = document.createElement("span");
          status.className = "hint";
          status.style.margin = "0 0 0 auto";
          status.textContent = state.characteristicPending
            ? `Click: ${tool.prompts[1]}`
            : `Click: ${tool.prompts[0]}`;
          heading.appendChild(status);
        } else {
          const charBtn = document.createElement("button");
          charBtn.className = "btn";
          charBtn.style.marginLeft = "auto";
          charBtn.textContent = g.characteristic ? `Update ${tool.dimension}` : `Set ${tool.dimension}`;
          charBtn.addEventListener("click", () => {
            state.characteristicTarget = g.id;
            state.characteristicPending = null;
            setMode("characteristic");
            refreshOverlay();
            refreshSidebar();
          });
          heading.appendChild(charBtn);
        }
      }
    }

    // Lowest point is a hard Side-view-only restriction (see renderGroups) — clicking
    // it records the point in whichever view is currently active (`v`), so only offer
    // it here when that active view is actually a Side view, regardless of which view
    // this tool (`g`) natively lives in.
    if (v.role === "side") {
      if (state.depthPointTarget === g.id) {
        const status = document.createElement("span");
        status.className = "hint";
        status.style.margin = "0 0 0 6px";
        status.textContent = "Click lowest point...";
        heading.appendChild(status);
      } else {
        const depthBtn = document.createElement("button");
        depthBtn.className = "btn";
        depthBtn.style.marginLeft = "6px";
        depthBtn.textContent = g.depthPoint ? "Update lowest point" : "Set lowest point";
        depthBtn.addEventListener("click", () => {
          state.depthPointTarget = g.id;
          setMode("depthpoint");
          refreshOverlay();
          refreshSidebar();
        });
        heading.appendChild(depthBtn);
      }
    }
    list.appendChild(heading);

    g.positions.forEach((pt, i) => {
      const anchor = v.depthAnchors.find((a) => a.kind !== "reference" && a.viewId === ov.id && a.groupId === g.id && a.positionIndex === i);
      const spanLabel = tool && tool.instanceMode === "span" ? `Barrel ${Math.floor(i / 2) + 1} ${i % 2 === 0 ? "left" : "right"} edge` : `Point ${i + 1}`;
      const row = buildDepthRow({
        label: spanLabel,
        anchor,
        onLink: () => {
          state.depthAnchorTarget = { kind: "instance", viewId: ov.id, groupId: g.id, positionIndex: i };
          setMode("depth");
          refreshOverlay();
          refreshSidebar();
        },
      });
      list.appendChild(row);
    });
  }
}

function buildDepthRow({ label, anchor, onLink }) {
  const row = document.createElement("div");
  row.className = "depth-anchor-row";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = label;

  const status = document.createElement("span");
  status.className = "status";
  status.textContent = anchor ? "linked" : "not linked";

  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = anchor ? "Update" : "Link";
  btn.addEventListener("click", onLink);

  row.append(name, status, btn);

  if (anchor) {
    const del = document.createElement("button");
    del.className = "btn danger";
    del.textContent = "×";
    del.addEventListener("click", () => {
      const v = activeView();
      v.depthAnchors = v.depthAnchors.filter((a) => a.id !== anchor.id);
      refreshSidebar();
      refreshOverlay();
    });
    row.appendChild(del);
  }

  return row;
}

// ---------- implement summary (across all views) ----------

function renderSummary() {
  const el = document.getElementById("summaryList");
  const byTool = new Map();

  const unit = state.session.displayUnit;
  for (const v of state.session.views) {
    const pxPerMm = v.scale.pixelsPerMm;
    const centerX = computeImplementCenterX(v);
    const corrections = computeEqualSpacingCorrections(v, unit);
    for (const g of v.groups) {
      if (!g.positions.length && !g.characteristic) continue;
      if (!byTool.has(g.toolTypeId)) byTool.set(g.toolTypeId, []);
      const tool = getToolType(g.toolTypeId);
      const row = { viewLabel: v.label, tool };
      if (g.positions.length) {
        if (tool && tool.instanceMode === "span") {
          row.span = computeSpanResult(seriesPoints(v, g.positions), pxPerMm, unit);
        } else {
          const linked = g.positions.some((_, i) => corrections.has(`${g.id}:${i}`));
          if (linked) {
            const offsets = g.positions.map((pt, i) => {
              const key = `${g.id}:${i}`;
              if (corrections.has(key)) return corrections.get(key);
              return centerX != null ? computeCenterOffset(lateralCoordOf(v, pt), centerX, pxPerMm, unit).value : 0;
            });
            row.series = seriesStatsFromOffsets(offsets, unit);
          } else {
            row.series = computeSeriesResult(seriesPoints(v, g.positions), pxPerMm, unit);
          }
        }
      }
      if (g.characteristic) row.characteristic = characteristicResult(state.session, g, unit);
      byTool.get(g.toolTypeId).push(row);
    }
  }

  if (!byTool.size) {
    el.innerHTML = '<p class="hint">Add tools in any view to see a combined profile here.</p>';
    return;
  }

  el.innerHTML = "";
  for (const [toolTypeId, rows] of byTool) {
    const tool = getToolType(toolTypeId);
    const card = document.createElement("div");
    card.className = "group-card";

    const header = document.createElement("div");
    header.className = "group-card-header";
    const iconWrap = document.createElement("span");
    iconWrap.className = "group-card-icon";
    iconWrap.innerHTML = tool ? tool.icon : "";
    const name = document.createElement("strong");
    name.textContent = tool ? tool.name : toolTypeId;
    header.append(iconWrap, name);

    const body = document.createElement("div");
    body.className = "group-results";
    body.innerHTML = rows
      .map((r) => {
        const bits = [];
        if (r.series) {
          const u = r.series.unit || "px";
          bits.push(`count ${r.series.count}, width ${r.series.width} ${u}${r.series.avgGap != null ? `, avg spacing ${r.series.avgGap} ${u}` : ""}`);
        }
        if (r.span) {
          const u = r.span.unit || "px";
          bits.push(`${r.span.count} barrel(s), width ${r.span.barrelWidths.join(", ")} ${u}, total ${r.span.totalWidth} ${u}`);
        }
        if (r.characteristic) {
          bits.push(`${r.tool ? r.tool.dimension : "size"} ${r.characteristic.value} ${r.characteristic.unit || "px"}`);
        }
        return `<div><b>${r.viewLabel}:</b> ${bits.join(" &middot; ")}</div>`;
      })
      .join("");

    card.append(header, body);
    el.appendChild(card);
  }
}

// ---------- quick measurements ----------

function renderQuick() {
  const v = activeView();
  const container = document.getElementById("quickList");
  container.innerHTML = "";
  if (!v) return;
  const unit = state.session.displayUnit;
  const pxPerMm = v.scale.pixelsPerMm;

  if (!v.quickMeasurements.length) {
    container.innerHTML = '<p class="hint">No quick measurements yet.</p>';
    return;
  }

  v.quickMeasurements.forEach((qm, i) => {
    const r = computePairDistance(qm.p1, qm.p2, pxPerMm, unit);
    const row = document.createElement("div");
    row.className = "quick-row";
    row.innerHTML = `<span>#${i + 1}: <b>${r.value} ${r.unit || "px"}</b></span>`;
    const del = document.createElement("button");
    del.className = "btn danger";
    del.textContent = "×";
    del.addEventListener("click", () => {
      v.quickMeasurements.splice(i, 1);
      refreshSidebar();
      refreshOverlay();
    });
    row.appendChild(del);
    container.appendChild(row);
  });
}

// ---------- scale panel status ----------

function renderScaleStatus() {
  const v = activeView();
  const el = document.getElementById("scaleStatus");
  if (!v) {
    el.textContent = "Not set";
    el.style.color = "var(--text-dim)";
    return;
  }
  const s = v.scale;
  if (s.pixelsPerMm) {
    el.textContent = `Set: ${s.knownDistanceValue} ${s.knownDistanceUnit} → ${s.pixelsPerMm.toFixed(3)} px/mm`;
    el.style.color = "var(--text)";
  } else if (s.p1 && s.p2) {
    el.textContent = "Points placed — enter distance and Apply";
    el.style.color = "var(--text-dim)";
  } else if (s.p1) {
    el.textContent = "First point placed — click the second point";
    el.style.color = "var(--text-dim)";
  } else {
    el.textContent = "Not set";
    el.style.color = "var(--text-dim)";
  }
}

// The angle readout is informational only — localAxesOf (measurements.js) projects
// onto the centerline itself, so the correction works at any angle without needing to
// know an "expected" one. It's here so the user can sanity-check their two clicks.
function renderDirectionStatus() {
  const v = activeView();
  const el = document.getElementById("directionStatus");
  const clearBtn = document.getElementById("clearDirectionBtn");
  if (!v) {
    el.textContent = "Not set";
    el.style.color = "var(--text-dim)";
    clearBtn.classList.add("hidden");
    return;
  }
  if (v.centerline) {
    const { hitch, rear } = v.centerline;
    const angleDeg = (Math.atan2(rear.y - hitch.y, rear.x - hitch.x) * 180) / Math.PI;
    const fromHorizontal = Math.abs(((Math.abs(angleDeg) + 90) % 180) - 90);
    el.textContent = `Set — ${fromHorizontal.toFixed(1)}° from horizontal`;
    el.style.color = "var(--text)";
    clearBtn.classList.remove("hidden");
  } else if (state.mode === "centerline" && state.centerlinePending) {
    el.textContent = "Hitch placed — click the farthest-back point on the implement's centerline";
    el.style.color = "var(--text-dim)";
    clearBtn.classList.add("hidden");
  } else {
    el.textContent = "Not set";
    el.style.color = "var(--text-dim)";
    clearBtn.classList.add("hidden");
  }
}

// ---------- overlay building ----------

function refreshOverlay() {
  const v = activeView();
  const markers = [];
  const lines = [];
  if (!v) {
    view.setOverlay(markers, lines);
    return;
  }
  const s = v.scale;

  if (s.p1) markers.push({ x: s.p1.x, y: s.p1.y, color: "#ffd93d", label: "1", ref: { kind: "scale", which: "p1" } });
  if (s.p2) markers.push({ x: s.p2.x, y: s.p2.y, color: "#ffd93d", label: "2", ref: { kind: "scale", which: "p2" } });
  if (s.p1 && s.p2) lines.push({ p1: s.p1, p2: s.p2, color: "#ffd93d", dashed: true });

  if (v.centerline) {
    const { hitch, rear } = v.centerline;
    markers.push({ x: hitch.x, y: hitch.y, color: "#ff3fa4", label: "H", ref: { kind: "centerline", which: "hitch" } });
    markers.push({ x: rear.x, y: rear.y, color: "#ff3fa4", label: "R", ref: { kind: "centerline", which: "rear" } });
    lines.push({ p1: hitch, p2: rear, color: "#ff3fa4", dashed: true });
  } else if (state.mode === "centerline" && state.centerlinePending) {
    markers.push({ x: state.centerlinePending.x, y: state.centerlinePending.y, color: "#ff3fa4", label: "H" });
  }

  for (const group of v.groups) {
    group.positions.forEach((pt, i) => {
      markers.push({ x: pt.x, y: pt.y, color: group.color, label: String(i + 1), ref: { kind: "group", groupId: group.id, index: i } });
    });
  }

  if (state.spanPending) {
    const activeGroup = v.groups.find((g) => g.id === state.activeGroupId);
    markers.push({ x: state.spanPending.x, y: state.spanPending.y, color: activeGroup ? activeGroup.color : "#9aa3b2", label: "L" });
  }

  // A characteristic's markers only belong on whichever view it was actually measured
  // in — which may not be the group's own native view (a disk's diameter set from a
  // Side view, say) — so check every group in the session, not just this view's own.
  for (const ov of state.session.views) {
    for (const group of ov.groups) {
      if (group.characteristic && (group.characteristic.viewId || ov.id) === v.id) {
        const { p1, p2 } = group.characteristic;
        markers.push({ x: p1.x, y: p1.y, color: group.color, label: "A", ref: { kind: "characteristic", groupId: group.id, which: "p1" } });
        markers.push({ x: p2.x, y: p2.y, color: group.color, label: "B", ref: { kind: "characteristic", groupId: group.id, which: "p2" } });
        lines.push({ p1, p2, color: group.color, dashed: true });
      }
    }
  }
  if (state.characteristicTarget && state.characteristicPending) {
    const targetGroup = findGroupById(state.characteristicTarget);
    if (targetGroup) markers.push({ x: state.characteristicPending.x, y: state.characteristicPending.y, color: targetGroup.color, label: "A" });
  }

  // A depthPoint's marker only belongs on whichever view it was actually clicked in —
  // same cross-view rule as characteristic markers above. If THIS view has since lost
  // its scale (e.g. "Reset scale points"), buildToolDepthProfile silently excludes
  // every depthPoint recorded here from the profile/export — flag that on the marker
  // itself (danger color, "!" label) instead of leaving it looking perfectly normal
  // and active while it's actually gone inert.
  const scaleless = !v.scale.pixelsPerMm;
  for (const ov of state.session.views) {
    for (const group of ov.groups) {
      if (group.depthPoint && group.depthPoint.viewId === v.id) {
        markers.push({
          x: group.depthPoint.x, y: group.depthPoint.y,
          color: scaleless ? "#ff5c5c" : group.color,
          label: scaleless ? "D!" : "D",
          ref: { kind: "depthpoint", groupId: group.id },
        });
      }
    }
  }

  for (const qm of v.quickMeasurements) {
    markers.push({ x: qm.p1.x, y: qm.p1.y, color: "#ff9f43", ref: { kind: "quick", id: qm.id, which: "p1" } });
    markers.push({ x: qm.p2.x, y: qm.p2.y, color: "#ff9f43", ref: { kind: "quick", id: qm.id, which: "p2" } });
    lines.push({ p1: qm.p1, p2: qm.p2, color: "#ff9f43" });
  }

  if (state.quickPending) {
    markers.push({ x: state.quickPending.x, y: state.quickPending.y, color: "#ff9f43" });
  }

  for (const anchor of v.depthAnchors) {
    if (anchor.kind === "reference") {
      markers.push({ x: anchor.x, y: anchor.y, color: "#ffd93d", label: "R", ref: { kind: "depth", id: anchor.id } });
      continue;
    }
    const sourceView = state.session.views.find((sv) => sv.id === anchor.viewId);
    const sourceGroup = sourceView && sourceView.groups.find((g) => g.id === anchor.groupId);
    markers.push({
      x: anchor.x,
      y: anchor.y,
      color: sourceGroup ? sourceGroup.color : "#9aa3b2",
      label: String(anchor.positionIndex + 1),
      ref: { kind: "depth", id: anchor.id },
    });
  }

  view.setOverlay(markers, lines);
}

function refreshSidebar() {
  renderScaleStatus();
  renderDirectionStatus();
  renderScaleRefOptions();
  renderGroups();
  renderDepthPanel();
  updateLinkingBanner();
  renderSummary();
  renderQuick();
}

function syncSessionFieldsToUI() {
  const v = activeView();
  document.getElementById("sessionName").value = state.session.name;
  document.getElementById("sessionNotes").value = state.session.notes;
  document.getElementById("displayUnit").value = state.session.displayUnit;
  document.getElementById("knownDistanceValue").value = "";
  document.getElementById("knownDistanceUnit").value = v ? v.scale.knownDistanceUnit : "cm";
  renderViewsBar();
  refreshSidebar();
}

document.getElementById("sessionName").addEventListener("input", (e) => (state.session.name = e.target.value));
document.getElementById("sessionNotes").addEventListener("input", (e) => (state.session.notes = e.target.value));

// ---------- save / export ----------

document.getElementById("saveBtn").addEventListener("click", async () => {
  if (!state.session.views.length) {
    alert("Load a photo before saving.");
    return;
  }
  state.session.updatedAt = Date.now();
  await storage.saveSession(state.session);
  alert("Tool profile saved.");
});

document.getElementById("exportJsonBtn").addEventListener("click", async () => {
  if (!state.session.views.length) return alert("Load a photo first.");
  await exportSessionJSON(state.session);
});

document.getElementById("exportCsvBtn").addEventListener("click", () => {
  if (!state.session.views.length) return alert("Load a photo first.");
  exportSessionCSV(state.session);
});

document.getElementById("exportPngBtn").addEventListener("click", () => {
  const v = activeView();
  if (!state.image || !v) return alert("Load a photo first.");
  const markers = [];
  const lines = [];
  const s = v.scale;
  if (s.p1 && s.p2) lines.push({ p1: s.p1, p2: s.p2, color: "#ffd93d" });
  for (const group of v.groups) {
    group.positions.forEach((pt) => markers.push({ x: pt.x, y: pt.y, color: group.color }));
    if (group.characteristic) {
      markers.push({ x: group.characteristic.p1.x, y: group.characteristic.p1.y, color: group.color });
      markers.push({ x: group.characteristic.p2.x, y: group.characteristic.p2.y, color: group.color });
      lines.push({ p1: group.characteristic.p1, p2: group.characteristic.p2, color: group.color });
    }
  }
  for (const qm of v.quickMeasurements) {
    markers.push({ x: qm.p1.x, y: qm.p1.y, color: "#ff9f43" });
    markers.push({ x: qm.p2.x, y: qm.p2.y, color: "#ff9f43" });
    lines.push({ p1: qm.p1, p2: qm.p2, color: "#ff9f43" });
  }
  exportAnnotatedPNG(state.session, v, state.image, markers, lines);
});

// ---------- render (3D scatter + flat schematic) ----------

const renderModal = document.getElementById("renderModal");
let currentSchematicSvg = null;
let currentProfileSvg = null;
let currentRenderTab = "scatter";
let currentProfileResult = null;
let scatter3d = null;
// Per-tool "Show in diagram" toggles — a view-only convenience for isolating one or a
// few tools at a time when several overlap and are hard to tell apart, so it's kept as
// session-only UI state (group ids), not saved with the profile.
const profileHiddenLaneIds = new Set();

function setRenderTab(tab) {
  currentRenderTab = tab;
  document.querySelectorAll(".render-tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.renderTab === tab));
  document.getElementById("scatterTab").classList.toggle("hidden", tab !== "scatter");
  document.getElementById("schematicTab").classList.toggle("hidden", tab !== "schematic");
  document.getElementById("profileTab").classList.toggle("hidden", tab !== "profile");
  // SVG download only makes sense for the two vector tabs; PNG works for all three
  // (the scatter tab's own handler below rasterizes the WebGL/canvas view instead).
  document.getElementById("downloadRenderSvgBtn").style.display = tab === "schematic" || tab === "profile" ? "" : "none";
  document.getElementById("downloadRenderPngBtn").style.display = "";
  if (tab === "scatter" && scatter3d) scatter3d.render();
}

document.querySelectorAll(".render-tab-btn").forEach((b) => b.addEventListener("click", () => setRenderTab(b.dataset.renderTab)));

// Rebuilds every render tab from current measurements. `openModal` is only true for the
// initial "Render Implement" click — table edits in the Profile tab (tillage type/soil
// inversion/full width overrides) call this again to refresh without resetting which
// tab is showing or re-opening the modal.
function runRender({ openModal = false } = {}) {
  const schematicResult = buildImplementRender(state.session);
  const holder = document.getElementById("renderSvgHolder");
  const unplacedEl = document.getElementById("renderUnplaced");
  holder.innerHTML = "";
  unplacedEl.innerHTML = "";
  currentSchematicSvg = null;

  if (schematicResult) {
    currentSchematicSvg = schematicResult.svg;
    holder.appendChild(schematicResult.svg);
    if (schematicResult.unplaced.length) {
      unplacedEl.innerHTML =
        "<strong>Also measured, no spatial position (closeups):</strong>" +
        schematicResult.unplaced
          .map((u) => `<div class="unplaced-item">${u.tool ? u.tool.name : u.group.name} (${u.view.label})</div>`)
          .join("");
    }
  } else {
    holder.innerHTML = '<p class="hint">Nothing measured yet.</p>';
  }

  const scatterData = buildScatterPoints(state.session);
  const profileResult = buildToolDepthProfile(state.session, state.session.profileUnit || state.session.displayUnit);
  if (openModal && !scatterData.points.length && !schematicResult && !profileResult.lanes.length) {
    alert("Add at least one tool with instances placed, or a \"lowest point\" set (in any view), before rendering.");
    return;
  }

  if (openModal) {
    renderModal.classList.remove("hidden");
    setRenderTab("scatter");
  }

  if (!scatter3d) scatter3d = new Scatter3D(document.getElementById("scatterCanvas"));
  scatter3d.setPoints(scatterData.points);

  const legendEl = document.getElementById("scatterLegend");
  legendEl.innerHTML =
    scatterData.legend
      .map((l) => `<span class="legend-item"><span class="legend-dot" style="background:${l.color}"></span>${l.name}</span>`)
      .join("") || '<span class="hint">No tools measured yet.</span>';

  const unscaled = findUnscaledDepthViews(state.session);
  const warningEl = document.getElementById("scatterScaleWarning");
  if (unscaled.length) {
    warningEl.textContent = `⚠ "${unscaled.map((v) => v.label).join('", "')}" has depth points linked but no scale of its own set — those points computed to Z=0 instead of a real depth. Set that view's scale to fix this.`;
    warningEl.classList.remove("hidden");
  } else {
    warningEl.classList.add("hidden");
  }

  const unscaledLowest = findUnscaledLowestPointViews(state.session);
  const profileWarningEl = document.getElementById("profileUnscaledHint");
  if (unscaledLowest.length) {
    profileWarningEl.textContent = `⚠ "${unscaledLowest.map((v) => v.label).join('", "')}" has a "lowest point" set but no scale of its own — that view is being skipped here entirely until its scale is set.`;
    profileWarningEl.classList.remove("hidden");
  } else {
    profileWarningEl.classList.add("hidden");
  }

  const crossViewHintEl = document.getElementById("profileDominantCrossViewHint");
  if (profileResult.dominantSpansUnreferencedViews) {
    crossViewHintEl.textContent = '⚠ No Side view has a Gauge/Leveling Wheel measured, and the deepest tool was picked by comparing depths across different Side views — each was only measured relative to its own shallowest tool, so this comparison isn\'t on a real shared scale. Set a gauge wheel in at least one view, or double-check the dominant tool by eye.';
    crossViewHintEl.classList.remove("hidden");
  } else {
    crossViewHintEl.classList.add("hidden");
  }

  currentProfileResult = profileResult;
  renderProfileTab(currentProfileResult);
}

document.getElementById("renderBtn").addEventListener("click", () => runRender({ openModal: true }));

// `skipInputValues` is set by the per-row "Show" checkbox's lightweight re-render —
// clicking a checkbox necessarily moves focus onto it first, so an activeElement
// check can't tell "user mid-edit" from "user clicked elsewhere" at the point this
// runs; skipping the two free-text fields entirely on that specific path is what
// actually prevents wiping an in-progress, not-yet-Applied edit (everything else —
// labels, notes, the diagram, the table — still refreshes normally).
function renderProfileTab(profileResult, { skipInputValues = false } = {}) {
  const holder = document.getElementById("profileTableHolder");
  const crossSectionHolder = document.getElementById("profileCrossSectionHolder");
  const noData = document.getElementById("profileNoDataHint");
  const depthRow = document.getElementById("implementDepthRow");
  const bedWidthRow = document.getElementById("bedWidthRow");
  holder.innerHTML = "";
  crossSectionHolder.innerHTML = "";
  currentProfileSvg = null;
  document.getElementById("profileUnitSelect").value = profileResult ? profileResult.unit : state.session.displayUnit;
  if (!profileResult || !profileResult.lanes.length || !profileResult.dominant) {
    noData.classList.remove("hidden");
    depthRow.classList.add("hidden");
    bedWidthRow.classList.add("hidden");
    return;
  }
  noData.classList.add("hidden");
  const unit = profileResult.unit;

  depthRow.classList.remove("hidden");
  const implementDepthInput = document.getElementById("implementDepthInput");
  if (!skipInputValues) implementDepthInput.value = profileResult.dominant.depth;
  document.getElementById("implementDepthUnit").textContent = unit;
  document.getElementById("resetImplementDepthBtn").classList.toggle("hidden", !profileResult.depthOverrideApplied);
  const measuredNote = document.getElementById("implementDepthMeasuredNote");
  measuredNote.textContent = profileResult.depthOverrideApplied
    ? `measured from photos: ${profileResult.measuredDominantDepth} ${unit}`
    : "";

  bedWidthRow.classList.remove("hidden");
  const bedWidthOverride = state.session.profileBedWidthOverride;
  // Must match buildTillageCrossSectionSvg's own acceptance check (render.js) exactly
  // — otherwise a value the UI treats as "active" (hiding the measured note, showing
  // Reset) can be one the renderer silently rejects and falls back from, leaving the
  // field and the actual diagram/export disagreeing with no indication why.
  const overrideAsNumber = Number(bedWidthOverride);
  const hasBedWidthOverride = bedWidthOverride != null && bedWidthOverride !== "" && Number.isFinite(overrideAsNumber) && overrideAsNumber > 0;
  const bedWidthInput = document.getElementById("bedWidthInput");
  document.getElementById("bedWidthUnit").textContent = unit;
  document.getElementById("resetBedWidthBtn").classList.toggle("hidden", !hasBedWidthOverride);
  // Always reflect an active override in the field itself — mirrors how the Depth
  // field above always shows its effective value — set here (not just in the
  // `!hasBedWidthOverride` branch below) so it's never left blank, which previously
  // made clicking Apply without noticing silently wipe a saved override back to null.
  if (hasBedWidthOverride && !skipInputValues) bedWidthInput.value = round(overrideAsNumber);

  const crossSection = buildTillageCrossSectionSvg(profileResult, { bedWidthOverride, hiddenLaneIds: profileHiddenLaneIds });
  if (crossSection) {
    currentProfileSvg = crossSection.svg;
    crossSectionHolder.appendChild(crossSection.svg);
    if (!hasBedWidthOverride && !skipInputValues) bedWidthInput.value = round(crossSection.measuredBedWidth);
    document.getElementById("bedWidthMeasuredNote").textContent = hasBedWidthOverride
      ? `measured from photos: ${round(crossSection.measuredBedWidth)} ${unit}`
      : "";
  } else {
    crossSectionHolder.innerHTML = '<p class="hint">Every tool is hidden — check at least one "Show" box below to see the diagram.</p>';
    document.getElementById("bedWidthMeasuredNote").textContent = "";
  }

  const table = document.createElement("table");
  table.className = "profile-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th>Show</th><th>Tool</th><th>View</th><th>Depth</th><th>Width / Spacing</th><th>Full width</th><th>Tillage type</th><th>Soil inversion</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");

  const sorted = [...profileResult.lanes].sort((a, b) => b.depth - a.depth);
  for (const lane of sorted) {
    const tr = document.createElement("tr");
    if (lane === profileResult.dominant) tr.classList.add("dominant-row");

    const showTd = document.createElement("td");
    const showCheckbox = document.createElement("input");
    showCheckbox.type = "checkbox";
    showCheckbox.checked = !profileHiddenLaneIds.has(lane.group.id);
    showCheckbox.title = "Show or hide this tool in the diagram above (doesn't affect the table or export)";
    showCheckbox.addEventListener("change", (e) => {
      if (e.target.checked) profileHiddenLaneIds.delete(lane.group.id);
      else profileHiddenLaneIds.add(lane.group.id);
      renderProfileTab(currentProfileResult, { skipInputValues: true });
    });
    showTd.appendChild(showCheckbox);
    tr.appendChild(showTd);

    const toolTd = document.createElement("td");
    toolTd.innerHTML = `<span class="tool-swatch" style="background:${lane.group.color}"></span>${lane.group.name}`;
    tr.appendChild(toolTd);

    const viewTd = document.createElement("td");
    viewTd.textContent = lane.view.label;
    tr.appendChild(viewTd);

    // Depth is NOT editable per tool here — the relative depth between tools is real
    // measured geometry (that's the entire point of setting each one's lowest point);
    // only the implement's overall depth (below) is meant to be adjusted, and it shifts
    // every lane together so this relative structure never changes.
    const depthTd = document.createElement("td");
    depthTd.innerHTML = `${lane.depth} ${unit}` + (lane.hasAbsoluteReference ? "" : '<span class="relative-note">relative — no gauge wheel in this view</span>');
    tr.appendChild(depthTd);

    const widthTd = document.createElement("td");
    const w = lane.widthStats;
    if (w && lane.tool.instanceMode === "span" && w.totalWidth != null) {
      widthTd.textContent = `${w.totalWidth} ${unit} total`;
    } else if (w && w.width) {
      widthTd.textContent = `${w.width} ${unit}${w.avgGap != null ? `, ${w.avgGap} ${unit} spacing` : ""}`;
    } else {
      widthTd.textContent = "—";
    }
    tr.appendChild(widthTd);

    const fullWidthTd = document.createElement("td");
    const fwCheckbox = document.createElement("input");
    fwCheckbox.type = "checkbox";
    fwCheckbox.checked = lane.fullWidth;
    fwCheckbox.addEventListener("change", (e) => {
      lane.group.profileOverride = lane.group.profileOverride || {};
      lane.group.profileOverride.fullWidth = e.target.checked;
      runRender();
    });
    fullWidthTd.appendChild(fwCheckbox);
    tr.appendChild(fullWidthTd);

    const tillageTd = document.createElement("td");
    const select = document.createElement("select");
    for (const t of TILLAGE_TYPES) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t.replace(/_/g, " ");
      select.appendChild(opt);
    }
    select.value = lane.tillageType || TILLAGE_TYPES[0];
    select.addEventListener("change", (e) => {
      lane.group.profileOverride = lane.group.profileOverride || {};
      lane.group.profileOverride.tillageType = e.target.value;
      runRender();
    });
    tillageTd.appendChild(select);
    tr.appendChild(tillageTd);

    const inversionTd = document.createElement("td");
    const invCheckbox = document.createElement("input");
    invCheckbox.type = "checkbox";
    invCheckbox.checked = lane.soilInversion;
    invCheckbox.addEventListener("change", (e) => {
      lane.group.profileOverride = lane.group.profileOverride || {};
      lane.group.profileOverride.soilInversion = e.target.checked;
      runRender();
    });
    inversionTd.appendChild(invCheckbox);
    tr.appendChild(inversionTd);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  holder.appendChild(table);
}

// Every other measured tool + its own depth, as a readable summary — the OFE tool's
// schema has no room for per-component granularity, so it goes in the one free-text
// field instead of being lost entirely.
function buildTillageNotes(profileResult) {
  const unit = profileResult.unit;
  const lines = [...profileResult.lanes]
    .sort((a, b) => b.depth - a.depth)
    .map((l) => {
      const bits = [`${l.group.name} (${l.view.label}): depth ${l.depth} ${unit}`];
      if (l === profileResult.dominant) bits.push("dominant/exported");
      if (!l.hasAbsoluteReference) bits.push("relative depth, no gauge wheel");
      return bits.join(" — ");
    });
  return `Generated by Machinery Image Processor from measured tool depths:\n${lines.join("\n")}`;
}

function buildTillageInputFromLane(lane, profileResult) {
  const unit = profileResult.unit;
  const isSpan = lane.tool.instanceMode === "span";
  const w = lane.widthStats;
  return {
    tillageType: lane.tillageType,
    fullWidth: lane.fullWidth,
    depth: { value: lane.depth, unit },
    stripWidth: isSpan && w && w.totalWidth != null ? { value: w.totalWidth, unit } : null,
    offsetFromLeft: null,
    patternSpacing: !isSpan && w && w.avgGap != null ? { value: w.avgGap, unit } : null,
    soilInversion: lane.soilInversion,
    daysBeforeMainCrop: 0,
    notes: buildTillageNotes(profileResult),
  };
}

document.getElementById("applyImplementDepthBtn").addEventListener("click", () => {
  const raw = document.getElementById("implementDepthInput").value;
  state.session.profileDepthOverride = raw === "" ? null : raw;
  runRender();
});
document.getElementById("resetImplementDepthBtn").addEventListener("click", () => {
  state.session.profileDepthOverride = null;
  runRender();
});

// Changing the Profile tab's own unit re-derives depth/width/bed-width from the
// underlying pixel measurements in the new unit — it does NOT convert whatever
// numbers are currently sitting in the override fields, since those are independent,
// user-stated values (an overall depth typed in cm doesn't become that same number in
// inches) — so switching units clears both overrides rather than silently
// misinterpreting them.
document.getElementById("profileUnitSelect").addEventListener("change", (e) => {
  state.session.profileUnit = e.target.value;
  state.session.profileDepthOverride = null;
  state.session.profileBedWidthOverride = null;
  runRender();
});

document.getElementById("applyBedWidthBtn").addEventListener("click", () => {
  const raw = document.getElementById("bedWidthInput").value;
  state.session.profileBedWidthOverride = raw === "" ? null : raw;
  runRender();
});
document.getElementById("resetBedWidthBtn").addEventListener("click", () => {
  state.session.profileBedWidthOverride = null;
  runRender();
});

document.getElementById("exportTillageJsonBtn").addEventListener("click", () => {
  if (!currentProfileResult || !currentProfileResult.dominant) {
    alert('No tool has a "lowest point" set yet — set at least one (ideally from a Side view) before exporting.');
    return;
  }
  const tillageInput = buildTillageInputFromLane(currentProfileResult.dominant, currentProfileResult);
  const blob = new Blob([JSON.stringify([tillageInput], null, 2)], { type: "application/json" });
  download(blob, `${state.session.name || "tool-profile"}-tillage-pass.json`);
});

document.getElementById("closeRenderBtn").addEventListener("click", () => renderModal.classList.add("hidden"));
document.getElementById("scatterRotateLeftBtn").addEventListener("click", () => scatter3d && scatter3d.rotateBy(-0.3));
document.getElementById("scatterRotateRightBtn").addEventListener("click", () => scatter3d && scatter3d.rotateBy(0.3));
document.getElementById("scatterResetBtn").addEventListener("click", () => scatter3d && scatter3d.resetView());

function activeRenderSvg() {
  return currentRenderTab === "profile" ? currentProfileSvg : currentSchematicSvg;
}

document.getElementById("downloadRenderSvgBtn").addEventListener("click", () => {
  const svg = activeRenderSvg();
  const suffix = currentRenderTab === "profile" ? "-cross-section" : "";
  if (svg) downloadSvg(svg, `${state.session.name || "implement"}${suffix}.svg`);
});
document.getElementById("downloadRenderPngBtn").addEventListener("click", () => {
  if (currentRenderTab === "scatter") {
    const canvas = document.getElementById("scatterCanvas");
    canvas.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${state.session.name || "implement"}-3d.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  } else {
    const svg = activeRenderSvg();
    const suffix = currentRenderTab === "profile" ? "-cross-section" : "";
    if (svg) downloadSvgAsPng(svg, `${state.session.name || "implement"}${suffix}.png`);
  }
});

// ---------- history modal ----------

const historyModal = document.getElementById("historyModal");
document.getElementById("historyBtn").addEventListener("click", async () => {
  await renderHistory();
  historyModal.classList.remove("hidden");
});
document.getElementById("closeHistoryBtn").addEventListener("click", () => historyModal.classList.add("hidden"));

async function renderHistory() {
  const list = document.getElementById("historyList");
  list.innerHTML = "Loading...";
  const sessions = await storage.listSessions();
  if (!sessions.length) {
    list.innerHTML = '<p class="hint">No saved tool profiles yet.</p>';
    return;
  }
  list.innerHTML = "";
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "history-item";
    const info = document.createElement("div");
    info.className = "history-item-info";
    const viewCount = s.views ? s.views.length : 0;
    info.innerHTML = `<span class="name">${s.name || "(untitled)"}</span><span class="date">${viewCount} view(s) &middot; ${new Date(s.updatedAt).toLocaleString()}</span>`;
    const actions = document.createElement("div");
    actions.className = "btn-row";
    const loadBtn = document.createElement("button");
    loadBtn.className = "btn";
    loadBtn.textContent = "Load";
    loadBtn.addEventListener("click", () => loadSessionIntoApp(s));
    const delBtn = document.createElement("button");
    delBtn.className = "btn danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete "${s.name || "(untitled)"}"? This cannot be undone.`)) return;
      await storage.deleteSession(s.id);
      renderHistory();
    });
    actions.append(loadBtn, delBtn);
    item.append(info, actions);
    list.appendChild(item);
  }
}

async function loadSessionIntoApp(session) {
  if (session.profileDepthOverride === undefined) session.profileDepthOverride = null;
  if (session.profileUnit === undefined) session.profileUnit = null;
  if (session.profileBedWidthOverride === undefined) session.profileBedWidthOverride = null;
  for (const v of session.views) {
    if (!v.role) v.role = "other";
    if (!v.depthAnchors) v.depthAnchors = [];
    if (!v.equalSpacingGroups) v.equalSpacingGroups = {};
    if (v.role === "top" && v.topLateralAxis !== "x" && v.topLateralAxis !== "y") v.topLateralAxis = "y";
    if (v.centerline === undefined) v.centerline = null;
    for (const g of v.groups) {
      if (g.depthPoint === undefined) g.depthPoint = null;
      if (g.profileOverride === undefined) g.profileOverride = null;
    }
  }
  state.session = session;
  resetInteractionState();
  const firstViewId = session.activeViewId && session.views.some((v) => v.id === session.activeViewId)
    ? session.activeViewId
    : session.views[0]?.id;
  syncSessionFieldsToUI();
  if (firstViewId) {
    await switchView(firstViewId);
  } else {
    state.image = null;
    view.image = null;
    view.render();
    emptyState.style.display = "flex";
  }
  historyModal.classList.add("hidden");
}
