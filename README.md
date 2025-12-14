# Note Relay - Headless Plugin (v2.0)

**Zero-knowledge vault sharing for Obsidian**

## What Changed in v2.0?

- **Headless Architecture**: No local UI. All interfaces run at `app.noterelay.com`.
- **Image Optimization**: Automatic image resizing using Electron's native APIs (<200KB target).
- **Modular Codebase**: Split into logical modules (server, routes, auth, webrtc, images).
- **CORS Lockdown**: Hardcoded whitelist for security.
- **No Telemetry**: Analytics handled by cloud client.

## Structure

```
note-relay-obsidian_plugin/
├── src/
│   ├── main.js              # Plugin entry point
│   └── server/
│       ├── server.js        # Express server + CORS
│       ├── routes.js        # API endpoints
│       ├── auth.js          # Password verification
│       ├── images.js        # Image optimization
│       └── webrtc.js        # Signaling + P2P
├── manifest.json            # Plugin metadata
├── package.json             # Dependencies
└── esbuild.config.mjs       # Build config
```

## Build

```bash
npm install
npm run build
```

## Development

```bash
npm run dev
```

## Target Bundle Size

**Goal:** <200KB (main.js)

**Key Optimizations:**
- Removed telemetry.js (~40KB)
- No UI bundle (saved 1.2MB)
- Tree-shaking enabled
- Production minification

## Security

**CORS Whitelist:**
- `https://app.noterelay.com`
- `https://noterelay.io`
- `http://localhost:*`
- `http://127.0.0.1:*`

All other origins are blocked with 403.
