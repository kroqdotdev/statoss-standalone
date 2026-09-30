import Link from "next/link";

/**
 * The frame of a page under the status page: an incident's own page, the
 * history. A way back at the top, then the page.
 */
export function SubPage({
  site,
  children,
}: {
  site: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-[46rem] px-5 py-12 sm:py-16">
      <p className="text-[14px]">
        <Link href="/" className="page-link">
          {site} status
        </Link>
      </p>
      {children}
    </main>
  );
}
