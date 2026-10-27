/**
 * Dice.tsx — a single d100 die rendered as a large numeral.
 *
 * Concept A uses one d100, so the pip-grid die is replaced by a
 * digital-numeral die. The `rolling` class blurs the face while the
 * animation hook is cycling random values (see useRollAnimation).
 */
interface DiceProps {
  /** 1..100 — the d100 face value. */
  value: number;
  rolling: boolean;
}

export function Dice({ value, rolling }: DiceProps): React.ReactElement {
  return (
    <div
      className={`die die--d100${rolling ? ' die--rolling' : ''}`}
      role="img"
      aria-label={`d100, value ${value}`}
    >
      <span className="die__numeral">{value}</span>
      <span className="die__caption" aria-hidden="true">D100</span>
    </div>
  );
}
