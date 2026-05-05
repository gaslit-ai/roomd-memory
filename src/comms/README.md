# comms

Real-time messaging in rooms. Two edges connect to a single transport-neutral core: **socket.io** for human/UI clients, and **MCP tools** for agent clients. Both speak the same envelope, validated by the same Zod schemas.

## Architecture

```
   [agents]                                  [humans / UI clients]
       │                                              │
   MCP tool call                              socket.io connection
       │                                              │
       ▼                                              ▼
   ┌─────────────────────────────────────────────────────────┐
   │              core (transport-neutral)                    │
   │   schemas (zod) · payload registry · dispatcher · bus   │
   └─────────────────────────────────────────────────────────┘
                     ▲                       ▲
                     │                       │
              McpToolAdapter         SocketIoAdapter
              (agent-side edge)       (human-side edge)
```

A message lives in the post office, not on a phone line. Agents drop letters at the MCP counter; humans drop letters at the socket.io window; the post office knows rooms, addresses, and what a valid letter looks like.

## Folder layout

```
src/comms/
├── server.ts                  Module entry: createCommsModule(config) → CommsModule
├── limits.ts                  CommsLimits (configurable defaults)
├── schemas/
│   ├── constants.ts           Eternal definitions (ULID regex, base32 alphabet)
│   ├── envelope.ts            SystemMeta + envelope generics + structural shapes
│   ├── registry.ts            PayloadRegistry — dev-supplied payload schemas
│   └── tools.ts               SendOutput, RecvInput, RecvOutput
├── core/
│   ├── types.ts               SessionContext, WireMessage
│   ├── id.ts                  ULID generator (injectable)
│   ├── bus.ts                 MessageBus interface
│   ├── in-memory-bus.ts       In-memory bus implementation
│   └── dispatcher.ts          Validation, system-meta stamping, idempotency, fan-out
└── adapters/
    ├── types.ts               CommsAdapter contract, Authenticator<T>
    ├── socketio/
    │   ├── defaults.ts        Configurable event names, namespace
    │   └── index.ts           SocketIoAdapter
    └── mcp/
        ├── defaults.ts        Configurable tool names
        └── index.ts           McpToolAdapter
```

## Quick start

`comms` is composed into the top-level MCP server via `createRoomdServer`; you do not wire it directly in production code:

```ts
import { z } from 'zod'
import { createRoomdServer } from '../server'

const ChatText = z.object({ body: z.string().max(2000) })

const server = createRoomdServer({
  comms: {
    payloads: [
      { type: 'chat.text', schema: ChatText, description: 'A chat message body.' },
    ],
    socketio: {
      port: 4310,
      cors: { origin: '*' },
      authenticator: ({ token }) => {
        if (!token) throw new Error('missing token')
        return { userId: verifyToken(token), rooms: roomsForUser(token) }
      },
    },
    mcp: {
      authenticator: ({ extra }) => deriveClaimsFromMcpRequest(extra),
    },
  },
})

await server.start()
// Connect server.mcp to whichever transport you want (stdio, streamable HTTP, in-memory).
```

A runnable example with both surfaces wired up — socket.io and MCP over Streamable HTTP — lives at [examples/comms-server.ts](../../examples/comms-server.ts) and is launched via `npm run demo:comms`.

## Agent surface (MCP tools)

| Tool | Purpose | Input | Output |
|---|---|---|---|
| `comms.send` | Publish a message to the rooms the session is bound to | `{ type, payload, reply_to?, client_msg_id?, meta? }` | `{ id, ts, delivered_to }` |
| `comms.recv` | Read recent messages addressed to the session's rooms | `{ since?, limit?, type_filter? }` | `{ messages: ReceivedMessage[] }` |

Notes for agent integrators:
- `type` is constrained to the discriminator enum of registered payload types; the description text enumerates them with their per-type descriptions.
- The agent does not specify rooms — routing is server-side, derived from session config.
- Server-stamped fields (`id`, `ts`, `sender`, `session`, `room`, `delivered_at`) are added at dispatch and never accepted from the caller.
- `client_msg_id` is an **idempotency** key. Resending with the same id within the session window returns the prior result without re-publishing.
- The agent receives its own messages back via recv (consistent with the room being the canonical view); dedupe by `id` if you don't want them.

## Wire surface (socket.io)

Default namespace `/comms`. Default event names (configurable):

| Event | Direction | Args |
|---|---|---|
| `send` | client → server | `(envelope, ack)` — ack receives `{ ok: true, data: SendOutput } \| { ok: false, error }` |
| `recv` | client → server | `(query, ack)` — ack receives `{ ok: true, data: ReceivedMessage[] } \| { ok: false, error }` |
| `message` | server → client | `(ReceivedMessage)` — pushed for every message in any of the session's rooms |

Auth: the client passes credentials via `auth.token` in the handshake. The middleware calls the configured authenticator and attaches a `SessionContext` to the socket.

## The envelope

```
SystemMeta (server-stamped, read-only to caller)
  id              ULID         monotonic, sortable
  ts              ISO datetime server clock
  sender          UserId       from session auth
  session         SessionId    connection identity
  room            RoomId       fan-out target

Routing (caller-supplied)
  type            string       discriminator into registered payloads
  reply_to        ULID?        threading
  client_msg_id   string?      retry-dedup idempotency key
  meta            object?      bounded free-form

Payload (caller-supplied, validated by registered schema for `type`)
  payload         <user-defined>
```

`ReceivedShape` adds `delivered_at` (per-recipient timestamp) on top.

## Configuration

Two layers of overridable values (defaults are sensible; override per deployment):

- **Operational limits** ([limits.ts](limits.ts)) — `metaByteLimit`, `clientMsgIdMin/MaxLength`, `recvLimitMin/Max/Default`, `recentBufferPerRoom`, `idempotencyWindowSize`, etc. Pass `limits: { … }` in `createCommsModule(config)`.
- **Identity limits** ([../shared/limits.ts](../shared/limits.ts)) — `idMinLength`, `idMaxLength`. Pass `identity: { limits: { … } }`.

Eternal definitions (ULID regex, Crockford alphabet) live in [schemas/constants.ts](schemas/constants.ts) and are not configurable — those are definitions, not choices.

Adapter-level customization:
- Socket.io: `namespace`, `events`, `cors`, `path`.
- MCP: `toolNames`.

## Adapter contract

Both adapters consume a single `AdapterContext = { dispatcher: Dispatcher }`. The dispatcher exposes everything an adapter needs:

- `attach(session)` / `detach(session)` — register a session with the bus on connect/disconnect.
- `send(envelope, session)` — validate envelope against the registry union, stamp system meta, fan out via the bus, return `DispatchResult`.
- `recv(session, query)` — validate the query against `RecvInput`, read recent messages from the bus.

Adapters never touch the bus directly. Swapping the in-memory bus for a Redis-backed one is invisible to adapters.

## Design invariants (recap)

1. Agents and humans are the same kind of user.
2. Rooms are server-configured per session; agents don't specify them.
3. Fire-and-forget — no acks, no delivery guarantees.
4. The room is the unit of shared context across comms / collab / memory; identity types belong in `src/shared/`, not in `src/comms/`.

These appear in the project-level memory and govern all schema / API decisions here.

## Testing

```bash
npm run typecheck              # tsc --noEmit
npm run test                   # node:test runtime smoke
npm run demo:comms             # spin up the demo server on :4310
```

End-to-end smoke at [src/__tests__/comms.smoke.ts](../__tests__/comms.smoke.ts) exercises:

- Socket.io fan-out (Alice sends, Alice + Bob both receive)
- Socket.io polling via `recv`
- Validation rejection of unknown payload types
- MCP tool registration + invocation via `InMemoryTransport`
- MCP validation rejection
