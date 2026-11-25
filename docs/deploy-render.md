# Deploy Inkling to Render

One Docker web service on [Render](https://render.com), one hosted MongoDB Atlas cluster, three API keys.
About 15 minutes, most of it waiting for the first build.

```
browser ──HTTPS──▶ Render (Docker: FastAPI + the studio) ──▶ MongoDB Atlas   (data + 5 vector indexes)
                                                         ──▶ Voyage AI       (embeddings)
                                                         ──▶ Gemini          (drafts)
                                                         ──▶ m-stash         (accounts, server to server)
```

The image is the same one Docker Compose runs locally. On Render there's no separate setup job, so the
container does it on boot: `python -m backend.serve` creates the collections and vector indexes
(`INKLING_SETUP_ON_START=1`), starts the API on Render's `$PORT`, and seeds the shared demo library once in
the background (`INKLING_SEED_DEMO=1`). We rehearsed exactly this, against an empty database, before writing
this guide.

---

## 1. MongoDB Atlas (5 minutes)

1. **Create a cluster** at [cloud.mongodb.com](https://cloud.mongodb.com). Inkling creates **5 vector
   indexes** (ideas, assets, scenes, layers, frames). The free M0 tier allows only 3 search indexes, so use
   **Flex** or **M10+**.
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
| `WHERE_USED_MIN_SCORE`, `SIMILAR_ASSET_MIN_SCORE` | `0.75` | Look-alike cutoffs (see [NEXT-STEPS.md](../NEXT-STEPS.md)) |

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
| `/api/ready` returns 503 for a few minutes | Vector indexes are still building | Wait; Atlas reports them queryable within minutes |
| "Start with the demo library" says there's no demo yet | The background seed hasn't finished (or failed) | Check the logs; or run `python -m backend.seed_demo` in the Shell |
| Sign-in works but you're signed straight out | The cookie isn't marked `Secure` behind the proxy | Make sure `TRUST_PROXY=1` |
| First sign-in of the day is slow | m-stash wakes from idle | The UI says so after 4 s; later sign-ins are fast |
| "Too many sign-in attempts" | 10 per 5 minutes, per address and per account | Wait a few minutes |

## Before you share it widely

- **Cost:** every save and search calls Voyage; Ask AI and auto-tags call Gemini. Accounts gate access, but
  there's no per-member AI quota yet. Set budget alerts with both providers.
- **Backups:** turn on Atlas backups (M10+) or scheduled exports.
- **Your own accounts:** create your own m-stash app and set `MSTASH_APP_KEY` / `MSTASH_APP_ID`, so the
  user list is yours.
- **Privacy:** artwork is sent to Voyage and Gemini. Say so in your terms.
