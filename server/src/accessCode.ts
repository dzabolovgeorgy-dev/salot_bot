// Алфавит без символов, которые легко перепутать при переписывании кода
// с экрана на бумажку: нет 0/O, нет 1/I/L
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// Короткий код для входа мастера/админа в PWA-версию без Telegram
export function generateAccessCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}
