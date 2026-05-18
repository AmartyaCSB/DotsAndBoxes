export type Orientation = 'h' | 'v';

export interface Edge {
  orientation: Orientation;
  row: number;
  col: number;
}

export interface PlayerProfile {
  id: string;
  name: string;
  color: string;
  seatIdx: number;
  connected: boolean;
  isHost: boolean;
  lastSeenAt: number;
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
  rows: number;
  cols: number;
  maxPlayers: number;
}

export interface GameState {
  phase: RoomPhase;
  config: GameConfig;
  players: PlayerProfile[];
  currentSeat: number;
  hEdges: number[][];
  vEdges: number[][];
  boxes: number[][];
  scores: number[];
  edgesDrawn: number;
  totalEdges: number;
  lastMove: Move | null;
  winnerSeats: number[];
}

export interface Envelope<T = unknown> {
  type: string;
  payload: T;
  reqId?: string;
}

export const PALETTE = ['#71cbb0', '#cf6d8b', '#bcb680', '#7981c3'] as const;

export const DEFAULT_CONFIG: GameConfig = {
  rows: 5,
  cols: 5,
  maxPlayers: 4,
};

export const ERROR_CODES = {
  NOT_YOUR_TURN: 'not_your_turn',
  EDGE_TAKEN: 'edge_taken',
  INVALID_EDGE: 'invalid_edge',
  NOT_IN_LOBBY: 'not_in_lobby',
  NOT_HOST: 'not_host',
  ROOM_FULL: 'room_full',
  BAD_REQUEST: 'bad_request',
  NOT_IN_GAME: 'not_in_game',
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];
