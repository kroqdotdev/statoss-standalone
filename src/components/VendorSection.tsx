import { rowId } from "@/lib/format";
import { COMPONENT_LABELS } from "@/lib/stated";
import type { ComponentView } from "@/lib/status-data";

/** How many of a vendor's open incidents a row lists. */
const SHOWN = 3;

const TONE = {
  operational: "text-up",
  degraded: "font-medium text-slow",
  partial: "font-medium text-timeout",
  major: "font-medium text-fail",
} as const;

/**
 * The services of others this site depends on, each following its vendor's
 * own status page: one compact row with whose report it is. Their trouble
 * is shown here and does not move the headline.
 */
export function VendorSection({ vendors }: { vendors: ComponentView[] }) {
  if (vendors.length === 0) return null;
  const off = vendors.filter((v) => v.state !== "operational").length;
  return (
    <section
      aria-label="Third-party services"
      className="border-t border-rule-strong pt-6 pb-2"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pb-2">
        <h2 className="page-group text-[15px] font-medium uppercase tracking-wide">
          Third-party services
        </h2>
        <span className={`text-[14px] ${off > 0 ? "text-muted" : "text-up"}`}>
          {off > 0
            ? `${off} of ${vendors.length} not operational`
            : vendors.length === 1
              ? "Operational"
              : `All ${vendors.length} operational`}
        </span>
      </div>
      <ul>
        {vendors.map((v) => (
          <li
            key={v.name}
            id={rowId(v.name)}
            className="scroll-mt-6 border-t border-rule py-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <p className="text-[15px]">
                <span className="font-medium">{v.name}</span>{" "}
                <span className="text-[13px] text-muted">
                  {v.vendor?.problem
                    ? `${v.vendor.host} ${v.vendor.problem}`
                    : "reported by "}
                  {!v.vendor?.problem && (
                    <a
                      href={v.vendor?.url}
                      rel="noopener noreferrer nofollow"
                      className="page-link"
                    >
                      {v.vendor?.host}
                    </a>
                  )}
                </span>
              </p>
              <span className={`text-[14.5px] ${TONE[v.state]}`}>
                {COMPONENT_LABELS[v.state]}
              </span>
            </div>
            {v.vendor?.incidents.slice(0, SHOWN).map((incident) => (
              <p
                key={incident.url + incident.name}
                className="mt-1 text-[13.5px]"
              >
                <a
                  href={incident.url}
                  rel="noopener noreferrer nofollow"
                  className="page-link"
                >
                  {incident.name}
                </a>
              </p>
            ))}
            {(v.vendor?.incidents.length ?? 0) > SHOWN && (
              <p className="mt-1 text-[13.5px] text-muted">
                and {(v.vendor?.incidents.length ?? 0) - SHOWN} more on{" "}
                {v.vendor?.host}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
