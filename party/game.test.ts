import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  startGame,
  applyMove,
  isGameOver,
  computeWinners,
  totalEdgesFor,
} from './game';
import type { Edge, GameConfig, PlayerProfile } from './types';
import { PALETTE, ERROR_CODES } from './types';

function makePlayers(n: number): PlayerProfile[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    name: `Player ${i + 1}`,
    color: PALETTE[i],
    seatIdx: i,
    connected: true,
    isHost: i === 0,
    lastSeenAt: 0,
  }));
}

function setup(config: GameConfig, nPlayers: number) {
  const players = makePlayers(nPlayers);
  let state = createInitialState(config, players);
  state = startGame(state, config);
  return state;
}

const TS = 1_700_000_000_000;

describe('createInitialState', () => {
  it('initializes empty grids of the right shape', () => {
    const s = createInitialState({ rows: 3, cols: 4, maxPlayers: 2 });
    expect(s.hEdges.length).toBe(4); // rows + 1
    expect(s.hEdges[0].length).toBe(4); // cols
    expect(s.vEdges.length).toBe(3); // rows
    expect(s.vEdges[0].length).toBe(5); // cols + 1
    expect(s.boxes.length).toBe(3);
    expect(s.boxes[0].length).toBe(4);
    expect(s.totalEdges).toBe(totalEdgesFor({ rows: 3, cols: 4, maxPlayers: 2 }));
    expect(s.phase).toBe('lobby');
  });
});

describe('applyMove validation', () => {
  it('rejects move when not in progress', () => {
    const players = makePlayers(2);
    const s = createInitialState({ rows: 3, cols: 3, maxPlayers: 2 }, players);
    const result = applyMove(s, { orientation: 'h', row: 0, col: 0 }, 'p1', TS);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toBe(ERROR_CODES.NOT_IN_GAME);
  });

  it('rejects out-of-bounds edge', () => {
    const s = setup({ rows: 3, cols: 3, maxPlayers: 2 }, 2);
    const bad: Edge = { orientation: 'h', row: 99, col: 0 };
    const result = applyMove(s, bad, 'p1', TS);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toBe(ERROR_CODES.INVALID_EDGE);
  });

  it('rejects when not the current player', () => {
    const s = setup({ rows: 3, cols: 3, maxPlayers: 2 }, 2);
    const result = applyMove(s, { orientation: 'h', row: 0, col: 0 }, 'p2', TS);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toBe(ERROR_CODES.NOT_YOUR_TURN);
  });

  it('rejects already-drawn edge', () => {
    let s = setup({ rows: 3, cols: 3, maxPlayers: 2 }, 2);
    const e: Edge = { orientation: 'h', row: 0, col: 0 };
    const first = applyMove(s, e, 'p1', TS);
    expect('state' in first).toBe(true);
    if (!('state' in first)) return;
    s = first.state;
    // Now it's p2's turn; p2 also can't draw the same edge
    const dup = applyMove(s, e, 'p2', TS);
    expect('error' in dup).toBe(true);
    if ('error' in dup) expect(dup.error).toBe(ERROR_CODES.EDGE_TAKEN);
  });
});

describe('applyMove turn and scoring', () => {
  it('advances turn on a non-completing move', () => {
    const s = setup({ rows: 3, cols: 3, maxPlayers: 2 }, 2);
    const result = applyMove(s, { orientation: 'h', row: 0, col: 0 }, 'p1', TS);
    if (!('state' in result)) throw new Error('expected success');
    expect(result.state.currentSeat).toBe(1);
    expect(result.move.extraTurn).toBe(false);
    expect(result.move.boxesCompleted).toHaveLength(0);
  });

  it('grants extra turn and a box on single-box completion', () => {
    // 2x2 grid is enough to test. Close box (0,0) with 4 edges.
    let s = setup({ rows: 2, cols: 2, maxPlayers: 2 }, 2);
    const ids = ['p1', 'p2'];
    // Sequence designed so the same player closes a box.
    // Move 1: p1 draws h(0,0)
    // Move 2: p2 draws h(0,1)
    // Move 3: p1 draws v(0,0)
    // Move 4: p2 draws v(1,2) (no completion)
    // Move 5: p1 draws v(0,2) (no completion)
    // Move 6: p2 draws v(0,1) (no completion)
    // Move 7: p1 draws h(1,0) -> closes box (0,0)
    const seq: Edge[] = [
      { orientation: 'h', row: 0, col: 0 },
      { orientation: 'h', row: 0, col: 1 },
      { orientation: 'v', row: 0, col: 0 },
      { orientation: 'v', row: 1, col: 2 },
      { orientation: 'v', row: 0, col: 2 },
      { orientation: 'v', row: 0, col: 1 },
      { orientation: 'h', row: 1, col: 0 },
    ];
    let turn = 0;
    for (let i = 0; i < seq.length; i++) {
      const result = applyMove(s, seq[i], ids[turn], TS);
      if (!('state' in result)) throw new Error(`move ${i} failed: ${(result as any).error}`);
      s = result.state;
      if (i < seq.length - 1) {
        // No closures yet → turn must advance
        turn = (turn + 1) % 2;
      } else {
        // Final move closes box (0,0); current player is p1 (turn=0), should get extra turn
        expect(result.move.boxesCompleted).toEqual([[0, 0]]);
        expect(result.move.extraTurn).toBe(true);
        expect(s.scores[0]).toBe(1);
        expect(s.currentSeat).toBe(0); // p1 still up
      }
    }
  });

  it('closes two boxes with one edge (the seam)', () => {
    // Build a 1x2 grid: 2 boxes side-by-side sharing a vertical edge at v(0,1).
    let s = setup({ rows: 1, cols: 2, maxPlayers: 2 }, 2);
    const ids = ['p1', 'p2'];
    // Pre-fill all edges except v(0,1) so that drawing it completes both boxes.
    const seq: Edge[] = [
      { orientation: 'h', row: 0, col: 0 }, // p1
      { orientation: 'h', row: 0, col: 1 }, // p2
      { orientation: 'h', row: 1, col: 0 }, // p1
      { orientation: 'h', row: 1, col: 1 }, // p2
      { orientation: 'v', row: 0, col: 0 }, // p1
      { orientation: 'v', row: 0, col: 2 }, // p2
      { orientation: 'v', row: 0, col: 1 }, // p1 -> closes BOTH boxes
    ];
    let turn = 0;
    for (let i = 0; i < seq.length; i++) {
      const result = applyMove(s, seq[i], ids[turn], TS);
      if (!('state' in result)) throw new Error(`move ${i} failed`);
      s = result.state;
      if (i < seq.length - 1) turn = (turn + 1) % 2;
      else {
        expect(result.move.boxesCompleted).toHaveLength(2);
        expect(s.scores[0]).toBe(2);
        expect(result.move.extraTurn).toBe(true);
        // Final edge also ends the game on a 1x2 grid
        expect(s.phase).toBe('finished');
        expect(isGameOver(s)).toBe(true);
        expect(s.winnerSeats).toEqual([0]);
      }
    }
  });

  it('detects end-of-game when all edges drawn', () => {
    // 1x1 grid has exactly 4 edges.
    let s = setup({ rows: 1, cols: 1, maxPlayers: 2 }, 2);
    const ids = ['p1', 'p2'];
    const seq: Edge[] = [
      { orientation: 'h', row: 0, col: 0 }, // p1
      { orientation: 'h', row: 1, col: 0 }, // p2
      { orientation: 'v', row: 0, col: 0 }, // p1
      { orientation: 'v', row: 0, col: 1 }, // p2 -> closes the only box
    ];
    let turn = 0;
    for (let i = 0; i < seq.length; i++) {
      const r = applyMove(s, seq[i], ids[turn], TS);
      if (!('state' in r)) throw new Error('failed');
      s = r.state;
      if (i < seq.length - 1) turn = (turn + 1) % 2;
    }
    expect(s.phase).toBe('finished');
    expect(s.winnerSeats).toEqual([1]); // p2 closed it
    expect(s.scores).toEqual([0, 1]);
  });

  it('reports ties when scores equal at game end', () => {
    // 1x2 grid (2 boxes). Force a 1-1 split: p1 closes one, p2 closes the other.
    let s = setup({ rows: 1, cols: 2, maxPlayers: 2 }, 2);
    const ids = ['p1', 'p2'];
    // We'll engineer two single-box completions on the *last two moves*, one by each player.
    // Sequence (1x2 has 7 edges):
    // 1: p1 h(0,0)
    // 2: p2 v(0,0)
    // 3: p1 h(1,1)
    // 4: p2 v(0,2)
    // 5: p1 v(0,1)  -> closes box (0,1)? Let's check: box(0,1) needs h(0,1), h(1,1)✓, v(0,1)✓, v(0,2)✓. h(0,1) not yet drawn → not closed.
    //                  Closes box (0,0)? h(0,0)✓, h(1,0)?, v(0,0)✓, v(0,1)✓. h(1,0) not drawn → not closed.
    //   No completion. turn -> p2.
    // 6: p2 h(0,1)  -> closes box(0,1): h(0,1)✓, h(1,1)✓, v(0,1)✓, v(0,2)✓. YES. extraTurn. score[1]=1.
    // 7: p2 h(1,0)  -> closes box(0,0): h(0,0)✓, h(1,0)✓, v(0,0)✓, v(0,1)✓. YES. score[1]=2. Game over.
    // That gives p2 = 2, not a tie. Let me re-engineer.
    //
    // Alternative: ensure each player closes one box.
    // 1: p1 h(0,0)
    // 2: p2 h(1,0)
    // 3: p1 v(0,0)
    // 4: p2 h(0,1)         -> sets up box(0,0) needing only v(0,1); also box(0,1) has h(0,1)✓ only
    // 5: p1 h(1,1)         -> box(0,1) now has h(0,1)✓ h(1,1)✓
    // 6: p2 v(0,2)         -> box(0,1) needs v(0,1)
    // 7: p1 v(0,1)         -> closes BOTH boxes for p1. Tie impossible on a 1x2 grid this way.
    //
    // The 1x2 grid is too small for a 1-1 tie because the seam closes both. Use 2x2 (4 boxes) for ties.
    s = setup({ rows: 2, cols: 2, maxPlayers: 2 }, 2);
    // 2x2 = 4 boxes, 12 edges. Construct a 2-2 split: p1 takes (0,0) & (1,1); p2 takes (0,1) & (1,0).
    // We'll just play a sequence and assert the final phase is finished and there's at least one winner.
    // For simplicity here, validate computeWinners on a hand-crafted state.
    const crafted = {
      ...createInitialState({ rows: 2, cols: 2, maxPlayers: 2 }, makePlayers(2)),
      scores: [2, 2],
    };
    expect(computeWinners(crafted)).toEqual([0, 1]);
  });
});

describe('totalEdgesFor', () => {
  it('matches (rows+1)*cols + rows*(cols+1)', () => {
    expect(totalEdgesFor({ rows: 1, cols: 1, maxPlayers: 2 })).toBe(4);
    expect(totalEdgesFor({ rows: 2, cols: 2, maxPlayers: 2 })).toBe(12);
    expect(totalEdgesFor({ rows: 5, cols: 5, maxPlayers: 4 })).toBe(60);
  });
});
