/**
 * StampedeShield - Node.js Telemetry Hub  (v3 — Cleaned)
 *
 * Responsibilities:
 *   1. HTTP static file server          — dashboard at port 3000
 *   2. WebSocket server (port 8080)     — relays telemetry to browser + Android
 *   3. UDP listener (port 4210)         — receives "F1,F2,F3,F4,F5,F6\n" from
 *                                         Arduino UNO Q App Lab Python (over WiFi)
 *   4. Python ML Bridge client (8081)   — sends sensor_frame, receives ml_result
 *
 * Data flow:
 *   UNO Q App Lab Python  --UDP:4210-->  this server
 *       --> sendToMLBridge (ws://localhost:8081)  --> ml_bridge.py
 *       --> broadcast telemetry + telemetry_ml to all WebSocket clients
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const dgram  = require('dgram');       // UDP socket — Arduino WiFi packets
const { WebSocketServer, WebSocket } = require('ws');
let SerialPort = null;
let ReadlineParser = null;
try {
  SerialPort = require('serialport').SerialPort;
  ReadlineParser = require('@serialport/parser-readline').ReadlineParser;
} catch (err) {
  console.warn('[Serial] WARNING: Could not load "serialport" module. USB Serial connection is disabled.');
  console.warn('[Serial] Reason:', err.message);
}

// ── Configuration ─────────────────────────────────────────────────────────────
const HTTP_PORT     = 3000;
const WS_PORT       = 8080;
const UDP_PORT      = 4210;               // UNO Q App Lab Python sends UDP here
const ML_BRIDGE_URL = 'ws://localhost:8081'; // Python ML Bridge WebSocket

const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── HTTP Static Server ────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = filePath.split('?')[0].split('#')[0];
  const absolutePath = path.join(__dirname, filePath);

  if (!absolutePath.startsWith(__dirname)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Access Denied');
    return;
  }

  fs.stat(absolutePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const indexPath = path.join(__dirname, 'index.html');
      fs.readFile(indexPath, (indexErr, indexData) => {
        if (indexErr) {
          res.statusCode = 500;
          res.end('Internal Server Error: Missing index.html');
        } else {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/html');
          res.end(indexData);
        }
      });
      return;
    }
    fs.readFile(absolutePath, (readErr, data) => {
      if (readErr) {
        res.statusCode = 500;
        res.end(`Internal Server Error`);
        return;
      }
      const ext = path.extname(absolutePath).toLowerCase();
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      res.end(data);
    });
  });
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log('\n=================================================================');
  console.log('🛡️  STAMPEDESHIELD  —  CROWD COMPRESSION MONITOR  v3');
  console.log('=================================================================');
  console.log(`   HTTP Dashboard : http://localhost:${HTTP_PORT}`);
  console.log(`   WebSocket      : ws://localhost:${WS_PORT}`);
  console.log(`   UDP Listener   : udp://0.0.0.0:${UDP_PORT}  (UNO Q App Lab)`);
  console.log(`   ML Bridge      : ${ML_BRIDGE_URL}`);
  console.log('-----------------------------------------------------------------');
});


// ── Python ML Bridge — WebSocket Client ──────────────────────────────────────
// Connects to stampede_shield/ml_bridge.py (port 8081).
// Forwards raw sensor frames; receives enriched ml_result packets.
let mlBridge          = null;
let mlBridgeReady     = false;
let mlBridgeReconnect = null;

function connectMLBridge() {
  if (mlBridgeReconnect) { clearTimeout(mlBridgeReconnect); mlBridgeReconnect = null; }

  console.log(`[MLBridge] Connecting to ${ML_BRIDGE_URL} ...`);
  mlBridge = new WebSocket(ML_BRIDGE_URL);

  mlBridge.on('open', () => {
    mlBridgeReady = true;
    console.log('[MLBridge] ✅ Connected to Python ML bridge');
  });

  // ml_result packets arrive here → broadcast as telemetry_ml
  mlBridge.on('message', (raw) => {
    try {
      const r = JSON.parse(raw);
      if (r.type !== 'ml_result') return;

      const packet = {
        type:               'telemetry_ml',
        timestamp:          new Date().toISOString(),
        sensors:            r.smoothed_sensors ? r.smoothed_sensors.map(Math.round) : [0,0,0,0,0,0],
        status:             r.status,
        risk:               r.risk_score,
        fusionReason:       r.fusion_reason,
        strategy:           r.strategy,
        algorithmVotes:     r.algorithm_votes,
        algorithmsAlarming: r.algorithms_alarming,
        spatialPattern:     r.spatial_pattern,
        recommendedAction:  r.recommended_action,
        spcDetail:          r.spc,
        ewmaDetail:         r.ewma,
        cusumDetail:        r.cusum,
        zscoreDetail:       r.zscore,
        mlDetail:           r.ml,
        smoothedSensors:    r.smoothed_sensors,
        lstmReady:          r.lstm_ready,
        bridgeMs:           r.bridge_ms,
      };
      broadcast(JSON.stringify(packet));
    } catch (err) {
      console.error('[MLBridge] Parse error:', err.message);
    }
  });

  mlBridge.on('close', () => {
    mlBridgeReady = false;
    mlBridge      = null;
    console.log('[MLBridge] Disconnected — retrying in 3 s...');
    mlBridgeReconnect = setTimeout(connectMLBridge, 3000);
  });

  mlBridge.on('error', (err) => {
    // suppress ECONNREFUSED spam — reconnect loop handles retries
    if (!err.message.includes('ECONNREFUSED')) {
      console.error('[MLBridge] Error:', err.message);
    }
    mlBridgeReady = false;
  });
}

function sendToMLBridge(sensors) {
  if (mlBridgeReady && mlBridge && mlBridge.readyState === WebSocket.OPEN) {
    mlBridge.send(JSON.stringify({ type: 'sensor_frame', sensors }));
  }
}

// Start connecting to ML bridge immediately
connectMLBridge();

// ── WebSocket Server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[WS] ❌ Port ${WS_PORT} is already in use!`);
    console.error(`[WS]    Another process is using this port.`);
    console.error(`[WS]    Fix: run this command, then restart:\n`);
    console.error(`[WS]      Stop-Process -Id (Get-NetTCPConnection -LocalPort ${WS_PORT}).OwningProcess -Force\n`);
    process.exit(1);
  } else {
    console.error('[WS] Server error:', err.message);
  }
});
const clients = new Set();

wss.on('connection', (ws) => {
  const clientInfo = { socket: ws, type: 'unknown', deviceId: 'Dashboard', lastHeartbeat: Date.now() };
  clients.add(clientInfo);
  console.log(`[WS] New connection. Active clients: ${clients.size}`);

  // Send available serial ports on connect
  getPortsList().then(ports => {
    safeSend(ws, JSON.stringify({ type: 'ports_list', ports }));
  });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'heartbeat':
          clientInfo.type = 'android';
          clientInfo.deviceId = data.deviceId || 'Android Phone';
          clientInfo.lastHeartbeat = Date.now();
          broadcastClientList();
          break;

        case 'dashboard_init':
          clientInfo.type = 'dashboard';
          clientInfo.deviceId = data.deviceId || 'Web Dashboard';
          broadcastClientList();
          break;

        case 'list_ports':
          const ports = await getPortsList();
          safeSend(ws, JSON.stringify({ type: 'ports_list', ports }));
          break;

        case 'select_port':
          console.log(`[Serial] Client requested port: ${data.path}`);
          connectSerial(data.path);
          break;

        case 'tune_spc':
          // Baseline tuning: forwarded to ML Bridge in future enhancement
          console.log(`[SPC] Baseline tune requested: mean=${data.mean}, sigma=${data.sigma} (applied client-side)`);
          break;

        case 'set_gain':
          // Gain tuning: applied client-side in dashboard
          console.log(`[Gain] Gain factor update: ${data.gain} (applied client-side)`);
          break;

        default:
          break;
      }
    } catch (err) {
      console.error('[WS] Message parse error:', err.message);
    }
  });

  ws.on('close', () => {
    clients.delete(clientInfo);
    console.log(`[WS] Disconnected. Active: ${clients.size}`);
    broadcastClientList();
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
    clients.delete(clientInfo);
    broadcastClientList();
  });
});

function safeSend(ws, msg) {
  try {
    if (ws.readyState === 1) ws.send(msg);
  } catch (_) {}
}

function broadcast(msgString) {
  clients.forEach(c => safeSend(c.socket, msgString));
}

function broadcastClientList() {
  const list = Array.from(clients).map(c => ({
    type: c.type, deviceId: c.deviceId, status: 'Connected'
  }));
  broadcast(JSON.stringify({ type: 'client_list', clients: list }));
}

// Heartbeat timeout: disconnect Android clients silent for > 10 s
setInterval(() => {
  const now = Date.now();
  let changed = false;
  clients.forEach(client => {
    if (client.type === 'android' && now - client.lastHeartbeat > 10000) {
      client.socket.close();
      clients.delete(client);
      changed = true;
    }
  });
  if (changed) broadcastClientList();
}, 3000);

/**
 * Core data path: raw sensor array → ML Bridge + broadcast to dashboard.
 * Called from the UDP receiver (UNO Q App Lab) and the USB Serial receiver.
 */
function ingestAndBroadcast(rawSensors, source) {
  // Forward to Python ML Bridge (fire-and-forget)
  // ml_result packet arrives on mlBridge.on('message') and is broadcast as telemetry_ml
  sendToMLBridge(rawSensors);

  // Also broadcast a basic telemetry packet immediately (before ML result arrives)
  // This keeps the dashboard charts live at 10 Hz without waiting for ML latency
  const packet = {
    type:          'telemetry',
    timestamp:     new Date().toISOString(),
    sensors:       rawSensors,
    rawSensors:    rawSensors,
    risk:          0,
    status:        'PROCESSING',
    spcState:      'Pending',
    alert:         '',
    activeSensors: rawSensors.filter(v => v > 10).length,
    currentAvg:    rawSensors.reduce((a, b) => a + b, 0) / rawSensors.length,
    currentSd:     0,
    controlLimits: { ucl: 0, lcl: 0, cl: 0 },
    source,
  };

  broadcast(JSON.stringify(packet));
}

// ── UDP Listener — Arduino WiFi ───────────────────────────────────────────────
const udpServer = dgram.createSocket('udp4');

udpServer.on('error', (err) => {
  console.error(`[UDP] Server error:\n${err.stack}`);
  udpServer.close();
});

udpServer.on('message', async (msg, rinfo) => {
  const line = msg.toString().trim();
  if (!line) return;

  const values = line.split(',').map(Number);
  if (values.length === 6 && !values.some(isNaN)) {
    await ingestAndBroadcast(values, `UDP:${rinfo.address}`);
  } else {
    console.warn(`[UDP] Invalid packet from ${rinfo.address}: "${line}"`);
  }
});

udpServer.bind(UDP_PORT, '0.0.0.0', () => {
  console.log(`[UDP] Listening for Arduino WiFi packets on port ${UDP_PORT}`);
});

// ── Serial Port — USB Connection (Arduino via cable) ─────────────────────────
let activeSerialPort = null;
let serialParser     = null;
let isSerialConnected = false;
let activePortPath   = null;
let autoReconnectTimer = null;

async function getPortsList() {
  if (!SerialPort) {
    return [];
  }
  try {
    const ports = await SerialPort.list();
    return ports.map(p => p.path);
  } catch (err) {
    console.error('[Serial] Error listing ports:', err);
    return [];
  }
}

function connectSerial(portPath) {
  closeActiveSerialPort();
  if (!SerialPort || !ReadlineParser) {
    console.error('[Serial] Cannot connect: serialport module is not loaded.');
    return;
  }
  console.log(`[Serial] Connecting to ${portPath} ...`);
  try {
    activeSerialPort = new SerialPort({ path: portPath, baudRate: 9600 });
    serialParser     = activeSerialPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    activeSerialPort.on('open', () => {
      console.log(`[Serial] Opened: ${portPath}`);
      isSerialConnected = true;
      activePortPath    = portPath;
    });

    serialParser.on('data', async (data) => {
      const line = data.trim();
      if (!line) return;
      const values = line.split(',').map(Number);
      if (values.length === 6 && !values.some(isNaN)) {
        await ingestAndBroadcast(values, `Serial:${portPath}`);
      } else {
        console.warn(`[Serial] Invalid packet: ${line}`);
      }
    });

    activeSerialPort.on('close', () => {
      console.log(`[Serial] Port closed: ${portPath}`);
      handleSerialDisconnect();
    });

    activeSerialPort.on('error', (err) => {
      console.error(`[Serial] Error on ${portPath}:`, err.message);
      handleSerialDisconnect();
    });

  } catch (err) {
    console.error(`[Serial] Open error on ${portPath}:`, err.message);
    handleSerialDisconnect();
  }
}

function closeActiveSerialPort() {
  if (activeSerialPort) {
    try { if (activeSerialPort.isOpen) activeSerialPort.close(); } catch (_) {}
    activeSerialPort.removeAllListeners();
    activeSerialPort = null;
    serialParser     = null;
  }
}

function handleSerialDisconnect() {
  if (!isSerialConnected && activePortPath === null) return;
  isSerialConnected = false;
  activePortPath    = null;
  closeActiveSerialPort();
  console.log('[Serial] Disconnected. Retrying in 3 s...');
  broadcast(JSON.stringify({
    type: 'telemetry', timestamp: new Date().toISOString(),
    sensors: [0,0,0,0,0,0], rawSensors: [0,0,0,0,0,0],
    risk: 0, status: 'DISCONNECTED',
    spcState: 'NORMAL', alert: 'Hardware disconnected',
    activeSensors: 0, currentAvg: 0, currentSd: 0,
    controlLimits: { ucl: 0, lcl: 0, cl: 0 }, source: 'Disconnected',
  }));
  if (autoReconnectTimer) clearTimeout(autoReconnectTimer);
  autoReconnectTimer = setTimeout(autoDetectSerial, 3000);
}

async function autoDetectSerial() {
  if (!SerialPort) {
    console.log('[Serial] USB serial connection is disabled because serialport library is not loaded.');
    return;
  }
  try {
    const ports = await SerialPort.list();
    console.log('[Serial] Detected ports:', ports.map(p => p.path));
    const target = ports.find(p => {
      const d = (p.friendlyName || p.description || '').toLowerCase();
      const m = (p.manufacturer || '').toLowerCase();
      return d.includes('arduino') || d.includes('ch340') || d.includes('usb-to-serial')
          || m.includes('arduino') || m.includes('ftdi') || m.includes('wch');
    }) || ports[0];

    if (target) {
      console.log(`[Serial] Auto-connecting: ${target.path}`);
      connectSerial(target.path);
    } else {
      console.log('[Serial] No ports found. Retrying in 3 s...');
      if (autoReconnectTimer) clearTimeout(autoReconnectTimer);
      autoReconnectTimer = setTimeout(autoDetectSerial, 3000);
    }
  } catch (err) {
    console.error('[Serial] Autodetect error:', err.message);
    if (autoReconnectTimer) clearTimeout(autoReconnectTimer);
    autoReconnectTimer = setTimeout(autoDetectSerial, 3000);
  }
}


// ── Boot ──────────────────────────────────────────────────────────────────────
// Primary data source: UDP port 4210 from Arduino UNO Q App Lab Python (always running above).
// USB Serial is available on-demand via the dashboard's port selector (select_port WS message).
// autoDetectSerial() is NOT called at boot — UNO Q uses UDP over WiFi, not USB Serial.
console.log('[Boot] UDP listener active. Waiting for UNO Q App Lab data on port ' + UDP_PORT + '...');
