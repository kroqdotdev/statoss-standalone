/**
 * What a password page shows a browser that has not given the password:
 * the site's name and a form. Nothing about the site's state.
 */
export function Unlock({
  site,
  logo,
  problem,
}: {
  site: string;
  logo: string | null;
  /** The ?unlock= the form came back with: wrong, or wait. */
  problem?: string;
}) {
  return (
    <main className="mx-auto w-full max-w-[26rem] px-5 py-16 sm:py-24">
      {logo !== null && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt="" className="mb-6 max-h-10 w-auto max-w-[12rem]" />
      )}
      <h1 className="page-title text-[2rem] font-semibold leading-tight">
        {site} status
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">
        This page needs a password.
      </p>
      <form method="post" action="/unlock" className="mt-6 space-y-3">
        <label className="block text-[14px]">
          <span className="mb-1.5 block">Password</span>
          <input
            type="password"
            name="password"
            required
            autoFocus
            autoComplete="current-password"
            className="page-field w-full"
          />
        </label>
        {problem === "wrong" && (
          <p role="alert" className="text-[14px] text-fail">
            That is not the password.
          </p>
        )}
        {problem === "wait" && (
          <p role="alert" className="text-[14px] text-fail">
            Too many tries. Wait a minute and try again.
          </p>
        )}
        <button type="submit" className="page-button">
          Open the page
        </button>
      </form>
    </main>
  );
}
