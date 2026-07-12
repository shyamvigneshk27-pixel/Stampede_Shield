/**
 * StampedeShield - Frontend Application Controller
 * Manages WebSocket connection, handles page routing, renders dashboards & heatmaps,
 * tracks status timelines, gates operational statuses, and connected clients.
 */

/* ═══════════════════════════════════════════════════════
   PAGE ROUTER
   ═══════════════════════════════════════════════════════ */
const Router = (() => {
  const pages = document.querySelectorAll('.page');
  const navItems = document.querySelectorAll('.nav-item');
  const breadcrumb = document.getElementById('breadcrumb-section');
  const pageNames = {
    dashboard:     'Dashboard',
    heatmap:       'Pressure Heatmap',
    ai:            'AI Prediction Center',
    venue:         'Venue Map',
    incident:      'Incident Center',
    devices:       'Device Monitoring',
    analytics:     'Analytics',
    notifications: 'Notifications',
    settings:      'Settings'
  };

  let current = 'dashboard';

  function navigate(pageId) {
    if (pageId === current) return;
    current = pageId;

    pages.forEach(p => p.classList.remove('active'));
    navItems.forEach(n => n.classList.remove('active'));

    const targetPage = document.getElementById('page-' + pageId);
    const targetNav  = document.querySelector(`.nav-item[data-page="${pageId}"]`);

    if (targetPage) targetPage.classList.add('active');
    if (targetNav)  targetNav.classList.add('active');
    if (breadcrumb) breadcrumb.textContent = pageNames[pageId] || pageId;

    // Trigger canvas resizing
    if (pageId === 'heatmap')   setTimeout(() => PageControllers.resizeHeatmapPage(), 50);
    if (pageId === 'ai')        setTimeout(() => PageControllers.resizeAICanvas(), 50);
    if (pageId === 'analytics') setTimeout(() => PageControllers.resizeAnalyticsCanvas(), 50);
  }

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.page));
  });

  const sidebar = document.getElementById('sidebar');
  const collapseBtn = document.getElementById('sidebar-collapse-btn');
  if (collapseBtn && sidebar) {
    collapseBtn.addEventListener('click', () => sidebar.classList.toggle('collapsed'));
  }

  return { navigate, getCurrent: () => current };
})();

/* ═══════════════════════════════════════════════════════
   LIVE CLOCK
   ═══════════════════════════════════════════════════════ */
(function startClock() {
  const el = document.getElementById('topbar-clock');
  function tick() {
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleTimeString('en-IN', { hour12: false });
  }
  tick();
  setInterval(tick, 1000);
})();

// Per-sensor maximum ADC values (measured at full pressure with 220Ω resistor)
// Must match SENSOR_MAX in app_lab/main.py and ml/lstm_inference.py
const SENSOR_MAX = [515, 1023, 575, 630, 570, 210];

// Returns 0.0-1.0 normalized load for sensor i
function sensorLoad(rawVal, sensorIdx) {
  return Math.max(0, Math.min(1, rawVal / SENSOR_MAX[sensorIdx]));
}

/* ═══════════════════════════════════════════════════════
   PAGE RENDERING & STATE CONTROLLER
   ═══════════════════════════════════════════════════════ */
const PageControllers = (() => {
  let latestSensors  = [0,0,0,0,0,0];
  let latestAnalysis  = null;

  // Buffers
  const incidentLog = [];
  const notifLog = [];
  const statusTransitions = []; // rolling timeline limit 15
  
  // Analytics variables
  let peakPressure = 0;
  let minPressure = Infinity;
  let totalSamples = 0;
  let criticalCount = 0;
  let runningSum = 0;
  let runningSD = 0;

  // Heatmap Page Canvas context
  let heatmapPageCanvas = null;
  let heatmapPageCtx = null;
  let heatmapPageOff = null;
  let heatmapPageOffCtx = null;

  function initHeatmapPage() {
    heatmapPageCanvas = document.getElementById('heatmap-page-canvas');
    if (!heatmapPageCanvas) return;
    heatmapPageCtx = heatmapPageCanvas.getContext('2d');
    heatmapPageOff = document.createElement('canvas');
    heatmapPageOff.width  = 32;
    heatmapPageOff.height = 16;
    heatmapPageOffCtx = heatmapPageOff.getContext('2d');
  }

  function resizeHeatmapPage() {
    if (!heatmapPageCanvas) initHeatmapPage();
    if (!heatmapPageCanvas) return;
    const rect = heatmapPageCanvas.parentNode.getBoundingClientRect();
    heatmapPageCanvas.width  = rect.width  * window.devicePixelRatio;
    heatmapPageCanvas.height = rect.height * window.devicePixelRatio;
    heatmapPageCanvas.style.width  = '100%';
    heatmapPageCanvas.style.height = '100%';
    heatmapPageCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
    drawHeatmapPage();
  }

  function drawHeatmapPage() {
    if (!heatmapPageCanvas || !heatmapPageCtx || !heatmapPageOffCtx) return;
    drawBilinearHeatmap(heatmapPageCtx, heatmapPageOff, heatmapPageOffCtx,
      heatmapPageCanvas.width / window.devicePixelRatio,
      heatmapPageCanvas.height / window.devicePixelRatio,
      latestSensors);
  }

  // AI & Analytics Canvases
  let aiCanvas = null;
  let aiCtx = null;
  let anCanvas = null;
  let anCtx = null;

  function resizeAICanvas() {
    aiCanvas = document.getElementById('ai-trend-canvas');
    if (!aiCanvas) return;
    aiCtx = aiCanvas.getContext('2d');
    const rect = aiCanvas.parentNode.getBoundingClientRect();
    aiCanvas.width  = rect.width  * window.devicePixelRatio;
    aiCanvas.height = rect.height * window.devicePixelRatio;
    aiCanvas.style.width  = '100%';
    aiCanvas.style.height = '100%';
    aiCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
    if (window.drawTrendGraph) {
      window.drawTrendGraph(aiCanvas, aiCtx);
    }
  }

  function resizeAnalyticsCanvas() {
    anCanvas = document.getElementById('analytics-canvas');
    if (!anCanvas) return;
    anCtx = anCanvas.getContext('2d');
    const rect = anCanvas.parentNode.getBoundingClientRect();
    anCanvas.width  = rect.width  * window.devicePixelRatio;
    anCanvas.height = rect.height * window.devicePixelRatio;
    anCanvas.style.width  = '100%';
    anCanvas.style.height = '100%';
    anCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
    if (window.drawTrendGraph) {
      window.drawTrendGraph(anCanvas, anCtx);
    }
  }

  // Premium Heatmap Color mapping — input: normalized load 0.0–1.0
  function getColorForPressure(norm) {
    const t = Math.max(0, Math.min(1, norm));
    let r, g, b;
    if (t <= 0.20) {
      const w = t / 0.20;
      r = Math.round(30  + w * (46  - 30));
      g = Math.round(180 + w * (204 - 180));
      b = Math.round(60  + w * (64  - 60));
    } else if (t <= 0.40) {
      const w = (t - 0.20) / 0.20;
      r = Math.round(46  + w * (180 - 46));
      g = Math.round(204 + w * (220 - 204));
      b = Math.round(64  + w * (40  - 64));
    } else if (t <= 0.55) {
      const w = (t - 0.40) / 0.15;
      r = Math.round(180 + w * (255 - 180));
      g = Math.round(220 + w * (214 - 220));
      b = Math.round(40  + w * (10  - 40));
    } else if (t <= 0.70) {
      const w = (t - 0.55) / 0.15;
      r = 255;
      g = Math.round(214 + w * (140 - 214));
      b = Math.round(10  + w * (0   - 10));
    } else if (t <= 0.85) {
      const w = (t - 0.70) / 0.15;
      r = Math.round(255 + w * (235 - 255));
      g = Math.round(140 + w * (55  - 140));
      b = Math.round(0   + w * (20  - 0));
    } else {
      const w = (t - 0.85) / 0.15;
      r = Math.round(235 + w * (200 - 235));
      g = Math.round(55  + w * (20  - 55));
      b = Math.round(20  + w * (30  - 20));
    }
    return [r, g, b];
  }

  // Draw Heatmap and Dynamic Direction Arrows on Canvas
  function drawBilinearHeatmap(ctx, offCanvas, offCtx, w, h, sensors) {
    const COLS = 12, ROWS = 6;
    const GAP = 3;
    const RADIUS = 5;
    const [F1,F2,F3,F4,F5,F6] = sensors;

    // Normalize each sensor reading by its own physical max
    const norms = sensors.map((v, i) => sensorLoad(v, i)); // [0..1] each
    const [N1,N2,N3,N4,N5,N6] = norms;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0B1120';
    ctx.fillRect(0, 0, w, h);

    const cellW = (w - GAP * (COLS + 1)) / COLS;
    const cellH = (h - GAP * (ROWS + 1)) / ROWS;

    for (let row = 0; row < ROWS; row++) {
      const ny = row / (ROWS - 1);
      for (let col = 0; col < COLS; col++) {
        const nx = col / (COLS - 1);
        let norm;
        // Bilinear interpolation of normalized loads
        if (nx <= 0.5) {
          const u = nx * 2;
          norm = (1-u)*(1-ny)*N1 + u*(1-ny)*N2 + (1-u)*ny*N4 + u*ny*N5;
        } else {
          const u = (nx - 0.5) * 2;
          norm = (1-u)*(1-ny)*N2 + u*(1-ny)*N3 + (1-u)*ny*N5 + u*ny*N6;
        }

        const [r,g,b] = getColorForPressure(norm);
        const x = GAP + col * (cellW + GAP);
        const y = GAP + row * (cellH + GAP);

        // Draw shadow glow
        ctx.shadowColor = `rgba(${r},${g},${b},${0.3 + norm * 0.5})`;
        ctx.shadowBlur = 6 + norm * 10;

        ctx.beginPath();
        ctx.roundRect(x, y, cellW, cellH, RADIUS);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fill();

        // Inner highlight
        const hlGrad = ctx.createLinearGradient(x, y, x + cellW * 0.5, y + cellH * 0.5);
        hlGrad.addColorStop(0, `rgba(255,255,255,${0.18 - norm * 0.08})`);
        hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.beginPath();
        ctx.roundRect(x, y, cellW, cellH, RADIUS);
        ctx.fillStyle = hlGrad;
        ctx.fill();

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }
    }

    // Overlay sensor identifier labels & values
    const sensorPositions = [
      {label:'F1', col:1.5,  row:1},
      {label:'F2', col:5.5,  row:1},
      {label:'F3', col:10,   row:1},
      {label:'F4', col:1.5,  row:4.5},
      {label:'F5', col:5.5,  row:4.5},
      {label:'F6', col:10,   row:4.5}
    ];

    ctx.font = `600 ${Math.max(10, Math.min(14, cellH * 0.45))}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    sensorPositions.forEach(({label, col, row}, i) => {
      const cx = GAP + col * (cellW + GAP) + cellW / 2;
      const cy = GAP + row * (cellH + GAP) + cellH / 2;
      const val  = sensors[i];
      const norm = norms[i];
      const pct  = Math.round(norm * 100);

      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillText(label, cx + 1, cy + 1);
      ctx.fillStyle = norm > 0.5 ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.85)';
      ctx.fillText(label, cx, cy);

      ctx.font = `500 ${Math.max(8, Math.min(11, cellH * 0.32))}px Inter, sans-serif`;
      ctx.fillStyle = norm > 0.5 ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.6)';
      ctx.fillText(`${val} (${pct}%)`, cx, cy + cellH * 0.55);
      ctx.font = `600 ${Math.max(10, Math.min(14, cellH * 0.45))}px Inter, sans-serif`;
    });

    // ── SHIELD DIRECTION ARROW OVERLAY ────────────────────────────
    // Use normalized loads for gradient direction (physically meaningful)
    const dx = (N3 - N1 + N6 - N4) / 2;
    const dy = (N4 - N1 + N5 - N2 + N6 - N3) / 3;
    const magnitude = Math.sqrt(dx * dx + dy * dy);

    // Draw compression direction arrows if normalized gradient > 0.15
    if (magnitude > 0.15) {
      const cx = w / 2;
      const cy = h / 2;
      const angle = Math.atan2(dy, dx);
      
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      
      // Draw dynamic chevron arrows
      ctx.shadowColor = 'rgba(255, 0, 0, 0.8)';
      ctx.shadowBlur = 15;
      
      ctx.strokeStyle = '#FF0000';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      ctx.beginPath();
      ctx.moveTo(-20, -15);
      ctx.lineTo(10, 0);
      ctx.lineTo(-20, 15);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(-40, -15);
      ctx.lineTo(-10, 0);
      ctx.lineTo(-40, 15);
      ctx.stroke();
      
      ctx.restore();
    }
  }

  // Handle updates on each WebSocket frame
  function onTelemetry(sensors, analysis) {
    latestSensors = [...sensors];
    latestAnalysis = analysis;

    totalSamples++;
    const avg = sensors.reduce((a,b)=>a+b,0) / sensors.length;
    const peak = Math.max(...sensors);
    if (peak > peakPressure) peakPressure = peak;
    if (peak < minPressure) minPressure = peak;
    runningSum += avg;
    runningSD = analysis ? (analysis.spatialStdDev || 0) : 0;
    if (analysis && analysis.riskScore >= 70) criticalCount++;

    updateKPIs(analysis);
    updateRiskDetails(analysis);
    updateTimeline(analysis);
    updateSensorHealth(sensors);
    updateHeatmapSidebar(sensors);
    updateAIPage(analysis);
    updateVenuePage(sensors, analysis);
    updateDevicePage(analysis);
    updateAnalyticsPage(analysis);
    logNotifications(analysis);
    drawHeatmapPage();

    // Render graphs if active
    if (window.drawTrendGraph) {
      const current = Router.getCurrent();
      if (current === 'ai' && aiCanvas && aiCtx) {
        window.drawTrendGraph(aiCanvas, aiCtx);
      } else if (current === 'analytics' && anCanvas && anCtx) {
        window.drawTrendGraph(anCanvas, anCtx);
      }
    }
  }

  // KPI Hero updates
  function updateKPIs(analysis) {
    if (!analysis) return;
    const setText = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
    setText('overall-status-val', analysis.crowdStatus);
    setText('overall-status-desc', analysis.crowdStatusDesc);

    // Color code overall status KPI block background border
    const overallCard = document.getElementById('kpi-overall-status');
    const kpiIcon = document.getElementById('kpi-status-icon');
    if (overallCard && kpiIcon) {
      overallCard.className = 'kpi-card';
      kpiIcon.className = 'kpi-icon';
      if (analysis.crowdStatus === 'SAFE') {
        kpiIcon.classList.add('kpi-icon-safe');
      } else if (analysis.crowdStatus === 'WATCH') {
        kpiIcon.classList.add('kpi-icon-warning');
      } else {
        kpiIcon.classList.add('kpi-icon-danger');
        overallCard.classList.add('saturated');
      }
    }

    // SPC indicator dot
    const dot = document.getElementById('spc-indicator-pulse');
    if (dot) {
      dot.style.background = analysis.spcState === 'Out of Control' ? '#FF0000' :
                             analysis.spcState === 'Drifting'      ? '#FFFF00' : '#39FF14';
      dot.style.boxShadow = `0 0 8px ${dot.style.background}`;
    }
  }

  // Detailed Risk assessment block
  function updateRiskDetails(analysis) {
    if (!analysis) return;
    const levelEl = document.getElementById('risk-detail-level');
    const reasonEl = document.getElementById('risk-detail-reason');
    const actionEl = document.getElementById('risk-detail-action');

    if (levelEl) {
      levelEl.textContent = analysis.crowdStatus;
      levelEl.className = `risk-val-status ${analysis.crowdStatus}`;
    }

    if (reasonEl) {
      reasonEl.textContent = `• ${analysis.alert || 'Normal variation within standard limits.'}`;
    }

    if (actionEl) {
      let actionText = "• Maintain nominal operations monitoring.";
      if (analysis.crowdStatus === "CRITICAL") {
        actionText = "• DEPLOY OFFICERS IMMEDIATELY. Open exit gates. Shut entry gates. Broadcast voice siren.";
      } else if (analysis.crowdStatus === "HIGH") {
        actionText = "• Dispatch Marshals to monitored zone. Unlock exit barriers. Stop incoming flow.";
      } else if (analysis.crowdStatus === "WATCH") {
        actionText = "• Escalate observation frequency. Check hardware links. Ready medical team.";
      }
      actionEl.textContent = actionText;
    }
  }

  // State Timeline manager
  function updateTimeline(analysis) {
    if (!analysis) return;
    const timelineContainer = document.getElementById('timeline-transitions');
    if (!timelineContainer) return;

    const lastEntry = statusTransitions[0];
    if (!lastEntry || lastEntry.status !== analysis.crowdStatus) {
      const timeStr = new Date().toLocaleTimeString('en-IN', { hour12: false });
      statusTransitions.unshift({
        time: timeStr,
        status: analysis.crowdStatus
      });

      if (statusTransitions.length > 12) {
        statusTransitions.pop();
      }

      timelineContainer.innerHTML = statusTransitions.map(item => `
        <div class="timeline-item-entry">
          <span class="timeline-time">${item.time}</span>
          <span class="timeline-badge ${item.status.toLowerCase()}">${item.status}</span>
        </div>
      `).join('');
    }
  }

  // Individual sensor health evaluator
  function updateSensorHealth(sensors) {
    sensors.forEach((val, idx) => {
      const healthEl = document.getElementById(`health-f${idx + 1}`);
      if (healthEl) {
        healthEl.className = "sensor-health-lbl";
        if (val > 800) {
          healthEl.textContent = "Saturated";
          healthEl.classList.add("saturated");
        } else if (val > 500) {
          healthEl.textContent = "Noisy";
          healthEl.classList.add("noisy");
        } else {
          healthEl.textContent = "Healthy";
        }
      }
    });
  }

  // Heatmap page live numbers
  function updateHeatmapSidebar(sensors) {
    const ids = ['f1','f2','f3','f4','f5','f6'];
    ids.forEach((id, i) => {
      const el = document.getElementById('hm-val-' + id);
      const load = sensorLoad(sensors[i], i);
      const pct  = Math.round(load * 100);
      if (el) el.textContent = `${sensors[i]} (${pct}%)`;
    });
    // Peak load is the sensor with highest normalized load (not raw ADC)
    const loads = sensors.map((v, i) => sensorLoad(v, i));
    const peakLoad  = Math.max(...loads);
    const hotIdx    = loads.indexOf(peakLoad);
    const hotNames  = ['F1','F2','F3','F4','F5','F6'];
    const rawPeak   = sensors[hotIdx];
    const avgLoad   = loads.reduce((a,b)=>a+b,0) / loads.length;
    const avgRaw    = (sensors.reduce((a,b)=>a+b,0)/sensors.length).toFixed(0);
    const setText   = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
    setText('hm-peak',    `${rawPeak} (${Math.round(peakLoad*100)}%)`);
    setText('hm-avg',     `${avgRaw} (${Math.round(avgLoad*100)}%)`);
    setText('hm-hotzone', hotNames[hotIdx]);
    // Risk level based on normalized peak load
    setText('hm-risk', peakLoad > 0.70 ? 'Critical' : peakLoad > 0.45 ? 'High' : peakLoad > 0.20 ? 'Warning' : 'Low');
  }

  // AI Forecasting indicators — uses real ML Bridge fusion output
  function updateAIPage(analysis) {
    if (!analysis) return;
    const risk    = (analysis.risk || 0) / 100;
    const riskPct = analysis.risk || 0;

    const gaugeFill = document.getElementById('ai-gauge-fill');
    if (gaugeFill) {
      const circ = 502.4;
      gaugeFill.style.strokeDashoffset = circ - (risk * circ);
      gaugeFill.style.stroke = risk > 0.7 ? '#FF0000' : risk > 0.4 ? '#FF7F00' : '#39FF14';
    }
    const setText = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
    setText('ai-risk-pct', riskPct + '%');

    // Status label & action — use real fusion reason if available
    let statusLabel = 'System Stable';
    let action      = analysis.recommendedAction || 'Monitor';
    let timeCrit    = '—';
    let growthRate  = 'Stable';
    let confidence  = '—';

    // LSTM confidence from mlDetail if available
    if (analysis.mlDetail && analysis.mlDetail.confidence != null) {
      confidence = Math.round(analysis.mlDetail.confidence * 100) + '%';
    }

    const status = analysis.crowdStatus || analysis.status || 'SAFE';
    if (status === 'CRITICAL') {
      statusLabel = '⚠ Critical Compression Alert';
      action      = analysis.recommendedAction || 'Evacuate Now';
      timeCrit    = '< 30 seconds';
      growthRate  = 'Ramp Spike';
    } else if (status === 'HIGH') {
      statusLabel = 'Elevated Pressure Grid';
      action      = analysis.recommendedAction || 'Alert Marshals';
      timeCrit    = '~2 minutes';
      growthRate  = 'Increasing';
    } else if (status === 'WATCH') {
      statusLabel = 'Process Drifting';
      action      = analysis.recommendedAction || 'Observe';
      timeCrit    = '> 5 minutes';
      growthRate  = 'Slight Increase';
    }

    // EWMA slope for growth rate if available
    if (analysis.ewmaDetail && analysis.ewmaDetail.slope != null) {
      const slope = analysis.ewmaDetail.slope;
      growthRate = slope > 2 ? 'Rising Fast' : slope > 0.5 ? 'Increasing' : slope < -0.5 ? 'Decreasing' : 'Stable';
    }

    setText('ai-status-label', statusLabel);
    setText('ai-action',       action);
    setText('ai-time-critical', timeCrit);
    setText('ai-confidence',   confidence);
    setText('ai-growth-rate',  growthRate);
    setText('ai-spc-state',    analysis.spcState      || 'Stable');
    setText('ai-spc-avg',      (analysis.currentAvg   || 0).toFixed(1) + ' N');
    setText('ai-spc-sd',       (analysis.currentSd    || 0).toFixed(1) + ' N');
    setText('ai-spc-ucl', analysis.controlLimits ? (analysis.controlLimits.ucl || 0).toFixed(0) + ' N' : '—');
    setText('ai-spc-lcl', analysis.controlLimits ? (analysis.controlLimits.lcl || 0).toFixed(0) + ' N' : '—');
    setText('ai-spc-risk', riskPct + '%');
  }


  // Venue map gate colors & evacuation suggestions
  function updateVenuePage(sensors, analysis) {
    const ids = ['f1','f2','f3','f4','f5','f6'];
    ids.forEach((id,i) => {
      const load = sensorLoad(sensors[i], i);
      const pct  = Math.round(load * 100);
      const el = document.getElementById('venue-' + id);
      if (el) el.textContent = `${sensors[i]} (${pct}%)`;

      const dot = document.getElementById('map-' + id);
      if (dot) {
        // Color by normalized load
        dot.style.background = load > 0.70 ? '#FF0000' : load > 0.45 ? '#FF7F00' : load > 0.20 ? '#FFFF00' : '#39FF14';
        dot.style.color = (load > 0.20 && load <= 0.45) ? '#1A1A00' : '#FFFFFF';
      }
    });

    // Dynamic gate colors
    const gateA = document.getElementById('venue-gate-a');
    const gateB = document.getElementById('venue-gate-b');
    const pressA = (sensors[0] + sensors[3]) / 2; // Left side
    const pressB = (sensors[2] + sensors[5]) / 2; // Right side

    if (gateA) {
      gateA.className = "venue-zone " + (pressA > 700 ? "danger-zone" : pressA > 300 ? "watch-zone" : "safe-zone");
    }
    if (gateB) {
      gateB.className = "venue-zone " + (pressB > 700 ? "danger-zone" : pressB > 300 ? "watch-zone" : "safe-zone");
    }

    // Suggest evacuation direction banner
    const banner = document.getElementById('evacuation-indicator-banner');
    if (banner) {
      if (analysis.status === 'HIGH' || analysis.status === 'CRITICAL') {
        banner.style.display = 'block';
        if (pressA > pressB) {
          banner.textContent = "⚠ Evacuate EAST exits (Entry Gate B / East Exit)";
          banner.style.borderColor = "var(--brand)";
        } else {
          banner.textContent = "⚠ Evacuate WEST exits (Entry Gate A / West Exit)";
          banner.style.borderColor = "var(--brand)";
        }
      } else {
        banner.style.display = 'none';
      }
    }
  }

  // Diagnostics details
  function updateDevicePage(analysis) {
    if (!analysis) return;
    const setText = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
    setText('dev-com-port', analysis.activeCOM || 'Auto');
    setText('dev-time-diag', new Date().toLocaleTimeString('en-IN', { hour12: false }));
    setText('dev-arduino-status-diag', analysis.activeCOM === 'Simulator' ? 'Simulator Fallback' : 'Connected');
    setText('dev-freq-diag', (document.getElementById('diag-freq') || {textContent:'10 Hz'}).textContent);
    
    // Auto-update gain factor label
    const gainVal = parseFloat(document.getElementById('cfg-sensor-gain')?.value || 1.0).toFixed(1);
    setText('dev-calibration', `${gainVal}x Gain`);
  }

  function updateAnalyticsPage(analysis) {
    const setText = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
    setText('an-peak', peakPressure + ' N');
    setText('an-avg',  totalSamples ? (runningSum/totalSamples).toFixed(1) + ' N' : '0 N');
    setText('an-sd',   runningSD.toFixed(1) + ' N');
    setText('an-min',  (minPressure === Infinity ? 0 : minPressure) + ' N');
    setText('an-samples', totalSamples);
    setText('an-critical', criticalCount);
  }

  // Push notifications log with grouping
  function logNotifications(analysis) {
    if (!analysis) return;
    const status = analysis.status;
    let notifType = null;
    let notifMsg = null;

    if (status === 'CRITICAL') {
      notifType = 'emergency';
      notifMsg = 'CRITICAL: Crowd compression risk at dangerous threshold!';
    } else if (status === 'HIGH') {
      notifType = 'warning';
      notifMsg = 'WARNING: High pressure drift detected across array.';
    }

    if (notifType) {
      // Check if duplicate of last notification
      const last = notifLog[notifLog.length - 1];
      if (last && last.msg === notifMsg) {
        last.count = (last.count || 1) + 1;
        last.time = new Date().toLocaleTimeString('en-IN', { hour12: false });
      } else {
        notifLog.push({
          type: notifType,
          msg: notifMsg,
          time: new Date().toLocaleTimeString('en-IN', { hour12: false }),
          count: 1
        });
        
        // Push to Incident Priority Queue
        addIncident(notifType === 'emergency' ? 'critical' : 'warning', notifMsg);
      }
      renderNotifications();
      updateBadges();
    }
  }

  // Grouped Notifications display
  function renderNotifications() {
    const list = document.getElementById('notif-list');
    if (!list) return;
    if (notifLog.length === 0) {
      list.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
      return;
    }
    list.innerHTML = notifLog.slice().reverse().map(n => `
      <div class="notif-item" data-type="${n.type}">
        <div class="notif-icon ${n.type}">⚡</div>
        <div class="notif-body">
          <div class="notif-title">${n.type === 'emergency' ? '🔴 Emergency Alert' : '🟡 Warning Alert'} ${n.count > 1 ? `(${n.count}x)` : ''}</div>
          <div class="notif-detail">${n.msg}</div>
        </div>
        <div class="notif-time">${n.time}</div>
      </div>
    `).join('');
  }

  // Priority Incident Queue Manager
  function addIncident(severity, message) {
    // Avoid duplicate active incidents in the same category
    const activeDup = incidentLog.find(inc => inc.title === message && inc.status !== 'Resolved');
    if (activeDup) return;

    const timeStr = new Date().toLocaleTimeString('en-IN', { hour12: false });
    incidentLog.push({
      id: incidentLog.length + 1,
      severity: severity,
      title: message,
      detail: 'Sensors triggered elevated risk levels on the floor grid.',
      time: timeStr,
      status: 'Active'
    });
    renderIncidents();
  }

  function renderIncidents() {
    const timeline = document.getElementById('incident-timeline');
    if (!timeline) return;
    if (incidentLog.length === 0) {
      timeline.innerHTML = '<div class="incident-empty">No incidents recorded. System is monitoring.</div>';
      return;
    }

    timeline.innerHTML = incidentLog.slice().reverse().map(inc => {
      let badgeStyle = "background: #DCFCE7; color: #166534;";
      if (inc.status === 'Active') badgeStyle = "background: #FEE2E2; color: #991B1B;";
      if (inc.status === 'Acknowledged') badgeStyle = "background: #FEFDE6; color: #854D0E;";

      return `
        <div class="incident-item" style="border-left: 4px solid ${inc.severity === 'critical' ? 'red' : 'orange'}; margin-bottom: 0.5rem; padding: 0.5rem; background: var(--bg-surface); border-radius: 4px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div>
              <span class="timeline-badge ${inc.severity}">${inc.severity}</span>
              <strong style="margin-left: 0.5rem; font-size: 0.8rem;">${inc.title}</strong>
              <div style="font-size: 0.72rem; color: var(--text-secondary); margin-top: 0.2rem;">${inc.detail}</div>
              <div style="font-size: 0.68rem; color: var(--text-tertiary); margin-top: 0.2rem;">Time: ${inc.time} | Zone: Monitored Area</div>
            </div>
            <div style="display: flex; gap: 0.3rem;">
              ${inc.status === 'Active' ? `<button onclick="PageControllers.acknowledgeIncident(${inc.id})" style="font-size: 0.65rem; background: #3B82F6; color: white; padding: 2px 6px; border-radius: 3px;">Acknowledge</button>` : ''}
              ${inc.status !== 'Resolved' ? `<button onclick="PageControllers.resolveIncident(${inc.id})" style="font-size: 0.65rem; background: #16A34A; color: white; padding: 2px 6px; border-radius: 3px;">Resolve</button>` : ''}
              <span style="font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 3px; ${badgeStyle}">${inc.status}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    const total = incidentLog.length;
    const critical = incidentLog.filter(i=>i.severity==='critical').length;
    const warnings = total - critical;
    const resolved = incidentLog.filter(i=>i.status==='Resolved').length;

    const setText = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
    setText('inc-total', total);
    setText('inc-critical', critical);
    setText('inc-warnings', warnings);
    setText('inc-resolved', resolved);
  }

  function acknowledgeIncident(id) {
    const inc = incidentLog.find(i => i.id === id);
    if (inc) {
      inc.status = 'Acknowledged';
      renderIncidents();
      updateBadges();
    }
  }

  function resolveIncident(id) {
    const inc = incidentLog.find(i => i.id === id);
    if (inc) {
      inc.status = 'Resolved';
      renderIncidents();
      updateBadges();
    }
  }

  function updateBadges() {
    const notifBadge = document.getElementById('notif-badge');
    const incidentBadge = document.getElementById('incident-badge');
    if (notifBadge) notifBadge.textContent = notifLog.length;
    if (incidentBadge) incidentBadge.textContent = incidentLog.filter(i=>i.status==='Active').length;
  }

  // Render Clients list received from server
  function renderClientsList(clients) {
    const tbody = document.getElementById('clients-list-tbody');
    if (!tbody) return;
    if (!clients || clients.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" style="padding: 1rem; text-align: center; color: var(--text-tertiary);">No clients connected.</td></tr>`;
      return;
    }
    tbody.innerHTML = clients.map(c => `
      <tr>
        <td style="padding: 0.5rem; font-weight: 600;">${c.deviceId}</td>
        <td style="padding: 0.5rem; text-transform: capitalize;">${c.type}</td>
        <td style="padding: 0.5rem; color: #166534; font-weight: 600;">✓ ${c.status}</td>
      </tr>
    `).join('');
  }

  return {
    onTelemetry,
    resizeHeatmapPage,
    resizeAICanvas,
    resizeAnalyticsCanvas,
    acknowledgeIncident,
    resolveIncident,
    renderClientsList,
    incidentLog
  };
})();

// Attach functions to window for onclick callbacks
window.PageControllers = PageControllers;

/* ═══════════════════════════════════════════════════════
   MAIN DASHBOARD EXECUTION INITIALIZATION
   ═══════════════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", () => {
  let telemetryCount = 0;
  let sampleTimes = [];
  let currentFrequency = 0;

  const graphHistory = [];
  const maxGraphPoints = 150;

  // UI elements
  const connIndicator = document.getElementById("connection-indicator");
  const diagConnMode = document.getElementById("diag-conn-mode");
  const diagFreq = document.getElementById("diag-freq");
  const diagCount = document.getElementById("diag-count");
  const diagTime = document.getElementById("diag-time");

  const canvas = document.getElementById("trend-graph-canvas");
  const ctx = canvas.getContext("2d");

  const heatmapCanvas = document.getElementById("crowd-heatmap-canvas");
  const hCtx = heatmapCanvas.getContext("2d");
  const offscreenCanvas = document.createElement("canvas");
  offscreenCanvas.width = 32;
  offscreenCanvas.height = 16;
  const offscreenCtx = offscreenCanvas.getContext("2d");

  // Sensor node elements mapping
  const nodes = [
    document.getElementById("node-f1"),
    document.getElementById("node-f2"),
    document.getElementById("node-f3"),
    document.getElementById("node-f4"),
    document.getElementById("node-f5"),
    document.getElementById("node-f6")
  ];
  const valLabels = [
    document.getElementById("val-f1"),
    document.getElementById("val-f2"),
    document.getElementById("val-f3"),
    document.getElementById("val-f4"),
    document.getElementById("val-f5"),
    document.getElementById("val-f6")
  ];
  const rawCards = [
    document.getElementById("raw-card-f1"),
    document.getElementById("raw-card-f2"),
    document.getElementById("raw-card-f3"),
    document.getElementById("raw-card-f4"),
    document.getElementById("raw-card-f5"),
    document.getElementById("raw-card-f6")
  ];
  const rawNums = [
    document.getElementById("raw-val-f1"),
    document.getElementById("raw-val-f2"),
    document.getElementById("raw-val-f3"),
    document.getElementById("raw-val-f4"),
    document.getElementById("raw-val-f5"),
    document.getElementById("raw-val-f6")
  ];
  const rawBars = [
    document.getElementById("raw-bar-f1"),
    document.getElementById("raw-bar-f2"),
    document.getElementById("raw-bar-f3"),
    document.getElementById("raw-bar-f4"),
    document.getElementById("raw-bar-f5"),
    document.getElementById("raw-bar-f6")
  ];

  // Radial Risk Score Gauge
  const riskGaugeFill = document.getElementById("risk-gauge-fill");
  const riskPctVal = document.getElementById("risk-pct-val");

  // SPC Cards
  const spcCard = document.getElementById("spc-status-card");
  const spcVal = document.getElementById("spc-status-val");
  const spcDesc = document.getElementById("spc-status-desc");
  const spcAvgVal = document.getElementById("spc-avg-val");
  const spcSdVal = document.getElementById("spc-sd-val");

  // Settings page items
  const serverIpInput = document.getElementById("server-ip-input");
  const btnSaveIp = document.getElementById("btn-save-ip");
  const backendPortSelect = document.getElementById("backend-port-select");
  const btnApplyBackendPort = document.getElementById("btn-apply-backend-port");
  const backendSerialDetails = document.getElementById("backend-serial-details");

  const cfgRiskThreshold = document.getElementById("cfg-risk-threshold");
  const cfgThresholdLbl = document.getElementById("cfg-threshold-lbl");
  const cfgHeatSens = document.getElementById("cfg-heat-sens");
  const cfgHeatSensLbl = document.getElementById("cfg-heat-sens-lbl");
  
  const cfgSensorGain = document.getElementById("cfg-sensor-gain");
  const cfgGainLbl = document.getElementById("cfg-gain-lbl");
  const cfgSpcOffset = document.getElementById("cfg-spc-offset");
  const cfgSpcSigma = document.getElementById("cfg-spc-sigma");
  const spcOffsetLbl = document.getElementById("spc-offset-lbl");
  const spcSigmaLbl = document.getElementById("spc-sigma-lbl");

  const btnExportCSV = document.getElementById("btn-export-csv-logs");
  const btnExportJSON = document.getElementById("btn-export-json-logs");

  // Telemetry buffer for CSV/JSON logger
  const logsBuffer = [];

  // --- TELEMETRY MANAGER SETUP ──────────────────────────────────
  const telemetry = new TelemetryManager(
    // onData Telemetry frame Callback
    (sensors, packet) => {
      handleIncomingTelemetry(sensors, packet);
    },
    // onStatus Connection state Callback
    (statusClass, label) => {
      updateConnectionIndicator(statusClass, label);
    },
    // onMessage Non-telemetry socket data Callback
    (data) => {
      if (data.type === 'client_list') {
        PageControllers.renderClientsList(data.clients);
      } else if (data.type === 'ports_list') {
        populatePortsList(data.ports);
      }
    }
  );

  function init() {
    window.drawTrendGraph = drawTrendGraph;
    setupCanvas();
    bindEvents();
    
    // Load stored values
    serverIpInput.value = telemetry.getServerIp();
    
    // Connect to WebSocket
    telemetry.connect();
    drawTrendGraph();
  }

  function setupCanvas() {
    const rect = canvas.parentNode.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const hRect = heatmapCanvas.parentNode.getBoundingClientRect();
    heatmapCanvas.width = hRect.width * window.devicePixelRatio;
    heatmapCanvas.height = hRect.height * window.devicePixelRatio;
    heatmapCanvas.style.width = "100%";
    heatmapCanvas.style.height = "100%";
    hCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  window.addEventListener("resize", () => {
    setupCanvas();
    drawTrendGraph();
    drawCrowdHeatmap(PageControllers.latestSensors || [0,0,0,0,0,0]);
  });

  // Bind UI Events
  function bindEvents() {
    // Save Server IP
    btnSaveIp.addEventListener("click", () => {
      const ip = serverIpInput.value.trim();
      if (ip) {
        telemetry.setServerIp(ip);
        telemetry.disconnect();
        telemetry.connect();
        alert(`Server IP updated to: ${ip}. Reconnecting...`);
      }
    });

    // Apply Backend COM port
    btnApplyBackendPort.addEventListener("click", () => {
      const selectedPort = backendPortSelect.value;
      if (selectedPort) {
        telemetry.send({ type: 'select_port', path: selectedPort });
        backendSerialDetails.textContent = `Active Port: ${selectedPort}`;
        alert(`Request sent to open port: ${selectedPort}`);
      } else {
        alert("Please select a valid COM Port.");
      }
    });

    // Heatmap sliders & sensitivity labels
    cfgRiskThreshold.addEventListener("input", (e) => {
      cfgThresholdLbl.textContent = e.target.value;
    });

    cfgHeatSens.addEventListener("input", (e) => {
      cfgHeatSensLbl.textContent = parseFloat(e.target.value).toFixed(1);
    });

    // Hardware Calibration
    cfgSensorGain.addEventListener("input", (e) => {
      cfgGainLbl.textContent = parseFloat(e.target.value).toFixed(1);
      // Synchronize gain with backend
      telemetry.send({ type: 'set_gain', gain: parseFloat(e.target.value) });
    });

    // SPC settings updates
    cfgSpcOffset.addEventListener("input", (e) => {
      spcOffsetLbl.textContent = e.target.value;
      syncSPCTuning();
    });

    cfgSpcSigma.addEventListener("input", (e) => {
      spcSigmaLbl.textContent = e.target.value;
      syncSPCTuning();
    });

    function syncSPCTuning() {
      telemetry.send({
        type: 'tune_spc',
        mean: parseInt(cfgSpcOffset.value),
        sigma: parseInt(cfgSpcSigma.value)
      });
    }

    // Backend presets commands removed (hardware-only mode)
    document.querySelectorAll(".quick-preset-btn, .preset-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        alert("Simulation disabled. Hardware mode active.");
      });
    });

    // Manual slider overrides removed (hardware-only mode)
    const sliders = [
      document.getElementById("sim-slider-f1"),
      document.getElementById("sim-slider-f2"),
      document.getElementById("sim-slider-f3"),
      document.getElementById("sim-slider-f4"),
      document.getElementById("sim-slider-f5"),
      document.getElementById("sim-slider-f6")
    ];

    sliders.forEach(slider => {
      if(slider) {
        slider.addEventListener("input", () => {
          // No operation - simulator disabled
        });
      }
    });

    // Direct Emergency command actions simulation
    document.getElementById("cmd-send-alert").addEventListener("click", () => triggerDirectEmergency("Broadcast Critical Emergency Alert"));
    document.getElementById("cmd-call-medical").addEventListener("click", () => triggerDirectEmergency("Dispatch Medical Team Alpha"));
    document.getElementById("cmd-open-exit").addEventListener("click", () => triggerDirectEmergency("Emergency: Open Exit Gates"));
    document.getElementById("cmd-close-gate").addEventListener("click", () => triggerDirectEmergency("Incident Center: Close Entry Gates"));
    document.getElementById("cmd-voice-alert").addEventListener("click", () => triggerDirectEmergency("Voice Broadcast Triggered"));
    document.getElementById("cmd-activate-siren").addEventListener("click", () => triggerDirectEmergency("Audible Siren Activated"));

    function triggerDirectEmergency(title) {
      alert(`Command Executed: ${title}`);
      // Push manual notification
      PageControllers.incidentLog.push({
        id: PageControllers.incidentLog.length + 1,
        severity: 'critical',
        title: title,
        detail: 'Direct operator command action override executed from command panel.',
        time: new Date().toLocaleTimeString('en-IN', { hour12: false }),
        status: 'Active'
      });
      // Trigger alarm audio if toggle check
      const alarmOn = document.getElementById("cfg-alarm-toggle")?.checked;
      if (alarmOn && typeof Audio !== 'undefined') {
        // play generic tone
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(800, ctx.currentTime);
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      }
    }

    // Export logs CSV
    btnExportCSV.addEventListener("click", () => {
      if (logsBuffer.length === 0) {
        alert("Telemetry logs are empty.");
        return;
      }
      const headers = ["Timestamp", "F1", "F2", "F3", "F4", "F5", "F6", "RiskScore", "Status"];
      const csvLines = [headers.join(",")];
      logsBuffer.forEach(log => {
        csvLines.push([
          log.timestamp,
          log.sensors.join(","),
          log.risk,
          log.status
        ].join(","));
      });
      
      const blob = new Blob([csvLines.join("\n")], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `stampedeshield_logs_${Date.now()}.csv`;
      a.click();
    });

    // Export logs JSON
    btnExportJSON.addEventListener("click", () => {
      if (logsBuffer.length === 0) {
        alert("Telemetry logs are empty.");
        return;
      }
      const blob = new Blob([JSON.stringify(logsBuffer, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `stampedeshield_logs_${Date.now()}.json`;
      a.click();
    });
  }

  // Populate backend serial ports select dropdown list
  function populatePortsList(ports) {
    if (!backendPortSelect) return;
    backendPortSelect.innerHTML = "";
    if (!ports || ports.length === 0) {
      backendPortSelect.innerHTML = `<option value="">No Ports Found</option>`;
      return;
    }
    ports.forEach(port => {
      const option = document.createElement("option");
      option.value = port;
      option.textContent = port;
      backendPortSelect.appendChild(option);
    });
  }

  // Connection Indicator view adjustments
  function updateConnectionIndicator(statusClass, label) {
    if (!connIndicator) return;
    connIndicator.className = `status-chip ${statusClass === 'websocket-active' ? 'connected' : 'offline'}`;
    const indicatorText = connIndicator.querySelector('.status-label') || connIndicator;
    indicatorText.textContent = label;
    diagConnMode.textContent = statusClass === 'websocket-active' ? "WEBSOCKET" : "OFFLINE";
  }

  // Pipeline execution for incoming WebSocket data frames
  function handleIncomingTelemetry(sensors, packet) {
    if (!packet) return;
    
    // Safely extract sensors array
    if (!sensors) {
      sensors = packet.sensors || packet.smoothedSensors;
    }
    if (!sensors || !Array.isArray(sensors) || sensors.length !== 6) {
      sensors = [0, 0, 0, 0, 0, 0];
    }
    // Map sensors to integers
    sensors = sensors.map(v => Math.round(Number(v) || 0));

    // Emergency check: alert if 4 or more sensors attain their individual maximum load (>= 85%)
    let sensorMaxCount = 0;
    sensors.forEach((val, idx) => {
      if (sensorLoad(val, idx) >= 0.85) {
        sensorMaxCount++;
      }
    });
    if (sensorMaxCount >= 4) {
      packet.risk = 100;
      packet.status = 'CRITICAL';
      packet.alert = 'CRITICAL EMERGENCY: 4+ sensors exceeded maximum safety threshold!';
    } else {
      packet.risk = Math.round((sensors.reduce((acc, val, idx) => acc + sensorLoad(val, idx), 0) / 6) * 100);
      packet.status = 'SAFE';
      packet.alert = 'System Monitoring — All areas nominal.';
    }

    const now = new Date();
    telemetryCount++;

    // Calculate actual update rate frequency
    sampleTimes.push(now.getTime());
    if (sampleTimes.length > 30) {
      sampleTimes.shift();
    }
    if (sampleTimes.length > 1) {
      const durationSec = (sampleTimes[sampleTimes.length - 1] - sampleTimes[0]) / 1000;
      currentFrequency = Math.round((sampleTimes.length - 1) / durationSec);
    }

    // Capture in logger buffer
    logsBuffer.push({
      timestamp: packet.timestamp,
      sensors: packet.sensors,
      risk: packet.risk,
      status: packet.status
    });
    if (logsBuffer.length > 1500) {
      logsBuffer.shift();
    }

    // Diagnostics details
    diagCount.textContent = telemetryCount;
    diagFreq.textContent = `${currentFrequency} Hz`;
    
    const hrs = String(now.getHours()).padStart(2, '0');
    const mins = String(now.getMinutes()).padStart(2, '0');
    const secs = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0').slice(0, 2);
    diagTime.textContent = `${hrs}:${secs}:${mins}.${ms}`;

    // Render numbers in array grid overlays & sensor bar charts
    sensors.forEach((val, idx) => {
      if (valLabels[idx]) valLabels[idx].textContent = val;
      if (rawNums[idx])   rawNums[idx].textContent   = val;

      const load    = sensorLoad(val, idx);
      const scalePct = load * 100;
      if (rawBars[idx]) {
        rawBars[idx].style.width = `${scalePct}%`;
        rawBars[idx].style.backgroundColor =
          load > 0.70 ? 'var(--status-risk)'   :
          load > 0.45 ? 'var(--status-orange)' :
          load > 0.20 ? 'var(--status-watch)'  :
                        'var(--status-safe)';
      }

      // Node card state classes based on normalized load
      const node    = nodes[idx];
      const rawCard = rawCards[idx];
      if (node && rawCard) {
        node.className    = 'sensor-node';
        rawCard.className = 'raw-card';
        if      (load > 0.70) { node.classList.add('heat-critical'); rawCard.classList.add('status-critical'); }
        else if (load > 0.45) { node.classList.add('heat-high');     rawCard.classList.add('status-high'); }
        else if (load > 0.20) { node.classList.add('heat-mod');      rawCard.classList.add('status-mod'); }
        else                  { node.classList.add('heat-low');       rawCard.classList.add('status-low'); }
      }
    });

    // Radial Gauge
    updateRiskGauge(packet.risk);

    // SPC indicators
    updateSpcStatusCard(packet);

    // Rolling graph statistics history
    graphHistory.push({
      avg: packet.currentAvg,
      ucl: packet.controlLimits ? packet.controlLimits.ucl : 0,
      lcl: packet.controlLimits ? packet.controlLimits.lcl : 0,
      mean: packet.controlLimits ? packet.controlLimits.mean : 0
    });
    if (graphHistory.length > maxGraphPoints) {
      graphHistory.shift();
    }

    drawTrendGraph();
    drawCrowdHeatmap(sensors);

    // Map properties for PageControllers compatibility
    // For raw telemetry: populate basic fields, but don't overwrite ML data
    if (packet.type !== 'telemetry_ml') {
      packet.crowdStatus     = packet.status || 'PROCESSING';
      packet.crowdStatusDesc = packet.alert  || 'Awaiting ML analysis...';
      packet.riskScore       = packet.risk   || 0;
      packet.spatialStdDev   = packet.currentSd || 0;
      packet.spcState        = packet.spcState  || 'Pending';
      packet.spcReason       = packet.alert     || 'Awaiting ML analysis...';
      packet.activeSensorsCount = packet.activeSensors || 6;
    } else {
      // telemetry_ml: extract real fields from ML Bridge fusion result
      packet.crowdStatus      = packet.status           || 'SAFE';
      packet.crowdStatusDesc  = packet.fusionReason     || 'ML inference complete.';
      packet.riskScore        = packet.risk             || 0;
      packet.spatialStdDev    = packet.spcDetail ? (packet.spcDetail.spatial_std_dev || 0) : 0;
      packet.spcState         = packet.spcDetail ? (packet.spcDetail.state || 'Stable') : 'Stable';
      packet.spcReason        = packet.spcDetail ? (packet.spcDetail.reason || '') : '';
      packet.currentAvg       = packet.spcDetail ? (packet.spcDetail.current_avg || 0) : 0;
      packet.currentSd        = packet.spcDetail ? (packet.spcDetail.spatial_std_dev || 0) : 0;
      packet.controlLimits    = packet.spcDetail ? (packet.spcDetail.control_limits || {ucl:0,lcl:0,cl:0}) : {ucl:0,lcl:0,cl:0};
      packet.activeSensorsCount = packet.spcDetail ? (packet.spcDetail.sensor_violations || []).length : 0;
      packet.alert            = packet.spcReason;
      // Use smoothed sensors from ML Bridge for display if available
      if (packet.smoothedSensors && packet.smoothedSensors.length === 6) {
        sensors = packet.smoothedSensors.map(v => Math.round(v));
      }
    }

    // Forward to general page controller handlers
    PageControllers.onTelemetry(sensors, packet);
  }

  function updateRiskGauge(risk) {
    if (!riskGaugeFill || !riskPctVal) return;
    riskPctVal.textContent = `${risk}%`;
    const circumference = 251.2;
    const offset = circumference - (risk / 100) * circumference;
    riskGaugeFill.style.strokeDashoffset = offset;
    
    if (risk >= 70) {
      riskGaugeFill.style.stroke = "var(--status-risk)";
    } else if (risk >= 30) {
      riskGaugeFill.style.stroke = "var(--status-orange)";
    } else {
      riskGaugeFill.style.stroke = "var(--status-safe-border)";
    }
  }

  function updateSpcStatusCard(packet) {
    if (!spcCard || !spcVal || !spcDesc) return;
    spcCard.className = "kpi-card spc-card";
    
    if (packet.spcState === "Out of Control") {
      spcCard.classList.add("out-of-control");
      spcVal.textContent = "Out of Control";
    } else if (packet.spcState === "Drifting") {
      spcCard.classList.add("drift");
      spcVal.textContent = "Process Drifting";
    } else {
      spcCard.classList.add("stable");
      spcVal.textContent = "Process Stable";
    }
    
    spcDesc.textContent = packet.alert || 'Nominal variation limits.';
    if (spcAvgVal) spcAvgVal.textContent = `${(packet.currentAvg || 0).toFixed(1)} N`;
    if (spcSdVal) spcSdVal.textContent = `${(packet.currentSd || 0).toFixed(1)} N`;
  }

  function drawTrendGraph(targetCanvas = canvas, targetCtx = ctx) {
    if (!targetCanvas || !targetCtx) return;
    
    const w = targetCanvas.width / window.devicePixelRatio;
    const h = targetCanvas.height / window.devicePixelRatio;
    
    targetCtx.clearRect(0, 0, w, h);
    
    // Draw background grid lines
    targetCtx.strokeStyle = "rgba(16, 24, 40, 0.05)";
    targetCtx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const yVal = h * 0.15 + (i * h * 0.23);
      targetCtx.beginPath();
      targetCtx.moveTo(0, yVal);
      targetCtx.lineTo(w, yVal);
      targetCtx.stroke();
    }

    if (graphHistory.length === 0) return;

    // Draw UCL limit lines
    targetCtx.strokeStyle = "rgba(220, 38, 38, 0.4)";
    targetCtx.lineWidth = 1.5;
    targetCtx.setLineDash([5, 5]);
    
    targetCtx.beginPath();
    graphHistory.forEach((pt, idx) => {
      const x = (idx / (maxGraphPoints - 1)) * w;
      const y = h - (Math.max(0, Math.min(1023, pt.ucl)) / 1023) * h * 0.9;
      if (idx === 0) targetCtx.moveTo(x, y);
      else targetCtx.lineTo(x, y);
    });
    targetCtx.stroke();

    // Draw LCL limit lines
    targetCtx.strokeStyle = "rgba(71, 85, 105, 0.4)";
    targetCtx.beginPath();
    graphHistory.forEach((pt, idx) => {
      const x = (idx / (maxGraphPoints - 1)) * w;
      const y = h - (Math.max(0, Math.min(1023, pt.lcl)) / 1023) * h * 0.9;
      if (idx === 0) targetCtx.moveTo(x, y);
      else targetCtx.lineTo(x, y);
    });
    targetCtx.stroke();

    // Draw average pressure path
    targetCtx.setLineDash([]);
    targetCtx.strokeStyle = "var(--brand)";
    targetCtx.lineWidth = 2.5;
    targetCtx.beginPath();
    graphHistory.forEach((pt, idx) => {
      const x = (idx / (maxGraphPoints - 1)) * w;
      const y = h - (Math.max(0, Math.min(1023, pt.avg)) / 1023) * h * 0.9;
      if (idx === 0) targetCtx.moveTo(x, y);
      else targetCtx.lineTo(x, y);
    });
    targetCtx.stroke();
  }

  function drawCrowdHeatmap(sensors) {
    if (!sensors || sensors.length < 6) return;
    const w = heatmapCanvas.width / window.devicePixelRatio;
    const h = heatmapCanvas.height / window.devicePixelRatio;
    const [F1,F2,F3,F4,F5,F6] = sensors;

    hCtx.clearRect(0, 0, w, h);
    hCtx.fillStyle = '#0B1120';
    hCtx.fillRect(0, 0, w, h);

    const COLS = 10, ROWS = 5;
    const GAP = 2;
    const RADIUS = 4;
    const cellW = (w - GAP * (COLS + 1)) / COLS;
    const cellH = (h - GAP * (ROWS + 1)) / ROWS;

    for (let row = 0; row < ROWS; row++) {
      const ny = row / (ROWS - 1);
      for (let col = 0; col < COLS; col++) {
        const nx = col / (COLS - 1);
        let val;
        if (nx <= 0.5) {
          const u = nx * 2;
          val = (1-u)*(1-ny)*F1 + u*(1-ny)*F2 + (1-u)*ny*F4 + u*ny*F5;
        } else {
          const u = (nx - 0.5) * 2;
          val = (1-u)*(1-ny)*F2 + u*(1-ny)*F3 + (1-u)*ny*F5 + u*ny*F6;
        }

        const [r,g,b] = getColorForPressure(val);
        const x = GAP + col * (cellW + GAP);
        const y = GAP + row * (cellH + GAP);

        const intensity = Math.max(0, Math.min(1023, val)) / 1023;
        hCtx.shadowColor = `rgba(${r},${g},${b},${0.25 + intensity * 0.45})`;
        hCtx.shadowBlur = 4 + intensity * 8;

        hCtx.beginPath();
        hCtx.roundRect(x, y, cellW, cellH, RADIUS);
        hCtx.fillStyle = `rgb(${r},${g},${b})`;
        hCtx.fill();

        hCtx.shadowColor = 'transparent';
        hCtx.shadowBlur = 0;
      }
    }
  }

  function getColorForPressure(val) {
    const t = Math.max(0, Math.min(1023, val)) / 1023;
    let r, g, b;
    if (t <= 0.2) {
      r = Math.round(30 + (t / 0.2) * 16);
      g = Math.round(180 + (t / 0.2) * 24);
      b = 60;
    } else if (t <= 0.4) {
      r = Math.round(46 + ((t - 0.2) / 0.2) * 134);
      g = Math.round(204 + ((t - 0.2) / 0.2) * 16);
      b = Math.round(64 - ((t - 0.2) / 0.2) * 24);
    } else if (t <= 0.55) {
      r = Math.round(180 + ((t - 0.4) / 0.15) * 75);
      g = Math.round(220 - ((t - 0.4) / 0.15) * 6);
      b = Math.round(40 - ((t - 0.4) / 0.15) * 30);
    } else if (t <= 0.7) {
      r = 255;
      g = Math.round(214 - ((t - 0.55) / 0.15) * 74);
      b = Math.round(10 - ((t - 0.55) / 0.15) * 10);
    } else if (t <= 0.85) {
      r = Math.round(255 - ((t - 0.7) / 0.15) * 20);
      g = Math.round(140 - ((t - 0.7) / 0.15) * 85);
      b = Math.round(((t - 0.7) / 0.15) * 20);
    } else {
      r = Math.round(235 - ((t - 0.85) / 0.15) * 35);
      g = Math.round(55 - ((t - 0.85) / 0.15) * 35);
      b = Math.round(20 + ((t - 0.85) / 0.15) * 10);
    }
    return [r, g, b];
  }

  init();
});
