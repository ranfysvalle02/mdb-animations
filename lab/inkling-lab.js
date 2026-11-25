// The Inkling Lab runner: one sketch, the artist's own strokes, and nothing else.
// It lives in an <iframe sandbox="allow-scripts"> (an opaque origin: no cookies, no storage, no /api/) and its
// Content-Security-Policy refuses every network connection. The studio sends `run` and `bake`; this page answers
// `ready`, `error`, and `baked`. That message channel is the only way in or out.
(() => {
  'use strict';
  const W = 1000, H = 650;
  const studio = window.parent;
  const send = message => studio.postMessage(message, '*'); // an opaque origin can't be named; only the studio listens
  let started = false;
  let baking = null; // { frames: [], current: [] } while frames are being captured

  // ---------------------------------------------------------------- a runaway loop throws instead of freezing the studio
  const LOOP_LIMIT_MS = 2500;
  let budgetStart = performance.now();
  window.__inklingGuard = () => {
    if (performance.now() - budgetStart > LOOP_LIMIT_MS) throw new Error('A loop ran for over 2.5 s. Is there an endless loop?');
  };
  // Put a guard at the top of every braced for / while / do body. A small scanner, so strings and comments that
  // happen to say "for (" are left alone. Line numbers don't change: the guard goes on the same line.
  function protect(code) {
    const word = ch => /[A-Za-z0-9_$]/.test(ch || '');
    const space = ch => /\s/.test(ch || '');
    const inserts = [];
    let i = 0;
    while (i < code.length) {
      const c = code[i], d = code[i + 1];
      if (c === '/' && d === '/') { const end = code.indexOf('\n', i); if (end < 0) break; i = end; continue; }
      if (c === '/' && d === '*') { const end = code.indexOf('*/', i + 2); if (end < 0) break; i = end + 2; continue; }
      if (c === '"' || c === "'" || c === '`') {
        i++;
        while (i < code.length && code[i] !== c) i += code[i] === '\\' ? 2 : 1;
        i++;
        continue;
      }
      if (word(c) && !word(code[i - 1])) {
        let j = i;
        while (word(code[j])) j++;
        const keyword = code.slice(i, j);
        let k = j;
        while (space(code[k])) k++;
        if ((keyword === 'for' || keyword === 'while') && code[k] === '(') {
          for (let depth = 0; k < code.length; k++) {
            if (code[k] === '(') depth++;
            else if (code[k] === ')' && --depth === 0) break;
          }
          k++;
          while (space(code[k])) k++;
          if (code[k] === '{') inserts.push(k + 1);
        } else if (keyword === 'do' && code[k] === '{') inserts.push(k + 1);
        i = j;
        continue;
      }
      i++;
    }
    let out = '', last = 0;
    for (const at of inserts) { out += `${code.slice(last, at)}__inklingGuard();`; last = at; }
    return out + code.slice(last);
  }

  function report(error) {
    const where = /sketch\.js:(\d+):(\d+)/.exec(String(error && error.stack));
    send({ type: 'error', message: String((error && error.message) || error).slice(0, 300), line: where ? Number(where[1]) : null });
  }
  window.addEventListener('error', event => { event.preventDefault(); report(event.error || event.message); });
  window.addEventListener('unhandledrejection', event => { event.preventDefault(); report(event.reason); });

  // ---------------------------------------------------------------- the Inkling API (see LAB_API in backend/ai.py)
  const toHex = value => {
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    try {
      const c = window.color(value);
      return `#${[window.red(c), window.green(c), window.blue(c)].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    } catch {
      return '#123b38';
    }
  };
  // Pen pressure rides along, so a baked line keeps the artist's thick-and-thin.
  const asPoint = p => (Array.isArray(p) ? { x: +p[0], y: +p[1], z: +(p[2] || 0) }
    : { x: +p.x, y: +p.y, z: +(p.z || 0), ...(Number.isFinite(p.pressure) ? { pressure: p.pressure } : {}) });
  // Where a point lands on the paper, through the current transform: what you see is what gets baked.
  function onPaper(points, width) {
    const r = window._renderer;
    if (r && r.isP3D) {
      const M = r.uModelMatrix.mat4, V = r.uViewMatrix.mat4, P = r.uPMatrix.mat4;
      const eye = (r._curCamera && r._curCamera.defaultEyeZ) || 800; // at the default camera distance, lines keep their width
      const mul = (m, v) => [0, 1, 2, 3].map(row => m[row] * v[0] + m[row + 4] * v[1] + m[row + 8] * v[2] + m[row + 12] * v[3]);
      let depth = 0;
      const out = [];
      for (const p of points) {
        const clip = mul(P, mul(V, mul(M, [p.x, p.y, p.z, 1])));
        if (clip[3] <= 1e-6) continue; // behind the camera
        out.push({ x: (clip[0] / clip[3] + 1) / 2 * window.width, y: (1 - clip[1] / clip[3]) / 2 * window.height, pressure: p.pressure });
        depth += clip[3];
      }
      return { points: out, width: width * Math.max(0.2, Math.min(4, out.length ? eye / (depth / out.length) : 1)) };
    }
    const m = window.drawingContext.getTransform();
    const density = window.pixelDensity();
    return {
      points: points.map(p => ({ x: (m.a * p.x + m.c * p.y + m.e) / density, y: (m.b * p.x + m.d * p.y + m.f) / density, pressure: p.pressure })),
      width: width * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) / density
    };
  }
  window.ink = (points, style = {}) => {
    if (!points || !points.length) return;
    const pts = Array.from(points, asPoint).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
    if (!pts.length) return;
    const color = style.color == null ? '#123b38' : style.color;
    const width = Math.max(0.5, Number(style.width) || 3);
    const webgl = !!(window._renderer && window._renderer.isP3D);
    if (baking) {
      const placed = onPaper(pts, width);
      if (placed.points.length) {
        baking.current.push({ points: placed.points, color: toHex(color), width: placed.width, fill: style.fill ? toHex(style.fill) : null,
          layer: typeof style.layer === 'string' ? style.layer.slice(0, 40) : null }); // which layer it bakes into
      }
    }
    window.push();
    window.stroke(color);
    window.strokeWeight(width);
    if (style.fill) window.fill(style.fill); else window.noFill();
    if (pts.length === 1) {
      if (webgl) window.point(pts[0].x, pts[0].y, pts[0].z); else window.point(pts[0].x, pts[0].y);
    } else {
      window.beginShape();
      for (const p of pts) { if (webgl) window.vertex(p.x, p.y, p.z); else window.vertex(p.x, p.y); }
      if (style.fill) window.endShape(window.CLOSE); else window.endShape();
    }
    window.pop();
  };
  window.inkStroke = (stroke, map) => {
    if (!stroke || !stroke.points) return;
    window.ink(map ? stroke.points.map((p, i) => map(p, i, stroke)) : stroke.points, { color: stroke.color, width: stroke.width, layer: stroke.layer });
  };
  window.loopT = () => ((Math.max(1, window.frameCount) - 1) % window.LOOP) / window.LOOP;

  // ---------------------------------------------------------------- run and bake
  const CALLBACKS = ['preload', 'setup', 'draw', 'mousePressed', 'mouseReleased', 'mouseDragged', 'mouseMoved', 'mouseWheel',
    'doubleClicked', 'keyPressed', 'keyReleased', 'touchStarted', 'touchMoved', 'touchEnded', 'windowResized'];
  function start({ code, data, seed, loop }) {
    Object.assign(window, { W, H, strokes: data.frames[0] || [], frames: data.frames, layers: data.layers, LOOP: loop });
    // Indirect eval: the sketch's functions become p5's global-mode callbacks, even under "use strict".
    const exports = CALLBACKS.map(name => `try { if (typeof ${name} === 'function') window.${name} = ${name}; } catch (e) {}`).join('\n');
    try {
      budgetStart = performance.now();
      (0, eval)(`${protect(String(code))}\n;${exports}\n//# sourceURL=sketch.js`);
    } catch (error) {
      report(error);
      return;
    }
    const userSetup = window.setup, userDraw = window.draw;
    if (typeof userDraw !== 'function') { report(new Error('A sketch needs a draw() function.')); return; }
    window.setup = () => {
      window.randomSeed(seed);
      window.noiseSeed(seed);
      budgetStart = performance.now();
      try {
        if (typeof userSetup === 'function') userSetup();
      } catch (error) {
        // Caught here, not by window.onerror: p5 calls setup() from its own file, so the browser would hide the message.
        window.noLoop();
        report(error);
        return;
      }
      if (!document.querySelector('canvas')) window.createCanvas(W, H);
      send({ type: 'ready', webgl: !!(window._renderer && window._renderer.isP3D) });
    };
    window.draw = () => {
      budgetStart = performance.now();
      try {
        userDraw();
      } catch (error) {
        window.noLoop(); // one clear error, not sixty a second
        if (baking) throw error; // bake() reports it
        report(error);
      }
    };
    new window.p5(); // eslint-disable-line no-new
  }
  // Every frame of the loop, drawn once, in order, from the same seed: the same sketch always bakes the same frames.
  function bake(count) {
    const sketch = window.p5.instance;
    if (!sketch || !sketch._setupDone) throw new Error('The sketch isn\u2019t running yet.');
    window.noLoop();
    window.LOOP = count;
    window.randomSeed(seed0);
    window.noiseSeed(seed0);
    sketch._setProperty('frameCount', 0);
    baking = { frames: [], current: [] };
    try {
      for (let f = 0; f < count; f++) {
        baking.current = [];
        sketch.redraw();
        baking.frames.push(baking.current);
      }
      return baking.frames;
    } finally {
      baking = null;
      window.loop();
    }
  }
  let seed0 = 7;
  window.addEventListener('message', event => {
    if (event.source !== studio || !event.data || typeof event.data !== 'object') return;
    const message = event.data;
    if (message.type === 'run' && !started && typeof message.code === 'string' && message.data && Array.isArray(message.data.frames)) {
      started = true;
      seed0 = Number(message.seed) || 7;
      start({ code: message.code, data: message.data, seed: seed0, loop: Math.max(2, Math.min(80, Number(message.loop) || 48)) });
    } else if (message.type === 'bake') {
      try {
        send({ type: 'baked', frames: bake(Math.max(2, Math.min(80, Number(message.frames) || 48))), keep: window.KEEP_DRAWING === true });
      } catch (error) {
        report(error);
        send({ type: 'baked', frames: null });
      }
    }
  });
  send({ type: 'loaded' });
})();
