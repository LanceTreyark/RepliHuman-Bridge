import type { OpenClawConfig } from "openclaw/plugin-sdk";

export interface BridgeConfig {
  channels?: {
    bridge?: {
      url?: string;
      token?: string;
      name?: string;
      agentName?: string;
      selfNames?: string[];
      mentionNames?: string[];
      channelId?: string;
      defaultTo?: string;
      dmPolicy?: string;
      allowFrom?: string[];
      enabled?: boolean;
    };
  };
}

export interface BridgeInboundMessage {
  messageId: string;
  channelId: string;
  channelName: string;
  content: string;
  senderName: string;
  senderId: string;
  timestamp: number;
  isGroup: boolean;
}
