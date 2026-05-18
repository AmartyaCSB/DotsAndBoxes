# Build Plan — Sequenced Claude Code Prompts

This is a one-time build sequence. Feed these prompts to Claude Code in order, one at a time. Wait for each step to finish, verify it works, then move on. After the build is done, you can delete this file (CLAUDE.md stays for ongoing context).

Use **Plan mode** in Claude Code for steps 2, 3, 4, and 7 — they touch multiple files and benefit from review before execution.

---

## Step 0 — Drop in CLAUDE.md

Before any prompt: copy `CLAUDE.md` to the repo root. Claude Code will read it automatically on every session. Confirm by asking Claude Code: *"Summarize the project from CLAUDE.md."* If it gives you the right summary, you're good.

---

## Step 1 — Scaffold the project

> Scaffold a PartyKit + Vercel project per CLAUDE.md. Create `package.json` with these scripts: `dev` (runs `partykit dev` and esbuild watch in parallel), `build` (esbuild on `public/src/*.ts` → `public/dist/`), `deploy:party` (`partykit deploy`), `test` (`vitest`). Install: `partykit`, `partyserver`, `partysocket`, `typescript`, `esbuild`, `vitest`, `@types/node`. Create `tsconfig.json` with a path mapping so `public/src/*.ts` can import from `party/types.ts`. Create `partykit.json` declaring the `DotsAndBoxes` server class at `party/index.ts` and binding it to the route `main`. Create `vercel.json` that serves `public/` and rewrites `/` to `public/index.html` and `/room` to `public/room.html`. Don't create the source files yet — just the config.

After: run `npm install`, verify `npm run dev` starts both processes without errors.

---

## Step 2 — Types and pure game logic (plan mode)

> Implement `party/types.ts` exactly as specified in CLAUDE.md (Edge, PlayerProfile, Move, GameState, etc.). Then implement `party/game.ts` as pure functions: `createInitialState(config)`, `applyMove(state, edge, playerId)`, `boxComplete(state, r, c)`, `isGameOver(state)`, `computeWinners(state)`. No `Date.now()`, no I/O — `applyMove` takes a `serverTs` parameter. Write `party/game.test.ts` with vitest covering: empty board first move, single-box completion gives extra turn, two-box completion in one move, full game to end, ties with even player counts on even grids, rejection of out-of-bounds edges, rejection of already-drawn edges, rejection when not the player's turn.

After: `npm test` passes.

---

## Step 3 — PartyKit server (plan mode)

> Implement `party/index.ts`. Extend `Server` from `partyserver`. Hold a single `state: GameState` field. Implement `onStart` (initialize state with a default config — 5×5 grid, max 4 players — and phase `lobby`), `onConnect` (set up the connection's per-conn state with placeholder playerId, set lastSeenAt), `onMessage` (parse JSON envelope, dispatch on `type`, catch errors and send `error` envelope back to the offending connection only), `onClose` (handle voluntary leave during lobby, start 90s grace timer during a game via `ctx.storage.setAlarm`), `onAlarm` (run the cleanup pass per CLAUDE.md). Implement these handlers: `handleHello`, `handleSetProfile`, `handleStartGame`, `handleDrawEdge`, `handleLeave`, `handlePing`. Use `game.ts` for all move validation and state mutation — the server file is just routing, broadcasting, and lifecycle. Broadcast `state` after lobby changes; broadcast `move` deltas after game moves; send `welcome` only to the connecting client. Keep handlers short — ~20 lines each.

After: `npm run dev` runs. Connect with `wscat -c ws://localhost:1999/parties/main/test123` and verify you can send `{"type":"hello","payload":{"playerId":"abc"}}` and receive a `welcome` message.

---

## Step 4 — Frontend client and lobby (plan mode)

> Implement `public/index.html` (landing) and `public/room.html` (game). Use plain HTML + a script tag importing `./dist/client.js`. Style with the same dark palette as the existing single-player version. Implement `public/src/url.ts` (room id generator excluding `0oilq`, 6 lowercase chars; URL helpers). Implement `public/src/client.ts` to construct a `PartySocket`, manage a local `GameState` cache, dispatch incoming messages to event handlers, and expose a `send(type, payload)` helper. The `PARTYKIT_HOST` should come from a build-time env replacement (esbuild's `--define:PARTYKIT_HOST='"..."'`). Implement `public/src/lobby.ts` to render the lobby panel: list of players with colored swatches and names, a name input that sends `set_profile` on blur or Enter, a "Copy invite link" button, and (when current player is host) grid size dropdown, player count dropdown, and "Start game" button. Show a banner when player count is 1 reminding the host they need at least one more player.

After: open two browser tabs to `http://localhost:1999/room.html?id=test123`. Both should see each other in the lobby. The host (first to join) can set config and start.

---

## Step 5 — Game board UI

> Implement `public/src/ui.ts` by adapting the SVG rendering from the existing single-player `index.html`. Differences from single-player: (1) read everything from the local `GameState` cache rather than mutating local arrays, (2) on edge click, send `draw_edge` to the server and render the edge in a "pending" style (50% opacity, animated dash) until `move` arrives, (3) lock all input when `currentSeat !== mySeat`, (4) display the player's own seat and color prominently above the board, (5) show the scoreboard from `state.players` and `state.scores`. Listen for `move` and `state` events from `client.ts` and re-render. On `game_over`, show the winner banner; support ties (multiple winnerSeats). When `phase === 'finished'`, replace the scoreboard with a "Play again" button that sends `start_game` (host only).

After: full game playable end-to-end across two tabs.

---

## Step 6 — Disconnect, AFK, and reconnect

> Implement the inactivity logic per CLAUDE.md. In `party/index.ts`: on `onClose` during a game, mark `connected: false` and schedule the alarm. In `onAlarm`, close any connection with stale `lastSeenAt`, advance `currentSeat` past any AFK player when it lands on them in the move handler. In `public/src/client.ts`: add a 25-second `ping` interval, reconnect handling via PartySocket's built-in retry. On the UI side, dim disconnected players in the scoreboard with an "(away)" label. Test by: starting a 3-player game, killing one tab — the others should see them dimmed within ~5 seconds, and the game continues skipping their turn.

After: kill-and-restore works. Closing all tabs and reopening within a minute restores the same game; after 10 minutes, opening the URL gives a fresh lobby.

---

## Step 7 — Polish (plan mode)

> Final pass. Add: (1) a subtle pulse on the active player's scoreboard card, (2) a "last move" highlight that fades over 1 second, (3) a small toast for `error` messages from the server, (4) keyboard focus management so screen readers can navigate the edges, (5) a mobile-friendly layout — the board should scale to fit the viewport width on phones. Run a final pass on accessibility (ARIA labels on interactive elements), and write a brief README.md with the architecture and deployment commands.

---

## Step 8 — Deploy

This is manual, not a Claude Code prompt:

1. `npx partykit deploy` — note the URL it returns, e.g. `dotsandboxes.amartya.partykit.dev`.
2. Push the repo to GitHub.
3. In Vercel: import the repo, set build command `npm run build`, output directory `public`, add env var `PARTYKIT_HOST=dotsandboxes.amartya.partykit.dev`.
4. In Vercel project → Settings → Domains, add `dotsandboxes.aeonic.earth`.
5. In Porkbun → aeonic.earth → DNS, add CNAME: host `dotsandboxes`, answer `cname.vercel-dns.com`, TTL 600.
6. Wait ~5 minutes for DNS + SSL. Visit `https://dotsandboxes.aeonic.earth` and verify the landing page loads. Click "Create room", share the URL with a friend in another browser, play a game.

Done.
