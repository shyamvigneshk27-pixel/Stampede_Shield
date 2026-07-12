/**
 * StampedeShield — WebSocket Telemetry Manager
 *
 * Manages the browser-side WebSocket connection to Node.js (port 8080).
 * Handles reconnection, message routing, and server IP persistence.
 *
 * Message routing:
 *   type:"telemetry"    → onData()    (raw sensor frame, 10 Hz)
 *   type:"telemetry_ml" → onData()    (Kalman+LSTM+Fusion enriched frame)
 *   type:"client_list"  → onMessage() (connected devices list)
 *   type:"ports_list"   → onMessage() (available serial ports)
 */

class TelemetryManager {
  constructor(onDataCallback, onStatusCallback, onMessageCallback) {
    this.onData    = onDataCallback;
    this.onStatus  = onStatusCallback;
    this.onMessage = onMessageCallback;

    this.webSocket       = null;
    this.serverIp        = localStorage.getItem('stampedeshield_server_ip') || 'localhost';
    this.wsPort          = 8080;
    this.reconnectTimer  = null;
    this.shouldReconnect = true;
  }

  getServerIp()  { return this.serverIp; }

  setServerIp(ip) {
    this.serverIp = ip;
    localStorage.setItem('stampedeshield_server_ip', ip);
  }

  getWsUrl() {
    return `ws://${this.serverIp}:${this.wsPort}`;
  }

  connect() {
    this.shouldReconnect = true;
    const url = this.getWsUrl();
    console.log(`[WS] Connecting to: ${url}`);
    this.notifyStatus('disconnected', 'Connecting...');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      this.webSocket = new WebSocket(url);

      this.webSocket.onopen = () => {
        console.log('[WS] Connected');
        this.notifyStatus('websocket-active', `Connected: ${this.serverIp}`);
        this.send({ type: 'dashboard_init', deviceId: 'Web Dashboard' });
      };

      this.webSocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'telemetry' || data.type === 'telemetry_ml') {
            this.onData(data.sensors, data);
          } else if (this.onMessage) {
            this.onMessage(data);
          }
        } catch (err) {
          console.warn('[WS] Parse error:', err);
        }
      };

      this.webSocket.onerror = () => {
        this.notifyStatus('disconnected', 'Connection Error');
      };

      this.webSocket.onclose = (event) => {
        console.log(`[WS] Closed (code=${event.code})`);
        this.notifyStatus('disconnected', 'Disconnected');
        this.webSocket = null;
        if (this.shouldReconnect) {
          this.reconnectTimer = setTimeout(() => this.connect(), 2000);
        }
      };

    } catch (err) {
      console.error('[WS] Init error:', err);
      this.notifyStatus('disconnected', 'Error');
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    }
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.webSocket) { this.webSocket.close(); this.webSocket = null; }
    this.notifyStatus('disconnected', 'Offline');
  }

  send(dataObj) {
    if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(dataObj));
      return true;
    }
    return false;
  }

  notifyStatus(statusClass, label) {
    if (this.onStatus) this.onStatus(statusClass, label);
  }
}
