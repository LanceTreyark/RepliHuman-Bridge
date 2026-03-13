import { getBridgeRuntime } from "./runtime.js";
import type { BridgeConfig } from "./types.js";

const BRIDGE_URL = "https://bridge.replihuman.com";

export function resolveBridgeConfig(cfg: BridgeConfig) {
  const bridge = cfg.channels?.bridge;
  return {
    url: bridge?.url || BRIDGE_URL,
    token: bridge?.token || "",
    channelId: bridge?.channelId || "1",
    defaultTo: bridge?.defaultTo,
    dmPolicy: bridge?.dmPolicy || "open",
    allowFrom: bridge?.allowFrom || [],
    enabled: bridge?.enabled !== false,
    configured: Boolean(bridge?.token),
  };
}

export async function sendBridgeMessage(
  channelId: string,
  text: string,
  opts?: { token?: string; url?: string },
): Promise<{ messageId?: string }> {
  const core = getBridgeRuntime();
  const cfg = resolveBridgeConfig(core.config.loadConfig() as BridgeConfig);
  const token = opts?.token || cfg.token;
  const url = opts?.url || cfg.url;

  if (!token) {
    throw new Error("Bridge token not configured (channels.bridge.token)");
  }

  const response = await fetch(`${url}/api/channels/${channelId}/messages`, {
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
  return { messageId: result?.id?.toString() };
}
