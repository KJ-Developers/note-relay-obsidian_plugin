const express = require('express');
const cors = require('cors');

// CORS Whitelist - Hardcoded for security
const ALLOWED_ORIGINS = [
  'https://noterelay.io',
  'http://localhost',
  'http://127.0.0.1'
];

function createServer(port, plugin) {
  const app = express();
  
  // CORS Middleware - Strict whitelist
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    
    // Allow no-origin requests (Postman, curl, internal)
    if (!origin) return next();
    
    // Check if origin matches whitelist (including any port for localhost/127.0.0.1)
    const isAllowed = ALLOWED_ORIGINS.some(allowed => {
      if (allowed.includes('localhost') || allowed.includes('127.0.0.1')) {
        return origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
      }
      return origin === allowed;
    });
    
    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      return next();
    }
    
    console.warn(`[Security] Blocked CORS request from: ${origin}`);
    res.status(403).json({ error: 'Origin not allowed' });
  });
  
  // Handle preflight
  app.options('*', (req, res) => res.sendStatus(200));
  
  // Parse JSON bodies
  app.use(express.json({ limit: '50mb' }));
  
  // Landing page
  app.get('/', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Note Relay</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .container { text-align: center; }
          h1 { font-size: 3rem; margin-bottom: 1rem; }
          p { font-size: 1.2rem; }
          a { color: #fff; text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>✅ Note Relay is Online</h1>
          <p>Go to <a href="https://noterelay.io">noterelay.io</a> to view your notes.</p>
        </div>
      </body>
      </html>
    `);
  });
  
  // Meta endpoint
  app.get('/api/meta', (req, res) => {
    res.json({
      version: '2.0.0',
      chunkSize: 16384,
      status: 'online'
    });
  });
  
  // Mount API routes
  const routes = require('./routes');
  routes.registerRoutes(app, plugin);
  
  return app;
}

module.exports = { createServer, ALLOWED_ORIGINS };
