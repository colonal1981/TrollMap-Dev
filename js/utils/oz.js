/**
 * oz.js — weights the way they are written on a packet.
 *
 * Jigheads, sinkers and rig weights are sold in eighths of an ounce. A rod row that says
 * "0.75oz jighead" reads like a number that escaped from a calculation, and Ryan's plan has to
 * be readable on the water — so the app stores the number and prints the fraction.
 *
 * One copy, because the head weight is now said in two places that must agree: the warning
 * capBaitDepth() writes when it moves a lead, and the spread row plan-to-timeline() builds.
 */
export function ozLabel(oz) {
  if (!Number.isFinite(oz) || oz <= 0) return '';
  const eighths = Math.round(oz * 8);
  // Anything off the eighths grid is not a weight in the box; print it plainly rather than
  // rounding a real number into a fraction that was never on the packet.
  if (Math.abs(eighths / 8 - oz) > 1e-9) return `${oz}oz`;
  const whole = Math.floor(eighths / 8), rem = eighths % 8;
  if (!rem) return `${whole}oz`;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const d = gcd(rem, 8);
  const frac = `${rem / d}/${8 / d}`;
  return whole ? `${whole}-${frac}oz` : `${frac}oz`;
}
