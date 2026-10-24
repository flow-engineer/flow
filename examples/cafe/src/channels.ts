/** The channels as the log line names them: "Telegram, WhatsApp, iMessage". */
export function channelNames(channels: Array<{ name: string }>): string {
  const label: Record<string, string> = { telegram: "Telegram", whatsapp: "WhatsApp", imessage: "iMessage" };
  return channels.map((c) => label[c.name] ?? c.name).join(", ");
}
