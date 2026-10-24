// covers: flow-messaging/src/client.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, idSegment } from "../src/client.ts";
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
