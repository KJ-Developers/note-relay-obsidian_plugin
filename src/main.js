const { Buffer } = require('buffer');
if (typeof window !== 'undefined') {
  window.Buffer = Buffer;
}

const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');
const { createServer } = require('./server/server');
const webrtc = require('./server/webrtc');
const auth = require('./server/auth');
const { createClient } = require('@supabase/supabase-js');

const DEFAULT_SETTINGS = {
  localPort: 5474,
  autoStartServer: true,
  userEmail: '',
  masterPasswordHash: '',
  vaultId: '',
  guestList: [],
  apiBaseUrl: 'https://noterelay.io'
};

class NoteRelayPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    
    console.log('%c Note Relay v2.0 (Headless) READY', 'color: #00ff00; font-weight: bold; background: #000;');
    
    // Generate vaultId if missing
    if (!this.settings.vaultId) {
      this.settings.vaultId = crypto.randomUUID();
      await this.saveSettings();
      console.log('Generated vaultId:', this.settings.vaultId);
    }
    
    // Status bar
    this.statusBar = this.addStatusBarItem();
    this.serverRunning = false;
    
    // Settings tab
    this.addSettingTab(new NoteRelaySettingTab(this.app, this));
    
    // SECURITY: Check if user has configured email and password
    const isConfigured = this.settings.userEmail && 
                         this.settings.userEmail.length > 0 && 
                         this.settings.masterPasswordHash && 
                         this.settings.masterPasswordHash.length > 0;
    
    if (!isConfigured) {
      // STANDBY MODE: Do not start server or signaling
      console.warn('⚠️ Note Relay: Configuration required. Server will not start.');
      this.statusBar.setText('⚪ Note Relay: Config Required');
      this.statusBar.style.color = '#ffa500';
      return;
    }
    
    // Auto-start server (only if configured)
    if (this.settings.autoStartServer) {
      this.startServer();
    } else {
      this.statusBar.setText('Note Relay: Stopped');
    }
  }
  
  async activateVault() {
    try {
      console.log('🚀 Activating vault...');
      
      // Step 1: Validate email (no license gate, just account check)
      const initResponse = await fetch(`${this.settings.apiBaseUrl}/api/plugin-init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: this.settings.userEmail,
          vaultId: this.settings.vaultId
        })
      });
      
      if (!initResponse.ok) {
        const error = await initResponse.json();
        console.error('❌ Plugin init failed:', initResponse.status, error);
        
        if (initResponse.status === 404) {
          new Notice('❌ Email not found. Please sign up at noterelay.io first.', 6000);
          return false;
        }
        
        new Notice('⚠️ Cannot connect to Note Relay cloud.');
        return false;
      }
      
      const initData = await initResponse.json();
      console.log('✅ Plugin init successful');
      
      // Step 2: Register vault (get signalId)
      const os = require('os');
      const registerResponse = await fetch(`${this.settings.apiBaseUrl}/api/vaults?route=register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: this.settings.userEmail,
          vaultId: this.settings.vaultId,
          signalId: crypto.randomUUID(),
          vaultName: this.app.vault.getName(),
          hostname: os.hostname()
        })
      });
      
      if (!registerResponse.ok) {
        console.error('❌ Vault registration failed:', registerResponse.status);
        new Notice('⚠️ Failed to register vault');
        return false;
      }
      
      const registerData = await registerResponse.json();
      this.signalId = registerData.signalId;
      console.log('✅ Vault registered, signalId:', this.signalId);
      
      // Step 3: Fetch TURN credentials
      const turnResponse = await fetch(`${this.settings.apiBaseUrl}/api/turn-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: this.settings.userEmail })
      });
      
      if (!turnResponse.ok) {
        console.error('⚠️ TURN credentials fetch failed, using STUN only');
        this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
      } else {
        const turnData = await turnResponse.json();
        this.iceServers = turnData.iceServers;
        console.log('✅ TURN credentials fetched');
      }
      
      // Step 4: Start heartbeat (5 min interval)
      this.startHeartbeat();
      
      // Step 5: Initialize WebRTC signaling
      this.supabaseChannel = await webrtc.initializeSignaling(
        initData.supabase.url,
        initData.supabase.anonKey,
        this.signalId,
        this.iceServers,
        this
      );
      
      console.log('✅ Vault activation complete');
      return true;
    } catch (error) {
      console.error('❌ Activation error:', error);
      new Notice('⚠️ Activation failed. Check console for details.');
      return false;
    }
  }
  
  startHeartbeat() {
    // Clear existing interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // Heartbeat every 5 minutes
    this.heartbeatInterval = setInterval(async () => {
      try {
        await fetch(`${this.settings.apiBaseUrl}/api/vaults?route=heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: this.settings.userEmail,
            vaultId: this.settings.vaultId,
            signalId: this.signalId
          })
        });
        console.log('💓 Heartbeat sent');
      } catch (error) {
        console.error('⚠️ Heartbeat failed:', error);
      }
    }, 5 * 60 * 1000);
    
    console.log('💓 Heartbeat started (5 min interval)');
  }
  
  async startServer() {
    if (this.serverRunning) {
      return;
    }
    
    // SECURITY GATE: Block server start if credentials not configured
    const isConfigured = this.settings.userEmail && 
                         this.settings.userEmail.length > 0 && 
                         this.settings.masterPasswordHash && 
                         this.settings.masterPasswordHash.length > 0;
    
    if (!isConfigured) {
      console.warn('🚫 Server blocked: Email and Password must be configured first');
      this.statusBar.setText('⚪ Note Relay: Config Required');
      this.statusBar.style.color = '#ffa500';
      new Notice('⚠️ Please configure your Email and Vault Password in settings before starting the server.');
      return;
    }
    
    // ACTIVATION: Full vault activation (plugin-init → register → TURN → heartbeat → signaling)
    this.statusBar.setText('Note Relay: Activating...');
    const activated = await this.activateVault();
    
    if (!activated) {
      console.error('🚫 Server blocked: Activation failed');
      this.statusBar.setText('⚠️ Note Relay: Activation Failed');
      this.statusBar.style.color = '#ff0000';
      new Notice('❌ Vault activation failed.\n\nPlease check your email and password in settings.', 8000);
      return;
    }
    
    this.statusBar.setText('Note Relay: Starting...');
    
    try {
      const app = createServer(this.settings.localPort, this);
      
      this.expressServer = app.listen(this.settings.localPort, '127.0.0.1', () => {
        console.log(`✅ Server running on http://127.0.0.1:${this.settings.localPort}`);
        this.statusBar.setText(`Note Relay: Online (${this.settings.localPort})`);
        this.statusBar.style.color = '#00ff00';
        this.serverRunning = true;
      });
      
      this.expressServer.on('error', (error) => {
        console.error('Server error:', error);
        this.statusBar.setText('Note Relay: Error');
        this.statusBar.style.color = '#ff0000';
      });
    } catch (error) {
      console.error('Failed to start server:', error);
      this.statusBar.setText('Note Relay: Failed');
      this.statusBar.style.color = '#ff0000';
    }
  }
  
  async stopServer() {
    if (!this.serverRunning || !this.expressServer) {
      return;
    }
    
    return new Promise((resolve) => {
      this.expressServer.close(() => {
        console.log('Server stopped');
        this.statusBar.setText('Note Relay: Stopped');
        this.statusBar.style.color = '';
        this.serverRunning = false;
        resolve();
      });
    });
  }
  
  onunload() {
    this.stopServer();
    
    // Cleanup heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // Cleanup signaling channel
    if (this.supabaseChannel) {
      this.supabaseChannel.unsubscribe();
    }
  }
  
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  
  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class NoteRelaySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  
  display() {
    const { containerEl } = this;
    containerEl.empty();
    
    containerEl.createEl('h2', { text: 'Note Relay Settings' });
    
    // Security Warning: Show if not configured
    const isConfigured = this.plugin.settings.userEmail && 
                         this.plugin.settings.userEmail.length > 0 && 
                         this.plugin.settings.masterPasswordHash && 
                         this.plugin.settings.masterPasswordHash.length > 0;
    
    if (!isConfigured) {
      const warning = containerEl.createDiv();
      warning.style.cssText = 'background: rgba(255, 165, 0, 0.15); border-left: 4px solid #ffa500; padding: 12px; margin-bottom: 20px; border-radius: 4px;';
      warning.createEl('strong', { text: '⚠️ Security Configuration Required' });
      warning.createEl('p', { 
        text: 'The Note Relay server will remain in standby mode until you set both your Email and Vault Password below. This prevents unauthorized access to your vault.',
        attr: { style: 'margin: 8px 0 0 0; color: #888;' }
      });
      warning.createEl('p', { 
        text: '📝 Note: You must first sign up at noterelay.io to register your email.',
        attr: { style: 'margin: 8px 0 0 0; color: #666; font-style: italic;' }
      });
    }
    
    // Server Settings
    containerEl.createEl('h3', { text: 'Server' });
    
    new Setting(containerEl)
      .setName('Local Port')
      .setDesc('Port for local HTTP server (default: 5474)')
      .addText(text => text
        .setPlaceholder('5474')
        .setValue(String(this.plugin.settings.localPort))
        .onChange(async (value) => {
          const port = parseInt(value);
          if (port > 0 && port < 65536) {
            this.plugin.settings.localPort = port;
            await this.plugin.saveSettings();
          }
        }));
    
    new Setting(containerEl)
      .setName('Auto-start Server')
      .setDesc('Start server automatically when Obsidian launches')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoStartServer)
        .onChange(async (value) => {
          this.plugin.settings.autoStartServer = value;
          await this.plugin.saveSettings();
        }));
    
    // Server Controls
    new Setting(containerEl)
      .setName('Server Control')
      .setDesc('Start or stop the local server')
      .addButton(button => {
        const updateButton = () => {
          button.setButtonText(this.plugin.serverRunning ? 'Stop Server' : 'Start Server');
        };
        
        updateButton();
        
        button.onClick(async () => {
          if (this.plugin.serverRunning) {
            await this.plugin.stopServer();
          } else {
            await this.plugin.startServer();
          }
          updateButton(); // Update button after server state changes
        });
      });
    
    // Identity Settings
    containerEl.createEl('h3', { text: 'Identity' });
    
    new Setting(containerEl)
      .setName('Email')
      .setDesc('Your registered email for remote access (sign up at noterelay.io first)')
      .addText(text => text
        .setPlaceholder('you@example.com')
        .setValue(this.plugin.settings.userEmail)
        .onChange(async (value) => {
          this.plugin.settings.userEmail = value;
          await this.plugin.saveSettings();
        }));
    
    const passwordSetting = new Setting(containerEl)
      .setName('Master Password')
      .setDesc(
        this.plugin.settings.masterPasswordHash 
          ? '✅ Password is set. Enter new password to change it.' 
          : '⚠️ Password required - server will not start until set'
      )
      .addText(text => {
        text
          .setPlaceholder('Enter password')
          .then(async () => {
            const input = text.inputEl;
            input.type = 'password';
            
            // Save on Enter key
            input.addEventListener('keydown', async (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const password = text.getValue();
                if (password.length > 0) {
                  this.plugin.settings.masterPasswordHash = await auth.hashString(password);
                  await this.plugin.saveSettings();
                  text.setValue('');
                  new Notice('✅ Password saved');
                  console.log('Master password updated (Enter key)');
                  this.display(); // Refresh to show checkmark
                }
              }
            });
          });
        
        // Save on blur (when clicking away)
        text.inputEl.addEventListener('blur', async () => {
          const password = text.getValue();
          if (password.length > 0) {
            this.plugin.settings.masterPasswordHash = await auth.hashString(password);
            await this.plugin.saveSettings();
            text.setValue('');
            new Notice('✅ Password saved');
            console.log('Master password updated (blur)');
            this.display(); // Refresh to show checkmark
          }
        });
        
        return text;
      });
    
    // Info
    containerEl.createEl('h3', { text: 'Info' });
    
    new Setting(containerEl)
      .setName('Vault ID')
      .setDesc(this.plugin.settings.vaultId || 'Not generated')
      .setDisabled(true);
    
    new Setting(containerEl)
      .setName('Status')
      .setDesc(this.plugin.serverRunning 
        ? `✅ Server online at http://127.0.0.1:${this.plugin.settings.localPort}` 
        : '⚫ Server offline')
      .setDisabled(true);
  }
}

module.exports = NoteRelayPlugin;
