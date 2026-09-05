# Canonical virtual chat boundary

`rapp-chat.js` wraps the legacy internal chat executor without changing the Grail,
its six-key reply, or its string log. It implements the RAPP/1 rev15 section 8 chat
shapes as **virtual dispatch**, not an HTTP server. Loading it on GitHub Pages does
not create a network `POST /chat` endpoint. There are no sibling endpoints.

## Public JavaScript API

```js
const chat = window.RappChat.create(execute);
const result = await chat.dispatch("POST", "/chat", body);
```

`create(execute)` returns exactly `{dispatch}`. `execute` must be a function;
otherwise creation throws `TypeError`. Each call to `create` makes an independent
session namespace. Create one boundary per stable AI/access scope, **not per
request**. Do not reuse a boundary across public/private access changes or persona
switches. Scope selection and authorization belong to the host.

The executor may return synchronously or asynchronously. It receives exactly:

```js
{
  user_input: "the unmodified user string",
  conversation_history: [
    { role: "user", content: "an earlier successful request" },
    { role: "assistant", content: "its successful response" }
  ],
  session_id: "the boundary-assigned UUID"
}
```

The executor returns the existing `{status, json}` result. Success requires numeric
`status:200`, an object `json`, a string `response`, string or string-array
`agent_logs`, and the exact supplied `session_id`. Extra legacy fields are ignored.
No provider error details are exposed.

### Requests

Only the exact method `"POST"` and path `"/chat"` are accepted.

| Member | Meaning |
|---|---|
| `user_input` | Required own member, string; whitespace and empty strings are preserved |
| `session_id` | Optional own member, string; omit to start a session |
| `idempotency_key` | Optional own member, string; the empty string is a valid key |
| Any other member | Ignored, including `conversation_history`; never forwarded or read |

This is an object API: a present `session_id: undefined` is malformed. Do not use
`session_id: sessionId || undefined`. Omit the property instead. An explicit empty
or unknown session ID is refused, not silently recreated.

### Results

Successful dispatch returns exactly:

```json
{"status":200,"json":{"response":"Answer","agent_logs":["combined kernel log\n"],"session_id":"assigned UUID"}}
```

A string log becomes one array element, including an empty string. Existing arrays
are copied unchanged. Logs are never split, trimmed, coerced, or truncated.

Every refusal returns exactly:

```json
{"status":422,"json":{"error":{"code":"refused","step":null}}}
```

The only error combinations emitted are:

| Condition | `code` | `step` |
|---|---|---|
| Wrong method/path, malformed body, missing/wrong-type recognized field | `invalid-request` | `"1"` |
| Unknown explicit session | `unknown-session` | `null` |
| Limits, missing entropy, executor failure, invalid reply, blocked session | `refused` | `null` |

The publisher must register these three error codes. This module does not register
codes or establish identity, registry, signing, or whole-host conformance.

## Session and idempotency semantics

- Sessions and successful user/assistant history pairs live only in this
  boundary's memory. No localStorage, sessionStorage, IndexedDB, cookies, or
  persistent personal store is used.
- Reload or a fresh `create` loses the old namespace and receipts. An old explicit
  ID then returns `unknown-session`. Session IDs are not ancestor identities.
- UUIDs prefer Web Crypto `randomUUID`, falling back to Web Crypto random bytes
  with UUIDv4 bits. Missing entropy or repeated collisions fails closed.
- Different requests in the same session execute sequentially. Each executor call
  receives a fresh copy of history built **when it executes**, after prior success.
  Different sessions may execute concurrently.
- Keys with omitted `session_id` occupy a creation namespace. Keys with explicit
  `session_id` occupy that session's separate namespace. These are maps, not
  delimiter-concatenated keys.
- An accepted key reserves its result before execution starts. Concurrent
  duplicates await that same execution. Later duplicates receive a fresh copy of
  its original result, even if `user_input` differs. Use a new key for a new intent.
- A creation key and the same key subsequently sent with the returned session ID
  are **different operations**. Retry using the same presence/absence of
  `session_id` as the original request.
- Replays do not execute, append history, or consume another request slot.
  Previously accepted receipts remain replayable at capacity or after a session
  becomes blocked.
- Any executor rejection, non-200 result, invalid result, or oversized result is a
  terminal refusal. Its keyed receipt is retained, never converted to success or
  automatically retried: a finished tool side effect may precede a failed reply.
- Such failure also blocks the session and its queued work. The wrapper cannot
  know whether the executor changed external state. A fresh session requires
  explicit client action; it is not a retry mechanism for an uncertain side effect.
- Refusals before admission (malformed/unknown-session/limits/entropy) do not call
  the executor or reserve a key. Retrying after a pending-work slot frees can be
  admitted. Already admitted work and failures consume request capacity.

There is no durable exactly-once guarantee across reload, separate boundaries,
or keyless/new-key requests. Use an idempotency key for consequential requests and
do not automatically replay an uncertain action after losing page state. A hanging
executor retains its pending slot; there is no unsafe timeout/cancellation/retry.

## Bounds

Limits apply independently to each boundary:

| Resource | Limit |
|---|---:|
| Sessions, including failed sessions | 32 |
| Accepted requests per session | 64 |
| Accepted requests in total | 256 |
| Pending accepted requests, queued plus executing | 16 |
| `user_input` length | 16,384 UTF-16 code units |
| `idempotency_key` length | 256 UTF-16 code units |
| Response length | 65,536 UTF-16 code units |
| Aggregate log length | 65,536 UTF-16 code units |
| Array log entries | 1,024 |

No session or receipt is silently evicted. Completed requests free pending slots;
they do not reset session/total counters. History contains only successful
user/assistant pairs. Oversized executor output is refused without truncation and
without retrying the execution.

## Host integration

Load `rapp-chat.js` through the host's permitted script-loading policy. After the
existing legacy dispatcher exists, capture it before exposing any new adapter:

```html
<script src="./rapp-chat.js"></script>
<script>
  const legacyDispatch = window.vbrainstem.dispatch.bind(window.vbrainstem);
  const canonicalChat = window.RappChat.create((internalRequest) =>
    legacyDispatch("POST", "/chat", internalRequest)
  );

  async function sendCanonical(userInput, sessionId, idempotencyKey) {
    const request = { user_input: userInput, idempotency_key: idempotencyKey };
    if (sessionId !== null) request.session_id = sessionId;
    return canonicalChat.dispatch("POST", "/chat", request);
  }

  // Retain this complete request/key for an identical in-page retry.
  const firstKey = crypto.randomUUID();
  // sendCanonical("Hello", null, firstKey) starts a session.
  // Use the successful json.session_id and a NEW key for the next turn.
</script>
```

The host must keep this executor bound to a stable, authorized persona/access
scope while calls are outstanding. Capturing a legacy function does not freeze
its mutable global persona or credentials. Retire the old UI scope on a switch;
do not route its replies into another AI's transcript. This module deliberately
does not edit `index.html`, replace the internal route, or implement authorization.

## Focused tests

Tests execute the real browser script in an isolated JavaScript VM, using the
existing Playwright runner and mock executor call counts. They do not call an AI.
The runner's existing static server is a test fixture, not a new product backend.

With the existing pinned test dependencies restored:

```bash
cd tests
mkdir -p test-results
PYTHONDONTWRITEBYTECODE=1 \
PWTEST_CACHE_DIR="$PWD/test-results/cache" \
TMPDIR="$PWD/test-results" \
VB_TEST_PORT=4289 \
./node_modules/.bin/playwright test rapp-chat.spec.js \
  --workers=1 --reporter=line --output=test-results/rapp-chat
```

Coverage includes strict envelopes, ignored fields, unknown sessions, response
validation, concurrent and scoped idempotency, serialized/copied histories,
failure receipts, blocked queues, reload isolation, entropy, and every limit.
