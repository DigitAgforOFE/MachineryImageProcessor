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
} from "./measurements.js";
import { exportSessionJSON, exportSessionCSV, exportAnnotatedPNG } from "./export.js";
import { TOOL_TYPES, TOOL_CATEGORIES, getToolType, preferredAxisFor } from "./toolCatalog.js";
import { buildImplementRender, buildScatterPoints, findUnscaledDepthViews, downloadSvg, downloadSvgAsPng } from "./render.js";
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
    topLateralAxis: "y", // 'top' only: which pixel axis is left-right in this photo — 'y' if the implement's length runs across the frame, 'x' if it runs down it
    imageBlob: null,
    imageWidth: 0,
    imageHeight: 0,
    thumbnail: null,
    scale: { p1: null, p2: null, knownDistanceValue: null, knownDistanceUnit: "cm", pixelsPerMm: null },
    groups: [], // {id, toolTypeId, name, color, positions: [{x,y}], characteristic: {p1,p2}|null}
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
    // face-on — so search every view, not just this one.
    const group = findGroupById(state.characteristicTarget);
    if (!group) return;
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
  } else if (ref.kind === "group") {
    const group = v.groups.find((g) => g.id === ref.groupId);
    if (group) group.positions[ref.index] = imgPt;
  } else if (ref.kind === "characteristic") {
    const group = findGroupById(ref.groupId);
    if (group && group.characteristic) group.characteristic[ref.which] = imgPt;
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

document.getElementById("displayUnit").addEventListener("change", (e) => {
  state.session.displayUnit = e.target.value;
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
      if (state.activeGroupId === group.id) state.activeGroupId = null;
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

    const charRow = document.createElement("div");
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
    let mismatchHint = null;
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

    card.append(header, chips);
    if (equalRow) card.appendChild(equalRow);
    card.append(results, charRow);
    if (mismatchHint) card.appendChild(mismatchHint);
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
    // view, even though the disk itself lives in a Back view).
    if (tool) {
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
let currentRenderSvg = null;
let currentRenderTab = "scatter";
let scatter3d = null;

function setRenderTab(tab) {
  currentRenderTab = tab;
  document.querySelectorAll(".render-tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.renderTab === tab));
  document.getElementById("scatterTab").classList.toggle("hidden", tab !== "scatter");
  document.getElementById("schematicTab").classList.toggle("hidden", tab !== "schematic");
  document.getElementById("downloadRenderSvgBtn").style.display = tab === "schematic" ? "" : "none";
  if (tab === "scatter" && scatter3d) scatter3d.render();
}

document.querySelectorAll(".render-tab-btn").forEach((b) => b.addEventListener("click", () => setRenderTab(b.dataset.renderTab)));

document.getElementById("renderBtn").addEventListener("click", () => {
  const schematicResult = buildImplementRender(state.session);
  const holder = document.getElementById("renderSvgHolder");
  const unplacedEl = document.getElementById("renderUnplaced");
  holder.innerHTML = "";
  unplacedEl.innerHTML = "";
  currentRenderSvg = null;

  if (schematicResult) {
    currentRenderSvg = schematicResult.svg;
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
  if (!scatterData.points.length && !schematicResult) {
    alert("Add at least one tool with instances placed (in any view) before rendering.");
    return;
  }

  renderModal.classList.remove("hidden");
  setRenderTab("scatter");

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
});

document.getElementById("closeRenderBtn").addEventListener("click", () => renderModal.classList.add("hidden"));
document.getElementById("scatterRotateLeftBtn").addEventListener("click", () => scatter3d && scatter3d.rotateBy(-0.3));
document.getElementById("scatterRotateRightBtn").addEventListener("click", () => scatter3d && scatter3d.rotateBy(0.3));
document.getElementById("scatterResetBtn").addEventListener("click", () => scatter3d && scatter3d.resetView());

document.getElementById("downloadRenderSvgBtn").addEventListener("click", () => {
  if (currentRenderSvg) downloadSvg(currentRenderSvg, `${state.session.name || "implement"}.svg`);
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
  } else if (currentRenderSvg) {
    downloadSvgAsPng(currentRenderSvg, `${state.session.name || "implement"}.png`);
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
  for (const v of session.views) {
    if (!v.role) v.role = "other";
    if (!v.depthAnchors) v.depthAnchors = [];
    if (!v.equalSpacingGroups) v.equalSpacingGroups = {};
    if (v.role === "top" && v.topLateralAxis !== "x" && v.topLateralAxis !== "y") v.topLateralAxis = "y";
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
