/*
 * mock-copilot.mjs — zero-dependency HTTP server that impersonates BOTH the
 * rapp-auth CORS worker AND the GitHub Copilot API for autopilot testing.
 *
 * Endpoints:
 *   OPTIONS *                      -> 204 (permissive CORS preflight)
 *   GET  /token                    -> Copilot token exchange (COPILOT_TOKEN_URL)
 *   GET  /api/copilot/token        -> same payload (auth-worker fallback path)
 *   GET  /models                   -> fixed catalog exercising the
 *                                     auto-select-highest-Haiku logic
 *   POST /chat/completions         -> scripted deterministic "brain"
 *   POST /api/auth/device          -> mock device-code flow start
 *   POST /api/auth/device/poll     -> pending once, then authorized
 *
 * Scripted brain rules (in precedence order):
 *   1. a role:"tool" message AFTER the last user message  -> acknowledge the
 *      tool result (this is the second round of a tool-call loop)
 *   2. last user matches /what do you remember/i          -> quote any
 *      <memory>...</memory> block found in the system message, proving the
 *      memory injection round-trips; else "I have no memories yet."
 *   3. last user matches /remember/i                      -> tool_calls
 *      response invoking ManageMemory with the captured user text
 *   4. otherwise -> deterministic echo containing the literal MOCK_LLM_OK
 *      marker plus the names of every tool it was offered
 *
 * Run standalone:  node mock-copilot.mjs [port]
 * Or in-process:   import { startMockCopilot } from './mock-copilot.mjs'
 */

import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 9797;

const MODELS_PAYLOAD = {
  data: [
    { id: 'gpt-4o', name: 'GPT-4o', capabilities: { type: 'chat' } },
    {
      id: 'claude-haiku-4-5',
      name: 'Claude Haiku 4.5',
      capabilities: { type: 'chat' },
      model_picker_enabled: true,
    },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', capabilities: { type: 'chat' } },
  ],
};

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    // The wildcard does not cover Authorization for actual requests in every
    // engine, so echo whatever the preflight asked for and fall back to '*'.
    'Access-Control-Allow-Headers':
      (req && req.headers['access-control-request-headers']) || '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '600',
  };
}

function sendJSON(req, res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* Copilot content can be a plain string or an array of typed parts. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p && p.text) || ''))
      .join(' ');
  }
  return '';
}

function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

let completionSeq = 0;

function completion(model, text) {
  return {
    id: `chatcmpl-mock-${++completionSeq}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'mock-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function toolCallCompletion(model, name, args) {
  return {
    id: `chatcmpl-mock-${++completionSeq}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'mock-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

export function scriptedCompletion(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const toolNames = (Array.isArray(body && body.tools) ? body.tools : [])
    .map((t) => t && t.function && t.function.name)
    .filter(Boolean);
  const model = (body && body.model) || 'mock-model';

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  const lastUserText = lastUserIdx >= 0
    ? contentToText(messages[lastUserIdx].content)
    : '';
  const toolAfterUser = messages
    .slice(lastUserIdx + 1)
    .some((m) => m && m.role === 'tool');

  // 1. Second round of a tool-call loop: acknowledge the tool result.
  if (toolAfterUser) {
    const toolMsgs = messages.filter((m) => m && m.role === 'tool');
    const last = toolMsgs[toolMsgs.length - 1] || {};
    return completion(
      model,
      `Saved. The ${last.name || 'tool'} reported: ${trunc(contentToText(last.content), 220)}`,
    );
  }

  // 2. Memory recall: quote the injected <memory> block if present.
  if (/what do you remember/i.test(lastUserText)) {
    const sysText = messages
      .filter((m) => m && m.role === 'system')
      .map((m) => contentToText(m.content))
      .join('\n');
    const mem = sysText.match(/<memory>[\s\S]*?<\/memory>/i);
    if (mem) return completion(model, `Here is what I remember:\n\n${mem[0]}`);
    return completion(model, 'I have no memories yet.');
  }

  // 3. A "remember" instruction: call ManageMemory with the captured text.
  if (/remember/i.test(lastUserText)) {
    return toolCallCompletion(model, 'ManageMemory', {
      memory_type: 'fact',
      content: lastUserText,
    });
  }

  // 4. Deterministic echo with the marker + offered tools.
  return completion(
    model,
    `MOCK_LLM_OK — you said: "${trunc(lastUserText, 140)}". ` +
    `Tools offered: ${toolNames.length ? toolNames.join(', ') : '(none)'}.`,
  );
}

export function startMockCopilot({ port = DEFAULT_PORT, quiet = false } = {}) {
  const state = { devicePolls: 0, chatCalls: 0 };
  const log = (...a) => { if (!quiet) console.log('[mock-copilot]', ...a); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    try {
      if (req.method === 'GET' && (path === '/token' || path === '/api/copilot/token')) {
        log(`GET ${path} -> token exchange ok`);
        sendJSON(req, res, 200, {
          token: 'mock-copilot-token',
          endpoints: { api: `http://127.0.0.1:${port}` },
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
        return;
      }

      if (req.method === 'GET' && path === '/models') {
        log('GET /models -> 3 models (haiku should win auto-select)');
        sendJSON(req, res, 200, MODELS_PAYLOAD);
        return;
      }

      if (req.method === 'POST' && path === '/chat/completions') {
        let body;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          sendJSON(req, res, 400, { error: { message: 'invalid JSON body' } });
          return;
        }
        state.chatCalls += 1;
        const out = scriptedCompletion(body);
        const kind = out.choices[0].finish_reason === 'tool_calls'
          ? `tool_calls(${out.choices[0].message.tool_calls[0].function.name})`
          : 'text';
        log(`POST /chat/completions #${state.chatCalls} model=${body.model || '?'} -> ${kind}`);
        sendJSON(req, res, 200, out);
        return;
      }

      if (req.method === 'POST' && path === '/api/auth/device') {
        state.devicePolls = 0;
        log('POST /api/auth/device -> device code MOCK-CODE');
        sendJSON(req, res, 200, {
          device_code: 'mock-dev',
          user_code: 'MOCK-CODE',
          verification_uri: 'https://github.com/login/device',
          interval: 1,
          expires_in: 900,
        });
        return;
      }

      if (req.method === 'POST' && path === '/api/auth/device/poll') {
        await readBody(req); // drain
        state.devicePolls += 1;
        if (state.devicePolls === 1) {
          log('POST /api/auth/device/poll #1 -> authorization_pending');
          sendJSON(req, res, 200, { error: 'authorization_pending' });
        } else {
          log(`POST /api/auth/device/poll #${state.devicePolls} -> access_token granted`);
          sendJSON(req, res, 200, { access_token: 'ghu_mockmockmock' });
        }
        return;
      }

      log(`${req.method} ${path} -> 404`);
      sendJSON(req, res, 404, { error: `mock-copilot: no route for ${req.method} ${path}` });
    } catch (err) {
      sendJSON(req, res, 500, { error: String((err && err.message) || err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(`listening on http://127.0.0.1:${port}`);
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Standalone: node mock-copilot.mjs [port]
const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.argv[2]) || Number(process.env.MOCK_COPILOT_PORT) || DEFAULT_PORT;
  startMockCopilot({ port }).catch((e) => {
    console.error('[mock-copilot] failed to start:', e.message);
    process.exit(1);
  });
}
