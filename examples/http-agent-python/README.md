# The café's agent in Python

Pip, the café's ordering assistant from [`../cafe`](../cafe), as a Python server with no
dependencies (Python 3.11+, standard library only). It implements Flow Framework's agent endpoint
([`spec/agent-endpoint.openapi.yaml`](../../spec/agent-endpoint.openapi.yaml)) so `flow test` can
talk to it: one POST per message from the person, answered with the replies to send. It reads the
café's instructions from `../cafe/agent/AGENTS.md`, runs the café's `get_menu` and `place_order`
tools itself, and calls any OpenAI-compatible model. Its `show_menu` tool shows the menu as a `records`
reply ([docs/records.md](../../docs/records.md)): rows made by its own code, laid out by Flow Framework for the person's platform.

## Run it

```bash
FAKE_MODEL=1 python3 server.py    # no key: every answer is one fixed reply
python3 server.py                 # with a model key set (below)
```

It listens on `http://localhost:3000/flow` (`PORT` to change it). The first key that is set
picks the model; `MODEL` overrides its model id:

| Key | Default model |
| --- | --- |
| `OPENROUTER_API_KEY` | `anthropic/claude-haiku-5.5` |
| `OPENAI_API_KEY` | `gpt-6-luna` |
| `ANTHROPIC_API_KEY` | `claude-haiku-5-5` |
| `GEMINI_API_KEY` | `gemini-3.8-flash` |

Set `FLOW_FRAMEWORK_AGENT_TOKEN` here and where `flow test` runs to require it.

## Check it

In another terminal, against the contract, with no cloud, key or model call on Flow Framework's side:

```bash
npx @flow-engineer/flow check-endpoint http://localhost:3000/flow
node ../../testing/src/cli.ts check-endpoint http://localhost:3000/flow            # from a clone
```

## Test it

From this folder:

```bash
npx @flow-engineer/flow test --agent-url http://localhost:3000/flow --synthetic
```

A hosted test cloud needs its key in `FLOW_FRAMEWORK_CLOUD_KEY`. The agent's tools run here for real, so
the café's `tests/tools/*.yaml` simulators are not used, and what
[`tests/scenarios/latte-correction.yaml`](tests/scenarios/latte-correction.yaml) checks is written as
judge items.

The tools and the message format have unit tests: `python3 -m unittest`.
