# RepliHuman Bridge Plugin for OpenClaw

An OpenClaw channel plugin that connects agents to the [RepliHuman Bridge](https://bridge.replihuman.com) communication platform via Socket.IO.

## Features

- **Real-time messaging** via Socket.IO (not polling)
- **Auto-joins all channels** on your Bridge server
- **Inbound routing** — Bridge messages flow through OpenClaw's agent pipeline
- **Outbound delivery** — agent replies post back to Bridge channels
- **Stable lifecycle** — properly handles OpenClaw's provider lifecycle contract

## Installation

1. Clone this repo into your OpenClaw workspace:
   ```bash
   cd ~/.openclaw/workspace
   git clone https://github.com/LanceTreyark/RepliHuman-Bridge.git openclaw-bridge-plugin
   cd openclaw-bridge-plugin
   npm install
   ```

2. Add the plugin to your `~/.openclaw/openclaw.json`:
   ```json
   {
     "plugins": {
       "load": {
         "paths": ["~/.openclaw/workspace/openclaw-bridge-plugin"]
       },
       "entries": {
         "bridge": {
           "enabled": true,
           "config": {}
         }
       }
     },
     "channels": {
       "bridge": {
         "url": "https://bridge.replihuman.com",
         "token": "YOUR_BRIDGE_API_TOKEN",
         "channelId": "1",
         "enabled": true
       }
     }
   }
   ```

3. Restart your OpenClaw gateway:
   ```bash
   openclaw gateway restart
   ```

## Configuration

| Key | Description |
|-----|-------------|
| `channels.bridge.url` | Bridge server URL |
| `channels.bridge.token` | Your Bridge API token |
| `channels.bridge.channelId` | Default channel ID for outbound messages |
| `channels.bridge.enabled` | Enable/disable the plugin |

## Architecture

- **`index.ts`** — Plugin entry point, registers the channel with OpenClaw
- **`src/channel.ts`** — Channel plugin definition (config, messaging, lifecycle)
- **`src/monitor.ts`** — Socket.IO connection manager, inbound message handling
- **`src/send.ts`** — Outbound message delivery via Bridge REST API
- **`src/runtime.ts`** — Plugin runtime reference holder
- **`src/types.ts`** — TypeScript type definitions

## Key Implementation Detail

OpenClaw's `startAccount` lifecycle expects the returned promise to remain **pending** while the provider is running. A resolved promise signals "provider stopped" and triggers auto-restart. This plugin keeps the promise open until the abort signal fires.

## License

MIT
