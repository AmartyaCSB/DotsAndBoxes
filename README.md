# Dots and Boxes — Multiplayer

Real-time multiplayer Dots and Boxes for 2–4 players. Web-only.

## Architecture

- **Frontend:** static site (`public/`) — plain HTML + TypeScript + SVG, no framework. Bundled with esbuild to `public/dist/`. Deploys to Vercel.
- **Backend:** PartyKit (Cloudflare Durable Objects). One DO per room, holds authoritative `GameState` in memory, broadcasts deltas over WebSocket.
- **No database.** Games are ephemeral — when a room is idle for ~10 min the DO is reclaimed and state vanishes. By design.

See [CLAUDE.md](./CLAUDE.md) for the full architectural rationale and conventions.

## Repo layout

```
party/
  types.ts         shared types (imported by both server and client)
  game.ts          pure game logic, fully unit-testable
  game.test.ts     vitest suite
  index.ts         PartyKit Server (lifecycle + routing only)
public/
  index.html       landing page (create / join)
  room.html        game UI shell
  styles.css       all UI styles
  src/
    landing.ts     landing page script
    client.ts      WebSocket + state cache + action dispatcher
    lobby.ts       lobby panel renderer
    ui.ts          SVG board renderer
    url.ts         room-id, player-id helpers
partykit.json      PartyKit config
vercel.json        static deploy config
package.json       scripts + deps
tsconfig.json      TS config with @party/* path mapping
```

## Local development

```
npm install
npm run dev        # starts partykit dev (:1999) + esbuild watch in parallel
```

Open two browser windows at `http://localhost:1999/` to simulate two players: create a room in one, copy the link, open it in the other.

```
npm test           # runs the game-logic vitest suite
```

## Deployment

### 1) PartyKit (game server)

```
npx partykit deploy
```

First time it'll prompt for login and return a host URL like `dotsandboxes.<yourname>.partykit.dev`. Save that.

### 2) Vercel (frontend)

Import the repo in Vercel. Settings:

- **Build command:** `npm run build`
- **Output directory:** `public`
- **Environment variables:** `PARTYKIT_HOST=dotsandboxes.<yourname>.partykit.dev`

Push to `main` and Vercel auto-deploys.

### 3) Domain

In Vercel → Domains add `dotsandboxes.aeonic.earth`. In Porkbun DNS add a CNAME from `dotsandboxes` → `cname.vercel-dns.com`, TTL 600. SSL is auto-issued by Vercel.

## How the game works

1. Players take turns drawing one edge between adjacent dots.
2. Completing the 4th side of a 1×1 box claims it for that player **and grants another turn** — chains are how you score.
3. A single edge can close two boxes (the seam between near-complete boxes), awarding both.
4. Game ends when every edge is drawn. Highest box count wins; ties supported.

## Things to know

- Player identity is a UUID in `localStorage`. No accounts.
- Color and seat are server-assigned in join order.
- Disconnects show as "away" — the game continues, skipping their seat. Reconnecting within the room's lifetime restores the seat.
- All game logic and validation lives server-side. The client only renders state it's told about (plus an optimistic pending edge for the player's own move).

