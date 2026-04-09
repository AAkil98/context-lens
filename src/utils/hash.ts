/**
 * FNV-1a 32-bit hash — deterministic, non-cryptographic.
 * @see cl-spec-007 R-178
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

export function fnv1aHex(input: string): string {
  return fnv1a(input).toString(16).padStart(8, '0');
}
