import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TRELLO_BASE_URL = "https://api.trello.com/1";

function getCredentials() {
  const key = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) {
    throw new Error(
      "Variáveis de ambiente TRELLO_API_KEY e TRELLO_TOKEN são obrigatórias"
    );
  }
  return { key, token };
}

async function trello(path, method = "GET", body = null) {
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
            list_id: {
              type: "string",
              description: "ID da lista onde o card será criado",
            },
            name: { type: "string", description: "Nome/título do card" },
            description: {
              type: "string",
              description: "Descrição do card (opcional)",
            },
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
          const boards = await trello(
            "/members/me/boards?fields=id,name,url,closed"
          );
          const open = boards.filter((b) => !b.closed);
          return {
            content: [{ type: "text", text: JSON.stringify(open, null, 2) }],
          };
        }

        case "list_lists": {
          const lists = await trello(
            `/boards/${args.board_id}/lists?fields=id,name,closed`
          );
          const open = lists.filter((l) => !l.closed);
          return {
            content: [{ type: "text", text: JSON.stringify(open, null, 2) }],
          };
        }

        case "list_cards": {
          const cards = await trello(
            `/lists/${args.list_id}/cards?fields=id,name,desc,due,url,closed`
          );
          return {
            content: [{ type: "text", text: JSON.stringify(cards, null, 2) }],
          };
        }

        case "create_card": {
          const body = {
            idList: args.list_id,
            name: args.name,
            ...(args.description && { desc: args.description }),
          };
          const card = await trello("/cards", "POST", body);
          return {
            content: [
              {
                type: "text",
                text: `Card criado!\nID: ${card.id}\nNome: ${card.name}\nURL: ${card.url}`,
              },
            ],
          };
        }

        case "archive_card": {
          const card = await trello(`/cards/${args.card_id}`, "PUT", {
            closed: true,
          });
          return {
            content: [
              {
                type: "text",
                text: `Card "${card.name}" (${card.id}) arquivado com sucesso.`,
              },
            ],
          };
        }

        case "move_card": {
          const card = await trello(`/cards/${args.card_id}`, "PUT", {
            idList: args.list_id,
          });
          return {
            content: [
              {
                type: "text",
                text: `Card "${card.name}" movido para a lista ${args.list_id}.`,
              },
            ],
          };
        }

        default:
          throw new Error(`Ferramenta desconhecida: ${name}`);
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Erro: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id"],
    exposedHeaders: ["Mcp-Session-Id"],
  })
);

app.use(express.json());

// Endpoint MCP: Streamable HTTP transport (stateless — sem session por request)
app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  const mcpServer = createMcpServer();

  res.on("finish", () => {
    mcpServer.close().catch(() => {});
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Erro no request MCP:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Erro interno do servidor MCP" });
    }
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "trello-mcp", version: "1.0.0" });
});

app.get("/", (_req, res) => {
  res.json({
    name: "Trello MCP Server",
    version: "1.0.0",
    endpoint: "/mcp",
    transport: "Streamable HTTP (stateless)",
    tools: [
      "list_boards",
      "list_lists",
      "list_cards",
      "create_card",
      "archive_card",
      "move_card",
    ],
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Trello MCP server rodando na porta ${PORT}`);
  console.log(`Endpoint MCP: http://0.0.0.0:${PORT}/mcp`);
});
