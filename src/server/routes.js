const auth = require('./auth');
const images = require('./images');

function registerRoutes(app, plugin) {
  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ 
      status: 'healthy',
      version: '2.0.0',
      vault: plugin.app.vault.getName()
    });
  });
  
  // Authentication check
  app.post('/api/auth', async (req, res) => {
    try {
      const { password, email } = req.body;
      const valid = await auth.verifyAccess(password, email, plugin.settings);
      res.json({ valid });
    } catch (error) {
      console.error('Auth error:', error);
      res.status(500).json({ error: 'Authentication failed' });
    }
  });
  
  // List files
  app.get('/api/files', async (req, res) => {
    try {
      const files = plugin.app.vault.getFiles();
      const list = files.map(f => ({
        path: f.path,
        name: f.name,
        extension: f.extension,
        stat: f.stat
      }));
      res.json({ files: list });
    } catch (error) {
      console.error('List files error:', error);
      res.status(500).json({ error: 'Failed to list files' });
    }
  });
  
  // Read file
  app.get('/api/file/:path(*)', async (req, res) => {
    try {
      const filePath = req.params.path;
      
      // Check if it's an image
      if (images.isImage(filePath)) {
        return images.serveOptimizedImage(filePath, plugin.app.vault, res);
      }
      
      // Serve text files
      const content = await plugin.app.vault.adapter.read(filePath);
      res.json({ path: filePath, content });
    } catch (error) {
      console.error('Read file error:', error);
      res.status(404).json({ error: 'File not found' });
    }
  });
  
  // Write file
  app.post('/api/file/:path(*)', async (req, res) => {
    try {
      const filePath = req.params.path;
      const { content } = req.body;
      
      await plugin.app.vault.adapter.write(filePath, content);
      res.json({ success: true, path: filePath });
    } catch (error) {
      console.error('Write file error:', error);
      res.status(500).json({ error: 'Failed to write file' });
    }
  });
  
  // Delete file
  app.delete('/api/file/:path(*)', async (req, res) => {
    try {
      const filePath = req.params.path;
      await plugin.app.vault.adapter.remove(filePath);
      res.json({ success: true, path: filePath });
    } catch (error) {
      console.error('Delete file error:', error);
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });
}

module.exports = { registerRoutes };
