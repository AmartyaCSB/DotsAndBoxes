import type { Edge, GameConfig, GameState, Move, PlayerProfile } from './types';
import { ERROR_CODES, type ErrorCode } from './types';

export interface ApplyMoveSuccess {
  state: GameState;
  move: Move;
}
export interface ApplyMoveFailure {
  error: ErrorCode;
}
export type ApplyMoveResult = ApplyMoveSuccess | ApplyMoveFailure;

function makeGrid<T>(rows: number, cols: number, value: T): T[][] {
  const out: T[][] = [];
  for (let r = 0; r < rows; r++) {
    out.push(Array(cols).fill(value));
  }
  return out;
}

export function totalEdgesFor(config: GameConfig): number {
  const { rows, cols } = config;
  return (rows + 1) * cols + rows * (cols + 1);
}

export function createInitialState(config: GameConfig, players: PlayerProfile[] = []): GameState {
  return {
    phase: 'lobby',
    config,
    players,
    currentSeat: 0,
    hEdges: makeGrid(config.rows + 1, config.cols, -1),
    vEdges: makeGrid(config.rows, config.cols + 1, -1),
    boxes: makeGrid(config.rows, config.cols, -1),
    scores: Array(players.length).fill(0),
    edgesDrawn: 0,
    totalEdges: totalEdgesFor(config),
    lastMove: null,
    winnerSeats: [],
  };
}

export function startGame(state: GameState, config: GameConfig): GameState {
  const fresh = createInitialState(config, state.players);
  return {
    ...fresh,
    phase: 'in_progress',
    players: state.players.map(p => ({ ...p })),
    scores: Array(state.players.length).fill(0),
    currentSeat: 0,
  };
}

export function edgeInBounds(state: GameState, edge: Edge): boolean {
  const { rows, cols } = state.config;
  if (edge.orientation === 'h') {
    return edge.row >= 0 && edge.row <= rows && edge.col >= 0 && edge.col < cols;
  }
  return edge.row >= 0 && edge.row < rows && edge.col >= 0 && edge.col <= cols;
}

export function edgeOwner(state: GameState, edge: Edge): number {
  const grid = edge.orientation === 'h' ? state.hEdges : state.vEdges;
  return grid[edge.row][edge.col];
}

export function boxComplete(state: GameState, r: number, c: number): boolean {
  return (
    state.hEdges[r][c] >= 0 &&
    state.hEdges[r + 1][c] >= 0 &&
    state.vEdges[r][c] >= 0 &&
    state.vEdges[r][c + 1] >= 0
  );
}

function adjacentBoxes(state: GameState, edge: Edge): Array<[number, number]> {
  const { rows, cols } = state.config;
  const out: Array<[number, number]> = [];
  if (edge.orientation === 'h') {
    if (edge.row - 1 >= 0) out.push([edge.row - 1, edge.col]);
    if (edge.row < rows) out.push([edge.row, edge.col]);
  } else {
    if (edge.col - 1 >= 0) out.push([edge.row, edge.col - 1]);
    if (edge.col < cols) out.push([edge.row, edge.col]);
  }
  return out;
}

function nextSeat(state: GameState): number {
  const n = state.players.length;
  if (n === 0) return 0;
  let seat = state.currentSeat;
  for (let i = 0; i < n; i++) {
    seat = (seat + 1) % n;
    const p = state.players[seat];
    if (p && p.connected) return seat;
  }
  return (state.currentSeat + 1) % n;
}

export function applyMove(
  state: GameState,
  edge: Edge,
  playerId: string,
  serverTs: number,
): ApplyMoveResult {
  if (state.phase !== 'in_progress') return { error: ERROR_CODES.NOT_IN_GAME };
  if (!edgeInBounds(state, edge)) return { error: ERROR_CODES.INVALID_EDGE };

  const currentPlayer = state.players[state.currentSeat];
  if (!currentPlayer || currentPlayer.id !== playerId) {
    return { error: ERROR_CODES.NOT_YOUR_TURN };
  }
  if (edgeOwner(state, edge) >= 0) return { error: ERROR_CODES.EDGE_TAKEN };

  const hEdges = state.hEdges.map(row => row.slice());
  const vEdges = state.vEdges.map(row => row.slice());
  const boxes = state.boxes.map(row => row.slice());
  const scores = state.scores.slice();

  if (edge.orientation === 'h') hEdges[edge.row][edge.col] = state.currentSeat;
  else vEdges[edge.row][edge.col] = state.currentSeat;

  const intermediate: GameState = {
    ...state,
    hEdges,
    vEdges,
    boxes,
    scores,
  };

  const boxesCompleted: Array<[number, number]> = [];
  for (const [br, bc] of adjacentBoxes(intermediate, edge)) {
    if (boxes[br][bc] < 0 && boxComplete(intermediate, br, bc)) {
      boxes[br][bc] = state.currentSeat;
      scores[state.currentSeat]++;
      boxesCompleted.push([br, bc]);
    }
  }

  const edgesDrawn = state.edgesDrawn + 1;
  const extraTurn = boxesCompleted.length > 0;
  const move: Move = {
    playerId,
    edge,
    boxesCompleted,
    extraTurn,
    serverTs,
  };

  let phase: GameState['phase'] = state.phase;
  let winnerSeats = state.winnerSeats;
  let currentSeat = state.currentSeat;

  const gameOver = edgesDrawn === state.totalEdges;
  if (gameOver) {
    phase = 'finished';
    const max = Math.max(...scores);
    winnerSeats = scores
      .map((s, i) => (s === max ? i : -1))
      .filter(i => i >= 0);
  } else if (!extraTurn) {
    const probe: GameState = { ...intermediate, scores, boxes, currentSeat: state.currentSeat };
    currentSeat = nextSeat(probe);
  }

  const next: GameState = {
    ...intermediate,
    edgesDrawn,
    currentSeat,
    phase,
    winnerSeats,
    lastMove: move,
  };

  return { state: next, move };
}

export function isGameOver(state: GameState): boolean {
  return state.edgesDrawn === state.totalEdges;
}

export function computeWinners(state: GameState): number[] {
  if (state.scores.length === 0) return [];
  const max = Math.max(...state.scores);
  return state.scores
    .map((s, i) => (s === max ? i : -1))
    .filter(i => i >= 0);
}

export function advancePastAfk(state: GameState): GameState {
  if (state.phase !== 'in_progress') return state;
  const cur = state.players[state.currentSeat];
  if (cur && cur.connected) return state;
  return { ...state, currentSeat: nextSeat(state) };
}
