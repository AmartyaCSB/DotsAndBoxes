const ALPHABET = 'abcdefghjkmnprstuvwxyz23456789';

export function generateRoomId(): string {
  let id = '';
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  for (const b of buf) id += ALPHABET[b % ALPHABET.length];
  return id;
}

export function isValidRoomId(id: string): boolean {
  if (id.length !== 6) return false;
  for (const ch of id) {
    if (!ALPHABET.includes(ch)) return false;
  }
  return true;
}

export function getRoomIdFromUrl(): string | null {
  const params = new URLSearchParams(location.search);
  const id = (params.get('id') || '').toLowerCase();
  return isValidRoomId(id) ? id : null;
}

export function roomUrl(id: string): string {
  return `${location.origin}/room.html?id=${id}`;
}

export function getOrCreatePlayerId(): string {
  // Dev override: ?as=alice gives this tab its own stable player id without
  // touching the localStorage one. Useful for opening multiple tabs in the
  // same browser during local development.
  const override = new URLSearchParams(location.search).get('as');
  if (override) return `dev-${override}`;

  const KEY = 'dab.playerId';
  let pid = localStorage.getItem(KEY);
  if (!pid) {
    pid = crypto.randomUUID();
    localStorage.setItem(KEY, pid);
  }
  return pid;
}

export function getStoredName(): string {
  return localStorage.getItem('dab.name') || '';
}
export function setStoredName(name: string): void {
  localStorage.setItem('dab.name', name);
}
