# The Lab: Your Strokes, as Numbers

*Inkling has a room where your drawing becomes code: p5.js, AI-written sketches, and every animation you
can read. ~5 min read.*

---

Here's something most drawing apps never tell you: the moment you lift your pencil, your line becomes data.

Not a picture of a line. The line itself: every point it passed through, how hard you pressed, and the order
you drew it in. Inkling has always kept it that way. That's how its flipbooks move your *actual* strokes
instead of redrawing them.

So we asked a fun question: **what happens if you hand those numbers to code?**

---

## Tilt the paper back

Tap **⟨/⟩ Lab** (or press **L**). The paper tilts away, the lights go down, and your drawing reappears as a
sketch in [p5.js](https://p5js.org), Processing for the web. Processing is the tool a whole generation of
artists learned to code with.

Your drawing arrives as plain variables:

- `strokes`: every line you drew, in order, with its points, pressure, color, width, and layer
- `frames` and `layers`: every flipbook frame, and frame 1 by layer
- `ink(points)`: draw a stroke *and* keep it for baking
- `inkStroke(stroke, map)`: ink one of your own strokes, moving each point as you like
- `loopT()`: 0 to 1 through the loop, for a seamless flipbook

That's the whole Inkling API. The rest is just p5.

---

## Eight doors in

Two of them are about *your* canvas:

- 🎞 **This animation.** Animate anything in Inkling and it's already code. Gemini's keyframes are numbers,
  and a smooth curve through them moves your strokes. Open it here, change a pose, and press Run.
- ✍ **Drawing as code.** Your drawing, rewritten as code. Strokes that continue a line are joined and
  simplified, keeping your color, width, and pressure, and a receipt tells you how many strokes went in and
  how many lines came out.

Six are just for fun, and none of them invent anything. They only move what *you* drew:

- 🧊 **Time sculpture.** Each stroke floats at the depth of *when* you drew it: your first line in front, your
  last at the back. Drag to orbit your own process in 3D.
- 🎞 **Flipbook tunnel.** Every frame of your animation, stacked in space, gliding toward you.
- 🌬️ **Flow field.** An invisible wind of Perlin noise bends your lines. Change `strength = 26` to `60`, press
  ⌘↵, and now it's a storm.
- ❄️ **Kaleidoscope**, ✨ **Ink to dust**, 🌊 **The wave**.

Every number is right there to change.

---

## Then ask AI to write the code

Type *"make my lines spiral into a galaxy"* and Gemini writes a p5.js sketch against that tiny API.

Here's the part we care about: **the AI writes code, not art.** You get the program, not a picture. You can
read every line. Each result lands as a take, with a note on what changed (*+11 −17 lines*). Flip back to any
earlier take, edit what it wrote, or break it. If it breaks, the error tells you which line.

Most AI is a black box. This one hands you the box *and* the source.

---

## Bake it back into a flipbook

When you love what's moving, press **⤓ Bake to frames**.

The Lab replays the loop one frame at a time from a fixed random seed, so the same sketch always bakes the same
way. Everything drawn with `ink()` becomes real, editable strokes: a 3-, 6-, or 10-second flipbook. 3D sketches
bake exactly the view you're looking at.

## Still yours?

If your lines went through code, are they still yours? Inkling asks instead of guessing:

- **✍ Yes, these are my lines.** Traced strokes count as your hand, and a *Signed* event goes in the history.
- **⟨/⟩ Mark them as code.** They're tracked, honestly, as code-made.
- **Not yet.** Decide later.

Marks the code *invented* (particles, effects) are always labeled as code. The **Your Hand** meter keeps score.

---

## Code you can search, and remix

The sketch is saved with the scene, and MongoDB Atlas embeds it with a Voyage code model the moment it lands.
So **◎ Similar code** finds scenes in your library that *move* alike, and **↻ Remix** loads one as a new take
over your current drawing. Shared scenes show their code too, with a **Remix in Inkling** button: anyone who
watches your animation can borrow its motion for their own drawing.

---

## Safe by construction

A playground for AI-written code needs a fence. Every sketch runs in a sandboxed frame with no cookies, no
storage, no access to your library, and a security policy that blocks every network request. Your strokes go
in, baked strokes come out, and nothing else crosses. A loop that runs for more than 2.5 seconds is stopped,
and the error says so.

None of that needs the internet, so the Lab works in airplane mode. Only *Ask AI* and search wait for a signal.

---

## Why this matters

There's a quiet fear that AI turns artists into prompt-typers. The Lab goes the other way: it turns a drawing
into a doorway to *code*, and makes AI a patient teacher instead of a replacement.

You drew the moments that matter. Math moved them. AI wrote code you can read, change, and own.

> **Keep the pencil. Hand AI the in-betweens.**

Open the Lab. Pull your drawing apart by time. See what your lines have been hiding.

*inkling* /ˈɪŋklɪŋ/: a slight hint. The rest is yours.
