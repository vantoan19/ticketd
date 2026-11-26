/** The ring's circumference: 2π × its 6px radius, which the dash lengths measure. */
const CIRCUMFERENCE = 37.7;

/**
 * Progress as a 16px ring: a track, and an arc from the top for the part done.
 * It is decoration; the count beside it says the same in words.
 */
export function SetupRing({ done, total }: { done: number; total: number }) {
  const arc = total > 0 ? Math.min(done / total, 1) * CIRCUMFERENCE : 0;
  return (
    <svg
      className="setup-ring"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="var(--control-boundary)"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="var(--interactive)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${arc.toFixed(2)} ${CIRCUMFERENCE}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
