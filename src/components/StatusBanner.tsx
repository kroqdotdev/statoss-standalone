const STYLES = {
  operational: { bg: "bg-emerald-500", label: "All systems operational" },
  partial: { bg: "bg-amber-500", label: "Partial outage" },
  major: { bg: "bg-red-600", label: "Major outage" },
} as const;

export function StatusBanner({ status }: { status: keyof typeof STYLES }) {
  const { bg, label } = STYLES[status];
  return (
    <div
      className={`${bg} rounded-lg px-4 py-3 text-lg font-semibold text-white`}
    >
      {label}
    </div>
  );
}
