import { Buffer } from 'buffer';
if (typeof window !== 'undefined') {
  window.Buffer = Buffer;
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
const BUILD_VERSION = '2024.12.16-1135';
const CHUNK_SIZE = 16 * 1024;
const DEFAULT_SETTINGS = {
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

    // BETA KILL SWITCH: Check if plugin is locked
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

    // TRINITY PROTOCOL: Generate Machine ID (Node ID)
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

    // Cleanup legacy identity artifacts from removed standby feature
    window.localStorage.removeItem('portal-device-id');
    if (this.settings.targetHostId !== undefined) {
      delete this.settings.targetHostId;
      await this.saveSettings();
    }


    console.log(`%c PORTAL ${BUILD_VERSION} READY`, 'color: #00ff00; font-weight: bold; background: #000;');
    this.statusBar = this.addStatusBarItem();
    this.isConnected = false;

    // Auto-connect on plugin load
    if (this.settings.autoConnect !== false) {
      this.connectSignaling();
    } else {
      this.statusBar?.setText('Note Relay: Stopped');
    }

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

    setTimeout(() => this.connectSignaling(), 1000);
  }

  onunload() {
    this.disconnectSignaling();

    if (false /* analytics removed */) {
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Sanitize file paths to prevent directory traversal attacks
   * @param {string} unsafePath - Raw user input path
   * @returns {string} Sanitized path safe for vault operations
   */
  sanitizePath(unsafePath) {
    if (!unsafePath || typeof unsafePath !== 'string') return '';

    // 1. Normalize slashes
    let clean = unsafePath.replace(/\\/g, '/');

    // 2. Remove path traversal attempts (..)
    clean = clean.replace(/\.\.\+/g, '');

    // 3. Remove leading slashes (force relative paths)
    clean = clean.replace(/^\/+/, '');

    // 4. Remove any remaining dangerous patterns
    clean = clean.replace(/[\/]{2,}/g, '/'); // Multiple slashes

    // 5. Trim whitespace
    clean = clean.trim();

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
          nodeId: this.nodeId,           // Machine ID (Trinity Protocol)
          machineName: os.hostname()     // User-friendly machine identifier
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

        // Capture license tier from server response
        if (result.planType) {
          await this.saveSettings();
        }

        // Save the database vault ID and user ID for analytics
        if (result.vaultId && result.userId) {
          this.settings.dbVaultId = result.vaultId;
          this.settings.userId = result.userId;
          await this.saveSettings();

          if (false /* analytics removed */) {
            console.log('[Telemetry] Initialized for registered vault:', this.settings.dbVaultId);
          }
        }

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

      // KILL SWITCH: Stop if license is invalid
      if (response.status === 401 || response.status === 403) {
        console.warn(`Note Relay: License invalid (${response.status}). Stopping heartbeat.`);
        clearInterval(this.heartbeatInterval);
        new obsidian.Notice("Note Relay: License expired. Remote access paused.");
        return { success: false, fatal: true, reason: 'auth' };
      }

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
  async processCommand(msg, sendCallback) {
    try {
      if (msg.cmd === 'PING' || msg.cmd === 'HANDSHAKE') {
        console.log('🔒 Server PING/HANDSHAKE received');
        const themeCSS = this.extractThemeCSS();
        sendCallback(msg.cmd === 'PING' ? 'PONG' : 'HANDSHAKE_ACK', {
          version: BUILD_VERSION,
          readOnly: false, // Will be overridden by HTTP/WebRTC handlers in their callbacks
          css: themeCSS
        });
        return;
      }

      if (msg.cmd === 'GET_TREE') {
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

        // NEW: Send Theme CSS immediately with the file tree
        const treeCss = this.extractThemeCSS();
        sendCallback('TREE', { files, folders: allFolders, css: treeCss });
        return;
      }

      if (msg.cmd === 'GET_RENDERED_FILE') {
        const safePath = this.sanitizePath(msg.path);
        if (!safePath) {
          sendCallback('ERROR', { message: 'Invalid path' });
          return;
        }

        let file = this.app.vault.getAbstractFileByPath(safePath);
        let shouldRefreshTree = msg.refreshTree || false;

        // AUTO-CREATE MISSING FILE (Ghost Link Support)
        if (!file) {
          try {
            console.log('Ghost Link: Creating missing file', safePath);
            file = await this.app.vault.create(safePath, '');
            new obsidian.Notice(`Created: ${safePath}`);
            shouldRefreshTree = true; // FORCE REFRESH
          } catch (err) {
            console.error('Ghost Create Failed:', err);
            sendCallback('ERROR', { message: `Could not create '${safePath}'. Ensure folder exists.` });
            return;
          }
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

                // Strategy 2: If no container, try to resolve the app:// URL to a file path
                if (!targetFile) {
                  // This is harder because app:// paths are absolute. 
                  // We'll skip complex reverse-engineering for V1 and rely on Strategy 1.
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
        return;
      }

      if (msg.cmd === 'GET_FILE') {
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

        // BANDWIDTH GUARD: Block video streaming
        const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv', 'iso', 'flv', 'webm', 'm4v'];
        if (VIDEO_EXTS.includes(file.extension.toLowerCase())) {
          console.log('🚫 Blocked video file request:', file.path);
          sendCallback('ERROR', { message: 'Media streaming is disabled. Video files cannot be accessed remotely.' });
          return;
        }

        const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
        if (IMAGE_EXTS.includes(file.extension)) {
          console.log(`Note Relay: Reading Image ${file.path}`);
          const arrayBuffer = await this.app.vault.readBinary(file);
          const base64 = Buffer.from(arrayBuffer).toString('base64');
          sendCallback('FILE', base64, {
            path: msg.path,
            isImage: true,
            ext: file.extension
          });
        } else {
          const content = await this.app.vault.read(file);
          const backlinks = [];

          if (file.extension === 'md') {
            const resolved = this.app.metadataCache.resolvedLinks;
            for (const [sourcePath, links] of Object.entries(resolved)) {
              if (links[msg.path]) backlinks.push(sourcePath);
            }
          }

          sendCallback('FILE', {
            data: content,
            backlinks
          }, { path: msg.path });
        }
        return;
      }

      if (msg.cmd === 'SAVE_FILE') {
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

        // Record sync event
        if (false /* analytics removed */) {
        }

        sendCallback('SAVED', { path: safePath });
        new obsidian.Notice(`Saved: ${safePath}`);
        return;
      }

      if (msg.cmd === 'CREATE_FILE') {
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
        await this.processCommand({
          cmd: 'GET_RENDERED_FILE',
          path: safePath,
          refreshTree: true
        }, sendCallback);
        return;
      }

      if (msg.cmd === 'CREATE_FOLDER') {
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
        return;
      }

      if (msg.cmd === 'RENAME_FILE') {
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
        return;
      }

      if (msg.cmd === 'DELETE_FILE') {
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
        return;
      }

      if (msg.cmd === 'OPEN_FILE') {
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
          this.processCommand({
            cmd: 'GET_RENDERED_FILE',
            path: safePath
          }, sendCallback);
          return;
        }

        // Try to capture plugin view HTML from existing open leaf
        const workspace = this.app.workspace;
        let kanbanLeaf = workspace.getLeavesOfType('kanban')[0];

        console.log('🔍 OPEN_FILE Debug:', {
          detectedPlugin,
          hasKanbanLeaf: !!kanbanLeaf,
          allLeafTypes: workspace.getLeavesOfType('kanban').length,
          allLeaves: this.app.workspace.getLeavesOfType('markdown').map(l => l.getViewState().type)
        });

        if (!kanbanLeaf) {
          // Try to open the file in a new tab to create the view
          try {
            console.log('🔓 Attempting to open file in new leaf...');
            const newLeaf = workspace.getLeaf('tab');
            await newLeaf.openFile(file);
            console.log('✅ File opened, view type:', newLeaf.getViewState().type);

            // Check if it's now a kanban view
            if (newLeaf.getViewState().type === 'kanban') {
              kanbanLeaf = newLeaf;
              console.log('✅ Kanban view detected!');
            } else {
              console.warn('⚠️ View type is not kanban:', newLeaf.getViewState().type);
            }
          } catch (openError) {
            console.error('❌ Failed to open file:', openError);
          }
        } else {
          // Leaf exists but might not be rendering - force a refresh
          try {
            console.log('🔄 Kanban leaf exists, forcing refresh...');
            await kanbanLeaf.openFile(file);
            // Give it a moment to actually render
            await new Promise(resolve => setTimeout(resolve, 150));
          } catch (refreshError) {
            console.error('❌ Failed to refresh kanban leaf:', refreshError);
          }
        }

        console.log('🎯 Attempting to extract HTML, kanbanLeaf exists:', !!kanbanLeaf);

        // If we have a leaf, extract the rendered HTML
        if (kanbanLeaf) {
          const view = kanbanLeaf.view;

          console.log('🔍 View check:', {
            hasView: !!view,
            hasContainerEl: !!view?.containerEl,
            containerClasses: view?.containerEl?.className
          });

          if (view.containerEl) {
            // Wait for Kanban to render (it may be async)
            // Try multiple times with increasing delays
            let kanbanBoard = null;
            let attempts = 0;
            const maxAttempts = 5;

            while (!kanbanBoard && attempts < maxAttempts) {
              if (attempts > 0) {
                await new Promise(resolve => setTimeout(resolve, 100 * attempts)); // 100ms, 200ms, 300ms, 400ms
                console.log(`⏳ Retry ${attempts}/${maxAttempts} - waiting for Kanban DOM...`);
              }

              kanbanBoard = view.containerEl.querySelector('.kanban-plugin');
              attempts++;
            }

            console.log('🔍 Kanban board element:', {
              found: !!kanbanBoard,
              attempts: attempts,
              selector: '.kanban-plugin',
              containerHTML: view.containerEl.innerHTML.substring(0, 500)
            });

            if (kanbanBoard) {
              const capturedHTML = kanbanBoard.outerHTML;

              console.log('🎨 ========== KANBAN CAPTURE DEBUG ==========');
              console.log('📏 HTML length:', capturedHTML.length);
              console.log('📝 HTML preview (first 1000 chars):', capturedHTML.substring(0, 1000));
              console.log('📝 HTML preview (last 500 chars):', capturedHTML.substring(capturedHTML.length - 500));

              // Extract Kanban plugin CSS
              const kanbanCSS = this.extractPluginCSS('.kanban-plugin');

              console.log('🎨 CSS length:', kanbanCSS.length);
              console.log('🎨 CSS preview (first 2000 chars):', kanbanCSS.substring(0, 2000));
              console.log('🎨 CSS rule count:', (kanbanCSS.match(/\{/g) || []).length);

              const response = {
                renderedHTML: capturedHTML,
                pluginCSS: kanbanCSS,
                viewType: 'kanban',
                success: true
              };

              console.log('📦 Response object keys:', Object.keys(response));
              console.log('📦 Response.renderedHTML length:', response.renderedHTML.length);
              console.log('📦 Response.pluginCSS length:', response.pluginCSS.length);
              console.log('🎨 ========== END CAPTURE DEBUG ==========');

              sendCallback('OPEN_FILE', response, { path: safePath });

              // Close the leaf after capturing
              kanbanLeaf.detach();
              console.log('🗑️ Closed Kanban leaf');

              return;
            }
          }
        }

        // If we got here, fall back to markdown rendering
        console.warn('⚠️ Falling back to markdown rendering (no Kanban HTML captured)');

        // Wrapper to ensure we return OPEN_FILE type even for fallback
        const wrapperCallback = (type, data, meta) => {
          if (type === 'RENDERED_FILE') {
            sendCallback('OPEN_FILE', data, meta);
          } else {
            sendCallback(type, data, meta);
          }
        };

        this.processCommand({
          cmd: 'GET_RENDERED_FILE',
          path: safePath
        }, wrapperCallback);

        return;
      }

      if (msg.cmd === 'OPEN_DAILY_NOTE') {
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

          console.log('📅 Daily note created/opened:', activeFile.path);

          // Get the active leaf and close it
          const activeLeaf = this.app.workspace.getLeaf(false);
          if (activeLeaf) {
            activeLeaf.detach();
            console.log('🗑️ Closed daily note leaf');
          }

          // Just return the path - let web UI load it normally
          const response = { success: true, path: activeFile.path };
          sendCallback('OPEN_DAILY_NOTE', response);

        } catch (error) {
          console.error('Daily Note Error:', error);
          sendCallback('ERROR', { message: 'Failed to open daily note: ' + error.message });
        }
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
        console.log(`Note Relay: Sending Large File (${Math.round(totalBytes / 1024)}KB)`);
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
              // Owner authentication
              if (this.settings.masterPasswordHash && msg.authHash === this.settings.masterPasswordHash) {
                accessGranted = true;
                isReadOnly = false;
                userIdentifier = this.settings.userEmail;
                console.log('✅ WebRTC: Owner authenticated -', userIdentifier);
              } else {
                console.log('❌ WebRTC: Owner password incorrect');
                peer.safeSend({ type: 'ERROR', message: 'ACCESS_DENIED: Invalid password.' });
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
            console.log('❌ WebRTC: Authentication failed - invalid credentials or not in ACL');
            peer.safeSend({ type: 'ERROR', message: 'ACCESS_DENIED: Invalid credentials or not authorized' });
            setTimeout(() => peer.destroy(), 1000);
          }
          return;
        }

        if (!isAuthenticated) return;

        // Block write commands if in read-only mode
        const writeCommands = ['CREATE', 'WRITE', 'DELETE', 'RENAME'];
        if (peerReadOnly && writeCommands.includes(msg.cmd)) {
          console.log(`🔒 Blocked ${msg.cmd} command - read-only mode`);
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
        await this.processCommand(msg, wrappedSendCallback);

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
      console.log('Note Relay: Connection health check - not connected');
      return;
    }

    const timeSinceLastHeartbeat = Date.now() - (this.lastHeartbeatTime || 0);

    // If more than 6 minutes since last heartbeat, reconnect
    if (timeSinceLastHeartbeat > 6 * 60 * 1000) {
      console.log('Note Relay: Connection stale, reconnecting...');
      await this.connectSignaling();
    } else {
      console.log('Note Relay: Connection healthy');
    }
  }

  async connectSignaling() {
    // SECURITY CHECK: Do not connect to Supabase if no email is present.
    if (!this.settings.userEmail) {
      console.log('Note Relay: No user email found. Staying offline (Local Mode only).');
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

        console.log('✅ Connection credentials loaded dynamically');
      } catch (err) {
        console.error('Failed to fetch connection credentials:', err);
        new obsidian.Notice('Note Relay: Connection initialization failed');
        return;
      }
    }

    this.supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Check if we have user email for remote access
    let signalId = null;
    if (this.settings.userEmail && this.settings.masterPasswordHash) {
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

    console.log('🎧 Host listening for offers with filter: target=eq.' + ID);

    this.channel = this.supabase.channel('host-channel')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'signaling', filter: `target=eq.${ID}` },
        (payload) => {
          console.log('📨 Received signaling message:', payload.new);
          if (payload.new.type === 'offer') {
            console.log('✅ Offer received from:', payload.new.source);
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
    console.log('🎨 THEME EXTRACTION DEBUG:');

    // Build :root block with essential variables at the top
    let rootVars = ':root {\n';
    essentialVars.forEach(varName => {
      const value = bodyStyles.getPropertyValue(varName).trim();
      console.log(`  ${varName}: ${value || 'NOT FOUND'}`);
      if (value) {
        // Add !important to ensure these override fallbacks
        rootVars += `  ${varName}: ${value} !important;\n`;
      }
    });
    rootVars += '}\n';
    allCSS.push(rootVars);

    console.log('📋 Root vars block:', rootVars);
    console.log('📊 Total stylesheet count:', document.styleSheets.length);

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

    console.log('🎨 Extracted', pluginCSS.length - 1, 'CSS rules for', baseClassName);

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
        <div style="margin-top: 10px; font-size: 0.9em; color: var(--text-muted);">Signal ID: ${this.plugin.signalId ? this.plugin.signalId.slice(0,8) + '...' : 'Connecting...'}</div>
      `;
    }
  }
}

module.exports = NoteRelay;
