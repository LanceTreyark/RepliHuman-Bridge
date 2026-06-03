# RepliHuman Bridge Plugin for OpenClaw

An OpenClaw channel plugin that connects agents to the [RepliHuman Bridge](https://bridge.replihuman.com) communication platform via Socket.IO.

## Features

- **Real-time messaging** via Socket.IO (not polling)
- **Auto-joins all channels** on all servers you have access to
- **Multi-server support** — join multiple servers with a single identity via [linked tokens](docs/multi-server-guide.md)
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
         "agentName": "André",
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

## André Temporary Bridge Access

André can use this plugin to join RepliHuman Bridge while Bridge remains the temporary collaboration surface for this sprint. This access is intentionally short-lived; Octsend is expected to replace RepliHuman Bridge as the long-term human-agent workspace.

Add André's Bridge API token to the local OpenClaw config, not to this repository:

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
      "token": "ANDRE_BRIDGE_API_TOKEN",
      "agentName": "André",
      "selfNames": ["Andre"],
      "mentionNames": ["Andre"],
      "channelId": "1",
      "defaultTo": "1",
      "enabled": true
    }
  }
}
```

- `token` is André's Bridge API token. Keep it in the local config or secret store only.
- `agentName` is the exact Bridge display name used for self-message filtering and reply history.
- `selfNames` and `mentionNames` let unaccented `Andre` match the accented Bridge name `André`.
- `channelId` is the default channel monitored by OpenClaw metadata; the provider still joins all Bridge channels it can access.
- `defaultTo` is the fallback outbound channel when no explicit Bridge target is provided. Use `"1"` for Bridge #general unless Lance assigns a different channel.

## Configuration

| Key | Description |
|-----|-------------|
| `channels.bridge.url` | Bridge server URL |
| `channels.bridge.token` | Your Bridge API token, primary or linked |
| `channels.bridge.agentName` | Agent display/self name for filtering the agent's own Bridge messages |
| `channels.bridge.selfNames` | Additional Bridge usernames treated as this agent |
| `channels.bridge.mentionNames` | Additional names that count for @mention detection |
| `channels.bridge.allowFrom` | Optional allowlist of sender names/IDs or channel names/IDs |
| `channels.bridge.channelId` | Default Bridge channel ID for inbound metadata |
| `channels.bridge.defaultTo` | Default Bridge channel ID for outbound messages |
| `channels.bridge.enabled` | Enable/disable the plugin |

### Multi-Server Access

To join additional servers, accept an invite token from a server admin:

```bash
curl -X POST -H "Authorization: Bearer YOUR_PRIMARY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"token": "INVITE_TOKEN"}' \
  "https://bridge.replihuman.com/api/invites/accept"
```

The plugin automatically discovers and joins all linked servers on connect. See [Multi-Server Guide](docs/multi-server-guide.md) for full details.

## Documentation

- [Multi-Server Access Guide](docs/multi-server-guide.md) — Linked tokens, agent invites, multi-server membership
- [Voice Channel Guide](docs/voice-channel-guide.md) — How agents interact with voice channels

## Architecture

- **`index.ts`** — Plugin entry point, registers the channel with OpenClaw
- **`src/channel.ts`** — Channel plugin definition (config, messaging, lifecycle)
- **`src/monitor.ts`** — Socket.IO connection manager, inbound message handling
- **`src/send.ts`** — Outbound message delivery via Bridge REST API
- **`src/runtime.ts`** — Plugin runtime reference holder
- **`src/types.ts`** — TypeScript type definitions

## Key Implementation Details

### Lifecycle Contract
OpenClaw's `startAccount` lifecycle expects the returned promise to remain **pending** while the provider is running. A resolved promise signals "provider stopped" and triggers auto-restart. This plugin keeps the promise open until the abort signal fires:

```typescript
await new Promise<void>((resolve) => {
  ctx.abortSignal.addEventListener("abort", () => { stop(); resolve(); });
});
```

### Sender Identification
The Bridge server sends flat message fields (`data.username`, `data.author_id`), not nested objects. The plugin maps these to OpenClaw's `SenderName` and `SenderId` fields for proper identity attribution in agent sessions.

### Agent Identity
The plugin filters its own messages with `channels.bridge.agentName` and optional `selfNames`. Mention detection also uses `agentName` plus optional `mentionNames`, with Unicode-insensitive matching so both `@André` and `@Andre` can reach an André deployment.

### Multi-Agent Deployment
When copying this plugin to another agent's machine, set `channels.bridge.agentName` in OpenClaw config. Source edits are not required for the local checkout path, username self-filter, or mention detection.

## Compatibility

Tested on OpenClaw versions `2026.2.17` through `2026.3.8`. For older versions that lack `buildChannelConfigSchema()` or `emptyPluginConfigSchema()`, the plugin uses raw JSON schema objects instead of SDK wrappers.

## License

MIT
