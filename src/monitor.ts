import { createRequire } from "node:module";
import {
  createNormalizedOutboundDeliverer,
  createReplyPrefixOptions,
  formatTextWithAttachmentLinks,
  resolveOutboundMediaUrls,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { getBridgeRuntime } from "./runtime.js";
import { resolveBridgeConfig, sendBridgeMessage } from "./send.js";
import type { BridgeConfig, BridgeInboundMessage } from "./types.js";

const CHANNEL_ID = "bridge" as const;

export type BridgeMonitorOptions = {
  config?: BridgeConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export async function monitorBridgeProvider(
  opts: BridgeMonitorOptions,
): Promise<{ stop: () => void }> {
  const core = getBridgeRuntime();
  const logger = core.logging.getChildLogger({ channel: "bridge" });
  try {
    logger.info?.("Bridge monitor starting...");
    const cfg = opts.config ?? (core.config.loadConfig() as BridgeConfig);
    const bridgeCfg = resolveBridgeConfig(cfg);
    logger.info?.(`Bridge config: url=${bridgeCfg.url} configured=${bridgeCfg.configured} token=${bridgeCfg.token ? 'set' : 'missing'}`);

    if (!bridgeCfg.configured) {
      throw new Error("Bridge is not configured (need token in channels.bridge.token)");
    }

    // Load socket.io-client  
    logger.info?.("Loading socket.io-client...");
    const _require = createRequire("/home/viktor/.openclaw/workspace/openclaw-bridge-plugin/src/monitor.ts");
    const { io } = _require("socket.io-client") as any;
    logger.info?.("socket.io-client loaded successfully");

    logger.info?.("Creating socket connection...");
    const socket = io(bridgeCfg.url, {
      auth: { apiKey: bridgeCfg.token },
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 5000,
      autoConnect: false,  // Don't connect yet
    });
    logger.info?.("Socket created, registering handlers...");

  // Register handlers before connecting
  const abortHandler = () => {
    socket.disconnect();
  };
  opts.abortSignal?.addEventListener("abort", abortHandler);

  socket.on("connect", async () => {
    logger.info?.("Bridge Socket.IO connected");
    // Join all channels
    try {
      const serversRes = await fetch(`${bridgeCfg.url}/api/servers`, {
        headers: { Authorization: `Bearer ${bridgeCfg.token}` },
      });
      const servers = await serversRes.json() as any[];
      for (const server of servers) {
        const chRes = await fetch(`${bridgeCfg.url}/api/servers/${server.id}/channels`, {
          headers: { Authorization: `Bearer ${bridgeCfg.token}` },
        });
        const channels = await chRes.json() as any[];
        for (const ch of channels) {
          socket.emit("join_channel", { channelId: ch.id });
          logger.info?.(`Joined Bridge channel #${ch.name} (${ch.id})`);
        }
      }
    } catch (err) {
      logger.error?.(`Failed to join Bridge channels: ${String(err)}`);
    }
  });

  socket.on("disconnect", (reason: string) => {
    logger.warn?.(`Bridge Socket.IO disconnected: ${reason}`);
  });

  socket.on("new_message", async (data: any) => {
    try {
      // Skip our own messages
      if (data.author?.is_bot) return;

      const message: BridgeInboundMessage = {
        messageId: String(data.id || Date.now()),
        channelId: String(data.channel_id || "1"),
        channelName: data.channel_name || `channel-${data.channel_id}`,
        content: data.content || "",
        senderName: data.author?.display_name || data.author?.username || "unknown",
        senderId: String(data.author?.id || "0"),
        timestamp: data.created_at ? new Date(data.created_at).getTime() : Date.now(),
        isGroup: true, // Bridge channels are always group-like
      };

      opts.statusSink?.({ lastInboundAt: Date.now() });
      await handleBridgeInbound({ message, config: cfg, runtime: opts.runtime, statusSink: opts.statusSink });
    } catch (err) {
      logger.error?.(`Bridge inbound error: ${String(err)}`);
    }
  });

  // Now connect and wait for initial connection
  logger.info?.("Connecting to Bridge...");
  socket.connect();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Bridge Socket.IO connection timeout (10s)"));
    }, 10000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      logger.info?.("Bridge initial connection established");
      resolve();
    });
    socket.once("connect_error", (err: any) => {
      if (!socket.connected) {
        clearTimeout(timeout);
        logger.error?.(`Bridge connect_error: ${err.message || err}`);
        reject(new Error(`Bridge Socket.IO connect error: ${err.message || err}`));
      }
    });
  });
  
  logger.info?.("Bridge provider running, returning stop handle");

  return {
    stop: () => {
      opts.abortSignal?.removeEventListener("abort", abortHandler);
      socket.disconnect();
    },
  };
  } catch (err) {
    logger.error?.(`Bridge monitor failed: ${String(err)}`);
    throw err;
  }
}

async function handleBridgeInbound(params: {
  message: BridgeInboundMessage;
  config: BridgeConfig;
  runtime?: RuntimeEnv;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  const core = getBridgeRuntime();
  const { message, config, statusSink } = params;

  const peerId = `bridge:channel:${message.channelId}`;

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: "default",
    peer: {
      kind: "group",
      id: peerId,
    },
  });

  const storePath = core.channel.session.resolveStorePath(
    (config as any).session?.store,
    { agentId: route.agentId },
  );

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(
    config as OpenClawConfig,
  );
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Bridge",
    from: `${message.senderName} in #${message.channelName}`,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: message.content,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: message.content,
    CommandBody: message.content,
    From: peerId,
    To: `bridge:${message.channelId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "group",
    ConversationLabel: `#${message.channelName}`,
    SenderName: message.senderName,
    SenderId: message.senderId,
    GroupSubject: `#${message.channelName}`,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: message.content.toLowerCase().includes("@viktor"),
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `bridge:${message.channelId}`,
    CommandAuthorized: true,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      core.logging.getChildLogger().error?.(`bridge: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: "default",
  });

  const deliverReply = createNormalizedOutboundDeliverer(async (payload) => {
    const text = formatTextWithAttachmentLinks(
      payload.text,
      resolveOutboundMediaUrls(payload),
    );
    if (!text) return;
    await sendBridgeMessage(message.channelId, text);
    statusSink?.({ lastOutboundAt: Date.now() });
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config as OpenClawConfig,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: deliverReply,
      onError: (err, info) => {
        core.logging.getChildLogger().error?.(`bridge ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}
