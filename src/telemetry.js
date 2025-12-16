// Analytics Telemetry Service
// Handles anonymous usage data collection for Note Relay analytics
// Created: December 3, 2025

class TelemetryService {
  constructor() {
    this.apiUrl = 'https://noterelay.io/api/analytics';
    this.queue = [];
    this.sessionId = this.generateSessionId();
    this.sessionStart = Date.now();
    this.flushInterval = null;
    this.vaultId = null;
    this.userId = null; // Owner of vault (for data isolation)
    this.nodeId = null; // Machine ID (Trinity Protocol)
    this.enabled = false;
    
    // Device/Browser detection cache
    this.deviceInfo = null;
    
    // Bind methods
    this.handleUnload = this.handleUnload.bind(this);
  }
  
  /**
   * Initialize telemetry service
   * @param {string} vaultId - Active vault ID (from active_vaults table)
   * @param {string} userId - Owner user ID (for data isolation)
   * @param {string} nodeId - Machine ID from Trinity Protocol (for device tracking)
   * @param {boolean} enabled - Whether analytics is enabled
   */
  init(vaultId, userId, nodeId, enabled = false) {
    this.vaultId = vaultId;
    this.userId = userId;
    this.nodeId = nodeId;
    this.enabled = enabled;
    
    if (!enabled) {
      console.log('[Telemetry] Analytics disabled');
      return;
    }
    
    if (!vaultId || !userId || !nodeId) {
      console.warn('[Telemetry] Missing required IDs (vault/user/node), analytics disabled');
      this.enabled = false;
      return;
    }
    
    // Detect device info once
    this.deviceInfo = this.detectEnvironment();
    
    // Start flush interval (every 5 minutes)
    this.flushInterval = setInterval(() => {
      this.flush();
    }, 5 * 60 * 1000);
    
    // Register unload handler for reliable final flush
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.handleUnload);
    }
    
    console.log('[Telemetry] Initialized - Vault:', vaultId, 'User:', userId, 'Node:', nodeId.substring(0, 8) + '...');
  }
  
  /**
   * Cleanup on unload - use sendBeacon for reliability
   */
  handleUnload() {
    if (this.queue.length > 0) {
      // Try sendBeacon for reliable delivery on page unload
      const payload = JSON.stringify(this.queue);
      const sent = navigator.sendBeacon 
        ? navigator.sendBeacon(`${this.apiUrl}?route=record`, payload)
        : false;
      
      if (!sent) {
        // Fallback: synchronous XHR (blocking but reliable)
        try {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `${this.apiUrl}?route=record`, false); // synchronous
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.send(payload);
        } catch (error) {
          console.error('[Telemetry] Failed to send on unload:', error);
        }
      }
    }
  }
  
  /**
   * Record session start event
   * @param {string} network - 'lan', 'tailscale', or 'cloud'
   */
  recordSessionStart(network) {
    if (!this.enabled) return;
    if (!network) network = 'lan';
    
    const event = {
      vault_id: this.vaultId,
      user_id: this.userId,
      node_id: this.nodeId,
      session_id: this.sessionId,
      event_type: 'session_start',
      network: network,
      browser: this.deviceInfo.browser,
      device: this.deviceInfo.device,
      os: this.deviceInfo.os,
      payload: {
        plugin_version: this.getPluginVersion()
      }
    };
    
    this.queue.push(event);
    console.log('[Telemetry] Session start recorded:', network);
    
    // Flush immediately for session start
    this.flush();
  }
  
  /**
   * Record session end event
   */
  recordSessionEnd() {
    if (!this.enabled) return;
    
    const durationSeconds = Math.floor((Date.now() - this.sessionStart) / 1000);
    
    const event = {
      vault_id: this.vaultId,
      user_id: this.userId,
      node_id: this.nodeId,
      session_id: this.sessionId,
      event_type: 'session_end',
      network: this.deviceInfo.lastNetwork || 'lan',
      browser: this.deviceInfo.browser,
      device: this.deviceInfo.device,
      os: this.deviceInfo.os,
      duration_seconds: durationSeconds,
      payload: {}
    };
    
    this.queue.push(event);
    console.log('[Telemetry] Session end recorded:', durationSeconds, 'seconds');
    
    // Flush immediately for session end
    this.flush();
  }

  /**
   * Record sync event
   * @param {number} bytes - Bytes transferred
   */
  recordSync(bytes) {
    if (!this.enabled) return;
    if (!bytes) bytes = 0;
    
    const event = {
      vault_id: this.vaultId,
      user_id: this.userId,
      node_id: this.nodeId,
      session_id: this.sessionId,
      event_type: 'sync',
      network: this.deviceInfo.lastNetwork || 'lan',
      browser: this.deviceInfo.browser,
      device: this.deviceInfo.device,
      os: this.deviceInfo.os,
      bytes_transferred: bytes,
      payload: {}
    };
    
    this.queue.push(event);
    
    // Don't flush immediately for syncs (batch them)
    if (this.queue.length >= 10) {
      this.flush();
    }
  }

  /**
   * Record error event
   * @param {string} errorCode - Error code/type
   * @param {string} message - Error message (optional)
   */
  recordError(errorCode, message) {
    if (!this.enabled) return;
    if (!message) message = null;
    
    const event = {
      vault_id: this.vaultId,
      user_id: this.userId,
      node_id: this.nodeId,
      session_id: this.sessionId,
      event_type: 'error',
      network: this.deviceInfo.lastNetwork || 'lan',
      browser: this.deviceInfo.browser,
      device: this.deviceInfo.device,
      os: this.deviceInfo.os,
      error_code: errorCode,
      payload: message ? { message } : {}
    };
    
    this.queue.push(event);
    console.log('[Telemetry] Error recorded:', errorCode);
    
    // Flush immediately for errors
    this.flush();
  }

  /**
   * Flush queued events to server
   */
  async flush() {
    if (this.queue.length === 0) return;
    
    const batch = [...this.queue];
    this.queue = [];
    
    try {
      // Send events one by one (API expects single events)
      for (const event of batch) {
        await fetch(`${this.apiUrl}?route=record`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event)
        });
      }
      
      console.log(`[Telemetry] Flushed ${batch.length} event(s)`);
    } catch (error) {
      console.error('[Telemetry] Flush failed:', error);
      // Re-queue failed events (up to limit)
      if (this.queue.length < 50) {
        this.queue.push(...batch.slice(-10)); // Keep last 10
      }
    }
  }
  
  /**
   * Detect browser, device, and OS
   */
  detectEnvironment() {
    const ua = navigator.userAgent;
    
    // Detect browser
    let browser = 'other';
    if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'chrome';
    else if (ua.includes('Safari') && !ua.includes('Chrome')) {
      browser = /Mobile|Android|iPhone|iPad/.test(ua) ? 'mobile_safari' : 'safari';
    }
    else if (ua.includes('Firefox')) browser = 'firefox';
    else if (ua.includes('Edg')) browser = 'edge';
    
    // Detect device
    let device = 'desktop';
    if (/Mobile|Android|iPhone/.test(ua)) device = 'mobile';
    else if (/iPad|Tablet/.test(ua)) device = 'tablet';
    
    // Detect OS
    let os = 'other';
    if (ua.includes('Mac OS X')) os = 'macos';
    else if (ua.includes('Windows')) os = 'windows';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'ios';
    else if (ua.includes('Android')) os = 'android';
    else if (ua.includes('Linux')) os = 'linux';
    
    return { browser, device, os, lastNetwork: null };
  }
  
  /**
   * Detect network type from connection
   * @param {string} remoteAddress - Remote IP address
   * @returns {string} 'lan', 'tailscale', or 'cloud'
   */
  detectNetwork(remoteAddress) {
    if (!remoteAddress) return 'lan';
    
    // LAN: Private IP ranges
    if (remoteAddress.startsWith('192.168.') || 
        remoteAddress.startsWith('10.') || 
        remoteAddress.startsWith('172.')) {
      return 'lan';
    }
    
    // Tailscale: 100.x.x.x range
    if (remoteAddress.startsWith('100.')) {
      return 'tailscale';
    }
    
    // Everything else is cloud (via TURN relay)
    return 'cloud';
  }
  
  /**
   * Update last known network type
   */
  setNetwork(network) {
    if (this.deviceInfo) {
      this.deviceInfo.lastNetwork = network;
    }
  }
  
  /**
   * Generate unique session ID
   */
  generateSessionId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Get plugin version (stub - should be imported from manifest)
   */
  getPluginVersion() {
    return '7.1.0'; // TODO: Import from manifest.json
  }
  
  /**
   * Update vault ID (e.g., after registration switches from local to database ID)
   * @param {string} newVaultId - New vault ID to use for all future events
   */
  updateVaultId(newVaultId) {
    if (!newVaultId) {
      console.warn('[Telemetry] Cannot update to null vault ID');
      return;
    }
    
    const oldId = this.vaultId;
    this.vaultId = newVaultId;
    
    // Update any queued events to use the new vault ID
    this.queue = this.queue.map(event => ({
      ...event,
      vault_id: newVaultId
    }));
    
    console.log(`[Telemetry] Vault ID updated: ${oldId} → ${newVaultId}`);
    
    // Flush immediately to send updated events
    this.flush();
  }

  /**
   * Cleanup - stop intervals and remove listeners
   */
  destroy() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.handleUnload);
    }
    
    // Final flush
    this.flush();
    
    console.log('[Telemetry] Destroyed');
  }
}

// Export singleton instance
const telemetryService = new TelemetryService();
export default telemetryService;
