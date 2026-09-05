(function (root) {
  "use strict";

  const MAX_SESSIONS = 32;
  const MAX_SESSION_REQUESTS = 64;
  const MAX_REQUESTS = 256;
  const MAX_PENDING = 16;
  const MAX_INPUT = 16384;
  const MAX_KEY = 256;
  const MAX_RESPONSE = 65536;
  const MAX_LOGS = 65536;
  const MAX_LOG_ENTRIES = 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function refusal(code = "refused", step = null) {
    return { status: 422, json: { error: { code, step } } };
  }

  function copyResult(result) {
    if (result.status === 422) {
      return refusal(result.json.error.code, result.json.error.step);
    }
    return {
      status: 200,
      json: {
        response: result.json.response,
        agent_logs: result.json.agent_logs.slice(),
        session_id: result.json.session_id
      }
    };
  }

  function canonicalReply(result, sessionId) {
    if (!result || typeof result !== "object" || Array.isArray(result) ||
        !own(result, "status") || !own(result, "json") || result.status !== 200) {
      return null;
    }
    const json = result.json;
    if (!json || typeof json !== "object" || Array.isArray(json) ||
        !["response", "agent_logs", "session_id"].every((key) => own(json, key))) {
      return null;
    }
    const response = json.response;
    const rawLogs = json.agent_logs;
    if (typeof response !== "string" || response.length > MAX_RESPONSE || json.session_id !== sessionId) {
      return null;
    }
    const source = typeof rawLogs === "string" ? [rawLogs] : rawLogs;
    if (!Array.isArray(source) || source.length > MAX_LOG_ENTRIES) {
      return null;
    }
    const logs = [];
    let length = 0;
    for (const entry of source) {
      if (typeof entry !== "string") return null;
      length += entry.length;
      if (length > MAX_LOGS) return null;
      logs.push(entry);
    }
    return { status: 200, json: { response, agent_logs: logs, session_id: sessionId } };
  }

  function create(execute) {
    if (typeof execute !== "function") {
      throw new TypeError("execute must be a function");
    }
    const sessions = new Map();
    const creations = new Map();
    let requests = 0;
    let pending = 0;

    function newSessionId() {
      try {
        const crypto = root.crypto;
        if (!crypto) return null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          let id;
          if (typeof crypto.randomUUID === "function") {
            try { id = crypto.randomUUID(); } catch (_) { /* Try random bytes below. */ }
          }
          if (typeof id !== "string" || !UUID.test(id)) {
            if (typeof crypto.getRandomValues !== "function") return null;
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            bytes[6] = (bytes[6] & 15) | 64;
            bytes[8] = (bytes[8] & 63) | 128;
            const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
            id = hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) +
              "-" + hex.slice(16, 20) + "-" + hex.slice(20);
          }
          if (!sessions.has(id)) return id;
        }
      } catch (_) {
        return null;
      }
      return null;
    }

    async function run(session, userInput) {
      try {
        if (session.failed) return refusal();
        const result = await execute({
          user_input: userInput,
          conversation_history: session.history.map((entry) => ({ ...entry })),
          session_id: session.id
        });
        const reply = canonicalReply(result, session.id);
        if (!reply) {
          session.failed = true;
          return refusal();
        }
        session.history.push(
          { role: "user", content: userInput },
          { role: "assistant", content: reply.json.response }
        );
        return reply;
      } catch (_) {
        // A failed reply does not prove that the executor performed no side effects.
        session.failed = true;
        return refusal();
      } finally {
        pending -= 1;
      }
    }

    async function dispatch(method, path, body) {
      let userInput, sessionId, key, hasSession, hasKey;
      try {
        if (method !== "POST" || path !== "/chat" || !body ||
            typeof body !== "object" || Array.isArray(body) || !own(body, "user_input")) {
          return refusal("invalid-request", "1");
        }
        userInput = body.user_input;
        hasSession = own(body, "session_id");
        hasKey = own(body, "idempotency_key");
        sessionId = hasSession ? body.session_id : undefined;
        key = hasKey ? body.idempotency_key : undefined;
        if (typeof userInput !== "string" || (hasSession && typeof sessionId !== "string") ||
            (hasKey && typeof key !== "string")) {
          return refusal("invalid-request", "1");
        }
      } catch (_) {
        return refusal("invalid-request", "1");
      }

      let session = hasSession ? sessions.get(sessionId) : null;
      if (hasSession && !session) return refusal("unknown-session");
      const receipts = hasSession ? session.receipts : creations;
      // Creation and explicit-session keys are separate maps, never concatenated strings.
      if (hasKey && receipts.has(key)) {
        return copyResult(await receipts.get(key));
      }
      if (userInput.length > MAX_INPUT || (hasKey && key.length > MAX_KEY) ||
          requests >= MAX_REQUESTS || pending >= MAX_PENDING ||
          (session && (session.failed || session.requests >= MAX_SESSION_REQUESTS)) ||
          (!session && sessions.size >= MAX_SESSIONS)) {
        return refusal();
      }
      if (!session) {
        const id = newSessionId();
        if (id === null) return refusal();
        session = { id, history: [], requests: 0, failed: false, receipts: new Map(), tail: Promise.resolve() };
        sessions.set(id, session);
      }

      session.requests += 1;
      requests += 1;
      pending += 1;
      // Reserve before yielding; different turns serialize and see committed history.
      const result = session.tail.then(() => run(session, userInput));
      session.tail = result.then(() => undefined);
      if (hasKey) receipts.set(key, result);
      return copyResult(await result);
    }

    return Object.freeze({ dispatch });
  }

  root.RappChat = Object.freeze({ create });
})(window);
