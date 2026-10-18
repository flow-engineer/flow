// Pip in the playground: `npm start`, then open the printed link and pick a test person. With
// FLOW_MESSAGING_KEY in .env (`npx @flow-engineer/flow link` puts it there), Pip is on Telegram
// too, through Flow Messaging's event stream: an outbound connection, so no public URL or tunnel.

import { flowMessaging } from "../../../flow-messaging/src/index.ts";
import { simulators } from "../../../simulators/src/index.ts";
import { buildAgent } from "./agent.ts";

const play = simulators({ title: "Pip · Bean & Leaf" });
const fm = process.env.FLOW_MESSAGING_KEY ? flowMessaging() : undefined;
let agent: ReturnType<typeof buildAgent>;
try {
  agent = buildAgent({ events: [play.events], channels: fm ? [fm.telegram()] : [] });
} catch (error) {
  console.error((error as Error).message); // such as no model key in .env
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8788);
const { url } = await play.listen(agent, port);
console.log(`Pip's playground: ${url}/`);
console.log(`Every channel side by side: ${url}/person`);
if (fm) {
  // Events sent while Pip was not running come when it starts again (.flow/ keeps the last one handled).
  const live = fm.start(agent, { cursorFile: ".flow/flow-messaging-cursor", port: port + 1 });
  console.log(`On Telegram through Flow Messaging (${live.mode}). The phone link: npx @flow-engineer/flow link`);
  live.stopped.then((why) => console.error(`Flow Messaging stopped: ${why.message} Then: npx @flow-engineer/flow setup`));
}
