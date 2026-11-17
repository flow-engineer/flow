// `npm start`: the agent in the playground.
import { choosePort, markRunning } from "../../../src/index.ts";
import { simulators } from "../../../simulators/src/index.ts";
import { buildAgent } from "./agent.ts";

const play = simulators({ title: "Lena" });
const agent = buildAgent({ events: [play.events] });
const { port } = await choosePort("PORT", 8788, { command: "npm start" });
const { url } = await play.listen(agent, port);
markRunning(url);
console.log(`Lena's playground: ${url}/`);
