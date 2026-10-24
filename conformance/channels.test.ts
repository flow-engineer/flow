// covers: src/channels.ts src/conversation.ts flow-messaging/src/index.ts flow-messaging/src/client.ts
// Every channel adapter Flow Framework ships, through the delivery guarantees (checks.ts): the
// built-in whatsapp(), sms() and customUI() over a provider that waits for the check, and each of
// Flow Messaging's channels with its signal coming by webhook, by the stream, and by reading back.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { customUI, sms, whatsapp, type Channel, type Message } from "../src/index.ts";
import { flowMessaging } from "../flow-messaging/src/index.ts";
import { fakeFlow, sign, SECRET, type Recorded } from "../flow-messaging/test/fake.ts";
import { conformance, type Arrival, type Rig } from "./checks.ts";

/** A provider whose every message waits for the check: the rig the built-in channels run on. */
function heldProvider() {
  const arrivals: Arrival[] = [];
  const waiters: Array<() => void> = [];
  const take = (message: Pick<Message, "text" | "idempotencyKey">) =>
    new Promise<void>((resolve, reject) => {
      arrivals.push({ text: message.text, idempotencyKey: message.idempotencyKey, accept: () => resolve(), refuse: (reason) => reject(new Error(reason)) });
      waiters.splice(0).forEach((w) => w());
    });
  async function arrival(n: number): Promise<Arrival> {
    while (arrivals.length <= n) await new Promise<void>((resolve) => waiters.push(resolve));
    return arrivals[n]!;
  }
  return { take, arrival, count: () => arrivals.length };
}

function builtIn(make: (take: ReturnType<typeof heldProvider>["take"]) => Channel, to: string): () => Promise<Rig> {
  return async () => {
    const held = heldProvider();
    return { channel: make(held.take), to, arrival: held.arrival, count: held.count, close: () => {} };
  };
}

conformance("whatsapp()", builtIn((take) => whatsapp({ sendMessage: (_to, m) => take(m), typing: async () => {}, markRead: async () => {} }), "+15550100199"));
conformance("sms()", builtIn((take) => sms({ sendMessage: (_to, m) => take(m) }), "+15550100199"));
conformance("customUI()", builtIn((take) => customUI("app", { sendMessage: (_to, m) => take(m) }), "user-1"));

type Kind = "whatsapp" | "sms" | "telegram" | "imessage";
type Signal = "webhook" | "stream" | "read back";
const ADDRESS: Record<Kind, string> = { whatsapp: "+15550100199", sms: "+15550100199", telegram: "777000", imessage: "+15550100199" };

/** A Flow Messaging channel against the fake Flow: every send is answered 202 queued, and its status comes as `signal` says. */
function flowRig(kind: Kind, signal: Signal): () => Promise<Rig> {
  return async () => {
    const flow = await fakeFlow();
    const sender = `snd_${kind}`;
    const stub = { message: async () => null, reacted: async () => {}, undelivered: () => {} } as never;
    const fm = flowMessaging({ apiKey: "fk_test_key", webhookSecret: SECRET, baseUrl: flow.url, waitTimeoutMs: 20_000 });
    const channel = fm[kind]({ sender });
    const isSend = (r: Recorded) => r.method === "POST" && (r.path === "/v0/messages" || /^\/v0\/conversations\/[^/]+\/(basic|buttons|list|carousel|template)$/.test(r.path));
    for (let i = 1; i <= 20; i++) flow.queued.push({ match: isSend, status: 202, body: { id: `msg_c${i}`, conversation: "conv_c", direction: "out", status: "queued", content: { kind: "basic", text: "" } } });

    // The person wrote first, so every send goes into their conversation: V0 starts one only with a basic message or a template.
    flow.contacts.ct_c = { id: "ct_c", address: kind === "telegram" ? { telegram_user_id: ADDRESS[kind] } : { phone: ADDRESS[kind] } };
    const hello = JSON.stringify({ id: "evt_c0", type: "message.received", created_at: new Date().toISOString(), app: "app_test", livemode: false, conversation: { id: "conv_c", type: "direct", channel: kind, sender, contact: "ct_c" }, data: { message: { id: "msg_in", conversation: "conv_c", direction: "in", status: "received", content: { kind: "basic", text: "hi" } } } });
    await fm.receive(stub, { body: hello, headers: { "flow-signature": sign(hello) } });

    let hook: ReturnType<typeof createServer> | undefined;
    let post: (body: object) => Promise<void> = async () => {};
    let stream: ReturnType<typeof fm.stream> | undefined;
    if (signal === "webhook") {
      const server = createServer(fm.webhook(stub));
      hook = server;
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      post = async (event) => {
        const body = JSON.stringify(event);
        const answer = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "flow-signature": sign(body) }, body });
        if (answer.status !== 200) throw new Error(`the webhook answered ${answer.status}`);
      };
    } else if (signal === "stream") {
      stream = fm.stream(stub);
      const socket = await flow.stream(0);
      post = async (event) => socket.send({ type: "event", event });
    }

    let events = 0;
    const status = async (id: string, type: "sent" | "failed", reason?: string) => {
      const message = { id, conversation: "conv_c", direction: "out", status: type, content: { kind: "basic", text: "" }, ...(reason ? { error: { type: "channel_error", message: reason } } : {}) };
      if (signal === "read back") return void (flow.messages[id] = message);
      const now = new Date().toISOString();
      await post({ id: `evt_c${++events}`, type: `message.${type}`, created_at: now, app: "app_test", livemode: false, conversation: { id: "conv_c", channel: kind, sender, contact: "ct_c" }, data: { message } });
    };
    const sends = () => flow.requests.filter(isSend);
    async function arrival(n: number): Promise<Arrival> {
      await flow.request(() => sends().length > n);
      const r = sends()[n]!;
      const id = `msg_c${n + 1}`;
      // V0 takes a kind's fields at the top of the body: a basic message's text is also a photo's caption.
      const key = r.headers["idempotency-key"];
      return { text: (r.body as { text?: string }).text ?? "", idempotencyKey: typeof key === "string" ? key : undefined, accept: () => status(id, "sent"), refuse: (reason) => status(id, "failed", reason) };
    }
    return {
      channel,
      to: ADDRESS[kind],
      arrival,
      count: () => sends().length,
      ...(kind === "telegram" ? { carouselParts: (carousel: { cards: unknown[] }) => 1 + carousel.cards.length } : {}),
      close: async () => {
        await stream?.close();
        hook?.close();
        flow.close();
      },
    };
  };
}

for (const kind of ["whatsapp", "sms", "telegram", "imessage"] as const) {
  for (const signal of ["webhook", "stream", "read back"] as const) conformance(`flowMessaging().${kind}() (${signal})`, flowRig(kind, signal));
}
