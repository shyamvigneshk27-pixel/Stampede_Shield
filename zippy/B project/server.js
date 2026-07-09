/**
 * StampedeShield - Local Development HTTP & WebSocket Server
 * Dual-channel real-time server with serial port auto-detection,
 * backend SPC processing engine, and connected client heartbeat manager.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const SPCEngine = require('./spc.js');

const PORT = 3000;
const WS_PORT = 8080;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ── HTTP STATIC SERVER ───────────────────────────────────────────
const server = http.createServer((req, res) => {
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
          res.setHeader('Content-Type', 'text/plain');
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
        res.setHeader('Content-Type', 'text/plain');
        res.end(`Internal Server Error: Could not read file`);
        return;
      }
      const ext = path.extname(absolutePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.end(data);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n=============================================================');
  console.log('🛡️  STAMPEDER SHIELD - CROWD COMPRESSION MONITOR SERVER');
  console.log('=============================================================');
  console.log(`HTTP Dashboard Address: http://localhost:${PORT}`);
  console.log(`WebSocket Port:         ws://localhost:${WS_PORT}`);
  console.log('-------------------------------------------------------------');
});

// ── WEBSOCKET SERVER ──────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });
const clients = new Set(); // Set of { socket, type, deviceId, lastHeartbeat }

wss.on('connection', (ws) => {
  const clientInfo = {
    socket: ws,
    type: 'unknown',
    deviceId: 'Dashboard Client',
    lastHeartbeat: Date.now()
  };
  clients.add(clientInfo);
  console.log(`[WS] New connection established. Active clients: ${clients.size}`);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'heartbeat') {
        clientInfo.type = 'android';
        clientInfo.deviceId = data.deviceId || 'Android Phone';
        clientInfo.lastHeartbeat = Date.now();
        broadcastClientList();
      } else if (data.type === 'dashboard_init') {
        clientInfo.type = 'dashboard';
        clientInfo.deviceId = data.deviceId || 'Web Dashboard';
        broadcastClientList();
      } else if (data.type === 'select_port') {
        console.log(`[WS] Client requested port switch: ${data.path}`);
        connectSerial(data.path);
      } else if (data.type === 'list_ports') {
        const ports = await getPortsList();
        ws.send(JSON.stringify({ type: 'ports_list', ports }));
      } else if (data.type === 'tune_spc') {
        console.log(`[SPC] Baseline tuned. Mean: ${data.mean}, Sigma: ${data.sigma}`);
        spcEngine.setBaseline(data.mean, data.sigma);
      } else if (data.type === 'set_gain') {
        console.log(`[SPC] Sensor gain factor set to: ${data.gain}`);
        gainFactor = data.gain;
      }
    } catch (err) {
      console.error("[WS] Error parsing message:", err);
    }
  });

  ws.on('close', () => {
    clients.delete(clientInfo);
    console.log(`[WS] Connection closed. Active clients: ${clients.size}`);
    broadcastClientList();
  });

  ws.on('error', (err) => {
    console.error("[WS] Connection error:", err);
    clients.delete(clientInfo);
    broadcastClientList();
  });

  // Send initial list of ports
  getPortsList().then(ports => {
    ws.send(JSON.stringify({ type: 'ports_list', ports }));
  });
});

// Broadcast helper
function broadcast(msgString) {
  clients.forEach(client => {
    if (client.socket.readyState === 1) { // OPEN
      client.socket.send(msgString);
    }
  });
}

function broadcastClientList() {
  const list = Array.from(clients).map(c => ({
    type: c.type,
    deviceId: c.deviceId,
    status: 'Connected'
  }));
  broadcast(JSON.stringify({ type: 'client_list', clients: list }));
}

// Heartbeat Monitor (timeouts Android clients after 10 seconds of no heartbeat)
setInterval(() => {
  const now = Date.now();
  let changed = false;
  clients.forEach(client => {
    if (client.type === 'android' && (now - client.lastHeartbeat) > 10000) {
      console.log(`[WS] Heartbeat timeout for ${client.deviceId}`);
      client.socket.close();
      clients.delete(client);
      changed = true;
    }
  });
  if (changed) {
    broadcastClientList();
  }
}, 3000);

// ── SPC ENGINE & HARDWARE CALIBRATION ────────────────────────────
const spcEngine = new SPCEngine(60);
let gainFactor = 1.0;

// Top-level state tracking variables
let activeSerialPort = null;
let serialParser = null;
let isSerialConnected = false;

function processAndBroadcast(rawSensors) {
  const scaledSensors = rawSensors.map(v => Math.min(1023, Math.round(v * gainFactor)));
  const analysis = spcEngine.processReading(scaledSensors);

  let status = "SAFE";
  if (analysis.riskScore >= 85) {
    status = "CRITICAL";
  } else if (analysis.riskScore >= 70) {
    status = "HIGH";
  } else if (analysis.riskScore >= 30) {
    status = "WATCH";
  }

  const packet = {
    type: "telemetry",
    timestamp: new Date().toISOString(),
    sensors: scaledSensors,
    rawSensors: rawSensors,
    risk: analysis.riskScore,
    status: status,
    spcState: analysis.spcStatus === 'Out of Control' ? 'Out of Control' :
              analysis.spcStatus === 'Drifting'      ? 'Drifting' : 'Stable',
    alert: analysis.spcReason,
    activeSensors: analysis.activeSensorsCount,
    currentAvg: analysis.currentAvg,
    currentSd: analysis.spatialStdDev,
    controlLimits: analysis.controlLimits,
    activeCOM: activeSerialPort ? activeSerialPort.path : "Simulator"
  };

  broadcast(JSON.stringify(packet));
}

// ── SERIAL PORT HARDWARE MANAGER ────────────────────────────────
let activePortPath = null;

async function getPortsList() {
  try {
    const ports = await SerialPort.list();
    return ports.map(p => p.path);
  } catch (err) {
    console.error("[Serial] Error listing ports:", err);
    return [];
  }
}

function connectSerial(portPath) {
  // Close existing port if any
  closeActiveSerialPort();

  console.log(`[Serial] Connecting to COM Port: ${portPath}`);
  try {
    activeSerialPort = new SerialPort({ path: portPath, baudRate: 9600 });
    serialParser = activeSerialPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    activeSerialPort.on('open', () => {
      console.log(`[Serial] Successfully opened port: ${portPath}`);
      isSerialConnected = true;
      activePortPath = portPath;
    });

    serialParser.on('data', (data) => {
      const line = data.trim();
      if (!line) return;
      
      const values = line.split(',').map(Number);
      if (values.length === 6 && !values.some(isNaN)) {
        processAndBroadcast(values);
      } else {
        console.warn(`[Serial] Invalid packet received: ${line}`);
      }
    });

    activeSerialPort.on('close', () => {
      console.log(`[Serial] Port closed: ${portPath}`);
      handleSerialDisconnect();
    });

    activeSerialPort.on('error', (err) => {
      console.error(`[Serial] Port error on ${portPath}:`, err.message);
      handleSerialDisconnect();
    });

  } catch (err) {
    console.error(`[Serial] Open error on ${portPath}:`, err.message);
    handleSerialDisconnect();
  }
}

function closeActiveSerialPort() {
  if (activeSerialPort) {
    try {
      if (activeSerialPort.isOpen) {
        activeSerialPort.close();
      }
    } catch (e) {
      console.error("[Serial] Safe close error:", e.message);
    }
    // Remove listeners to prevent memory leaks and duplicate error triggers
    activeSerialPort.removeAllListeners();
    activeSerialPort = null;
    serialParser = null;
  }
}

let autoReconnectTimer = null;

function handleSerialDisconnect() {
  if (!isSerialConnected && activePortPath === null) return; // Already disconnected
  
  isSerialConnected = false;
  activePortPath = null;
  closeActiveSerialPort();
  console.log("[Serial] Arduino Disconnected. Waiting for reconnection...");
  
  // Broadcast disconnect state explicitly
  broadcast(JSON.stringify({
    type: "telemetry",
    timestamp: new Date().toISOString(),
    sensors: [0, 0, 0, 0, 0, 0],
    rawSensors: [0, 0, 0, 0, 0, 0],
    risk: 0,
    status: "DISCONNECTED",
    spcState: "NORMAL",
    alert: "Hardware disconnected",
    activeSensors: 0,
    currentAvg: 0,
    currentSd: 0,
    controlLimits: { lcl: 0, ucl: 0, mean: 0 },
    activeCOM: "Disconnected"
  }));

  // Trigger auto-reconnect loop
  if (autoReconnectTimer) clearTimeout(autoReconnectTimer);
  autoReconnectTimer = setTimeout(autoDetectSerial, 3000);
}

async function autoDetectSerial() {
  try {
    const ports = await SerialPort.list();
    console.log("[Serial] Detected ports:", ports.map(p => p.path));

    const targetPort = ports.find(port => {
      const desc = (port.friendlyName || port.description || "").toLowerCase();
      const manufacturer = (port.manufacturer || "").toLowerCase();
      return desc.includes("arduino") || 
             desc.includes("ch340") || 
             desc.includes("usb-to-serial") || 
             manufacturer.includes("arduino") || 
             manufacturer.includes("ftdi") ||
             manufacturer.includes("silicon labs") ||
             manufacturer.includes("wch");
    }) || ports[0];

    if (targetPort) {
      console.log(`[Serial] Auto-detecting and connecting to: ${targetPort.path}`);
      connectSerial(targetPort.path);
    } else {
      console.log("[Serial] No hardware ports found. Retrying in 3 seconds...");
      if (autoReconnectTimer) clearTimeout(autoReconnectTimer);
      autoReconnectTimer = setTimeout(autoDetectSerial, 3000);
    }
  } catch (err) {
    console.error("[Serial] Autodetect failed:", err.message);
    if (autoReconnectTimer) clearTimeout(autoReconnectTimer);
    autoReconnectTimer = setTimeout(autoDetectSerial, 3000);
  }
}

// ── INITIALIZATION ──────────────────────────────────────────────
autoDetectSerial();
