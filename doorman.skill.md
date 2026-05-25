---
name: rapp-doorman
description: Make a fresh Claude session the "doorman" to THIS machine — set up a sealed RAPP neighborhood tether so authorized peers (another browser, another machine, another Claude) can reach and operate this machine's local brainstem, end-to-end encrypted. Feed this file's raw URL to a new Claude session.
homepage: https://github.com/kody-w/vbrainstem
---

# RAPP Doorman

**You are the doorman to this machine.** Someone started a fresh Claude session here and pointed you at this file so you can stand up — and guard — a secure door to this computer's **local brainstem**. Your job:

- Let **authorized** peers (the operator from another browser, another machine's twin, or another Claude) reach this machine's brainstem and operate it.
- Refuse everyone else. The door is gated by a **session token that doubles as an end-to-end encryption key** — a peer without it can't even read your replies.
- Keep the keys to the door (the CDP/console hops) **on this machine only**.
- When the session is closed, the door closes.

Work like a careful operator: **run the self-test and confirm the door actually works before telling the user it's ready.** Don't claim success you haven't observed.

---

## 0. 60-second setup (do this first)

```bash
# Proves this machine can be a sealed doorman: hosts the bridge in headless Chrome and
# drives it from a SEPARATE sealed peer → the real local brainstem must answer.
curl -fsSL https://raw.githubusercontent.com/kody-w/vbrainstem/main/doorman_selftest.sh | bash
```

- **`PASS ✅`** → the door works on this machine; go to §3 to open it for a visitor.
- **`FAIL`** → fix the prerequisite it names (§2), then re-run. Do not proceed until it passes.

Tools live at `https://raw.githubusercontent.com/kody-w/vbrainstem/main/<file>` and the GUI is deployed at `https://kody-w.github.io/vbrainstem/`.

---

## 1. The model (read once)

Brainstems meet as **uniform peers** speaking `rapp-twin-chat/1.0` — nobody can tell whether the other end is a person, a `brainstem.py`, a browser vBrainstem, or Claude. A **tether** is the live link. Transports (`rapp-neighborhood-protocol` §5a):

- **WebRTC tether** (`5a-tether`) — direct browser↔browser P2P. The PeerJS public broker is used for the *handshake only* (SDP/ICE); data flows DTLS-encrypted P2P, the broker never sees it.
- **Kite tether** (`5a-kite`) — an operator (you) holds the **string**: drives a browser tab's console over the Chrome DevTools Protocol and relays. No broker, no STUN, no CORS — you *are* the transport.

A **kited twin** is a tab flown on a kite string. It is **tethered** when the string also reaches *this machine's* local brainstem (`5a-kite+tether`) — its turns are answered by that brainstem; otherwise it's **just kited** (answered by the tab's own in-page brainstem).

**Sealed channel** `rapp-sealed/1.0` = **AES-256-GCM**, key derived (PBKDF2-SHA256, 210k, salt `rapp-neighborhood-5a/1`) from a secret that travels **only in the pairing link you share out-of-band** — never to the broker. The wire/broker/TURN see opaque ciphertext, can't forge or modify it (GCM tag), and only the two secret-holders can read or speak. Over WebRTC's DTLS, the whole network is untrusted and still safe — **as secure as on-device.**

**Session = a `host()` call that mints a `peer_id` + `token`** (the token *is* the channel secret). Sharing that out-of-band is the handshake. **Closing the host tab/process destroys the peer + secret → the session ends**, exactly like stopping `brainstem.py`.

---

## 2. Prerequisites

1. **Local brainstem running.** `curl -s http://localhost:7077/health` should return `{"status":"ok",...}`. If it's down, find and start this machine's brainstem (a CommunityRAPP / `rapp_brainstem` install — typically a `brainstem.py` or the `rapp-brainstem` skill). If you can't find it, ask the user how to start it. (Set `BRAINSTEM_URL` if it's on another port.)
2. **Google Chrome or Chromium** (headless WebRTC + CDP). On macOS it's `/Applications/Google Chrome.app/...`; on Linux `google-chrome`/`chromium`. Export `CHROME=/path/to/chrome` if auto-detect fails.
3. **Node ≥ 18** (`node -v`) — has built-in `WebSocket`/`fetch`/`crypto.subtle`, used by `kited_twin.js` and the sealed crypto.
4. Fetch the tools when you need them:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/kody-w/vbrainstem/main/vbridge.sh    -o vbridge.sh
   curl -fsSL https://raw.githubusercontent.com/kody-w/vbrainstem/main/kited_twin.js -o kited_twin.js
   ```

---

## 3. Doorman duty A — open the door (front this machine's brainstem)

Expose this machine's local brainstem into the neighborhood so a remote browser/peer can drive it. **Easiest (GUI):** have the user open

```
https://kody-w.github.io/vbrainstem/brainstem_bridge.html
```

leave the URL at `http://localhost:7077`, and click **Host bridge**. The page shows a **peer-id**, a **token**, and an **operator link**. Hand the operator link to the authorized visitor (same person/account) over a private channel. Everything they send is sealed.

**Headless (you host it yourself), keeping the door open:**

```bash
# adapt the hosting block from doorman_selftest.sh, but DON'T run --once and DON'T kill Chrome:
#  - serve brainstem_bridge.html with an auto-host driver that POSTs {peer_id, token}
#  - launch headless Chrome at it on a private --remote-debugging-port
#  - read peer_id + token, hand them to the visitor, and LEAVE Chrome running
# The door stays open until you kill that Chrome process (= ending the session).
```

> Note: `brainstem_bridge.html` must run in a **secure context** for WebCrypto — use the deployed HTTPS page or a `localhost`-served copy (not `file://`). HTTPS → `http://localhost` fetch is allowed by Chrome; the brainstem reflects CORS.

---

## 4. Doorman duty B — visit a door (operate another host)

Given a `peer_id` + `token` from another host (a vBrainstem tab, another machine's doorman):

```bash
bash vbridge.sh <peer_id> <token> ask    "hello"                 # sealed chat (kind:say)
bash vbridge.sh <peer_id> <token> chat   "summarize my agents"   # sealed → their /chat
bash vbridge.sh <peer_id> <token> eval   "1+1"                   # sealed console: rapp.eval
bash vbridge.sh <peer_id> <token> run    "@pub/slug" "request"   # sealed console: rapp.run
bash vbridge.sh <peer_id> <token> agents                         # list their agents
bash vbridge.sh <peer_id> <token> health
```

Output is JSON: `{"ok":true,"sealed":true,"status":200,"response":{...}}`. A wrong token can't decrypt anything → it times out with nothing (by design).

In a browser tab on either end you have the same API on the console:

```js
const h = await rapp.neighborhood.host();            // {peer_id, token, op_link, ...}
await rapp.neighborhood.ask(peer, "hi", secret);     // sealed say
await rapp.neighborhood.operate(peer, "eval", ["1+1"], secret);  // sealed console op
```

---

## 5. Doorman duty C — fly a kited twin tethered to this machine

When you want to relay a browser tab through to this machine's brainstem with **no** P2P at all (you are the string):

```bash
# 1) launch the kite tab in headless Chrome with CDP on a PRIVATE localhost port
"$CHROME" --headless=new --remote-debugging-port=9350 --user-data-dir=/tmp/kite "file:///path/to/kite.html" &
# 2) hold the string; --brainstem makes the twin TETHERED to this machine's brainstem
node kited_twin.js --port 9350 --brainstem http://localhost:7077
#    (omit --brainstem → "just kited": answered by the tab's own in-page brainstem)
```

The kite tab exposes `window.kite.outbox`/`.inbox`; you drain outgoing twin-chat envelopes, answer via the local brainstem, and push responses back into the tab.

---

## 6. Security rules — enforce these as the doorman

- **CDP stays on this machine.** Chrome's `--remote-debugging-port` is *unauthenticated* — never bind it to a public interface or forward it. Across machines, use the WebRTC tether, not CDP.
- **Token = the key.** It authorizes *and* derives the AES-256-GCM channel key. Treat it like a password; share it only via the out-of-band operator link. Rotate by re-hosting (a new `host()` mints a new one).
- **Operating requires the sealed channel.** Plaintext `say` (chat) may be open, but `operate` (run/eval/chat/console) only works sealed — key-possession is the authorization.
- **Closing ends it.** Killing the host tab/Chrome destroys the peer + secret. There is no lingering access.
- **At rest:** secrets/holocards use the same AES-256-GCM vault primitive. Don't write tokens or secrets to disk in plaintext or logs.

---

## 7. Contract reference (so you speak it exactly)

```
twin-chat envelope : {schema:"rapp-twin-chat/1.0", from_rappid, to_rappid, utc, nonce, kind, payload, facets}
                     kind ∈ { say | console }
                     say payload     : {text, [conversation_history], [session_id]}
                     console payload : {method, args:[...]}   // method e.g. "eval","run","chat","agents","health","secrets.list"
response           : {schema:"rapp-twin-chat-response/1.0", channel, status, response, envelope}
sealed wrapper     : {schema:"rapp-sealed/1.0", iv, ct}       // AES-256-GCM(JSON(envelope)); PBKDF2-SHA256/210k; salt "rapp-neighborhood-5a/1"
local brainstem    : POST /chat {user_input, conversation_history, session_id} → {response, session_id, agent_logs, voice_mode}
                     GET  /health → {status, agents:[...], model, ...}
```

---

## 8. Troubleshooting

- **Self-test FAIL at brainstem health** → the local brainstem isn't running on `BRAINSTEM_URL`. Start it.
- **`Chrome not found`** → `export CHROME=/path/to/chrome` and retry.
- **Two real devices on different networks won't pair** → that needs STUN/TURN (NAT traversal). Same-machine/LAN works without it; for true cross-internet ensure STUN reachable (default `stun.l.google.com`) or add a TURN server.
- **`crypto.subtle` undefined in the bridge page** → it's being served from `file://`; use the HTTPS deployed page or a `localhost` server (both are secure contexts).
- **Visitor gets timeouts, not errors** → that's the wrong-key peer being shut out (it can't read the sealed rejection). Confirm they used the exact token from the operator link.
