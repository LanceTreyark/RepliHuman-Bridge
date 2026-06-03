import {
  buildBaseChannelStatusSummary,
  buildComputedAccountStatusSnapshot,
} from "openclaw/plugin-sdk/channel-status";
import {
  buildJsonChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/core";
import { resolveBridgeConfig, sendBridgeMessage } from "./send.js";
import { monitorBridgeProvider } from "./monitor.js";
import { getBridgeRuntime } from "./runtime.js";
import type { BridgeConfig } from "./types.js";

const meta = {
  id: "bridge" as const,
  label: "Bridge",
  selectionLabel: "RepliHuman Bridge",
  detailLabel: "Bridge",
  docsPath: "/channels/bridge",
  docsLabel: "bridge",
  blurb: "RepliHuman Bridge communication platform",
  systemImage: "network",
};

type ResolvedBridgeAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  url: string;
  token: string;
  channelId: string;
};

export const bridgePlugin: ChannelPlugin<ResolvedBridgeAccount, any> = {
  id: "bridge",
  meta: {
    ...meta,
  },
  capabilities: {
    chatTypes: ["group"],
    media: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.bridge"] },
  configSchema: buildJsonChannelConfigSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string" },
      token: { type: "string" },
      name: { type: "string" },
      agentName: { type: "string" },
      selfNames: { type: "array", items: { type: "string" } },
      mentionNames: { type: "array", items: { type: "string" } },
      channelId: { type: "string" },
      defaultTo: { type: "string" },
      dmPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
      allowFrom: { type: "array", items: { type: "string" } },
      enabled: { type: "boolean" },
    },
  }),
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => {
      const bridgeCfg = resolveBridgeConfig(cfg as BridgeConfig);
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: bridgeCfg.enabled,
        configured: bridgeCfg.configured,
        url: bridgeCfg.url,
        token: bridgeCfg.token,
        channelId: bridgeCfg.channelId,
      };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: () => true,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      url: account.url,
    }),
  },
  messaging: {
    normalizeTarget: (input: string) => input?.trim() || undefined,
    targetResolver: {
      looksLikeId: (input: string) => /^\d+$/.test(input?.trim() || ""),
      hint: "<channelId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getBridgeRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 2000,
    sendText: async ({ to, text }) => {
      const result = await sendBridgeMessage(to, text);
      return { channel: "bridge", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl }) => {
      const combined = mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text;
      const result = await sendBridgeMessage(to, combined);
      return { channel: "bridge", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ account, snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      url: account.url,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...buildComputedAccountStatusSnapshot({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        runtime,
      }),
      url: account.url,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account as ResolvedBridgeAccount;
      if (!account.configured) {
        throw new Error("Bridge is not configured (need token in channels.bridge.token)");
      }
      ctx.log?.info?.(`Starting Bridge provider (${account.url})`);
      ctx.setStatus({ accountId: ctx.accountId, running: true, lastStartAt: Date.now(), lastStopAt: null, lastError: null });
      if (ctx.abortSignal?.aborted) {
        throw new Error("Bridge: abort signal already aborted before start");
      }
      const { stop } = await monitorBridgeProvider({
        config: ctx.cfg as BridgeConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
      // Keep alive until abort signal
      await new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => {
          stop();
          resolve();
        });
      });
      return { stop };
    },
  },
};
