# Dots and Boxes — Multiplayer

A real-time multiplayer Dots and Boxes game for 2–4 players, web-only. Target scale: ~100 weekly active players. Built for fun, not for monetization or growth.

## Architecture overview

- **Frontend:** Static site on Vercel at `dotsandboxes.aeonic.earth`. Vanilla TypeScript + HTML + SVG — no React, no framework, this is small enough to keep dependency-free on the frontend.
- **Backend:** PartyKit (Cloudflare Durable Objects under the hood). One server instance per game room. The room holds authoritative game state in memory and broadcasts state changes over WebSocket to all connected players.
- **DNS:** `aeonic.earth` is at Porkbun. The subdomain `dotsandboxes` is a CNAME to `cname.vercel-dns.com`. PartyKit lives at its own `<project>.<user>.partykit.dev` URL — no custom domain needed at this scale.
- **No database.** Games are ephemeral. State lives only in the Durable Object's memory; when the room goes idle (no connections for ~10 minutes), the DO is reclaimed and the state vanishes. This is the desired behavior, not a limitation.

## Tech stack

- **PartyKit** (`partykit`, `partysocket`) — server framework + reconnecting WebSocket client
- **TypeScript** everywhere
- **No framework on the frontend.** Build with `esbuild` or `tsc` directly, output to `public/dist/`. Keep the bundle under 50 KB gzipped.
- **No database, no auth provider, no analytics.** Player identity is a UUID stored in `localStorage`; that's it.

## Repo layout

```
dotsandboxes/
  party/
    index.ts        Server (one Durable Object per room)
    game.ts         Pure game logic (no I/O, fully testable)
    types.ts        Shared types — IMPORT FROM HERE on both sides
  public/
    index.html      Landing page: create or join
    room.html       Game UI
    src/
      client.ts     PartySocket setup, message handlers, state cache
      ui.ts         SVG board rendering (adapted from existing index.html)
      lobby.ts      Lobby panel and profile setup
      url.ts        Room id encode/decode helpers
  partykit.json     PartyKit config (party path, vars, alarms)
  package.json
  tsconfig.json
  vercel.json       Static deploy config + cache headers
  CLAUDE.md         This file
```

## Data model

All types live in `party/types.ts` and are imported by both server and client. Single source of truth.

```ts
export type Orientation = 'h' | 'v';

export interface Edge {
  orientation: Orientation;
  row: number;   // h: 0..rows, v: 0..rows-1
  col: number;   // h: 0..cols-1, v: 0..cols
}

export interface PlayerProfile {
  id: string;          // stable UUID, persisted in client localStorage
  name: string;        // display name, 1–20 chars
  color: string;       // hex, server-assigned from PALETTE
  seatIdx: number;     // 0..3, assigned by server in join order
  connected: boolean;
  isHost: boolean;
  lastSeenAt: number;  // server epoch ms; updated on any inbound message
}

export interface Move {
  playerId: string;
  edge: Edge;
  boxesCompleted: Array<[number, number]>;
  extraTurn: boolean;
  serverTs: number;
}

export type RoomPhase = 'lobby' | 'in_progress' | 'finished';

export interface GameConfig {
  rows: number;        // number of BOXES, not dots; 4..7
  cols: number;
  maxPlayers: number;  // 2..4
}

export interface GameState {
  phase: RoomPhase;
  config: GameConfig;
  players: PlayerProfile[];           // ordered by seatIdx
  currentSeat: number;
  hEdges: number[][];                 // (rows+1) x cols, -1 if undrawn, else seatIdx
  vEdges: number[][];                 // rows x (cols+1)
  boxes: number[][];                  // rows x cols, -1 if unclaimed, else seatIdx
  scores: number[];                   // length = players.length
  edgesDrawn: number;
  totalEdges: number;
  lastMove: Move | null;
  winnerSeats: number[];              // populated on game_over; supports ties
}

export const PALETTE = ['#ef476f', '#06d6a0', '#ffd166', '#118ab2'] as const;
```

### Edge → adjacent box index rule (the one mechanic that bites you if wrong)

When edge `{ orientation: 'h', row: r, col: c }` is drawn, the candidate boxes for completion are `(r-1, c)` and `(r, c)`, each only if in bounds. For `{ orientation: 'v', row: r, col: c }` the candidates are `(r, c-1)` and `(r, c)`. A box `(r, c)` is complete iff all four of `hEdges[r][c]`, `hEdges[r+1][c]`, `vEdges[r][c]`, `vEdges[r][c+1]` are `>= 0`. Always O(1) per move.

## Message protocol

Single envelope, JSON over WebSocket:

```ts
export interface Envelope<T = unknown> {
  type: string;
  payload: T;
  reqId?: string;   // client sets this; server echoes it on errors only
}
```

### Client → Server

| `type` | `payload` | Notes |
|---|---|---|
| `hello` | `{ playerId: string }` | First message after connect. Server uses `playerId` to claim a seat or restore an existing one. Sent automatically by `client.ts` on every (re)connect. |
| `set_profile` | `{ name: string }` | Only valid in `lobby` phase. Validates 1–20 chars, trims, rejects duplicates within the room. |
| `start_game` | `{ config: GameConfig }` | Host only. Server validates ≥ 2 players present, all have non-empty names. Transitions phase to `in_progress`. |
| `draw_edge` | `{ edge: Edge }` | The only in-game action. Server validates: phase is `in_progress`, sender's seat == `currentSeat`, edge in bounds, edge undrawn. |
| `leave` | `{}` | Voluntary leave. Different from disconnect — does not get a grace period. |
| `ping` | `{}` | Heartbeat from client every 25s. Server updates `lastSeenAt`, no broadcast. |

### Server → Client

| `type` | `payload` | Broadcast scope |
|---|---|---|
| `welcome` | `{ you: PlayerProfile, state: GameState }` | Sent only to the connecting client immediately after `hello` is processed. Always a full snapshot. |
| `state` | `{ state: GameState }` | Sent to everyone on lobby changes (join/leave/profile/host change/start). Full snapshot. Snapshots are cheap at this size — don't optimize prematurely. |
| `move` | `{ move: Move, currentSeat: number, scores: number[], phase: RoomPhase }` | Delta sent to everyone after every accepted `draw_edge`. Clients patch `hEdges` / `vEdges` / `boxes` locally from `move.edge` and `move.boxesCompleted`. |
| `game_over` | `{ scores: number[], winnerSeats: number[] }` | After the last edge. Clients should show the winner banner; the next `state` will have phase `finished`. |
| `error` | `{ code: string, message: string, reqId?: string }` | Sent to the offending client only. Codes: `not_your_turn`, `edge_taken`, `invalid_edge`, `not_in_lobby`, `not_host`, `room_full`, `bad_request`. |

## Game rules (the parts that need to be right)

1. **Extra turn on completion.** If `draw_edge` completes one or more boxes, the same player moves again. `move.extraTurn = boxesCompleted.length > 0`.
2. **A single edge can complete two boxes.** When closing the seam between two near-complete boxes, both get awarded. `boxesCompleted` is therefore an array, not a single value.
3. **Turn advances only when no box completes.** `if (!extraTurn) currentSeat = (currentSeat + 1) % players.length`. Skip seats whose player is currently AFK (see lifecycle below).
4. **End condition.** `edgesDrawn === totalEdges`. At that point compute `winnerSeats` (all seats tied for max score — usually one, occasionally many) and transition phase to `finished`.
5. **Ties are real and allowed.** With 2 players on an even grid, ties happen. Don't pick a winner; display all tied players.

Implement these in `party/game.ts` as pure functions over `GameState`. No `party` reference, no WebSocket — just `applyMove(state, edge, playerId): { state, move } | { error }`. This file should be 100% unit-testable.

## Lobby flow

1. User visits `dotsandboxes.aeonic.earth`. Landing page shows two buttons: **Create room** and **Join room**.
2. **Create room** → client generates a 6-char room id (lowercase alphanumeric, exclude ambiguous `0oilq`), navigates to `/room.html?id=<roomId>`. The user becomes host on first connect.
3. **Join room** → input field for room id, then same navigation. Or the user follows a shared link `https://dotsandboxes.aeonic.earth/room.html?id=<roomId>`.
4. On `room.html` load: read `id` from URL, generate or read `playerId` from `localStorage`, connect to PartyKit at `wss://<project>.<user>.partykit.dev/parties/main/<roomId>`, send `hello`.
5. Server sends `welcome`. Client renders lobby panel: list of players, color swatches, name input, "Ready" indicator, and (for host) game config (rows, cols, max players) plus a **Start game** button.
6. On `start_game` (host only, with ≥ 2 players named), server broadcasts a new `state` with `phase: 'in_progress'`. Clients hide the lobby and render the board.

### Sharing the link

The room id is in the URL. That's the whole share mechanism. A "copy invite link" button writes `location.href` to clipboard. No tokens, no invites table, no email — at this scale, knowing the URL *is* the invitation.

## Player lifecycle

- **Join:** Server reads `playerId` from `hello`. If the room is in lobby phase, append a new `PlayerProfile` to `players` with the next free seat and the next color from `PALETTE`. If the room is in `in_progress` and `playerId` matches an existing seat, restore it (`connected: true`, update `lastSeenAt`). If `in_progress` and `playerId` is unknown, reject with `room_full` (we don't allow mid-game joins).
- **Host:** The first player to connect to a fresh room is host. If the host disconnects past the grace period, promote the lowest-seat connected player.
- **Disconnect mid-game:** Mark `connected: false`. Start a 90-second grace timer (via `ctx.storage.setAlarm`). If they `hello` back with the same `playerId` before the alarm fires, restore them. If the alarm fires, leave them in `players` but mark them AFK (turns automatically skip their seat). If they later reconnect, they're back in.
- **Voluntary leave (`leave` message) in lobby:** Remove from `players`, broadcast `state`. In game: same as disconnect-past-grace — turns skip them, score frozen.
- **Last player leaves:** Room remains until Cloudflare reclaims the DO (~10 min idle). On the next connection after reclaim, the room starts fresh in lobby phase. Don't try to persist anything.

## Inactivity cleanup

Two mechanisms work together:

1. **Per-connection `lastSeenAt`.** Updated on every inbound message including `ping`. The client sends `ping` every 25 seconds.
2. **Periodic alarm.** Schedule a recurring alarm via `ctx.storage.setAlarm(now + 60_000)`. On wake:
   - For each connection where `now - lastSeenAt > 90_000`, close the socket. The `onClose` handler runs the disconnect path above.
   - If the room has been empty of connections for > 5 minutes and phase is `lobby` or `finished`, no further action needed — let Cloudflare reclaim the DO naturally.
   - If `in_progress` and zero connected players for > 5 minutes, transition phase to `finished` with no winner. Future connections see a clean lobby.
   - Re-schedule the alarm for `now + 60_000`.

Implementation lives in `party/index.ts`'s `onAlarm` method.

## PartyKit server skeleton

`party/index.ts` extends `Server` from `partyserver`:

```ts
import { Server, type Connection, type ConnectionContext } from "partyserver";
import type { GameState, Envelope, PlayerProfile } from "./types";
import * as Game from "./game";

interface ConnState {
  playerId: string;
  lastSeenAt: number;
}

export class DotsAndBoxes extends Server<Env> {
  state!: GameState;

  async onStart() { /* initialize state if first boot */ }
  async onConnect(conn: Connection<ConnState>, ctx: ConnectionContext) { /* ... */ }
  async onMessage(conn: Connection<ConnState>, raw: string) { /* dispatch on envelope.type */ }
  async onClose(conn: Connection<ConnState>) { /* start grace timer */ }
  async onAlarm() { /* cleanup pass */ }
}
```

Each method is small and dispatches to handlers (`handleHello`, `handleSetProfile`, `handleDrawEdge`, etc.). Keep the server thin — all game logic in `game.ts`.

## Client architecture

`public/src/client.ts` owns the socket and a local `GameState` cache. Pattern:

```ts
import PartySocket from "partysocket";

const socket = new PartySocket({
  host: PARTYKIT_HOST,            // build-time env var
  room: roomId,
  id: playerId,                   // for sticky reconnect
});

socket.addEventListener("open", () => send({ type: "hello", payload: { playerId } }));
socket.addEventListener("message", (e) => dispatch(JSON.parse(e.data)));

setInterval(() => send({ type: "ping", payload: {} }), 25_000);
```

`PartySocket` handles reconnect with backoff. On reconnect, we send `hello` again automatically — the server restores the seat.

Optimistic UI: when the user clicks an edge, render it immediately in a "pending" style and lock further input. On `move` from the server, replace the pending edge with the confirmed one. On `error` with `code: edge_taken` or `not_your_turn`, roll back the pending edge.

## Conventions

- All shared types in `party/types.ts`. **Never duplicate a type definition on the client.** If the client needs a type, import from `../party/types` (TypeScript path mapping in `tsconfig.json`).
- All game logic in `party/game.ts` as pure functions. No `party` access, no `Date.now()` — pass `serverTs` in.
- Server is authoritative. The client renders state it's told about; it does not compute scores or turn order on its own. The only client-side "logic" is the optimistic pending edge.
- Color and seat assignment is server-side, never client-side. Clients pick a name only.
- Room ids are lowercase alphanumeric, length 6, excluding `0`, `o`, `i`, `l`, `q`. Pick once on landing page, never regenerate.
- Don't use `localStorage` for anything except `playerId`. No game state caching on the client.
- Tests: `party/game.ts` has a `game.test.ts` next to it. Use `vitest`. Cover: empty move on empty board, single-box completion, double-box completion (the seam), extra-turn flag, end-of-game detection, ties.

## Things NOT to do

- Don't add a database. Don't add Redis. Don't add user accounts.
- Don't try to host the WebSocket on Vercel — it can't. PartyKit only.
- Don't put game logic in `index.ts`; it goes in `game.ts`.
- Don't broadcast the full state on every move; use the `move` delta. (Full snapshots on lobby changes only.)
- Don't let clients trust each other. Every message from a client must be validated server-side.
- Don't fancy up the lobby. A name field, color swatches, a list of joined players, and a start button. That's it.

## Local development

```
npm install
npm run dev          # runs partykit dev (local server on :1999) + esbuild watch on public/src
```

Open two browser windows to `http://localhost:1999` to simulate two players. PartyKit dev server proxies and serves both the API and (optionally) the static assets, but for production we split: PartyKit hosts only the WebSocket; Vercel serves the static frontend.

## Deployment

### PartyKit (game server)

```
npx partykit deploy
```

First time: it'll prompt for login, create the project under your account, and return a URL like `https://dotsandboxes.amartya.partykit.dev`. Set `PARTYKIT_HOST=dotsandboxes.amartya.partykit.dev` in Vercel's environment variables so the frontend knows where to connect.

### Vercel (frontend)

```
git push origin main
```

Vercel auto-builds and deploys. In the project settings:
1. **Build command:** `npm run build` (runs esbuild on `public/src/*.ts`, outputs to `public/dist/`).
2. **Output directory:** `public`.
3. **Environment variables:** `PARTYKIT_HOST=dotsandboxes.amartya.partykit.dev` (or whatever PartyKit gave you).
4. **Domains:** add `dotsandboxes.aeonic.earth`. Vercel will display the required DNS record.

### DNS (Porkbun)

In Porkbun → aeonic.earth → DNS Records, add:
- **Type:** CNAME
- **Host:** `dotsandboxes`
- **Answer:** `cname.vercel-dns.com`
- **TTL:** 600

Wait 1–5 minutes for propagation. Vercel auto-issues an SSL certificate. Existing `aeonic.earth` and `www.aeonic.earth` records are untouched.

## Why these choices

- **Why PartyKit and not raw Cloudflare Workers + Durable Objects?** PartyKit is a thin wrapper that handles room routing, connection lifecycle, and WebSocket boilerplate. At this scale the wrapper is pure win; if we ever needed to drop down we could, since it deploys to Cloudflare Workers anyway.
- **Why no framework on the frontend?** The UI is one SVG board plus a small lobby panel. React or Vue would be more code than the app itself. Vanilla TypeScript keeps the bundle tiny and the mental model simple.
- **Why no database?** Games are ephemeral and at 100 weekly players, persistence buys nothing. The "profiles vanish on inactivity" requirement is satisfied for free by DO hibernation.
- **Why server-authoritative?** Multiplayer turn-based games are trivially exploitable client-side ("I just claimed all the boxes"). The server validates every move. There's no scenario where this is worth skimping on.
