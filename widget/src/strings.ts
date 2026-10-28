// The chat box's own words, in English and Hindi. The agent's replies are in the visitor's language already.

const en = {
  close: "Close chat",
  send: "Send",
  message: "Message",
  placeholder: "Type a message",
  typing: "Typing…",
  sending: "Sending…",
  failed: "Not sent.",
  retry: "Try again",
  too_large: "That message is too long.",
  rate_limited: "Too many messages. Try again in a while.",
  you: "You",
  photo: "Photo",
  reacted: "Reacted",
  back: "Back",
  opens: "(opens in a new tab)",
};

export type Words = typeof en;

export const WORDS: Record<"en" | "hi", Words> = {
  en,
  hi: {
    close: "चैट बंद करें",
    send: "भेजें",
    message: "संदेश",
    placeholder: "संदेश लिखें",
    typing: "लिख रहे हैं…",
    sending: "भेजा जा रहा है…",
    failed: "नहीं भेजा गया।",
    retry: "फिर से भेजें",
    too_large: "यह संदेश बहुत लंबा है।",
    rate_limited: "बहुत सारे संदेश। थोड़ी देर बाद फिर कोशिश करें।",
    you: "आप",
    photo: "फ़ोटो",
    reacted: "प्रतिक्रिया",
    back: "वापस",
    opens: "(नए टैब में खुलता है)",
  },
};
