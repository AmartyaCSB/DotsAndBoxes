import type * as Party from 'partykit/server';
import * as Game from './game';
import type {
  Envelope,
  GameConfig,
  GameState,
  PlayerProfile,
  ErrorCode,
} from './types';
import { DEFAULT_CONFIG, ERROR_CODES, PALETTE } from './types';

interface ConnState {
  playerId: string;
  lastSeenAt: number;
  tokens: number;       // current bucket level
  tokensRefilledAt: number;  // last refill timestamp
  violations: number;   // count of times this conn hit the limit
}

// Token bucket: 30 burst, refills at 10/sec (one token per 100ms).
const BUCKET_MAX = 30;
const BUCKET_REFILL_PER_MS = 10 / 1000; // 0.01 tokens/ms
const MAX_VIOLATIONS_BEFORE_KICK = 5;

const GRACE_MS = 90_000;
const STALE_MS = 90_000;
const ALARM_PERIOD_MS = 30_000;
const EMPTY_FINISH_MS = 2 * 60_000;
const UNDERPOPULATED_FINISH_MS = 2 * 60_000;

const ALLOWED_ORIGINS: RegExp[] = [
  /^https:\/\/dotsandboxes\.aeonic\.earth$/,
  /^https:\/\/[a-z0-9.-]+\.vercel\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

const INVALID_NAME_CHARS = /[<>\x00-\x1f\x7f]/;

export default class DotsAndBoxes implements Party.Server {
  state: GameState = Game.createInitialState(DEFAULT_CONFIG);
  emptySince: number | null = null;
  underpopulatedSince: number | null = null;

  constructor(readonly room: Party.Room) {}

  // Reject WebSocket upgrades from origins we don't recognize. PartyKit's URL is
  // public — without this, any page could open a socket and burn quota.
  static async onBeforeConnect(req: Party.Request): Promise<Response | Request> {
    const origin = req.headers.get('origin') || '';
    if (!ALLOWED_ORIGINS.some(p => p.test(origin))) {
      return new Response('Forbidden origin', { status: 403 });
    }
    return req;
  }

  onRequest(_req: Party.Request): Response {
    return new Response('Method Not Allowed', { status: 405 });
  }

  async onStart() {
    await this.room.storage.setAlarm(Date.now() + ALARM_PERIOD_MS);
  }

  onConnect(conn: Party.Connection<ConnState>) {
    conn.setState({
      playerId: '',
      lastSeenAt: Date.now(),
      tokens: BUCKET_MAX,
      tokensRefilledAt: Date.now(),
      violations: 0,
    });
    this.emptySince = null;
  }

  onMessage(raw: string, sender: Party.Connection<ConnState>) {
    if (!this.consumeToken(sender)) return;  // dropped due to rate limit
    if (typeof raw === 'string' && raw.length > 4096) {
      return this.sendError(sender, ERROR_CODES.BAD_REQUEST, 'message too large');
    }
    let env: Envelope;
    try {
      env = JSON.parse(raw);
    } catch {
      return this.sendError(sender, ERROR_CODES.BAD_REQUEST, 'invalid JSON');
    }
    this.touchConn(sender);
    try {
      switch (env.type) {
        case 'hello':        return this.handleHello(sender, env);
        case 'set_profile':  return this.handleSetProfile(sender, env);
        case 'start_game':   return this.handleStartGame(sender, env);
        case 'draw_edge':    return this.handleDrawEdge(sender, env);
        case 'leave':        return this.handleLeave(sender);
        case 'request_rematch': return this.handleRequestRematch(sender, env);
        case 'ping':         return;
        default:             return this.sendError(sender, ERROR_CODES.BAD_REQUEST, `unknown type: ${env.type}`, env.reqId);
      }
    } catch (err) {
      this.sendError(sender, ERROR_CODES.BAD_REQUEST, (err as Error).message, env.reqId);
    }
  }

  onClose(conn: Party.Connection<ConnState>) {
    const playerId = conn.state?.playerId;
    if (!playerId) { this.checkEmpty(); return; }
    const idx = this.state.players.findIndex(p => p.id === playerId);
    if (idx < 0) { this.checkEmpty(); return; }
    if (this.state.phase === 'lobby') {
      this.removePlayer(idx);
      this.broadcastState();
    } else {
      this.state.players[idx].connected = false;
      this.state = Game.advancePastAfk(this.state);
      this.broadcastState();
      this.room.storage.setAlarm(Date.now() + Math.min(ALARM_PERIOD_MS, GRACE_MS));
    }
    this.checkEmpty();
  }

  async onAlarm() {
    const now = Date.now();
    const prevPhase = this.state.phase;
    for (const conn of this.room.getConnections<ConnState>()) {
      const cs = conn.state;
      if (!cs) continue;
      if (now - cs.lastSeenAt > STALE_MS) {
        try { conn.close(); } catch { /* ignore */ }
      }
    }
    const liveConns = Array.from(this.room.getConnections<ConnState>()).length;
    if (liveConns === 0) {
      if (!this.emptySince) this.emptySince = now;
      if (this.state.phase === 'in_progress' && now - this.emptySince > EMPTY_FINISH_MS) {
        this.state = { ...this.state, phase: 'finished', winnerSeats: Game.computeWinners(this.state) };
        this.broadcastState();
      }
    } else {
      this.emptySince = null;
    }

    // Auto-finish in-progress games that drop below 2 connected players for 2 min
    if (this.state.phase === 'in_progress') {
      const connected = this.state.players.filter(p => p.connected).length;
      if (connected < 2) {
        if (!this.underpopulatedSince) this.underpopulatedSince = now;
        if (now - this.underpopulatedSince > UNDERPOPULATED_FINISH_MS) {
          this.state = { ...this.state, phase: 'finished', winnerSeats: Game.computeWinners(this.state) };
          this.underpopulatedSince = null;
          this.broadcastState();
        }
      } else {
        this.underpopulatedSince = null;
      }
    } else {
      this.underpopulatedSince = null;
    }

    // Notify the stats party
    if (this.state.phase === 'in_progress') {
      void this.pingStats('heartbeat');
    } else if (prevPhase === 'in_progress' && this.state.phase === 'finished') {
      void this.pingStats('game_ended');
    }

    await this.room.storage.setAlarm(now + ALARM_PERIOD_MS);
  }

  // ---------- Handlers ----------

  private handleHello(conn: Party.Connection<ConnState>, env: Envelope) {
    const payload = env.payload as { playerId?: string } | undefined;
    const playerId = payload?.playerId;
    if (!playerId || typeof playerId !== 'string') {
      return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'missing playerId', env.reqId);
    }
    conn.setState({ playerId, lastSeenAt: Date.now() });

    const existing = this.state.players.find(p => p.id === playerId);
    if (existing) {
      existing.connected = true;
      existing.lastSeenAt = Date.now();
      this.sendTo(conn, { type: 'welcome', payload: { you: existing, state: this.state } });
      this.broadcastState();
      return;
    }

    if (this.state.phase !== 'lobby') {
      return this.sendError(conn, ERROR_CODES.ROOM_FULL, 'game in progress', env.reqId);
    }
    if (this.state.players.length >= this.state.config.maxPlayers) {
      return this.sendError(conn, ERROR_CODES.ROOM_FULL, 'lobby full', env.reqId);
    }

    const seatIdx = this.state.players.length;
    const profile: PlayerProfile = {
      id: playerId,
      name: '',
      color: PALETTE[seatIdx % PALETTE.length],
      seatIdx,
      connected: true,
      isHost: this.state.players.length === 0,
      lastSeenAt: Date.now(),
    };
    this.state.players.push(profile);
    this.state.scores.push(0);
    this.sendTo(conn, { type: 'welcome', payload: { you: profile, state: this.state } });
    this.broadcastState();
  }

  private handleSetProfile(conn: Party.Connection<ConnState>, env: Envelope) {
    if (this.state.phase !== 'lobby') {
      return this.sendError(conn, ERROR_CODES.NOT_IN_LOBBY, 'profile locked', env.reqId);
    }
    const me = this.findPlayer(conn);
    if (!me) return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'no profile', env.reqId);
    const raw = (env.payload as { name?: unknown })?.name;
    if (typeof raw !== 'string') {
      return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'name must be string', env.reqId);
    }
    const name = raw.trim().slice(0, 20);
    if (name.length < 1) {
      return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'name required', env.reqId);
    }
    if (INVALID_NAME_CHARS.test(name)) {
      return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'name contains invalid characters', env.reqId);
    }
    const dup = this.state.players.some(p => p.id !== me.id && p.name && p.name.toLowerCase() === name.toLowerCase());
    if (dup) return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'name taken', env.reqId);
    me.name = name;
    this.broadcastState();
  }

  private async pingStats(type: 'heartbeat' | 'game_ended') {
    try {
      const ctx = (this.room as any).context;
      const stats = ctx?.parties?.stats?.get?.('counter');
      if (!stats) return;
      await stats.fetch({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, roomId: this.room.id }),
      });
    } catch { /* never let stats errors break gameplay */ }
  }

  private handleStartGame(conn: Party.Connection<ConnState>, env: Envelope) {
    const me = this.findPlayer(conn);
    if (!me) return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'unknown player', env.reqId);
    if (!me.isHost) return this.sendError(conn, ERROR_CODES.NOT_HOST, 'only host can start', env.reqId);
    if (this.state.phase === 'in_progress') return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'already running', env.reqId);
    if (this.state.players.length < 2) return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'need 2+ players', env.reqId);
    if (this.state.players.some(p => !p.name)) return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'all players need a name', env.reqId);

    const incoming = (env.payload as { config?: Partial<GameConfig> })?.config;
    const config = this.sanitizeConfig(incoming);
    this.state = Game.startGame(this.state, config);
    this.broadcastState();
    void this.pingStats('heartbeat');
  }

  private handleDrawEdge(conn: Party.Connection<ConnState>, env: Envelope) {
    const me = this.findPlayer(conn);
    if (!me) return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'unknown player', env.reqId);
    const edge = (env.payload as { edge?: any })?.edge;
    if (!edge || (edge.orientation !== 'h' && edge.orientation !== 'v') ||
        typeof edge.row !== 'number' || typeof edge.col !== 'number') {
      return this.sendError(conn, ERROR_CODES.INVALID_EDGE, 'malformed edge', env.reqId);
    }
    const connectedCount = this.state.players.filter(p => p.connected).length;
    if (connectedCount < 2) {
      return this.sendError(conn, ERROR_CODES.NOT_IN_GAME, 'Waiting for another player to join', env.reqId);
    }
    this.state = Game.advancePastAfk(this.state);
    const result = Game.applyMove(this.state, edge, me.id, Date.now());
    if ('error' in result) {
      return this.sendError(conn, result.error, errorMessage(result.error), env.reqId);
    }
    this.state = result.state;
    const phase = this.state.phase;
    this.broadcast({
      type: 'move',
      payload: {
        move: result.move,
        currentSeat: this.state.currentSeat,
        scores: this.state.scores,
        phase,
      },
    });
    if (phase === 'finished') {
      this.broadcast({
        type: 'game_over',
        payload: { scores: this.state.scores, winnerSeats: this.state.winnerSeats },
      });
      this.broadcastState();
      void this.pingStats('game_ended');
    }
  }

  private handleRequestRematch(conn: Party.Connection<ConnState>, env: Envelope) {
    if (this.state.phase !== 'finished') {
      return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'game not finished', env.reqId);
    }
    const me = this.findPlayer(conn);
    if (!me) return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'unknown player', env.reqId);
    if (!this.state.rematchVotes.includes(me.id)) {
      this.state.rematchVotes.push(me.id);
      this.broadcastState();
    }
  }

  private handleLeave(conn: Party.Connection<ConnState>) {
    const idx = this.state.players.findIndex(p => p.id === conn.state?.playerId);
    if (idx < 0) return;
    if (this.state.phase === 'lobby') {
      this.removePlayer(idx);
    } else {
      this.state.players[idx].connected = false;
      this.state = Game.advancePastAfk(this.state);
    }
    this.broadcastState();
    try { conn.close(); } catch { /* ignore */ }
  }

  // ---------- Helpers ----------

  // Token-bucket rate limit. Returns false if the conn is over budget — in
  // that case the message is dropped (and the conn closed after repeat abuse).
  private consumeToken(conn: Party.Connection<ConnState>): boolean {
    const cs = conn.state;
    if (!cs) return true;
    const now = Date.now();
    const refilled = Math.min(
      BUCKET_MAX,
      cs.tokens + (now - cs.tokensRefilledAt) * BUCKET_REFILL_PER_MS,
    );
    if (refilled < 1) {
      const violations = cs.violations + 1;
      conn.setState({ ...cs, tokens: refilled, tokensRefilledAt: now, violations });
      this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'rate limit exceeded');
      if (violations >= MAX_VIOLATIONS_BEFORE_KICK) {
        try { conn.close(1008, 'rate limit'); } catch { /* ignore */ }
      }
      return false;
    }
    conn.setState({ ...cs, tokens: refilled - 1, tokensRefilledAt: now });
    return true;
  }

  private touchConn(conn: Party.Connection<ConnState>) {
    const cs = conn.state;
    if (cs) conn.setState({ ...cs, lastSeenAt: Date.now() });
    const me = this.findPlayer(conn);
    if (me) me.lastSeenAt = Date.now();
  }

  private findPlayer(conn: Party.Connection<ConnState>): PlayerProfile | undefined {
    const pid = conn.state?.playerId;
    if (!pid) return undefined;
    return this.state.players.find(p => p.id === pid);
  }

  private removePlayer(idx: number) {
    const leavingId = this.state.players[idx]?.id;
    this.state.players.splice(idx, 1);
    this.state.scores.splice(idx, 1);
    if (leavingId) {
      this.state.rematchVotes = this.state.rematchVotes.filter(id => id !== leavingId);
    }
    this.state.players.forEach((p, i) => {
      p.seatIdx = i;
      p.color = PALETTE[i % PALETTE.length];
      p.isHost = false;
    });
    if (this.state.players.length > 0) {
      const next = this.state.players.find(p => p.connected) ?? this.state.players[0];
      next.isHost = true;
    }
    if (this.state.phase === 'in_progress' && this.state.players.length < 2) {
      this.state = { ...this.state, phase: 'finished', winnerSeats: Game.computeWinners(this.state) };
    }
  }

  private sanitizeConfig(c: Partial<GameConfig> | undefined): GameConfig {
    const rows = clamp(c?.rows ?? DEFAULT_CONFIG.rows, 2, 8);
    const cols = clamp(c?.cols ?? DEFAULT_CONFIG.cols, 2, 8);
    const maxPlayers = clamp(c?.maxPlayers ?? DEFAULT_CONFIG.maxPlayers, 2, 4);
    return { rows, cols, maxPlayers };
  }

  private sendTo(conn: Party.Connection, env: Envelope) {
    try { conn.send(JSON.stringify(env)); } catch { /* ignore */ }
  }

  private broadcast(env: Envelope) {
    this.room.broadcast(JSON.stringify(env));
  }

  private broadcastState() {
    this.broadcast({ type: 'state', payload: { state: this.state } });
  }

  private sendError(conn: Party.Connection, code: ErrorCode, message: string, reqId?: string) {
    this.sendTo(conn, { type: 'error', payload: { code, message, reqId } });
  }

  private checkEmpty() {
    const live = Array.from(this.room.getConnections<ConnState>()).length;
    if (live === 0) this.emptySince = Date.now();
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function errorMessage(code: ErrorCode): string {
  switch (code) {
    case ERROR_CODES.NOT_YOUR_TURN: return "Not your turn";
    case ERROR_CODES.EDGE_TAKEN:    return "Edge already drawn";
    case ERROR_CODES.INVALID_EDGE:  return "Invalid edge";
    case ERROR_CODES.NOT_IN_LOBBY:  return "Not in lobby";
    case ERROR_CODES.NOT_HOST:      return "Only the host can do that";
    case ERROR_CODES.ROOM_FULL:     return "Room is full";
    case ERROR_CODES.NOT_IN_GAME:   return "Game not running";
    default:                        return "Bad request";
  }
}
