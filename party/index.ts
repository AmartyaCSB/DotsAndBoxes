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
}

const GRACE_MS = 90_000;
const STALE_MS = 90_000;
const ALARM_PERIOD_MS = 60_000;
const EMPTY_FINISH_MS = 5 * 60_000;

export default class DotsAndBoxes implements Party.Server {
  state: GameState = Game.createInitialState(DEFAULT_CONFIG);
  emptySince: number | null = null;

  constructor(readonly room: Party.Room) {}

  async onStart() {
    await this.room.storage.setAlarm(Date.now() + ALARM_PERIOD_MS);
  }

  onConnect(conn: Party.Connection<ConnState>) {
    conn.setState({ playerId: '', lastSeenAt: Date.now() });
    this.emptySince = null;
  }

  onMessage(raw: string, sender: Party.Connection<ConnState>) {
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
      }
    } else {
      this.emptySince = null;
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
    const dup = this.state.players.some(p => p.id !== me.id && p.name && p.name.toLowerCase() === name.toLowerCase());
    if (dup) return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'name taken', env.reqId);
    me.name = name;
    this.broadcastState();
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
  }

  private handleDrawEdge(conn: Party.Connection<ConnState>, env: Envelope) {
    const me = this.findPlayer(conn);
    if (!me) return this.sendError(conn, ERROR_CODES.BAD_REQUEST, 'unknown player', env.reqId);
    const edge = (env.payload as { edge?: any })?.edge;
    if (!edge || (edge.orientation !== 'h' && edge.orientation !== 'v') ||
        typeof edge.row !== 'number' || typeof edge.col !== 'number') {
      return this.sendError(conn, ERROR_CODES.INVALID_EDGE, 'malformed edge', env.reqId);
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
    this.state.players.splice(idx, 1);
    this.state.scores.splice(idx, 1);
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
