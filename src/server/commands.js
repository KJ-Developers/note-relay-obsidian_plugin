const { MarkdownRenderer } = require('obsidian');
const auth = require('./auth');

/**
 * Handle incoming data channel commands
 * @param {Object} msg - The incoming message { cmd, ...params }
 * @param {Object} plugin - The plugin instance
 * @param {Function} sendCallback - Function to send response back
 * @param {Object} peerState - Per-peer auth state { isAuthenticated, isReadOnly }
 */
async function handleCommand(msg, plugin, sendCallback, peerState) {
  const { cmd } = msg;
  
  // AUTH command (must come first)
  if (cmd === 'PING' || cmd === 'HANDSHAKE') {
    return await handleAuth(msg, plugin, sendCallback, peerState);
  }
  
  // Block unauthenticated requests
  if (!peerState.isAuthenticated) {
    sendCallback('ERROR', { message: 'Unauthenticated' });
    return;
  }
  
  // Block write commands for read-only peers
  const writeCommands = ['FILE_WRITE', 'CREATE', 'DELETE', 'RENAME'];
  if (peerState.isReadOnly && writeCommands.includes(cmd)) {
    console.log(`🔒 Blocked ${cmd} command - read-only mode`);
    sendCallback('ERROR', { message: 'READ_ONLY_MODE: Editing is disabled' });
    return;
  }
  
  // Route to handlers
  switch (cmd) {
    case 'FILE_READ':
      return await handleFileRead(msg, plugin, sendCallback);
    case 'FILE_LIST':
      return await handleFileList(msg, plugin, sendCallback);
    case 'FILE_WRITE':
      return await handleFileWrite(msg, plugin, sendCallback);
    case 'SEARCH':
      return await handleSearch(msg, plugin, sendCallback);
    case 'GET_RENDERED_FILE':
      return await handleGetRenderedFile(msg, plugin, sendCallback);
    case 'GET_FILE':
      return await handleGetFile(msg, plugin, sendCallback);
    default:
      sendCallback('ERROR', { message: `Unknown command: ${cmd}` });
  }
}

/**
 * AUTH: Verify password and grant access
 */
async function handleAuth(msg, plugin, sendCallback, peerState) {
  let accessGranted = false;
  let isReadOnly = false;
  let userIdentifier = 'unknown';
  
  // Email-based authentication
  if (msg.guestEmail && msg.authHash) {
    const userEmail = msg.guestEmail.toLowerCase().trim();
    
    // Check if owner
    if (plugin.settings.userEmail && userEmail === plugin.settings.userEmail.toLowerCase().trim()) {
      if (plugin.settings.masterPasswordHash && msg.authHash === plugin.settings.masterPasswordHash) {
        accessGranted = true;
        isReadOnly = false;
        userIdentifier = plugin.settings.userEmail;
        console.log('✅ WebRTC: Owner authenticated -', userIdentifier);
      } else {
        console.log('❌ WebRTC: Owner password incorrect');
        sendCallback('ERROR', { message: 'ACCESS_DENIED: Invalid password.' });
        return false;
      }
    }
    // Check guest list
    else if (plugin.settings.guestList && plugin.settings.guestList.length > 0) {
      const guest = plugin.settings.guestList.find(g => g.email === userEmail);
      
      if (!guest) {
        console.log('❌ WebRTC: Guest not in list');
        sendCallback('ERROR', { message: 'ACCESS_DENIED: Not authorized' });
        return false;
      }
      
      // Verify password
      if (guest.passHash !== msg.authHash) {
        console.log('❌ WebRTC: Guest password incorrect');
        sendCallback('ERROR', { message: 'ACCESS_DENIED: Invalid password.' });
        return false;
      }
      
      accessGranted = true;
      isReadOnly = (guest.mode === 'ro');
      userIdentifier = userEmail;
      console.log(`✅ WebRTC: Guest authenticated - ${userIdentifier} (${guest.mode})`);
    }
  }
  
  if (accessGranted) {
    peerState.isAuthenticated = true;
    peerState.isReadOnly = isReadOnly;
    peerState.userIdentifier = userIdentifier;
    
    sendCallback(msg.cmd === 'PING' ? 'PONG' : 'HANDSHAKE_ACK', {
      readOnly: isReadOnly,
      version: 'v2.0-headless'
    });
    
    return true;
  } else {
    sendCallback('ERROR', { message: 'ACCESS_DENIED: Invalid credentials' });
    return false;
  }
}

/**
 * FILE_READ: Read file and render markdown to HTML
 */
async function handleFileRead(msg, plugin, sendCallback) {
  const safePath = sanitizePath(msg.path);
  if (!safePath) {
    sendCallback('ERROR', { message: 'Invalid path' });
    return;
  }
  
  const file = plugin.app.vault.getAbstractFileByPath(safePath);
  if (!file) {
    sendCallback('ERROR', { message: 'File not found' });
    return;
  }
  
  try {
    const content = await plugin.app.vault.read(file);
    
    // Extract YAML frontmatter
    let yamlData = null;
    let contentWithoutYaml = content;
    const yamlMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
    
    if (yamlMatch) {
      const cache = plugin.app.metadataCache.getFileCache(file);
      if (cache && cache.frontmatter) {
        yamlData = { ...cache.frontmatter };
        delete yamlData.position;
      }
      contentWithoutYaml = content.slice(yamlMatch[0].length);
    }
    
    // Render markdown to HTML
    const html = await renderMarkdownToHtml(contentWithoutYaml, file.path, plugin);
    
    sendCallback('FILE_CONTENT', {
      html,
      yaml: yamlData,
      path: safePath
    });
  } catch (error) {
    console.error('FILE_READ error:', error);
    sendCallback('ERROR', { message: 'Failed to read file: ' + error.message });
  }
}

/**
 * GET_RENDERED_FILE: Full render with backlinks, graph, etc.
 */
async function handleGetRenderedFile(msg, plugin, sendCallback) {
  const safePath = sanitizePath(msg.path);
  if (!safePath) {
    sendCallback('ERROR', { message: 'Invalid path' });
    return;
  }
  
  let file = plugin.app.vault.getAbstractFileByPath(safePath);
  
  // Auto-create missing file (ghost link support)
  if (!file) {
    try {
      console.log('Ghost Link: Creating missing file', safePath);
      file = await plugin.app.vault.create(safePath, '');
    } catch (err) {
      sendCallback('ERROR', { message: `Could not create '${safePath}'` });
      return;
    }
  }
  
  try {
    const content = await plugin.app.vault.read(file);
    
    // Extract YAML frontmatter
    let yamlData = null;
    let contentWithoutYaml = content;
    const yamlMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
    
    if (yamlMatch) {
      const cache = plugin.app.metadataCache.getFileCache(file);
      if (cache && cache.frontmatter) {
        yamlData = { ...cache.frontmatter };
        delete yamlData.position;
      }
      contentWithoutYaml = content.slice(yamlMatch[0].length);
    }
    
    // Render markdown
    const html = await renderMarkdownToHtml(contentWithoutYaml, file.path, plugin);
    
    // Build graph data
    const graphData = { nodes: [], edges: [] };
    const backlinks = [];
    
    graphData.nodes.push({ id: safePath, label: file.basename, group: 'center' });
    
    // Forward links
    const cache = plugin.app.metadataCache.getFileCache(file);
    if (cache && cache.links) {
      cache.links.forEach(l => {
        const linkPath = l.link;
        if (!graphData.nodes.find(n => n.id === linkPath)) {
          graphData.nodes.push({
            id: linkPath,
            label: linkPath.split('/').pop().replace('.md', ''),
            group: 'neighbor'
          });
        }
        graphData.edges.push({ from: safePath, to: linkPath });
      });
    }
    
    // Backlinks
    const allLinks = plugin.app.metadataCache.resolvedLinks;
    for (const sourcePath in allLinks) {
      if (allLinks[sourcePath][safePath]) {
        backlinks.push(sourcePath);
        if (!graphData.nodes.find(n => n.id === sourcePath)) {
          graphData.nodes.push({
            id: sourcePath,
            label: sourcePath.split('/').pop().replace('.md', ''),
            group: 'neighbor'
          });
        }
        graphData.edges.push({ from: sourcePath, to: safePath });
      }
    }
    
    sendCallback('RENDERED_FILE', {
      html,
      yaml: yamlData,
      backlinks,
      graph: graphData,
      path: safePath
    });
  } catch (error) {
    console.error('GET_RENDERED_FILE error:', error);
    sendCallback('ERROR', { message: 'Rendering failed: ' + error.message });
  }
}

/**
 * GET_FILE: Read raw file content
 */
async function handleGetFile(msg, plugin, sendCallback) {
  const safePath = sanitizePath(msg.path);
  if (!safePath) {
    sendCallback('ERROR', { message: 'Invalid path' });
    return;
  }
  
  const file = plugin.app.vault.getAbstractFileByPath(safePath);
  if (!file) {
    sendCallback('ERROR', { message: 'File not found' });
    return;
  }
  
  try {
    const content = await plugin.app.vault.read(file);
    sendCallback('FILE', { data: content, path: safePath });
  } catch (error) {
    sendCallback('ERROR', { message: 'Failed to read file' });
  }
}

/**
 * FILE_LIST: Return all vault files
 */
async function handleFileList(msg, plugin, sendCallback) {
  try {
    const files = plugin.app.vault.getFiles().map(f => {
      // Get metadata
      const cache = plugin.app.metadataCache.getFileCache(f);
      const tags = [];
      const links = [];
      
      if (cache) {
        if (cache.frontmatter?.tags) {
          let ft = cache.frontmatter.tags;
          if (!Array.isArray(ft)) ft = [ft];
          ft.forEach(t => tags.push(t.startsWith('#') ? t : '#' + t));
        }
        if (cache.tags) cache.tags.forEach(t => tags.push(t.tag));
        if (cache.links) cache.links.forEach(l => links.push(l.link));
      }
      
      return {
        path: f.path,
        name: f.name,
        basename: f.basename,
        extension: f.extension,
        tags: [...new Set(tags)],
        links: [...new Set(links)]
      };
    });
    
    // Get folders
    const folders = [];
    const getAllFolders = (folder) => {
      folder.children.forEach(child => {
        if (child.children) {
          folders.push(child.path);
          getAllFolders(child);
        }
      });
    };
    getAllFolders(plugin.app.vault.getRoot());
    
    sendCallback('FILE_LIST', { files, folders });
  } catch (error) {
    console.error('FILE_LIST error:', error);
    sendCallback('ERROR', { message: 'Failed to list files' });
  }
}

/**
 * FILE_WRITE: Modify file content
 */
async function handleFileWrite(msg, plugin, sendCallback) {
  const safePath = sanitizePath(msg.path);
  if (!safePath) {
    sendCallback('ERROR', { message: 'Invalid path' });
    return;
  }
  
  const file = plugin.app.vault.getAbstractFileByPath(safePath);
  if (!file) {
    sendCallback('ERROR', { message: 'File not found' });
    return;
  }
  
  try {
    await plugin.app.vault.modify(file, msg.data);
    sendCallback('FILE_SAVED', { path: safePath });
  } catch (error) {
    console.error('FILE_WRITE error:', error);
    sendCallback('ERROR', { message: 'Failed to write file' });
  }
}

/**
 * SEARCH: Search vault for term
 */
async function handleSearch(msg, plugin, sendCallback) {
  try {
    const query = msg.query.toLowerCase();
    const results = [];
    
    const files = plugin.app.vault.getMarkdownFiles();
    
    for (const file of files) {
      const content = await plugin.app.vault.read(file);
      const contentLower = content.toLowerCase();
      
      if (contentLower.includes(query)) {
        // Find matching lines
        const lines = content.split('\n');
        const matches = [];
        
        lines.forEach((line, index) => {
          if (line.toLowerCase().includes(query)) {
            matches.push({
              lineNum: index + 1,
              text: line.trim()
            });
          }
        });
        
        results.push({
          path: file.path,
          matches: matches.slice(0, 5) // Limit to 5 matches per file
        });
      }
    }
    
    sendCallback('SEARCH_RESULTS', { results, query });
  } catch (error) {
    console.error('SEARCH error:', error);
    sendCallback('ERROR', { message: 'Search failed' });
  }
}

/**
 * Render markdown to HTML using Obsidian's renderer
 */
async function renderMarkdownToHtml(markdown, sourcePath, plugin) {
  const div = document.createElement('div');
  
  await MarkdownRenderer.render(
    plugin.app,
    markdown,
    div,
    sourcePath,
    plugin
  );
  
  // Wait for dynamic content to render
  await waitForRender(div);
  
  return div.innerHTML;
}

/**
 * Wait for renderer to finish (handles Dataview, etc.)
 */
async function waitForRender(element) {
  if (!element.innerHTML.trim()) {
    await new Promise(r => setTimeout(r, 100));
  }
  
  return new Promise((resolve) => {
    let timeout = null;
    
    const maxTimeout = setTimeout(() => {
      if (observer) observer.disconnect();
      resolve();
    }, 2000);
    
    const observer = new MutationObserver(() => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        observer.disconnect();
        clearTimeout(maxTimeout);
        resolve();
      }, 300);
    });
    
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true
    });
    
    // Trigger initial debounce
    timeout = setTimeout(() => {
      observer.disconnect();
      clearTimeout(maxTimeout);
      resolve();
    }, 300);
  });
}

/**
 * Sanitize file paths
 */
function sanitizePath(path) {
  if (!path || typeof path !== 'string') return null;
  
  // Remove dangerous patterns
  const dangerous = ['../', '..\\', '~/', '\\\\'];
  for (const pattern of dangerous) {
    if (path.includes(pattern)) return null;
  }
  
  return path.replace(/\\/g, '/');
}

module.exports = {
  handleCommand
};
