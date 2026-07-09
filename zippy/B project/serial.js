/**
 * StampedeShield - Telemetry Connection Interface
 * Manages WebSocket connection to the Node.js backend.
 */

class TelemetryManager {
  constructor(onDataCallback, onStatusCallback, onMessageCallback) {
    this.onData = onDataCallback;
    this.onStatus = onStatusCallback;
    this.onMessage = onMessageCallback; // for non-telemetry messages (ports, clients, etc.)
    
    this.webSocket = null;
    this.serverIp = localStorage.getItem("stampedeshield_server_ip") || "localhost";
    this.wsPort = 8080;
    this.reconnectTimer = null;
    this.shouldReconnect = true;
  }

  getServerIp() {
    return this.serverIp;
  }

  setServerIp(ip) {
    this.serverIp = ip;
    localStorage.setItem("stampedeshield_server_ip", ip);
  }

  getWsUrl() {
    return `ws://${this.serverIp}:${this.wsPort}`;
  }

  connect() {
    this.shouldReconnect = true;
    const url = this.getWsUrl();
    console.log(`[WS] Connecting to server at: ${url}`);
    this.notifyStatus("disconnected", "Connecting...");

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      this.webSocket = new WebSocket(url);

      this.webSocket.onopen = () => {
        console.log("[WS] Connection opened successfully");
        this.notifyStatus("websocket-active", `Connected: ${this.serverIp}`);
        
        // Identify as dashboard
        this.send({ type: 'dashboard_init', deviceId: 'Web Dashboard' });
      };

      this.webSocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'telemetry') {
            // Forward telemetry to page pipeline
            this.onData(data.sensors, data);
          } else if (this.onMessage) {
            // Forward helper control messages (client list, ports, etc.)
            this.onMessage(data);
          }
        } catch (err) {
          console.warn("[WS] Error parsing message data:", event.data, err);
        }
      };

      this.webSocket.onerror = (error) => {
        console.error("[WS] WebSocket error:", error);
        this.notifyStatus("disconnected", "Connection Error");
      };

      this.webSocket.onclose = (event) => {
        console.log(`[WS] Connection closed: code=${event.code}`);
        this.notifyStatus("disconnected", "Disconnected");
        this.webSocket = null;
        
        if (this.shouldReconnect) {
          this.reconnectTimer = setTimeout(() => this.connect(), 2000);
        }
      };
    } catch (err) {
      console.error("[WS] Initialization error:", err);
      this.notifyStatus("disconnected", "Error");
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    }
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.webSocket) {
      this.webSocket.close();
      this.webSocket = null;
    }
    this.notifyStatus("disconnected", "Offline");
  }

  send(dataObj) {
    if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(dataObj));
      return true;
    }
    return false;
  }

  notifyStatus(statusClass, label) {
    if (this.onStatus) {
      this.onStatus(statusClass, label);
    }
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TelemetryManager;
} else {
  window.TelemetryManager = TelemetryManager;
}
