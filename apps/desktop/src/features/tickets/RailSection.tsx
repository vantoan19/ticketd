import { useId, type ReactNode } from "react";

/** One labeled section of the property rail: a 12px label above its values. */
export function RailSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="rail-section" aria-labelledby={id}>
      <h3 id={id} className="rail-label">
        {label}
      </h3>
      {children}
    </section>
  );
}
