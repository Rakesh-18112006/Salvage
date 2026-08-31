/** Money is always paise (integer). Never floats for currency. */
export type Paise = number;

export const rupees = (p: Paise): number => p / 100;
export const toPaise = (r: number): Paise => Math.round(r * 100);

/** Indian digit grouping: 7,33,840 not 733,840. */
export function formatINR(paise: Paise): string {
  const neg = paise < 0;
  const whole = Math.abs(Math.trunc(paise / 100)).toString();
  const frac = Math.abs(paise % 100).toString().padStart(2, '0');

  let grouped: string;
  if (whole.length <= 3) {
    grouped = whole;
  } else {
    const last3 = whole.slice(-3);
    let rest = whole.slice(0, -3);
    const parts: string[] = [];
    while (rest.length > 2) {
      parts.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    if (rest.length > 0) parts.unshift(rest);
    grouped = `${parts.join(',')},${last3}`;
  }
  return `${neg ? '-' : ''}₹${grouped}.${frac}`;
}
