import { Buffer } from 'buffer';
if (typeof window !== 'undefined') {
}

const obsidian = require('obsidian');
const { createClient } = require('@supabase/supabase-js');
const SimplePeer = require('simple-peer');
const { readFileSync } = require('fs');
const { join } = require('path');


// Supabase credentials loaded dynamically from API (no hardcoded keys)
let SUPABASE_URL = null;
let SUPABASE_KEY = null;
const API_BASE_URL = 'https://noterelay.io';
const BUILD_VERSION = '2024.12.16-1521';
const CHUNK_SIZE = 16 * 1024;
const DEFAULT_SETTINGS = {
  enableRemoteAccess: false,
  passwordHash: '',
  // IDENTITY-BASED REMOTE ACCESS
  userEmail: '', // User's email address (subscription validation)
  masterPasswordHash: '', // Owner's override password
  vaultId: '', // Unique vault identifier (auto-generated)
};

async function hashString(str) {
  const msgBuffer = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

class NoteRelay extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new NoteRelaySettingTab(this.app, this));

    // Generate pluginId from vault path for license validation
    const vaultPath = this.app.vault.adapter.basePath;
    this.pluginId = await hashString(vaultPath);

    // Generate vaultId if missing (for identity-based system)
    if (!this.settings.vaultId) {
      this.settings.vaultId = crypto.randomUUID();
      await this.saveSettings();
      console.log('Generated new vaultId:', this.settings.vaultId);
    }
    console.log('Plugin ID:', this.pluginId);

    // This stays local (localStorage) and does NOT sync via Obsidian Sync
    // Purpose: Distinguish different devices running the same vault
    let nodeId = window.localStorage.getItem('note-relay-node-id');
    if (!nodeId) {
      nodeId = crypto.randomUUID();
      window.localStorage.setItem('note-relay-node-id', nodeId);
      console.log('Generated new Machine ID (Node ID):', nodeId);
    }
    this.nodeId = nodeId;
    console.log('Machine Identity:', this.nodeId);

    console.log(`%c PORTAL ${BUILD_VERSION} READY`, 'color: #00ff00; font-weight: bold; background: #000;');
    this.statusBar = this.addStatusBarItem();
    this.isConnected = false;

    // Auto-connect on plugin load
    this.connectSignaling();

    // Initialize heartbeat timestamp
    this.lastHeartbeatTime = Date.now();

    // Register wake detection
    this.wakeHandler = async () => {
      if (!document.hidden && this.settings.userEmail) {
        await this.checkConnectionHealth();
      }
    };

    this.registerDomEvent(document, 'visibilitychange', this.wakeHandler);
    console.log('Note Relay: Wake detection enabled');

    // Only auto-connect if fully configured (email + password)
    // Only auto-connect if enabled AND fully configured
    if (this.settings.enableRemoteAccess && this.settings.userEmail && this.settings.masterPasswordHash) {
      setTimeout(() => this.connectSignaling(), 1000);
    } else {
      this.statusBar?.setText('Note Relay: Not configured');
    }
  }

  onunload() {
    this.disconnectSignaling();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }


  // Sanitize file paths to prevent directory traversal attacks
  sanitizePath(unsafePath) {
    if (!unsafePath || typeof unsafePath !== 'string') return '';

    let clean = unsafePath
      .replace(/\\/g, '/')           // Normalize backslashes
      .replace(/\0/g, '')            // Remove null bytes
      .replace(/\/+/g, '/')          // Collapse multiple slashes
      .trim();

    // Remove ALL path traversal patterns (before and after normalization)
    while (clean.includes('..')) {
      clean = clean.replace(/\.\./g, '');
    }

    // Force relative path (no leading slash)
    clean = clean.replace(/^\/+/, '');

    return clean;
  }

  async registerVaultAndGetSignalId() {
    if (!this.settings.userEmail) {
      console.log('No user email configured');
      return null;
    }

    try {
      const os = require('os');
      const response = await fetch('https://noterelay.io/api/vaults?route=register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          email: this.settings.userEmail,
          vaultId: this.settings.vaultId,
          signalId: this.pluginId,
          vaultName: this.app.vault.getName(),
          hostname: os.hostname(),
          nodeId: this.nodeId,
          machineName: os.hostname()
        })
      });

      if (!response.ok) {
        let errorMessage = `Registration failed: ${response.status}`;

        try {
          const errorData = await response.json();
          // Handle specific error cases
          if (response.status === 404 && errorData.error === 'Account not found') {
            errorMessage = '❌ Account not found. Please sign up at noterelay.io first.';
          } else if (response.status === 400 && errorData.error === 'Invalid email format') {
            errorMessage = '❌ Invalid email format. Please check your email address.';
          } else if (errorData.error) {
            errorMessage = `❌ ${errorData.error}`;
          }
        } catch (e) {
          // If JSON parsing fails, use text response
          const errorText = await response.text();
          console.error('Registration failed:', response.status, errorText);
        }

        new obsidian.Notice(errorMessage, 10000);
        return null;
      }

      const result = await response.json();

      if (result.success) {
        console.log('Vault registered! Signal ID:', result.signalId, 'DB Vault ID:', result.vaultId, 'User ID:', result.userId, 'Plan:', result.planType);
        this.signalId = result.signalId; this.isConnected = true;

        this.startHeartbeat();
        // Fetch TURN credentials after successful registration
        await this.fetchTurnCredentials();
        return result.signalId;
      } else {
        new obsidian.Notice('Vault registration failed: ' + (result.error || 'Unknown error'));
        return null;
      }
    } catch (error) {
      console.error('Vault registration error:', error);
      new obsidian.Notice('Failed to register vault: ' + error.message);
      return null;
    }
  }

  async fetchTurnCredentials() {
    if (!this.settings.userEmail) return;

    try {
      console.log('Fetching TURN credentials for host...');
      const response = await fetch('https://noterelay.io/api/turn-credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: this.settings.userEmail
        })
      });

      if (response.ok) {
        const data = await response.json();
        if (data.iceServers) {
          this.iceServers = data.iceServers;
          console.log('✅ Host TURN credentials obtained');
        }
      } else {
        const errorText = await response.text();
        console.warn('Failed to fetch host TURN credentials:', response.status, errorText);
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.details) {
            new obsidian.Notice(`TURN Auth Failed: ${errorJson.details}`);
          } else {
            new obsidian.Notice(`TURN Auth Failed: ${response.status}`);
          }
        } catch (e) {
          new obsidian.Notice(`TURN Auth Failed: ${response.status}`);
        }
      }
    } catch (e) {
      console.error('Error fetching host TURN credentials:', e);
    }
  }

  startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    console.log('Note Relay: Starting API Heartbeat (5m)...');

    // 1. Immediate Ping
    this.sendHeartbeat();

    // 2. Schedule Loop (Every 5 minutes)
    this.heartbeatInterval = setInterval(async () => {
      await this.sendHeartbeat();
    }, 300000); // 5 Minutes
  }

  async sendHeartbeat() {
    if (!this.settings.userEmail || !this.signalId) {
      return { success: false, fatal: false, reason: 'no-config' };
    }

    try {
      const response = await fetch('https://noterelay.io/api/vaults?route=heartbeat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: this.settings.userEmail,
          vaultId: this.settings.vaultId,
          signalId: this.signalId
        })
      });

      // ALWAYS update timestamp (we attempted contact)
      this.lastHeartbeatTime = Date.now();

      if (!response.ok) {
        console.warn(`Note Relay: Heartbeat transient error (${response.status})`);
        return { success: false, fatal: false, reason: 'server' };
      }

      return { success: true, fatal: false };

    } catch (err) {
      // Update timestamp even on network error
      this.lastHeartbeatTime = Date.now();
      console.error('Note Relay: Heartbeat network error', err);
      return { success: false, fatal: false, reason: 'network' };
    }
  }

  disconnectSignaling() {
    console.log('Disconnecting signaling...');

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Unsubscribe from Supabase
    if (this.channel) {
      this.channel.unsubscribe();
      this.channel = null;
    }

    if (this.supabase) {
      this.supabase.removeAllChannels();
      this.supabase = null;
    }

    this.signalId = null; this.isConnected = false;
    if (this.statusBar) {
      this.statusBar?.setText('Note Relay: Disconnected');
      if (this.statusBar) this.statusBar.style.color = '';
    }
    console.log('Signaling disconnected. Offline mode.');
  }

  /**
   * Unified command processor for WebRTC mode
   * @param {Object} msg - The command message { cmd, path, data }
   * @param {Function} sendCallback - Function to send response: (type, data, meta) => void
   */
  async processCommand(msg, sendCallback, isReadOnly = false) {
    try {
      if (msg.cmd === 'PING' || msg.cmd === 'HANDSHAKE') {
        // TODO: Implement Challenge-Response Auth (Nonce) for V2
        console.log('🔒 Server PING/HANDSHAKE received');
        sendCallback(msg.cmd === 'PING' ? 'PONG' : 'HANDSHAKE_ACK', {
          version: BUILD_VERSION,
          vaultName: this.app.vault.getName()
        });
        return;
      }

      console.log('Note Relay Command:', msg.cmd, msg.path || '');

      switch (msg.cmd) {
        case 'GET_TREE':
          await this.handleGetTree(sendCallback);
          break;
        case 'GET_RENDERED_FILE':
          await this.handleGetRenderedFile(msg, sendCallback, isReadOnly);
          break;
        case 'GET_FILE':
          await this.handleGetFile(msg, sendCallback);
          break;
        case 'SAVE_FILE':
          await this.handleSaveFile(msg, sendCallback, isReadOnly);
          break;
        case 'CREATE_FILE':
          await this.handleCreateFile(msg, sendCallback, isReadOnly);
          break;
        case 'DELETE_FILE':
          await this.handleDeleteFile(msg, sendCallback, isReadOnly);
          break;
        case 'RENAME_FILE':
          await this.handleRenameFile(msg, sendCallback, isReadOnly);
          break;
        case 'OPEN_FILE':
          await this.handleOpenFile(msg, sendCallback);
          break;
        default:
          console.warn('Unknown command:', msg.cmd);
          sendCallback('ERROR', { message: 'Unknown command' });
      }
    } catch (e) {
      console.error('Note Relay Error', e);
      sendCallback('ERROR', { message: e.message });
    }
  }
}

class NoteRelaySettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Note Relay Configuration' });

    // Step 0: Consent Toggle
    new obsidian.Setting(containerEl)
      .setName('Enable Remote Access')
      .setDesc('Allow this plugin to connect to Note Relay servers')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableRemoteAccess)
        .onChange(async (value) => {
          this.plugin.settings.enableRemoteAccess = value;
          await this.plugin.saveSettings();
          if (value) {
            if (this.plugin.settings.userEmail && this.plugin.settings.masterPasswordHash) {
              this.plugin.connectSignaling();
            }
          } else {
            this.plugin.disconnectSignaling();
          }
          this.display();
        }));

    // Step 1: Email Account
    containerEl.createEl('h3', { text: '1️⃣ Account' });

    new obsidian.Setting(containerEl)
      .setName('Email Address')
      .setDesc('Your noterelay.io account email')
      .addText(text => {
        text.setPlaceholder('you@example.com')
          .setValue(this.plugin.settings.userEmail || '');
        text.inputEl.addEventListener('blur', async () => {
          const value = text.getValue().trim();
          if (!value) return;
          if (value === this.plugin.settings.userEmail && this.plugin.settings.emailValidated) return;

          try {
            const response = await fetch(`${API_BASE_URL}/api/plugin-init`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: value, vaultId: this.plugin.settings.vaultId })
            });

            if (response.ok) {
              this.plugin.settings.userEmail = value;
              this.plugin.settings.emailValidated = true;
              await this.plugin.saveSettings();
              new obsidian.Notice('✅ Account verified');
            } else if (response.status === 404) {
              this.plugin.settings.emailValidated = false;
              await this.plugin.saveSettings();
              new obsidian.Notice('❌ Account not found. Sign up at noterelay.io first.');
            } else {
              new obsidian.Notice('⚠️ Could not verify account');
            }
          } catch (err) {
            new obsidian.Notice('⚠️ Network error verifying account');
          }
          this.display();
        });
        text.inputEl.addEventListener('keypress', async (e) => {
          if (e.key === 'Enter') text.inputEl.blur();
        });
      });

    const emailStatus = containerEl.createDiv({ cls: 'setting-item-description' });
    emailStatus.style.marginTop = '-10px';
    emailStatus.style.marginBottom = '20px';
    if (this.plugin.settings.emailValidated) {
      emailStatus.setText('✅ Account verified');
    } else if (this.plugin.settings.userEmail) {
      emailStatus.setText('⚠️ Account not verified - press Tab to verify');
    } else {
      emailStatus.setText('Enter your noterelay.io email');
    }

    // Step 2: Vault Password
    containerEl.createEl('h3', { text: '2️⃣ Vault Password' });

    new obsidian.Setting(containerEl)
      .setName('Remote Vault Password')
      .setDesc('Password required to access your vault remotely')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('Enter password');
        text.inputEl.addEventListener('blur', async () => {
          const value = text.getValue();
          if (value) {
            this.plugin.settings.masterPasswordHash = await hashString(value);
            await this.plugin.saveSettings();
            this.display();
          }
        });
        text.inputEl.addEventListener('keypress', async (e) => {
          if (e.key === 'Enter') text.inputEl.blur();
        });
      });

    const passStatus = containerEl.createDiv({ cls: 'setting-item-description' });
    passStatus.style.marginTop = '-10px';
    passStatus.style.marginBottom = '20px';
    passStatus.setText(this.plugin.settings.masterPasswordHash ? '✅ Password is set' : '⚠️ Password required');

    // Step 3: Connect Relay
    containerEl.createEl('h3', { text: '3️⃣ Connect Relay' });

    const canStart = this.plugin.settings.emailValidated && this.plugin.settings.masterPasswordHash;

    if (!canStart) {
      const warningDiv = containerEl.createDiv();
      warningDiv.style.cssText = 'padding: 15px; margin-bottom: 15px; background: rgba(255,152,0,0.1); border-left: 3px solid #ff9800; border-radius: 4px;';
      if (!this.plugin.settings.emailValidated) {
        warningDiv.innerHTML = '<strong>⚠️ Step 1 incomplete</strong><br>Enter a valid noterelay.io email and press Tab.';
      } else {
        warningDiv.innerHTML = '<strong>⚠️ Step 2 incomplete</strong><br>Set a vault password.';
      }
    }

    new obsidian.Setting(containerEl)
      .setName('Relay Control')
      .setDesc(this.plugin.isConnected ? '🟢 Relay is connected' : '⚪ Relay disconnected')
      .addButton(button => button
        .setButtonText(this.plugin.isConnected ? 'Disconnect' : 'Connect')
        .setDisabled(!canStart)
        .onClick(async () => {
          if (this.plugin.isConnected) {
            this.plugin.disconnectSignaling();
          } else {
            await this.plugin.connectSignaling();
          }
          this.display();
        }));

    if (this.plugin.isConnected) {
      const statusDiv = containerEl.createDiv();
      statusDiv.style.cssText = 'padding: 20px; margin-top: 20px; background: rgba(76,175,80,0.1); border-radius: 6px; border-left: 3px solid #4caf50;';
      statusDiv.innerHTML = `
        <h4 style="margin-top: 0; color: #4caf50;">✅ Note Relay is Active</h4>
        <div style="margin-top: 10px;"><strong>Remote:</strong> Go to <a href="https://noterelay.io/dashboard" target="_blank">noterelay.io/dashboard</a></div>
        <div style="margin-top: 10px; font-size: 0.9em; color: var(--text-muted);">Signal ID: ${this.plugin.signalId ? this.plugin.signalId.slice(0, 8) + '...' : 'Connecting...'}</div>
      `;
    }
  }
}

module.exports = NoteRelay;
