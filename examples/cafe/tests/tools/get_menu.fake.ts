// get_menu in tests, played by this code when a scenario has a given: block (it runs on your machine,
// never in the cloud). Written from get_menu.yaml's behaviour: the whole menu every time, the
// scenario's own when its given: names one (menu: get_menu.yaml is the usual one), else the usual one.
import type { Fake } from "../../../../testing/src/index.ts";

const getMenu: Fake<Record<string, never>> = ({ world, responses }) => {
  const usual = responses.find((r) => r.output !== undefined)?.output;
  return { output: world.menu ?? usual };
};

export default getMenu;
