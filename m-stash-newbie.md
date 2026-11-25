# m-stash, from a newbie: lessons from wiring Inkling

*Field notes from adding m-stash accounts to [Inkling](README.md), a FastAPI + MongoDB Atlas app with a
vanilla JS front end. Each note covers what we expected, what happened, and one change that would have saved
the time. Written to make m-stash better, not to complain: the core idea worked.*

---

## TL;DR

**What we built:** sign-up and sign-in, a private library per member (every Atlas query and vector search
filtered by `owner`), and per-member preferences stored as an m-stash `item` record. It works end to end,
including a live smoke test that signs in through m-stash and proves another library gets a 404.

**What went right:**
- The publishable/secret key split is clear.
- Ownership enforced on the server is the right default.
- Responses were fast (about 0.3 s once warm).
- Tampered and forged tokens were refused (403).

**What slowed us down:** six things, ranked by how much time they cost.

| # | Friction | Time lost | Suggested fix |
|---|---|---|---|
| 1 | Browser calls blocked by CORS from localhost, with no hint why | High | Let sandbox and dev apps accept `localhost` and `127.0.0.1`, and document allowed origins in the skill |
| 2 | No documented way for a **backend** to verify a token | High | Put `GET /v1/auth/verify` in `llms.txt` and the skill (today it's only in the manifest) |
| 3 | Sign-up rules not documented (password 12–72, username format) | Medium | List them in the skill, or make `username` optional |
| 4 | `409 "Email or username is already claimed"` doesn't say which | Medium | Return machine-readable codes: `email_taken`, `username_taken` |
| 5 | `PUT` on a missing record returns 404 (no upsert), and `PUT` replaces `data` | Low | Document it, or add `?upsert=true` / a merge `PATCH` |
| 6 | No way to delete test users that the verify script creates | Low | `DELETE /v1/me`, or a self-cleaning verify script |

---

## What happened, in order

### 1. "Who is this token?" There was no `/v1/me`

The skill explains how to sign up and how to send `Authorization: Bearer <token>`. It doesn't explain how a
backend should find out who a token belongs to. That's the first thing any app with its own database needs:
our Atlas documents need an `owner`.

We tried the obvious routes:

```
GET /v1/me            -> 404 {"error":"API route not found"}
GET /v1/auth/me       -> 404
GET /v1/auth/session  -> 404
GET /v1/me/profile    -> 404
```

The token is an **HS256** JWT, so we can't verify it ourselves; that would need the signing secret. Our first
working version called `GET /v1/me/identities` (any authenticated route works) and then read `uid` from the
payload. That's sound, because the signature covers the payload, but it's a workaround.

Later we found `authentication.verificationEndpoint: "/v1/auth/verify"` in `/.well-known/m-stash.json`.
It's exactly the right tool:

```json
GET /v1/auth/verify  ->  200 {"active": true, "claims": {"uid": "...", "email": "...", "expiresAt": ..., ...}}
                         403 {"error": "Invalid or expired token"}   (tampered or forged)
```

**Suggestions**
- Put `/v1/auth/verify` in `llms.txt` and the skill. Add a section called **"Verify a token on your backend"**
  with a 5-line example in Python and Node.
- Add `GET /v1/me` as an alias (`{user, namespace}`). Everyone tries it first.
- Return `appId` in the verify `claims`. The JWT carries it, but the verify response doesn't, so a backend
  can't pin tokens to its own app without decoding the token itself.
- Also tell people how to *find* their app id. We only learned ours (`appId`) by decoding a token.
  Including it in the sign-up response or a `GET /v1/app` (keyed by `pk_`) would help.
- Longer term, consider asymmetric signing (RS256/EdDSA) plus a JWKS URL, so backends can verify offline
  with no network call per request.

### 2. CORS: "Failed to fetch," and nothing else

The skill says to call the API from the browser with `fetch(url, { credentials: "omit" })`, which suggests
calling m-stash straight from page scripts is supported. From `http://127.0.0.1:8000`, sign-up failed with:

```
Access to fetch at 'https://m-stash.onrender.com/v1/auth/signup' from origin 'http://127.0.0.1:8000'
has been blocked by CORS policy: Response to preflight request doesn't pass access control check
```

Page scripts only see `TypeError: Failed to fetch`. We probed the preflight:

| Origin | Preflight |
|---|---|
| `http://127.0.0.1:8000`, `http://localhost:8000`, `http://localhost:3000`, `https://m-stash.com`, `null` | 403, no `Access-Control-Allow-Origin` |
| same, with `?app=pk_...` | 403, but `Access-Control-Allow-Headers` present |

`llms.txt` mentions `allowedOrigins` only as an optional field on **claim**. As the person integrating, we found
no way to see or change our app's allowed origins.

**Suggestions**
- **Allow `http://localhost:*` and `http://127.0.0.1:*` by default for sandbox and dev apps.** That's where
  every first integration happens.
- Add a row to the skill's "When a call fails" table: *Browser shows "Failed to fetch" and the console says
  CORS → your origin isn't allowed. Add it in the console, or call m-stash from your backend.*
- A read-only `GET /v1/app/origins?app=pk_...` (or listing them in the manifest per key) would turn a
  guessing game into one curl.

**What we did instead:** a small backend-for-frontend. The browser sends email and password to Inkling
(`/api/auth/signup`, `/api/auth/login`); Inkling calls m-stash server to server and keeps the token only in an
`HttpOnly; SameSite=Strict` cookie. We prefer this anyway: the token never touches page scripts, and `<img>`
requests are authenticated automatically. It deserves a section in the docs as a recommended pattern (see
the recipe below).

### 3. Sign-up rules we discovered by failing

| Rule | How we learned it |
|---|---|
| Password **12–72** characters | `400 "password must be between 12 and 72 characters"` |
| Username **must start and end with a lowercase letter or number** | `400 "username must begin and end with a lowercase letter or number"` |

Neither rule is in the skill; its verify script happens to use a 19-character password. These rules are good,
but discovering them one 400 at a time slows down every UI.

**Suggestions**
- Publish the rules in the skill, or as `GET /v1/auth/rules` (or `providers` could include them), so forms can
  validate before submitting.
- **Make `username` optional.** Artists don't want to invent a handle on screen one. We derive one
  (`ada.l@x.com` → `ada-l-7k2f`); m-stash could do the same and return it.

### 4. An ambiguous 409

```
409 {"error": "Email or username is already claimed"}
```

The same response comes back whether the email or the username is taken, so the UI can't tell the person
which. Our workaround: on 409, try **login** with the same credentials. If that works, it's a returning member
who picked the wrong tab, so we sign them in. If it doesn't, we say *"That email already has a studio. Switch
to Sign in."*

**Suggestion:** add a stable machine-readable `code` next to every `error`, e.g.
`{"error": "...", "code": "email_taken"}`. That also fixes the general problem of matching error *messages*,
which the skill's "When a call fails" table currently asks us to do ("Message contains...").

### 5. Records: `PUT` isn't an upsert, and `data` is nested twice

Saving per-member preferences (`item/inkling-prefs`):

```
GET  /v1/me/resources/item/inkling-prefs   -> 404 (first time)
PUT  /v1/me/resources/item/inkling-prefs   -> 404 "Resource not found"
POST /v1/me/resources/item                 -> 201
PUT  (again, with a smaller data object)   -> 200, data replaced wholesale (old keys gone)
```

So "save my settings" is PUT, then POST on 404. That's easy once you know it. We also hit some shape confusion:

- The record body has a top-level `title`, and the skill's `item` schema also has a field called `title`
  inside `data`, so we stored both.
- Responses wrap the record in `data`, and the record has its own `data`, so reads look like
  `body["data"]["data"]`.

**Suggestions**
- Support `PUT` as an upsert, or offer `?upsert=true`. Settings, save slots, and profiles all want it.
- Document that `PUT` replaces `data`, and offer a merge-style `PATCH` (there's already `PATCH` for the
  atomic `increment` op).
- Rename the record's payload field (e.g. `fields`), or show the full response envelope once in the skill.

### 6. Test users pile up

The skill's verify script signs up a new user **every run**, and free-tier apps are capped by
`FREE_TIER_MAX_USERS`. We found no endpoint to delete a user, so three test accounts remain in our app: the
verify script's, our smoke test's, and one from a browser run.

**Suggestions**
- `DELETE /v1/me` (delete my account and my records). Good for GDPR-style requests too.
- Have the verify script reuse one account: log in, and sign up only on 401. That's the pattern our smoke test
  uses, with a password derived from a server-side secret so nothing new is committed.

---

## Smaller notes

- **Cold starts.** The first request after idle can be slow. Our UI says *"Waking the account service (the
  first sign-in of the day can take ~30 s)…"* after 4 s, and our backend uses a 60 s timeout. A sentence in the
  docs would save others from deciding it's broken.
- **Token lifetime.** `exp - iat` is 7 days. It isn't documented, and there's no documented refresh or logout
  (revocation) route. We size our cookie to the token's `exp`. Say the lifetime explicitly, and add a revoke
  route if one exists.
- **Shared IP when proxying.** Once the backend proxies login, m-stash sees every member coming from one IP.
  We added our own per-client limit (10 attempts per 5 minutes). If m-stash rate-limits by IP, document how a
  trusted backend (holding `sk_`) can forward the real client address.
- **A testing gotcha (not an m-stash bug).** Our first "tampered token" test changed the *last* base64url
  character of the signature and got **200**. The final character of a 32-byte signature carries padding bits,
  so the decoded bytes didn't change. Changing a middle character, or forging the payload, correctly got 403.
  A one-line note in a "verify your integration" section would stop someone from filing a false alarm.
- **Python.** `mstash.js` is great for JS, but backends in other languages start from scratch. A 30-line
  `urllib` snippet (sign up, log in, verify, upsert a record) in the docs would cover most of them.

---

## What was genuinely great

- **Publishable vs secret keys.** "The `pk_` key is safe in the browser" is clear and correct. We committed
  it as a compose default with confidence.
- **Ownership on the server.** We never had to write a security rule for m-stash data. That's the pitch, and
  it held up.
- **`llms.txt` and the skill.** They're short and practical, and the `curl -f` verify script gave us a working
  sign-up in one minute.
- **`/.well-known/m-stash.json`.** It's what rescued us on item 1. More of the docs should point to it.
- **Honest errors.** Every 400 told us exactly what was wrong; we just wanted the rules up front.

---

## The recipe that worked (backend-for-frontend)

For any app with its own database and server, this is the shape we'd recommend:

```
browser ──email+password──▶ your backend ──▶ m-stash /v1/auth/signup | /v1/auth/login
                                         ◀── token
        ◀── Set-Cookie: session=<token>; HttpOnly; SameSite=Strict; Secure

every request: cookie ──▶ your backend ──▶ m-stash GET /v1/auth/verify   (cache ~5 min)
                                       ──▶ claims.uid  ==  owner on every query
```

1. **Sign up:** derive the username; on 409, try login and sign in a returning member.
2. **Verify:** call `GET /v1/auth/verify`, take `uid` from *its* answer, and cache it briefly (hash the token
   as the cache key). Optionally pin the token's `appId`.
3. **Scope:** stamp `owner = uid` on every record, and put `owner` in every query, update, delete, and
   **vector search filter**. Fail closed: refuse any data access without an owner.
4. **Per-user settings:** use an m-stash record with PUT, then POST on 404, sent with the member's own token.
5. **Scripts:** have a test account log in (sign up only on 401) instead of minting users every run.

In Inkling this is [`backend/auth.py`](backend/auth.py) (verification, sign-up and login proxy, preferences,
throttle) and the `authenticate` middleware in [`backend/main.py`](backend/main.py). Tests are in
[`backend/tests/test_auth.py`](backend/tests/test_auth.py).

---

*If you maintain m-stash: the three changes with the biggest payoff are **localhost CORS for dev apps**,
**`/v1/auth/verify` in the docs**, and **error `code`s**. Together they would have turned a long evening into a
short one.*
