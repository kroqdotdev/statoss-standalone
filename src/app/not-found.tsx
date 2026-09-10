export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-[46rem] px-5 py-16 sm:py-24">
      <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.02em] sm:text-[2.5rem]">
        No status page at this address.
      </h1>
      <p className="mt-4 max-w-[36rem] text-[15px] leading-relaxed text-muted">
        This server only answers for the hostnames listed in its configuration.
        Check the address, or add this hostname to a site in the configuration
        file and restart the server.
      </p>
    </main>
  );
}
