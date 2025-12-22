# Note Relay

**Zero-knowledge vault sharing for Obsidian**

Access your Obsidian vault securely from any browser. No cloud storage of your notes — everything is encrypted peer-to-peer via WebRTC.

## Features

- **🔐 Zero-Knowledge Architecture** — Your notes never touch our servers
- **🌐 Browser Access** — View and edit your vault from any device at [noterelay.io](https://noterelay.io)
- **🔒 OTP Authentication** — Secure two-factor authentication via TOTP
- **👥 Guest Sharing** — Share vaults with guests (read-only or edit permissions)
- **📱 Real-time Sync** — Changes sync instantly via WebRTC
- **🎨 Theme Support** — Your Obsidian theme travels with your vault

## Installation

1. Open Obsidian Settings → Community Plugins
2. Search for "Note Relay"
3. Install and enable the plugin

## Setup

1. **Enable Remote Access** — Toggle on in plugin settings
2. **Verify Account** — Click "Verify via Browser" to authenticate with your noterelay.io account
3. **Connect Relay** — Click "Connect" to start sharing

## Usage

Once connected, visit [noterelay.io/dashboard](https://noterelay.io/dashboard) to access your vault from any browser.

### Sharing with Guests

1. Open your vault in the dashboard
2. Click "Share" and enter a guest's email
3. Choose permission level (read-only or edit)
4. Guest receives an email invitation

## Requirements

- Obsidian v0.15.0 or later
- Desktop only (Windows, macOS, Linux)
- A [noterelay.io](https://noterelay.io) account

## Privacy & Security

- **No cloud storage** — Notes are transmitted directly peer-to-peer
- **End-to-end encryption** — All data is encrypted via WebRTC DTLS
- **Two-factor authentication** — OTP required for all connections
- **No tracking** — We don't collect or store your note content

## Support

- [Documentation](https://noterelay.io/docs)
- [FAQ](https://noterelay.io/faq)
- [GitHub Issues](https://github.com/KJ-Developers/note-relay-obsidian_plugin/issues)

## License

MIT License - See [LICENSE](LICENSE) for details.
