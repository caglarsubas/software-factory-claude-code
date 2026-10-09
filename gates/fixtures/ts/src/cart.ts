export interface Line {
  sku: string;
  unitCents: number;
  quantity: number;
}

export function totalCents(lines: readonly Line[]): number {
  return lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);
}
