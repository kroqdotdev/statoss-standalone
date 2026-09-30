import Link from "next/link";
import { DEFAULT_RANGE, RANGES, type RangeKey } from "@/lib/ranges";

export function RangeSwitch({
  current,
  fallback = DEFAULT_RANGE,
}: {
  current: RangeKey;
  /** The range the page opens on, which needs nothing in the address. */
  fallback?: RangeKey;
}) {
  return (
    <nav aria-label="Time range" className="flex gap-5 text-[15px]">
      {Object.values(RANGES).map((spec) => {
        const isCurrent = spec.key === current;
        return (
          <Link
            key={spec.key}
            href={spec.key === fallback ? "/" : `/?range=${spec.key}`}
            aria-current={isCurrent ? "page" : undefined}
            className={
              isCurrent
                ? "border-b-2 border-[var(--link)] pb-0.5 font-medium text-ink"
                : "border-b-2 border-transparent pb-0.5 text-muted hover:text-ink"
            }
          >
            {spec.label}
          </Link>
        );
      })}
    </nav>
  );
}
