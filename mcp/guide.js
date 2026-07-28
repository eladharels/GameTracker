// What GameTracker IS, for an agent that has never seen it.
//
// Tool descriptions say what one call does. They cannot explain the application: that a
// backlog is ordered and the order is a statement of intent, that `unreleased` is
// assigned by the server rather than chosen, that a stored price is a weekly snapshot.
// An agent reasoning without that produces answers that are individually valid and
// collectively wrong — reordering a backlog it never read, reporting a stale price as
// today's, telling someone a game "isn't in your library" when it is filed under a
// status the agent did not think to check.
//
// Served as MCP RESOURCES rather than folded into the instructions, because the
// instructions are sent on every connection and most of this is needed only when a
// question actually turns on it. A client can read these on demand, and an agent that
// is about to do something consequential should.

// The instructions block: short, and only the things that are wrong-by-default.
// Everything else lives in the resources below.
const INSTRUCTIONS = `Tools for GameTracker — a self-hosted personal game library. Users track games they
want, are playing, have finished, or have queued up next.

Every call acts as one GameTracker account: the one whose token this client carries.
Call whoami if you need to know which.

Four things an agent gets wrong without being told:

1. Games are identified by a SOURCE-PREFIXED id like "igdb_1020" or "rawg_58175",
   never by title. Ids come from search_games and cannot be constructed or guessed.
2. The backlog is ORDERED, and the order is the user's stated intent about what to
   play next. "What should I play?" is answered by the first entry of get_backlog.
   reorder_backlog replaces the whole ordering, so read it before you write it.
3. A game has exactly ONE status, out of five: wishlist (wants it), playing (in
   progress), done (finished), backlog (queued, and ordered), unreleased (release date
   is in the future — the server assigns this, it is not a choice, and moves the game
   to wishlist on release). A game the user "has" might be under any of them, so check
   before saying a game is or is not in their library. get_game answers that for one
   game without listing everything.
4. lastPrice on a library game is a weekly snapshot, not a live price. There is no
   price lookup here. If a user asks what something costs now, say the stored figure
   is from lastPriceUpdatedAt and point them at the store.

Call read_gametracker_guide once at the start of any session that will do more than a
single lookup. It explains the status lifecycle, sharing, pagination and what every
field means. The same content is at the gametracker://guide resource.

This server exposes library, catalog and sharing operations only. Account management,
server settings and credential administration are deliberately unavailable, whatever
the configured token would otherwise permit.`;

const GUIDE = `# GameTracker

A self-hosted, multi-user web application for tracking a personal video-game library.
Users search several game databases, add games to their own library, and track what
they are playing, what they have finished, and what they intend to play next.

Every account has its own separate library. Nothing is shared unless a user explicitly
shares it, and a share is read-only.

## The five statuses

A game in a library has exactly ONE status. This is the core model — most questions
about a library are really questions about status.

| Status | Meaning |
|---|---|
| \`wishlist\` | Wants it. Has not committed to playing it. The neutral landing place. |
| \`playing\` | Currently in progress. |
| \`done\` | Finished. |
| \`backlog\` | Queued to play, AND positioned in an ordered list. See below. |
| \`unreleased\` | Release date is in the future. **Assigned by the server, not chosen.** |

Two consequences worth holding on to:

**\`unreleased\` is automatic in both directions.** A game whose release date is in the
future is stored as \`unreleased\` no matter what status was requested when adding it.
A nightly job moves it to \`wishlist\` on release day and can notify the user. Do not
set \`unreleased\` by hand and do not treat it as a user's choice — it is a fact about
the calendar, not an intention.

**"Is this game in my library?" is not the same as "am I playing it?"** A game can be
present under any of the five. When a user asks whether they have something, check the
library rather than a single status filter.

## The backlog is ordered

\`backlog\` is the only status with an ordering. The order is the user's answer to
"what next" — first entry is what they intend to play after the current game.

* \`get_backlog\` returns them in that order. \`list_library(status="backlog")\` does not
  guarantee it — use \`get_backlog\` whenever order could matter, which is most of the time.
* \`reorder_backlog\` replaces the ENTIRE ordering. It is not a move-one-item operation.
  **Send every backlogged id, every time.** A partial list assigns positions 1..N to the
  ids you sent and leaves every other game's stored position unchanged — which produces
  DUPLICATE positions and silently breaks the up/down controls in the web app. Worse, it
  does not show: \`get_backlog\` renders position by row number, so the next read looks
  perfectly clean. Read, apply your change, send the whole list.
* Moving a game into \`backlog\` puts it at the end. Moving it out drops its position.

## Adding a game

Two ways, and the shorter one is usually better.

**By name, one call.** \`add_game\` accepts \`name\` — an exact title — and the SERVER
resolves it against the game databases using the same rule the web app uses. It refuses
to guess: an ambiguous title comes back as a conflict listing the candidates, which you
should put to the user rather than picking for them. Prefer this when the user named a
game plainly.

**By id, two calls.** \`search_games\` then \`add_game\` with the \`id\` you chose. Use
this when the user is browsing, when they need to see options, or when you already
searched.

Pass exactly one of \`name\` or \`gameId\`, never both.

The id is source-prefixed — \`igdb_1020\`, \`rawg_58175\`, \`thegamesdb_1234\` — because
the same numeric id means different games at different providers. It cannot be
constructed from a title, and a bare number is not valid.

The server resolves the name, cover art and release date from that id. What you pass as
a title is never stored.

**Re-adding a game that is already there does not reset it.** If \`status\` is omitted,
the existing status is preserved. Only pass \`status\` when the user actually asked for
one — otherwise you will demote a game they are playing back to \`wishlist\`.

If a search returns several plausible matches, ask the user which one rather than
guessing. Adding the wrong game is silent: it succeeds, and the user finds out later.

## What a library game carries

| Field | |
|---|---|
| \`gameId\` | The source-prefixed id. Stable, and what every other call takes. |
| \`name\`, \`coverUrl\`, \`releaseDate\` | Resolved from the provider when added. |
| \`status\` | One of the five above. |
| \`steamAppId\` | Steam's id, when known. May be absent. |
| \`lastPrice\` | **A weekly snapshot, not a live price.** See below. |
| \`lastPriceUpdatedAt\` | When that snapshot was taken. This is how to answer "how stale?". |
| \`crackStatus\` | DRM/availability status, refreshed daily. May be \`unknown\`. |
| \`addedAt\` | When it was added to the library. Sort by this for "what did I add recently". |
| \`backlogOrder\` | Position, only meaningful when status is \`backlog\`. |

### About lastPrice

\`lastPrice\` is whatever a weekly background sweep last recorded from Steam, and
\`lastPriceUpdatedAt\` says when. It exists so a library view can show something
without calling Steam for every row.

**There is no price lookup in this tool set** — deliberately, because it is not what
people use this for. Report \`lastPrice\` as what it is: a figure from a date, not a
current price. If someone is deciding whether to buy, say when the snapshot was taken
and let them check the store. An empty \`lastPrice\` usually means the game has no
Steam id, not that it is free.

## Sharing

A user can share their library with specific other accounts. Sharing is:

* **Read-only.** A recipient sees the games; they cannot change anything.
* **Per-account.** Sharing with one person does not affect anyone else.
* **Two-directional as a concept:** \`outgoing\` is who you share with, \`incoming\` is
  who shares with you. \`list_shares\` returns both.

To share, resolve the person to an exact username with \`list_shareable_users\` first —
usernames are lowercase and an unknown one is rejected. Do not guess from a display
name.

\`read_shared_library\` reads someone else's shared library. This is how to answer
comparative questions: "what does Dana have that I don't", "has anyone finished this".

## Search behaves gracefully, which can mislead

\`search_games\` queries three providers concurrently and merges the results. **If a
provider is down, its results are simply absent and the search still succeeds.** So a
thin result list means "few matches were found", which is not quite the same as "this
game does not exist". If a user insists a game exists and search disagrees, that is a
plausible reason.

Results are de-duplicated across providers, but the same game can still appear more
than once with different ids if the providers describe it differently.

## What this server will not do

Deliberately absent, and not reachable even with an administrator's token:

* creating, editing or deleting user accounts
* server settings — SMTP, LDAP, API keys
* minting or revoking credentials
* triggering instance-wide background jobs

Two per-user things are also absent, and they are ordinary requests rather than
administration — so name them plainly rather than looking evasive:

* **Notification settings** (when to be reminded before a release) — web interface only.
* **Refreshing a game's metadata** from the databases, when cover art or a date is
  wrong — web interface only.

If a user asks for any of the above, say it has to be done in the GameTracker web
interface. Do not attempt a workaround.

## Failure modes worth recognising

* **"Not authenticated"** — the token is wrong or expired. Retrying will not help; the
  user must mint a new one under My Account → API Tokens.
* **"Not permitted"** — the token is valid but lacks the scope. Also not retryable, and
  a different fix from the above. Do not tell a user to re-issue a token for this.
* **A server error (5xx)** — may be transient. One retry is reasonable.
* **A timeout** — the write may still have been applied. Check the current state before
  retrying anything that changes data.
`;

const CONVENTIONS = `# Working conventions

## Read before you write

Three operations replace rather than modify, and each is a way to destroy information
by acting on a stale picture:

* \`reorder_backlog\` replaces the whole ordering — call \`get_backlog\` first.
* \`add_game\` without \`status\` preserves an existing status — do not pass one unless
  asked, or you overwrite what the user chose.
* \`update_game_status\` overwrites the current status outright.

## Destructive operations

\`remove_game\` and \`unshare_library\` are marked destructive and should be confirmed
with the user unless they asked unambiguously.

\`remove_game\` is not "mark as finished" — it discards the entry, its status, its
backlog position and its price history. If a user says they finished a game, the right
call is \`update_game_status\` to \`done\`.

## Identity

Everything acts as one account. There is no "act on behalf of another user" here, and
nothing an agent can do to change which account it is. If a user asks about someone
else's games, the only legitimate route is a library that person has shared with them —
\`list_shares\` shows which, \`read_shared_library\` reads one.

## Being honest about staleness

Two fields are snapshots rather than live values, and saying so costs one clause:

* \`lastPrice\` — refreshed weekly.
* \`crackStatus\` — refreshed daily.

If a user is making a decision on either, say when the figure is from rather than
presenting it as current.

## Pagination

\`list_library\` and \`read_shared_library\` page. When a response carries a
\`meta.nextCursor\`, there are more results — pass it as \`cursor\` to continue.

**\`meta.total\` is the real count.** Use it to answer "how many games do I have"; never
count the rows you received, which are one page. Answering "you have 50 games" from a
page that was capped at 50 is the mistake this field exists to prevent.
`;

const RESOURCES = [
  {
    name: 'guide',
    uri: 'gametracker://guide',
    config: {
      title: 'GameTracker application guide',
      description:
        'What GameTracker is and how its model works: the five statuses and their lifecycle, '
        + 'why the backlog is ordered, how games are identified, what each library field means, '
        + 'how sharing works, and which failures are worth retrying. Read this before doing '
        + 'anything consequential with a library.',
      mimeType: 'text/markdown',
    },
    text: GUIDE,
  },
  {
    name: 'conventions',
    uri: 'gametracker://conventions',
    config: {
      title: 'Working conventions',
      description:
        'How to use these tools without destroying information: which operations replace '
        + 'rather than modify, which are destructive, how to handle stale fields and '
        + 'pagination honestly.',
      mimeType: 'text/markdown',
    },
    text: CONVENTIONS,
  },
];

module.exports = { INSTRUCTIONS, GUIDE, CONVENTIONS, RESOURCES };
