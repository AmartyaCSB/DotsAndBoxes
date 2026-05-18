import PartySocket from 'partysocket';
import { inject } from '@vercel/analytics';
import type { Envelope, GameState, Move, PlayerProfile } from '../../party/types';

// Vercel Web Analytics
inject();
import { getOrCreatePlayerId, getRoomIdFromUrl, getStoredName, setStoredName, roomUrl } from './url';
import { initLobby, renderLobby } from './lobby';
import { initBoard, renderBoard, applyMoveLocal, setPending, clearPending } from './ui';

declare const PARTYKIT_HOST: string;

interface ClientCtx {
  socket: PartySocket;
  state: GameState | null;
  me: PlayerProfile | null;
  pendingEdge: { orientation: 'h' | 'v'; row: number; col: number } | null;
}

const ctx: ClientCtx = {
  socket: null as unknown as PartySocket,
  state: null,
  me: null,
  pendingEdge: null,
};

const roomId = getRoomIdFromUrl();
if (!roomId) {
  location.replace('/');
  throw new Error('invalid room id');
}

const playerId = getOrCreatePlayerId();

const socket = new PartySocket({
  host: PARTYKIT_HOST,
  room: roomId,
  id: playerId,
});
ctx.socket = socket;

socket.addEventListener('open', () => {
  send('hello', { playerId });
});

socket.addEventListener('close', () => {
  setStatus('Reconnecting…');
});

socket.addEventListener('message', (ev) => {
  let env: Envelope;
  try { env = JSON.parse(ev.data); } catch { return; }
  dispatch(env);
});

setInterval(() => send('ping', {}), 25_000);

function send<T>(type: string, payload: T, reqId?: string) {
  try {
    socket.send(JSON.stringify({ type, payload, reqId }));
  } catch { /* not open yet */ }
}

function dispatch(env: Envelope) {
  switch (env.type) {
    case 'welcome': {
      const p = env.payload as { you: PlayerProfile; state: GameState };
      ctx.me = p.you;
      ctx.state = p.state;
      // Restore name if we already had one stored
      const stored = getStoredName();
      if (stored && !p.you.name) send('set_profile', { name: stored });
      renderAll();
      setStatus('Connected');
      return;
    }
    case 'state': {
      const p = env.payload as { state: GameState };
      ctx.state = p.state;
      if (ctx.me) {
        const refreshed = p.state.players.find(pl => pl.id === ctx.me!.id);
        if (refreshed) ctx.me = refreshed;
      }
      renderAll();
      return;
    }
    case 'move': {
      const p = env.payload as { move: Move; currentSeat: number; scores: number[]; phase: GameState['phase'] };
      if (!ctx.state) return;
      ctx.state = applyMoveLocal(ctx.state, p.move, p.currentSeat, p.scores, p.phase);
      clearPending();
      ctx.pendingEdge = null;
      renderAll();
      return;
    }
    case 'game_over': {
      // The next 'state' message will follow with phase=finished; nothing extra needed here.
      return;
    }
    case 'error': {
      const p = env.payload as { code: string; message: string };
      // If the server rejected our pending edge, clear it
      if (ctx.pendingEdge && (p.code === 'edge_taken' || p.code === 'not_your_turn' || p.code === 'invalid_edge')) {
        clearPending();
        ctx.pendingEdge = null;
        renderAll();
      }
      showToast(p.message || p.code);
      return;
    }
  }
}

// ------- Public actions wired into the UI -------

export function setMyName(name: string) {
  setStoredName(name);
  send('set_profile', { name });
}

export function startGame(config: { rows: number; cols: number; maxPlayers: number }) {
  send('start_game', { config });
}

export function requestRematch() {
  send('request_rematch', {});
}

export function addBot() {
  send('add_bot', {});
}

export function removeBot(botId: string) {
  send('remove_bot', { botId });
}

export function leave() {
  send('leave', {});
  location.href = '/';
}

export function tryDrawEdge(edge: { orientation: 'h' | 'v'; row: number; col: number }) {
  if (!ctx.state || !ctx.me) return;
  if (ctx.state.phase !== 'in_progress') return;
  if (ctx.state.currentSeat !== ctx.me.seatIdx) return;
  if (ctx.pendingEdge) return;
  const humanCount = ctx.state.players.filter(p => p.connected && !p.isBot).length;
  const totalActive = ctx.state.players.filter(p => p.connected).length;
  if (humanCount < 1 || totalActive < 2) {
    showToast('Waiting for another player');
    return;
  }
  // Already drawn locally? (race)
  const grid = edge.orientation === 'h' ? ctx.state.hEdges : ctx.state.vEdges;
  if (grid[edge.row][edge.col] >= 0) return;
  ctx.pendingEdge = edge;
  setPending(edge);
  send('draw_edge', { edge });
}

export function copyInviteLink() {
  if (!roomId) return;
  navigator.clipboard.writeText(roomUrl(roomId)).then(
    () => showToast('Invite link copied'),
    () => showToast('Copy failed — select and copy manually'),
  );
}

export function getContext(): { state: GameState | null; me: PlayerProfile | null; roomId: string } {
  return { state: ctx.state, me: ctx.me, roomId: roomId! };
}

// ------- Rendering -------

function renderAll() {
  if (!ctx.state) return;
  renderLobby(ctx.state, ctx.me);
  renderBoard(ctx.state, ctx.me);
}

function setStatus(s: string) {
  const el = document.getElementById('connection-status');
  if (el) el.textContent = s;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function showToast(msg: string) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove('show'), 2400);
}

// Theme toggle
document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('dab.theme', next);
});

// Populate room-code badges + wire copy buttons
const codeUpper = roomId!.toUpperCase();
document.querySelectorAll<HTMLElement>('.room-code-text').forEach(el => {
  el.textContent = codeUpper;
});
document.querySelectorAll<HTMLButtonElement>('[data-copy-code]').forEach(btn => {
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(codeUpper).then(
      () => showToast('Room code copied'),
      () => showToast('Copy failed — long-press to copy'),
    );
  });
});

// Boot the UI shells
initLobby({ setMyName, startGame, copyInviteLink, leave, addBot, removeBot });
initBoard({ tryDrawEdge });
