import type { GameState, PlayerProfile } from '../../party/types';

interface LobbyHandlers {
  setMyName: (name: string) => void;
  startGame: (config: { rows: number; cols: number; maxPlayers: number }) => void;
  copyInviteLink: () => void;
  leave: () => void;
}

let handlers: LobbyHandlers;
let nameFormEl: HTMLFormElement;
let nameInputEl: HTMLInputElement;
let nameSaveBtnEl: HTMLButtonElement;
let hostPanelEl: HTMLDivElement;
let playersListEl: HTMLDivElement;
let startBtnEl: HTMLButtonElement;
let lobbyRootEl: HTMLDivElement;
let warningEl: HTMLDivElement;
let savedName = '';

export function initLobby(h: LobbyHandlers) {
  handlers = h;
  lobbyRootEl = byId<HTMLDivElement>('lobby');
  nameFormEl = byId<HTMLFormElement>('name-form');
  nameInputEl = byId<HTMLInputElement>('name-input');
  nameSaveBtnEl = byId<HTMLButtonElement>('name-save-btn');
  hostPanelEl = byId<HTMLDivElement>('host-panel');
  playersListEl = byId<HTMLDivElement>('players-list');
  startBtnEl = byId<HTMLButtonElement>('start-btn');
  warningEl = byId<HTMLDivElement>('lobby-warning');

  nameFormEl.addEventListener('submit', (e) => {
    e.preventDefault();
    commitName();
    nameInputEl.blur();
  });
  nameInputEl.addEventListener('input', refreshSaveBtn);
  byId<HTMLButtonElement>('copy-link-btn').addEventListener('click', () => handlers.copyInviteLink());
  byId<HTMLButtonElement>('leave-btn').addEventListener('click', () => handlers.leave());

  startBtnEl.addEventListener('click', () => {
    const rows = +byId<HTMLSelectElement>('cfg-rows').value;
    const cols = rows;
    const maxPlayers = +byId<HTMLSelectElement>('cfg-max').value;
    handlers.startGame({ rows, cols, maxPlayers });
  });

  refreshSaveBtn();
}

function commitName() {
  const n = nameInputEl.value.trim().slice(0, 20);
  if (!n) return;
  handlers.setMyName(n);
}

function refreshSaveBtn() {
  const typed = nameInputEl.value.trim();
  if (!typed) {
    nameSaveBtnEl.disabled = true;
    nameSaveBtnEl.textContent = 'Save';
    nameSaveBtnEl.classList.add('accent');
    return;
  }
  if (savedName && typed === savedName) {
    nameSaveBtnEl.disabled = true;
    nameSaveBtnEl.textContent = 'Saved';
    nameSaveBtnEl.classList.remove('accent');
    nameSaveBtnEl.classList.add('ghost');
  } else {
    nameSaveBtnEl.disabled = false;
    nameSaveBtnEl.textContent = 'Save';
    nameSaveBtnEl.classList.add('accent');
    nameSaveBtnEl.classList.remove('ghost');
  }
}

export function renderLobby(state: GameState, me: PlayerProfile | null) {
  const inLobby = state.phase === 'lobby';
  lobbyRootEl.hidden = !inLobby;
  if (!inLobby) return;

  // Name input — keep the stored value unless server already gave us a name
  savedName = me?.name ?? '';
  if (me && me.name && nameInputEl.value !== me.name && document.activeElement !== nameInputEl) {
    nameInputEl.value = me.name;
  }
  refreshSaveBtn();

  // Player list
  playersListEl.innerHTML = '';
  state.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `
      <span class="swatch" style="background:${p.color}"></span>
      <span class="player-row-name">${escapeHtml(p.name || '(naming…)')}</span>
      ${p.isHost ? '<span class="badge">host</span>' : ''}
      ${me && p.id === me.id ? '<span class="badge muted">you</span>' : ''}
    `;
    playersListEl.appendChild(row);
  });

  // Host panel visibility
  const iAmHost = !!(me && me.isHost);
  hostPanelEl.hidden = !iAmHost;

  const namedCount = state.players.filter(p => !!p.name).length;
  const canStart = state.players.length >= 2 && namedCount === state.players.length;
  startBtnEl.disabled = !canStart;

  if (state.players.length < 2) {
    warningEl.hidden = false;
    warningEl.textContent = 'Share the invite link — at least 2 players needed.';
  } else if (namedCount < state.players.length) {
    warningEl.hidden = false;
    warningEl.textContent = 'Waiting on all players to choose a name…';
  } else {
    warningEl.hidden = true;
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
