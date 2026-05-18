import type { Edge, GameState, Move, PlayerProfile } from '../../party/types';

interface BoardHandlers {
  tryDrawEdge: (edge: Edge) => void;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const CELL = 70;
const PAD = 28;

let handlers: BoardHandlers;
let boardEl: SVGSVGElement;
let scoreEl: HTMLDivElement;
let statusEl: HTMLDivElement;
let gameEl: HTMLDivElement;
let boardWrapEl: HTMLDivElement;
let youPillEl: HTMLDivElement;
let endgameEl: HTMLDivElement;
let winnerBannerEl: HTMLDivElement;
let playAgainBtn: HTMLButtonElement;

let pending: Edge | null = null;
let lastMoveEdge: Edge | null = null;

export function initBoard(h: BoardHandlers) {
  handlers = h;
  boardEl = byId<SVGSVGElement>('board');
  scoreEl = byId<HTMLDivElement>('scoreboard');
  statusEl = byId<HTMLDivElement>('status');
  gameEl = byId<HTMLDivElement>('game');
  boardWrapEl = byId<HTMLDivElement>('board-wrapper');
  youPillEl = byId<HTMLDivElement>('you-pill');
  endgameEl = byId<HTMLDivElement>('endgame');
  winnerBannerEl = byId<HTMLDivElement>('winner-banner');
  playAgainBtn = byId<HTMLButtonElement>('play-again-btn');

  byId<HTMLButtonElement>('leave-btn-game').addEventListener('click', () => {
    import('./client').then(c => c.leave());
  });
  byId<HTMLButtonElement>('back-home-btn').addEventListener('click', () => {
    location.href = '/';
  });
  playAgainBtn.addEventListener('click', () => {
    // Re-use the current grid as the new config
    import('./client').then(c => {
      const ctx = c.getContext();
      if (!ctx.state) return;
      c.startGame({
        rows: ctx.state.config.rows,
        cols: ctx.state.config.cols,
        maxPlayers: ctx.state.config.maxPlayers,
      });
    });
  });
}

export function setPending(edge: Edge) { pending = edge; }
export function clearPending() { pending = null; }

export function applyMoveLocal(
  state: GameState,
  move: Move,
  currentSeat: number,
  scores: number[],
  phase: GameState['phase'],
): GameState {
  // Patch a delta into the local state so we don't wait for a full state snapshot.
  const hEdges = state.hEdges.map(r => r.slice());
  const vEdges = state.vEdges.map(r => r.slice());
  const boxes  = state.boxes.map(r => r.slice());

  // The seat that drew the move is whoever currently owned the turn before applying.
  // Without that info, derive it from move.playerId.
  const drawerSeat = state.players.find(p => p.id === move.playerId)?.seatIdx ?? state.currentSeat;
  if (move.edge.orientation === 'h') hEdges[move.edge.row][move.edge.col] = drawerSeat;
  else vEdges[move.edge.row][move.edge.col] = drawerSeat;
  for (const [r, c] of move.boxesCompleted) boxes[r][c] = drawerSeat;

  // Persistent last-move marker — stays until the next move replaces it.
  lastMoveEdge = move.edge;

  return {
    ...state,
    hEdges,
    vEdges,
    boxes,
    scores,
    edgesDrawn: state.edgesDrawn + 1,
    currentSeat,
    phase,
    lastMove: move,
  };
}

export function renderBoard(state: GameState, me: PlayerProfile | null) {
  const inGame = state.phase !== 'lobby';
  gameEl.hidden = !inGame;
  boardWrapEl.hidden = !inGame;
  statusEl.hidden = !inGame;

  if (!inGame) {
    endgameEl.hidden = true;
    return;
  }

  renderYouPill(state, me);
  renderScoreboard(state, me);
  renderSvg(state, me);
  renderStatus(state, me);
  renderEndgame(state, me);
}

function renderYouPill(state: GameState, me: PlayerProfile | null) {
  if (!me) { youPillEl.textContent = ''; return; }
  const turn = state.currentSeat === me.seatIdx && state.phase === 'in_progress';
  youPillEl.innerHTML = `
    <span class="swatch" style="background:${me.color}; vertical-align:middle; display:inline-block; margin-right:6px;"></span>
    You are <strong style="color:${me.color}">${escapeHtml(me.name || '…')}</strong>
    ${turn ? ' — <em>your turn</em>' : ''}
  `;
}

function renderScoreboard(state: GameState, me: PlayerProfile | null) {
  scoreEl.innerHTML = '';
  state.players.forEach((p, i) => {
    const card = document.createElement('div');
    const isActive = i === state.currentSeat && state.phase === 'in_progress';
    card.className = 'player-card'
      + (isActive ? ' active' : '')
      + (!p.connected ? ' afk' : '');
    card.innerHTML = `
      <span class="swatch" style="background:${p.color}"></span>
      <span class="player-name">${escapeHtml(p.name || '(unnamed)')}</span>
      ${!p.connected ? '<span class="badge muted">away</span>' : ''}
      ${me && p.id === me.id ? '<span class="badge muted">you</span>' : ''}
      <span class="player-score">${state.scores[i] ?? 0}</span>
    `;
    scoreEl.appendChild(card);
  });
}

function renderSvg(state: GameState, me: PlayerProfile | null) {
  const { rows, cols } = state.config;
  const N_DOTS_ROWS = rows + 1;
  const N_DOTS_COLS = cols + 1;
  const width = PAD * 2 + cols * CELL;
  const height = PAD * 2 + rows * CELL;
  boardEl.setAttribute('width', String(width));
  boardEl.setAttribute('height', String(height));
  boardEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
  boardEl.innerHTML = '';

  const connectedCount = state.players.filter(p => p.connected).length;
  const myTurn = me && state.currentSeat === me.seatIdx && state.phase === 'in_progress' && connectedCount >= 2;

  // Box fills + labels
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const owner = state.boxes[r][c];
      if (owner < 0) continue;
      const x = PAD + c * CELL;
      const y = PAD + r * CELL;
      const color = state.players[owner]?.color ?? '#888';
      const rect = document.createElementNS(SVGNS, 'rect');
      rect.setAttribute('class', 'box-fill');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(CELL));
      rect.setAttribute('height', String(CELL));
      rect.setAttribute('fill', color + 'cc');
      boardEl.appendChild(rect);

      const label = document.createElementNS(SVGNS, 'text');
      label.setAttribute('class', 'box-label');
      label.setAttribute('x', String(x + CELL / 2));
      label.setAttribute('y', String(y + CELL / 2));
      label.textContent = 'P' + (owner + 1);
      boardEl.appendChild(label);
    }
  }

  const makeLine = (edge: Edge, x1: number, y1: number, x2: number, y2: number) => {
    const drawn = (edge.orientation === 'h' ? state.hEdges : state.vEdges)[edge.row][edge.col] >= 0;
    const isPending = !!pending && pending.orientation === edge.orientation && pending.row === edge.row && pending.col === edge.col;
    const isLastMove = !!lastMoveEdge && lastMoveEdge.orientation === edge.orientation && lastMoveEdge.row === edge.row && lastMoveEdge.col === edge.col;
    const locked = !myTurn || drawn || isPending;

    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'line-group'
      + (drawn ? ' drawn' : '')
      + (locked ? ' locked' : ''));

    const visible = document.createElementNS(SVGNS, 'line');
    const cls = ['line'];
    if (drawn) cls.push('drawn');
    if (isPending) cls.push('pending');
    if (isLastMove && drawn) cls.push('last-move');
    visible.setAttribute('class', cls.join(' '));
    visible.setAttribute('x1', String(x1));
    visible.setAttribute('y1', String(y1));
    visible.setAttribute('x2', String(x2));
    visible.setAttribute('y2', String(y2));
    g.appendChild(visible);

    if (!drawn && !isPending) {
      const hit = document.createElementNS(SVGNS, 'line');
      hit.setAttribute('class', 'line-hit');
      hit.setAttribute('x1', String(x1));
      hit.setAttribute('y1', String(y1));
      hit.setAttribute('x2', String(x2));
      hit.setAttribute('y2', String(y2));
      hit.setAttribute('tabindex', myTurn ? '0' : '-1');
      hit.setAttribute('role', 'button');
      hit.setAttribute('aria-label', `Draw ${edge.orientation === 'h' ? 'horizontal' : 'vertical'} edge at row ${edge.row}, column ${edge.col}`);
      if (myTurn) {
        const fire = () => handlers.tryDrawEdge(edge);
        hit.addEventListener('click', fire);
        hit.addEventListener('keydown', (e: Event) => {
          const ke = e as KeyboardEvent;
          if (ke.key === 'Enter' || ke.key === ' ') { ke.preventDefault(); fire(); }
        });
      }
      g.appendChild(hit);
    }

    boardEl.appendChild(g);
  };

  // Horizontal edges: rows = rows+1, cols = cols
  for (let r = 0; r < N_DOTS_ROWS; r++) {
    for (let c = 0; c < cols; c++) {
      const x1 = PAD + c * CELL;
      const x2 = PAD + (c + 1) * CELL;
      const y = PAD + r * CELL;
      makeLine({ orientation: 'h', row: r, col: c }, x1, y, x2, y);
    }
  }

  // Vertical edges: rows = rows, cols = cols+1
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < N_DOTS_COLS; c++) {
      const x = PAD + c * CELL;
      const y1 = PAD + r * CELL;
      const y2 = PAD + (r + 1) * CELL;
      makeLine({ orientation: 'v', row: r, col: c }, x, y1, x, y2);
    }
  }

  // Dots on top
  for (let r = 0; r < N_DOTS_ROWS; r++) {
    for (let c = 0; c < N_DOTS_COLS; c++) {
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('class', 'dot');
      dot.setAttribute('cx', String(PAD + c * CELL));
      dot.setAttribute('cy', String(PAD + r * CELL));
      dot.setAttribute('r', '5');
      boardEl.appendChild(dot);
    }
  }
}

function renderStatus(state: GameState, me: PlayerProfile | null) {
  if (state.phase !== 'in_progress') {
    statusEl.textContent = '';
    return;
  }
  const connectedCount = state.players.filter(p => p.connected).length;
  if (connectedCount < 2) {
    statusEl.textContent = 'Waiting for another player to reconnect…';
    statusEl.style.color = '';
    return;
  }
  const cur = state.players[state.currentSeat];
  if (!cur) { statusEl.textContent = ''; return; }
  if (me && cur.id === me.id) {
    statusEl.textContent = "Your turn — click a line";
    statusEl.style.color = cur.color;
  } else {
    statusEl.textContent = `${cur.name || 'Player'}'s turn`;
    statusEl.style.color = cur.color;
  }
}

function renderEndgame(state: GameState, me: PlayerProfile | null) {
  if (state.phase !== 'finished') {
    endgameEl.hidden = true;
    return;
  }
  endgameEl.hidden = false;
  const winners = state.winnerSeats;
  const maxScore = winners.length ? state.scores[winners[0]] : 0;
  if (winners.length === 1) {
    const w = state.players[winners[0]];
    winnerBannerEl.textContent = `🏆 ${w?.name || 'Player'} wins with ${maxScore} boxes!`;
  } else if (winners.length > 1) {
    const names = winners.map(i => state.players[i]?.name || `P${i + 1}`).join(', ');
    winnerBannerEl.textContent = `🤝 Tie between ${names} (${maxScore} boxes each)`;
  } else {
    winnerBannerEl.textContent = 'Game ended.';
  }
  // "Play again" is host-only
  playAgainBtn.hidden = !(me && me.isHost);
}

function byId<T extends HTMLElement | SVGSVGElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as unknown as T;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
