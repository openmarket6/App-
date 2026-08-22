import type { Cents } from './types.js';

/** Currency is integer cents throughout. Parse at the edges, never mid-pipeline. */
export function dollarsToCents(dollars: number): Cents {
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: Cents): number {
  return cents / 100;
}

export function formatCents(cents: Cents): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = `$${(abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return neg ? `-${s}` : s;
}

/** Parse an agency fee string ("$1,234.56", "1234.56 USD") into cents. Null when unparseable. */
export function parseFeeToCents(input: string | null | undefined): Cents | null {
  if (!input) return null;
  const cleaned = input.replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
