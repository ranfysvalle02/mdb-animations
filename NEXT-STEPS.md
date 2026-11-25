# Inkling: next steps

> **Thesis.** AI shouldn't make the art. It should take the *busywork* away from the people who
> do: the eye that won't come right, the nine lookalikes a battle scene needs, the "which shots use
> the old rocket?" email chain, the hour spent hunting for the tree you drew last spring. The artist's
> hand stays on every line, and the studio remembers everything: by meaning, by usage, and by process.

**The story, in one breath:** *Draw it once. Animate it anywhere. Find any frame.*
**The promise underneath it:** *AI drafts. You decide. Every stroke is remembered.*

Every step below has to sharpen **Draw → Animate → Find**, or keep that promise. Otherwise it waits.

---

## Where we are (v1.0)

| Beat | What works today |
| --- | --- |
| **Start** | 8 starters (blank, beach, mountains, forest, city at night, outer space, character sheet, bouncing-ball flipbook) as editable layers. They float over an empty canvas and vanish on the first touch |
| **Draw** | Built for fingers and pencils: pressure, palm rejection, brush-pen feel, 12 layers, shapes, eraser, Move, **Focus**, undo for everything |
| **Ask AI** | One box, three modes, always previewed: **Sketch a layer** (blue-pencil draft under your ink), **Fix a spot** (a few strokes in a box), **Grow variations** (Gemini edits *your* strokes into lookalikes, from a plan you can edit) |
| **Assets** | Versioned assets with a duplicate check ("this looks like Rocket Ship"), lineage (🌱 Family), and similar assets |
| **Animate** | **🎬 Animate**: pick what moves, a backdrop, and a free preset or a described motion; one Gemini call returns keyframes (move, squash, turn) for the artist's own layers, previewed, then baked into editable frames (1-3 s at 8 fps). Grab anything on the canvas to move or resize it per frame; ink never lands on a linked asset. Every step is in the audit trail |
| **Find** | One bar over assets, scenes, **single frames**, and ideas: by words, **by sketch**, or "with ◆ asset". Filters (status, project, hand share, color) run *inside* Atlas vector search |
| **Remember** | Audit trail of every AI step taken or skipped; **Breakdown** (exposure sheet, who made what); every stroke's order and time; **Watch it being made**, **⬇ Save replay** (video), **Evolution** (v1 → vN), and **art math** stored in Atlas |
| **Accounts** | m-stash sign-up and sign-in; every query and vector search scoped by `owner`; token kept in an HttpOnly cookie, verified by m-stash; a private copy of the demo library in one tap; guide progress synced as an m-stash record |
| **Any screen** | Mobile-first, plain copy with an example everywhere, tooltips, a 4-step guide, microanimations that respect *reduce motion* |
| **Ship** | One Docker image for Compose and Render (`render.yaml`): index setup and the demo seed on boot, `$PORT`, Secure cookies behind TLS. [Tutorials](docs/TUTORIALS.md) and screenshots regenerate from a script |

### The data model that makes it work

```
assets          { name, type, version, layers, tags, origin, history,
                  stats{strokes, hand_share, ink_px, draw_ms, colors} }     + 1 vector
asset_versions  { asset_id, version, layers, stats }                         (Evolution, replay of any version)
shots           { code, project, sequence, status, assignee, fps,
                  layers[ {..., asset: {asset_id, version}} ], frames, history } + 1 vector (frame 1)
shot_frames     { shot_id, frame, hash, asset_ids, project, sequence, status }    + 1 vector per frame
shot_elements   { shot_id, layer_index, asset_id?, box, project, status }     + 1 vector per layer's ink
strokes         { points, color, width, ai?, kit?, seq, ms }                  (inside layers: the process)
```

Every document carries its `owner` (the m-stash member). Owner, operational metadata, and art math are
copied onto every vector document and declared as **filter** fields, so "not approved, sequence SQ010, mostly by hand" is applied inside the vector search, not
after it. Per-element vectors keep a small prop in a busy scene findable, and per-frame vectors (hashed,
so only changed frames re-embed) make "the moment it clears the trees" a query.

### What we measured (live, Voyage `voyage-multimodal-3.5`, Atlas Local 8.0)

Query: the "Red Rocket" asset picture. Scores are Atlas vector-search scores.

| Shot element | Truth | Score |
| --- | --- | --- |
| Rocket placed from the asset (small, corner) | linked | exact link (also 0.96 visually) |
| Rocket *redrawn by hand*: blue, skinnier, never linked | look-alike | **0.855** |
| Rocket painted into the same layer as a city skyline | look-alike | **0.791** |
| Tree and house (no rocket) | unrelated | 0.67-0.68 |
| Background hills | unrelated | 0.66 |

A cutoff of **0.75** (`WHERE_USED_MIN_SCORE`) separates these, and the UI labels >= 0.82 as "strong".
It started at 0.72, until Little Fox (a colored fox) matched three rocket layers at **0.72-0.73**: unrelated
figures with a similar build on white can score that high. Real look-alikes so far score 0.79-0.96.
**Caveat: that's a handful of assets.** It's a signal, not a benchmark (see step 1).

**Asset vs asset** (duplicate check and *Similar assets*; asset vectors also carry name, type, and
description): a slightly reshaped rocket scored **0.88** against Red Rocket, and Sam's "Rocket Ship"
**0.88**. Pine tree, badge, and unrelated drawings scored **0.61-0.69**. Cutoff: **0.75**
(`SIMILAR_ASSET_MIN_SCORE`).

**AI sketch**: 5-10 s per draft with `gemini-3.5-flash` (low thinking), typically 10-40 strokes. It
reads as a clean rough. It's good scaffolding, and nobody would mistake it for finished art, which is the point.

**Frame search** (16 frames in 8 scenes): words find the right *scene* reliably ("four rockets lined up for
battle" -> SQ050 0.77 vs next scene 0.69; "a house at the edge of a forest" -> SQ020 0.71 vs 0.61). Within one
flipbook, neighboring frames tie on words (0.782-0.785), so hits are grouped per scene with frame chips. A
**sketch** separates frames by composition: pine + rocket up high ranks the liftoff's frame 6 first, and the
smoke test's liftoff (frames 6, 4, 5) the same way. Results keep hits within 0.06 of the best.

**Variations** (Red Rocket, 5 artist strokes): the plan took ~3.5 s. Each variation took 3.5-8 s, three in parallel.
Additive briefs (lasers, damage, emblem, shield) kept **5 of 5** artist strokes verbatim and added 2-6;
a repaint brief ("paint it green") honestly kept **2 of 5** and redrew the rest. Kept variants land in
the original's 🌱 Family and are left out of "similar assets" (siblings scored 0.80-0.88 against each other).

**Process** (Little Fox, 3 versions): v1 has 4 strokes, v2 has 9, and v3 has 19, with 2 accepted AI whiskers.
That's 89-90% hand and about 23 s pencil down. "Mostly by hand" (>= 80%) keeps it and filters out the AI-heavy
variations (46-71% hand).

---

## Next steps, in order

Effort: S (a day), M (a few days), L (a week+).

### 1. Prove it with numbers (S-M)
Today's thresholds rest on a handful of synthetic drawings. Before showing a studio:
- **Where used**: 30-50 labeled asset -> shot pairs (linked, redrawn, restyled, occluded, mirrored, tiny,
  true negatives), with real artist line art. Report Hit@1, recall at the cutoff, and false positives. Compare
  element vectors, frame vectors, and shot vectors (reuse Cinematlas `evaluate()`).
- **Frames**: 50 word and sketch queries with labeled best frames; tune `SEARCH_SPREAD`.
- **Variations**: 20 assets x 10 briefs, scored by artists on *on-model?* and *kept my hand?*. Add a
  keep floor, so a result that drops the artist's strokes is rejected unless the brief asks for a redraw.
- **Exit:** one sentence a studio believes: "finds 9 of 10 unlinked uses; variations keep 90% of your line".

### 2. Find things like *this* (S-M)
- Box part of any canvas or frame ("just the rocket, up here") and search assets, elements, and frames by
  that crop, plus position. It's "where used" for things that were never assets, and the fastest path to reuse.
- "Frames still showing Red Rocket v1" as a filter (versions are already stored per layer).
- "Not this asset" to dismiss a look-alike; confirmations and dismissals become labeled data for step 1.

### 3. Assets that hold up in production (M)
- **Layer-aware variations**: keep line, color, and shadow layers, and vary one. Today variations flatten the asset.
- **Region variations**: vary just the helmet, N-up.
- **Turnarounds**: front, 3/4, side, and back, with a consistency score against the original's vector.
- **Before/after diff** shown before *Update to vN* (the versions are already stored).
- **Save layer as asset**, and transform handles stored on the link (not baked), so version swaps re-apply them.

### 4. Process as data (M)
- **Process search**: "drawn in under 2 minutes", "redrawn the most", "AI touched less than 5%", and sort
  by ink, time, or versions. The art math is already stored.
- **Evolution diffs**: highlight the strokes each version added, removed, or redrew.
- **Process fingerprints**: find assets *made the way this one was* (rough pencil, then clean line, then fills).
- **Starter packs per project**: save any scene as a starter for the whole show.

### 5. AI that knows your studio (M)
- **Sketch from my library**: pass the nearest assets as references, so "the hero running" uses *your* hero.
- **Style memory**: kept-vs-skipped decisions (already in the audit trail) become few-shot examples per artist.
- **Continuity check**: compare a placed character with its asset and flag drift in costume or colors.

### 6. Motion, to a point (M-L)
Animation stays a taste of what's possible; assets are the product. Shipped: presets and AI keyframes for the
artist's own layers, previewed and baked into editable frames.
- **Keep the keyframes**: store motion as editable tracks (not only baked frames), with a curve editor, so a
  timing tweak doesn't mean redrawing frames; then longer scenes (10 s) without 80 stored frames.
- **Suggest an in-between**: AI proposes frame N+1 from N and N+2 by moving the artist's own strokes, with
  an onion-skin preview, accepted per layer.
- **Secondary motion**: let AI animate parts (a waving arm, a tail) once assets keep their own layers (step 3).
- **Motion-aware frame search**: frame deltas as a second vector, to rank within a scene.
- Index animatics and dailies with **Cinematlas video**: "the rocket appears at 0:42 in SQ030".

### 7. Plug into the studio's tracker (L)
- Sync shots, status, and assignees with Flow Production Tracking (ShotGrid), ftrack, or Kitsu. Inkling
  becomes the visual memory next to the tracker, not a replacement for it. Webhooks update filter fields
  without re-embedding.

### 8. Production-grade (L, before any real studio data)
- Shipped: accounts (m-stash) and per-member isolation in every query and vector filter.
  Next: shared studio libraries (teams), per-project roles, and an m-stash allowed origin for the hosted domain.
- Artwork goes to Voyage and Gemini: per-project provider controls, retention, a processing agreement, and
  self-hosted or VPC options.
- Shipped: a Render Blueprint ([docs/deploy-render.md](docs/deploy-render.md)), hourly per-member budgets for Gemini drafts and Voyage calls, and CI.
  Next: persistent budgets (they're in-process and reset on restart), Atlas backups, cost metering per project.
- A signed, exportable audit trail and process record (JSON/PDF) for clients and rights reviews.
- Deleting an asset offers to unlink or re-link its placements instead of refusing.

---

## Known limitations (today)

- Calibration rests on a tiny synthetic set (step 1).
- Variations and placements flatten a multi-layer asset into one layer, and transforms are baked into points (step 3).
- *Update to vN* replaces the placed layer's strokes. Anything drawn on that same layer moves to a hidden backup.
- Elements are per *layer*: a look-alike sharing a layer with lots of other ink scores lower (0.79 vs 0.86).
  Per-layer elements come from frame 1 only; every frame gets a whole-frame vector.
- Frames copy the whole layer stack (24 frames, 8 MiB request cap).
- Process data covers strokes drawn since it shipped; older strokes have no time and replay in layer order.
- The audit trail records what the member's browser reports, not signed events.
- New saves take a moment to become vector-searchable (eventual consistency); exact links are immediate.
- Libraries are per member; there are no shared team libraries or roles yet (step 8).
- Budgets live in process memory: a restart resets them, and more than one instance would need a shared store (step 8).
- The demo copy is a snapshot: improvements to the shared demo don't reach copies already made.
- "Inkling" needs a trademark check before any public launch.

## Metrics that matter

- **Hand share** across saved assets. It should stay high: the measure of "AI empowers, not replaces".
- **Time to first stroke** (starters, AI sketch) and **time to a usable asset**.
- **Find rate**: share of real asset uses found at the chosen cutoff; time to answer "where is X used?" (< 2 s).
- **Variation keep rate**: kept / drawn, and the artist-stroke keep ratio inside each kept one.
- **Reuse rate**: placements per asset, and drawings started from a library search.

## How to try it

```sh
docker compose up --build -d --wait --wait-timeout 900
docker compose exec -T studio python -m backend.seed_demo   # the shared demo library members can copy
```

Open <http://localhost:8000/studio>, create an account, and tap **Start with the demo library**. Then:
1. **Start:** on the blank canvas, tap **🏖️ Beach**, and draw on *Draw here*.
2. **Draw + Ask AI:** pick **Grow variations**, tap "a battle: different weapons and poses", keep a few, and **Build a scene**.
3. **Animate:** add frames, **Move** the rocket, press Space.
4. **Find:** **🎞 Frames**, "the rocket high above the pine tree", or doodle it and tap ✏️.
5. **Remember:** Library -> **Little Fox** -> Where used? -> **🔍 Breakdown** -> **✎ Watch it being made**, then **⬇ Save replay**.
