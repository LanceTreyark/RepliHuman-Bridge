import { createRequire } from "node:module";
import {
  createNormalizedOutboundDeliverer,
  formatTextWithAttachmentLinks,
  resolveOutboundMediaUrls,
} from "openclaw/plugin-sdk/reply-payload";
import {
  createReplyPrefixOptions,
} from "openclaw/plugin-sdk/channel-reply-pipeline";
import {
  recordPendingHistoryEntry,
  buildPendingHistoryContextFromMap,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import {
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import {
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { getBridgeRuntime } from "./runtime.js";
import { resolveBridgeConfig, sendBridgeMessage } from "./send.js";
import type { BridgeConfig, BridgeInboundMessage } from "./types.js";

const CHANNEL_ID = "bridge" as const;

/** In-memory chat history per channel, used to inject recent messages as context. */
const channelHistories = new Map<string, HistoryEntry[]>();
const HISTORY_LIMIT = DEFAULT_GROUP_HISTORY_LIMIT;

function formatHistoryEntry(entry: HistoryEntry): string {
  return `${entry.sender}: ${entry.body}`;
}

function normalizeIdentity(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase();
}

function matchesConfiguredIdentity(value: string, candidates: string[]): boolean {
  const normalized = normalizeIdentity(value);
  return candidates.some((candidate) => normalizeIdentity(candidate) === normalized);
}

function normalizeMentionText(value: string): string {
  return normalizeIdentity(value).replace(/\s+/g, "");
}

function wasAgentMentioned(content: string, mentionNames: string[]): boolean {
  const normalizedContent = normalizeMentionText(content);
  return mentionNames.some((name) => {
    const mention = `@${normalizeMentionText(name)}`;
    return mention.length > 1 && normalizedContent.includes(mention);
  });
}

function isAllowedInbound(message: BridgeInboundMessage, allowFrom: string[]): boolean {
  if (allowFrom.length === 0) return true;
  const allowed = allowFrom.map(normalizeIdentity);
  return [
    message.senderName,
    message.senderId,
    message.channelId,
    message.channelName,
    `#${message.channelName}`,
  ].some((value) => allowed.includes(normalizeIdentity(value)));
}

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
    const _require = createRequire(import.meta.url);
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
    // Join all channels and seed history from recent messages
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

          // Seed history from recent messages so agents have context on connect
          try {
            const histRes = await fetch(`${bridgeCfg.url}/api/channels/${ch.id}/messages?limit=${HISTORY_LIMIT}`, {
              headers: { Authorization: `Bearer ${bridgeCfg.token}` },
            });
            const msgs = await histRes.json() as any[];
            const histKey = `bridge:${ch.id}`;
            // Messages come newest-first, reverse for chronological order
            const sorted = [...msgs].reverse();
            for (const m of sorted) {
              const senderName = m.author?.username || m.username || "unknown";
              if (matchesConfiguredIdentity(senderName, bridgeCfg.selfNames)) continue;
              recordPendingHistoryEntry({
                historyMap: channelHistories,
                historyKey: histKey,
                entry: {
                  sender: senderName,
                  body: m.content || "",
                  timestamp: m.createdAt ? new Date(m.createdAt).getTime() : undefined,
                  messageId: String(m.id),
                },
                limit: HISTORY_LIMIT,
              });
            }
            logger.info?.(`Seeded ${sorted.length} history entries for #${ch.name}`);
          } catch (histErr) {
            logger.warn?.(`Failed to seed history for #${ch.name}: ${String(histErr)}`);
          }
        }
      }
    } catch (err) {
      logger.error?.(`Failed to join Bridge channels: ${String(err)}`);
    }
  });

  socket.on("disconnect", (reason: string) => {
    logger.warn?.(`Bridge Socket.IO disconnected: ${reason}`);
  });

  socket.onAny((event: string, ...args: any[]) => {
    logger.info?.(`Bridge socket event: ${event}`);
  });

  socket.on("new_message", async (data: any) => {
    try {
      logger.info?.(`Bridge new_message: user=${data.username} type=${data.account_type} content=${(data.content || '').slice(0, 80)}`);
      // Skip our own messages (bot/agent accounts with our configured name).
      if (data.account_type !== "human" && matchesConfiguredIdentity(data.username || "", bridgeCfg.selfNames)) return;

      const message: BridgeInboundMessage = {
        messageId: String(data.id || Date.now()),
        channelId: String(data.channel_id || "1"),
        channelName: data.channel_name || `channel-${data.channel_id}`,
        content: data.content || "",
        senderName: data.username || "unknown",
        senderId: String(data.author_id || "0"),
        timestamp: data.created_at ? new Date(data.created_at).getTime() : Date.now(),
        isGroup: true,
      };

      if (!isAllowedInbound(message, bridgeCfg.allowFrom)) {
        logger.info?.(`Bridge inbound skipped by allowFrom: user=${message.senderName} channel=${message.channelId}`);
        return;
      }

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
  const logger = core.logging.getChildLogger({ channel: "bridge" });
  logger.info?.(`handleBridgeInbound: from=${message.senderName} in ch=${message.channelId} content=${message.content.slice(0,60)}`);

  // All Bridge channels share one session context so the agent maintains
  // continuity across channels.  The outbound reply still targets the
  // originating channel via message.channelId.
  const peerId = `bridge:unified`;

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

  // Build chat history context from recent messages in this channel
  const historyKey = `bridge:${message.channelId}`;
  const historyContext = buildPendingHistoryContextFromMap({
    historyMap: channelHistories,
    historyKey,
    limit: HISTORY_LIMIT,
    currentMessage: message.content,
    formatEntry: formatHistoryEntry,
  });

  // Record this message into history for future context
  recordPendingHistoryEntry({
    historyMap: channelHistories,
    historyKey,
    entry: {
      sender: message.senderName,
      body: message.content,
      timestamp: message.timestamp,
      messageId: message.messageId,
    },
    limit: HISTORY_LIMIT,
  });

  const bodyWithHistory = historyContext
    ? `${historyContext}\n\n${message.content}`
    : message.content;

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Bridge",
    from: `${message.senderName} in #${message.channelName}`,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyWithHistory,
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
    WasMentioned: wasAgentMentioned(message.content, resolveBridgeConfig(config).mentionNames),
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
    // Record our own reply in history so it appears as context for other agents
    recordPendingHistoryEntry({
      historyMap: channelHistories,
      historyKey: `bridge:${message.channelId}`,
      entry: {
        sender: resolveBridgeConfig(config).agentName,
        body: text,
        timestamp: Date.now(),
      },
      limit: HISTORY_LIMIT,
    });
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
