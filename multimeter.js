/**
 * ============================================================================
 * DIGITAL MULTIMETER SYSTEM & INSTANT ELECTRICAL CONNECTION VALIDATOR
 * ============================================================================
 * Features:
 * 1. Physical Voltage Simulator: Solves exact nodal voltages across circuits,
 *    including multi-resistor voltage dividers, potentiometers, battery rails,
 *    and ground networks using Modified Nodal Analysis (KCL).
 * 2. Precision Dual-Probe Multimeter (DMM-800):
 *    - Real-time differential DC Voltage measurement: V(Red) - V(Black).
 *    - High-contrast digital 7-segment style LCD with auto-ranging & analog bargraph.
 *    - Interactive Red Probe (V+) & Black Probe (COM-) leads attachable to any pin/wire.
 *    - Default circuit GND reference with 1-click probe swap & reset.
 * 3. Instant Wrong Connection Warning System:
 *    - Fired the EXACT millisecond a wire connection is made.
 *    - Detects Dead Short Circuits (VCC to GND), Rail Conflicts (5V vs 3.3V),
 *      Direct LED shorts (no resistor), and Reverse Polarity.
 *    - Displays prominent glowing warning banner with 1-click [Undo Wire] action,
 *      audio synthesizer alert beep, and visual pulse on faulty wire.
 */

(function () {
  'use strict';

  // Audio synthesizer for instant alert sound
  let audioCtx = null;
  function playAlertBeep(isCritical = true) {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      if (!audioCtx) audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = isCritical ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(isCritical ? 880 : 587, audioCtx.currentTime); // A5 or D5
      osc.frequency.exponentialRampToValueAtTime(isCritical ? 440 : 440, audioCtx.currentTime + 0.18);

      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.22);

      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.22);
    } catch (_) {
      // Audio might be blocked by browser autoplay policy until interaction
    }
  }

  function getKonvaStage() {
    return window.konvaStage || (window.stage?.find ? window.stage : null);
  }

  function getStageContainer() {
    const s = getKonvaStage();
    return s?.container ? s.container() : (document.getElementById('stage') || null);
  }

  // ==========================================================================
  // 1. MNA VOLTAGE SIMULATOR (VOLTAGE DIVIDER & NETWORK SOLVER)
  // ==========================================================================

  function solveCircuitVoltages() {
    if (typeof window.computeElectricalNets !== 'function') {
      return { nets: [], netVoltageMap: new Map(), solved: false };
    }

    const nets = window.computeElectricalNets();
    if (!nets || nets.length === 0) {
      return { nets: [], netVoltageMap: new Map(), solved: true };
    }

    // Map rootKey -> net object & index
    const netIndexMap = new Map();
    nets.forEach((net, idx) => {
      netIndexMap.set(net.rootKey, idx);
      net.voltage = 0.0;
      net.isFixed = false;
      net.isFloating = true;
    });

    // 1. Determine Fixed Voltage Nets from Source Pins
    nets.forEach((net) => {
      for (const p of net.pins) {
        const lbl = (p.label || '').toLowerCase();
        const pinType = p.type;
        const partName = (p.partName || '').toLowerCase();

        // Ground reference
        if (pinType === 'ground' || lbl.includes('gnd') || lbl === '-' || lbl.includes('neg') || lbl.includes('ground')) {
          net.voltage = 0.0;
          net.isFixed = true;
          net.isFloating = false;
          net.voltageSourceType = 'GND (0V)';
          break;
        }
        // 5V Power
        if (lbl.includes('5v') || lbl === 'vcc' || (pinType === 'power' && !lbl.includes('3') && !lbl.includes('9'))) {
          net.voltage = 5.0;
          net.isFixed = true;
          net.isFloating = false;
          net.voltageSourceType = '+5.0V Rail';
          break;
        }
        // 3.3V Logic Rail
        if (lbl.includes('3v3') || lbl.includes('3.3')) {
          net.voltage = 3.3;
          net.isFixed = true;
          net.isFloating = false;
          net.voltageSourceType = '+3.3V Rail';
          break;
        }
        // 9V Battery Rail
        if (lbl.includes('9v')) {
          net.voltage = 9.0;
          net.isFixed = true;
          net.isFloating = false;
          net.voltageSourceType = '+9.0V Rail';
          break;
        }
        // 3.7V Li-ion Rail
        if (lbl.includes('3.7') || lbl.includes('3v7')) {
          net.voltage = 3.7;
          net.isFixed = true;
          net.isFloating = false;
          net.voltageSourceType = '+3.7V Rail';
          break;
        }
      }
    });

    const stage = getKonvaStage();
    if (stage) {
      const components = stage.find('.component') || [];
      components.forEach((comp) => {
        const defId = comp.getAttr('defId');
        if (defId === 'battery-9v' || defId === 'li-ion-18650-3v7') {
          const nominalV = defId === 'battery-9v' ? 9.0 : 3.7;
          const pins = comp.find('.pin') || [];
          const posPin = pins.find((p) => (p.getAttr('pinId') || '').includes('pos'));
          const negPin = pins.find((p) => (p.getAttr('pinId') || '').includes('neg'));

          if (posPin && negPin) {
            const posNet = findNetForEndpoint(posPin, nets);
            const negNet = findNetForEndpoint(negPin, nets);

            if (negNet && !negNet.isFixed) {
              negNet.voltage = 0.0;
              negNet.isFixed = true;
              negNet.isFloating = false;
              negNet.voltageSourceType = 'Battery Negative (0V ref)';
            }
            if (posNet && negNet) {
              posNet.voltage = negNet.voltage + nominalV;
              posNet.isFixed = true;
              posNet.isFloating = false;
              posNet.voltageSourceType = `+${nominalV}V Battery Supply`;
            }
          }
        }
      });
    }

    // 2. Identify Conductive & Resistive Branches
    // Find all resistors, potentiometers, and resistive loads connecting between nets
    const branches = []; // { netA, netB, resistance, componentName }

    if (stage) {
      const components = stage.find('.component') || [];
      components.forEach((comp) => {
        const defId = comp.getAttr('defId');
        const pins = comp.find('.pin') || [];

        // Variable Resistor (editable ohms)
        if (defId === 'resistor-variable') {
          const pinA = pins.find((p) => p.getAttr('pinId') === 'a');
          const pinB = pins.find((p) => p.getAttr('pinId') === 'b');
          if (pinA && pinB) {
            const netA = findNetForEndpoint(pinA, nets);
            const netB = findNetForEndpoint(pinB, nets);
            const rVal = Number.isFinite(comp.resistanceOhms) && comp.resistanceOhms > 0 ? comp.resistanceOhms : 220;
            if (netA && netB && netA !== netB) {
              branches.push({ netA, netB, resistance: rVal, compName: `Resistor (${formatResistanceShort(rVal)})` });
            }
          }
        }

        // 10k Rotary Potentiometer
        if (defId === 'potentiometer-10k') {
          const pin1 = pins.find((p) => p.getAttr('pinId') === 'term1');
          const pinWiper = pins.find((p) => p.getAttr('pinId') === 'wiper');
          const pin2 = pins.find((p) => p.getAttr('pinId') === 'term2');

          const net1 = pin1 ? findNetForEndpoint(pin1, nets) : null;
          const netW = pinWiper ? findNetForEndpoint(pinWiper, nets) : null;
          const net2 = pin2 ? findNetForEndpoint(pin2, nets) : null;

          const totalR = 10000;
          const wiperPos = Number.isFinite(comp.wiperPos) ? comp.wiperPos : 0.5; // default 50%
          const r1 = Math.max(1, totalR * wiperPos);
          const r2 = Math.max(1, totalR * (1 - wiperPos));

          if (net1 && netW && net1 !== netW) {
            branches.push({ netA: net1, netB: netW, resistance: r1, compName: `Pot (Term 1 - Wiper)` });
          }
          if (netW && net2 && netW !== net2) {
            branches.push({ netA: netW, netB: net2, resistance: r2, compName: `Pot (Wiper - Term 2)` });
          }
        }

        // LDR Sensor (Photoresistor)
        if (defId === 'ldr-sensor' && pins.length >= 2) {
          const netA = findNetForEndpoint(pins[0], nets);
          const netB = findNetForEndpoint(pins[1], nets);
          if (netA && netB && netA !== netB) {
            branches.push({ netA, netB, resistance: 10000, compName: 'LDR Photoresistor (~10kΩ)' });
          }
        }
      });
    }

    // 3. Solve Linear Nodal Equations (Modified Nodal Analysis)
    // Unknown nets: nets that do NOT have a direct fixed voltage source
    const unknownNets = nets.filter((n) => !n.isFixed);
    const m = unknownNets.length;

    if (m > 0 && branches.length > 0) {
      // Map unknown net -> matrix index 0 .. m-1
      const uIndexMap = new Map();
      unknownNets.forEach((net, idx) => uIndexMap.set(net, idx));

      // Build conductance matrix G and current vector I
      const G = Array.from({ length: m }, () => new Float64Array(m));
      const I = new Float64Array(m);
      const isConnectedToCircuit = new Uint8Array(m);

      branches.forEach(({ netA, netB, resistance }) => {
        const cond = 1.0 / resistance;
        const uA = uIndexMap.has(netA) ? uIndexMap.get(netA) : -1;
        const uB = uIndexMap.has(netB) ? uIndexMap.get(netB) : -1;

        if (uA !== -1) {
          G[uA][uA] += cond;
          isConnectedToCircuit[uA] = 1;
          if (uB !== -1) {
            G[uA][uB] -= cond;
          } else {
            // netB is a fixed voltage source!
            I[uA] += cond * netB.voltage;
          }
        }

        if (uB !== -1) {
          G[uB][uB] += cond;
          isConnectedToCircuit[uB] = 1;
          if (uA !== -1) {
            G[uB][uA] -= cond;
          } else {
            // netA is a fixed voltage source!
            I[uB] += cond * netA.voltage;
          }
        }
      });

      // Solve G * V = I using Gaussian Elimination with partial pivoting
      const V_solved = solveLinearSystem(G, I, m);

      unknownNets.forEach((net, i) => {
        if (isConnectedToCircuit[i] && Number.isFinite(V_solved[i])) {
          net.voltage = Math.round(V_solved[i] * 1000) / 1000; // 3 decimal places
          net.isFloating = false;
        } else {
          net.voltage = 0.0;
          net.isFloating = true;
        }
      });
    }

    // Build fast lookup map
    const netVoltageMap = new Map();
    nets.forEach((net) => {
      netVoltageMap.set(net.rootKey, net.voltage);
    });

    return {
      nets,
      netVoltageMap,
      solved: true,
      getPinVoltage: (pinEndpoint) => {
        const net = findNetForEndpoint(pinEndpoint, nets);
        return net ? net.voltage : 0.0;
      },
    };
  }

  // Gaussian elimination with partial pivoting for m x m linear system
  function solveLinearSystem(A, b, n) {
    const x = new Float64Array(n);
    // Forward elimination
    for (let i = 0; i < n; i++) {
      // Find pivot
      let maxRow = i;
      let maxVal = Math.abs(A[i][i]);
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(A[k][i]) > maxVal) {
          maxVal = Math.abs(A[k][i]);
          maxRow = k;
        }
      }

      if (maxVal < 1e-12) {
        // Singular or disconnected node
        continue;
      }

      // Swap rows
      if (maxRow !== i) {
        const tempRow = A[i];
        A[i] = A[maxRow];
        A[maxRow] = tempRow;
        const tempB = b[i];
        b[i] = b[maxRow];
        b[maxRow] = tempB;
      }

      // Eliminate
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(A[k][i]) < 1e-12) continue;
        const factor = A[k][i] / A[i][i];
        for (let j = i; j < n; j++) {
          A[k][j] -= factor * A[i][j];
        }
        b[k] -= factor * b[i];
      }
    }

    // Back substitution
    for (let i = n - 1; i >= 0; i--) {
      if (Math.abs(A[i][i]) < 1e-12) {
        x[i] = 0.0;
        continue;
      }
      let sum = b[i];
      for (let j = i + 1; j < n; j++) {
        sum -= A[i][j] * x[j];
      }
      x[i] = sum / A[i][i];
    }

    return x;
  }

  function findNetForEndpoint(endpoint, nets) {
    if (!endpoint) return null;
    const epKey = typeof window.endpointKey === 'function' ? window.endpointKey(endpoint) : null;
    if (!epKey) return null;

    for (const net of nets) {
      if (net.pins.some((p) => p.endpoint === endpoint || (typeof window.endpointKey === 'function' && window.endpointKey(p.endpoint) === epKey))) {
        return net;
      }
    }
    return null;
  }

  function formatResistanceShort(ohms) {
    if (ohms >= 1e6) return `${(ohms / 1e6).toFixed(1).replace(/\.0$/, '')}MΩ`;
    if (ohms >= 1e3) return `${(ohms / 1e3).toFixed(1).replace(/\.0$/, '')}kΩ`;
    return `${Math.round(ohms)}Ω`;
  }

  // ==========================================================================
  // 2. INSTANT WRONG CONNECTION VALIDATOR
  // ==========================================================================

  function checkInstantConnection(newWire) {
    if (!newWire) return;
    const nets = typeof window.computeElectricalNets === 'function' ? window.computeElectricalNets() : [];

    // Find the net that this wire belongs to
    const targetNet = nets.find((net) => net.wires.some((w) => w.id === newWire.id));
    if (!targetNet) return;

    const pins = targetNet.pins || [];

    // Rule 1: Dead Short Circuit (Power to Ground)
    const powerPins = pins.filter((p) => p.type === 'power' || (p.label || '').toLowerCase().includes('vcc') || (p.label || '').toLowerCase().includes('5v') || (p.label || '').toLowerCase().includes('3v3') || (p.label || '').toLowerCase().includes('9v'));
    const groundPins = pins.filter((p) => p.type === 'ground' || (p.label || '').toLowerCase().includes('gnd') || p.label === '-');

    if (powerPins.length > 0 && groundPins.length > 0) {
      const p = powerPins[0];
      const g = groundPins[0];
      triggerInstantWarning({
        severity: 'critical',
        title: '🚨 DEAD SHORT CIRCUIT DETECTED!',
        message: `Direct short between Power (${p.partName} [${p.label}]) and Ground (${g.partName} [${g.label}])! This will fry power supplies or cause a fire in hardware.`,
        wire: newWire,
      });
      return;
    }

    // Rule 2: Voltage Rail Clash (e.g. 5V rail connected to 3.3V rail or 9V rail)
    const has5V = pins.some((p) => (p.label || '').toLowerCase().includes('5v') || (p.label || '').toLowerCase() === 'vcc');
    const has3V3 = pins.some((p) => (p.label || '').toLowerCase().includes('3v3') || (p.label || '').toLowerCase().includes('3.3'));
    const has9V = pins.some((p) => (p.label || '').toLowerCase().includes('9v'));

    if (has5V && has3V3) {
      triggerInstantWarning({
        severity: 'warning',
        title: '⚠️ VOLTAGE RAIL CONFLICT!',
        message: 'A +5.0V power rail is tied directly to a +3.3V power rail without a level shifter or regulator! 3.3V logic will be damaged.',
        wire: newWire,
      });
      return;
    }

    if (has9V && (has5V || has3V3)) {
      triggerInstantWarning({
        severity: 'critical',
        title: '🚨 HIGH VOLTAGE RAIL CLASH!',
        message: 'A +9V Battery rail is connected directly to a +5V or +3.3V rail! Excessive voltage will instantly destroy logic microcontrollers.',
        wire: newWire,
      });
      return;
    }

    // Rule 3: Direct LED Short (LED connected to VCC and GND with no resistor in net)
    const ledPins = pins.filter((p) => p.def?.id === 'led-5mm-red');
    if (ledPins.length > 0) {
      // Check if LED is in a circuit with power and ground but zero resistance
      const hasPower = powerPins.length > 0;
      const hasGnd = groundPins.length > 0;
      // If the same net has power or ground directly touching the LED pin
      // Check if another wire directly grounds the cathode while anode is on 5V
      if (hasPower || hasGnd) {
        checkLedDirectConnection(newWire);
      }
    }
  }

  function checkLedDirectConnection(newWire) {
    const stage = getKonvaStage();
    if (!stage) return;
    const leds = stage.find('.component').filter((c) => c.getAttr('defId') === 'led-5mm-red');
    leds.forEach((led) => {
      const pins = led.find('.pin') || [];
      const anode = pins.find((p) => p.getAttr('pinId') === 'anode');
      const cathode = pins.find((p) => p.getAttr('pinId') === 'cathode');
      if (!anode || !cathode) return;

      const nets = typeof window.computeElectricalNets === 'function' ? window.computeElectricalNets() : [];
      const anodeNet = findNetForEndpoint(anode, nets);
      const cathodeNet = findNetForEndpoint(cathode, nets);

      if (anodeNet && cathodeNet && anodeNet !== cathodeNet) {
        const anodeHasPower = anodeNet.pins.some((p) => p.type === 'power' && p.group !== led);
        const cathodeHasGnd = cathodeNet.pins.some((p) => p.type === 'ground' && p.group !== led);

        // Check if there are any resistors in the entire path
        const components = stage.find('.component') || [];
        const hasResistor = components.some((c) => c.getAttr('defId') === 'resistor-variable');

        if (anodeHasPower && cathodeHasGnd && !hasResistor) {
          triggerInstantWarning({
            severity: 'warning',
            title: '⚠️ OVERCURRENT: LED WITHOUT RESISTOR!',
            message: '5mm Red LED is wired directly across power and ground without a current-limiting resistor! The LED will burn out immediately. Add a 220Ω resistor in series.',
            wire: newWire,
          });
        }

        // Reverse polarity check
        const anodeHasGnd = anodeNet.pins.some((p) => p.type === 'ground' && p.group !== led);
        const cathodeHasPower = cathodeNet.pins.some((p) => p.type === 'power' && p.group !== led);
        if (anodeHasGnd && cathodeHasPower) {
          triggerInstantWarning({
            severity: 'warning',
            title: '⚠️ REVERSE POLARITY: LED CONNECTED BACKWARDS!',
            message: 'LED Anode (+) is wired to Ground and Cathode (-) is wired to Power! The LED is reverse-biased and will not light up.',
            wire: newWire,
          });
        }
      }
    });
  }

  let toastDismissTimer = null;
  function triggerInstantWarning({ severity, title, message, wire }) {
    playAlertBeep(severity === 'critical');

    // Visual pulse on the faulty wire
    if (wire && wire.line) {
      const origStroke = wire.line.stroke();
      const origWidth = wire.line.strokeWidth();
      wire.line.stroke('#ef4444');
      wire.line.strokeWidth(4);
      wire.line.dash([6, 6]);
      if (window.wireLayer) window.wireLayer.batchDraw();

      setTimeout(() => {
        if (wire.line && wire.line.parent) {
          wire.line.stroke(origStroke);
          wire.line.strokeWidth(origWidth);
          wire.line.dash([]);
          if (window.wireLayer) window.wireLayer.batchDraw();
        }
      }, 3500);
    }

    const toast = document.getElementById('instant-warning-toast');
    const toastTitle = toast?.querySelector('.instant-warning-title');
    const toastMsg = toast?.querySelector('.instant-warning-message');
    const undoBtn = document.getElementById('instant-warning-undo');

    if (toast && toastTitle && toastMsg) {
      toastTitle.textContent = title;
      toastMsg.textContent = message;
      toast.className = `instant-warning-toast ${severity === 'critical' ? 'critical' : 'warning'}`;
      toast.hidden = false;

      if (undoBtn) {
        undoBtn.onclick = () => {
          if (wire && typeof window.removeWire === 'function') {
            window.removeWire(wire);
            toast.hidden = true;
            if (typeof window.setStatus === 'function') {
              window.setStatus('Faulty wire safely removed', false);
            }
          }
        };
      }

      clearTimeout(toastDismissTimer);
      // Auto-dismiss after 9 seconds if not interacted
      toastDismissTimer = setTimeout(() => {
        toast.hidden = true;
      }, 9000);
    }

    // Refresh Diagnostics counter in toolbar
    if (typeof window.updateWiringCheckIndicator === 'function') {
      window.updateWiringCheckIndicator();
    }
  }

  // ==========================================================================
  // 3. DIGITAL MULTIMETER SYSTEM (DMM-800)
  // ==========================================================================

  let multimeterActive = false;
  let activeProbeLead = 'red'; // 'red' or 'black'

  // Probe locations: can be a pin endpoint { type: 'pin', endpoint, pinId, partName }
  // or a wire { type: 'wire', wire }
  let probeRed = null;
  let probeBlack = null; // null represents default Circuit Ground

  const multimeterHud = document.getElementById('multimeter-hud');
  const multimeterBtn = document.getElementById('multimeter-btn');
  const dmmDigits = document.getElementById('multimeter-digits');
  const dmmSign = document.getElementById('multimeter-sign');
  const dmmBargraph = document.getElementById('multimeter-bargraph');
  const dmmRedLabel = document.getElementById('dmm-red-label');
  const dmmBlkLabel = document.getElementById('dmm-blk-label');
  const dmmProbeRedBtn = document.getElementById('dmm-probe-red-btn');
  const dmmProbeBlkBtn = document.getElementById('dmm-probe-blk-btn');

  function toggleMultimeter(forceState = null) {
    multimeterActive = forceState !== null ? forceState : !multimeterActive;
    window.multimeterActive = multimeterActive;

    if (multimeterBtn) {
      multimeterBtn.classList.toggle('active', multimeterActive);
      multimeterBtn.setAttribute('aria-pressed', multimeterActive ? 'true' : 'false');
    }

    if (multimeterHud) {
      multimeterHud.hidden = !multimeterActive;
      if (multimeterActive) {
        updateMultimeterReading();
        renderProbeMarkers();
      } else {
        clearProbeMarkers();
      }
    }

    const container = getStageContainer();
    if (container) {
      container.style.cursor = multimeterActive ? 'crosshair' : 'default';
    }
  }

  function setActiveProbeLead(lead) {
    activeProbeLead = lead;
    if (dmmProbeRedBtn) dmmProbeRedBtn.classList.toggle('active', lead === 'red');
    if (dmmProbeBlkBtn) dmmProbeBlkBtn.classList.toggle('active', lead === 'black');
  }

  function normalizeProbeTarget(target) {
    if (!target) return null;
    if (target.type === 'pin') {
      let instanceId = target.instanceId;
      if (!instanceId && target.group && typeof target.group.getAttr === 'function') {
        instanceId = target.group.getAttr('instanceId');
      } else if (!instanceId && target.endpoint && typeof target.endpoint.getParent === 'function') {
        const p = target.endpoint.getParent();
        if (p && typeof p.getAttr === 'function') instanceId = p.getAttr('instanceId');
      }
      return {
        type: 'pin',
        endpoint: target.endpoint,
        pinId: target.pinId,
        instanceId: instanceId || '',
        partName: target.partName || 'Pin',
      };
    } else if (target.type === 'wire') {
      return {
        type: 'wire',
        wire: target.wire,
        wireId: target.wire?.id || target.wireId || '',
      };
    }
    return null;
  }

  function setProbeTarget(lead, target) {
    const norm = normalizeProbeTarget(target);
    if (lead === 'red') {
      probeRed = norm;
    } else {
      probeBlack = norm;
    }
    updateMultimeterReading();
    renderProbeMarkers();
  }

  function rebindProbes() {
    const stage = getKonvaStage();

    function rebindTarget(target) {
      if (!target) return null;
      try {
        if (target.type === 'pin') {
          if (!stage) return null;
          if (target.endpoint && target.endpoint.parent && typeof target.endpoint.getAbsolutePosition === 'function') {
            return target;
          }
          if (!target.instanceId || !target.pinId) return null;
          const comps = stage.find('.component') || [];
          const comp = comps.find((c) => c.getAttr('instanceId') === target.instanceId);
          if (!comp) return null;
          const pins = comp.find('.pin') || [];
          const pin = pins.find((p) => p.getAttr('pinId') === target.pinId);
          if (!pin) return null;
          return {
            type: 'pin',
            endpoint: pin,
            pinId: target.pinId,
            instanceId: target.instanceId,
            partName: target.partName,
          };
        } else if (target.type === 'wire') {
          if (target.wire && window.wires && window.wires.includes(target.wire)) {
            return target;
          }
          if (!target.wireId || !window.wires) return null;
          const w = window.wires.find((item) => item.id === target.wireId);
          if (!w) return null;
          return {
            type: 'wire',
            wire: w,
            wireId: target.wireId,
          };
        }
      } catch (_) {}
      return null;
    }

    probeRed = rebindTarget(probeRed);
    probeBlack = rebindTarget(probeBlack);
    updateMultimeterReading();
    renderProbeMarkers();
  }

  function updateMultimeterReading() {
    if (!multimeterActive || window.replayingHistory) return;

    try {
      const { getPinVoltage, nets } = solveCircuitVoltages();

      // 1. Calculate Red probe potential
      let vRed = 0.0;
      let labelRed = 'Not Connected';
      if (probeRed) {
        if (probeRed.type === 'pin' && probeRed.endpoint && probeRed.endpoint.parent) {
          vRed = typeof getPinVoltage === 'function' ? getPinVoltage(probeRed.endpoint) : 0.0;
          labelRed = `${probeRed.partName} [${probeRed.pinId}] (${vRed >= 0 ? '+' : ''}${vRed.toFixed(2)}V)`;
        } else if (probeRed.type === 'wire' && probeRed.wire) {
          const net = nets.find((n) => n.wires.some((w) => w.id === probeRed.wire.id));
          vRed = net ? net.voltage : 0.0;
          labelRed = `Wire: ${net ? net.title : 'Net'} (${vRed >= 0 ? '+' : ''}${vRed.toFixed(2)}V)`;
        }
      }

      // 2. Calculate Black probe potential
      let vBlack = 0.0;
      let labelBlack = 'Circuit GND (0.00V)';
      if (probeBlack) {
        if (probeBlack.type === 'pin' && probeBlack.endpoint && probeBlack.endpoint.parent) {
          vBlack = typeof getPinVoltage === 'function' ? getPinVoltage(probeBlack.endpoint) : 0.0;
          labelBlack = `${probeBlack.partName} [${probeBlack.pinId}] (${vBlack >= 0 ? '+' : ''}${vBlack.toFixed(2)}V)`;
        } else if (probeBlack.type === 'wire' && probeBlack.wire) {
          const net = nets.find((n) => n.wires.some((w) => w.id === probeBlack.wire.id));
          vBlack = net ? net.voltage : 0.0;
          labelBlack = `Wire: ${net ? net.title : 'Net'} (${vBlack >= 0 ? '+' : ''}${vBlack.toFixed(2)}V)`;
        }
      }

      // 3. Difference V = V(Red) - V(Black)
      let vDiff = vRed - vBlack;
      if (Math.abs(vDiff) < 1e-4) vDiff = 0.0;

      // Display updates
      if (dmmDigits && dmmSign) {
        if (!probeRed && !probeBlack) {
          dmmSign.textContent = ' ';
          dmmDigits.textContent = '0.000';
        } else {
          dmmSign.textContent = vDiff < 0 ? '-' : '+';
          dmmDigits.textContent = Math.abs(vDiff).toFixed(3);
        }
      }

      if (dmmBargraph) {
        // Scale 0 .. 9V
        const percent = Math.min(100, Math.max(0, (Math.abs(vDiff) / 9.0) * 100));
        dmmBargraph.style.width = `${percent.toFixed(1)}%`;
        dmmBargraph.style.background = vDiff < 0 ? '#f43f5e' : '#22d3ee';
      }

      if (dmmRedLabel) dmmRedLabel.textContent = labelRed;
      if (dmmBlkLabel) dmmBlkLabel.textContent = labelBlack;
    } catch (_) {}
  }

  // ==========================================================================
  // 4. KONVA PROBE MARKERS VISUALIZATION
  // ==========================================================================

  let probeGroupRed = null;
  let probeGroupBlk = null;

  function renderProbeMarkers() {
    if (!window.overlay || !multimeterActive || window.replayingHistory) return;

    clearProbeMarkers();

    try {
      if (probeRed) {
        const pos = getTargetCenter(probeRed);
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
          probeGroupRed = createProbeMarker('red', '+V', pos);
          window.overlay.add(probeGroupRed);
        }
      }

      if (probeBlack) {
        const pos = getTargetCenter(probeBlack);
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
          probeGroupBlk = createProbeMarker('black', 'COM', pos);
          window.overlay.add(probeGroupBlk);
        }
      }

      window.overlay.batchDraw();
    } catch (_) {}
  }

  function clearProbeMarkers() {
    try {
      if (probeGroupRed) {
        probeGroupRed.destroy();
        probeGroupRed = null;
      }
      if (probeGroupBlk) {
        probeGroupBlk.destroy();
        probeGroupBlk = null;
      }
      if (window.overlay) window.overlay.batchDraw();
    } catch (_) {}
  }

  function getTargetCenter(target) {
    if (!target) return null;
    try {
      if (target.type === 'pin' && target.endpoint) {
        if (!target.endpoint.parent) return null;
        if (typeof window.pinPos === 'function') {
          return window.pinPos(target.endpoint);
        }
      } else if (target.type === 'wire' && target.wire) {
        if (!window.wires || !window.wires.includes(target.wire)) return null;
        if (typeof window.wirePoints === 'function') {
          const pts = window.wirePoints(target.wire);
          if (pts && pts.length >= 2) {
            const numPoints = Math.floor(pts.length / 2);
            const midPointIdx = Math.floor(numPoints / 2) * 2;
            return { x: pts[midPointIdx], y: pts[midPointIdx + 1] };
          }
        }
      }
    } catch (_) {}
    return null;
  }

  function createProbeMarker(type, text, pos) {
    const isRed = type === 'red';
    const mainColor = isRed ? '#ef4444' : '#1e293b';
    const accentColor = isRed ? '#fee2e2' : '#cbd5e1';
    const glowColor = isRed ? 'rgba(239, 68, 68, 0.6)' : 'rgba(148, 163, 184, 0.5)';

    const group = new Konva.Group({
      x: pos.x,
      y: pos.y,
      listening: false,
    });

    // Needle shadow / glow
    group.add(
      new Konva.Circle({
        radius: 14,
        fill: glowColor,
        shadowColor: mainColor,
        shadowBlur: 10,
        shadowOpacity: 0.8,
      })
    );

    // Needle body pin
    group.add(
      new Konva.Circle({
        radius: 9,
        fill: mainColor,
        stroke: '#ffffff',
        strokeWidth: 2,
      })
    );

    // Needle pointer badge
    group.add(
      new Konva.Text({
        text: text,
        fontSize: 8.5,
        fontFamily: "'JetBrains Mono', monospace",
        fontStyle: 'bold',
        fill: accentColor,
        align: 'center',
        verticalAlign: 'middle',
        offsetX: text.length > 2 ? 8 : 6,
        offsetY: 4,
      })
    );

    return group;
  }

  // ==========================================================================
  // 5. DRAGGABLE MULTIMETER WINDOW & INITIALIZATION
  // ==========================================================================

  function initMultimeterHUD() {
    if (!multimeterHud) return;

    // Draggable handling by header
    const header = multimeterHud.querySelector('.multimeter-header');
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let initialLeft = 0, initialTop = 0;

    if (header) {
      header.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        const rect = multimeterHud.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        multimeterHud.style.transition = 'none';
        multimeterHud.style.right = 'auto';
        multimeterHud.style.bottom = 'auto';
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        const newLeft = Math.max(10, Math.min(window.innerWidth - 320, initialLeft + dx));
        const newTop = Math.max(60, Math.min(window.innerHeight - 380, initialTop + dy));
        multimeterHud.style.left = `${newLeft}px`;
        multimeterHud.style.top = `${newTop}px`;
      });

      window.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          multimeterHud.style.transition = '';
        }
      });
    }

    // Probe selector buttons
    if (dmmProbeRedBtn) {
      dmmProbeRedBtn.addEventListener('click', () => setActiveProbeLead('red'));
    }
    if (dmmProbeBlkBtn) {
      dmmProbeBlkBtn.addEventListener('click', () => setActiveProbeLead('black'));
    }

    // Quick Action: Reference to GND
    const refGndBtn = document.getElementById('dmm-ref-gnd-btn');
    if (refGndBtn) {
      refGndBtn.addEventListener('click', () => {
        probeBlack = null; // Ground
        updateMultimeterReading();
        renderProbeMarkers();
      });
    }

    // Quick Action: Swap probes
    const swapProbesBtn = document.getElementById('dmm-swap-probes-btn');
    if (swapProbesBtn) {
      swapProbesBtn.addEventListener('click', () => {
        const temp = probeRed;
        probeRed = probeBlack;
        probeBlack = temp;
        updateMultimeterReading();
        renderProbeMarkers();
      });
    }

    // Quick Action: Reset probes
    const clearProbesBtn = document.getElementById('dmm-clear-probes-btn');
    if (clearProbesBtn) {
      clearProbesBtn.addEventListener('click', () => {
        probeRed = null;
        probeBlack = null;
        updateMultimeterReading();
        renderProbeMarkers();
      });
    }

    // Close button
    const closeBtn = document.getElementById('multimeter-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => toggleMultimeter(false));
    }

    // Minimize button
    const minBtn = document.getElementById('multimeter-minimize-btn');
    if (minBtn) {
      minBtn.addEventListener('click', () => {
        multimeterHud.classList.toggle('minimized');
      });
    }

    // Dismiss toast button
    const dismissBtn = document.getElementById('instant-warning-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        const toast = document.getElementById('instant-warning-toast');
        if (toast) toast.hidden = true;
      });
    }
  }

  // ==========================================================================
  // 6. GLOBAL HOOKS & EXPORTS
  // ==========================================================================

  window.multimeter = {
    toggle: toggleMultimeter,
    update: updateMultimeterReading,
    rebindProbes: rebindProbes,
    solveVoltages: solveCircuitVoltages,
    onWireAdded: checkInstantConnection,
    handleCanvasClick: (target) => {
      if (!multimeterActive || !target) return false;
      setProbeTarget(activeProbeLead, target);
      return true;
    },
  };

  // Attach toolbar button listener
  if (multimeterBtn) {
    multimeterBtn.addEventListener('click', () => toggleMultimeter());
  }

  // Hotkey 'M' for Multimeter
  window.addEventListener('keydown', (e) => {
    if (typeof window.isTyping === 'function' && window.isTyping(e)) return;
    if (e.key === 'm' || e.key === 'M') {
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        toggleMultimeter();
      }
    }
  });

  // Initialize once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMultimeterHUD);
  } else {
    initMultimeterHUD();
  }
})();
