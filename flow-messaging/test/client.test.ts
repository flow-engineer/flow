// covers: flow-messaging/src/client.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, FlowMessagingError, idSegment } from "../src/client.ts";
import { fakeFlow } from "./fake.ts";

test("a file id from an event must look like Flow's before the key is sent to it", async (t) => {
  const flow = await fakeFlow();
  t.after(() => flow.close());
  flow.files.file_01JB8ZE5N7Q9S1V3X5Z7B9D1E3 = Buffer.from([1, 2, 3]);
  const client = new Client({ apiKey: "fk_test_key", baseUrl: flow.url });

  for (const bad of ["../v1/apps", "a/b", "file_1/../../v1/apps", "file_1?x=1", "file_", "msg_1", "", "file_1%2F..", "file_1#x"]) {
    await assert.rejects(client.download(bad), /not a Flow Messaging file_ id/, bad);
  }
  assert.equal(flow.requests.length, 0, "nothing was sent for a refused id");

  assert.deepEqual([...(await client.download("file_01JB8ZE5N7Q9S1V3X5Z7B9D1E3"))], [1, 2, 3]);
  assert.equal(flow.requests[0]!.path, "/v0/files/file_01JB8ZE5N7Q9S1V3X5Z7B9D1E3");
  assert.equal(flow.requests[0]!.headers.authorization, "Bearer fk_test_key");
});

test("ids used in other request paths are checked the same way", () => {
  assert.equal(idSegment("msg", "msg_01JB8ZE5N7Q9S1V3X5Z7B9D1E3"), "msg_01JB8ZE5N7Q9S1V3X5Z7B9D1E3");
  assert.equal(idSegment("conv", "conv_wa"), "conv_wa");
  for (const [prefix, bad] of [["ct", "ct_a/../../v1/apps"], ["conv", "../conv_x"], ["msg", "msg_1 "], ["snd", "snd_1&status=all"], ["ct", 42]] as const) {
    assert.throws(() => idSegment(prefix, bad), /not a Flow Messaging/, String(bad));
  }
});

test("a refusal keeps Flow's hint and doc_url for the developer; empty ones are none", async (t) => {
  const flow = await fakeFlow();
  t.after(() => flow.close());
  const client = new Client({ apiKey: "fk_live_key", baseUrl: flow.url });
  const hint = "Choose a plan at https://flow.engineer/dashboard/plans?plan=shared; this key works again once the plan is active.";
  flow.queued.push({ match: () => true, status: 403, body: { error: { type: "permission", channel_code: "plan_ended", message: "The plan ended.", hint, doc_url: "https://api.flow.engineer/docs/errors/permission" } } });
  const refused = await client.post("/v0/messages", {}, 1).then(() => assert.fail("refused"), (error: FlowMessagingError) => error);
  assert.ok(refused instanceof FlowMessagingError);
  assert.deepEqual([refused.type, refused.channelCode, refused.hint, refused.docUrl], ["permission", "plan_ended", hint, "https://api.flow.engineer/docs/errors/permission"]);

  const none = await client.get("/v0/contacts/ct_x").then(() => assert.fail("not found"), (error: FlowMessagingError) => error);
  assert.deepEqual([none.type, none.hint, none.docUrl], ["not_found", undefined, undefined]);
});
