// GameTracker MCP server.
//
// Exposes a narrow, task-shaped subset of /api/v2 over the Model Context Protocol so
// an AI agent can work with a user's game library.
//
// THIS SERVER HOLDS NO CREDENTIALS. That is the central design decision and everything
// else follows from it. Every tool call carries the CALLER's personal access token,
// taken from the Authorization header of the MCP request that triggered it and passed
// straight through to the API. There is no token in the environment, no token in a
// config file, and nothing for this process to leak if it is compromised.
//
// The alternative — one ambient token in the container's environment — would make this
// port a credential: anything that could reach it would act as that account, and a
// self-hosted instance would end up with an unauthenticated door into its own API.
// Threading the caller's token instead means authorization is the backend's, unchanged,
// and a stolen MCP port grants exactly nothing.
//
// STATELESS, and a fresh McpServer per request. The token is closed over by that
// request's tool handlers and cannot outlive it or bleed into another caller's. A
// session-based transport would have to hold the token for the session's lifetime and
// map sessions to credentials — state worth avoiding on a process whose entire job is
// to forward requests.

const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { TOOLS } = require('./tools');
const api = require('./api');

const PORT = Number(process.env.MCP_PORT || 3001);
// Loopback by default. This surface takes a token, so exposure is not catastrophic —
// but an agent-facing port has no business being on 0.0.0.0 unless someone said so.
// Set MCP_BIND=0.0.0.0 to publish it, and put TLS in front of it when you do.
const BIND = process.env.MCP_BIND || '127.0.0.1';

// Host header values this server will answer to.
//
// MCP_PUBLIC_HOST is the address CLIENTS use, which inside a container is NOT the
// address this process binds to: compose publishes the port on a host interface and
// the container itself always binds 0.0.0.0. So an operator who sets MCP_BIND to a LAN
// address gets a Host header this server has never heard of, and the DNS-rebinding
// check below rejects a perfectly legitimate client with an error that says nothing
// about which of the two addresses is wrong.
//
// Deriving it from the published address means one setting does the whole job.
// MCP_ALLOWED_HOSTS remains for the cases this cannot infer — a DNS name, a reverse
// proxy in front, several addresses — and ADDS to the defaults rather than replacing
// them, so setting it cannot accidentally lock out localhost.
const PUBLIC_HOST = (process.env.MCP_PUBLIC_HOST || '').trim();

const ALLOWED_HOSTS = [
  `127.0.0.1:${PORT}`, '127.0.0.1', `localhost:${PORT}`, 'localhost',
  // The compose service name, for a client on the same Docker network.
  `mcp:${PORT}`, 'mcp',
  // Whatever the port is published on, with and without the port suffix — a client
  // may send either depending on whether the port is the scheme default.
  ...(PUBLIC_HOST && PUBLIC_HOST !== '0.0.0.0' ? [`${PUBLIC_HOST}:${PORT}`, PUBLIC_HOST] : []),
  ...(process.env.MCP_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
];

const SERVER_INFO = {
  name: 'gametracker',
  version: '1.0.0',
};

// The application explanation an agent needs, and the conventions for not destroying
// anything with it. Both live in guide.js — see the header there for why most of it is
// a RESOURCE rather than instructions: the instructions are sent on every connection,
// while the guide is needed only when a question actually turns on it.
const { INSTRUCTIONS, RESOURCES } = require('./guide');

// Pull the personal access token off the request.
//
// Only the Authorization header, and only Bearer. A token in a query string ends up in
// access logs and proxy logs; accepting one there would undo the reason this design
// has no ambient credential in the first place.
function tokenFromRequest(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

// Build a server bound to ONE caller's token.
function serverForToken(token) {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
    instructions: INSTRUCTIONS,
  });
  for (const t of TOOLS) {
    server.registerTool(t.name, t.config, (args, extra) =>
      // The token travels on `extra`, which is per-invocation, rather than being read
      // from module state. Nothing shared, nothing to race.
      t.handler(args, { ...extra, _gametrackerToken: token }));
  }
  // Static documents. They describe the application, not this account's data, so they
  // need no credential and reveal nothing about the instance — which is why they are
  // served from a constant rather than fetched.
  for (const r of RESOURCES) {
    server.registerResource(r.name, r.uri, r.config, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: r.config.mimeType, text: r.text }],
    }));
  }
  return server;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// Liveness only. Deliberately says nothing about the backend: this endpoint answers
// "is the MCP process up", and reporting the API's health here would both require a
// credential we do not have and make a backend blip look like an MCP outage to an
// orchestrator that restarts on it.
app.get('/health', (_req, res) => {
  // Deliberately does NOT report the API base. It used to, and that contradicted
  // api.js's refusal to name the same address in an error message — where the reason
  // given is that it is internal topology. In production it resolves to
  // `http://backend:3000/api/v2`. The compose healthcheck reads the status code only.
  res.json({ status: 'ok', service: 'gametracker-mcp' });
});

app.post('/mcp', async (req, res) => {
  const token = tokenFromRequest(req);
  if (!token) {
    // A JSON-RPC-shaped error, because the caller is an MCP client and a bare HTTP body
    // is not something it can surface to the model.
    return res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Missing Authorization header. This server holds no credentials of its own — '
          + 'configure the MCP client with a GameTracker personal access token '
          + '(My Account → API Tokens) and send it as: Authorization: Bearer gt_pat_...',
      },
      id: null,
    });
  }

  const server = serverForToken(token);
  // sessionIdGenerator: undefined puts the transport in stateless mode — no session
  // store, no session validation, nothing retained between requests.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // DNS-rebinding protection. Practically redundant today — the required
    // Authorization header forces a CORS preflight and there is no CORS middleware, so
    // a browser cannot reach this — but the README actively tells operators to set
    // MCP_BIND=0.0.0.0, and this is one option rather than a class of reasoning
    // somebody has to redo later.
    enableDnsRebindingProtection: true,
    allowedHosts: ALLOWED_HOSTS,
  });

  // Torn down when the response ends, whether it ended well or not. Without this each
  // request leaks a server and a transport, and this process is long-lived.
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP] Request failed:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// GET and DELETE on /mcp are the session-oriented halves of the Streamable HTTP
// transport. Stateless mode has no sessions, so they are answered explicitly rather
// than falling through to a 404 that a client would report as "server not found".
const noSessions = (_req, res) => res.status(405).json({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'This server is stateless; use POST /mcp.' },
  id: null,
});
app.get('/mcp', noSessions);
app.delete('/mcp', noSessions);

// Only start a listener when run directly. Required so the tests can import the tool
// definitions and the express app without binding a port — the same rule index.js
// follows, and for the same reason.
if (require.main === module) {
  app.listen(PORT, BIND, () => {
    console.log(`[MCP] gametracker-mcp listening on ${BIND}:${PORT}`);
    console.log(`[MCP] Accepting Host: ${ALLOWED_HOSTS.join(', ')}`);
    console.log(`[MCP] Forwarding to ${api.API_BASE}`);
    console.log(`[MCP] ${TOOLS.length} tools registered. This server holds no credentials; `
      + 'each request must carry its own Authorization: Bearer gt_pat_...');
  });
}

module.exports = { app, serverForToken, tokenFromRequest, INSTRUCTIONS, SERVER_INFO, ALLOWED_HOSTS };
