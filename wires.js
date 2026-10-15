// Circuit Sketcher: routed wires, editable nodes, and branch junctions.
// Loaded after app.js.

const SNAP_RADIUS = 12;
const START_CLICK = 10;
const AXIS_SNAP_PIXELS = 10;
const DEFAULT_WIRE_COLOR = '#2f6fb0';
const wires = []; // endpoints are pin nodes or {kind:'junction', wireId, nodeId}
window.wires = wires;
let draft = null;
let hoverWire = null, pinnedWire = null, hideTimer = null;
let nextWireId = 0;
const wireColorInput = document.getElementById('wire-color-input');

let activeWireColorPreference = null;
const wireQuickSwatches = document.getElementById('wire-quick-swatches');

function getPinAttrs(endpoint) {
  if (!endpoint || isJunctionEndpoint(endpoint)) return null;
  const pinId = String(endpoint.getAttr('pinId') || '').toLowerCase();
  const label = String(endpoint.getAttr('pinLabel') || '').toLowerCase();
  const type = String(endpoint.getAttr('pinType') || '').toLowerCase();
  return { pinId, label, type, endpoint };
}

function resolveStandardWireColor(from, to) {
  // If either endpoint is a junction, inherit parent wire's color
  if (isJunctionEndpoint(from)) {
    const parent = getWire(from.wireId);
    if (parent?.color) return parent.color;
  }
  if (isJunctionEndpoint(to)) {
    const parent = getWire(to.wireId);
    if (parent?.color) return parent.color;
  }

  const p1 = getPinAttrs(from);
  const p2 = getPinAttrs(to);
  const pins = [p1, p2].filter(Boolean);
  if (!pins.length) return DEFAULT_WIRE_COLOR;

  // 1. Ground Net: Black / Dark Slate #1e293b
  const isGround = (p) => p.type === 'ground' || 
    p.label.includes('gnd') || p.label.includes('ground') || p.label === '-' || p.label.startsWith('-') ||
    p.pinId.includes('gnd') || p.pinId === '-' || p.pinId === 'b-' || p.pinId === 'out-';
  if (pins.some(isGround)) return '#1e293b';

  // 2. 3.3V Logic / Rail: Orange #f97316
  const is3V3 = (p) => p.label.includes('3v3') || p.label.includes('3.3') || 
    p.pinId.includes('3v3') || p.pinId.includes('3.3');
  if (pins.some(is3V3)) return '#f97316';

  // 3. 5V / Main Positive Power: Red #ef4444
  const is5V = (p) => p.type === 'power' || 
    p.label.includes('5v') || p.label.includes('vcc') || p.label.includes('vin') || 
    p.label.includes('v+') || p.label.includes('vm') || p.label.includes('out+') || p.label.includes('b+') ||
    p.label === '+' || p.label.startsWith('+') ||
    p.pinId.includes('vcc') || p.pinId.includes('5v') || p.pinId.includes('vin') || p.pinId.includes('v+');
  if (pins.some(is5V)) return '#ef4444';

  // 4. High Voltage Battery (+9V / +12V): Crimson #dc2626
  const isHV = (p) => p.label.includes('9v') || p.pinId.includes('9v');
  if (pins.some(isHV)) return '#dc2626';

  // 5. I2C Clock / Serial Clock: Yellow #eab308
  const isClock = (p) => p.label.includes('scl') || p.label.includes('clk') || p.label.includes('sck') ||
    p.pinId.includes('scl') || p.pinId.includes('clk');
  if (pins.some(isClock)) return '#eab308';

  // 6. I2C Data / SPI MOSI/MISO: Green #22c55e
  const isData = (p) => p.type === 'data' || p.label.includes('sda') || p.label.includes('mosi') || p.label.includes('miso') ||
    p.pinId.includes('sda') || p.pinId.includes('mosi') || p.pinId.includes('miso');
  if (pins.some(isData)) return '#22c55e';

  // 7. Serial UART: Cyan #06b6d4
  const isSerial = (p) => p.label.includes('tx') || p.label.includes('rx') || 
    p.pinId.includes('tx') || p.pinId.includes('rx');
  if (pins.some(isSerial)) return '#06b6d4';

  // 8. Control / Analog / General Signal: Electric Blue #3b82f6
  return '#3b82f6';
}
window.resolveStandardWireColor = resolveStandardWireColor;

// Kept for compatibility with saved circuit files; new wire colors come from swatches or pins.
function getWireColorPreference() { return activeWireColorPreference; }
function setWireColorPreference(col) {
  activeWireColorPreference = col ?? null;
  syncWireColorPicker();
  updateSwatchUI(activeWireColorPreference);
}

function updateSwatchUI(selectedColor) {
  if (!wireQuickSwatches) return;
  wireQuickSwatches.querySelectorAll('.swatch-btn').forEach((btn) => {
    const col = btn.getAttribute('data-color');
    if (selectedColor === null || selectedColor === 'auto') {
      btn.classList.toggle('active', col === 'auto');
    } else {
      btn.classList.toggle('active', col?.toLowerCase() === selectedColor?.toLowerCase());
    }
  });
}

function selectWireColor(color) {
  if (color === 'auto' || !color) {
    activeWireColorPreference = null;
    updateSwatchUI('auto');
    if (wireColorInput) wireColorInput.value = DEFAULT_WIRE_COLOR;
    if (typeof setStatus === 'function') setStatus('Wire color set to Auto (Pin default)');
    return;
  }
  activeWireColorPreference = color;
  updateSwatchUI(color);
  if (wireColorInput) wireColorInput.value = color;
  if (pinnedWire) {
    recolorWire(pinnedWire, color);
    if (typeof queueSave === 'function') queueSave();
    if (typeof setStatus === 'function') setStatus(`Selected wire recolored to ${color}`);
  } else {
    if (typeof setStatus === 'function') setStatus(`Next wire will use color ${color}`);
  }
}
window.selectWireColor = selectWireColor;

wireQuickSwatches?.addEventListener('click', (e) => {
  const btn = e.target.closest('.swatch-btn');
  if (!btn) return;
  const color = btn.getAttribute('data-color');
  selectWireColor(color);
});

function syncWireColorPicker() {
  if (!wireColorInput) return;
  wireColorInput.value = pinnedWire?.color || activeWireColorPreference || DEFAULT_WIRE_COLOR;
  wireColorInput.disabled = false;
  wireColorInput.title = pinnedWire ? 'Change the selected wire color' : 'Set custom color for future wires';
  updateSwatchUI(pinnedWire?.color || activeWireColorPreference);
}

function recolorWire(wire, color) {
  wire.color = color;
  wire.line.stroke(color);
  if (pulseActive) {
    wire.line.shadowColor(color);
  }
  wire.handles.getChildren().forEach((handle) => handle.stroke(color));
  wire.nodes.forEach((node) => { if (node.dot) node.dot.fill(color); });
  wireLayer.batchDraw();
  overlay.batchDraw();
}

wireColorInput?.addEventListener('input', () => {
  selectWireColor(wireColorInput.value);
});

// Live Signal Flow Pulse Engine
let pulseAnimation = null;
let pulseActive = false;

function toggleSignalPulse(forcedState = null) {
  pulseActive = forcedState !== null ? forcedState : !pulseActive;
  const btn = document.getElementById('pulse-flow-btn');
  if (btn) {
    btn.classList.toggle('active', pulseActive);
    btn.setAttribute('aria-pressed', pulseActive ? 'true' : 'false');
  }

  if (pulseActive) {
    if (!pulseAnimation) {
      pulseAnimation = new Konva.Animation((frame) => {
        const offset = - (frame.time / 22) % 20;
        wires.forEach((wire) => {
          wire.line.dash([10, 8]);
          wire.line.dashOffset(offset);
          wire.line.shadowColor(wire.color || wire.line.stroke());
          wire.line.shadowBlur(8);
          wire.line.shadowOpacity(0.9);
        });
      }, wireLayer);
    }
    pulseAnimation.start();
    if (typeof setStatus === 'function') setStatus('⚡ Live Signal Flow: ACTIVE (60fps simulation)');
  } else {
    if (pulseAnimation) {
      pulseAnimation.stop();
    }
    wires.forEach((wire) => {
      wire.line.dash([]);
      wire.line.dashOffset(0);
      wire.line.shadowBlur(0);
    });
    wireLayer.batchDraw();
    if (typeof setStatus === 'function') setStatus('Live Signal Flow: Paused');
  }
}
window.toggleSignalPulse = toggleSignalPulse;

document.getElementById('pulse-flow-btn')?.addEventListener('click', () => {
  toggleSignalPulse();
});

const pinPos = (pin) => {
  if (!pin) return { x: 0, y: 0 };
  try {
    if (typeof pin.getAbsolutePosition === 'function' && pin.parent) {
      return pin.getAbsolutePosition(layer);
    }
  } catch (_) {}
  return { x: typeof pin.x === 'function' ? pin.x() : (pin.x || 0), y: typeof pin.y === 'function' ? pin.y() : (pin.y || 0) };
};
const pointer = () => layer.getRelativePointerPosition();
const isDrawing = () => draft !== null;

function newWireId() {
  nextWireId += 1;
  return window.crypto?.randomUUID?.() || `wire-${Date.now()}-${nextWireId}`;
}

function isJunctionEndpoint(endpoint) { return endpoint?.kind === 'junction'; }
function getWire(id) { return wires.find((wire) => wire.id === id); }
function getJunctionNode(endpoint) {
  const parent = getWire(endpoint.wireId);
  return parent?.nodes.find((node) => node.junctionId === endpoint.nodeId) || null;
}
function endpointPos(endpoint) {
  if (!endpoint) return null;
  if (!isJunctionEndpoint(endpoint)) return pinPos(endpoint);
  const node = getJunctionNode(endpoint);
  return node ? { x: node.x, y: node.y } : null;
}
function serializeEndpoint(endpoint) {
  if (!endpoint) return { kind: 'pin', instanceId: '', pinId: '' };
  if (isJunctionEndpoint(endpoint)) {
    return { kind: 'junction', wireId: endpoint.wireId, nodeId: endpoint.nodeId };
  }
  try {
    const parent = typeof endpoint.getParent === 'function' ? endpoint.getParent() : null;
    return {
      kind: 'pin',
      instanceId: parent && typeof parent.getAttr === 'function' ? parent.getAttr('instanceId') : '',
      pinId: typeof endpoint.getAttr === 'function' ? endpoint.getAttr('pinId') : '',
    };
  } catch (_) {
    return { kind: 'pin', instanceId: '', pinId: '' };
  }
}
function endpointKey(endpoint) {
  if (!endpoint) return '';
  if (isJunctionEndpoint(endpoint)) return `junction:${endpoint.wireId}:${endpoint.nodeId}`;
  try {
    const parent = typeof endpoint.getParent === 'function' ? endpoint.getParent() : null;
    const instanceId = parent && typeof parent.getAttr === 'function' ? parent.getAttr('instanceId') : '';
    const pinId = typeof endpoint.getAttr === 'function' ? endpoint.getAttr('pinId') : '';
    return `pin:${instanceId}:${pinId}`;
  } catch (_) {
    return '';
  }
}

function wirePoints(wire) {
  const a = endpointPos(wire.from), b = endpointPos(wire.to);
  if (!a || !b) return [];
  return [a.x, a.y, ...wire.nodes.flatMap((node) => [node.x, node.y]), b.x, b.y];
}
function updateWire(wire) { wire.line.points(wirePoints(wire)); }

// Recalculate every line when a component moves; branches may depend on another wire's node.
function updateWiresFor() {
  wires.forEach(updateWire);
  wireLayer.batchDraw();
  overlay.batchDraw();
}

function nearestSegment(points, p) {
  let best = { i: 0, d: Infinity, x: 0, y: 0 };
  for (let k = 0; k + 3 < points.length; k += 2) {
    const ax = points[k], ay = points[k + 1], bx = points[k + 2], by = points[k + 3];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
    const x = ax + t * dx, y = ay + t * dy, d = Math.hypot(p.x - x, p.y - y);
    if (d < best.d) best = { i: k / 2, d, x, y };
  }
  return best;
}

function snapToAxes(point, anchors) {
  const tolerance = AXIS_SNAP_PIXELS / stage.scaleX();
  let x = point.x, y = point.y;
  let nearestX = tolerance, nearestY = tolerance;
  anchors.filter(Boolean).forEach((anchor) => {
    const dx = Math.abs(point.x - anchor.x), dy = Math.abs(point.y - anchor.y);
    if (dx < nearestX) { nearestX = dx; x = anchor.x; }
    if (dy < nearestY) { nearestY = dy; y = anchor.y; }
  });
  return { x, y };
}
function alignmentBend(start, end) {
  const tolerance = AXIS_SNAP_PIXELS / stage.scaleX();
  const dx = Math.abs(end.x - start.x), dy = Math.abs(end.y - start.y);
  if (dx <= tolerance && dx > 0.5 && (dx <= dy || dy > tolerance)) return { x: end.x, y: start.y };
  if (dy <= tolerance && dy > 0.5) return { x: start.x, y: end.y };
  return null;
}
function highlight(pin, on) {
  if (!pin || isJunctionEndpoint(pin)) return;
  pin.radius(on ? 6.5 : 4);
  layer.batchDraw();
}
function nearestPin(pos, exclude) {
  let best = null, bestDist = SNAP_RADIUS;
  layer.find('.pin').forEach((pin) => {
    if (pin === exclude) return;
    const p = pinPos(pin), d = Math.hypot(p.x - pos.x, p.y - pos.y);
    if (d <= bestDist) { best = pin; bestDist = d; }
  });
  return best;
}
function nearestWirePoint(pos) {
  let best = null;
  wires.forEach((wire) => {
    const hit = nearestSegment(wirePoints(wire), pos);
    if (hit.d <= SNAP_RADIUS && (!best || hit.d < best.d)) best = { wire, ...hit };
  });
  return best;
}

function refreshHandles() {
  wires.forEach((wire) => {
    const on = wire === hoverWire || wire === pinnedWire;
    wire.handles.visible(on);
    wire.line.strokeWidth(wire === pinnedWire ? 4 : 2.5);
  });
  overlay.batchDraw();
  wireLayer.batchDraw();
}
function hovering(wire) { clearTimeout(hideTimer); hoverWire = wire; refreshHandles(); }
function unhover(wire) {
  hideTimer = setTimeout(() => { if (hoverWire === wire) { hoverWire = null; refreshHandles(); } }, 250);
}
function pinWire(wire) { pinnedWire = wire; refreshHandles(); syncWireColorPicker(); }

function junctionDot(node, wire) {
  if (!node.junctionId) return;
  if (!node.dot) {
    node.dot = new Konva.Circle({
      radius: 4.5, fill: wire.line.stroke(), stroke: '#ffffff', strokeWidth: 1.5,
      listening: false, name: 'junction-dot',
    });
    overlay.add(node.dot);
  }
  node.dot.fill(wire.color || wire.line.stroke());
  node.dot.position({ x: node.x, y: node.y });
  node.dot.moveToTop();
}

function updateConnectedBranches(wire, node) {
  wires.forEach((candidate) => {
    if ((isJunctionEndpoint(candidate.from) && candidate.from.wireId === wire.id && candidate.from.nodeId === node.junctionId) ||
        (isJunctionEndpoint(candidate.to) && candidate.to.wireId === wire.id && candidate.to.nodeId === node.junctionId)) {
      updateWire(candidate);
    }
  });
  wireLayer.batchDraw();
}

function removeBranchesAt(wireId, nodeId) {
  wires.slice().forEach((wire) => {
    const uses = [wire.from, wire.to].some((endpoint) =>
      isJunctionEndpoint(endpoint) && endpoint.wireId === wireId && endpoint.nodeId === nodeId);
    if (uses) removeWire(wire);
  });
}

function rebuildHandles(wire) {
  wire.handles.destroyChildren();
  wire.nodes.forEach((node) => {
    junctionDot(node, wire);
    const handle = new Konva.Circle({
      x: node.x, y: node.y, radius: 5,
      fill: '#ffffff', stroke: wire.line.stroke(), strokeWidth: 2,
      hitStrokeWidth: 10, draggable: true,
    });
    handle.on('mousedown touchstart', () => { select(null); pinWire(wire); });
    handle.on('dragmove', () => {
      const index = wire.nodes.indexOf(node);
      const before = index > 0 ? wire.nodes[index - 1] : endpointPos(wire.from);
      const after = index < wire.nodes.length - 1 ? wire.nodes[index + 1] : endpointPos(wire.to);
      const point = snapToAxes({ x: handle.x(), y: handle.y() }, [before, after]);
      node.x = point.x; node.y = point.y;
      handle.position(point);
      if (node.dot) node.dot.position(point);
      wires.forEach(updateWire);
      wireLayer.batchDraw();
      overlay.batchDraw();
      if (node.junctionId) updateConnectedBranches(wire, node);
      queueSave();
    });
    handle.on('dblclick dbltap', () => {
      if (node.junctionId) {
        removeBranchesAt(wire.id, node.junctionId);
        if (node.dot) node.dot.destroy();
      }
      const nodeIndex = wire.nodes.indexOf(node);
      if (nodeIndex >= 0) wire.nodes.splice(nodeIndex, 1);
      stage.container().style.cursor = 'default';
      rebuildHandles(wire);
      updateWire(wire);
      wireLayer.batchDraw();
      queueSave();
    });
    handle.on('mouseenter', () => { stage.container().style.cursor = 'move'; hovering(wire); });
    handle.on('mouseleave', () => { stage.container().style.cursor = 'default'; unhover(wire); });
    wire.handles.add(handle);
  });
  overlay.batchDraw();
}

function addWire(from, to, nodes = [], wireId = newWireId(), shouldSave = true, colorOverride = null) {
  if (!from || !to) return null;
  const key = `${endpointKey(from)}>${endpointKey(to)}`;
  const reverseKey = `${endpointKey(to)}>${endpointKey(from)}`;
  if (wires.some((wire) => wire.key === key || wire.key === reverseKey)) return null;

  const sourcePin = isJunctionEndpoint(from) ? null : from;
  const color = colorOverride || activeWireColorPreference || resolveStandardWireColor(from, to);
  const line = new Konva.Line({
    stroke: color, strokeWidth: 2.5, lineJoin: 'round', lineCap: 'round', hitStrokeWidth: 12,
  });
  if (pulseActive) {
    line.dash([10, 8]);
    line.shadowColor(color);
    line.shadowBlur(8);
    line.shadowOpacity(0.9);
  }
  const handles = new Konva.Group({ visible: false });
  overlay.add(handles);
  const wire = { id: wireId, key, from, to, nodes, line, handles, color };

  line.on('mouseenter', () => {
    stage.container().style.cursor = window.probeModeActive ? 'crosshair' : 'pointer';
    hovering(wire);
    if (window.probeModeActive && typeof window.probeHover === 'function') {
      window.probeHover(wire);
    }
  });
  line.on('mouseleave', () => {
    stage.container().style.cursor = 'default';
    unhover(wire);
    if (window.probeModeActive && typeof window.probeUnhover === 'function') {
      window.probeUnhover(wire);
    }
  });
  line.on('click tap', (e) => {
    if (window.multimeterActive && window.multimeter) {
      e.cancelBubble = true;
      window.multimeter.handleCanvasClick({ type: 'wire', wire });
      return;
    }
    select(null);
    pinWire(wire);
    if (window.probeModeActive || e.evt?.shiftKey) {
      if (typeof window.inspectWireNet === 'function') window.inspectWireNet(wire);
    }
  });
  line.on('dblclick dbltap', () => {
    const pos = pointer();
    if (!pos) return;
    const point = nearestSegment(wirePoints(wire), pos);
    wire.nodes.splice(point.i, 0, { x: point.x, y: point.y });
    rebuildHandles(wire);
    updateWire(wire);
    pinWire(wire);
    queueSave();
  });

  wireLayer.add(line);
  wires.push(wire);
  updateWire(wire);
  rebuildHandles(wire);
  wireLayer.batchDraw();
  if (shouldSave) queueSave();
  return wire;
}

function removeWire(wire) {
  if (!wires.includes(wire)) return;
  wires.slice().forEach((candidate) => {
    [candidate.from, candidate.to].forEach((endpoint) => {
      if (isJunctionEndpoint(endpoint) && endpoint.wireId === wire.id) removeWire(candidate);
    });
  });
  const junctionEndpoints = [wire.from, wire.to].filter(isJunctionEndpoint);
  clearTimeout(hideTimer);
  if (hoverWire === wire) hoverWire = null;
  if (pinnedWire === wire) pinnedWire = null;
  syncWireColorPicker();
  wire.nodes.forEach((node) => { if (node.dot) node.dot.destroy(); });
  wire.line.destroy();
  wire.handles.destroy();
  wires.splice(wires.indexOf(wire), 1);
  junctionEndpoints.forEach((endpoint) => {
    const stillConnected = wires.some((candidate) => [candidate.from, candidate.to].some((other) =>
      isJunctionEndpoint(other) && other.wireId === endpoint.wireId && other.nodeId === endpoint.nodeId));
    if (stillConnected) return;
    const parent = getWire(endpoint.wireId);
    if (!parent) return;
    const index = parent.nodes.findIndex((node) => node.junctionId === endpoint.nodeId);
    if (index < 0) return;
    const [node] = parent.nodes.splice(index, 1);
    if (node.dot) node.dot.destroy();
    rebuildHandles(parent);
    updateWire(parent);
  });
  stage.container().style.cursor = 'default';
  wireLayer.batchDraw();
  overlay.batchDraw();
  if (!window.replayingHistory) {
    queueSave();
    if (window.multimeter) {
      window.multimeter.update();
    }
    if (typeof window.updateWiringCheckIndicator === 'function') {
      window.updateWiringCheckIndicator();
    }
  }
}
function removeWiresFor(group) {
  wires.slice().forEach((wire) => {
    const connected = [wire.from, wire.to].some((endpoint) =>
      !isJunctionEndpoint(endpoint) && endpoint && typeof endpoint.getParent === 'function' && endpoint.getParent() === group);
    if (connected) removeWire(wire);
  });
}

function setPartsDraggable(on) {
  layer.find('.component').forEach((group) => group.draggable(on));
}
function drawDraft(pos) {
  const start = pinPos(draft.from);
  const points = draft.nodes.map((node) => ({ x: node.x, y: node.y }));
  const anchor = points.length ? points[points.length - 1] : start;
  let end = pos;
  let bend = null;
  if (draft.targetPin) end = pinPos(draft.targetPin);
  else if (draft.wireTarget) end = { x: draft.wireTarget.x, y: draft.wireTarget.y };
  if (draft.targetPin || draft.wireTarget) {
    bend = alignmentBend(anchor, end);
  } else {
    end = snapToAxes(end, [anchor]);
  }
  if (bend) points.push(bend);
  draft.line.points([start.x, start.y, ...points.flatMap((node) => [node.x, node.y]), end.x, end.y]);
  overlay.batchDraw();
}
function startWire(pin) {
  if (draft) return;
  const color = activeWireColorPreference || resolveStandardWireColor(pin, null);
  const line = new Konva.Line({
    stroke: color, strokeWidth: 2, dash: [6, 4], lineJoin: 'round', listening: false,
  });
  overlay.add(line);
  draft = { from: pin, nodes: [], line, color, targetPin: null, wireTarget: null };
  setPartsDraggable(false);
  highlight(pin, true);
}
function finishWire(target) {
  const { from, nodes, line, targetPin } = draft;
  draft = null;
  line.destroy();
  highlight(from, false);
  highlight(targetPin, false);
  setPartsDraggable(true);
  if (target) {
    const end = endpointPos(target);
    const start = nodes.length ? nodes[nodes.length - 1] : pinPos(from);
    const bend = end && alignmentBend(start, end);
    if (bend) nodes.push(bend);
    const resolvedColor = activeWireColorPreference || resolveStandardWireColor(from, target);
    const newWire = addWire(from, target, nodes, undefined, true, resolvedColor);
    if (newWire && window.multimeter) {
      window.multimeter.onWireAdded(newWire);
      window.multimeter.update();
    }
    if (typeof window.updateWiringCheckIndicator === 'function') {
      window.updateWiringCheckIndicator();
    }
  }
  overlay.batchDraw();
}
function junctionAt(hit) {
  const nearby = hit.wire.nodes.find((node) => node.junctionId && Math.hypot(node.x - hit.x, node.y - hit.y) <= SNAP_RADIUS);
  if (nearby) return { kind: 'junction', wireId: hit.wire.id, nodeId: nearby.junctionId };
  const nodeId = newWireId();
  const node = { x: hit.x, y: hit.y, junctionId: nodeId };
  hit.wire.nodes.splice(hit.i, 0, node);
  rebuildHandles(hit.wire);
  updateWire(hit.wire);
  wireLayer.batchDraw();
  overlay.batchDraw();
  return { kind: 'junction', wireId: hit.wire.id, nodeId };
}

stage.on('mousemove touchmove', () => {
  if (!draft) return;
  const pos = pointer();
  if (!pos) return;
  const targetPin = nearestPin(pos, draft.from);
  const wireTarget = targetPin ? null : nearestWirePoint(pos);
  if (targetPin !== draft.targetPin) {
    highlight(draft.targetPin, false);
    highlight(targetPin, true);
  }
  draft.targetPin = targetPin;
  draft.wireTarget = wireTarget;
  if (!activeWireColorPreference) {
    const liveTarget = targetPin || (wireTarget ? junctionAt(wireTarget) : null);
    const liveColor = resolveStandardWireColor(draft.from, liveTarget);
    draft.color = liveColor;
    draft.line.stroke(liveColor);
  }
  drawDraft(pos);
});

stage.on('mouseup touchend', () => {
  if (!draft) return;
  const pos = pointer();
  if (!pos) return;
  const start = pinPos(draft.from);
  if (Math.hypot(pos.x - start.x, pos.y - start.y) <= START_CLICK) return;
  const targetPin = nearestPin(pos, draft.from);
  if (targetPin) return finishWire(targetPin);
  const wireTarget = nearestWirePoint(pos);
  if (wireTarget) return finishWire(junctionAt(wireTarget));
  const anchor = draft.nodes.length ? draft.nodes[draft.nodes.length - 1] : pinPos(draft.from);
  draft.nodes.push(snapToAxes(pos, [anchor]));
  drawDraft(pos);
});

stage.on('mousedown touchstart', (e) => {
  if (e.target === stage) {
    pinWire(null);
    if (!window.probeModeActive) clearNetHighlight();
  }
});
window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return;
  if (e.key === 'Escape' && draft) finishWire(null);
  else if (e.key === 'Escape' && (probedNet || window.probeModeActive)) clearNetHighlight();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && pinnedWire && !draft) removeWire(pinnedWire);
});

// ============================================================================
// ELECTRICAL NET ENGINE & PROBE SYSTEM
// ============================================================================

function computeElectricalNets() {
  const parent = new Map();
  const find = (key) => {
    if (!parent.has(key)) parent.set(key, key);
    if (parent.get(key) !== key) parent.set(key, find(parent.get(key)));
    return parent.get(key);
  };
  const union = (a, b) => {
    const rootA = find(a), rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  const wireNetMap = new Map();
  const pinEndpointMap = new Map();

  wires.forEach((wire) => {
    const endpoints = [wire.from, wire.to];
    wire.nodes.forEach((node) => {
      if (node.junctionId) endpoints.push({ kind: 'junction', wireId: wire.id, nodeId: node.junctionId });
    });
    const keys = endpoints.map(endpointKey);
    keys.forEach((key) => find(key));
    for (let i = 1; i < keys.length; i += 1) union(keys[0], keys[i]);

    endpoints.forEach((endpoint, i) => {
      const k = keys[i];
      if (!wireNetMap.has(k)) wireNetMap.set(k, new Set());
      wireNetMap.get(k).add(wire);
      if (!isJunctionEndpoint(endpoint)) {
        pinEndpointMap.set(k, endpoint);
      }
    });
  });

  const netGroups = new Map();
  pinEndpointMap.forEach((endpoint, key) => {
    const root = find(key);
    if (!netGroups.has(root)) netGroups.set(root, { pins: [], wires: new Set() });
    netGroups.get(root).pins.push(endpoint);
  });
  wireNetMap.forEach((wireSet, key) => {
    const root = find(key);
    if (!netGroups.has(root)) netGroups.set(root, { pins: [], wires: new Set() });
    wireSet.forEach((w) => netGroups.get(root).wires.add(w));
  });

  const resolvedNets = [];
  let netIdx = 1;

  netGroups.forEach((groupData, rootKey) => {
    const netWires = Array.from(groupData.wires);
    const resolvedPins = groupData.pins.map((endpoint) => {
      if (!endpoint) return null;
      let compGroup = null;
      try {
        compGroup = typeof endpoint.getParent === 'function' ? endpoint.getParent() : null;
      } catch (_) { compGroup = null; }
      if (!compGroup || typeof compGroup.getAttr !== 'function') return null;
      const def = window.library ? window.library.get(compGroup.getAttr('defId')) : null;
      const pinId = typeof endpoint.getAttr === 'function' ? endpoint.getAttr('pinId') : '';
      const pinDef = def?.pins?.find((p) => p.id === pinId) || {};
      return {
        endpoint,
        group: compGroup,
        def,
        pin: pinDef,
        pinId,
        label: pinDef.label || pinId,
        type: pinDef.type || 'other',
        partName: def?.name || 'Component',
      };
    }).filter((item) => item && item.def);

    // Classify Net & determine Voltage / Standard Color
    let title = `NET ${netIdx}`;
    let classification = 'Signal / Logic';
    let standardColor = '#3b82f6';
    let accentColor = '#38bdf8';
    let voltage = 'Logic (3.3V/5V)';
    let isGround = false;
    let isPower = false;

    const hasGND = resolvedPins.some((p) => p.type === 'ground' || (p.label || '').toLowerCase().includes('gnd') || p.label === '-');
    const has5V = resolvedPins.some((p) => p.type === 'power' && ((p.label || '').toLowerCase().includes('5v') || (p.label || '').toLowerCase().includes('vcc')));
    const has3V3 = resolvedPins.some((p) => (p.label || '').toLowerCase().includes('3v3') || (p.label || '').toLowerCase().includes('3.3'));
    const has9V = resolvedPins.some((p) => (p.label || '').toLowerCase().includes('9v'));
    const hasSCL = resolvedPins.some((p) => (p.label || '').toLowerCase().includes('scl') || (p.label || '').toLowerCase().includes('clk'));
    const hasSDA = resolvedPins.some((p) => (p.label || '').toLowerCase().includes('sda') || (p.label || '').toLowerCase().includes('mosi'));
    const hasUART = resolvedPins.some((p) => (p.label || '').toLowerCase().includes('tx') || (p.label || '').toLowerCase().includes('rx'));

    if (hasGND) {
      isGround = true;
      title = '🔌 NET: Ground (GND)';
      classification = 'Common Ground (0V)';
      standardColor = '#1e293b';
      accentColor = '#94a3b8';
      voltage = '0.0V (GND)';
    } else if (has5V) {
      isPower = true;
      title = '⚡ NET: +5V Power Rail (VCC)';
      classification = 'Power Rail (+5.0V)';
      standardColor = '#ef4444';
      accentColor = '#ef4444';
      voltage = '+5.0V DC';
    } else if (has3V3) {
      isPower = true;
      title = '⚡ NET: +3.3V Logic Rail';
      classification = 'Power Rail (+3.3V)';
      standardColor = '#f97316';
      accentColor = '#f97316';
      voltage = '+3.3V DC';
    } else if (has9V) {
      isPower = true;
      title = '🔋 NET: +9V Battery Rail';
      classification = 'Battery Supply (+9V)';
      standardColor = '#dc2626';
      accentColor = '#dc2626';
      voltage = '+9.0V DC';
    } else if (hasSCL) {
      title = '📊 NET: I2C_SCL (Clock)';
      classification = 'I2C Serial Clock Bus';
      standardColor = '#eab308';
      accentColor = '#eab308';
      voltage = 'Clock Signal';
    } else if (hasSDA) {
      title = '📡 NET: I2C_SDA (Data)';
      classification = 'I2C Serial Data Bus';
      standardColor = '#22c55e';
      accentColor = '#22c55e';
      voltage = 'Bidirectional Data';
    } else if (hasUART) {
      const uartPin = resolvedPins.find((p) => (p.label || '').toLowerCase().includes('tx') || (p.label || '').toLowerCase().includes('rx'));
      title = `📶 NET: UART Serial (${uartPin?.label || 'TX/RX'})`;
      classification = 'Serial UART Bus';
      standardColor = '#06b6d4';
      accentColor = '#06b6d4';
      voltage = 'Asynchronous Serial';
    } else if (resolvedPins.length > 0) {
      const lead = resolvedPins[0];
      title = `📶 NET: ${lead.partName} [${lead.label}]`;
      classification = 'Digital / Analog Signal';
      standardColor = '#3b82f6';
      accentColor = '#38bdf8';
      voltage = 'Signal Bus';
    }

    // Health & Safety Checks on this net
    const warnings = [];
    // 1. Direct Short Circuit Check
    if (isGround && (has5V || has3V3 || has9V || resolvedPins.some(p => p.type === 'power'))) {
      const pPin = resolvedPins.find(p => p.type === 'power' || (p.label || '').toLowerCase().includes('vcc') || (p.label || '').toLowerCase().includes('5v'));
      const gPin = resolvedPins.find(p => p.type === 'ground' || (p.label || '').toLowerCase().includes('gnd'));
      warnings.push({
        severity: 'critical',
        message: `🚨 Short Circuit: Power (${pPin?.partName} [${pPin?.label}]) connected directly to Ground (${gPin?.partName} [${gPin?.label}])!`,
      });
    }

    // 2. Voltage conflict
    if (has5V && has3V3) {
      warnings.push({
        severity: 'warning',
        message: `⚠️ Voltage Conflict: 5V power source and 3.3V power source connected directly together on this net.`,
      });
    }

    // 3. Logic level overdrive
    const sources = resolvedPins.filter((item) => Number.isFinite(item.pin.maxOutputVoltage));
    const targets = resolvedPins.filter((item) => ['signal', 'data'].includes(item.pin.type) && Number.isFinite(item.def.gpioMaxInputVoltage));
    sources.forEach((source) => {
      targets.forEach((target) => {
        if (source.endpoint === target.endpoint || source.group === target.group) return;
        if (source.pin.maxOutputVoltage > target.def.gpioMaxInputVoltage) {
          warnings.push({
            severity: 'warning',
            message: `${source.def.name} ${source.label} outputs ${source.pin.maxOutputVoltage}V, while ${target.def.name} ${target.label} accepts max ${target.def.gpioMaxInputVoltage}V logic. Add level shifter.`,
          });
        }
      });
    });

    // 4. Unterminated net
    if (resolvedPins.length < 2 && netWires.length > 0) {
      warnings.push({
        severity: 'info',
        message: `ℹ️ Unterminated Net: Wire has only 1 connected pin.`,
      });
    }

    resolvedNets.push({
      netId: `net-${netIdx++}`,
      rootKey,
      title,
      classification,
      standardColor,
      accentColor,
      voltage,
      isGround,
      isPower,
      wires: netWires,
      pins: resolvedPins,
      warnings,
    });
  });

  return resolvedNets;
}
window.computeElectricalNets = computeElectricalNets;

// Net Highlighting & Probe HUD
let probeModeActive = false;
let probedNet = null;
const netInspectorCard = document.getElementById('net-inspector-card');
const netProbeBtn = document.getElementById('net-probe-btn');
const autocolorWiresBtn = document.getElementById('autocolor-wires-btn');

function toggleNetProbe(forceState = null) {
  probeModeActive = forceState !== null ? forceState : !probeModeActive;
  window.probeModeActive = probeModeActive;
  if (netProbeBtn) {
    netProbeBtn.classList.toggle('active', probeModeActive);
    netProbeBtn.setAttribute('aria-pressed', probeModeActive ? 'true' : 'false');
  }
  if (probeModeActive) {
    stage.container().style.cursor = 'crosshair';
    if (typeof setStatus === 'function') {
      setStatus('⚡ Net Probe Active: Click any wire or pin to inspect electrical net (Esc to close)');
    }
  } else {
    stage.container().style.cursor = 'default';
    clearNetHighlight();
    if (typeof setStatus === 'function') setStatus('Net Probe: Off');
  }
}
window.toggleNetProbe = toggleNetProbe;

function findNetFor(target) {
  const nets = computeElectricalNets();
  if (!target) return null;
  if (wires.includes(target)) {
    return nets.find((n) => n.wires.includes(target)) || null;
  }
  return nets.find((n) => n.pins.some((p) => p.endpoint === target)) || null;
}

function highlightNet(net) {
  if (!net) {
    clearNetHighlight();
    return;
  }
  probedNet = net;
  window.probedNet = net;

  const netWireSet = new Set(net.wires);
  const netPinSet = new Set(net.pins.map((p) => p.endpoint));
  const netGroupSet = new Set(net.pins.map((p) => p.group));

  // Dim non-net wires & highlight net wires
  wires.forEach((wire) => {
    if (netWireSet.has(wire)) {
      wire.line.strokeWidth(4.5);
      wire.line.shadowColor(net.accentColor || '#38bdf8');
      wire.line.shadowBlur(14);
      wire.line.shadowOpacity(1.0);
      wire.line.opacity(1.0);
    } else {
      wire.line.opacity(0.18);
      wire.line.shadowBlur(0);
      wire.line.strokeWidth(2);
    }
  });

  // Enlarge and highlight pins in net
  layer.find('.pin').forEach((pin) => {
    if (netPinSet.has(pin)) {
      pin.radius(7);
      pin.stroke('#ffffff');
      pin.strokeWidth(2.5);
      pin.shadowColor(net.accentColor || '#38bdf8');
      pin.shadowBlur(10);
    } else {
      pin.radius(4);
      pin.stroke('#ffffff');
      pin.strokeWidth(1.5);
      pin.shadowBlur(0);
    }
  });

  // Dim non-connected components
  layer.find('.component').forEach((group) => {
    if (netGroupSet.has(group)) {
      group.opacity(1.0);
    } else {
      group.opacity(0.4);
    }
  });

  wireLayer.batchDraw();
  overlay.batchDraw();
  layer.batchDraw();

  updateNetInspectorUI(net);
}
window.highlightNet = highlightNet;

function clearNetHighlight() {
  probedNet = null;
  window.probedNet = null;

  wires.forEach((wire) => {
    wire.line.opacity(1.0);
    wire.line.strokeWidth(wire === pinnedWire ? 4 : 2.5);
    wire.line.shadowBlur(pulseActive ? 8 : 0);
    wire.line.shadowColor(wire.color || wire.line.stroke());
  });

  layer.find('.pin').forEach((pin) => {
    pin.radius(4);
    pin.stroke('#ffffff');
    pin.strokeWidth(1.5);
    pin.shadowBlur(0);
  });

  layer.find('.component').forEach((group) => {
    group.opacity(1.0);
  });

  wireLayer.batchDraw();
  overlay.batchDraw();
  layer.batchDraw();

  if (netInspectorCard) netInspectorCard.hidden = true;
}
window.clearNetHighlight = clearNetHighlight;

function updateNetInspectorUI(net) {
  if (!netInspectorCard) return;
  netInspectorCard.hidden = false;

  const titleEl = document.getElementById('net-inspector-title');
  const dotEl = document.getElementById('net-inspector-dot');
  const typeEl = document.getElementById('net-inspector-type');
  const countEl = document.getElementById('net-inspector-count');
  const healthEl = document.getElementById('net-inspector-health');
  const healthIcon = document.getElementById('net-inspector-health-icon');
  const healthText = document.getElementById('net-inspector-health-text');
  const nodesList = document.getElementById('net-inspector-nodes');

  if (titleEl) titleEl.textContent = net.title;
  if (typeEl) typeEl.textContent = `${net.classification} (${net.voltage})`;
  if (countEl) countEl.textContent = `${net.pins.length} Pin${net.pins.length === 1 ? '' : 's'} • ${net.wires.length} Wire${net.wires.length === 1 ? '' : 's'}`;

  const critical = (net.warnings || []).find((w) => w.severity === 'critical');
  const warning = (net.warnings || []).find((w) => w.severity === 'warning');

  if (dotEl) {
    dotEl.className = 'net-status-dot';
    if (critical) dotEl.classList.add('status-critical');
    else if (warning) dotEl.classList.add('status-warning');
  }

  if (healthEl) {
    healthEl.className = 'net-health-row';
    if (critical) {
      healthEl.classList.add('health-critical');
      if (healthIcon) healthIcon.textContent = '🚨';
      if (healthText) healthText.textContent = critical.message;
    } else if (warning) {
      healthEl.classList.add('health-warning');
      if (healthIcon) healthIcon.textContent = '⚠️';
      if (healthText) healthText.textContent = warning.message;
    } else {
      healthEl.classList.add('health-ok');
      if (healthIcon) healthIcon.textContent = '✅';
      if (healthText) healthText.textContent = 'No electrical conflicts';
    }
  }

  if (nodesList) {
    nodesList.replaceChildren();
    net.pins.forEach((item) => {
      const nodeEl = document.createElement('div');
      nodeEl.className = 'net-node-item';
      nodeEl.title = `Click to pan & focus on ${item.partName}`;
      nodeEl.innerHTML = `
        <span class="net-node-part">${item.partName}</span>
        <span class="net-node-pin">${item.label}</span>
      `;
      nodeEl.addEventListener('click', () => {
        const pos = item.group.position();
        const stageW = stage.width(), stageH = stage.height();
        const scale = stage.scaleX() || 1;
        stage.position({
          x: stageW / 2 - pos.x * scale,
          y: stageH / 2 - pos.y * scale,
        });
        stage.batchDraw();
        layer.batchDraw();
        wireLayer.batchDraw();
        overlay.batchDraw();
        if (typeof updateMinimap === 'function') updateMinimap();
      });
      nodesList.appendChild(nodeEl);
    });
  }
}

// Global probe hooks for pins and wires
window.probeHover = (target) => {
  if (probedNet) return;
  const net = findNetFor(target);
  if (net) highlightNet(net);
};

window.probeUnhover = () => {
  if (!probedNet) clearNetHighlight();
};

window.inspectWireNet = (wire) => {
  const net = findNetFor(wire);
  if (net) highlightNet(net);
};

window.inspectPinNet = (pin) => {
  const net = findNetFor(pin);
  if (net) highlightNet(net);
};

function autoColorAllWires() {
  if (!wires.length) {
    if (typeof setStatus === 'function') setStatus('No wires to auto-color');
    return;
  }
  const nets = computeElectricalNets();
  let updatedCount = 0;
  nets.forEach((net) => {
    const stdColor = net.standardColor || '#3b82f6';
    net.wires.forEach((wire) => {
      if (wire.color !== stdColor) {
        recolorWire(wire, stdColor);
        updatedCount += 1;
      }
    });
  });
  wireLayer.batchDraw();
  overlay.batchDraw();
  if (typeof queueSave === 'function') queueSave();
  if (typeof setStatus === 'function') {
    setStatus(`⚡ Auto-colored ${updatedCount} wires across ${nets.length} electrical nets!`);
  }
}
window.autoColorAllWires = autoColorAllWires;

// Attach UI Event Listeners
netProbeBtn?.addEventListener('click', () => toggleNetProbe());
autocolorWiresBtn?.addEventListener('click', () => autoColorAllWires());
document.getElementById('net-inspector-close')?.addEventListener('click', () => clearNetHighlight());
document.getElementById('net-autocolor-btn')?.addEventListener('click', () => {
  if (!probedNet) return;
  const stdColor = probedNet.standardColor || '#3b82f6';
  probedNet.wires.forEach((w) => recolorWire(w, stdColor));
  highlightNet(probedNet);
  if (typeof queueSave === 'function') queueSave();
  if (typeof setStatus === 'function') setStatus(`⚡ Applied standard color ${stdColor} to ${probedNet.title}`);
});

// Make Net Inspector Card draggable anywhere on the workspace
(function initDraggableInspector() {
  const card = document.getElementById('net-inspector-card');
  const header = card?.querySelector('.net-inspector-header');
  if (!card || !header) return;

  let isDragging = false;
  let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    isDragging = true;
    const rect = card.getBoundingClientRect();
    const parentRect = card.parentElement.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    initialLeft = rect.left - parentRect.left;
    initialTop = rect.top - parentRect.top;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    card.style.left = `${Math.max(10, initialLeft + dx)}px`;
    card.style.top = `${Math.max(10, initialTop + dy)}px`;
    card.style.right = 'auto';
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
  });

  header.addEventListener('touchstart', (e) => {
    if (e.target.closest('button')) return;
    const touch = e.touches[0];
    if (!touch) return;
    isDragging = true;
    const rect = card.getBoundingClientRect();
    const parentRect = card.parentElement.getBoundingClientRect();
    startX = touch.clientX;
    startY = touch.clientY;
    initialLeft = rect.left - parentRect.left;
    initialTop = rect.top - parentRect.top;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    card.style.left = `${Math.max(10, initialLeft + dx)}px`;
    card.style.top = `${Math.max(10, initialTop + dy)}px`;
    card.style.right = 'auto';
  }, { passive: true });

  window.addEventListener('touchend', () => {
    isDragging = false;
  });
})();
