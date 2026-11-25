# Deploy Inkling to Render

One Docker web service on [Render](https://render.com), one hosted MongoDB Atlas cluster, three API keys.
About 15 minutes, most of it waiting for the first build.

```
browser ──HTTPS──▶ Render (Docker: FastAPI + the studio) ──▶ MongoDB Atlas   (data + 6 vector indexes: drawings, assets, scenes, elements, frames, and scene code via Automated Embedding)
                                                         ──▶ Voyage AI       (embeddings)
                                                         ──▶ Gemini          (drafts)
                                                         ──▶ m-stash         (accounts, server to server)
```

The image is the same one Docker Compose runs locally, and it configures itself: `python -m backend.serve`
binds Render's `$PORT` within seconds, then, in the background, builds the collections and vector indexes and
seeds the shared demo library once. `/api/ready` reports each phase ("Building search indexes…"), and the studio
shows **Warming up…** until search is ready. On Render it also trusts the TLS proxy automatically (secure
cookies). So a plain **Web Service** works as well as the Blueprint: it only needs the secrets.

---

## 1. MongoDB Atlas (5 minutes)

1. **Create a cluster** at [cloud.mongodb.com](https://cloud.mongodb.com). Inkling creates **6 vector
   indexes**: five Voyage multimodal ones (ideas, assets, scenes, layers, frames) and one
   [Automated Embedding](https://www.mongodb.com/docs/vector-search/crud-embeddings/automated-embedding/) index
   on scene code (`voyage-code-4`; Atlas embeds the code itself). The free M0 tier allows only 3 search indexes,
   so use **Flex** or **M10+**. Without Automated Embedding, code search falls back to the multimodal vectors.
2. **Database Access → Add user** with *Read and write to any database* (or scope it to your
   `MONGODB_DB`). Setup also creates the search indexes, which this role allows.
3. **Network Access → Add IP.** Render's outbound addresses are listed in your service's
   **Connect → Outbound** tab once it exists. Add those (best), or `0.0.0.0/0` while you test.
4. **Connect → Drivers** and copy the `mongodb+srv://...` string. URL-encode special characters in the
   password.

## 2. Keys (2 minutes)

| Key | Where | Used for |
| --- | --- | --- |
| `VOYAGE_API_KEY` | [dash.voyageai.com](https://dash.voyageai.com) | `voyage-multimodal-3.5` embeddings (every save and search) |
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com/apikey) | Ask AI, variations, auto-tags |
| m-stash `pk_` key | already in `render.yaml` | Accounts. Publishable, so it's safe to commit. **Never** use an `sk_` key here |

## 3. Render (3 clicks, then wait)

**Either** a Blueprint (below), **or** New → Web Service → this repo → Docker, with these environment variables:
`MONGODB_URI`, `VOYAGE_API_KEY`, `GEMINI_API_KEY`, `MSTASH_APP_KEY` (and optionally `MSTASH_APP_ID`, `MONGODB_DB`).
Everything else has safe defaults.

1. Push this repo to GitHub (or GitLab).
2. Render dashboard → **New → Blueprint** → pick the repo. Render reads [`render.yaml`](../render.yaml).
3. Fill in the three secrets it asks for: `MONGODB_URI`, `VOYAGE_API_KEY`, `GEMINI_API_KEY`. Then **Apply**.

What the Blueprint sets for you:

| Variable | Value | Why |
| --- | --- | --- |
| `MONGODB_DB` | `inkling` | Database name |
| `INKLING_SETUP_ON_START` | `1` | Create collections + vector indexes on boot (idempotent; keeps data) |
| `INKLING_SEED_DEMO` | `1` | Seed the shared demo library once, in the background (Voyage calls on first boot only) |
| `TRUST_PROXY` | `1` | Render terminates TLS: session cookies become `Secure`, sign-in limits use the real client IP |
| `INKLING_SERVICE_KEY` | generated | Lets in-container scripts act as a library, over loopback only |
| `MSTASH_APP_KEY`, `MSTASH_APP_ID`, `MSTASH_API` | Inkling's m-stash app | Accounts. Swap in your own app to own the user list |
| `INKLING_AI_PER_HOUR`, `INKLING_EMBEDS_PER_HOUR` | `60`, `600` | Hourly per-member budgets for Gemini drafts and Voyage saves/searches (`0` = unlimited) |
| `WHERE_USED_MIN_SCORE`, `SIMILAR_ASSET_MIN_SCORE` | `0.75` | Look-alike cutoffs (see [NEXT-STEPS.md](../NEXT-STEPS.md)) |

Link previews (the card in [`og.png`](../og.png)) use Render's `RENDER_EXTERNAL_URL` automatically. On a
custom domain, set `PUBLIC_URL=https://your.domain`.

**Plan:** `starter` is the default. `free` works but sleeps when idle, so the first visit takes about a minute.

## 4. First boot (about 2–4 minutes after the build)

Watch **Logs**. You should see, in order:

```
drawings: collection and Voyage vector index are ready.
...
shot_frames: collection and Voyage vector index are ready.
INFO:     Uvicorn running on http://0.0.0.0:10000
Assets: Red Rocket, Pine Tree. Shots: SQ010_0010, ...
Asset 'Little Fox': 3 versions from doodle to finished. ...
Demo library ready: open the studio, sign up, and tap 'Start with the demo library'.
```

Render's health check (`/health`) passes as soon as the API is up. Search becomes available once
`/api/ready` returns 200, which means every vector index is queryable.

## 5. Check it (1 minute)

```sh
curl -s https://YOUR-APP.onrender.com/health          # {"status":"ok"}
curl -s https://YOUR-APP.onrender.com/api/ready       # {"status":"ready",...}
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR-APP.onrender.com/api/assets   # 401: locked without a session
```

Then open the URL, **Create account**, tap **Start with the demo library**, and follow
[the tour](TUTORIALS.md). For the full end-to-end check, open the service's **Shell** in Render and run:

```sh
python -m backend.smoke_test   # signs in through m-stash and exercises everything; billable Voyage + Gemini calls
```

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Deploy fails, logs say `Set MONGODB_URI and VOYAGE_API_KEY` | A secret is missing | Add it under **Environment**, then redeploy |
| Logs show `ServerSelectionTimeoutError` | Atlas is blocking Render | Add Render's outbound IPs (or `0.0.0.0/0` to test) in Atlas **Network Access** |
| `OperationFailure ... search index` / limit reached | M0 cluster (3-index cap) | Use Flex or M10+ |
| `/api/ready` says "Building search indexes" | First boot on this cluster | Wait 1-3 minutes; the studio reconnects by itself |
| `/api/ready` says "Atlas refused the index setup: ..." | Usually the M0 limit (3 search indexes) or a user without index rights | Use Flex/M10+, or a user with read/write; then redeploy (setup is idempotent) |
| `/api/ready` says "Can't reach MongoDB Atlas" | Network Access or a bad URI | Fix it in Atlas, then redeploy |
| "Start with the demo library" says there's no demo yet | The background seed hasn't finished (or failed) | Check the logs; or run `python -m backend.seed_demo` in the Shell |
| Sign-in works but you're signed straight out | The cookie isn't marked `Secure` behind the proxy | Make sure `TRUST_PROXY=1` |
| First sign-in of the day is slow | m-stash wakes from idle | The UI says so after 4 s; later sign-ins are fast |
| "Too many sign-in attempts" | 10 per 5 minutes, per address and per account | Wait a few minutes |
| "You've used this hour's 60 AI drafts" | The member's hourly budget | Wait (the message says how long), or raise `INKLING_AI_PER_HOUR` |
| A push didn't deploy | CI failed, or auto-deploy is off | Check the repo's **Actions** tab (tests, lint, Docker build) |

## Before you share it widely

- **Cost:** every save and search calls Voyage; Ask AI and auto-tags call Gemini. Each member gets an hourly
  budget (`INKLING_AI_PER_HOUR`, default 60 drafts; `INKLING_EMBEDS_PER_HOUR`, default 600 saves and searches),
  shown in their account menu. Failed calls aren't charged. Budgets reset on restart, so still set budget alerts
  with both providers.
- **Backups:** turn on Atlas backups (M10+) or scheduled exports.
- **Your own accounts:** create your own m-stash app and set `MSTASH_APP_KEY` / `MSTASH_APP_ID`, so the
  user list is yours.
- **Privacy:** artwork is sent to Voyage and Gemini. Say so in your terms.
