import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createUlid(): string {
  const timestamp = Date.now();
  let value = timestamp;
  let id = "";

  for (let index = 0; index < 10; index += 1) {
    id = ALPHABET[value % 32] + id;
    value = Math.floor(value / 32);
  }

  const random = randomBytes(16);
  for (const byte of random) {
    id += ALPHABET[byte % ALPHABET.length];
  }

  return id.slice(0, 26);
}
