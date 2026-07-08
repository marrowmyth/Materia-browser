// A local MCP (Model Context Protocol) server that exposes Slash's browser
// tools to any MCP-capable CLI (Claude / Gemini / Codex) over HTTP. This is
// what lets the FREE, subscription CLIs actually drive the browser: the CLI
// connects to this server and calls the same tools the API path uses.
//
// Universal by design: the caller passes in the tool list and an executor, so
// nothing about the tools is hardcoded here. Binds to localhost on a random
// free port, and every session is gated by a random bearer token.

const http = require('http');
const crypto = require('crypto');

async function startMcpServer({ name = 'slash', tools, executeTool, host = '127.0.0.1' }) {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const {
    StreamableHTTPServerTransport,
  } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

  const token = crypto.randomUUID();
  const transports = {}; // sessionId -> transport

  function makeServer() {
    const server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema,
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      try {
        const result = await executeTool(req.params.name, req.params.arguments || {});
        return { content: [{ type: 'text', text: String(result) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: 'Tool error: ' + (e && e.message ? e.message : String(e)) }], isError: true };
      }
    });
    return server;
  }

  const httpServer = http.createServer(async (req, res) => {
    if ((req.headers['authorization'] || '') !== 'Bearer ' + token) {
      res.writeHead(401).end('Unauthorized');
      return;
    }
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }

    let body = null;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        res.writeHead(400).end('bad json');
        return;
      }
    }

    const sid = req.headers['mcp-session-id'];
    let transport = sid && transports[sid];
    if (!transport) {
      const isInit = body && body.method === 'initialize';
      if (req.method !== 'POST' || !isInit) {
        res.writeHead(400).end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null }),
        );
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      await makeServer().connect(transport);
    }
    await transport.handleRequest(req, res, body);
  });

  const port = await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, host, () => resolve(httpServer.address().port));
  });

  return { name, host, port, token, url: `http://${host}:${port}/mcp`, close: () => httpServer.close() };
}

module.exports = { startMcpServer };
