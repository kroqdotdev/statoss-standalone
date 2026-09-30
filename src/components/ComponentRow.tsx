import Link from "next/link";
import { rowId } from "@/lib/format";
import { COMPONENT_LABELS, type Stated } from "@/lib/stated";
import type { ComponentView } from "@/lib/status-data";

const TONE = {
  operational: "text-up",
  degraded: "font-medium text-slow",
  partial: "font-medium text-timeout",
  major: "font-medium text-fail",
} as const;

/**
 * A part of the product with no check: a name, an optional line under it,
 * and its state. No strip and no uptime figure, since nothing measures it.
 */
export function ComponentRow({
  component,
  stated,
  as: Heading = "h2",
}: {
  component: ComponentView;
  stated?: Stated;
  as?: "h2" | "h3";
}) {
  const maintenance = stated?.maintenanceUntil && !stated.impact;
  const label = maintenance
    ? "Under maintenance"
    : COMPONENT_LABELS[component.state];
  return (
    <section
      id={rowId(component.name)}
      className="scroll-mt-6 border-t border-rule py-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <Heading className="page-heading text-[17px] font-medium leading-tight">
          {component.name}
        </Heading>
        <p className="text-[15px]">
          {stated?.incident ? (
            <Link
              href={`/incidents/${encodeURIComponent(stated.incident.id)}`}
              title={stated.incident.title}
              className={`${maintenance ? "text-muted" : TONE[component.state]} hover:underline`}
            >
              {label}
            </Link>
          ) : (
            <span
              className={maintenance ? "text-muted" : TONE[component.state]}
            >
              {label}
            </span>
          )}
        </p>
      </div>
      {component.description && (
        <p className="mt-1.5 text-[13.5px] text-muted">
          {component.description}
        </p>
      )}
    </section>
  );
}
