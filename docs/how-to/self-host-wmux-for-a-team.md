# How to self-host wmux for a team

> **Goal:** run one isolated wmux per person on a shared Linux server, so each
> person opens their own terminals and agents from a browser and installs
> nothing on their own machine. People sign in with the company's OIDC
> provider, and each can reach only their own instance.

The files are in [`deploy/docker/`](../../deploy/docker/):

- `Dockerfile`: one user's headless wmux (daemon and `wmux web`) on Debian 12,
  built from a released `wmux-server` tarball. The download is checked against
  the release's `.sha256` file and, when you pass `WMUX_SHA256`, against a hash
  you pinned yourself.
- `compose.example.yaml`: Traefik, oauth2-proxy and one container per person.

## What you get

- **One container per person.** Each has its own home volume (terminals,
  `~/.wmux`, the `~/.claude` login, repositories), its own network and its own
  wmux token. Containers cannot reach each other: only Traefik joins every
  user network.
- **Limits.** Each container runs as an unprivileged user with every Linux
  capability dropped, `no-new-privileges`, and CPU, memory and process caps.
  No user container gets the Docker socket, and Traefik reaches Docker only
  through a filtering proxy that allows read-only container listing.
- **Sign-in.** Every request first needs a company sign-in through
  oauth2-proxy. A per-user rule then admits only that person's address, so a
  signed-in colleague who opens someone else's address gets `403`. The
  sign-in also opens wmux itself: nobody has to carry the wmux token around
  (see [Signing in through the proxy](#signing-in-through-the-proxy)).
- **Agents.** Claude Code is installed into the home volume on first start,
  and wmux's Claude Code hooks are installed with it, so tool approvals reach
  the browser. Each person signs in to their own Claude account in their own
  terminal. Never share one account between containers.

## Prerequisites

- A Linux server with Docker and Docker Compose.
- A DNS name per person under one domain, for example
  `alice.wmux.example.com`, pointing at the server. For a server reachable only
  over a VPN, the names can resolve to a private address. Use a DNS-challenge
  certificate so the certificate stays publicly trusted.
- An OIDC client at your identity provider, with the redirect URI
  `https://<person>.<domain>/oauth2/callback` for each person.

## Steps

1. **Copy the user blocks.** In `compose.example.yaml`, keep one service per
   person (`alice` and `bob` are examples). For each person, set:
   - their host name;
   - the `allowed_emails` address in their `-only` middleware, and the same
     address in `WMUX_TRUST_PROXY_USER`;
   - their own network (with its own `subnet` and `ip_range`) and volume;
   - Traefik's fixed address on that network, in `WMUX_TRUST_PROXY_FROM`.

   Add each new network to Traefik's `networks` with that fixed address as
   its `ipv4_address`. The subnets in the example are placeholders: pick
   private ranges nothing else on the host uses, and keep Traefik's address
   inside the subnet but outside `ip_range`, where Docker hands out
   addresses to containers.

2. **Configure TLS.** Uncomment the `certresolver` lines and set Traefik's
   ACME DNS-challenge provider, or point Traefik at certificates you already
   have.

3. **Start it.**

   ```bash
   cd deploy/docker
   export WMUX_DOMAIN=wmux.example.com
   export OIDC_ISSUER_URL=https://login.example.com
   export OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=...
   export OAUTH2_PROXY_COOKIE_SECRET=$(openssl rand -hex 16)
   docker compose -f compose.example.yaml up -d --build
   ```

   Both oauth2-proxy secrets reach it as compose secret files, not as flags
   or container environment. To build another wmux release, or to pin the
   tarball's hash, also export `WMUX_VERSION` and `WMUX_SHA256` before
   `up`; the compose file passes them to the build.

4. **Hand out each person's address.** On its first start, each container
   creates one terminal and logs the address to open:

   ```bash
   docker compose -f compose.example.yaml logs alice | grep 'wmux is ready'
   ```

   The line holds no secret: it is the person's plain address.

5. **First visit.** The person opens their address
   (`https://alice.wmux.example.com/`), signs in with the company account and
   lands in their terminal. Sign-ins expire (after a week by default); when
   one does, the page reloads and the sign-in page appears. To use Claude
   Code, they run `claude` and finish the sign-in once. The login is kept in
   their volume.

## Signing in through the proxy

Each container starts `wmux web` with `--trust-proxy-header`,
`--trust-proxy-user` and `--trust-proxy-from` when both
`WMUX_TRUST_PROXY_USER` and `WMUX_TRUST_PROXY_FROM` are set. wmux then admits
a request that carries no wmux token only when it comes from exactly that
address and its `X-Auth-Request-Email` header names that person. With either
variable missing, the container keeps asking for the token and logs a
warning.

- **Who sets the header.** Each person's chain in Traefik first removes any
  `X-Auth-Request-Email` the browser sent, then runs the sign-in and the
  per-user check. Only that check puts the header back, copied from
  oauth2-proxy's answer.
- **Why Traefik's address is fixed.** wmux trusts one address, not a
  network. Traefik is the only other member of each person's network, and
  its fixed address there is the only one wmux accepts. Requests from the
  network's gateway or from inside the container itself never count, so a
  terminal in the container cannot pose as the proxy.
- **Wiring your own proxy.** The address you trust must be one that every
  connection reaches only through the sign-in. That rules out a TCP
  passthrough, a NAT or gateway address, or a tunnel: through any of them,
  every client looks like the proxy. Your proxy must also remove the
  identity header from the browser's request before it sets its own.
- **The token still works.** The token address remains a fallback, for
  example for a script. Read the token with
  `docker compose -f compose.example.yaml exec alice wmux web --status --show-token`. Open
  the address and sign in first, then the token address: a token in the
  address during sign-in travels to the identity provider inside the return
  address.
- **The classic page needs the token.** Old browsers that cannot run the app
  fall back to `/classic`, which still asks for the token.
- **Ending a sign-in.** Once oauth2-proxy stops accepting a sign-in (it
  expired or was signed out), the page's next request notices within a few
  seconds and reloads into the sign-in page. A terminal stream that is
  already open is not cut by that: it keeps running until it reconnects.

## Things to know

- **No device pairing.** Inside the container `wmux web` serves plain HTTP on
  that person's private network, behind Traefik's TLS. wmux refuses to mint
  long-lived device credentials over plain HTTP, so phones and browsers sign
  in through the proxy (or use the token address) instead of a pairing code.
- **The host administrator can see everything.** Anyone with root on the
  server can read every volume, including each `~/.claude` login. Tell users,
  and keep administrator access small.
- **Cloud metadata.** User containers can reach the host's network,
  including a cloud provider's metadata address (`169.254.169.254`). On a
  cloud VM, block it for the user networks with a host firewall rule, or any
  user can read the VM's cloud credentials.
- **Restarts.** Restarting a container keeps the token, the terminal list and
  the Claude Code install. Processes that were running in its terminals end.
- **Adding people.** Each new person means another service block, plus
  their network in Traefik's list, which recreates Traefik. Containers share
  the host kernel, so the server assumes nobody on it will try to break out of
  a container. Give people you do not trust separate virtual machines.
