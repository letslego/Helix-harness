/** Time-sortable UUIDv7 generator (RFC 9562) with process-local monotonicity. */
let lastMs = 0n;
let seq = 0;

export function uuidv7(now = Date.now()): string {
  let ms = BigInt(now);
  if (ms < lastMs) {
    ms = lastMs;
  }
  if (ms === lastMs) {
    seq += 1;
    if (seq > 0x0fff) {
      ms += 1n;
      seq = 0;
    }
  } else {
    seq = 0;
  }
  lastMs = ms;

  const bytes = new Uint8Array(16);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);

  // 12 bits of monotonic sequence in the version-nibble payload, then random.
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  crypto.getRandomValues(bytes.subarray(8));
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Reset monotonic state — test helper only. */
export function resetUuidV7StateForTests(): void {
  lastMs = 0n;
  seq = 0;
}
