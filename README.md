# roomd-memory

A multi-agent collaboration platform exposed as a single MCP server. Agents and humans share **rooms**; each room is a context that holds messages, shared documents, and persistent memory. Three subsystems compose under one MCP entry point:

| Subsystem | Folder | What it does | Status |
|---|---|---|---|
| **comms** | [src/comms/](src/comms/) | Real-time messaging in rooms (socket.io for humans, MCP tools for agents) | Implemented |
| **collab** | [src/collab/](src/collab/) | Shared document space (Google Docs / Sheets style) per room | Not started |
| **memory** | [src/memory/](src/memory/) | Persistent knowledge per (user, room) | Not started |

The top-level [src/server.ts](src/server.ts) is the composition root — `createRoomdServer(config)` builds one `McpServer` and registers tools from every configured subsystem. Examples and the eventual production entry point go through this factory; nothing wires comms (or any subsystem) directly.

## Core concepts

- **User** — anyone interacting with the system. Agents and humans are indistinguishable at the protocol level; both are users.
- **Session** — one connected client. Bound to a user and to one or more rooms by server config.
- **Room** — the unit of shared context across all three subsystems. Configured by the developer who spins up the MCP server; agents never name rooms in their tool calls.
- **Membership** — which users belong to which rooms.

These primitives live in [src/shared/](src/shared/) and are imported by every subsystem. Do not redefine them inside `comms/`, `collab/`, or `memory/`.

## Project layout

```
src/
├── server.ts          MCP server entry (composes subsystems — owned by top-level)
├── shared/            Cross-subsystem primitives: User, Session, Room, Membership
├── config/            Shared configuration schema
├── comms/             Real-time messaging — see src/comms/README.md
├── collab/            Shared documents (planned)
└── memory/            Persistent knowledge (planned)

examples/              Runnable demos
src/__tests__/         End-to-end smoke tests
```

## Dev setup

Requires Node 22+.

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run test           # node:test runtime smoke tests
npm run demo:comms     # spin up createRoomdServer with the comms subsystem
```

The demo serves two surfaces:

| Surface | Port | Audience |
|---|---|---|
| socket.io | `:4310` (`PORT`) | human/UI clients |
| MCP Streamable HTTP | `:4311` (`MCP_PORT`) | agent clients |

Verifying the wire is alive:

```bash
# socket.io engine.io handshake
curl -i 'http://localhost:4310/socket.io/?EIO=4&transport=polling'
# → HTTP/1.1 200 OK   0{"sid":"…","upgrades":["websocket"],…}

# MCP initialize (returns mcp-session-id header in real response)
curl -i -X POST http://localhost:4311/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# → HTTP/1.1 200 OK   mcp-session-id: <uuid>
#   event: message
#   data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"roomd-memory-demo",…}},…}

# Then subsequent calls (using the captured session id) can list and call tools:
SESSION=<uuid from previous response>
curl -X POST http://localhost:4311/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -X POST http://localhost:4311/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"comms.send","arguments":{"type":"chat.text","payload":{"body":"hello from curl"}}}}'
# → structuredContent: { id: "01KQ…", ts: "2026-05-04T…Z", delivered_to: 0 }
```

For a full client/server roundtrip without curl, see [src/__tests__/comms.smoke.ts](src/__tests__/comms.smoke.ts) and [examples/comms-server.ts](examples/comms-server.ts).

## Subsystems

- **[src/comms/README.md](src/comms/README.md)** — messaging architecture, adapter contract, schema layer, configuration reference.
- collab and memory READMEs will live alongside their implementations as those subsystems land.

## Design invariants

Cross-subsystem rules that shape every decision in this repo:

1. Agents and humans are the same kind of user. No `origin` or actor-type field at the protocol level.
2. Rooms are server-configured per session. Agents do not specify routing; the server fans out to whatever rooms the session is bound to.
3. Comms is fire-and-forget — no acks, no delivery guarantees. `client_msg_id` is a retry-dedup hint only.
4. The unit of shared context across comms / collab / memory is the **room**. Identity types live in `src/shared/`, not inside any subsystem.
