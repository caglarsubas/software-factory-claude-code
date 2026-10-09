/** The total after a percentage discount, rounded to the nearest cent. */
export function applyDiscount(totalCents: number, percent: number): number {
  const p = Math.min(Math.max(percent, 0), 100);
  return Math.round((totalCents * (100 - p)) / 100);
}
