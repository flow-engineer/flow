// Which Flow Messaging channels the agent is on: Telegram always, WhatsApp and iMessage when .env names
// their sender (FLOW_MESSAGING_WHATSAPP_SENDER, FLOW_MESSAGING_IMESSAGE_SENDER).

import type { flowMessaging } from "../../../flow-messaging/src/index.ts";

type FlowMessaging = Pick<ReturnType<typeof flowMessaging>, "telegram" | "whatsapp" | "imessage">;

export function flowChannels(fm: FlowMessaging, env: Record<string, string | undefined> = process.env) {
  return [
    fm.telegram(),
    ...(env.FLOW_MESSAGING_WHATSAPP_SENDER ? [fm.whatsapp()] : []),
    ...(env.FLOW_MESSAGING_IMESSAGE_SENDER ? [fm.imessage()] : []),
  ];
}

/** The channels as the log line names them: "Telegram, WhatsApp, iMessage". */
export function channelNames(channels: Array<{ name: string }>): string {
  const label: Record<string, string> = { telegram: "Telegram", whatsapp: "WhatsApp", imessage: "iMessage" };
  return channels.map((c) => label[c.name] ?? c.name).join(", ");
}
