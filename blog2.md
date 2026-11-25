# Saving Is Searching

*How Inkling turns every drawing, every animation, and every line of code into something you can find by meaning, with MongoDB Atlas, Voyage AI, and Gemini. ~6 min read.*

---

Here's a small, strange moment in Inkling.

You draw a rocket. You press **Save**. And the studio says:

> ✓ Saved. Voyage AI embedded its picture, story, and code: find it by words, a sketch, or code.

You didn't tag anything. You didn't pick a folder. You didn't name it `rocket_final_v3_REAL.png`.
And yet, a second later, you can find that rocket by typing *"something blasting off"*, or by scribbling
a rough cone on the paper, or by pasting a few lines of p5.js that move things the same way.

How? Isn't search supposed to be a feature you build *after* the app?

What if saving **was** the search index?

---

## The rhythm: Draw → Animate → Find

Inkling has one rhythm, and it sits at the top of the studio:

1. **Draw.** Your pencil, your strokes. Pressure, order, timing: all kept as live vector math, not pixels.
2. **Animate.** One tap. Gemini looks at your scene and picks the *poses*. Plain math draws the in-betweens.
   Every frame is your own strokes, moved. Nothing is redrawn.
3. **Find.** Everything you've ever made, searchable by words, by a sketch, or by code.

Three verbs. Everything else is in service of them. And the third one is the quiet magic: *you never do
any work to make it happen.*

---

## Autoembed: declare it once, never think about it again

Here's the whole search "pipeline" for drawings in Inkling. Not a summary. The actual code:

```python
self.atlas = Atlas(
    mongo_client=self.client, voyage_api_key=key,
    db="animation_studio",
    model="voyage-multimodal-3.5", rerank_model=None,
)
self.drawings = self.atlas.collection(
    "drawings",
    embed=Text("title") + Text("description") + Text("tags", label="Tags") + Image("image"),
    key="id", filters=["owner", "tags"],
)
```

That `embed=` line is a promise: *every time a drawing is saved, take its title, description, tags, and
its picture, and turn them into a single vector with Voyage AI.* The vector lands in the same MongoDB
document as the drawing. One write. No queue, no sync job, no second database to keep in step.

Scenes go further:

```python
embed=Text("code") + Text("description") + Text("tags", label="Tags")
      + Text("story", label="Story") + Image("image")
```

A scene's *story* is the cast, the keyframes, and, since this release, **the p5.js sketch that draws it**.
So the vector for a scene holds what it looks like, what it's about, and *how it moves*, all at once.

Why does that matter? Because `voyage-multimodal-3.5` puts pictures and words in **one shared space**.
A sketch of a rocket and the words *"rocket ship"* land near each other. So does a cone-shaped scribble.
So does code that sends something up-and-to-the-right with a squash before launch.

One model. One space. Three ways in.

---

## Search that respects the artist

Every query runs through **MongoDB Atlas Vector Search**, and every query is scoped to its owner
before it ever touches a vector. Your sketchbook is a private library, not a training set.

Three ways to search, one engine:

- **Words.** Type *"forest at night"*. Voyage embeds the words; Atlas ranks your art by meaning.
- **A sketch.** Doodle a rough shape and press **Find similar**. Your drawing *becomes* the query.
  No words at all.
- **Code.** Open any scene in the Lab and press **◎ Similar code**. Voyage embeds the sketch; Atlas finds
  scenes that move alike. Tap **↻ Remix** to start from one.

And the cheapest search of all: **Similar to this asset.** The asset already has a vector in Atlas, so
Inkling uses *that* as the query. Zero new embeddings. Instant, and free.

```python
def search_code(self, code: str) -> list[dict]:
    """Scenes whose code (and story) is nearest to this sketch: one Voyage embedding, one Atlas vector search."""
    vector = self.shots._query_vector([code_query(code)])
    rows = self._nearest(self.shots, vector, 12, self.q(), SEARCH_SPREAD)
    ...
```

`self.q()` is the owner filter. It's in every query. That's not a feature; it's a rule.

---

## Gemini picks the poses. Math does the rest.

Here's where most "AI animation" goes wrong: it regenerates every frame. Lines flicker, the style drifts,
and the character you drew slowly becomes someone else's.

Inkling does what real animation studios have always done. A lead animator draws the **keyframes**:
the big poses. Assistants draw the **in-betweens**. In Inkling:

- **Gemini is the lead's assistant for poses.** It looks at your scene and proposes keyframes:
  *where, how big, how squashed, how turned, and when.* Numbers, not pixels.
- **Math is the in-betweener.** A smooth curve through those poses moves your **actual strokes**,
  frame by frame. Ten seconds, eight frames a second, eighty frames of *your* line.

The AI never holds a pencil. It only says *where the pencil's work should go.*

---

## Every animation is code. And you can read it.

This is the part that made us sit up.

Every animation in Inkling is saved as a small, readable **p5.js** sketch. Here's the shape of one (header verbatim, keyframes trimmed):

```js
// Takeoff: Gemini chose these keyframes. This code draws every frame.
// Your strokes are never redrawn: each moving layer is posed (moved, squashed, turned) by the numbers below,
// and in-betweens come from a smooth curve through them. Change a number, Run, then Bake.

const FPS = 8;
const STRENGTH = 1;   // 1 = as choreographed. Try 1.4 for bigger moves.

// t: 0..1 through the clip. x, y: offset in paper fractions (y up is negative). sx, sy: squash and stretch. r: degrees.
const MOTION = {
  "rocket": {
    pivot: [0.5, 0.62],  // its center: it turns and squashes around here
    keys: [
      { t: 0, x: 0, y: 0, sx: 1, sy: 1, r: 0, label: "nervous" },
      { t: 0.25, x: 0, y: 0.03, sx: 1.12, sy: 0.85, r: 0, label: "crouch" },
      ...
```

Why code?

- **Traceability.** You can see exactly what the AI decided. Every keyframe is a line you can read.
- **Auditability.** If Gemini chose a weird pose, it's a number. Change it. Run. Bake.
- **Efficiency without losing your hand.** Five overlapping strokes along one edge can become one
  simplified line, while your color, width, and pressure stay yours. **✍ Drawing as code** shows you
  the receipt: *how many strokes in, how many lines out.*

And because the code is part of the scene's story, it's **embedded too**. Your animations are searchable
by *how they move.*

---

## Sign it

Here's a question we couldn't stop asking: *if your drawing becomes code, is it still yours?*

Our answer: **yes, if you say so.**

When you bake a sketch back into frames, Inkling asks one question: **Still yours?**

- **✍ Yes, these are my lines.** Your traced strokes count as your hand. A *Signed* event lands in the history.
- **⟨/⟩ Mark them as code.** They're tracked as code-made, honestly.
- **Not yet.** Decide later.

The **Your Hand** meter on the canvas keeps score: hand, AI, kit, code, placed. Every stroke has an
author. Nothing lands without your yes.

---

## And when the Wi-Fi drops?

Inkling is a PWA. Install it, go into airplane mode, and keep drawing. Every online feature (AI,
search, sync) switches off cleanly, so nothing pretends to work. Your drafts wait on the device. Quick
moves (Lift off, Hop, Float, Spin, Bounce) are plain math, so you can still animate on a plane.

When you land, Save. It embeds. It's findable.

---

## So what's the point?

The loudest version of AI-for-art says: *type a prompt, get a picture.* The artist quietly drops out.

Inkling bets on the opposite:

- **Your strokes are the source of truth.** AI never draws over them.
- **AI does the in-betweens:** poses, tags, search, and code you can read.
- **MongoDB Atlas and Voyage AI give your sketchbook a memory.** Declared once, embedded on every save,
  private to you.

> **Keep the pencil. Hand AI the in-betweens.**

Draw something. Press **🎞 Animate**. Then go find it.

*Try it at [inkling.oblivio-company.com](https://inkling.oblivio-company.com). The code is at
[github.com/ranfysvalle02/mdb-animations](https://github.com/ranfysvalle02/mdb-animations).*
