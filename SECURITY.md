# Security policy

## Supported versions

Only the latest commit on `main` receives security fixes.

## Report a vulnerability

Do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting on this repository: open the **Security** tab and choose **Report a vulnerability**. Describe what you found, how to reproduce it, and what an attacker could do with it.

You will get a first reply within 7 days. When a fix is ready, it is published on `main` and noted in the changelog. You are credited in the changelog unless you ask not to be.

## What to look at

The status page is public by design. It shows checkpoint names, response times, and the reason for each failed check. It never shows the checked URLs, configuration values, or raw error messages.

The server chooses a site by the `Host` header and answers 404 for unknown hostnames. Only the hostnames in the configuration are served.
