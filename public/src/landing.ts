import { generateRoomId, isValidRoomId } from './url';

declare const PARTYKIT_HOST: string;

async function loadStats() {
  try {
    const protocol = PARTYKIT_HOST.startsWith('localhost') ? 'http' : 'https';
    const r = await fetch(`${protocol}://${PARTYKIT_HOST}/parties/stats/counter`);
    if (!r.ok) return;
    const data = await r.json() as { gamesCompleted?: number; gamesInProgress?: number };
    const live = document.getElementById('stat-live');
    const total = document.getElementById('stat-total');
    if (live) live.textContent = (data.gamesInProgress ?? 0).toLocaleString();
    if (total) total.textContent = (data.gamesCompleted ?? 0).toLocaleString();
  } catch { /* ignore */ }
}
loadStats();
setInterval(loadStats, 30_000);

document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('dab.theme', next);
});

const createBtn = document.getElementById('create-btn') as HTMLButtonElement;
const joinForm = document.getElementById('join-form') as HTMLFormElement;
const joinInput = document.getElementById('join-input') as HTMLInputElement;
const joinErr = document.getElementById('join-error') as HTMLDivElement;

createBtn?.addEventListener('click', () => {
  const id = generateRoomId();
  location.href = `/room.html?id=${id}`;
});

joinForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = joinInput.value.trim().toLowerCase();
  if (!isValidRoomId(v)) {
    joinErr.hidden = false;
    joinErr.textContent = 'Room codes are 6 letters/digits (no 0, o, i, l, q).';
    return;
  }
  joinErr.hidden = true;
  location.href = `/room.html?id=${v}`;
});
