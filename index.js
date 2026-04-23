import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TRELLO_BASE_URL = "https://api.trello.com/1";

function getCredentials() {
  const key = process.env.TRELLO_API_KEY?.trim().replace(/^=+/, "");
  const token = process.env.TRELLO_TOKEN?.trim().replace(/^=+/, "");
  if (!key || !token) {
    throw new Error("TRELLO_API_KEY e TRELLO_TOKEN são obrigatórias");
  }
  return { key, token };
}

async function trelloRequest(path, method = "GET", body = null) {
  const { key, token } = getCredentials();
  const sep = path.includes("?") ? "&" : "?";
  const url = `${TRELLO_BASE_URL}${path}${sep}key=${key}&token=${token}`;
  const options = { method, headers: { "Content-Type": "application/json" } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trello API ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Transport em memória: entrega mensagens ao Server e devolve respostas como
// JSON puro, sem SSE — resolve incompatibilidade com o cliente do claude.ai.
// ---------------------------------------------------------------------------
class JsonTransport {
  constructor() {
    this._resolve = null;
    this._reject = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }

  async start() {}
  async close() {}

  async send(message) {
    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      this._reject = null;
      resolve(message);
    }
  }

  waitForResponse(timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      setTimeout(() => {
        if (this._reject) {
          this._reject = null;
          this._resolve = null;
          reject(new Error("MCP response timeout"));
        }
      }, timeoutMs);
    });
  }

  deliver(message) {
    this.onmessage?.(message, {});
  }
}

// ---------------------------------------------------------------------------
// Factory de Server MCP — instanciada por request no modo stateless
// ---------------------------------------------------------------------------
function createMcpServer() {
  const server = new Server(
    { name: "trello-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_boards",
        description: "Lista todos os boards abertos do usuário autenticado no Trello",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "list_lists",
        description: "Lista todas as listas abertas de um board específico",
        inputSchema: {
          type: "object",
          properties: {
            board_id: { type: "string", description: "ID do board no Trello" },
          },
          required: ["board_id"],
        },
      },
      {
        name: "list_cards",
        description: "Lista todos os cards visíveis de uma lista específica",
        inputSchema: {
          type: "object",
          properties: {
            list_id: { type: "string", description: "ID da lista no Trello" },
          },
          required: ["list_id"],
        },
      },
      {
        name: "create_card",
        description: "Cria um novo card em uma lista do Trello",
        inputSchema: {
          type: "object",
          properties: {
            list_id: { type: "string", description: "ID da lista onde o card será criado" },
            name: { type: "string", description: "Nome/título do card" },
            description: { type: "string", description: "Descrição do card (opcional)" },
          },
          required: ["list_id", "name"],
        },
      },
      {
        name: "archive_card",
        description: "Arquiva (conclui/fecha) um card do Trello",
        inputSchema: {
          type: "object",
          properties: {
            card_id: { type: "string", description: "ID do card a arquivar" },
          },
          required: ["card_id"],
        },
      },
      {
        name: "move_card",
        description: "Move um card para outra lista do Trello",
        inputSchema: {
          type: "object",
          properties: {
            card_id: { type: "string", description: "ID do card a mover" },
            list_id: { type: "string", description: "ID da lista de destino" },
          },
          required: ["card_id", "list_id"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "list_boards": {
          const boards = await trelloRequest("/members/me/boards?fields=id,name,url,closed");
          return { content: [{ type: "text", text: JSON.stringify(boards.filter((b) => !b.closed), null, 2) }] };
        }
        case "list_lists": {
          const lists = await trelloRequest(`/boards/${args.board_id}/lists?fields=id,name,closed`);
          return { content: [{ type: "text", text: JSON.stringify(lists.filter((l) => !l.closed), null, 2) }] };
        }
        case "list_cards": {
          const cards = await trelloRequest(`/lists/${args.list_id}/cards?fields=id,name,desc,due,url,closed`);
          return { content: [{ type: "text", text: JSON.stringify(cards, null, 2) }] };
        }
        case "create_card": {
          const body = { idList: args.list_id, name: args.name, ...(args.description && { desc: args.description }) };
          const card = await trelloRequest("/cards", "POST", body);
          return { content: [{ type: "text", text: `Card criado!\nID: ${card.id}\nNome: ${card.name}\nURL: ${card.url}` }] };
        }
        case "archive_card": {
          const card = await trelloRequest(`/cards/${args.card_id}`, "PUT", { closed: true });
          return { content: [{ type: "text", text: `Card "${card.name}" (${card.id}) arquivado.` }] };
        }
        case "move_card": {
          const card = await trelloRequest(`/cards/${args.card_id}`, "PUT", { idList: args.list_id });
          return { content: [{ type: "text", text: `Card "${card.name}" movido para lista ${args.list_id}.` }] };
        }
        default:
          throw new Error(`Ferramenta desconhecida: ${name}`);
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "Accept", "Cache-Control"],
    exposedHeaders: ["Mcp-Session-Id"],
  })
);

app.use(express.json());

// Request logger (visible nos logs do Railway)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} | accept: ${req.headers.accept || "-"} | origin: ${req.headers.origin || "-"}`);
  next();
});

// ---------------------------------------------------------------------------
// OAuth Protected Resource Metadata — RFC 9728
// claude.ai verifica este endpoint; sem authorization_servers = acesso público
// ---------------------------------------------------------------------------
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const host = req.headers.host || req.hostname;
  res.json({ resource: `https://${host}/mcp` });
});

app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
  const host = req.headers.host || req.hostname;
  res.json({ resource: `https://${host}/mcp` });
});

// ---------------------------------------------------------------------------
// POST /mcp — Streamable HTTP (stateless) com transport JSON puro
// Retorna application/json em vez de text/event-stream, eliminando problemas
// de buffering do CDN e parsing SSE no cliente do claude.ai.
// ---------------------------------------------------------------------------
app.post("/mcp", async (req, res) => {
  const message = req.body;
  const acceptsSSE = (req.headers.accept || "").includes("text/event-stream");

  const sendResponse = (statusCode, body) => {
    if (statusCode !== 200) {
      return res.status(statusCode).json(body);
    }
    if (acceptsSSE) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
      return res.end();
    }
    return res.json(body);
  };

  if (!message || typeof message !== "object") {
    return sendResponse(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  // Notificações (sem id) não precisam de resposta
  if (message.id === undefined || message.id === null) {
    return res.status(202).end();
  }

  const transport = new JsonTransport();
  const mcpServer = createMcpServer();

  try {
    await mcpServer.connect(transport);
    const responsePromise = transport.waitForResponse();
    transport.deliver(message);
    const response = await responsePromise;
    sendResponse(200, response);
  } catch (err) {
    console.error("Erro no request MCP:", err.message);
    sendResponse(500, {
      jsonrpc: "2.0",
      id: message?.id ?? null,
      error: { code: -32000, message: err.message },
    });
  } finally {
    await mcpServer.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// GET /mcp — SSE stream para notificações server→client (spec Streamable HTTP)
// Envia keepalive a cada 15s para manter a conexão aberta no Railway/Fastly.
// ---------------------------------------------------------------------------
app.get("/mcp", (req, res) => {
  const accept = req.headers.accept || "";
  if (!accept.includes("text/event-stream")) {
    return res.status(406).json({ error: "Not Acceptable: must accept text/event-stream" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Comentário inicial confirma a conexão ao cliente
  res.write(": connected\n\n");

  const keepalive = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => clearInterval(keepalive));
});

// ---------------------------------------------------------------------------
// /sse + /message — Transport SSE legado (SSEServerTransport)
// Compatibilidade com clientes MCP que usam o protocolo anterior a 2025-03-26
// ---------------------------------------------------------------------------
const sseSessions = new Map();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/message", res);
  const mcpServer = createMcpServer();
  const sid = transport.sessionId;

  sseSessions.set(sid, { transport, server: mcpServer });
  transport.onclose = () => {
    sseSessions.delete(sid);
    mcpServer.close().catch(() => {});
  };

  await mcpServer.connect(transport);
  await transport.start();
});

app.post("/message", async (req, res) => {
  const sid = req.query.sessionId;
  const session = sseSessions.get(sid);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  await session.transport.handlePostMessage(req, res, req.body);
});

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) =>
  res.json({ status: "ok", server: "trello-mcp", version: "1.0.0" })
);

app.get("/", (_req, res) =>
  res.json({
    name: "Trello MCP Server",
    version: "1.0.0",
    endpoints: {
      mcp_streamable_http: "POST /mcp  (application/json)",
      mcp_sse_stream: "GET /mcp   (text/event-stream)",
      mcp_legacy_sse: "GET /sse   (SSEServerTransport)",
    },
    tools: ["list_boards", "list_lists", "list_cards", "create_card", "archive_card", "move_card"],
  })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Trello MCP server rodando na porta ${PORT}`);

  const rawKey   = process.env.TRELLO_API_KEY   ?? "";
  const rawToken = process.env.TRELLO_TOKEN      ?? "";
  const trimKey   = rawKey.trim();
  const trimToken = rawToken.trim();

  const mask = (s) => s.length >= 10
    ? `${s.slice(0, 5)}...${s.slice(-5)} (len=${s.length})`
    : `[muito curto: len=${s.length}]`;

  console.log(`[DIAG] TRELLO_API_KEY   raw  : ${mask(rawKey)}`);
  console.log(`[DIAG] TRELLO_API_KEY   trim : ${mask(trimKey)}`);
  console.log(`[DIAG] TRELLO_TOKEN     raw  : ${mask(rawToken)}`);
  console.log(`[DIAG] TRELLO_TOKEN     trim : ${mask(trimToken)}`);
  console.log(`[DIAG] raw===trim key   : ${rawKey === trimKey}`);
  console.log(`[DIAG] raw===trim token : ${rawToken === trimToken}`);
});
