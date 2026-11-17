// Two tools run the whole form. `update_listing` takes every fact a message holds; `publish_listing`
// is the one step that cannot be undone, and runs only after a summary the person has said yes to.

import { tool, ToolError, z } from "../../../src/index.ts";
import { apply, emptyDraft, FIELDS, hashOf, missing, nextAsk, show, type Draft } from "./draft.ts";

const field = z.string().describe(`one of: ${FIELDS.map((f) => f.name).join(", ")}`);

export const tools = [
  tool({
    name: "update_listing",
    description:
      "Save every fact the person's last message holds about their listing, in their own words (\"35k\", \"a month ago\"): one call, as many fields as it covers, also ones not asked yet. Split a reply into every field it holds: \"good, 2 yrs old\" is condition \"good\" AND bought_on \"2 yrs old\", never one field. Only what they actually said: never fill a field they did not speak to, never a guess. " +
      "Returns the draft, what is missing, the ONE thing to ask next, and problems.",
    input: z.object({
      fields: z.record(field, z.string()).describe("name -> what they said, as they said it; a new value replaces the old one"),
      clear: z.array(field).optional().describe("fields to forget, when they take something back"),
    }),
    signIn: "none",
    run: async ({ fields, clear }, { records, person }) => {
      const draft = (await records.get<Draft>("drafts", person)) ?? emptyDraft();
      const applied = apply(draft, fields, clear ?? [], Date.now());
      const ask = nextAsk(draft);
      if (ask && !FIELDS.find((f) => f.name === ask.field)!.required) draft.offered.push(ask.field); // asked once, tracked here
      const confirm = missing(draft).length === 0 && !ask ? hashOf(draft) : null;
      draft.summarised = confirm;
      await records.put("drafts", person, { ...draft, person });
      return {
        draft: show(draft),
        missing: missing(draft),
        ask: ask?.ask ?? null,
        problems: applied.problems,
        unknown_fields: applied.unknown.length ? { fields: applied.unknown, note: "No such field: call update_listing again now with the closest valid name. Never tell the person." } : undefined,
        ready_for_summary: confirm !== null,
        next: confirm ? { step: "Show the whole draft as a short summary, ask if it is right, and call publish_listing with this confirm_token only after they say yes to that summary.", confirm_token: confirm } : "Not ready for a summary yet. Ask only the `ask` above, as ONE plain question with no examples and no extra questions.",
      };
    },
  }),
  tool({
    name: "publish_listing",
    description: "Publish the listing. Cannot be undone. Only after the person said yes to a summary of the draft as it is now; pass the confirm_token update_listing gave with that summary.",
    input: z.object({ confirm_token: z.string() }),
    signIn: "none",
    hints: { destructive: true, idempotent: false, openWorld: false },
    run: async ({ confirm_token }, { records, person, idempotencyKey }) => {
      const draft = await records.get<Draft & { person: string }>("drafts", person);
      if (!draft) throw new ToolError("no_draft", "There is no draft to publish.");
      if (missing(draft).length) throw new ToolError("incomplete", "The draft is not complete.", { next: "Call update_listing and ask the next thing." });
      if (!draft.summarised || draft.summarised !== hashOf(draft) || confirm_token !== draft.summarised) {
        throw new ToolError("not_confirmed", "The draft changed since the person was shown a summary, or no summary was shown.", { next: "Call update_listing with no fields to get a fresh summary, show it, and ask again." });
      }
      const id = `L-${idempotencyKey.slice(-6)}`; // the same call twice makes one listing
      await records.put("listings", id, { person, ...show(draft) });
      await records.delete("drafts", person);
      return { published: true, listing_id: id };
    },
  }),
];
