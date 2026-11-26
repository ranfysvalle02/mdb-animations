# The Index Was PENDING Forever

*What we learned putting MongoDB Atlas Automated Embedding into a real app: where it shines, the local-dev trap
that cost us an afternoon, and the design that works on every cluster. ~8 min read.*

---

It started with a blog post that lied.

Not on purpose. We'd written about [Inkling](https://github.com/ranfysvalle02/mdb-animations), a drawing app
where every save becomes searchable by meaning. A section proudly titled **"Autoembed"** showed off how
Inkling declares which fields to embed and then never thinks about vectors again.

Then we reread it with MongoDB's documentation open, and the reaction was not printable.

It was wrong. In MongoDB, **Automated Embedding** is a specific feature: Atlas itself calls Voyage AI and
embeds a field of your documents, at write time and at query time, with no embedding code in your app. Inkling
wasn't doing that. Inkling called Voyage itself, through a client library, and stored the vectors. That's a
perfectly good design, but it isn't *autoembed*, and calling it that was the kind of mistake that makes readers
stop trusting the rest of the page.

We had two ways to fix the post: change the word, or make the word true. We made it true. This is what happened
next, including the parts that didn't work, so you don't repeat them.

---

## What Automated Embedding actually is

You create a Vector Search index with a field of type `autoEmbed`, and name a Voyage model:

```json
{
  "fields": [
    { "type": "autoEmbed", "modality": "text", "path": "sketch.code", "model": "voyage-code-4" },
    { "type": "filter", "path": "owner" }
  ]
}
```

From then on, Atlas watches the collection. Every document with that field gets embedded, existing ones in an
initial sync and new or changed ones as they arrive. The vectors don't go into your documents: they live in a
separate internal database (`__mdb_internal_search`), one collection per index, kept in step for you.

Querying is the best part. You send **text**, not a vector:

```python
rows = list(shots.aggregate([
    {"$vectorSearch": {"index": "shots_code_autoembed", "path": "sketch.code",
                       "query": pasted_code, "numCandidates": 120, "limit": 12,
                       "filter": {"owner": user_id}}},
    {"$addFields": {"score": {"$meta": "vectorSearchScore"}}},
]))
```

Atlas embeds the query with the same model it used on the documents. Your app never sees a vector.

One word in that index definition matters more than it looks: `"modality": "text"`. Automated Embedding embeds
text fields. Keep that in mind; it shapes everything below.

---

## Choosing what to hand over

Inkling searches three kinds of things: **pictures** (drawings and animation frames), **words** (titles, tags,
the story of a scene), and, since every animation in Inkling is a small p5.js sketch, **code**.

Pictures are Inkling's strongest signal. Doodle a rough cone and you should find the rocket you drew last week.
That needs a multimodal model (`voyage-multimodal-3.5`) that puts images and words in one space, and Automated
Embedding embeds text. So pictures stay where they were: Inkling's own library calls Voyage on save and writes
the vector into the same document.

Code is text, and there's a Voyage model built for it. That was the obvious thing to hand to Atlas:

| What | Who embeds it | Model |
| --- | --- | --- |
| Pictures and words | The app, on save | `voyage-multimodal-3.5` |
| Scene code | **Atlas** (Automated Embedding) | `voyage-code-4` |

**Lesson 1: it's not all-or-nothing.** Automated Embedding is a great default for the text in your data, and
you can run it next to vectors you make yourself, in the same collection, under different indexes.

---

## Act one: hosted Atlas just works

We started small, a scratch database on a hosted Atlas cluster (MongoDB 8.0.39) with three documents:

- The index went from `PENDING` to `READY` and queryable in **66 seconds**.
- A nested path (`sketch.code`) worked, and so did the `owner` pre-filter. The other owner's document never
  showed up.
- `query` worked both as a plain string and as `{"text": "..."}`.
- A newly inserted document was searchable **4.3 seconds** after the insert.

Then in the real app, end to end: save a scene, search by a different piece of code that moves a ship the same
way.

- The scene was findable by its code **1.5 seconds** after the save.
- The search took about **a quarter of a second** (222 to 265 ms across runs).
- Ranking made sense: a rocket that crouches and launches (0.75) came above a spiral galaxy (0.62).
- Another user's search never saw it.

There's no embedding code on that path at all. That was the dream, and on hosted Atlas it's real.

---

## Act two: the local trap

Inkling's local setup uses Docker Compose with the `mongodb/mongodb-atlas-local` image, so every contributor
gets a working vector search without a cloud account. Naturally, we tried Automated Embedding there first.

Creating the index **succeeded**. That's the trap. The index sat in `PENDING`, and any query failed with:

```
PlanExecutor error during aggregation :: caused by :: CanonicalModel: voyage-code-4 not registered yet,
supported models are: []
```

*Supported models are: [].* The search process (`mongot`) had no embedding provider at all.

Here's the trail, so you can skip it:

1. **Setting `VOYAGE_API_KEY` on the container doesn't help.** The variable reached the `mongot` process, and
   the model list stayed empty.
2. **`mongot` wants a flag, not an environment variable.** Its local-dev command line accepts
   `--voyageApiKey`, and it logs either *"Voyage API key provided, setting up embedding service"* or *"No Voyage
   API key provided, skipping embedding service setup."* The Atlas Local runner (in the images we tested,
   tagged `8.0` and `latest`) never passes that flag.
3. **Forcing the flag in gets you halfway.** We wrapped `mongot`'s JVM launcher to append the key. The model
   list filled in, but only with `voyage-3-large`, `voyage-3.5`, and `voyage-3.5-lite`. No code models, and no
   `voyage-4`.
4. **Halfway isn't working.** On the `8.0` image, an index with `voyage-3.5` stayed `PENDING`, and its
   collection in `__mdb_internal_search` had zero documents after minutes of waiting. On `latest` (8.3.11),
   creating it failed with `quantization cannot be resolved from model config`, whether or not we set
   `quantization`.

At least the newer image fails fast. On `latest`, without a key, the `createSearchIndex` call itself errors with
*"not registered yet, supported models are: []"* instead of leaving a `PENDING` index behind.

MongoDB's documentation is candid about why. Automated Embedding is **generally available on Atlas**. On
self-managed deployments it's a **Preview**, and you provide Voyage keys when you deploy `mongot`, ideally one
for indexing and another for queries. Atlas Local is a self-managed `mongot` in a box, and it doesn't expose
that setting yet.

**Lesson 2: to try Automated Embedding, use a hosted Atlas cluster.** A free or Flex cluster is enough to
develop against. Point your local app at it with `MONGODB_URI` and keep the container for everything else.

**Lesson 3: "created" is not "working".** An `autoEmbed` index that can't reach a model may still be created.
Check `status` and `queryable` with `list_search_indexes()`, and if it matters, run one canary query in setup.

---

## Act three: design for every cluster

Your app will meet clusters that can't do Automated Embedding: a contributor's laptop, an older deployment, a
self-managed staging box. Inkling's answer is a graceful fallback, and it's short.

**Setup tries, and survives:**

```python
def ensure_code_index(shots) -> None:
    wanted = code_index_definition()
    shape = lambda fields: sorted((f.get("type"), f.get("path"), f.get("model")) for f in fields)
    current = next(iter(shots.list_search_indexes(CODE_INDEX)), None)
    if current and shape((current.get("latestDefinition") or {}).get("fields", [])) == shape(wanted["fields"]):
        return  # already set up
    try:
        if current:
            shots.drop_search_index(CODE_INDEX)  # then wait until it's gone
        shots.create_search_index(SearchIndexModel(name=CODE_INDEX, type="vectorSearch", definition=wanted))
    except OperationFailure as exc:
        print(f"Automated Embedding isn't available on this cluster ({exc}); code search will fall back.")
```

Look at `shape`. Atlas adds its own defaults to the definition it hands back, such as a similarity function. If
you compare the whole definition, every boot looks like a change, and you'll drop and rebuild the index forever.
**Lesson 4: compare only the fields you set:** type, path, and model.

**Search tries, then falls back:**

```python
try:
    rows = list(shots.aggregate(autoembed_pipeline))
except PyMongoError:
    rows = []
if not rows:
    vector = voyage_multimodal_embed(code)          # one embedding, made by the app
    rows = vector_search(shots, vector, owner)       # the scene's story vector includes its code
```

Two details make that fallback honest:

- **Fall back on empty, not only on error.** An index that's still building, or a cluster that can't embed,
  may simply return nothing.
- **Make the fallback worth having.** Inkling's scene vectors already include the scene's code in their text, so
  the multimodal index can answer code questions, just less sharply than a code model.

And since documents **without** the indexed field are never embedded, an `autoEmbed` index only ever returns
documents that have it. For Inkling that's a feature: only scenes with code come back from a code search.

**Lesson 5: say which engine answered.** Inkling's search returns the engine with the results, and the studio
shows it: *"Atlas Automated Embedding (voyage-code-4), 265 ms"* or *"Voyage AI + Atlas Vector Search."* It's
honest with users, and it's the fastest debugging tool we have.

---

## The small stuff that bites

**Environment variables.** We spent a happy minute wondering why the app ignored a brand-new cluster: the
connection string had been pasted into `MONGODB_DB`, the *database name*. Name your settings so that mistake
looks wrong at a glance, and fail loudly when a database name contains `://`.

**Shared clusters.** The cluster we tested on also held other apps' data, including user logins. Automated
Embedding indexes are per collection, so give your app its own database, and only ever create or drop indexes
inside it.

**Costs and limits.** Every query embeds its text, so every search counts against your Automated Embedding rate
limits, just like writes do. Things that don't need a new embedding shouldn't make one. Inkling's
*"similar to this asset"* reuses the vector already stored for the asset: zero new embeddings.

**Tests.** None of this needs a live cluster to test. Mock `aggregate` to return rows and check the `$vectorSearch`
stage you built: index, path, plain-text query, owner filter. Then make it raise `OperationFailure` and check
that the fallback ran. Two small tests cover the whole contract.

---

## The checklist

If you only read this far:

1. **Automated Embedding embeds text.** Use it for text fields; keep app-side multimodal vectors for images.
2. **Develop against hosted Atlas.** Atlas Local doesn't hand `mongot` a Voyage key yet, so `autoEmbed` indexes
   there never become queryable.
3. **Created isn't working.** Check `status` and `queryable`, and run a canary query.
4. **Compare index definitions by what you set** (type, path, model), not by what Atlas returns.
5. **Fall back on errors *and* on empty results**, to something that genuinely answers the question.
6. **Filter by owner inside `$vectorSearch`**, not after it.
7. **Show which engine answered.** Your users and your future self will thank you.
8. **Call it Automated Embedding only when Atlas does the embedding.**

---

## What it's like now

In Inkling, you draw a rocket and press **Animate**. Gemini picks the poses, and math draws the frames from your
own strokes. The animation is saved as a few dozen lines of p5.js. A second and a half later, Atlas has
embedded that code with a model built for code. Paste a few lines that move *anything* the same way, and your
rocket comes back first.

No embedding code, no queue, no second database. Just a word in an index definition, `autoEmbed`, that's now
true.

*Inkling is open source: [github.com/ranfysvalle02/mdb-animations](https://github.com/ranfysvalle02/mdb-animations).
The whole Automated Embedding integration is two functions in `backend/production.py` and one in
`backend/setup.py`. Try it at [inkling.oblivio-company.com](https://inkling.oblivio-company.com).*
