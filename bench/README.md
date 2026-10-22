# Load test

`bench/load.ts` runs N simulated conversations at once on one process and reports what each turn
costs. It is never part of `npm test`, `test:changed` or any check: run it when you want the numbers.

```sh
npm run bench:load                                   # 50 conversations × 5 turns
npm run bench:load -- --conversations 200 --turns 10 # more load
npm run bench:load -- --model-ms 300                 # a model that takes 300 ms a call
npm run bench:load -- --json                         # one JSON line, to compare runs
```

## What it does

- One agent, made with `createAgent` and its default store (SQLite in memory), `debounceMs: 0`.
- Each conversation is one person on one of the simulators' platforms (`PLATFORMS` from
  `simulators/`: SMS, WhatsApp, iMessage, Telegram, web, in turn), so each turn meets that platform's
  rules. The person writes T messages, each once the agent has finished the turn before it; all N
  people write at the same time.
- The model is a fake: it answers at once (or after `--model-ms`), with no spend and no network.
  Every other message asks about an order, so that turn calls a tool (`lookup_order`) before it
  replies; the others reply straight away. A run where any turn delivered no reply exits 1.
- One conversation runs first to warm up (compiling, the store's tables); the numbers are measured
  after it.

## Reading the numbers

```
50 conversations × 5 turns (fake model, 0 ms a call), 250/250 replies delivered, 0.2s
throughput     1244.6 turns/s
CPU per turn   1.271 ms (user + system, the whole process)
turn time      p50 36.7 ms   p95 54.3 ms   max 60.2 ms
memory         65 KB heap, 1889 KB RSS per conversation (heap 22.1 MB, RSS 215.9 MB after)
```

- **CPU per turn** is the process's CPU time (user + system, `process.cpuUsage`) during the run,
  divided by the turns: Flow Framework's own work for a turn (building the request, history, the
  store, delivery), plus the fake model and garbage collection. With a real model, add the
  provider client's time to parse its answer. `1000 / CPU per turn` is about the most turns a
  second one core can take.
- **Throughput** is turns finished per second of wall time. With `--model-ms 0` it is limited by
  CPU alone; with a model delay it is limited by how many conversations are in flight.
- **Turn time** runs from the person's message to the turn being over and stored (`whenIdle`),
  so it includes the follow-up step Flow Framework takes after a reply. With `--model-ms 0` all N
  turns share one thread, so turn time grows with N (about N × CPU per turn); with a model delay it
  is mostly the model's calls (two a plain turn, three a turn with a tool).
- **Memory per conversation** is the growth after the run, with garbage collected
  (`--expose-gc`, which the npm script passes), divided by N. The conversations stay loaded, so
  this is what one more open conversation costs with T turns of history. Heap is the number to
  read; RSS includes memory the process keeps but no longer uses, and is noisy for small N.

Keep runs short (under 2 minutes) and do not run a large one while a full test suite runs on the
same machine: both numbers and the suite suffer.
