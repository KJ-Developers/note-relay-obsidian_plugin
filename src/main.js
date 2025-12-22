import { Buffer } from 'buffer';
if (typeof window !== 'undefined') {
}

const obsidian = require('obsidian');
const { createClient } = require('@supabase/supabase-js');
const SimplePeer = require('simple-peer');
const { readFileSync } = require('fs');
const { join } = require('path');
const os = require('os');

// Suppress Supabase "Multiple GoTrueClient instances" warning (benign, expected in plugin)
const originalConsoleLog = console.log;
console.log = (...args) => {
  if (args[0]?.includes?.('Multiple GoTrueClient instances')) return;
  originalConsoleLog.apply(console, args);
};


// Supabase credentials loaded dynamically from API (no hardcoded keys)
let SUPABASE_URL = null;
let SUPABASE_KEY = null;
const API_BASE_URL = 'https://noterelay.io';
const BUILD_VERSION = '2024.12.16-1421';
const CHUNK_SIZE = 16 * 1024;
const DEFAULT_SETTINGS = {
  enableRemoteAccess: false,
  // IDENTITY-BASED REMOTE ACCESS (OTP Model v8.0)
  userEmail: '', // User's email address (subscription validation)
  vaultId: '', // Unique vault identifier (auto-generated)
  // DEPRECATED: masterPasswordHash removed - now using Supabase MFA
};

async function hashString(str) {
  const msgBuffer = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * OTP Modal for TOTP verification
 * Used during vault registration to verify user identity via Supabase MFA
 */
class OTPModal extends obsidian.Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
    this.result = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.style.textAlign = 'center';

    contentEl.createEl('h2', { text: '🔐 Verify Your Identity' });
    contentEl.createEl('p', {
      text: 'Open your authenticator app and enter the 6-digit code.',
      cls: 'setting-item-description'
    });

    const inputContainer = contentEl.createDiv();
    inputContainer.style.cssText = 'margin: 20px 0; display: flex; justify-content: center;';

    const input = inputContainer.createEl('input', {
      type: 'text',
      attr: {
        maxlength: '6',
        pattern: '[0-9]*',
        inputmode: 'numeric',
        autocomplete: 'one-time-code',
        placeholder: '000000'
      }
    });
    input.style.cssText = 'font-size: 28px; text-align: center; width: 180px; letter-spacing: 10px; padding: 10px; font-family: monospace;';

    const btnContainer = contentEl.createDiv();
    btnContainer.style.cssText = 'margin-top: 20px; display: flex; gap: 10px; justify-content: center;';

    const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
    cancelBtn.onclick = () => {
      this.result = null;
      this.close();
    };

    const verifyBtn = btnContainer.createEl('button', { text: 'Verify', cls: 'mod-cta' });
    verifyBtn.onclick = () => {
      const code = input.value.trim();
      if (code.length === 6 && /^\d+$/.test(code)) {
        this.result = code;
        this.close();
      } else {
        new obsidian.Notice('Please enter a valid 6-digit code');
      }
    };

    // Focus input and handle Enter key
    input.focus();
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') verifyBtn.click();
    });
  }

  onClose() {
    if (this.onSubmit) {
      this.onSubmit(this.result);
    }
  }
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
    }

    // DETERMINISTIC DEVICE FINGERPRINT (no localStorage needed)
    // Unique per: vault path + OS platform + hostname
    const fingerprint = vaultPath + '|' + os.platform() + '|' + os.hostname();
    this.nodeId = await hashString(fingerprint);
    this.nodeName = os.hostname();
    this.nodePlatform = os.platform();

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

    // Register URI handler for OAuth callback from browser
    // Receives: obsidian://noterelay?token=xxx&email=xxx&vaultId=xxx
    this.registerObsidianProtocolHandler('noterelay', async (params) => {

      if (params.token && params.email && params.vaultId) {
        // Validate token with API
        const valid = await this.validatePluginToken(params.token, params.email, params.vaultId);

        if (valid) {
          this.settings.userEmail = params.email;
          this.settings.emailValidated = true;
          await this.saveSettings();
          new obsidian.Notice('✅ Account verified! You can now connect.');

          // Refresh settings tab if open
          this.app.setting.close();
          this.app.setting.open();
          this.app.setting.openTabById(this.manifest.id);
        } else {
          new obsidian.Notice('❌ Token expired or invalid. Please try again.');
        }
      } else {
        new obsidian.Notice('❌ Invalid callback - missing parameters');
      }
    });

    // Keep event loop active to prevent Electron background throttling
    // This ensures WebRTC data callbacks execute promptly when app is not focused
    this.keepAliveInterval = setInterval(() => {
      // Noop - just keeps the event loop from going idle
    }, 1000);

    // Only auto-connect if fully configured (email verified)
    // NOTE: Password check removed in v8.0 - OTP validates at connection time
    if (this.settings.enableRemoteAccess && this.settings.userEmail && this.settings.emailValidated) {
      setTimeout(() => this.connectSignaling(), 3000); // 3s delay for cold start
    } else {
      this.statusBar?.setText('Note Relay: Not configured');
    }
  }

  onunload() {
    this.disconnectSignaling();

    // Clean up keepalive interval
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
    }
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

  // Validate OAuth token from browser callback
  async validatePluginToken(token, email, vaultId) {
    try {
      const response = await fetch('https://noterelay.io/api/plugin-token?route=validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, email, vaultId })
      });

      if (response.ok) {
        const result = await response.json();
        return result.success === true;
      }
      return false;
    } catch (error) {
      console.error('Token validation error:', error);
      return false;
    }
  }

  async fetchTurnCredentials() {
    if (!this.settings.userEmail) return;

    try {
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
  }

  /**
   * Unified command processor for WebRTC mode
   * @param {Object} msg - The command message { cmd, path, data }
   * @param {Function} sendCallback - Function to send response: (type, data, meta) => void
   */

  // ============================================
  // COMMAND HANDLERS (Wave 1: Simple)
  // ============================================

  async _handlePing(msg, sendCallback) {
    // PING/HANDSHAKE
    const themeCSS = this.extractThemeCSS();
    sendCallback(msg.cmd === 'PING' ? 'PONG' : 'HANDSHAKE_ACK', {
      version: BUILD_VERSION,
      readOnly: false,
      css: themeCSS
    });
  }

  async _handleGetTree(sendCallback) {
    const files = this.app.vault.getMarkdownFiles().map((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      let tags = [], links = [];
      if (cache) {
        if (cache.frontmatter?.tags) {
          let ft = cache.frontmatter.tags;
          if (!Array.isArray(ft)) ft = [ft];
          ft.forEach((t) => tags.push(t.startsWith('#') ? t : '#' + t));
        }
        if (cache.tags) cache.tags.forEach((t) => tags.push(t.tag));
        if (cache.links) cache.links.forEach((l) => links.push(l.link));
      }
      return { path: f.path, tags: [...new Set(tags)], links: [...new Set(links)] };
    });

    // Get all folders including empty ones
    const allFolders = [];
    const getAllFolders = (folder) => {
      folder.children.forEach(child => {
        if (child.children) {
          allFolders.push(child.path);
          getAllFolders(child);
        }
      });
    };
    getAllFolders(this.app.vault.getRoot());

    const treeCss = this.extractThemeCSS();
    sendCallback('TREE', { files, folders: allFolders, css: treeCss });
  }


  // ============================================
  // COMMAND HANDLERS (Wave 2: Read)
  // ============================================

  async _handleGetRenderedFile(msg, sendCallback, isReadOnly) {
    const safePath = this.sanitizePath(msg.path);
    if (!safePath) {
      sendCallback('ERROR', { message: 'Invalid path' });
      return;
    }

    let file = this.app.vault.getAbstractFileByPath(safePath);
    let shouldRefreshTree = msg.refreshTree || false;

    // SECURITY: Do not auto-create missing files (Ghost File vulnerability fixed)
    if (!file) {
      sendCallback('ERROR', { message: 'File not found' });
      return;
    }

    try {
      const content = await this.app.vault.read(file);

      // Extract YAML frontmatter
      let yamlData = null;
      let contentWithoutYaml = content;
      const yamlMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);

      if (yamlMatch) {
        const yamlText = yamlMatch[1];
        try {
          // Parse YAML to object (Obsidian's parser handles it)
          const cache = this.app.metadataCache.getFileCache(file);
          if (cache && cache.frontmatter) {
            yamlData = { ...cache.frontmatter };
            delete yamlData.position; // Remove metadata
          }
          contentWithoutYaml = content.slice(yamlMatch[0].length);
        } catch (err) {
          console.warn('Invalid YAML frontmatter:', err);
        }
      }

      const div = document.createElement('div');

      // Render Markdown WITHOUT frontmatter
      await obsidian.MarkdownRenderer.render(this.app, contentWithoutYaml, div, file.path, this);

      // Smart Rendering: Wait for Dataview/Plugins to settle
      await this.waitForRender(div);

      // Extract CSS
      const themeCSS = this.extractThemeCSS();

      // 6. GRAPH & BACKLINKS DATA
      const graphData = { nodes: [], edges: [] };
      const currentPath = msg.path;
      const backlinks = [];

      // Add Central Node
      graphData.nodes.push({ id: currentPath, label: file.basename, group: 'center' });

      // A. Forward Links
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache && cache.links) {
        cache.links.forEach(l => {
          const linkPath = l.link; // Simple resolution for V1
          if (!graphData.nodes.find(n => n.id === linkPath)) {
            graphData.nodes.push({ id: linkPath, label: linkPath.split('/').pop().replace('.md', ''), group: 'neighbor' });
          }
          graphData.edges.push({ from: currentPath, to: linkPath });
        });
      }

      // B. Backlinks
      const allLinks = this.app.metadataCache.resolvedLinks;
      for (const sourcePath in allLinks) {
        if (allLinks[sourcePath][currentPath]) {
          backlinks.push(sourcePath);
          if (!graphData.nodes.find(n => n.id === sourcePath)) {
            graphData.nodes.push({ id: sourcePath, label: sourcePath.split('/').pop().replace('.md', ''), group: 'neighbor' });
          }
          graphData.edges.push({ from: sourcePath, to: currentPath });
        }
      }

      // Process Assets (Images, PDFs, etc.)
      const assets = div.querySelectorAll('img, embed, object, iframe');
      for (const el of assets) {
        // Check for internal app:// links or relative paths
        let src = el.getAttribute('src') || el.getAttribute('data');

        if (src && src.startsWith('app://')) {
          try {
            // Attempt to find the file in the vault
            // Strategy 1: Use the internal-embed src if available (most reliable for [[links]])
            const container = el.closest('.internal-embed');
            let targetFile = null;

            if (container && container.getAttribute('src')) {
              const linktext = container.getAttribute('src');
              targetFile = this.app.metadataCache.getFirstLinkpathDest(linktext, file.path);
            }


            if (targetFile) {
              const arrayBuffer = await this.app.vault.readBinary(targetFile);
              const base64 = Buffer.from(arrayBuffer).toString('base64');
              const ext = targetFile.extension;
              const mime = this.getMimeType(ext);

              if (el.tagName.toLowerCase() === 'img') {
                el.src = `data:${mime};base64,${base64}`;
                el.removeAttribute('srcset');
              } else {
                // For embed/object/iframe
                const dataUri = `data:${mime};base64,${base64}`;
                if (el.hasAttribute('src')) el.setAttribute('src', dataUri);
                if (el.hasAttribute('data')) el.setAttribute('data', dataUri);
              }
            }
          } catch (assetError) {
            console.error('Failed to process asset:', src, assetError);
          }
        }
      }

      // PREPARE RESPONSE
      const response = {
        html: div.innerHTML,
        yaml: yamlData,
        css: themeCSS,
        backlinks,
        graph: graphData
      };

      // INJECT TREE IF NEEDED
      if (shouldRefreshTree) {
        response.files = this.app.vault.getFiles().map(f => ({
          path: f.path,
          name: f.name,
          basename: f.basename,
          extension: f.extension
        }));
      }

      sendCallback('RENDERED_FILE', response, { path: safePath });

    } catch (renderError) {
      console.error('Render Error:', renderError);
      sendCallback('ERROR', { message: 'Rendering failed: ' + renderError.message });
    }
  }

  async _handleGetFile(msg, sendCallback) {
    const safePath = this.sanitizePath(msg.path);
    if (!safePath) {
      sendCallback('ERROR', { message: 'Invalid path' });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(safePath);
    if (!file) {
      sendCallback('ERROR', { message: 'File not found' });
      return;
    }

    // 1. Handle Images (with Optional Resizing)
    const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
    if (IMAGE_EXTS.includes(file.extension.toLowerCase())) {
      const arrayBuffer = await this.app.vault.readBinary(file);

      // Check for resize request (Thumbnail Mode for Free/Preview)
      if (msg.options && msg.options.resize) {
        try {
          const blob = new Blob([arrayBuffer]);
          const bitmap = await createImageBitmap(blob);

          // Calculate new dimensions (max 800px)
          const MAX_WIDTH = 800;
          let width = bitmap.width;
          let height = bitmap.height;

          if (width > MAX_WIDTH) {
            height = Math.round(height * (MAX_WIDTH / width));
            width = MAX_WIDTH;
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0, width, height);

          // Convert to JPEG 80% quality for thumbnails
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          const base64 = dataUrl.split(',')[1];

          sendCallback('FILE', base64, {
            path: msg.path,
            isImage: true,
            ext: 'jpg', // Thumbnails are always JPEGs
            originalExt: file.extension
          });
          return;
        } catch (err) {
          console.error('Image resize failed, falling back to full size:', err);
          // Fallthrough to full size
        }
      }

      // Full size (Default for Pro Download or Fallback)
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      sendCallback('FILE', base64, {
        path: msg.path,
        isImage: true,
        ext: file.extension
      });
    }
    // 2. Handle Markdown (Text)
    else if (file.extension === 'md') {
      const content = await this.app.vault.read(file);
      const backlinks = [];
      const resolved = this.app.metadataCache.resolvedLinks;
      for (const [sourcePath, links] of Object.entries(resolved)) {
        if (links[msg.path]) backlinks.push(sourcePath);
      }

      sendCallback('FILE', {
        data: content,
        backlinks
      }, { path: msg.path });
    }
    // 3. Handle All Other Files (Binary - PDF, Video, Zip, etc.)
    else {
      // Treat as binary to prevent corruption
      const arrayBuffer = await this.app.vault.readBinary(file);
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      sendCallback('FILE', base64, {
        path: msg.path,
        isBinary: true,
        ext: file.extension
      });
    }
  }


  // ============================================
  // COMMAND HANDLERS (Wave 3: Write)
  // ============================================

  async _handleSaveFile(msg, sendCallback, isReadOnly) {
    if (isReadOnly) {
      sendCallback('ERROR', { message: 'Read-only mode' });
      return;
    }
    const safePath = this.sanitizePath(msg.path);
    if (!safePath) {
      sendCallback('ERROR', { message: 'Invalid path' });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(safePath);
    if (!file) {
      sendCallback('ERROR', { message: 'File not found' });
      return;
    }

    await this.app.vault.modify(file, msg.data);
    sendCallback('SAVED', { path: safePath });
    new obsidian.Notice(`Saved: ${safePath}`);
  }

  async _handleCreateFile(msg, sendCallback, isReadOnly) {
    if (isReadOnly) {
      sendCallback('ERROR', { message: 'Read-only mode' });
      return;
    }
    const safePath = this.sanitizePath(msg.path);
    if (!safePath) {
      sendCallback('ERROR', { message: 'Invalid path' });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(safePath);
    if (file) {
      sendCallback('ERROR', { message: 'File already exists' });
      return;
    }
    await this.app.vault.create(safePath, '');
    new obsidian.Notice(`Created: ${safePath}`);

    // Recursively call GET_RENDERED_FILE with refreshTree flag
    await this._handleGetRenderedFile({
      cmd: 'GET_RENDERED_FILE',
      path: safePath,
      refreshTree: true
    }, sendCallback, isReadOnly);
  }

  async _handleCreateFolder(msg, sendCallback, isReadOnly) {
    if (isReadOnly) {
      sendCallback('ERROR', { message: 'Read-only mode' });
      return;
    }
    const safePath = this.sanitizePath(msg.path);
    if (!safePath) {
      sendCallback('ERROR', { message: 'Invalid path' });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(safePath);
    if (file) {
      sendCallback('ERROR', { message: 'Folder already exists' });
      return;
    }
    await this.app.vault.createFolder(safePath);
    sendCallback('SAVED', { path: safePath });
    new obsidian.Notice(`Created Folder: ${safePath}`);
  }

  async _handleRenameFile(msg, sendCallback, isReadOnly) {
    if (isReadOnly) {
      sendCallback('ERROR', { message: 'Read-only mode' });
      return;
    }
    const safePath = this.sanitizePath(msg.path);
    const safeNewPath = this.sanitizePath(msg.data.newPath);
    if (!safePath || !safeNewPath) {
      sendCallback('ERROR', { message: 'Invalid path' });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(safePath);
    if (!file) {
      sendCallback('ERROR', { message: 'File not found' });
      return;
    }
    await this.app.fileManager.renameFile(file, safeNewPath);
    sendCallback('SAVED', { path: safeNewPath });
    new obsidian.Notice(`Renamed: ${safePath} to ${safeNewPath}`);
  }

  async _handleDeleteFile(msg, sendCallback, isReadOnly) {
    if (isReadOnly) {
      sendCallback('ERROR', { message: 'Read-only mode' });
      return;
    }
    const safePath = this.sanitizePath(msg.path);
    if (!safePath) {
      sendCallback('ERROR', { message: 'Invalid path' });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(safePath);
    if (!file) {
      sendCallback('ERROR', { message: 'File not found' });
      return;
    }
    await this.app.vault.trash(file, true);
    sendCallback('SAVED', { path: safePath });
    new obsidian.Notice(`Deleted: ${safePath}`);
  }


  // ============================================
  // COMMAND HANDLERS (Wave 4: Special)
  // ============================================

  async _handleOpenFile(msg, sendCallback, isReadOnly) {
    const safePath = this.sanitizePath(msg.path);

    if (!safePath) {
      sendCallback('ERROR', { message: 'Invalid path' });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(safePath);

    if (!file) {
      sendCallback('ERROR', { message: 'File not found' });
      return;
    }

    // Check frontmatter for plugin types
    const metadata = this.app.metadataCache.getFileCache(file);
    const frontmatter = metadata?.frontmatter || {};

    // Detect plugin type
    let detectedPlugin = null;
    if (frontmatter['kanban-plugin']) detectedPlugin = 'kanban';
    else if (frontmatter['dataview']) detectedPlugin = 'dataview';
    else if (frontmatter['excalidraw-plugin']) detectedPlugin = 'excalidraw';

    if (!detectedPlugin) {
      await this._handleGetRenderedFile({
        cmd: 'GET_RENDERED_FILE',
        path: safePath
      }, (type, data, meta) => {
        if (type === 'RENDERED_FILE') {
          sendCallback('OPEN_FILE', data, meta);
        } else {
          sendCallback(type, data, meta);
        }
      }, isReadOnly);
      return;
    }

    // Try to capture plugin view HTML from existing open leaf
    const workspace = this.app.workspace;
    let kanbanLeaf = workspace.getLeavesOfType('kanban')[0];

    if (!kanbanLeaf) {
      // Try to open the file in a new tab to create the view
      try {
        const newLeaf = workspace.getLeaf('tab');
        await newLeaf.openFile(file);

        // Check if it's now a kanban view
        if (newLeaf.getViewState().type === 'kanban') {
          kanbanLeaf = newLeaf;
        } else {
        }
      } catch (openError) {
      }
    } else {
      // Leaf exists but might not be rendering - force a refresh
      try {
        await kanbanLeaf.openFile(file);
        // Give it a moment to actually render
        await new Promise(resolve => setTimeout(resolve, 150));
      } catch (refreshError) {
      }
    }

    // If we have a leaf, extract the rendered HTML
    if (kanbanLeaf) {
      const view = kanbanLeaf.view;

      if (view.containerEl) {
        // Wait for Kanban to render (it may be async)
        // Try multiple times with increasing delays
        let kanbanBoard = null;
        let attempts = 0;
        const maxAttempts = 5;

        while (!kanbanBoard && attempts < maxAttempts) {
          if (attempts > 0) {
            await new Promise(resolve => setTimeout(resolve, 100 * attempts)); // 100ms, 200ms, 300ms, 400ms
          }

          kanbanBoard = view.containerEl.querySelector('.kanban-plugin');
          attempts++;
        }

        if (kanbanBoard) {
          const capturedHTML = kanbanBoard.outerHTML;

          // Extract Kanban plugin CSS
          const kanbanCSS = this.extractPluginCSS('.kanban-plugin');

          const response = {
            renderedHTML: capturedHTML,
            pluginCSS: kanbanCSS,
            viewType: 'kanban',
            success: true
          };

          sendCallback('OPEN_FILE', response, { path: safePath });

          // Close the leaf after capturing
          kanbanLeaf.detach();

          return;
        }
      }
    }

    // If we got here, fall back to markdown rendering
    await this._handleGetRenderedFile({
      cmd: 'GET_RENDERED_FILE',
      path: safePath
    }, (type, data, meta) => {
      if (type === 'RENDERED_FILE') {
        sendCallback('OPEN_FILE', data, meta);
      } else {
        sendCallback(type, data, meta);
      }
    }, isReadOnly);
  }

  async _handleOpenDailyNote(msg, sendCallback) {
    try {
      // Check if daily notes plugin is enabled
      const dailyNotesPlugin = this.app.internalPlugins?.plugins?.['daily-notes'];

      if (!dailyNotesPlugin || !dailyNotesPlugin.enabled) {
        sendCallback('ERROR', { message: 'Daily Notes plugin is not enabled in Obsidian' });
        return;
      }

      // Use Obsidian's command to create/open today's daily note
      // This properly processes Templater and respects all settings
      this.app.commands.executeCommandById('daily-notes');

      // Wait for the command to complete (file creation + Templater processing)
      await new Promise(resolve => setTimeout(resolve, 300));

      const activeFile = this.app.workspace.getActiveFile();

      if (!activeFile) {
        sendCallback('ERROR', { message: 'No file opened after daily notes command' });
        return;
      }

      // Get the active leaf and close it
      const activeLeaf = this.app.workspace.getLeaf(false);
      if (activeLeaf) {
        activeLeaf.detach();
      }

      // Just return the path - let web UI load it normally
      const response = { success: true, path: activeFile.path };
      sendCallback('OPEN_DAILY_NOTE', response);

    } catch (error) {
      console.error('Daily Note Error:', error);
      sendCallback('ERROR', { message: 'Failed to open daily note: ' + error.message });
    }
  }

  async processCommand(msg, sendCallback, isReadOnly = false) {
    try {
      if (msg.cmd === 'PING' || msg.cmd === 'HANDSHAKE') {
        await this._handlePing(msg, sendCallback);
        return;
      }

      if (msg.cmd === 'GET_TREE') {
        await this._handleGetTree(sendCallback);
        return;
      }

      if (msg.cmd === 'GET_RENDERED_FILE') {
        await this._handleGetRenderedFile(msg, sendCallback, isReadOnly);
        return;
      }

      if (msg.cmd === 'GET_FILE') {
        await this._handleGetFile(msg, sendCallback);
        return;
      }

      if (msg.cmd === 'SAVE_FILE') {
        await this._handleSaveFile(msg, sendCallback, isReadOnly);
        return;
      }

      if (msg.cmd === 'CREATE_FILE') {
        await this._handleCreateFile(msg, sendCallback, isReadOnly);
        return;
      }

      if (msg.cmd === 'CREATE_FOLDER') {
        await this._handleCreateFolder(msg, sendCallback, isReadOnly);
        return;
      }

      if (msg.cmd === 'RENAME_FILE') {
        await this._handleRenameFile(msg, sendCallback, isReadOnly);
        return;
      }

      if (msg.cmd === 'DELETE_FILE') {
        await this._handleDeleteFile(msg, sendCallback, isReadOnly);
        return;
      }

      if (msg.cmd === 'OPEN_FILE') {
        await this._handleOpenFile(msg, sendCallback, isReadOnly);
        return;
      }

      if (msg.cmd === 'OPEN_DAILY_NOTE') {
        await this._handleOpenDailyNote(msg, sendCallback);
        return;
      }

    } catch (error) {
      console.error('Note Relay Command Error:', error);
      sendCallback('ERROR', { message: error.message });
    }
  }

  answerCall(remoteId, offerSignal) {
    // Configure ICE servers (STUN + TURN if available)
    const iceServers = this.iceServers || [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];

    const peer = new SimplePeer({
      initiator: false,
      trickle: false,
      objectMode: false,
      config: { iceServers }
    });
    let isAuthenticated = false;
    let peerReadOnly = false;

    peer.safeSend = (data) => {
      if (peer._channel && peer._channel.readyState === 'open') {
        try {
          peer.send(JSON.stringify(data));
        } catch (e) {
          console.error('Send Fail', e);
        }
      }
    };

    peer.sendChunked = async (type, data, meta = {}) => {
      if (!isAuthenticated && type !== 'ERROR') return;

      const fullString = JSON.stringify(data);
      const totalBytes = fullString.length;
      let offset = 0;

      if (totalBytes > 100000) {
      }

      while (offset < totalBytes) {
        const chunk = fullString.slice(offset, offset + CHUNK_SIZE);
        offset += CHUNK_SIZE;
        peer.safeSend({ type: 'PART', cat: type, chunk, end: offset >= totalBytes, ...meta });
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    peer.on('signal', async (data) => {
      await this.supabase.from('signaling').insert({
        source: 'host',
        target: remoteId,
        type: 'answer',
        payload: data
      });
    });

    peer.on('connect', () => {
      this.statusBar?.setText('Note Relay: Verifying...');

      // Record WebRTC session start
      if (false /* analytics removed */) {
        const network = 'cloud'; // WebRTC connections are remote
      }
    });

    peer.on('data', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Handle authentication with ACL
        if (msg.cmd === 'PING' || msg.cmd === 'HANDSHAKE') {
          let accessGranted = false;
          let isReadOnly = false;
          let userIdentifier = 'unknown';

          // Email-based authentication - check if owner or guest
          if (msg.guestEmail && msg.authHash) {
            const userEmail = msg.guestEmail.toLowerCase().trim();

            // Check if this is the owner's email
            if (this.settings.userEmail && userEmail === this.settings.userEmail.toLowerCase().trim()) {
              // Owner authentication (v8.0: OTP validated by server before signaling)
              // If we received a valid WebRTC connection, the server has already verified OTP
              accessGranted = true;
              isReadOnly = false;
              userIdentifier = this.settings.userEmail;
            } else {
              // Guest authentication - verify via Supabase RPC
              try {
                const { data, error } = await this.supabase.rpc('verify_guest_otp', {
                  p_vault_name: this.app.vault.getName(),
                  p_owner_email: this.settings.userEmail,
                  p_auth_hash: msg.authHash
                });

                if (error) {
                  console.error('Note Relay: Guest auth RPC error:', error);
                  peer.safeSend({ type: 'ERROR', message: 'ACCESS_DENIED: Authentication failed.' });
                  setTimeout(() => peer.destroy(), 1000);
                  return;
                }

                if (data && data.valid) {
                  accessGranted = true;
                  isReadOnly = data.permission === 'read-only';
                  userIdentifier = userEmail;
                } else {
                  peer.safeSend({ type: 'ERROR', message: `ACCESS_DENIED: ${data?.error || 'Invalid credentials'}` });
                  setTimeout(() => peer.destroy(), 1000);
                  return;
                }
              } catch (rpcError) {
                console.error('Note Relay: Guest auth exception:', rpcError);
                peer.safeSend({ type: 'ERROR', message: 'ACCESS_DENIED: Authentication service unavailable.' });
                setTimeout(() => peer.destroy(), 1000);
                return;
              }
            }
          }

          if (accessGranted) {
            isAuthenticated = true;
            peerReadOnly = isReadOnly;
            this.statusBar?.setText(`Linked: ${msg.sessionName || userIdentifier}${isReadOnly ? ' (RO)' : ''}`);
            if (this.statusBar) this.statusBar.style.color = '#4caf50';
            peer.safeSend({
              type: msg.cmd === 'PING' ? 'PONG' : 'HANDSHAKE_ACK',
              version: BUILD_VERSION,
              readOnly: isReadOnly,
              styles: []
            });

            // Audit log the connection
          } else {
            peer.safeSend({ type: 'ERROR', message: 'ACCESS_DENIED: Invalid credentials or not authorized' });
            setTimeout(() => peer.destroy(), 1000);
          }
          return;
        }

        if (!isAuthenticated) return;

        // Block write commands if in read-only mode
        // Block write commands if in read-only mode
        // FIXED: Updated to match actual command names
        const writeCommands = ['CREATE_FILE', 'SAVE_FILE', 'DELETE_FILE', 'RENAME_FILE', 'CREATE_FOLDER'];
        if (peerReadOnly && writeCommands.includes(msg.cmd)) {
          peer.safeSend({ type: 'ERROR', message: 'READ-ONLY MODE: Editing is disabled' });
          return;
        }

        // Create a wrapped sendCallback that preserves the requestId
        const wrappedSendCallback = (type, data, meta = {}) => {
          // Preserve requestId from original message for promise resolution
          const metaWithRequestId = msg.requestId !== undefined
            ? { ...meta, requestId: msg.requestId }
            : meta;
          return peer.sendChunked(type, data, metaWithRequestId);
        };

        // Use unified command processor with WebRTC send callback
        // Use unified command processor with WebRTC send callback
        // PASS READ-ONLY STATUS
        await this.processCommand(msg, wrappedSendCallback, peerReadOnly);

      } catch (e) {
        console.error('Note Relay Error', e);
      }
    });

    peer.on('close', () => {
      new obsidian.Notice('Client Disconnected');
      this.statusBar?.setText('Note Relay: Active');
      if (this.statusBar) this.statusBar.style.color = '';

      // Record WebRTC session end
      if (false /* analytics removed */) {
      }
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      this.statusBar?.setText('Note Relay: Error');

      // Record error event
      if (false /* analytics removed */) {
      }
    });

    peer.signal(offerSignal);
  }

  async waitForRender(element) {
    // Pre-check: If empty, wait for renderer to start
    if (!element.innerHTML.trim()) {
      await new Promise(r => setTimeout(r, 100));
    }

    return new Promise((resolve) => {
      let timeout = null;

      // Safety net: Force resolve after 2 seconds max
      const maxTimeout = setTimeout(() => {
        if (observer) observer.disconnect();
        resolve();
      }, 2000);

      const observer = new MutationObserver((mutations) => {
        // Reset debounce timer on every mutation
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
          observer.disconnect();
          clearTimeout(maxTimeout);
          resolve();
        }, 100); // Wait for 100ms of silence
      });

      observer.observe(element, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true
      });

      // Initial check: if nothing happens in 100ms, assume done (for simple notes)
      timeout = setTimeout(() => {
        observer.disconnect();
        clearTimeout(maxTimeout);
        resolve();
      }, 100);
    });
  }

  async checkConnectionHealth() {
    // Check if signaling connection is still alive
    if (!this.supabase || !this.settings.userEmail) {
      return;
    }

    const timeSinceLastHeartbeat = Date.now() - (this.lastHeartbeatTime || 0);

    // If more than 6 minutes since last heartbeat, reconnect
    if (timeSinceLastHeartbeat > 6 * 60 * 1000) {
      await this.connectSignaling();
    } else {
    }
  }

  async connectSignaling() {
    // CONSENT CHECK: Only connect if user has enabled remote access
    if (!this.settings.enableRemoteAccess) {
      return;
    }
    // SECURITY CHECK: Do not connect to Supabase if no email is present.
    if (!this.settings.userEmail) {
      return; // Exit immediately
    }

    // Disconnect existing connection if any
    this.disconnectSignaling();

    // Load Supabase credentials dynamically from API (no hardcoded keys)
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      try {
        const initResponse = await fetch(`${API_BASE_URL}/api/plugin-init`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: this.settings.userEmail,
            vaultId: this.settings.vaultId
          })
        });

        if (!initResponse.ok) {
          const error = await initResponse.json();
          console.error('Failed to load connection credentials:', error);
          new obsidian.Notice('Note Relay: Unable to connect to cloud service');
          return;
        }

        const initData = await initResponse.json();
        SUPABASE_URL = initData.supabase.url;
        SUPABASE_KEY = initData.supabase.anonKey;
        this.iceServers = initData.iceServers; // Store for WebRTC

      } catch (err) {
        console.error('Failed to fetch connection credentials:', err);
        new obsidian.Notice('Note Relay: Connection initialization failed');
        return;
      }
    }

    // Reuse existing supabase client or create new one (avoids Multiple GoTrueClient warning)
    if (!this.supabase) {
      this.supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    }

    // Check if we have user email for remote access
    let signalId = null;
    // NOTE: Password check removed in v8.0 - using Supabase MFA
    if (this.settings.enableRemoteAccess && this.settings.userEmail && this.settings.emailValidated) {
      signalId = await this.registerVaultAndGetSignalId();
    }

    // Use signal ID if validated, otherwise fall back to 'host' for testing
    const ID = signalId || 'host';

    if (signalId) {
      this.statusBar?.setText(`Note Relay: Pro Active (${ID.slice(0, 8)}...)`);
      if (this.statusBar) this.statusBar.style.color = '#7c4dff';
    } else {
      this.statusBar?.setText(`Note Relay: Active`);
    }


    this.channel = this.supabase.channel('host-channel')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'signaling', filter: `target=eq.${ID}` },
        (payload) => {
          if (payload.new.type === 'offer') {
            new obsidian.Notice(`Incoming Connection...`);
            this.answerCall(payload.new.source, payload.new.payload);
          }
        }
      )
      .subscribe();
  }

  extractThemeCSS() {
    // Capture CSS rules AND essential theme variables
    const allCSS = [];

    // First, get computed theme variables from body (ensures we get active theme)
    const bodyStyles = getComputedStyle(document.body);
    const essentialVars = [
      '--background-primary',
      '--background-secondary',
      '--background-primary-alt',
      '--background-secondary-alt',
      '--background-modifier-border',
      '--background-modifier-hover',
      '--background-modifier-border-hover',
      '--text-normal',
      '--text-muted',
      '--text-faint',
      '--text-accent',
      '--text-accent-hover',
      '--interactive-accent',
      '--interactive-accent-hover',
      '--tag-background',
      '--tag-color'
    ];

    // DEBUG: Log what we're extracting

    // Build :root block with essential variables at the top
    let rootVars = ':root {\n';
    essentialVars.forEach(varName => {
      const value = bodyStyles.getPropertyValue(varName).trim();
      if (value) {
        // Add !important to ensure these override fallbacks
        rootVars += `  ${varName}: ${value} !important;\n`;
      }
    });
    rootVars += '}\n';
    allCSS.push(rootVars);


    // Then capture stylesheet rules (filtered)
    Array.from(document.styleSheets).forEach(sheet => {
      try {
        // Only process if we can access cssRules (CORS check)
        if (sheet.cssRules) {
          Array.from(sheet.cssRules).forEach(rule => {
            const cssText = rule.cssText;

            // Skip @font-face rules (contain app:// URLs that fail CORS)
            if (cssText.startsWith('@font-face')) {
              return;
            }

            // Skip rules with app:// protocol URLs
            if (cssText.includes('app://')) {
              return;
            }

            // Skip rules with /public/ paths (Obsidian internal)
            if (cssText.includes('/public/')) {
              return;
            }

            // Include everything else (CSS variables, colors, styles, plugin CSS)
            allCSS.push(cssText);
          });
        }
      } catch (e) {
        // Skip CORS-blocked stylesheets
      }
    });

    return allCSS.join('\n');
  }

  extractPluginCSS(pluginClass) {
    // Extract CSS rules that apply to a specific plugin's classes
    const pluginCSS = [];
    const seenRules = new Set(); // Deduplicate rules

    // First, add all Obsidian CSS variables that the plugin might use
    const rootVars = getComputedStyle(document.body);
    const obsidianVars = [
      '--size-2-1', '--size-2-2', '--size-2-3',
      '--size-4-1', '--size-4-2', '--size-4-3', '--size-4-4',
      '--size-4-5', '--size-4-6', '--size-4-8', '--size-4-12',
      '--background-primary', '--background-secondary',
      '--background-primary-alt', '--background-secondary-alt',
      '--background-modifier-border', '--background-modifier-border-hover',
      '--background-modifier-border-focus',
      '--text-normal', '--text-muted', '--text-faint',
      '--interactive-accent', '--interactive-hover',
      '--table-border-width', '--table-border-color',
      '--font-text-size', '--font-ui-small', '--font-ui-smaller',
      '--clickable-icon-radius', '--radius-s', '--radius-m',
      '--tag-padding-x', '--tag-padding-y', '--tag-radius'
    ];

    let varsBlock = ':root {\n';
    obsidianVars.forEach(varName => {
      const value = rootVars.getPropertyValue(varName).trim();
      if (value) {
        varsBlock += `  ${varName}: ${value};\n`;
      }
    });
    varsBlock += '}\n';
    pluginCSS.push(varsBlock);

    // Extract base class name for pattern matching
    // e.g., '.kanban-plugin' -> 'kanban-plugin'
    const baseClassName = pluginClass.replace(/^\./, '');

    Array.from(document.styleSheets).forEach(sheet => {
      try {
        if (sheet.cssRules) {
          Array.from(sheet.cssRules).forEach(rule => {
            const cssText = rule.cssText;

            // Skip problematic rules
            if (cssText.startsWith('@font-face') || cssText.includes('app://')) {
              return;
            }

            // Skip if we've already seen this rule
            if (seenRules.has(cssText)) {
              return;
            }

            // Include rules that:
            // 1. Contain the base class name (catches .kanban-plugin, .kanban-plugin__item, etc.)
            // 2. Start with the base class (catches .kanban-plugin { ... })
            if (cssText.includes(baseClassName)) {
              pluginCSS.push(cssText);
              seenRules.add(cssText);
            }
          });
        }
      } catch (e) {
        // CORS error, skip
      }
    });


    return pluginCSS.join('\n');
  }

  getMimeType(ext) {
    const map = {
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'svg': 'image/svg+xml',
      'webp': 'image/webp',
      'pdf': 'application/pdf'
    };
    return map[ext.toLowerCase()] || 'application/octet-stream';
  }

  /**
   * Zero-Knowledge Audit Log
   * @param {string} userIdentifier - Email or userId of accessor
   * @param {string} action - Action performed (READ, WRITE, DELETE, etc.)
   * @param {string} target - File path or resource accessed
   */
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
    // STEP 1: CONSENT
    containerEl.createEl('h3', { text: '1️⃣ Enable Remote Access' });
    new obsidian.Setting(containerEl)
      .setName('I agree to enable remote access')
      .setDesc('This plugin connects to noterelay.io servers every 5 minutes (heartbeat) to allow remote vault access.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableRemoteAccess)
        .onChange(async (value) => {
          this.plugin.settings.enableRemoteAccess = value;
          await this.plugin.saveSettings();
          if (!value) {
            this.plugin.disconnectSignaling();
          }
          this.display();
        }));

    // Step 2: Account Verification (v8.0: OAuth via browser)
    containerEl.createEl('h3', { text: '2️⃣ Account' });

    if (this.plugin.settings.emailValidated && this.plugin.settings.userEmail) {
      // Already verified - show status
      const verifiedDiv = containerEl.createDiv();
      verifiedDiv.style.cssText = 'padding: 15px; margin-bottom: 15px; background: rgba(76,175,80,0.1); border-left: 3px solid #4caf50; border-radius: 4px;';
      verifiedDiv.innerHTML = `
        <strong style="color: #4caf50;">✅ Account Verified</strong><br>
        <span style="color: var(--text-muted);">${this.plugin.settings.userEmail}</span>
      `;

      new obsidian.Setting(containerEl)
        .setName('Change Account')
        .setDesc('Verify a different noterelay.io account')
        .addButton(btn => btn
          .setButtonText('Re-verify')
          .onClick(async () => {
            // Warn if connected
            if (this.plugin.isConnected) {
              const confirm = await new Promise(resolve => {
                const modal = new obsidian.Modal(this.app);
                modal.contentEl.createEl('h2', { text: '⚠️ Relay Will Disconnect' });
                modal.contentEl.createEl('p', { text: 'Re-verifying will disconnect the current relay connection. You will need to reconnect after verification.' });
                const btnContainer = modal.contentEl.createDiv({ cls: 'modal-button-container' });
                btnContainer.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;';
                const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
                cancelBtn.onclick = () => { modal.close(); resolve(false); };
                const confirmBtn = btnContainer.createEl('button', { text: 'Continue', cls: 'mod-warning' });
                confirmBtn.onclick = () => { modal.close(); resolve(true); };
                modal.open();
              });
              if (!confirm) return;
              this.plugin.disconnectSignaling();
            }
            // Open browser for re-verification
            const url = `https://noterelay.io/plugin-auth?vaultId=${encodeURIComponent(this.plugin.settings.vaultId)}&vaultName=${encodeURIComponent(this.plugin.app.vault.getName())}`;
            window.open(url);
            new obsidian.Notice('🔐 Complete verification in your browser, then return here.');
          }))
        .addButton(btn => btn
          .setButtonText('Logout')
          .setWarning()
          .onClick(async () => {
            // Disconnect and clear account
            this.plugin.disconnectSignaling();
            this.plugin.settings.userEmail = '';
            this.plugin.settings.emailValidated = false;
            await this.plugin.saveSettings();
            new obsidian.Notice('🔓 Account disconnected. You will need to verify again to use the relay.');
            this.display();
          }));
    } else {
      // Not verified - show verify button
      const notVerifiedDiv = containerEl.createDiv();
      notVerifiedDiv.style.cssText = 'padding: 15px; margin-bottom: 15px; background: rgba(124,77,255,0.1); border-left: 3px solid #7c4dff; border-radius: 4px;';
      notVerifiedDiv.innerHTML = `
        <strong>🔐 Verification Required</strong><br>
        <span style="color: var(--text-muted);">Click below to verify your noterelay.io account via browser login.</span>
      `;

      new obsidian.Setting(containerEl)
        .setName('Verify Account')
        .setDesc('Opens your browser to log in and verify with OTP')
        .addButton(btn => btn
          .setButtonText('Verify via Browser')
          .setCta()
          .onClick(() => {
            // Open browser for OAuth verification
            const url = `https://noterelay.io/plugin-auth?vaultId=${encodeURIComponent(this.plugin.settings.vaultId)}&vaultName=${encodeURIComponent(this.plugin.app.vault.getName())}`;
            window.open(url);
            new obsidian.Notice('🔐 Complete verification in your browser, then return here.');
          }));
    }

    // Step 3: Connect Relay (v8.0: No password required, OTP validates via browser)
    containerEl.createEl('h3', { text: '3️⃣ Connect Relay' });

    // v8.0: Only require consent + verified email
    const canStart = this.plugin.settings.enableRemoteAccess && this.plugin.settings.emailValidated;

    if (!canStart) {
      const warningDiv = containerEl.createDiv();
      warningDiv.style.cssText = 'padding: 15px; margin-bottom: 15px; background: rgba(255,152,0,0.1); border-left: 3px solid #ff9800; border-radius: 4px;';
      if (!this.plugin.settings.enableRemoteAccess) {
        warningDiv.innerHTML = '<strong>⚠️ Step 1 incomplete</strong><br>Enable remote access above.';
      } else if (!this.plugin.settings.emailValidated) {
        warningDiv.innerHTML = '<strong>⚠️ Step 2 incomplete</strong><br>Verify your account via browser.';
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
