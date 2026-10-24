// The agent in the playground: `npm start`, then open the printed link and pick a test person. With
// FLOW_MESSAGING_KEY in .env (`npx @flow-engineer/flow link` puts it there), it is on Telegram
// too (and WhatsApp and iMessage when .env names their senders), through Flow Messaging's event
// stream: an outbound connection, so no public URL or tunnel. It listens on PORT, else 8788 or the
// next free port above it.

import { choosePort, markRunning } from "../../../src/index.ts";
import { flowMessaging } from "../../../flow-messaging/src/index.ts";
import { simulators } from "../../../simulators/src/index.ts";
import { buildAgent } from "./agent.ts";
import { channelNames } from "./channels.ts";
import { displayName } from "./name.ts";

const play = simulators({ title: displayName });
const fm = process.env.FLOW_MESSAGING_KEY ? flowMessaging() : undefined;
// Telegram, plus WhatsApp and iMessage when .env names their senders.
const channels = fm ? fm.channels() : [];
let agent: ReturnType<typeof buildAgent>;
try {
  agent = buildAgent({ events: [play.events], channels });
} catch (error) {
  console.error((error as Error).message); // such as no model key in .env
  process.exit(1);
}
let url: string;
try {
  const { port, note } = await choosePort("PORT", 8788, { command: "npm start" });
  if (note) console.log(note);
  ({ url } = await play.listen(agent, port));
} catch (error) {
  console.error((error as Error).message); // such as the port PORT names being in use
  process.exit(1);
}
const port = Number(new URL(url).port);
// `npx @flow-engineer/flow link` reads it (.flow/running.json) to say whether to start or restart this.
markRunning(url);
console.log(`${displayName}'s playground: ${url}/`);
console.log(`Every channel side by side: ${url}/person`);
if (fm) {
  // Events sent while it was not running come when it starts again (.flow/ keeps the last one handled).
  const live = fm.start(agent, { cursorFile: ".flow/flow-messaging-cursor", port: port + 1 });
  console.log(`On ${channelNames(channels)} through Flow Messaging (${live.mode}). The phone link: npx @flow-engineer/flow link`);
  live.stopped.then((why) => console.error(`Flow Messaging stopped: ${why.message} Then: npx @flow-engineer/flow setup`));
}
