import {
  emptyPluginConfigSchema,
  type ChannelPlugin,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import { bridgePlugin } from "./src/channel.js";
import { setBridgeRuntime } from "./src/runtime.js";

const plugin = {
  id: "bridge",
  name: "RepliHuman Bridge",
  description: "Channel plugin for RepliHuman Bridge",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setBridgeRuntime(api.runtime);
    api.registerChannel({ plugin: bridgePlugin as ChannelPlugin });
  },
};

export default plugin;
