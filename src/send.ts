import { getBridgeRuntime } from "./runtime.js";
import type { BridgeConfig } from "./types.js";

const BRIDGE_URL = "https://bridge.replihuman.com";
const DEFAULT_AGENT_NAME = "Viktor";

function normalizeConfiguredName(value?: string): string | undefined {
  const normalized = value?.normalize("NFC").trim();
  return normalized || undefined;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of values) {
    const name = normalizeConfiguredName(value);
    if (!name) continue;
    const key = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function resolveBridgeConfig(cfg: BridgeConfig) {
  const bridge = cfg.channels?.bridge;
  const agentName = normalizeConfiguredName(bridge?.agentName || bridge?.name) || DEFAULT_AGENT_NAME;
  return {
    url: bridge?.url || BRIDGE_URL,
    token: bridge?.token || "",
    agentName,
    selfNames: uniqueNonEmpty([agentName, ...(bridge?.selfNames || [])]),
    mentionNames: uniqueNonEmpty([agentName, ...(bridge?.mentionNames || []), ...(bridge?.selfNames || [])]),
    channelId: bridge?.channelId || "1",
    defaultTo: bridge?.defaultTo,
    dmPolicy: bridge?.dmPolicy || "open",
    allowFrom: uniqueNonEmpty(bridge?.allowFrom || []),
    enabled: bridge?.enabled !== false,
    configured: Boolean(bridge?.token),
  };
}

export async function sendBridgeMessage(
  channelId: string,
  text: string,
  opts?: { token?: string; url?: string },
): Promise<{ messageId: string }> {
  const core = getBridgeRuntime();
  const cfg = resolveBridgeConfig(core.config.loadConfig() as BridgeConfig);
  const token = opts?.token || cfg.token;
  const url = opts?.url || cfg.url;
  const resolvedChannelId = String(channelId || cfg.defaultTo || cfg.channelId || "1").trim();

  if (!token) {
    throw new Error("Bridge token not configured (channels.bridge.token)");
  }
  if (!/^\d+$/.test(resolvedChannelId)) {
    throw new Error(`Invalid Bridge channel target: ${channelId || "(empty)"}`);
  }

  const response = await fetch(`${url}/api/channels/${resolvedChannelId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ content: text }),
  });

  if (!response.ok) {
    throw new Error(`Bridge API error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  return { messageId: result?.id?.toString() || `${resolvedChannelId}:${Date.now()}` };
}
