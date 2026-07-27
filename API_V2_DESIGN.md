# /api/v2 — contract decisions

**Status:** decided, not yet implemented. This document gates the OpenAPI spec; the spec
gates the routes. Nothing under `/api/v2` gets written until the decisions below are
settled, because every one of them is cheap now and expensive once a generated client
depends on it.

**Audience:** the owner (scripts, terminal), and an MCP server built on the generated
client. Not a public API. That narrows several decisions — see D1 on scopes.

**This is a DESIGN document, not a description of current behaviour.** Written
descriptively it would inherit v1's shapes by accident, which defeats the point of
writing it before the routes exist. Where a decision requires a service change, it is
listed in the Service gaps appendix rather than quietly softened.

**v1 is frozen and permanently supported.** Not deprecated-then-sunset: the Android
companion app is a build we do not control, so v1 keeps working. No `Sunset` headers.
The one exception is removing a security defect — a frozen API is not frozen against
fixing a credential leak. Already applied: the admin user endpoints no longer return
or accept another user's notification target on any of the three paths that had it
(`GET /api/users`, `PUT /api/users/:id`, `POST /api/users`). The break is recorded in
`PRODUCTION_CHANGELOG.txt` for the Android client, which is not in this repository.

---

## D1 — Authentication: opaque personal access tokens, not longer JWTs

v2 accepts **only** personal access tokens. It has **no login endpoint**.

```
api_tokens(id, user_id, name, token_hash, scopes, created_at, last_used_at, expires_at NULL)
```

- Wire format `gt_pat_<base64url>`, 256 bits of randomness. `authRequired` branches on the
  prefix, then does the same database privilege re-read it already does.
- **SHA-256, not bcrypt.** A 256-bit random secret has no entropy problem for a KDF to
  fix, and this is verified on every request.
- **Two scopes: `library` and `admin`.** A 42-route scope matrix for a single-user
  instance is unmaintainable and would need its own CI gate. The only boundary that
  matters is "the MCP cannot create users or read API keys."
- Revocation is `DELETE` on the row — which is the whole reason the token is looked up
  rather than self-describing.
- The first token is minted by `create-api-token.js` inside the container, same shape as
  `create-local-admin.js`. A Settings → API Tokens UI comes later.

**Why not just raise the JWT expiry.** A long-lived JWT is unrevocable. The only levers
are rotating `JWT_SECRET`, which kills every session including the SPA and the phone, or
deleting the account. That is a demolition charge, not a lever.

**Why long-lived credentials are safe here specifically.** The usual objection — that a
long-lived token freezes privilege at issue time — does not apply: `authRequired`
(`index.js:1264`) re-reads `can_manage_users`, `origin` and `display_name` from the
database on every single request and 401s when the row is gone. Demote or delete a user
and their tokens die on the next call. This argument is only available because that
decision was already taken.

**Consequence, and the reason this unblocks everything else:** because v2 has no login,
`services/auth.js` for v2 is token verification plus middleware — small, testable, no
LDAP. The ~319-line nested-callback LDAP login in `index.js` stays where it is and stops
gating the spec. If v2 had its own `/auth/login`, that pyramid would have to be extracted
first, because two login implementations on the most security-sensitive path is exactly
the failure the service layer exists to prevent.

**Additive to v1, immediately:** teach v1's `authRequired` to accept PATs. It is a new
credential type, not a shape change, so it does not violate the freeze — and it gets the
owner's password out of script and MCP configs today.

**The rate limiter must not apply to token auth.** The current limiter is 5 failed
attempts → 15-minute IP lockout (`LOCKOUT_DURATION`, `index.js:91`). A retrying MCP
client would lock the owner out of their own instance. It is also in-process, so it is
already wrong for more than one replica. Token verification is a different path and does
not go through it; failed *password* login keeps the limiter unchanged.

**JWT claims are vestigial.** Both `jwt.sign` sites (`index.js:1461`, `index.js:1693`)
bake in `can_manage_users`/`origin`/`display_name`, and nothing authorizes off them —
`authRequired` reads only `payload.id`. So scopes cannot live in a JWT payload, and v2
must not put them there. The two sites collapse to one `issueToken` seam when auth is
extracted.

### D1 addendum — the three blockers, now decided

Found while implementing D1 and absent from the original decision. Settled before
writing the spec, because two of the three determine what the spec can honestly say.

1. **v2 is PAT-only, enforced by a `patRequired` middleware.** `authRequired` accepts
   both credential types; mounting it on v2 would publish a token-only API that also
   accepts a 12-hour JWT. The deciding argument is not tidiness — **a JWT carries no
   scope**, so `authorize()` gives it the account's full privilege. If v2 declares an
   admin boundary and also accepts JWTs, that boundary is bypassable by logging in.
   `patRequired` lands **with the first v2 route**, not before: middleware guarding
   nothing is the same unused-code problem the auth review already raised once.
   `tierOf()` in `test/api-surface.test.js` needs a vocabulary entry for it at the same
   time — it currently resolves an unknown middleware name to `public`, which fails
   closed (the allowlist assertion fires) but for the wrong reason.

2. **Scopes are NOT expressible per-operation, so the spec does not pretend they are.**
   This turned out to be a property of OpenAPI rather than of this codebase: the scope
   array in a `security` requirement is only meaningful for `oauth2` and
   `openIdConnect`. For `type: http, scheme: bearer` it is ignored, so writing
   `security: [{bearerAuth: [admin]}]` would be decorative — a claim no tool checks and
   no client honours.

   Instead each operation carries **`x-required-scope`**, which maps one-to-one onto the
   admin/non-admin boundary the router actually derives from `requirePermission`. That
   makes it genuinely checkable: the drift gate can assert `x-required-scope: admin` iff
   `tierOf(route) === 'admin:can_manage_users'`. The Enforcement section's claim is
   narrowed accordingly — the gate proves the ADMIN boundary, and there is nothing
   finer-grained to prove.

3. **`library` keeps its name; the meaning is documented instead.** It does mean
   "every non-admin capability" rather than "the library", and that name goes into every
   generated client. Weighed against renaming: the scopes are a two-value set where the
   real distinction a reader needs is *admin or not*, and `library` vs `admin` carries
   that. Renaming now costs a data migration against a CHECK constraint and live rows on
   a schema that deployed hours ago, for a nuance the README and this spec both state
   outright. *(Dissent recorded: the Architect's point that the name is permanent once
   the MCP ships is correct, and this is the cheapest it will ever be to change. If a
   third scope is ever added the set stops reading as a binary and this should be
   revisited then — that is the trigger.)*

## D2 — `gameId` is an opaque string, forever

One `GameRef` schema shared by search results, library rows and path parameters:
`type: string`, `pattern: ^(igdb|rawg|thegamesdb)_[A-Za-z0-9_-]+$`.

**Never `integer`.** The SQLite column was *declared* `INTEGER` and stored strings anyway;
that only worked because of SQLite's flexible typing. A spec that types this as a number
produces a client that corrupts ids on the way in.

## D3 — RFC 9457 `problem+json`, with the error code on the wire

`{error: string}` becomes `application/problem+json`, and `services/errors.js`'s frozen
`CODES` become the `type`. Today a 400 from `UNKNOWN_USERS` and a 400 from `VALIDATION`
are indistinguishable without string-matching the message, and `NOT_FOUND` is
`expose:false` so the message is the generic `'Not found'` — a client cannot branch on
anything.

`services/problem.js` already holds the single code → `{status, title, expose}` table and
hardcodes the v1 envelope in one place, so this is a second renderer, not a rewrite.
`expose` keeps its meaning: a 500 still never echoes a service message.

## D4 — Lists return `{data, meta}`

`meta` is where `degraded`, `total` and paging live. This kills the worst v1 shape:
catalog degradation is currently signalled by an `X-Catalog-Degraded: 1` header
(`index.js:409`) while the body stays a bare array. Generated clients drop headers, so
"IGDB is down" and "that game doesn't exist" read identically — precisely the distinction
`services/catalog.js` was rewritten to compute.

## D5 — camelCase once, from a single mapper

No aliases. v1's `listGamesWithAliases` emits snake_case *plus* duplicated
`steamAppId`/`crackStatus` because the SPA reads both spellings; search emits a third
convention again. Three conventions in one round trip is a client-generator's worst case.
v2's mapper reads raw rows and emits camelCase; it never calls the aliasing function.

## D6 — Mutations return the resource; success is falsifiable

v1 returns `{success:true}` from `DELETE .../games/:gameId` whether or not a row existed,
and from a backlog reorder that moved nothing. Combined with opaque `gameId`, a typo is a
silent no-op reported as success — the worst possible shape for an LLM-driven client.

v2: `DELETE` → `204`, or `404` when there was nothing to delete. Mutations return the
resulting resource.

## D7 — `PATCH /library/games/{gameId}` re-derives status from the STORED release date

This fixes a live v1 bug, not just a shape. `POST /api/user/:u/games` computes the stored
status from the `releaseDate` **in the request body**, not from the row. Omit the date for
a game released in 2020 and `validReleaseDate(undefined)` → null → `isReleased(null)` →
false, so the row is written `unreleased` — while `release_date` is *preserved*, because it
is not in the `ON CONFLICT DO UPDATE SET` list. The row is now
`release_date='2020-01-01', status='unreleased'`, and the next correct POST makes
`decideEvents` emit `RELEASED` and push "has been released!" to four channels for a
six-year-old game.

The SPA never trips this because it always resends the date. A script or an MCP is exactly
the client that will. **This is also worth fixing in v1** — see Service gaps.

## D8 — Server-side filter, sort and ordering

`GET /api/v2/library/games?status=&sort=&limit=&cursor=`. "What's in my backlog, in
order" must not mean shipping the whole library through a model's context window.

This has a hard prerequisite: `listGamesFor` is deliberately unordered, and offset
pagination over an unordered result is silently wrong rather than slightly wrong. See
Service gaps.

## D9 — Composite add: resolve-or-refuse, never guess

`POST /api/v2/library/games` accepts either a resolved `gameId` or `{name, status}`. On a
name it runs `catalogService.searchAll` + `findExactMatch` — the rule already exists — and
on a unique exact match creates and returns the resource. Otherwise **409 with a candidate
list**, never a guess.

This collapses search-then-add into one call and makes ambiguity a refusal rather than a
wrong write. The domain rule stays in the service: the SPA, the phone, a CLI and the MCP
must all get the same answer to "which search result is this game", and putting that in
the MCP recreates exactly the drift the service extraction just eliminated.

## D10 — `GET /api/v2/me`

Identity, `canManageUsers`, active scopes, token expiry. One call to orient a client.

## D11 — Long operations become job resources

`202` + `GET /api/v2/jobs/{id}` for bulk metadata refresh, check-releases, and the
CrackWatch sweep. Today `POST /api/admin/refresh-crackwatch-cache` awaits a full paginated
sweep at ~1.2s/page inside the request, and bulk `refresh-metadata` walks the whole library
sequentially at up to three providers per game with a 10s timeout each. Any reverse proxy
kills these before they answer. Everything else stays synchronous.

## D12 — Sharing: `PUT` replaces, `POST` adds one

v1's `POST /api/user/:u/share` is replace-not-append — `replaceOutgoing` deletes the whole
outgoing list first. An agent that "adds a share" by posting one name silently revokes
every other one. It is PUT-shaped and spelled POST. v2 splits them.

## D13 — Non-admin `GET /settings` is 403, not `{}`

v1 returns `{}` with a 200 to a non-admin. For the SPA that is harmless. For an MCP it is a
correctness hole: `{}` is indistinguishable from "this server has no SMTP configured", so
an agent reasoning over the response will confidently report a false fact about the system.
A role-dependent response body also cannot be typed in OpenAPI without a union that clients
get wrong.

This one is genuinely SPA-breaking, so it changes in v2 only.

## D14 — Version discovery, added to v1 BEFORE the freeze bites

`GET /api/capabilities` (auth tier — **not** `/api/health`, which stays boring) returning
`{apiVersions, serverVersion, deprecations}`. There is currently no way for the phone or
any other client to discover that v2 exists. This is the last change made to v1, because
after the freeze it cannot be added.

---

## Service gaps — changes the services need before the spec can be honoured

Listed explicitly so the spec is not quietly written down to what the services already do.

| Gap | Service | For |
|---|---|---|
| `listGamesFor` has no `ORDER BY`; pagination over it is unsound | `services/library.js:36` | D8 |
| Status derived from the request's date rather than the stored row | `services/library.js` upsert | D7 |
| `removeGame` computes `removed` and the adapter discards it | `services/library.js` | D6 |
| Backlog boundary no-op returns `moved:false`, discarded | `services/library.js` | D6 |
| `readSharedLibrary(owner, viewer)` and `revokeIncoming(to, from)` take two usernames in **opposite** orders, adjacent in the file | `services/shares.js` | D12 |
| ~~No PAT table, no token verification path~~ — done | `services/auth.js` | D1 |

The shares argument-order item fails closed today — swapping them inverts the grant
direction but only matters if a reciprocal share exists — so it is a footgun rather than a
bypass. It gets meaningfully more dangerous the moment a second set of adapters exists,
which is why it is normalised **before** v2 routes, not after.

---

## Enforcement — the drift gate goes INSIDE `test/api-surface.test.js`

Not a separate spec-lint step. That file already walks the **live Express router** and
already lists `/api/v2` in `KNOWN_MOUNTS`; a second file would be a second copy of the
truth, which is the pattern this project keeps getting burned by (four copies of the
release sweep, two ownership rules on one path prefix).

**What the gate catches:** a route on the router that is not in the spec; a spec
path/method that does not exist on the router — which for an MCP means an agent calling a
404 and hallucinating around it; and an operation whose **`x-required-scope`** disagrees
with the router-derived tier. That last one is not the existing test done twice: the
existing test proves the router's tier matches the recorded table, this proves the
*published claim* matches the router. Different lie, same ground truth.

Note the narrowing from D1 addendum #2: the gate proves the **admin boundary only**,
because that is the only distinction the router encodes. It cannot prove anything about
`library`, which is defined as the absence of admin rather than as a set of permissions.

**What it cannot catch, and nobody should claim otherwise:** response body conformance.
The spec can say `200` returns `{data: [...]}` while the handler returns
`{success:true, games:[...]}` and nothing static in this repo will notice. That needs the
routes exercised against a live stack — the `smoke-test` job, not a lint job.

**Separately, v1 needs response-shape assertions.** "Frozen" is currently an intention with
nothing enforcing it: `api-surface.test.js` pins routes and auth tiers, but any service can
rename a field and every v1 client breaks with CI green. The most likely casualty is the
duplicated `steamAppId`/`crackStatus` aliases, which exist *only* because the SPA reads
both spellings — someone will tidy them away and silently break the phone. The services are
pure enough to assert against directly, no database needed.

---

## Build order

0. ~~Remove the admin push-credential disclosure from v1.~~ Done.
1. This document. ← you are here
2. ~~Auth slice: `migrations/003_api_tokens.sql`, `services/auth.js` (verification
   only — the middleware itself is inline in `index.js`, because CLAUDE.md forbids
   `req`/`res` in `services/`), `create-api-token.js`, PAT acceptance in v1's
   `authRequired`, and mint/list/revoke on the CLI.~~
   Done. Verified end-to-end against a real Postgres and a booted backend, not only by
   unit test: an admin account presenting a library-scoped token gets 403 on
   `/api/users`, demoting the account revokes admin on the very next request, deleting
   the token 401s it, and deleting the user cascades its tokens away.
3. ~~The OpenAPI 3.1 document — v2 only, hand-written.~~ `openapi/gametracker-v2.yaml`,
   26 operations. It is the SOURCE for the routes, not a description of them: no v2
   route exists yet, so every operation in it is a specification to be implemented.
4. The drift gate, landed **with the first v2 route**, not after. A spec without the gate
   is a document, not a contract.
5. v2 routes in slices — library first (that is what the MCP and the terminal both want),
   admin second. Normalise the shares argument order before the second adapter set exists.
6. The docs site: point Redoc or Scalar at the spec, emit one static file, serve it from
   the existing nginx. It must be **vendored** — `frontend/nginx.conf` sets
   `script-src 'self'`, so a CDN-loaded viewer will not run.
7. The MCP: a thin wrapper over the generated client, ~10 tools, no domain logic. Tool
   descriptions, disambiguation prompting, within-session caching of search results so
   "add the second one" works, and confirm-before-destroy all live here — not in the API.

### Deliberately not doing

- **An OpenAPI spec for v1.** Contested; decided against. A faithful v1 spec produces a
  generated client carrying three naming conventions, `{success:true}` as the return type
  of every mutation, a degradation flag that lives in a header, and D7's landmine baked
  into a typed method signature. That client is worse than none, and describing the warts
  precisely makes them permanent. v1 keeps the README table, plus the shape assertions
  above. *(Dissent worth recording: the counter-argument is that a v1 spec is ~80%
  derivable from the existing route inventory and would let the docs site and an MCP exist
  over the 42 routes that work today, decoupled from v2 finishing. The risk it addresses —
  v2 being 60% built for months while nothing ships — is real, and step 5's slicing is what
  is supposed to address it instead. Revisit if v2 stalls.)*
- **A v1 response serialiser.** v1 is frozen; a serialiser for a frozen surface is
  refactoring with no consumer.
- **Bulk mutation endpoints on day one.** There is one user; let the MCP loop.
  `backlog-reorder` stays bulk because ordering genuinely is a set operation.
- **Further `index.js` line-count reduction as a goal.** 2,439 lines is not the problem.
