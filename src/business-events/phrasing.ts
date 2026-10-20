// The wording check: inside WhatsApp's window the agent may phrase a business event's message
// itself, keeping every value and the button link unchanged. While such a turn runs, the channel's
// send asks this registry (`check`); a message that drops a value or changes the link is refused,
// and the template (or its text) goes instead.

import type { Outbound } from "../types.ts";

export interface PhrasingExpectation {
  values: string[];
  url: string;
  delivered: boolean;
}

const key = (address: string) => address.replace(/\D/g, "");

export function createPhrasing() {
  const open = new Map<string, PhrasingExpectation>();
  return {
    expect(address: string, values: string[], url: string): PhrasingExpectation {
      const e = { values, url, delivered: false };
      open.set(key(address), e);
      return e;
    },
    done(address: string) {
      open.delete(key(address));
    },
    /** Why this message may not go during a notification turn, or null. */
    check(address: string, outbound: Outbound): string | null {
      const e = open.get(key(address));
      if (!e || outbound.type !== "message") return null;
      if (e.delivered) return "the notification already went; send nothing more this turn";
      const lost = e.values.filter((v) => !(outbound.text ?? "").includes(v));
      if (lost.length) return `a notification keeps every value exactly (${lost.join(", ")} missing)`;
      if (outbound.link?.url !== e.url) return "a notification keeps its link exactly, in the link field";
      e.delivered = true;
      return null;
    },
  };
}

export type Phrasing = ReturnType<typeof createPhrasing>;
