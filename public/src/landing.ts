import { generateRoomId, isValidRoomId } from './url';

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
