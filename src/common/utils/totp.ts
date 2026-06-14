import { createHmac, randomBytes } from 'crypto';

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32_CHARS[(value << (5 - bits)) & 31];
  return result;
}

export function base32Decode(str: string): Buffer {
  const s = str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of s) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function generateTotpToken(secret: string, window = 0): string {
  const keyBuffer = base32Decode(secret);
  const timeStep  = Math.floor(Date.now() / 1000 / 30) + window;
  const buf       = Buffer.alloc(8);
  // Write 64-bit big-endian integer
  const high = Math.floor(timeStep / 0x100000000);
  const low  = timeStep >>> 0;
  buf.writeUInt32BE(high, 0);
  buf.writeUInt32BE(low,  4);

  const hmac   = createHmac('sha1', keyBuffer);
  hmac.update(buf);
  const digest = hmac.digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const code   =
    ((digest[offset]     & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8)  |
     (digest[offset + 3] & 0xff);

  return (code % 1_000_000).toString().padStart(6, '0');
}

export function verifyTotp(secret: string, token: string, windowSize = 1): boolean {
  for (let w = -windowSize; w <= windowSize; w++) {
    if (generateTotpToken(secret, w) === token) return true;
  }
  return false;
}

export function buildOtpAuthUri(secret: string, email: string, issuer = 'EduBridge'): string {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(email)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
