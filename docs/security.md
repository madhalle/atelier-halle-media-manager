# Local security model

## Trust boundary

The app protects your data from **websites open in your browser** and from
**other machines on your network**. It does **not** protect against a
compromised macOS installation or another program running as your macOS
user. Such a program can read the data directory, the launch file, and
Keychain items it is allowed to access. Use FileVault and encrypted backups.
The SQLite database is not separately encrypted.

## Network exposure

- The server binds to `127.0.0.1` only. Nothing listens on other interfaces.
- Every request needs an exact `Host` of `127.0.0.1:<port>` or
  `localhost:<port>`. Anything else gets `421`, which blocks DNS-rebinding
  attacks.
- There is no CORS. API requests are rejected when `Sec-Fetch-Site` is
  `cross-site` or `same-site`, or when `Origin` isn't one of this app's two
  exact origins. Unsafe methods must carry an `Origin`.

## Browser sessions

1. At startup, and again after each use or every 5 minutes, the server mints a
   random **launch token**.
   - It's single-use and expires after 10 minutes.
   - The server keeps only its SHA-256 digest.
2. The token is written into `launch.html`, a mode-`0600` file in the data
   directory. It's never printed or logged, and never passed as a process
   argument.
3. `npm run open` opens that file. The file sends the browser to
   `/launch?token=…`.
4. The server exchanges the token for a random session ID, set as an
   `HttpOnly; SameSite=Strict; Path=/` cookie. It then redirects to `/`, which
   removes the token from the address bar.
5. Sessions live only in server memory. They expire after 12 hours idle or 7
   days total. Restarting the server signs every browser out.
6. Unsafe API requests also need an `x-csrf-token` header that matches the
   session's CSRF token. The UI keeps that token in memory only, never in
   `localStorage`.

**Loopback limitations:**

- Cookies can't use `Secure` over plain-HTTP loopback.
- Browsers scope cookies by host, not port. Another local service on
  `127.0.0.1:<other port>` would receive the cookie if the browser visited it.
  That's a same-user or same-machine process, which is outside the trust
  boundary.
- A hosted version must use HTTPS, `Secure` cookies, and managed sign-in.

## Other controls

- **Security headers:** strict Content-Security-Policy (`default-src
  'self'`, no inline scripts, `frame-ancestors 'none'`), `nosniff`,
  `no-referrer`, COOP/CORP `same-origin`, and a restrictive
  `Permissions-Policy`. API responses are `no-store`.
- **Limits:** JSON bodies are capped at 1 MiB. Upload limits come with
  media handling (milestone 4).
- **Logging:** query strings are replaced with `?[redacted]`, and cookie,
  authorization and CSRF headers are redacted.
- **Filesystem:**
  - The process umask is `077`.
  - The data directories are `0700`, and the database, WAL and launch file
    are `0600`.
  - Paths built from input go through `containedPath`.
  - Static files are served only from the built UI directory.
- **Data separation:**
  - Development uses `.data/development` (gitignored).
  - Tests must use an explicit temporary directory.
  - Neither may point at the production data directory.
  - Live publishing can only be enabled in production.
- **Single instance:** a lock file in the data directory stops two servers
  from using the same data.
