(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('drawing');
  const ctx = canvas.getContext('2d');
  const overlay = $('overlay');
  const octx = overlay.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  // Crisp ink on retina screens: bitmaps follow the screen's pixel density (up to 2x), while every
  // coordinate stays in the 1000 x 650 artwork space that is saved and rendered by the server.
  const DENSITY = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  function hiRes(c) {
    c.width = Math.round(W * DENSITY);
    c.height = Math.round(H * DENSITY);
    const g = c.getContext('2d');
    g.setTransform(DENSITY, 0, 0, DENSITY, 0, 0);
    return g;
  }
  hiRes(canvas);
  hiRes(overlay);
  const MAX_STROKES = 1000;
  const MAX_POINTS = 20000;
  const MAX_LAYERS = 12;
  const MAX_HISTORY = 100;
  const MAX_PENDING_SPARKS = 3;
  const TAG_PATTERN = /^[a-z0-9][a-z0-9 -]{0,29}$/;
  const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
  const SHAPES = new Set(['line', 'rect', 'ellipse']);
  const TOOL_KEYS = { b: 'pen', p: 'pen', e: 'eraser', l: 'line', r: 'rect', o: 'ellipse', m: 'move', v: 'move', s: 'spark', k: 'stamp', t: 'path' };
  const MAX_FRAMES = 80;
  const MAX_SKETCH_CODE = 12000; // a scene's code, as saved (backend/models.py MAX_SKETCH_CODE)

  let layerSeq = 0;
  const newLayer = (name, props = {}) => ({ id: ++layerSeq, name, visible: true, opacity: 1, strokes: [], asset: null, ...props });
  let layers = [newLayer('Layer 1')];
  let activeId = layers[0].id;
  // A flipbook: every frame has its own layer stack. `layers` is always the stack of the frame on screen.
  let frames = [layers];
  let frameIndex = 0;
  let fps = 12;
  let onionSkin = true;
  let playing = null; // { at, timer }
  let motionDraft = null; // { spec, stacks, at, timer, paths } while a motion previews
  // Takes: every AI attempt is kept side by side until the artist keeps one. Nothing touches the canvas before that.
  let takes = []; // motion specs, in the order they arrived
  let takeAt = -1;
  let offline = !navigator.onLine; // airplane mode (or no route to Inkling): drawing only, nothing leaves the device
  let draftRevision = -1; // the canvas revision last kept on this device
  let targets = null; // the layers the box talks to (a Set of ids); null means everything that can move
  let targetGlow = 0; // until when the canvas outlines them
  let everyFrame = true; // in an animation, layer edits reach the same layer in every frame (decompose, then recompose)
  let peeking = false; // while "hold to compare" is held, previews step aside to show the original
  let sceneMotion = null; // the accepted direction behind this scene's frames, saved with the scene
  let sceneSketch = null; // or the Lab code its frames were baked from
  let showMath = false;
  let rigView = null; // 🦴 the rig on screen: { layerId | null, rig, started }
  let lastSavedAsset = null; // the asset just saved (with its shot count), for ② Shot
  let pendingRig = null; // { sig, rig }: made on an unsaved drawing, kept with the asset on save
  let shareAfterSave = false; // "Share" on an unsaved scene saves it first
  let moving = null; // { layer, start, original, bounds } while the Move tool drags a layer
  // The audit trail for this canvas: what the artist and the AI did since it was opened. Sent with the
  // next asset/scene save, where the server appends it to the stored history.
  let journal = [];
  let handStrokes = 0;
  let savedHistory = []; // the stored trail of the asset/scene being edited
  let pendingOrigin = null; // set when an AI variation is opened for editing: saved as its lineage
  let penSeen = false; // once a pencil draws, touches are palms
  // Process: every stroke gets its place in the drawing order (seq) and how long it took (ms), so any
  // drawing can be replayed stroke by stroke and measured. Starter strokes are seq 0.
  let strokeSeq = 0;
  let activeStart = 0;
  const nextSeq = () => ++strokeSeq;
  const resyncSeq = () => { strokeSeq = Math.max(0, ...frames.flat().flatMap(layer => layer.strokes.map(stroke => stroke.seq || 0))); };
  const undoStack = []; // snapshots of the layer stack; strokes are immutable once finished
  const redoStack = [];
  const layerCanvases = new Map();
  const guides = []; // pinned trace guides: { region, img } (never saved or exported)
  const sparks = []; // { kind, region, prompt, status: 'pending' | 'ready', result, img }
  let guidesVisible = true;
  let tool = 'pen';
  let drawTool = 'pen'; // tool to return to after a spark
  let active = null; // the freehand stroke being drawn
  let activeStrokeLayer = null;
  let shapeDraft = null;
  let selection = null;
  let pendingRegion = null;
  let pointer = null;
  let pointCount = 0;
  let revision = 0;
  let savedRevision = 0;
  let galleryRequest = null;
  let tags = [];
  let currentQuery = '';
  let trayTimer = null;
  let animating = false;
  let compositeQueued = false;
  let opacityBefore = null; // snapshot taken when an opacity drag starts
  let placing = null; // asset being placed: { id, version, name, strokes, bbox }
  let placeDraft = null; // the box being dragged for it
  // The stamp brush: the artist's own art as a brush. { name, size, strokes centered on 0,0 in canvas px }
  let stamp = null;
  let stampHover = null; // where the ghost previews (mouse and pencil hover)
  let stamping = null; // { layer, last, count } during a stamp drag

  const message = (id, text, error = false, actions = []) => {
    $(id).textContent = text;
    $(id).classList.toggle('error', error);
    if (actions.length) {
      // "What's next?" buttons right where the artist is already looking.
      const row = document.createElement('span');
      row.className = 'next-actions';
      for (const { label, tip, run } of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'next-action';
        button.textContent = label;
        if (tip) button.dataset.tip = tip;
        button.addEventListener('click', run);
        row.append(button);
      }
      $(id).append(row);
    }
  };
  const isTyping = target => target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
    || (target.tagName === 'INPUT' && TEXT_INPUTS.has(target.type)));
  const countPoints = list => list.reduce((total, stroke) => total + stroke.points.length, 0);
  const allStrokes = () => layers.flatMap(layer => layer.strokes);
  const activeLayer = () => layers.find(layer => layer.id === activeId) || layers[layers.length - 1];
  const recount = () => { pointCount = countPoints(allStrokes()); };
  const hasInk = (stack = layers) => stack.some(layer => layer.visible && layer.strokes.some(stroke => !stroke.erase));
  function pointBounds(strokes) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const stroke of strokes) {
      for (const p of stroke.points) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
    }
    return x1 >= x0 ? { x0, y0, x1, y1 } : null;
  }
  const docStack = stack => stack.map(({ name, visible, opacity, strokes, asset, backdrop }) => ({
    name, visible, opacity, strokes, ...(asset ? { asset } : {}), ...(backdrop ? { backdrop } : {}) }));
  const docLayers = () => docStack(layers);
  const copyStack = stack => stack.map(layer => ({ ...layer, strokes: layer.strokes.slice() }));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  function logEvent(by, action, detail = '') {
    journal.push({ at: new Date().toISOString(), by, action, detail: String(detail).slice(0, 240) });
    if (journal.length > 55) journal.splice(0, journal.length - 55);
  }
  function pendingEvents() {
    return handStrokes ? [...journal, { at: new Date().toISOString(), by: 'artist', action: 'Drew',
      detail: `${handStrokes} stroke${handStrokes === 1 ? '' : 's'} and shapes by hand` }] : journal.slice();
  }

  // True while a stroke, shape, or selection is in progress; self-heals if a pointerup was ever missed.
  function busy() {
    if (pointer !== null && !canvas.hasPointerCapture(pointer)) {
      pointer = null;
      active = null;
      activeStrokeLayer = null;
      shapeDraft = null;
      selection = null;
      placeDraft = null;
      moving = null;
      stamping = null;
      inkState = null;
    }
    return pointer !== null;
  }

  // ---------------------------------------------------------------- history
  const snapshot = () => ({ active: activeId, frame: frameIndex, frames: frames.map(copyStack) });
  let redoBackup = []; // what the last pushUndo cleared, in case that step is called off (a two-finger tap)
  function pushUndo(state = snapshot()) {
    undoStack.push(state);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoBackup = redoStack.slice();
    redoStack.length = 0;
    revision++;
    updateControls();
  }
  function restore(state) {
    frames = state.frames.map(copyStack);
    frameIndex = Math.min(state.frame, frames.length - 1);
    layers = frames[frameIndex];
    activeId = layers.some(layer => layer.id === state.active) ? state.active : layers[layers.length - 1].id;
    recount();
    rebuildOnion();
    rebuildAll();
    renderFrames();
    renderSaveKind();
  }
  function undo() {
    endOpacityEdit();
    stopPlay();
    if (busy() || !undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    revision++;
  }
  function redo() {
    endOpacityEdit();
    stopPlay();
    if (busy() || !redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    revision++;
  }

  // ---------------------------------------------------------------- rendering
  function layerCanvas(id) {
    let sheet = layerCanvases.get(id);
    if (!sheet) {
      sheet = document.createElement('canvas');
      hiRes(sheet);
      layerCanvases.set(id, sheet);
    }
    return sheet;
  }
  function paintPoint(c, stroke, point, previous) {
    const x = point.x * W;
    const y = point.y * H;
    const width = Math.max(1, Math.round(stroke.width * (0.25 + point.pressure)));
    c.fillStyle = stroke.color;
    c.strokeStyle = stroke.color;
    c.lineWidth = width;
    c.lineCap = 'round';
    if (previous) {
      c.beginPath();
      c.moveTo(previous.x * W, previous.y * H);
      c.lineTo(x, y);
      c.stroke();
    }
    c.beginPath();
    c.arc(x, y, width / 2, 0, Math.PI * 2);
    c.fill();
  }
  function withMode(c, stroke, paint) {
    c.save();
    // An eraser cuts through its own layer only, like the server renderer.
    c.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    paint();
    c.restore();
  }
  function drawStroke(c, stroke) {
    withMode(c, stroke, () => {
      if (stroke.fill && stroke.points.length > 2) {
        c.fillStyle = stroke.fill;
        c.beginPath();
        stroke.points.forEach((p, i) => (i ? c.lineTo(p.x * W, p.y * H) : c.moveTo(p.x * W, p.y * H)));
        c.closePath();
        c.fill();
      }
      stroke.points.forEach((point, index) => paintPoint(c, stroke, point, stroke.points[index - 1]));
    });
  }
  function renderLayer(layer) {
    const c = layerCanvas(layer.id).getContext('2d');
    c.clearRect(0, 0, W, H);
    layer.strokes.forEach(stroke => drawStroke(c, stroke));
  }
  // ---------------------------------------------------------------- frames: rendering any stack, onion skin
  const scratch = document.createElement('canvas');
  const sctx = hiRes(scratch);
  function paintStack(c, stack) {
    for (const layer of stack) {
      if (!layer.visible) continue;
      sctx.clearRect(0, 0, W, H);
      layer.strokes.forEach(stroke => drawStroke(sctx, stroke));
      c.globalAlpha = layer.opacity;
      c.drawImage(scratch, 0, 0, W, H);
    }
    c.globalAlpha = 1;
  }
  function frameImage(stack, width = W) {
    const full = document.createElement('canvas');
    full.width = W;
    full.height = H;
    const f = full.getContext('2d');
    f.fillStyle = '#ffffff';
    f.fillRect(0, 0, W, H);
    paintStack(f, stack);
    if (width === W) return full;
    const small = document.createElement('canvas');
    small.width = width;
    small.height = Math.round(width * H / W);
    small.getContext('2d').drawImage(full, 0, 0, small.width, small.height);
    return small;
  }
  // The previous frame, tinted red, under the current one: how animators see motion while drawing.
  const onionCanvas = document.createElement('canvas');
  onionCanvas.width = W;
  onionCanvas.height = H;
  function rebuildOnion() {
    const o = onionCanvas.getContext('2d');
    o.clearRect(0, 0, W, H);
    if (frameIndex === 0) return;
    paintStack(o, frames[frameIndex - 1]);
    o.globalCompositeOperation = 'source-in';
    o.fillStyle = '#ef4444';
    o.fillRect(0, 0, W, H);
    o.globalCompositeOperation = 'source-over';
  }
  function paintArtwork(c, withGuides) {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, W, H);
    if (withGuides && onionSkin && frameIndex > 0) {
      c.globalAlpha = 0.28;
      c.drawImage(onionCanvas, 0, 0);
      c.globalAlpha = 1;
    }
    if (withGuides && guidesVisible) {
      c.globalAlpha = 0.35;
      for (const guide of guides) c.drawImage(guide.img, guide.region.x * W, guide.region.y * H, guide.region.w * W, guide.region.h * H);
    }
    for (const layer of layers) {
      if (!layer.visible) continue;
      c.globalAlpha = layer.opacity;
      c.drawImage(layerCanvas(layer.id), 0, 0, W, H);
    }
    c.globalAlpha = 1;
  }
  function composite() {
    compositeQueued = false;
    paintArtwork(ctx, true);
    updateControls();
    scheduleThumb();
  }
  function scheduleComposite() {
    if (compositeQueued) return;
    compositeQueued = true;
    requestAnimationFrame(composite);
  }
  function rebuildAll() {
    if (canvasIsBlank()) startersDismissed = false;
    layers.forEach(renderLayer);
    for (const id of layerCanvases.keys()) if (!layers.some(layer => layer.id === id)) layerCanvases.delete(id);
    composite();
    renderLayersPanel();
    renderStarters();
  }
  function updateControls() {
    // Ink on the page wakes up the Animate box.
    document.body.classList.toggle('has-ink', !canvasIsBlank());
    renderAuthorship();
    $('undo').disabled = !undoStack.length;
    $('redo').disabled = !redoStack.length;
    $('guide-controls').hidden = !guides.length;
    $('guides-toggle').textContent = `Guides (${guides.length})`;
    $('guides-toggle').setAttribute('aria-pressed', String(guidesVisible));
  }

  // ---------------------------------------------------------------- frame strip, flipbook playback
  const thumbCache = new WeakMap(); // frame stack -> small canvas
  let thumbTimer = null;
  function frameThumb(stack) {
    let thumb = thumbCache.get(stack);
    if (!thumb) {
      thumb = frameImage(stack, 96);
      thumbCache.set(stack, thumb);
    }
    return thumb;
  }
  function scheduleThumb() {
    if (frames.length < 2) return;
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      thumbCache.delete(layers);
      const slot = document.querySelector(`#frame-list [data-frame="${frameIndex}"] .frame-thumb`);
      if (slot) slot.replaceChildren(frameThumb(layers));
    }, 300);
  }
  function renderFrames() {
    const many = frames.length > 1;
    $('frames').classList.toggle('animating', many);
    $('frame-play').hidden = !many;
    $('frame-tools').hidden = !many;
    $('explain-open').hidden = !(many && sceneMotion);
    $('frame-add').textContent = many ? '+ Frame' : '+ Frame by hand';
    $('frame-add').disabled = frames.length >= MAX_FRAMES;
    const queue = [];
    $('frame-list').replaceChildren(...(many ? frames.map((stack, i) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.frame = String(i);
      button.className = `frame${i === frameIndex ? ' current' : ''}`;
      button.setAttribute('aria-label', `Frame ${i + 1}`);
      if (i === frameIndex) button.setAttribute('aria-current', 'true');
      const thumb = document.createElement('span');
      thumb.className = 'frame-thumb';
      if (thumbCache.has(stack)) thumb.append(frameThumb(stack));
      else queue.push([thumb, stack]);
      const number = document.createElement('span');
      number.className = 'frame-number';
      number.textContent = String(i + 1);
      button.append(thumb, number);
      button.addEventListener('click', () => goFrame(i));
      item.append(button);
      return item;
    }) : []));
    document.querySelector('#frame-list .current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    thumbQueue = queue;
    if (queue.length && !thumbQueue.busy) fillThumbs();
  }
  // 80 thumbnails at once would stall a phone: paint a few per animation frame instead.
  let thumbQueue = [];
  function fillThumbs() {
    const start = performance.now();
    while (thumbQueue.length && performance.now() - start < 10) {
      const [slot, stack] = thumbQueue.shift();
      if (slot.isConnected) slot.replaceChildren(frameThumb(stack));
    }
    thumbQueue.busy = thumbQueue.length > 0;
    if (thumbQueue.busy) requestAnimationFrame(fillThumbs);
  }
  function showFrame(i) {
    const activeName = activeLayer().name;
    frameIndex = i;
    layers = frames[i];
    activeId = (layers.find(layer => layer.name === activeName) || layers[layers.length - 1]).id;
    closePopover();
    recount();
    rebuildOnion();
    rebuildAll();
    renderFrames();
    renderSaveKind();
  }
  function goFrame(i) {
    if (i < 0 || i >= frames.length || i === frameIndex || busy()) return;
    stopPlay();
    showFrame(i);
  }
  function addFrame() {
    if (busy()) return;
    if (frames.length >= MAX_FRAMES) {
      message('drawing-status', `A scene can have ${MAX_FRAMES} frames.`, true);
      return;
    }
    stopPlay();
    pushUndo();
    // A new frame starts as a copy: change only what moves, like tracing the last drawing on a lightbox.
    frames.splice(frameIndex + 1, 0, layers.map(layer => newLayer(layer.name, {
      visible: layer.visible, opacity: layer.opacity, strokes: layer.strokes.slice(), asset: layer.asset,
      ...(layer.xf ? { xf: layer.xf, bend: layer.bend, xfBase: layer.xfBase, xfStrokes: layer.xfStrokes } : {}), ...(layer.backdrop ? { backdrop: layer.backdrop } : {}) })));
    showFrame(frameIndex + 1);
    logEvent('artist', 'Added frame', `frame ${frameIndex + 1}, a copy of frame ${frameIndex}`);
    if (saveKind !== 'shot' && !editing) setSaveKind('shot');
    if (frames.length === 2) {
      message('drawing-status', 'Frame 2 is a copy of frame 1 (the red ghost). Change what moves: draw, erase, or slide a layer with \u2725 Move (M).');
    }
  }
  function deleteFrame() {
    if (frames.length === 1 || busy()) return;
    stopPlay();
    pushUndo();
    const removed = frameIndex + 1;
    frames.splice(frameIndex, 1);
    showFrame(Math.min(frameIndex, frames.length - 1));
    logEvent('artist', 'Deleted frame', `frame ${removed}`);
    message('drawing-status', `Deleted frame ${removed}. Undo brings it back.`);
  }
  function play() {
    if (frames.length < 2 || playing) return;
    closePopover();
    playing = { at: frameIndex, timer: null };
    const tick = () => {
      renderOverlay();
      document.querySelectorAll('#frame-list .frame').forEach(b => b.classList.toggle('playing', Number(b.dataset.frame) === playing.at));
      playing.at = (playing.at + 1) % frames.length;
    };
    tick();
    playing.timer = setInterval(tick, 1000 / fps);
    $('frame-play').textContent = '\u23f8';
    $('frame-play').setAttribute('aria-label', 'Stop');
    updateHud();
  }
  function stopPlay() {
    if (!playing) return;
    clearInterval(playing.timer);
    playing = null;
    $('frame-play').textContent = '\u25b6';
    $('frame-play').setAttribute('aria-label', 'Play');
    document.querySelectorAll('#frame-list .playing').forEach(b => b.classList.remove('playing'));
    updateHud();
  }
  $('frame-play').addEventListener('click', () => (playing ? stopPlay() : play()));
  $('frame-add').addEventListener('click', addFrame);
  $('frame-delete').addEventListener('click', deleteFrame);
  $('onion').addEventListener('change', () => { onionSkin = $('onion').checked; composite(); });
  $('fps').addEventListener('change', () => {
    fps = Number($('fps').value);
    revision++;
    if (playing) { stopPlay(); play(); }
  });

  // ---------------------------------------------------------------- layers panel
  // The same layer in every frame: matched by position and name, so a scene can be taken apart and put back together.
  const scoped = () => everyFrame && frames.length > 1;
  function twins(layer) {
    if (!scoped()) return [layer];
    const index = layers.indexOf(layer);
    return frames.map(stack => (stack === layers ? layer : stack[index])).filter(twin => twin && twin.name === layer.name);
  }
  const frameWord = list => (list.length > 1 ? ` in all ${list.length} frames` : frames.length > 1 ? ` on frame ${frameIndex + 1}` : '');
  $('layer-scope').addEventListener('click', () => {
    everyFrame = !everyFrame;
    renderLayersPanel();
    flashTray(everyFrame ? `\u25a4 Layer edits reach all ${frames.length} frames.` : `\u25a4 Layer edits stay on frame ${frameIndex + 1}.`);
  });
  function renderLayersPanel() {
    const list = $('layer-list');
    list.replaceChildren(...[...layers].reverse().map(layer => {
      const item = document.createElement('li');
      item.className = `layer${layer.id === activeId ? ' active' : ''}${layer.visible ? '' : ' hidden-layer'}`;
      item.setAttribute('aria-current', String(layer.id === activeId));
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'layer-eye';
      eye.setAttribute('aria-pressed', String(layer.visible));
      eye.setAttribute('aria-label', `${layer.visible ? 'Hide' : 'Show'} ${layer.name}`);
      eye.dataset.tip = layer.visible ? 'Hide layer|Hidden layers are kept but not shown, exported, or searched.' : 'Show layer';
      eye.innerHTML = layer.visible
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><path d="M4 4l16 16"/></svg>';
      eye.addEventListener('click', () => {
        pushUndo();
        const show = !layer.visible;
        const all = twins(layer);
        for (const twin of all) twin.visible = show;
        composite();
        rebuildOnion();
        renderLayersPanel();
        if (all.length > 1) flashTray(`${show ? 'Showing' : 'Hid'} \u201c${layer.name}\u201d${frameWord(all)}.`);
      });
      const thumb = document.createElement('canvas');
      thumb.className = 'layer-thumb';
      thumb.width = 60;
      thumb.height = 39;
      const t = thumb.getContext('2d');
      t.fillStyle = '#ffffff';
      t.fillRect(0, 0, 60, 39);
      t.globalAlpha = layer.opacity;
      t.drawImage(layerCanvas(layer.id), 0, 0, 60, 39);
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'layer-name';
      name.textContent = layer.name;
      name.dataset.tip = `${layer.name}|Click to draw on this layer. Double-click to rename it.`;
      name.addEventListener('click', event => { activeId = layer.id; followSelection(layer.id, event.shiftKey); renderLayersPanel(); });
      name.addEventListener('dblclick', () => renameLayer(layer, item, name));
      if (layer.asset) {
        // A layer placed from a library asset: "Where used" finds this shot by exact link.
        const badge = document.createElement('span');
        badge.className = 'asset-badge';
        badge.textContent = `\u25c6 v${layer.asset.version}`;
        badge.dataset.tip = `Linked to an asset (v${layer.asset.version})|This layer was placed from an asset, so "Where used" can find this scene.`;
        name.prepend(badge);
        item.classList.add('linked');
      }
      item.append(eye, thumb, name);
      return item;
    }));
    const current = activeLayer();
    const index = layers.indexOf(current);
    $('layer-opacity').value = String(Math.round(current.opacity * 100));
    $('layer-opacity-value').value = `${Math.round(current.opacity * 100)}%`;
    $('layer-up').disabled = index === layers.length - 1;
    $('layer-down').disabled = index === 0;
    $('layer-delete').disabled = layers.length === 1;
    $('layer-add').disabled = layers.length >= MAX_LAYERS;
    $('layer-copy').disabled = layers.length >= MAX_LAYERS;
    $('layer-brush').disabled = !activeLayer().strokes.some(stroke => !stroke.erase);
    $('layers-count').textContent = String(layers.length);
    $('layer-scope').hidden = frames.length < 2;
    $('layer-scope').setAttribute('aria-pressed', String(everyFrame));
    $('layer-scope').textContent = everyFrame ? `All ${frames.length} frames` : `Frame ${frameIndex + 1} only`;
    renderSaveKind(); // the shot panel lists placed assets, which undo/delete can change
    updateHud();
  }
  function renameLayer(layer, item, nameButton) {
    const input = document.createElement('input');
    input.className = 'layer-rename';
    input.value = layer.name;
    input.maxLength = 40;
    input.setAttribute('aria-label', `Rename ${layer.name}`);
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (save && value && value !== layer.name) {
        pushUndo();
        for (const twin of twins(layer)) twin.name = value;
      }
      renderLayersPanel();
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    item.replaceChild(input, nameButton);
    input.focus();
    input.select();
  }
  $('layer-add').addEventListener('click', () => {
    if (layers.length >= MAX_LAYERS) return;
    pushUndo();
    const used = new Set(layers.map(layer => layer.name));
    let n = layers.length + 1;
    while (used.has(`Layer ${n}`)) n++;
    const at = layers.indexOf(activeLayer()) + 1;
    const layer = newLayer(`Layer ${n}`);
    if (scoped()) for (const stack of frames) if (stack !== layers) stack.splice(Math.min(at, stack.length), 0, newLayer(layer.name));
    layers.splice(at, 0, layer);
    activeId = layer.id;
    rebuildAll();
    if (scoped()) flashTray(`New layer \u201c${layer.name}\u201d in all ${frames.length} frames: draw on any of them.`);
  });
  $('layer-delete').addEventListener('click', () => {
    if (layers.length === 1) return;
    pushUndo();
    const index = layers.indexOf(activeLayer());
    const all = twins(activeLayer());
    for (const stack of frames) {
      const at = stack.findIndex(layer => all.includes(layer));
      if (at >= 0 && stack.length > 1) stack.splice(at, 1);
    }
    const removed = all[0];
    activeId = layers[Math.max(0, Math.min(index - 1, layers.length - 1))].id;
    recount();
    rebuildOnion();
    rebuildAll();
    message('drawing-status', `Deleted "${removed.name}"${frameWord(all)}. Undo brings it back.`);
  });
  function moveLayer(step) {
    const index = layers.indexOf(activeLayer());
    const target = index + step;
    if (target < 0 || target >= layers.length) return;
    pushUndo();
    const name = layers[index].name;
    for (const stack of scoped() ? frames : [layers]) {
      if (stack[index]?.name === name && stack[target]) [stack[index], stack[target]] = [stack[target], stack[index]];
    }
    composite();
    rebuildOnion();
    renderLayersPanel();
  }
  $('layer-up').addEventListener('click', () => moveLayer(1));
  $('layer-down').addEventListener('click', () => moveLayer(-1));
  $('layer-opacity').addEventListener('input', event => {
    opacityBefore ??= snapshot();
    for (const twin of twins(activeLayer())) twin.opacity = Number(event.target.value) / 100;
    $('layer-opacity-value').value = `${event.target.value}%`;
    scheduleComposite();
  });
  // One undo step per drag. `change` doesn't fire when a drag ends where it started, so also end on release/blur.
  function endOpacityEdit() {
    if (!opacityBefore) return;
    const before = opacityBefore.frames[opacityBefore.frame].find(layer => layer.id === activeId);
    const changed = before && before.opacity !== activeLayer().opacity;
    if (changed) pushUndo(opacityBefore);
    opacityBefore = null;
    renderLayersPanel();
  }
  for (const type of ['change', 'pointerup', 'blur']) $('layer-opacity').addEventListener(type, endOpacityEdit);

  // ---------------------------------------------------------------- pointer input
  function normPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    };
  }
  // The ink engine. Raw input is steadied (a light stabilizer), drawn as smooth curves through the
  // midpoints of the samples, and tapered like a brush pen. What's saved is still plain points, so the
  // server renders every stroke exactly like the canvas does.
  let inkState = null; // { pen, stab, base, from, ctrl, n } for the stroke being drawn (never saved)
  const inkDist = (a, b) => Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);
  function pushInk(point) {
    if (pointCount >= MAX_POINTS) {
      message('drawing-status', 'This canvas has reached 20,000 points. Save it or undo a stroke to continue.', true);
      return false;
    }
    const previous = active.points[active.points.length - 1];
    active.points.push(point);
    pointCount++;
    const c = layerCanvas(activeStrokeLayer.id).getContext('2d');
    withMode(c, active, () => paintPoint(c, active, point, previous));
    return true;
  }
  function curveTo(a, control, b) {
    const steps = Math.max(1, Math.ceil((inkDist(a, control) + inkDist(control, b)) / 2.5));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      if (!pushInk({ x: u * u * a.x + 2 * u * t * control.x + t * t * b.x, y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
        pressure: a.pressure + (b.pressure - a.pressure) * t })) return;
    }
  }
  function appendPoint(event) {
    const raw = normPoint(event);
    if (!inkState) {
      const pen = event.pointerType === 'pen';
      const base = pen ? Math.max(0.05, event.pressure || 0.5) : 0.5;
      const first = { ...raw, pressure: pen ? base : base * 0.55 };
      inkState = { pen, stab: first, base, from: first, ctrl: null, n: 1 };
      pushInk(first);
      scheduleComposite();
      return;
    }
    // Steady hands for everyone: mice and fingers get more smoothing than a pencil.
    const pull = inkState.pen ? 0.7 : 0.45;
    const at = { x: inkState.stab.x + (raw.x - inkState.stab.x) * pull, y: inkState.stab.y + (raw.y - inkState.stab.y) * pull };
    const step = inkDist(at, inkState.stab);
    if (step < 0.8) return;
    // A pencil's pressure is smoothed; fingers and mice get a brush-pen feel: slow lines swell, flicks thin out.
    inkState.base = inkState.pen ? inkState.base * 0.4 + Math.max(0.05, event.pressure || inkState.base) * 0.6
      : inkState.base * 0.75 + Math.max(0.3, 0.62 - step / 70) * 0.25;
    inkState.n++;
    const point = { ...at, pressure: Math.min(1, inkState.pen ? inkState.base : inkState.base * Math.min(1, 0.55 + inkState.n * 0.09)) };
    inkState.stab = point;
    if (!inkState.ctrl) { inkState.ctrl = point; return; }
    const to = { x: (inkState.ctrl.x + point.x) / 2, y: (inkState.ctrl.y + point.y) / 2, pressure: (inkState.ctrl.pressure + point.pressure) / 2 };
    curveTo(inkState.from, inkState.ctrl, to);
    inkState.from = to;
    inkState.ctrl = point;
    scheduleComposite();
  }
  function endInk() {
    if (!inkState || !active) { inkState = null; return; }
    if (inkState.ctrl) curveTo(inkState.from, { x: (inkState.from.x + inkState.ctrl.x) / 2, y: (inkState.from.y + inkState.ctrl.y) / 2, pressure: inkState.ctrl.pressure }, inkState.ctrl);
    const points = active.points;
    if (!inkState.pen && points.length > 6) {
      // Finger and mouse strokes lift off like a brush: the last few points thin out.
      const k = Math.min(12, Math.floor(points.length / 3));
      for (let i = 0; i < k; i++) points[points.length - 1 - i].pressure *= 0.3 + 0.7 * (i / k);
      renderLayer(activeStrokeLayer);
    }
    inkState = null;
    scheduleComposite();
  }
  function canDrawOn(layer) {
    if (!layer.visible) {
      message('drawing-status', `"${layer.name}" is hidden. Show it to draw on it.`, true);
      return false;
    }
    if (allStrokes().length >= MAX_STROKES || pointCount >= MAX_POINTS) {
      message('drawing-status', 'Canvas limit reached. Save your work, or undo to keep drawing.', true);
      return false;
    }
    return true;
  }

  canvas.addEventListener('pointerdown', event => {
    if (busy() || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    if (playing) { stopPlay(); return; }
    if (event.pointerType === 'pen' && !penSeen) {
      penSeen = true;
      flashTray('\u270f\ufe0f Pencil detected: your palm and fingers won\'t draw. Pressure works.');
    }
    if (penSeen && event.pointerType === 'touch') return; // palm rejection once a pencil is in play
    if (rigView) { closeRig(); return; } // a tap on the canvas puts the rig view away
    if (tool === 'path') {
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
      startPath(event, normPoint(event));
      return;
    }
    if (motionDraft) { flashTray('\ud83c\udfac Keep (Enter) or skip (Esc) the motion first. Or pick \u3030 Path to drag another layer.'); return; }
    if ($('starter-strip').classList.contains('show')) { startersDismissed = true; renderStarters(); }
    // preventDefault keeps focus where it was; touching the canvas means "drawing now", so shortcuts
    // and Enter (accept spark) must not go to a previously focused field or button (e.g. Delete layer).
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    const point = normPoint(event);
    if (tool === 'place' && placing) {
      pointer = event.pointerId;
      canvas.setPointerCapture(pointer);
      placeDraft = { x0: point.x, y0: point.y, x1: point.x, y1: point.y };
      renderOverlay();
      return;
    }
    if (tool === 'spark') {
      closePopover();
      pointer = event.pointerId;
      canvas.setPointerCapture(pointer);
      selection = { x0: point.x, y0: point.y, x1: point.x, y1: point.y };
      renderOverlay();
      return;
    }
    if (tool === 'move') {
      // Grab what's under the finger (or the selected layer's resize handle); a miss just says how.
      const selected = activeLayer();
      const scaling = selected.visible && onHandle(selected, point);
      const target = scaling ? selected : pickLayer(point);
      if (!target) {
        flashTray('\u2725 Tap something you drew or placed to grab it. Scenery stays put (pick it in Layers to move it).');
        return;
      }
      activeId = target.id;
      followSelection(target.id, event.shiftKey);
      renderLayersPanel();
      const b = inkBounds(target.strokes);
      pointer = event.pointerId;
      canvas.setPointerCapture(pointer);
      moving = { layer: target, start: point, original: target.strokes, bounds: pointBounds(target.strokes), mode: scaling ? 'scale' : 'move',
        center: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, before: snapshot(), changed: false };
      return;
    }
    if (tool === 'stamp' && stamp) {
      const layer = inkTarget();
      if (!canDrawOn(layer)) return;
      pointer = event.pointerId;
      canvas.setPointerCapture(pointer);
      pushUndo();
      stamping = { layer, last: point, count: 0 };
      stampHover = null;
      placeStamp(point, false);
      return;
    }
    const layer = tool === 'eraser' ? activeLayer() : inkTarget();
    if (!canDrawOn(layer)) return;
    pointer = event.pointerId;
    canvas.setPointerCapture(pointer);
    if (SHAPES.has(tool)) {
      shapeDraft = { tool, start: point, end: point, shift: event.shiftKey, t0: performance.now() };
      renderOverlay();
      return;
    }
    pushUndo();
    handStrokes++;
    active = { color: tool === 'eraser' ? '#000000' : $('ink').value, width: Number($('width').value), points: [], erase: tool === 'eraser', fill: null, seq: nextSeq() };
    activeStart = performance.now();
    activeStrokeLayer = layer;
    layer.strokes.push(active);
    inkState = null;
    appendPoint(event);
  });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerId !== pointer) return;
    if (pathDraft) {
      extendPath(event);
    } else if (moving) {
      const point = normPoint(event);
      if (!moving.changed) {
        if (Math.hypot((point.x - moving.start.x) * W, (point.y - moving.start.y) * H) < 2) return;
        pushUndo(moving.before); // one undo step per drag, and none for a tap that only selects
        moving.changed = true;
      }
      if (moving.mode === 'scale') {
        const { center } = moving;
        const from = Math.hypot(moving.start.x * W - center.x, moving.start.y * H - center.y) || 1;
        const k = Math.max(0.15, Math.min(6, Math.hypot(point.x * W - center.x, point.y * H - center.y) / from));
        moving.layer.strokes = scaledStrokes(moving.original, center, k);
        moving.k = k;
      } else {
        // Slide the whole layer; the offset is clamped so no point is squashed against the canvas edge.
        const { bounds } = moving;
        const dx = Math.max(-bounds.x0, Math.min(1 - bounds.x1, point.x - moving.start.x));
        const dy = Math.max(-bounds.y0, Math.min(1 - bounds.y1, point.y - moving.start.y));
        moving.layer.strokes = moving.original.map(stroke => ({
          ...stroke, points: stroke.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }))
        }));
        moving.dx = dx;
        moving.dy = dy;
      }
      renderLayer(moving.layer);
      scheduleComposite();
      renderOverlay();
    } else if (placeDraft) {
      const point = normPoint(event);
      placeDraft.x1 = point.x;
      placeDraft.y1 = point.y;
      renderOverlay();
    } else if (selection) {
      const point = normPoint(event);
      selection.x1 = point.x;
      selection.y1 = point.y;
      renderOverlay();
    } else if (shapeDraft) {
      shapeDraft.end = normPoint(event);
      shapeDraft.shift = event.shiftKey;
      renderOverlay();
    } else if (stamping) {
      // A trail of stamps, one per stamp-width, like a scatter brush.
      const point = normPoint(event);
      if (Math.hypot((point.x - stamping.last.x) * W, (point.y - stamping.last.y) * H) >= Math.max(12, stampSize() * 0.8)) {
        stamping.last = point;
        placeStamp(point, true);
      }
    } else if (active) {
      const samples = event.getCoalescedEvents?.();
      for (const sample of samples?.length ? samples : [event]) appendPoint(sample);
    }
  });
  function finish(event) {
    if (event.pointerId !== pointer) return;
    pointer = null;
    if (pathDraft) {
      commitPath();
    } else if (moving) {
      const { layer, mode, changed, dx = 0, dy = 0, k = 1, center } = moving;
      moving = null;
      if (changed) {
        // The same move for this layer in every other frame: its whole animation shifts (or grows) together.
        const all = twins(layer);
        for (const twin of all) {
          if (twin === layer) continue;
          twin.strokes = mode === 'scale' ? scaledStrokes(twin.strokes, center, k)
            : twin.strokes.map(stroke => ({ ...stroke, points: stroke.points.map(p => ({ ...p, x: Math.max(0, Math.min(1, p.x + dx)), y: Math.max(0, Math.min(1, p.y + dy)) })) }));
        }
        if (all.length > 1) { rebuildOnion(); flashTray(`${mode === 'scale' ? 'Resized' : 'Moved'} \u201c${layer.name}\u201d${frameWord(all)}.`); }
        recount();
        logEvent('artist', mode === 'scale' ? 'Resized' : 'Moved', `${layer.name}${frameWord(all)}`);
      }
      renderLayersPanel();
    } else if (placeDraft) {
      const box = placementBox(placeDraft);
      placeDraft = null;
      renderOverlay();
      placeAsset(box);
    } else if (selection) {
      const region = selectionRegion(selection);
      selection = null;
      if (pendingFix !== null) {
        const prompt = pendingFix;
        pendingFix = null;
        renderOverlay();
        setTool(drawTool);
        startSpark('strokes', region, prompt);
      } else {
        openPopover(region);
      }
    } else if (shapeDraft) {
      const stroke = shapeStroke(shapeDraft);
      shapeDraft = null;
      renderOverlay();
      if (stroke) stroke.ms = Math.round(performance.now() - shapeDraft.t0);
      if (stroke && commitStrokes([stroke])) handStrokes++;
    } else if (stamping) {
      const { count } = stamping;
      stamping = null;
      if (count) logEvent('artist', 'Stamped', `${count} \u00d7 ${stamp.name}`);
      renderLayersPanel();
    } else if (active) {
      endInk();
      active.ms = Math.min(3_600_000, Math.round(performance.now() - activeStart));
      active = null;
      activeStrokeLayer = null;
      renderLayersPanel();
    }
  }
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', event => {
    if (event.pointerId === pointer && (selection || shapeDraft || placeDraft || pathDraft)) {
      pathDraft = null;
      placeDraft = null;
      selection = null;
      shapeDraft = null;
      renderOverlay();
    }
    finish(event);
  });
  canvas.addEventListener('lostpointercapture', finish);

  // Two fingers tap to undo, three to redo (like the drawing apps artists already know). A stroke the
  // first finger started is called off, so the gesture never leaves a mark.
  const touches = new Map();
  let gesture = null;
  function callOff() {
    if (pointer !== null && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    const started = active || stamping || moving?.changed;
    if (active) handStrokes = Math.max(0, handStrokes - 1);
    pointer = null;
    active = null;
    activeStrokeLayer = null;
    inkState = null;
    stamping = null;
    moving = null;
    shapeDraft = null;
    selection = null;
    placeDraft = null;
    pathDraft = null;
    if (started && undoStack.length) {
      restore(undoStack.pop());
      redoStack.splice(0, redoStack.length, ...redoBackup);
      updateControls();
    } else renderOverlay();
  }
  canvas.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size < 2) return;
    if (!gesture) { gesture = { fingers: touches.size, t0: performance.now(), moved: false }; callOff(); }
    else gesture.fingers = Math.max(gesture.fingers, touches.size);
  });
  canvas.addEventListener('pointermove', event => {
    const start = touches.get(event.pointerId);
    if (gesture && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 14) gesture.moved = true;
  });
  const touchUp = event => {
    if (!touches.delete(event.pointerId) || !gesture || touches.size) return;
    const tap = !gesture.moved && performance.now() - gesture.t0 < 400;
    if (tap && gesture.fingers === 2 && undoStack.length) { undo(); flashTray('\u21b6 Undo \u00b7 two-finger tap'); }
    else if (tap && gesture.fingers >= 3 && redoStack.length) { redo(); flashTray('\u21b7 Redo \u00b7 three-finger tap'); }
    gesture = null;
  };
  canvas.addEventListener('pointerup', touchUp);
  canvas.addEventListener('pointercancel', touchUp);

  // A live brush ring under the mouse or pencil: the exact size and color of the next line.
  const brushCursor = $('brush-cursor');
  function placeBrushCursor(x, y) {
    const rect = canvas.getBoundingClientRect();
    const frame = $('canvas-frame').getBoundingClientRect();
    const size = Math.max(4, Number($('width').value) * rect.width / W);
    brushCursor.style.setProperty('--size', `${size}px`);
    brushCursor.style.setProperty('--ink', tool === 'eraser' ? '#64748b' : $('ink').value);
    brushCursor.style.transform = `translate(${x - frame.left - size / 2}px, ${y - frame.top - size / 2}px)`;
  }
  const inkTool = () => tool === 'pen' || tool === 'eraser';
  function showBrush(on) {
    brushCursor.hidden = !on;
    $('canvas-frame').classList.toggle('brushing', on); // the ring replaces the arrow, never leaves you cursorless
  }
  canvas.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || !inkTool() || playing || motionDraft) { showBrush(false); return; }
    showBrush(true);
    brushCursor.classList.toggle('erasing', tool === 'eraser');
    placeBrushCursor(event.clientX, event.clientY);
  });
  canvas.addEventListener('pointerleave', () => showBrush(false));
  // Dragging the size slider previews the brush in the middle of the paper.
  let sizePreview = null;
  $('width').addEventListener('input', () => {
    if (!inkTool()) return;
    const rect = canvas.getBoundingClientRect();
    showBrush(true);
    brushCursor.classList.add('preview');
    placeBrushCursor(rect.left + rect.width / 2, rect.top + rect.height / 2);
    clearTimeout(sizePreview);
    sizePreview = setTimeout(() => { showBrush(false); brushCursor.classList.remove('preview'); }, 700);
  });

  function shapeStroke({ tool: kind, start, end, shift }) {
    let x0 = start.x * W;
    let y0 = start.y * H;
    let x1 = end.x * W;
    let y1 = end.y * H;
    if (Math.hypot(x1 - x0, y1 - y0) < 3) return null;
    if (shift && kind === 'line') {
      const angle = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * (Math.PI / 4);
      const length = Math.hypot(x1 - x0, y1 - y0);
      x1 = x0 + length * Math.cos(angle);
      y1 = y0 + length * Math.sin(angle);
    } else if (shift) {
      const side = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + Math.sign(x1 - x0 || 1) * side;
      y1 = y0 + Math.sign(y1 - y0 || 1) * side;
    }
    let pixels;
    if (kind === 'line') pixels = [[x0, y0], [x1, y1]];
    else if (kind === 'rect') pixels = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
    else {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = Math.abs(x1 - x0) / 2;
      const ry = Math.abs(y1 - y0) / 2;
      pixels = Array.from({ length: 73 }, (_, i) => [cx + rx * Math.cos(i / 36 * Math.PI), cy + ry * Math.sin(i / 36 * Math.PI)]);
    }
    const clamp = value => Math.max(0, Math.min(1, value));
    return {
      color: $('ink').value,
      width: Number($('width').value),
      // pressure 0.75 renders at exactly the chosen size (width * (0.25 + pressure)).
      points: pixels.map(([x, y]) => ({ x: clamp(x / W), y: clamp(y / H), pressure: 0.75 })),
      erase: false,
      fill: kind !== 'line' && $('fill-on').checked ? $('fill-color').value : null
    };
  }

  // Adds finished strokes (a shape or an accepted spark) to the active layer as one undo step.
  function commitStrokes(list) {
    const layer = inkTarget();
    if (!canDrawOn(layer)) return false;
    if (allStrokes().length + list.length > MAX_STROKES || pointCount + countPoints(list) > MAX_POINTS) {
      message('drawing-status', 'That would exceed the canvas limits. Undo a few strokes first.', true);
      return false;
    }
    pushUndo();
    for (const stroke of list) if (stroke.seq == null) stroke.seq = nextSeq();
    layer.strokes.push(...list);
    const c = layerCanvas(layer.id).getContext('2d');
    list.forEach(stroke => drawStroke(c, stroke));
    recount();
    composite();
    renderLayersPanel();
    return true;
  }

  function selectionRegion({ x0, y0, x1, y1 }) {
    let x = Math.min(x0, x1);
    let y = Math.min(y0, y1);
    let w = Math.abs(x1 - x0);
    let h = Math.abs(y1 - y0);
    if (w * W < 24 && h * H < 24) {
      // A tap sparks a 160px square around the point.
      w = 160 / W;
      h = 160 / H;
      x = x0 - w / 2;
      y = y0 - h / 2;
    }
    w = Math.min(1, Math.max(w, 0.03));
    h = Math.min(1, Math.max(h, 0.03));
    x = Math.max(0, Math.min(1 - w, x));
    y = Math.max(0, Math.min(1 - h, y));
    return { x, y, w, h };
  }

  // ---------------------------------------------------------------- your hand, always visible
  // Who made what, live: strokes by the artist's hand vs. AI drafts they accepted. Never a black box.
  function renderAuthorship() {
    const counts = madeBy([layers]);
    const ai = counts.ai + counts.placedAi;
    const mine = counts.hand + counts.placed - counts.placedAi;
    const total = mine + ai + counts.kit + counts.code;
    const meter = $('authorship');
    meter.hidden = !total;
    if (!total) return;
    const pct = n => Math.round(n / total * 100);
    meter.textContent = !mine && !ai && counts.code ? '\u27e8/\u27e9 Code over your lines \u270d'
      : !mine && !ai ? '\ud83e\udde9 Kit lines \u00b7 your turn \u270d'
      : `\u270d ${pct(mine)}% your hand${ai ? ` \u00b7 \u2726 ${pct(ai)}% AI` : ''}${counts.code ? ` \u00b7 \u27e8/\u27e9 ${pct(counts.code)}% code` : ''}${counts.kit ? ` \u00b7 ${pct(counts.kit)}% kit` : ''}`;
    meter.classList.toggle('pure', !ai);
  }
  $('authorship').addEventListener('click', () => $('breakdown-open').click());

  // ---------------------------------------------------------------- copy, paste, duplicate: plain computer superpowers
  const CLIP_KEY = 'inkling.clipboard.v1';
  let clipboard = (() => { try { return JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); } catch { return null; } })();
  const cloneStroke = stroke => ({ ...stroke, points: stroke.points.map(point => ({ ...point })) });
  function setClipboard(item) {
    clipboard = item;
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(item)); } catch { /* too big to keep across tabs; this tab still has it */ }
  }
  function clipboardActions() {
    return [{ label: 'Paste', tip: 'Paste \u00b7 Cmd/Ctrl+V', run: pasteClipboard },
      { label: '\ud83d\udd8c Use as brush', tip: 'Stamp brush|Your own art as a brush. Tap to stamp, drag to scatter.', run: brushFromClipboard }];
  }
  function copyLayer() {
    const layer = activeLayer();
    if (!layer.strokes.some(stroke => !stroke.erase)) { flashTray('Nothing to copy on this layer yet.'); return; }
    setClipboard({ name: layer.name, strokes: layer.strokes.map(cloneStroke), link: layer.asset ? { ...layer.asset } : null });
    message('drawing-status', `Copied \u201c${layer.name}\u201d. It's yours to reuse, as a copy or as a brush.`, false, clipboardActions());
  }
  // A pasted layer lands a little down and right, like any design app, then Move is ready to drag it.
  function pasteStrokes(name, strokes, link = null) {
    const bounds = pointBounds(strokes);
    if (!bounds) return;
    const dx = Math.min(0.03, 1 - bounds.x1), dy = Math.min(0.03, 1 - bounds.y1);
    const total = countPoints(strokes);
    if (layers.length >= MAX_LAYERS || allStrokes().length + strokes.length > MAX_STROKES || pointCount + total > MAX_POINTS) {
      message('drawing-status', 'That would exceed the canvas limits. Delete a layer or undo a few strokes first.', true);
      return;
    }
    pushUndo();
    const copy = newLayer(`${name.slice(0, 33)} copy`, { asset: link ? { ...link } : null,
      strokes: strokes.map(stroke => ({ ...cloneStroke(stroke), seq: nextSeq(),
        points: stroke.points.map(point => ({ ...point, x: point.x + dx, y: point.y + dy })) })) });
    layers.splice(layers.indexOf(activeLayer()) + 1, 0, copy);
    activeId = copy.id;
    recount();
    rebuildAll();
    logEvent('artist', 'Pasted', copy.name);
    setTool('move');
    flashTray(`Pasted \u201c${copy.name}\u201d. Drag it into place, or pull its corner to resize.`);
  }
  function pasteClipboard() {
    if (!clipboard) { flashTray('Copy something first: Cmd/Ctrl+C copies the layer you\u2019re on.'); return; }
    if (clipboard.item) { showTop(); startPlacing(clipboard.item); return; }
    pasteStrokes(clipboard.name, clipboard.strokes, clipboard.link);
  }
  function duplicateLayer() {
    const layer = activeLayer();
    if (!layer.strokes.length) { flashTray('Nothing to duplicate on this layer yet.'); return; }
    pasteStrokes(layer.name, layer.strokes, layer.asset);
  }
  $('layer-copy').addEventListener('click', duplicateLayer);
  const showTop = () => { setFocus(false); setView('studio'); };

  // ---------------------------------------------------------------- the stamp brush: your art, multiplied (no AI)
  const stampSize = () => 24 * Number($('width').value);
  function makeStamp(name, strokes) {
    const ink = strokes.filter(stroke => !stroke.erase && stroke.points.length);
    const b = pointBounds(ink);
    if (!b) return null;
    const cx = (b.x0 + b.x1) / 2 * W, cy = (b.y0 + b.y1) / 2 * H;
    // A brush must stay light: very detailed art is thinned to ~800 points per stamp.
    const step = Math.max(1, Math.ceil(countPoints(ink) / 800));
    return {
      name: name.slice(0, 40),
      size: Math.max((b.x1 - b.x0) * W, (b.y1 - b.y0) * H, 4),
      strokes: ink.map(stroke => {
        const points = stroke.points.filter((_, i) => i % step === 0 || i === stroke.points.length - 1);
        return { color: stroke.color, width: stroke.width, fill: stroke.fill || null, ai: !!stroke.ai, kit: !!stroke.kit,
          points: points.map(p => ({ x: p.x * W - cx, y: p.y * H - cy, pressure: p.pressure ?? 0.75 })) };
      })
    };
  }
  // Scaled to the brush size; a dragged trail gets a touch of natural wobble in size and angle.
  function stampStrokes(at, scatter) {
    const k = stampSize() / stamp.size * (scatter ? 0.88 + Math.random() * 0.24 : 1);
    const angle = scatter ? (Math.random() - 0.5) * 0.35 : 0;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const clamp = v => Math.max(0, Math.min(1, v));
    const ink = stamp.tint ? $('ink').value : null;
    return stamp.strokes.map(({ ai, kit, ...stroke }) => ({
      ...stroke, erase: false, width: Math.max(1, Math.min(40, Math.round(stroke.width * k * 10) / 10)),
      ...(ink ? { color: ink, fill: stroke.fill ? ink : null } : {}),
      ...(ai ? { ai: true } : {}), ...(kit ? { kit: true } : {}), // provenance travels with the art
      points: stroke.points.map(p => ({ x: clamp((p.x * cos - p.y * sin) * k / W + at.x), y: clamp((p.x * sin + p.y * cos) * k / H + at.y), pressure: p.pressure }))
    }));
  }
  function placeStamp(at, scatter) {
    const list = stampStrokes(at, scatter);
    if (allStrokes().length + list.length > MAX_STROKES || pointCount + countPoints(list) > MAX_POINTS) {
      flashTray('Canvas limit reached. Save it, or undo a few stamps.', true);
      return;
    }
    const layer = stamping.layer;
    for (const stroke of list) stroke.seq = nextSeq();
    layer.strokes.push(...list);
    const c = layerCanvas(layer.id).getContext('2d');
    list.forEach(stroke => drawStroke(c, stroke));
    stamping.count++;
    recount();
    scheduleComposite();
  }
  function drawStampIcon(icon = $('stamp-icon'), source = stamp) {
    const c = icon.getContext('2d');
    c.clearRect(0, 0, icon.width, icon.height);
    const k = icon.width * 0.82 / source.size;
    c.save();
    c.translate(icon.width / 2, icon.height / 2);
    for (const stroke of source.strokes) {
      const tint = $('ink').value;
      const color = source.tint ? tint : stroke.color;
      if (stroke.fill) {
        c.fillStyle = source.tint ? tint : stroke.fill;
        c.beginPath();
        stroke.points.forEach((p, i) => (i ? c.lineTo(p.x * k, p.y * k) : c.moveTo(p.x * k, p.y * k)));
        c.closePath();
        c.fill();
      }
      c.strokeStyle = color;
      c.lineWidth = Math.max(1, stroke.width * k);
      c.lineCap = c.lineJoin = 'round';
      c.beginPath();
      stroke.points.forEach((p, i) => (i ? c.lineTo(p.x * k, p.y * k) : c.moveTo(p.x * k, p.y * k)));
      if (stroke.points.length === 1) c.lineTo(stroke.points[0].x * k + 0.1, stroke.points[0].y * k);
      c.stroke();
    }
    c.restore();
  }
  function useAsBrush(name, strokes) {
    const made = makeStamp(name, strokes);
    if (!made) { flashTray('Nothing to make a brush from yet.', true); return; }
    myBrush = made;
    selectStamp(made, `\ud83d\udd8c \u201c${made.name}\u201d is your brush. Tap to stamp, drag to scatter. The size slider (or [ ]) sets its size.`);
    logEvent('artist', 'Made a brush', made.name);
  }
  function selectStamp(made, tip) {
    stamp = made;
    drawStampIcon();
    const button = document.querySelector('.tool[data-tool="stamp"]');
    button.hidden = false;
    button.setAttribute('aria-label', `Stamp brush: ${stamp.name}`);
    button.classList.remove('fresh');
    void button.offsetWidth;
    button.classList.add('fresh');
    setTool('stamp');
    flashTray(tip);
    renderKit();
  }
  async function brushFromClipboard() {
    if (!clipboard) return;
    if (!clipboard.item) { showTop(); useAsBrush(clipboard.name, clipboard.strokes); return; }
    await brushFromAsset(clipboard.item);
  }
  async function brushFromAsset(item) {
    try {
      const record = await api(`/api/assets/${encodeURIComponent(item.id)}`);
      showTop();
      useAsBrush(item.name, record.layers.filter(layer => layer.visible !== false).flatMap(layer => layer.strokes));
    } catch (error) {
      message('drawing-status', error.message, true);
    }
  }
  $('layer-brush').addEventListener('click', () => { const layer = activeLayer(); useAsBrush(layer.name, layer.strokes); });
  canvas.addEventListener('pointermove', event => {
    if (tool !== 'stamp' || !stamp || pointer !== null || event.pointerType === 'touch') return;
    stampHover = normPoint(event);
    renderOverlay();
  });
  canvas.addEventListener('pointerleave', () => { if (stampHover) { stampHover = null; renderOverlay(); } });

  // ---------------------------------------------------------------- the kit: shapes, figures, and brushes to build on
  // Plain geometry, drawn in your ink color. Tap to stamp, drag to scatter. Marked as kit, never as your hand.
  let myBrush = null;
  const arc = (cx, cy, rx, ry = rx, n = 40, from = 0, to = Math.PI * 2) =>
    Array.from({ length: n + 1 }, (_, i) => { const t = from + (to - from) * i / n; return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]; });
  const path = (...pts) => pts;
  const KIT = [
    { id: 'star', name: 'Star', group: 'Brushes', make: () => [{ fill: true, pts: Array.from({ length: 11 }, (_, i) => {
      const r = i % 2 ? 22 : 50, t = -Math.PI / 2 + i * Math.PI / 5; return [r * Math.cos(t), r * Math.sin(t)]; }) }] },
    { id: 'heart', name: 'Heart', group: 'Brushes', make: () => [{ fill: true, pts: Array.from({ length: 49 }, (_, i) => {
      const t = i / 48 * Math.PI * 2; return [3 * 16 * Math.sin(t) ** 3, -3 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]; }) }] },
    { id: 'leaf', name: 'Leaf', group: 'Brushes', make: () => [
      { pts: [...arc(0, 26, 56, 56, 16, -Math.PI * 0.75, -Math.PI * 0.25), ...arc(0, -26, 56, 56, 16, Math.PI * 0.25, Math.PI * 0.75)] },
      { width: 3, pts: path([-52, 8], [-40, 0], [38, 0]) }, { width: 2, pts: path([-12, 0], [2, -12]) }, { width: 2, pts: path([10, 0], [22, 10]) }] },
    { id: 'cloud', name: 'Cloud', group: 'Brushes', make: () => [{ pts: [...arc(-30, 6, 22, 22, 14, Math.PI * 0.5, Math.PI * 1.5), ...arc(-6, -12, 28, 28, 14, Math.PI, Math.PI * 2),
      ...arc(28, 0, 24, 24, 14, -Math.PI * 0.5, Math.PI * 0.5), [-30, 28]] }] },
    { id: 'grass', name: 'Grass', group: 'Brushes', make: () => [-24, -10, 4, 18, 30].map((x, i) => ({ width: 4,
      pts: Array.from({ length: 9 }, (_, j) => [x + (j / 8) ** 2 * (i % 2 ? 14 : -12), 40 - j * (9 + (i % 3) * 1.5)]) })) },
    { id: 'sparkle', name: 'Sparkle', group: 'Brushes', make: () => [{ fill: true, pts: Array.from({ length: 41 }, (_, i) => {
      const t = i / 40 * Math.PI * 2; return [50 * Math.cos(t) ** 3, 50 * Math.sin(t) ** 3]; }) }] },
    { id: 'flower', name: 'Flower', group: 'Brushes', make: () => [
      ...[0, 1, 2, 3, 4].map(i => { const t = -Math.PI / 2 + i * Math.PI * 2 / 5; return { pts: arc(Math.cos(t) * 26, Math.sin(t) * 26, 18, 18, 20) }; }),
      { fill: true, pts: arc(0, 0, 11, 11, 18) }] },
    { id: 'drop', name: 'Drop', group: 'Brushes', make: () => [{ fill: true, pts: [[0, -50], ...arc(0, 14, 30, 30, 24, -Math.PI * 0.15, Math.PI * 1.15), [0, -50]] }] },
    { id: 'bubbles', name: 'Bubbles', group: 'Brushes', make: () => [{ pts: arc(-14, 10, 26, 26, 30) }, { pts: arc(26, -18, 15, 15, 22) }, { pts: arc(24, 26, 9, 9, 16) }] },
    { id: 'wave', name: 'Wave', group: 'Brushes', make: () => [{ width: 5, pts: Array.from({ length: 41 }, (_, i) => [-60 + i * 3, 14 * Math.sin(i / 40 * Math.PI * 4)]) }] },
    { id: 'figure', name: 'Figure', group: 'Figures', make: () => [{ pts: arc(0, -46, 13, 13, 24) }, { pts: path([0, -33], [0, 12]) },
      { pts: path([-28, -8], [0, -22], [28, -8]) }, { pts: path([-20, 52], [0, 12], [20, 52]) }] },
    { id: 'house', name: 'House', group: 'Figures', make: () => [{ pts: path([-40, -4], [-40, 46], [40, 46], [40, -4]) }, { pts: path([-50, 2], [0, -46], [50, 2]) },
      { pts: path([-10, 46], [-10, 18], [10, 18], [10, 46]) }] },
    { id: 'tree', name: 'Tree', group: 'Figures', make: () => [{ pts: path([-6, 50], [-6, 10]) }, { pts: path([6, 50], [6, 10]) },
      { pts: [...arc(-20, -6, 20, 20, 12, Math.PI * 0.5, Math.PI * 1.4), ...arc(0, -30, 24, 24, 14, Math.PI * 1.1, Math.PI * 1.9), ...arc(20, -6, 20, 20, 12, -Math.PI * 0.4, Math.PI * 0.5), [-20, 14]] }] },
    { id: 'mountain', name: 'Mountain', group: 'Figures', make: () => [{ pts: path([-60, 36], [-18, -30], [2, -4], [20, -36], [60, 36]) }, { pts: path([-30, -12], [-18, -30], [-8, -14]) }] },
    { id: 'sun', name: 'Sun', group: 'Figures', make: () => [{ fill: true, pts: arc(0, 0, 22, 22, 32) },
      ...Array.from({ length: 8 }, (_, i) => { const t = i * Math.PI / 4; return { pts: path([Math.cos(t) * 32, Math.sin(t) * 32], [Math.cos(t) * 48, Math.sin(t) * 48]) }; })] },
    { id: 'face', name: 'Face', group: 'Figures', make: () => [{ pts: arc(0, 0, 46, 46, 40) }, { fill: true, pts: arc(-16, -10, 5, 5, 12) },
      { fill: true, pts: arc(16, -10, 5, 5, 12) }, { pts: arc(0, 6, 22, 18, 16, Math.PI * 0.15, Math.PI * 0.85) }] }
  ];
  function kitStamp(item) {
    const strokes = item.make().map(({ pts, fill, width }) => ({ color: '#123b38', width: width ?? 4, fill: fill ? '#123b38' : null, kit: true,
      points: pts.map(([x, y]) => ({ x, y, pressure: 0.75 })) }));
    const xs = strokes.flatMap(s => s.points.map(p => p.x)), ys = strokes.flatMap(s => s.points.map(p => p.y));
    return { name: item.name, tint: true, size: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)), strokes };
  }
  function kitButton(made, onPick, label = made.name) {
    const button = el('button', 'kit-item');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(stamp?.name === made.name && stamp?.tint === made.tint));
    const icon = document.createElement('canvas');
    icon.width = icon.height = 56;
    drawStampIcon(icon, made);
    button.append(icon, el('span', '', label));
    button.addEventListener('click', onPick);
    return button;
  }
  function renderKit() {
    const groups = ['Brushes', 'Figures'].map(group => {
      const wrap = el('div', 'kit-group');
      wrap.append(el('p', 'kit-label', group));
      const grid = el('div', 'kit-grid');
      grid.append(...KIT.filter(item => item.group === group).map(item => {
        const made = kitStamp(item);
        return kitButton(made, () => { closeKit(); selectStamp(made, `${made.name}: tap to stamp, drag to scatter. Uses your ink color; [ ] sets the size.`); });
      }));
      wrap.append(grid);
      return wrap;
    });
    const mine = el('div', 'kit-group');
    mine.append(el('p', 'kit-label', 'Yours'));
    if (myBrush) {
      const grid = el('div', 'kit-grid');
      grid.append(kitButton(myBrush, () => { closeKit(); selectStamp(myBrush, `\ud83d\udd8c \u201c${myBrush.name}\u201d: tap to stamp, drag to scatter.`); }));
      mine.append(grid);
    }
    mine.append(el('p', 'kit-hint', myBrush ? 'Make another: Layers \u203a \ud83d\udd8c Brush, or \ud83d\udd8c Brush on any asset card.'
      : 'Any drawing can be a brush: Layers \u203a \ud83d\udd8c Brush, or \ud83d\udd8c Brush on an asset card.'));
    $('kit-body').replaceChildren(...groups, mine);
  }
  function openKit() {
    closeNudge();
    renderKit();
    $('kit').hidden = false;
    $('kit').classList.remove('dealt');
    void $('kit').offsetWidth;
    $('kit').classList.add('dealt');
    document.querySelector('.stamp-tool').setAttribute('aria-expanded', 'true');
  }
  function closeKit() {
    $('kit').hidden = true;
    document.querySelector('.stamp-tool').setAttribute('aria-expanded', 'false');
  }
  function toggleKit() { $('kit').hidden ? openKit() : closeKit(); }
  drawStampIcon($('stamp-icon'), kitStamp(KIT[0])); // the toolbar shows a star until a brush is picked
  $('kit-close').addEventListener('click', closeKit);
  $('kit').addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeKit(); } });

  // ---------------------------------------------------------------- the magic wand: a nudge into flow
  // Free and instant: a playful prompt and a creative rule, or a "what if" for a drawing in progress.
  // AI is one optional tap away, and the artist's hand still does the drawing.
  const NUDGE_SUBJECTS = ['a sleepy dragon', 'a robot learning to dance', 'a cat astronaut', 'a tiny house on a giant turtle',
    'a cactus who wants a hug', 'a fox in a raincoat', 'a lighthouse that is afraid of the dark', 'a snail racing a rocket',
    'a cloud having a bad day', 'a whale in a teacup', 'a knight made of fruit', 'an octopus barista', 'a mushroom village',
    'a dog flying a kite', 'a monster who loves gardening', 'a bicycle with wings', 'a penguin on vacation',
    'a bear knitting a scarf', 'a tree full of lanterns', 'the moon, fishing for stars'];
  const NUDGE_TWISTS = ['guarding a single cookie', 'at sunrise', 'in the middle of a storm', 'meeting a new friend',
    'on its very first day', 'who just won a prize', 'hiding from the rain', 'seen from far, far away', 'up close and dramatic',
    'in the year 3000'];
  const NUDGE_RULES = ['Rule: draw the first line without lifting your pen.', 'Rule: only three colors.', 'Rule: twelve strokes or fewer.',
    'Rule: start with one big circle.', 'Rule: exaggerate one feature.', 'Rule: no erasing. Every mark stays.',
    'Rule: use the thickest brush for everything.', 'Rule: draw the shadow first.', 'Rule: give it a backdrop with just three lines.',
    'Rule: draw it fast, then draw it again slowly.'];
  const NUDGE_NEXT = ['Give it a friend who is its total opposite.', 'What is the weather doing? Draw it.',
    'Add something tiny in the background that tells a story.', 'Make one thing much bigger than it should be.',
    'What is it holding? What is it afraid of?', 'Draw where it lives.', 'Add motion lines: where is it going?',
    'Copy it, paste it, and make the copy different.', 'Turn your favorite part into a brush and scatter it.',
    'What happens next? Flipbook it.'];
  const pick = list => list[Math.floor(Math.random() * list.length)];
  let nudge = null; // { prompt, rule, fresh }
  let flowSeconds = 120;
  function dealNudge() {
    const fresh = !hasInk();
    let prompt;
    do { prompt = fresh ? `Draw ${pick(NUDGE_SUBJECTS)} ${pick(NUDGE_TWISTS)}.` : pick(NUDGE_NEXT); } while (nudge && prompt === nudge.prompt);
    nudge = { prompt, rule: fresh ? pick(NUDGE_RULES) : '', fresh };
    $('nudge-kicker').textContent = fresh ? '\ud83e\ude84 A little nudge' : '\ud83e\ude84 What if\u2026';
    $('nudge-title').textContent = prompt;
    $('nudge-rule').textContent = nudge.rule;
    $('nudge-rule').hidden = !nudge.rule;
    $('nudge-ai').textContent = fresh ? '\u2726 Sketch a start' : '\u2726 Ask AI for ideas';
    $('nudge-ai').dataset.tip = fresh ? 'AI sketch|A faint blue-pencil draft of this prompt, on its own layer, to trace or ignore. Uses one AI draft.'
      : 'Refine ideas|AI looks at your drawing and suggests what it could use. You pick, or skip.';
    const card = $('nudge');
    card.classList.remove('dealt');
    void card.offsetWidth;
    card.classList.add('dealt');
  }
  function openNudge() {
    closeKit();
    dealNudge();
    $('nudge').hidden = false;
    $('wand').setAttribute('aria-expanded', 'true');
    $('nudge-go').focus({ preventScroll: true });
    buzz();
  }
  function closeNudge() {
    $('nudge').hidden = true;
    $('wand').setAttribute('aria-expanded', 'false');
  }
  $('wand').addEventListener('click', () => ($('nudge').hidden ? openNudge() : closeNudge()));
  $('nudge-close').addEventListener('click', closeNudge);
  $('nudge-again').addEventListener('click', dealNudge);
  $('nudge').addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeNudge(); $('wand').focus(); } });
  document.querySelectorAll('.nudge-time [data-seconds]').forEach(button => button.addEventListener('click', () => {
    flowSeconds = Number(button.dataset.seconds);
    document.querySelectorAll('.nudge-time [data-seconds]').forEach(b => b.setAttribute('aria-checked', String(b === button)));
  }));
  $('nudge-go').addEventListener('click', () => {
    const { prompt, rule, fresh } = nudge;
    closeNudge();
    if (fresh) {
      startersDismissed = true;
      renderStarters();
      if (!$('description').value.trim()) $('description').value = prompt.replace(/^Draw /, '').replace(/\.$/, '');
    }
    if (tool !== 'pen' && tool !== 'eraser' && tool !== 'stamp') setTool('pen');
    setFocus(true);
    const twist = rule.replace('Rule: ', '');
    startFlow(twist ? `${prompt} ${twist.charAt(0).toUpperCase()}${twist.slice(1)}` : prompt);
  });
  $('nudge-ai').addEventListener('click', () => {
    const { prompt, fresh } = nudge;
    closeNudge();
    if (!fresh) { startRefineFlow(); return; }
    setFocus(false);
    $('ai-tools').open = true;
    setAiMode('sketch');
    $('ai-prompt').value = prompt.replace(/^Draw /, '').replace(/\.$/, '');
    $('ai-bar').requestSubmit();
    $('canvas-frame').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // The flow timer: the prompt stays in view with a gentle countdown, then a nudge toward what's next.
  let flow = null; // { end, total, timer }
  const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  function startFlow(text) {
    stopFlow();
    $('flow-text').textContent = text;
    $('flow-banner').hidden = false;
    $('flow-banner').classList.remove('done');
    $('flow-actions').replaceChildren();
    $('flow-clock').hidden = !flowSeconds;
    $('flow-bar').style.transform = 'scaleX(1)';
    if (!flowSeconds) return;
    flow = { end: performance.now() + flowSeconds * 1000, total: flowSeconds * 1000, timer: null };
    const tick = () => {
      const left = Math.max(0, flow.end - performance.now());
      $('flow-clock').textContent = clock(left / 1000);
      $('flow-bar').style.transform = `scaleX(${left / flow.total})`;
      if (left > 0) return;
      clearInterval(flow.timer);
      flow = null;
      $('flow-banner').classList.add('done');
      $('flow-clock').textContent = 'Time! \u2728';
      buzz();
      // What's next, right where the eyes already are (the status line is tucked away in full screen).
      const next = (label, run) => { const b = el('button', 'flow-next', label); b.type = 'button'; b.addEventListener('click', () => { stopFlow(); run(); }); return b; };
      $('flow-actions').replaceChildren(next('\u3030 Make it move', () => setTool('path')), next('\ud83e\ude84 Another', () => openNudge()));
    };
    tick();
    flow.timer = setInterval(tick, 250);
  }
  function stopFlow() {
    if (flow) clearInterval(flow.timer);
    flow = null;
    $('flow-banner').hidden = true;
  }
  $('flow-stop').addEventListener('click', stopFlow);

  // While the pen is down in Focus, the chrome steps back so the page is all there is.
  canvas.addEventListener('pointerdown', () => { if (pointer !== null) document.body.classList.add('inking'); });
  for (const type of ['pointerup', 'pointercancel']) addEventListener(type, () => document.body.classList.remove('inking'));

  // ---------------------------------------------------------------- tools
  function setTool(next) {
    if (next === 'stamp' && !stamp) { openKit(); return; }
    const wasPlacing = tool === 'place';
    const wasTool = tool;
    if (next !== 'place') placing = null;
    tool = next;
    if (next !== 'spark' && next !== 'place' && next !== 'path') drawTool = next;
    canvas.classList.toggle('place-mode', tool === 'place');
    document.querySelectorAll('.tool[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === tool)));
    canvas.classList.toggle('spark-mode', tool === 'spark');
    canvas.classList.toggle('eraser-mode', tool === 'eraser');
    canvas.classList.toggle('move-mode', tool === 'move');
    canvas.classList.toggle('stamp-mode', tool === 'stamp');
    canvas.classList.toggle('path-mode', tool === 'path');
    if (tool === 'path' && next !== wasTool) flashTray(`\u3030 Drag from something you drew: it travels your trail for ${MIN_SHOT} s. One path per layer.`);
    canvas.classList.toggle('ink-mode', tool === 'pen' || tool === 'eraser');
    if (tool !== 'pen' && tool !== 'eraser') { $('brush-cursor').hidden = true; $('canvas-frame').classList.remove('brushing'); }
    if (tool !== 'stamp' && stampHover) { stampHover = null; renderOverlay(); }
    updateHud();
    if (tool !== 'spark') pendingFix = null;
    else if (pendingFix === null) flashTray('Drag a box around the stuck spot, or tap it.');
    else if (wasPlacing && next !== 'place') renderTray();
  }
  document.querySelectorAll('.tool[data-tool]').forEach(button => button.addEventListener('click', () => {
    closePopover();
    if (button.dataset.tool === 'stamp') { toggleKit(); return; }
    setTool(button.dataset.tool === tool && tool === 'spark' ? drawTool : button.dataset.tool);
  }));
  const setWidth = value => {
    $('width').value = String(Math.max(1, Math.min(40, value)));
    $('width-value').value = $('width').value;
    if (tool === 'stamp' && stampHover) renderOverlay(); // the ghost grows and shrinks with the size
  };
  $('width').addEventListener('input', () => setWidth(Number($('width').value)));
  for (const id of ['title', 'description']) $(id).addEventListener('input', () => { revision++; });
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('clear').addEventListener('click', () => clearCanvas());
  function clearCanvas() {
    if (busy() || (!allStrokes().length && layers.length === 1 && frames.length === 1 && !guides.length)) return;
    stopPlay();
    pushUndo();
    layers = [newLayer('Layer 1')];
    frames = [layers];
    frameIndex = 0;
    pendingOrigin = null;
    sceneMotion = null;
    sceneSketch = null;
    rebuildOnion();
    activeId = layers[0].id;
    guides.length = 0;
    sparks.length = 0;
    closePopover();
    recount();
    rebuildAll();
    renderOverlay();
    renderTray();
    message('drawing-status', 'A fresh canvas. Undo brings your layers back.');
  }
  $('guides-toggle').addEventListener('click', () => { guidesVisible = !guidesVisible; composite(); });
  $('guides-clear').addEventListener('click', () => { guides.length = 0; composite(); });
  $('download').addEventListener('click', () => {
    const exported = document.createElement('canvas');
    exported.width = W;
    exported.height = H;
    paintArtwork(exported.getContext('2d'), false);
    exported.toBlob(blob => {
      if (!blob) {
        message('drawing-status', 'PNG export failed. Please try again.', true);
        return;
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${($('title').value.trim() || 'inkling').replace(/[^\w-]+/g, '-').toLowerCase()}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }, 'image/png');
  });
  window.addEventListener('beforeunload', event => {
    if (revision !== savedRevision && revision !== draftRevision) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  async function failed(response, path) {
    // A session that ends mid-flow (expired, signed out elsewhere) brings back the sign-in, not a dead end.
    if (response.status === 401 && !path.startsWith('/api/session') && !path.startsWith('/api/auth/')) showGate('Your session ended. Sign in again to keep going; your drawing is still here.');
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : null;
    const detail = typeof body?.detail === 'string' ? body.detail
      : Array.isArray(body?.detail) && body.detail[0]?.msg ? `${body.detail[0].msg.replace(/^Value error, /, '')}` : null;
    return new Error(detail || `Request failed (${response.status}). Check the API and try again.`);
  }
  const PROBES = new Set(['/api/ready', '/api/session', '/api/auth/config']);
  const OFFLINE_NOTE = 'You\u2019re offline. This needs a connection; your pencil doesn\u2019t.';
  async function reach(path, options) {
    if (offline && !PROBES.has(path)) throw Object.assign(new Error(OFFLINE_NOTE), { network: true });
    try {
      return await fetch(path, options);
    } catch {
      throw Object.assign(new Error('Can\u2019t reach Inkling right now. Your drawing is safe on this device.'), { network: true });
    }
  }
  async function api(path, options = {}) {
    const response = await reach(path, options);
    if (!response.ok) throw await failed(response, path);
    return response.status === 204 ? null : response.json();
  }
  const postJSON = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

  // Speech is handled by the browser's speech service; the transcript is editable and never submitted automatically.
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let listening = null;
  if (SpeechRecognition && window.isSecureContext) {
    document.querySelectorAll('[data-voice-for]').forEach(button => {
      const input = $(button.dataset.voiceFor);
      const form = input.closest('form');
      const status = document.createElement('p');
      status.className = 'voice-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.hidden = true;
      if (form.id === 'spark-popover') form.append(status);
      else form.insertAdjacentElement('afterend', status);
      button.hidden = false;
      button.setAttribute('aria-pressed', 'false');
      button.title = 'Voice uses your browser’s speech service; speech may be sent to its provider.';
      button.addEventListener('click', () => {
        if (listening?.button === button) { listening.recognition.stop(); return; }
        if (listening) return;
        const recognition = new SpeechRecognition();
        recognition.lang = document.documentElement.lang || navigator.language;
        recognition.continuous = false;
        recognition.interimResults = false;
        let failed = false;
        let heard = false;
        listening = { recognition, button, input };
        document.querySelectorAll('[data-voice-for]').forEach(other => { if (other !== button) other.disabled = true; });
        button.setAttribute('aria-pressed', 'true');
        button.setAttribute('aria-label', 'Stop listening');
        status.hidden = false;
        status.classList.remove('error');
        status.textContent = 'Listening… Your browser may send audio to its speech service. Tap again to stop.';
        recognition.onresult = event => {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (!event.results[i].isFinal || !input.getClientRects().length) continue;
            const text = event.results[i][0].transcript.trim();
            if (!text) continue;
            const separator = input.value && !/\s$/.test(input.value) ? ' ' : '';
            const next = `${input.value}${separator}${text}`;
            input.value = next.slice(0, input.maxLength > 0 ? input.maxLength : undefined);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            heard = true;
            status.textContent = next.length > input.value.length ? 'Text reached the field limit. Review it before submitting.' : 'Added your words. Review them before submitting.';
          }
        };
        recognition.onerror = event => {
          failed = true;
          status.classList.add('error');
          status.textContent = ({ 'not-allowed': 'Microphone permission was denied. Allow it in your browser or type instead.',
            'service-not-allowed': 'Voice input is blocked by your browser. Type instead.',
            'audio-capture': 'No microphone found. Check your device or type instead.',
            'no-speech': 'No speech heard. Try again or type instead.',
            'network': 'The browser speech service is unavailable. Try again or type instead.',
            'aborted': 'Voice input stopped.' })[event.error] || `Voice input failed (${event.error}). Try again or type instead.`;
        };
        recognition.onend = () => {
          listening = null;
          button.setAttribute('aria-pressed', 'false');
          button.setAttribute('aria-label', button.dataset.voiceLabel);
          document.querySelectorAll('[data-voice-for]').forEach(other => { other.disabled = false; });
          if (!failed && !heard) status.textContent = 'No words added. Try again or type instead.';
        };
        try { recognition.start(); } catch (error) {
          failed = true;
          status.classList.add('error');
          status.textContent = `Could not start voice input: ${error.message}`;
          recognition.onend();
        }
      });
      button.dataset.voiceLabel = button.getAttribute('aria-label');
      form.closest('dialog')?.addEventListener('close', () => { if (listening?.input === input) listening.recognition.abort(); });
    });
    $('ai-tools').addEventListener('toggle', () => {
      if (!$('ai-tools').open && listening?.input === $('ai-prompt')) listening.recognition.abort();
    });
  }

  // ---------------------------------------------------------------- sparks
  function openPopover(region) {
    pendingRegion = region;
    const popover = $('spark-popover');
    popover.hidden = false;
    const frame = $('canvas-frame').getBoundingClientRect();
    const pop = popover.getBoundingClientRect();
    let top = (region.y + region.h) * frame.height + 8;
    if (top + pop.height > frame.height - 8) top = region.y * frame.height - pop.height - 8;
    popover.style.top = `${Math.max(8, top)}px`;
    popover.style.left = `${Math.max(8, Math.min(frame.width - pop.width - 8, region.x * frame.width))}px`;
    renderOverlay();
    $('spark-prompt').focus({ preventScroll: true });
  }
  function closePopover() {
    if ($('spark-popover').hidden) return;
    if (listening?.input === $('spark-prompt')) listening.recognition.abort();
    if ($('spark-popover').contains(document.activeElement)) document.activeElement.blur();
    $('spark-popover').hidden = true;
    $('spark-prompt').value = '';
    pendingRegion = null;
    renderOverlay();
  }
  function fireSpark(kind) {
    const region = pendingRegion;
    const prompt = $('spark-prompt').value.trim();
    closePopover();
    setTool(drawTool);
    if (region) startSpark(kind, region, prompt);
  }
  $('spark-popover').addEventListener('submit', event => { event.preventDefault(); fireSpark('strokes'); });
  $('spark-guide').addEventListener('click', () => fireSpark('guide'));
  $('spark-cancel').addEventListener('click', closePopover);
  $('spark-prompt').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closePopover(); }
    if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); fireSpark('guide'); }
  });

  // ---------------------------------------------------------------- Ask AI: previewed drawing tools
  // Every mode previews first and changes nothing until the artist says so; every step lands in the audit trail.
  const AI_MODES = {
    refine: {
      placeholder: 'What should change? e.g. give it a curious smile', go: 'Refine it',
      hint: 'AI edits your strokes on one layer: it keeps all it can and adds only what this needs. You see it first.',
      examples: []
    },
    sketch: {
      placeholder: 'Describe a starting point', go: 'Sketch it',
      hint: 'A faint blue-pencil layer under your ink: plain strokes you can erase, redraw, or hide.',
      examples: ['a hero standing, front view', 'a dragon curled up asleep', 'a rocket on a launch pad', 'a cozy house on a hill']
    },
    fix: {
      placeholder: "What's wrong? e.g. make the eye look left", go: 'Pick the spot',
      hint: 'Then drag a box around the spot, or tap it. AI proposes a few strokes in your ink; you accept or skip.',
      examples: ['fix the hand', 'make the eye look left', 'add a shadow under it', 'clean up this line']
    },
    vary: {
      placeholder: 'What are they for? e.g. a battle', go: 'Plan them',
      hint: 'AI writes a plan you can edit, then edits your strokes for each one. Every variation stays linked to the original.',
      examples: ['a battle: different weapons and poses', 'a crowd: different builds and outfits', 'expressions: happy, angry, scared', 'wear and tear: new, dented, wrecked']
    }
  };
  let aiMode = 'sketch';
  let refineIdeas = { revision: -1, items: [], loading: false, error: '' }; // Gemini's suggestions for this drawing
  let pendingFix = null; // a "Fix a spot" prompt waiting for the artist to pick the spot
  let pendingVary = null; // a variations goal waiting for the asset to be saved first
  function setAiMode(mode) {
    aiMode = mode;
    const text = AI_MODES[mode];
    document.querySelectorAll('.ai-modes [data-mode]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    $('ai-prompt').placeholder = text.placeholder;
    $('ai-go').setAttribute('aria-label', text.go);
    $('ai-hint').textContent = text.hint;
    renderAiExamples();
    $('ai-bar').dataset.mode = mode;
  }
  function renderAiExamples() {
    const chip = example => {
      const button = el('button', 'example', example);
      button.type = 'button';
      button.addEventListener('click', () => { $('ai-prompt').value = example; askAI(); });
      return button;
    };
    if (aiMode !== 'refine') {
      $('ai-examples').replaceChildren(...AI_MODES[aiMode].examples.map(chip));
      return;
    }
    if (refineIdeas.loading) {
      $('ai-examples').replaceChildren(el('span', 'example pending', '\u2726 Gemini is looking at your drawing\u2026'));
    } else if (refineIdeas.items.length) {
      $('ai-examples').replaceChildren(...refineIdeas.items.map(chip));
    } else {
      const ask = el('button', 'example', refineIdeas.error ? '\u21bb Suggest again' : '\u2726 Suggest what it needs');
      ask.type = 'button';
      ask.addEventListener('click', () => suggestRefinements(true));
      $('ai-examples').replaceChildren(ask, ...(refineIdeas.error ? [el('span', 'example-note', refineIdeas.error)] : []));
    }
  }
  function currentAsset() {
    if (editing?.kind !== 'asset') return null;
    return { id: editing.id, version: editing.version, name: $('title').value.trim(), type: $('asset-type').value, tags,
      image_url: `/api/assets/${encodeURIComponent(editing.id)}/image?v=${editing.version}` };
  }
  function askAI() {
    const prompt = $('ai-prompt').value.trim().replace(/\s+/g, ' ');
    if (aiMode === 'refine') {
      if (!hasInk()) { flashTray('Draw something first, then refine it with AI.', true); return; }
      if (prompt.length < 3) { $('ai-prompt').focus(); flashTray('Say what should change, or tap a suggestion.', true); return; }
      $('ai-prompt').value = '';
      startSpark('refine', null, prompt.slice(0, 200));
      canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (aiMode === 'sketch') {
      if (prompt.length < 3) { $('ai-prompt').focus(); flashTray('Describe what to sketch, e.g. "a fox under a tree".', true); return; }
      $('ai-prompt').value = '';
      startSketch(prompt.slice(0, 200));
    } else if (aiMode === 'fix') {
      if (!hasInk()) { flashTray('Draw something first, then ask AI to fix a spot.', true); return; }
      pendingFix = prompt.slice(0, 300);
      $('ai-prompt').value = '';
      closePopover();
      setTool('spark');
      canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flashTray(`Now drag around the spot${pendingFix ? ` for "${pendingFix}"` : ''}, or tap it.`);
    } else {
      if (prompt.length < 3) { $('ai-prompt').focus(); flashTray('Say what the variations are for, e.g. "a battle".', true); return; }
      const asset = currentAsset();
      if (asset && revision === savedRevision) {
        $('ai-prompt').value = '';
        openVariations(asset, prompt);
      } else if (!hasInk(frames[0])) {
        flashTray('Draw an asset first (or Sketch a layer), then grow variations from it.', true);
      } else {
        // Lineage is only bulletproof if the original is saved: variations link to an exact asset version.
        pendingVary = prompt;
        setFocus(false);
        if (saveKind !== 'asset') setSaveKind('asset');
        message('drawing-status', asset ? 'Save your changes first: variations link to an exact version.'
          : 'Variations stay linked to their original, so save this as an asset first.', false, [
          { label: '\u25c6 Save & grow variations', run: () => $('save-form').requestSubmit() }]);
        $('save-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (!$('title').value.trim()) $('title').focus({ preventScroll: true });
      }
    }
  }
  document.querySelectorAll('.ai-modes [data-mode]').forEach(b => b.addEventListener('click', () => {
    setAiMode(b.dataset.mode);
    $('ai-prompt').focus();
    if (b.dataset.mode === 'refine') suggestRefinements();
  }));
  $('ai-bar').addEventListener('submit', event => { event.preventDefault(); askAI(); });
  // One tap, no prompt: rough lines in, cleaner lines back as a draft. Drawing never stops while it works.
  const QUICK_REFINE = 'Clean up rough lines into smoother, more confident strokes. Keep every detail (eyes, face, markings, fills), my pose, proportions, style, and colors.';
  $('refine-now').addEventListener('click', () => {
    $('refine-now').blur(); // so Enter keeps the result instead of pressing this again
    $('refine-pick').hidden ? openRefinePick() : closeRefinePick();
  });
  // Refine: you pick what (your drawing, an asset in the shot, the backdrop) and, if you like, say how.
  let refinePicked = null;
  const refineKind = layer => layer.backdrop || (!layer.asset && isScenery(layer)) ? 'backdrop' : layer.asset ? 'asset' : 'drawing';
  function refineThumb(layer) {
    const thumb = document.createElement('canvas');
    thumb.width = 144;
    thumb.height = 96;
    const t = thumb.getContext('2d');
    t.fillStyle = '#ffffff';
    t.fillRect(0, 0, 144, 96);
    const b = inkBounds(layer.strokes.filter(stroke => !stroke.erase)) || { x: 0, y: 0, w: W, h: H };
    const sheet = layerCanvas(layer.id), k = sheet.width / W, pad = 8;
    const fit = Math.min((144 - pad * 2) / b.w, (96 - pad * 2) / b.h);
    const w = b.w * fit, h = b.h * fit;
    t.drawImage(sheet, b.x * k, b.y * k, b.w * k, b.h * k, (144 - w) / 2, (96 - h) / 2, w, h);
    return thumb;
  }
  function openRefinePick() {
    if (offline) { flashTray(OFFLINE_NOTE, true); return; }
    if (sparks.some(spark => spark.kind === 'refine' && spark.status === 'pending')) { flashTray('\u2726 Already refining. Keep drawing.'); return; }
    const choices = [...layers].reverse().filter(layer => layer.visible && layer.strokes.some(stroke => !stroke.erase));
    if (!choices.length) { flashTray('Draw something rough first, then \u2726 Refine cleans it up.', true); return; }
    const first = refineTarget() || choices[0];
    refinePicked = first.id;
    const label = { drawing: ['\u270f\ufe0f', 'your drawing'], asset: ['\u25c6', saveKind === 'shot' ? 'asset in this shot \u00b7 its copy here; the asset stays as it is' : 'placed asset'], backdrop: ['\u25a3', 'backdrop \u00b7 every frame gets it'] };
    $('refine-options').replaceChildren(...choices.map(layer => {
      const [icon, what] = label[refineKind(layer)];
      const option = el('button', 'refine-option');
      option.type = 'button';
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', String(layer.id === refinePicked));
      const words = el('span');
      words.append(el('b', '', `${icon} ${layer.name}`), el('small', '', what));
      option.append(refineThumb(layer), words);
      option.addEventListener('click', () => {
        refinePicked = layer.id;
        for (const other of $('refine-options').children) other.setAttribute('aria-checked', String(other === option));
        $('refine-how').focus();
      });
      option.addEventListener('dblclick', () => $('refine-pick').requestSubmit());
      return option;
    }));
    $('refine-how').value = '';
    $('refine-pick').hidden = false;
    $('refine-now').setAttribute('aria-expanded', 'true');
    $('refine-how').focus({ preventScroll: true });
  }
  function closeRefinePick() {
    $('refine-pick').hidden = true;
    $('refine-now').setAttribute('aria-expanded', 'false');
  }
  $('refine-cancel').addEventListener('click', closeRefinePick);
  $('refine-pick').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRefinePick(); } });
  $('refine-pick').addEventListener('submit', event => {
    event.preventDefault();
    const how = $('refine-how').value.trim().replace(/\s+/g, ' ').slice(0, 120);
    closeRefinePick();
    if (motionDraft) skipMotion(); // refine the drawing first; the take comes back once you keep the refinement
    // In a moving shot, refine frame 1: every other frame is posed from it, so they all follow.
    const pickedAt = layers.findIndex(item => item.id === refinePicked);
    if (frames.length > 1 && frameIndex !== 0 && pickedAt >= 0) showFrame(0);
    const layer = [layers[pickedAt]].find(item => item && item.visible && item.strokes.some(stroke => !stroke.erase));
    if (!layer) { flashTray('That layer is gone or empty. Open \u2726 Refine again.', true); return; }
    activeId = layer.id;
    renderLayersPanel();
    flashTray(`\u2726 Refining ${refinedLabel(layer)}${how ? `: \u201c${how}\u201d` : ''}\u2026 keep drawing.`);
    startSpark('refine', null, how.length >= 3 ? `${how}. Keep everything else exactly as drawn: details, pose, proportions, style, colors.` : QUICK_REFINE,
      how.length >= 3 ? how : 'clean up the lines');
  });

  // ---------------------------------------------------------------- Focus mode: the whole screen is paper
  function fitFocus() {
    const frame = $('canvas-frame');
    if (!document.body.classList.contains('focus-mode')) { frame.style.width = ''; return; }
    const body = document.querySelector('.canvas-body');
    const side = getComputedStyle($('layers-panel')).display !== 'none' && innerWidth >= 1024 ? $('layers-panel').offsetWidth : 0;
    const width = Math.max(120, Math.min(body.clientWidth - side - 20, (body.clientHeight - 20) * W / H));
    frame.style.width = `${Math.floor(width)}px`;
  }
  function setFocus(on) {
    if (document.body.classList.contains('focus-mode') === on) return;
    document.body.classList.toggle('focus-mode', on);
    $('focus-toggle').setAttribute('aria-pressed', String(on));
    $('focus-toggle').querySelector('span').textContent = on ? 'Done' : 'Focus';
    if (on) setLayersOpen(false);
    // Real full screen where the device allows it (it hides the browser's own bars); phones turn sideways.
    if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen({ navigationUI: 'hide' })
        .then(() => matchMedia('(pointer: coarse)').matches && screen.orientation?.lock?.('landscape'))
        .catch(() => { /* not allowed here: the in-page full screen still works */ });
    } else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    requestAnimationFrame(fitFocus);
  }
  document.addEventListener('fullscreenchange', () => requestAnimationFrame(fitFocus));
  $('focus-toggle').addEventListener('click', () => setFocus(!document.body.classList.contains('focus-mode')));
  addEventListener('resize', () => requestAnimationFrame(fitFocus));

  // ---------------------------------------------------------------- ink swatches (big, finger-friendly)
  function setInk(color) {
    $('ink').value = color;
    document.querySelectorAll('#swatches .ink-dot').forEach(dot => dot.setAttribute('aria-pressed', String(dot.dataset.color === color)));
    // Kit stamps wear the ink color, so their icon does too.
    drawStampIcon($('stamp-icon'), stamp || kitStamp(KIT[0]));
    if (tool === 'stamp' && stampHover) renderOverlay();
  }
  document.querySelectorAll('#swatches .ink-dot').forEach(dot => dot.addEventListener('click', () => {
    setInk(dot.dataset.color);
    if (tool !== 'pen' && tool !== 'stamp' && SHAPES.has(tool) === false) setTool('pen');
  }));
  $('ink').addEventListener('input', () => setInk($('ink').value));

  // ---------------------------------------------------------------- layers drawer (mobile); always open on wide screens
  function setLayersOpen(open) {
    $('layers-panel').classList.toggle('open', open);
    $('layers-toggle').setAttribute('aria-expanded', String(open));
  }
  $('layers-toggle').addEventListener('click', () => setLayersOpen(!$('layers-panel').classList.contains('open')));

  const activeSpark = () => sparks.find(spark => spark.status === 'ready');
  const pendingCount = () => sparks.filter(spark => spark.status === 'pending').length;

  async function startSpark(kind, region, prompt, label = prompt) {
    if (pendingCount() >= MAX_PENDING_SPARKS) {
      flashTray('Three AI requests are already running. Keep drawing; they\'ll land soon.', true);
      return;
    }
    const title = $('title').value.trim().slice(0, 120);
    const target = kind === 'refine' ? refineTarget() : null;
    if (kind === 'refine' && !target) {
      flashTray('Nothing to refine yet: draw something, or select a layer with ink.', true);
      return;
    }
    const body = JSON.stringify(kind === 'sketch' ? { prompt, title, layers: docLayers() }
      : kind === 'refine' ? { prompt, title, target: layers.indexOf(target), layers: docLayers() }
      : { region, prompt, title, layers: docLayers() });
    if (new Blob([body]).size > 2 * 1024 * 1024) {
      flashTray('This drawing is too big to send to AI (2 MiB limit).', true);
      return;
    }
    const spark = { kind, region, prompt, label, status: 'pending', layerId: target?.id, source: target?.strokes.slice() };
    sparks.push(spark);
    clearTimeout(trayTimer);
    trayTimer = null;
    animate();
    renderTray();
    try {
      const result = await postJSON(`/api/sparks/${kind}`, body);
      if (kind === 'guide') {
        spark.img = new Image();
        spark.img.src = result.image;
        await spark.img.decode();
      }
      if (!sparks.includes(spark)) return; // canvas cleared or replaced meanwhile
      spark.result = result;
      spark.status = 'ready';
      spark.readyAt = performance.now();
    } catch (error) {
      const index = sparks.indexOf(spark);
      if (index === -1) return;
      sparks.splice(index, 1);
      flashTray(`AI couldn't do that: ${error.message}`, true);
    }
    animate();
    renderTray();
  }
  function startSketch(prompt) {
    startSpark('sketch', null, prompt);
    canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // The AI sketch lands as its own faint layer *under* the artist's ink: scaffolding to draw over.
  function addSketchLayer(spark) {
    const strokes = spark.result.strokes.map(stroke => ({ ...stroke, seq: nextSeq() }));
    if (layers.length >= MAX_LAYERS || allStrokes().length + strokes.length > MAX_STROKES || pointCount + countPoints(strokes) > MAX_POINTS) {
      flashTray('No room for another layer. Delete or merge one first.', true);
      return false;
    }
    pushUndo();
    const layer = newLayer(`\u2726 ${spark.prompt}`.slice(0, 40), { strokes, opacity: 0.6 });
    const below = layers.indexOf(activeLayer());
    layers.splice(Math.max(0, below), 0, layer);
    recount();
    rebuildAll();
    message('drawing-status', `Added a blue-pencil sketch under "${activeLayer().name}". Draw over it, then hide or delete it.`, false, [
      { label: 'Hide the sketch', run: () => { pushUndo(); layer.visible = false; rebuildAll(); message('drawing-status', 'Sketch hidden. Show it again from Layers.'); } }
    ]);
    return true;
  }

  // The layer refine works on: the one you've selected (your ink, a placed asset, or the backdrop), else the
  // topmost thing with ink: your drawing first, then a placed asset, then the backdrop.
  function refineTarget() {
    const inked = layer => layer.visible && layer.strokes.some(stroke => !stroke.erase);
    const active = activeLayer();
    if (active && inked(active)) return active;
    const top = [...layers].reverse().filter(inked);
    return top.find(layer => !layer.asset && !isScenery(layer)) || top.find(layer => layer.asset) || top[0] || null;
  }
  const refinedLabel = layer => layer.backdrop ? `the backdrop \u201c${layer.name}\u201d` : `\u201c${layer.name}\u201d`;
  // ---------------------------------------------------------------- refine = AI picks the edits, code applies them
  // AI never redraws a stroke you drew. It returns a plan ("S3 is a circle", "smooth S1, S5", "S7, S8 bigger"), and
  // this exact geometry runs it, on frame 1 and on every frame of a shot. Mirrors REFINE_OPS in backend/ai.py.
  const toPx = points => points.map(p => [p.x * W, p.y * H, p.pressure ?? 0.5]);
  const fromPx = list => list.map(([x, y, pr]) => ({ x: r4(clampTo(x / W, 0, 1)), y: r4(clampTo(y / H, 0, 1)), pressure: Math.round(clampTo(pr, 0.05, 1) * 1000) / 1000 }));
  const pathLength = pts => pts.reduce((sum, p, i) => sum + (i ? Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
  const looksClosed = pts => pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < Math.max(6, pathLength(pts) * 0.12);
  const meanPressure = pts => pts.reduce((sum, p) => sum + p[2], 0) / Math.max(1, pts.length);
  function resample(pts, step) {
    if (pts.length < 2) return pts.slice();
    const out = [pts[0]];
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let t = step - carry;
      while (t <= d) {
        const f = t / d;
        out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
        t += step;
      }
      carry = d - (t - step);
    }
    if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
    return out;
  }
  const centroid = pts => pts.reduce((c, p) => [c[0] + p[0] / pts.length, c[1] + p[1] / pts.length], [0, 0]);
  const turning = pts => Math.sign(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) || 1;
  const REFINE_SHAPES = {
    smooth(pts) {
      if (pts.length < 3) return pts;
      const closed = looksClosed(pts), even = resample(pts, 4), n = even.length;
      const k = clampTo(Math.round(pathLength(pts) / 90), 1, 5); // a wider window steadies a longer line
      let out = even.map((p, i) => {
        const reach = closed ? k : Math.min(k, i, n - 1 - i); // open ends stay exactly where you put them
        let x = 0, y = 0, c = 0;
        for (let j = -reach; j <= reach; j++) { const q = even[((i + j) % n + n) % n]; x += q[0]; y += q[1]; c++; }
        return [x / c, y / c, p[2]];
      });
      for (let round = 0; round < 2; round++) { // Chaikin: corners become curves
        const next = closed ? [] : [out[0]];
        for (let i = 0; i < out.length - (closed ? 0 : 1); i++) {
          const a = out[i], b = out[(i + 1) % out.length];
          next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25, a[2]], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75, b[2]]);
        }
        if (closed) next.push(next[0]); else next.push(out[out.length - 1]);
        out = next;
      }
      return simplifyChain(out, 0.6);
    },
    line(pts) {
      const c = centroid(pts);
      let sxx = 0, sxy = 0, syy = 0;
      for (const [x, y] of pts) { sxx += (x - c[0]) ** 2; sxy += (x - c[0]) * (y - c[1]); syy += (y - c[1]) ** 2; }
      const a = 0.5 * Math.atan2(2 * sxy, sxx - syy), dir = [Math.cos(a), Math.sin(a)], pr = meanPressure(pts);
      const onLine = p => { const t = (p[0] - c[0]) * dir[0] + (p[1] - c[1]) * dir[1]; return [c[0] + dir[0] * t, c[1] + dir[1] * t]; };
      const [p0, p1] = [onLine(pts[0]), onLine(pts[pts.length - 1])];
      return Array.from({ length: 8 }, (_, i) => [p0[0] + (p1[0] - p0[0]) * i / 7, p0[1] + (p1[1] - p0[1]) * i / 7, pr]);
    },
    curve(pts) {
      const even = resample(pts, 3), p0 = pts[0], p2 = pts[pts.length - 1], pr = meanPressure(pts);
      const dx = p2[0] - p0[0], dy = p2[1] - p0[1], len = Math.hypot(dx, dy) || 1;
      let apex = even[0], far = -1;
      for (const p of even) { const d = Math.abs(dy * p[0] - dx * p[1] + p2[0] * p0[1] - p2[1] * p0[0]) / len; if (d > far) { far = d; apex = p; } }
      const ctrl = [2 * apex[0] - (p0[0] + p2[0]) / 2, 2 * apex[1] - (p0[1] + p2[1]) / 2];
      return Array.from({ length: 25 }, (_, i) => { const t = i / 24, u = 1 - t; return [u * u * p0[0] + 2 * u * t * ctrl[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * ctrl[1] + t * t * p2[1], pr]; });
    },
    circle(pts) {
      const even = resample(pts, 3), c = centroid(even), pr = meanPressure(pts);
      const r = even.reduce((sum, p) => sum + Math.hypot(p[0] - c[0], p[1] - c[1]), 0) / even.length;
      const start = Math.atan2(pts[0][1] - c[1], pts[0][0] - c[0]), way = turning(even);
      return Array.from({ length: 65 }, (_, i) => { const a = start + way * i / 64 * Math.PI * 2; return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, pr]; });
    },
    ellipse(pts) {
      const even = resample(pts, 3), c0 = centroid(even), pr = meanPressure(pts);
      let sxx = 0, sxy = 0, syy = 0;
      for (const [x, y] of even) { sxx += (x - c0[0]) ** 2; sxy += (x - c0[0]) * (y - c0[1]); syy += (y - c0[1]) ** 2; }
      const a = 0.5 * Math.atan2(2 * sxy, sxx - syy), u = [Math.cos(a), Math.sin(a)], v = [-u[1], u[0]];
      const along = even.map(p => (p[0] - c0[0]) * u[0] + (p[1] - c0[1]) * u[1]), across = even.map(p => (p[0] - c0[0]) * v[0] + (p[1] - c0[1]) * v[1]);
      const [lo, hi, lo2, hi2] = [Math.min(...along), Math.max(...along), Math.min(...across), Math.max(...across)];
      const rx = (hi - lo) / 2, ry = (hi2 - lo2) / 2, mu = (hi + lo) / 2, mv = (hi2 + lo2) / 2;
      const c = [c0[0] + u[0] * mu + v[0] * mv, c0[1] + u[1] * mu + v[1] * mv];
      const p = [(pts[0][0] - c[0]) * u[0] + (pts[0][1] - c[1]) * u[1], (pts[0][0] - c[0]) * v[0] + (pts[0][1] - c[1]) * v[1]];
      const start = Math.atan2(p[1] / (ry || 1), p[0] / (rx || 1)), way = turning(even);
      return Array.from({ length: 65 }, (_, i) => {
        const t = start + way * i / 64 * Math.PI * 2, x = Math.cos(t) * rx, y = Math.sin(t) * ry;
        return [c[0] + u[0] * x + v[0] * y, c[1] + u[1] * x + v[1] * y, pr];
      });
    },
    close(pts) {
      if (pts.length < 3) return pts;
      const first = pts[0], last = pts[pts.length - 1];
      return Math.hypot(first[0] - last[0], first[1] - last[1]) < 1 ? pts : [...pts, [first[0], first[1], last[2]]];
    }
  };
  // Run a plan on strokes (any frame's). Returns the new strokes, in the same order (so a rig still fits), and
  // where each old stroke went (-1: removed).
  function applyEdits(strokes, edits) {
    const out = strokes.slice(), gone = new Set();
    for (const edit of edits || []) {
      const at = edit.strokes.filter(i => out[i] && !out[i].erase && !gone.has(i));
      if (!at.length) continue;
      if (edit.op === 'delete') { at.forEach(i => gone.add(i)); continue; }
      if (edit.op === 'transform') {
        const all = at.flatMap(i => toPx(out[i].points));
        const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const k = edit.scale || 1, a = (edit.rotate || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
        for (const i of at) {
          const moved = toPx(out[i].points).map(([x, y, pr]) => { const dx = (x - cx) * k, dy = (y - cy) * k; return [cx + dx * cos - dy * sin + (edit.dx || 0), cy + dx * sin + dy * cos + (edit.dy || 0), pr]; });
          out[i] = { ...out[i], points: fromPx(moved), width: clampTo(Math.round(out[i].width * Math.sqrt(k) * 10) / 10, 1, 40), ai: true };
        }
        continue;
      }
      const shape = REFINE_SHAPES[edit.op];
      if (!shape) continue;
      for (const i of at) out[i] = { ...out[i], points: fromPx(shape(toPx(out[i].points))), ai: true };
    }
    let n = 0;
    const map = out.map((_, i) => (gone.has(i) ? -1 : n++));
    return { strokes: out.filter((_, i) => !gone.has(i)), map };
  }
  // A refinement's result, for the preview and for keeping it: the plan run on the strokes it was made from, plus
  // anything new it adds, plus whatever you drew while it worked.
  function refinedStrokes(spark, layer) {
    spark.applied ||= applyEdits(spark.source, spark.result.edits);
    const next = [...spark.applied.strokes, ...(spark.result.add || [])];
    const changed = next.filter(stroke => !spark.source.includes(stroke));
    const since = layer.strokes.filter(stroke => !spark.source.includes(stroke));
    return { next, changed, since, map: spark.applied.map };
  }
  // What a plan does, in plain words: "rounded 1 · smoothed 3 · bigger 2 · removed 1 · added 2".
  function editSummary(result) {
    const words = { smooth: 'smoothed', line: 'straightened', curve: 'curved', circle: 'rounded', ellipse: 'made oval', close: 'closed', delete: 'removed' };
    const count = {};
    for (const edit of result.edits || []) {
      const word = edit.op === 'transform' ? (edit.scale > 1.01 ? 'made bigger' : edit.scale < 0.99 ? 'made smaller' : edit.rotate ? 'turned' : 'moved') : words[edit.op];
      if (word) count[word] = (count[word] || 0) + edit.strokes.length;
    }
    if (result.add?.length) count.added = result.add.length;
    return Object.entries(count).map(([word, n]) => `${word} ${n}`).join(' \u00b7 ') || 'no changes';
  }
  function acceptRefine(spark) {
    const layer = layers.find(l => l.id === spark.layerId);
    if (!layer) { flashTray('That layer is gone. Try the refinement again.', true); return false; }
    const { next: plan, since, map } = refinedStrokes(spark, layer);
    const next = [...plan.map(stroke => (spark.result.add?.includes(stroke) ? { ...stroke, seq: nextSeq() } : stroke)), ...since];
    const others = allStrokes().filter(stroke => !layer.strokes.includes(stroke));
    if (others.length + next.length > MAX_STROKES || countPoints(others) + countPoints(next) > MAX_POINTS) {
      flashTray('That would exceed the canvas limits. Undo a few strokes first.', true);
      return false;
    }
    pushUndo();
    const index = layers.indexOf(layer), old = spark.source;
    layer.strokes = next;
    if (map.includes(-1)) layer.rigOff = true; // strokes were removed: the rig's stroke numbers no longer line up
    // Every frame gets the same edits: a posed frame is re-posed from the refined frame 1 (same numbers, same
    // bends); a frame that shares the strokes shares the result; a hand-drawn frame runs the plan on its own lines.
    let reached = 0;
    for (const stack of frames) {
      const twin = stack[index];
      if (stack === layers || !twin || twin.name !== layer.name) continue;
      if (twin.xf && sameStrokes(twin.xfBase, old)) {
        const bend = (twin.bend || []).map(b => ({ ...b, s: b.s.map(i => map[i] ?? -1).filter(i => i >= 0) })).filter(b => b.s.length);
        const strokes = poseXf(bendStrokes(next, bend), twin.xf);
        Object.assign(twin, { strokes, bend: bend.length ? bend : undefined, xfBase: next, xfStrokes: strokes.slice(), rigOff: layer.rigOff });
      } else if (sameStrokes(twin.strokes, old)) {
        twin.strokes = next;
      } else if (twin.strokes.length === old.length) {
        twin.strokes = applyEdits(twin.strokes, spark.result.edits).strokes;
      } else continue;
      reached++;
    }
    recount();
    rebuildOnion();
    rebuildAll();
    renderLayersPanel();
    const r = spark.result, what = editSummary(r);
    const where = reached ? ` in all ${reached + 1} frames` : '';
    logEvent('ai', 'Refine', `"${spark.label}" on "${layer.name}": ${what}${where} (${r.note})`);
    if (layer.asset && saveKind === 'shot' && frames.length === 1) { // it moves again, refined
      autoTake(layer, 0, `\u2726 Refined ${refinedLabel(layer)} (${what}); the asset itself is unchanged. `);
      if (motionDraft) return true;
    }
    message('drawing-status', `\u2726 Refined ${refinedLabel(layer)}${where}: ${what}.${layer.asset ? ' The asset itself is unchanged.' : ''}`, false, [
      { label: '\u21b6 Undo', tip: 'Undo \u00b7 Cmd/Ctrl+Z|Your layer exactly as it was.', run: () => { undo(); message('drawing-status', 'Undone. Your layer is back as it was.'); } },
      { label: '\u2726 Refine more', run: () => startRefineFlow() }]);
    return true;
  }

  function acceptSpark() {
    const spark = activeSpark();
    if (!spark) return;
    if (spark.kind === 'refine') {
      if (!acceptRefine(spark)) return;
    } else if (spark.kind === 'sketch') {
      if (!addSketchLayer(spark)) return;
      logEvent('ai', 'AI sketch', `"${spark.prompt}": ${plural(spark.result.strokes.length, 'blue-pencil stroke')} as their own layer`);
      undoable('\u2726 Sketch added as its own faint layer. Trace it, hide it, or undo.');
    } else if (spark.kind === 'strokes') {
      if (!commitStrokes(spark.result.strokes)) {
        flashTray(`Can't add to "${activeLayer().name}" right now. See the note under the canvas.`, true);
        return;
      }
      logEvent('ai', 'Fix a spot', `${spark.prompt ? `"${spark.prompt}"` : 'no prompt'}: ${plural(spark.result.strokes.length, 'stroke')} on "${activeLayer().name}" (${spark.result.note})`);
      undoable(`\u2726 Added ${plural(spark.result.strokes.length, 'line')} to "${activeLayer().name}". Marked as AI.`);
    } else {
      guides.push({ region: spark.region, img: spark.img });
      guidesVisible = true;
      composite();
      logEvent('ai', 'Trace guide', `${spark.prompt ? `"${spark.prompt}"` : 'no prompt'} (a reference only; never saved)`);
    }
    sparks.splice(sparks.indexOf(spark), 1);
    renderOverlay();
    renderTray();
  }
  function dismissSpark() {
    const spark = activeSpark();
    if (!spark) return;
    const what = { sketch: 'AI sketch', strokes: 'AI fix', guide: 'trace guide', refine: 'AI refine' }[spark.kind];
    logEvent('artist', 'Skipped AI', `${what}${spark.prompt ? ` "${spark.prompt}"` : ''}`);
    sparks.splice(sparks.indexOf(spark), 1);
    renderOverlay();
    renderTray();
  }
  function retrySpark() {
    const spark = activeSpark();
    if (!spark) return;
    sparks.splice(sparks.indexOf(spark), 1);
    startSpark(spark.kind, spark.region, spark.prompt, spark.label);
  }

  function animate() {
    if (animating) return;
    animating = true;
    const tick = () => {
      renderOverlay();
      if (pendingCount() || revealing() || rigView) requestAnimationFrame(tick);
      else animating = false;
    };
    requestAnimationFrame(tick);
  }
  const REVEAL_MS = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 900;
  const revealProgress = spark => (REVEAL_MS ? Math.min(1, (performance.now() - (spark.readyAt || 0)) / REVEAL_MS) : 1);
  const revealing = () => sparks.some(spark => spark.status === 'ready' && revealProgress(spark) < 1);
  // AI suggestions draw themselves in, stroke by stroke, like a pencil on paper.
  function revealed(strokes, progress) {
    if (progress >= 1) return strokes;
    const total = countPoints(strokes);
    let budget = Math.ceil(total * progress);
    const out = [];
    for (const stroke of strokes) {
      if (budget <= 0) break;
      out.push({ ...stroke, points: stroke.points.slice(0, budget) });
      budget -= stroke.points.length;
    }
    return out;
  }
  const WHOLE = { x: 0.004, y: 0.006, w: 0.992, h: 0.988 };
  function outline(region, dash, offset = 0) {
    octx.setLineDash(dash);
    octx.lineDashOffset = offset;
    octx.strokeRect(region.x * W, region.y * H, region.w * W, region.h * H);
  }
  function renderOverlay() {
    octx.clearRect(0, 0, W, H);
    if (playing) {
      // Painted live, frame by frame: 80 frames of full-size images would be ~200 MB.
      octx.fillStyle = '#ffffff';
      octx.fillRect(0, 0, W, H);
      paintStack(octx, frames[playing.at] || frames[0]);
      const k = mathScale(canvas.getBoundingClientRect().width);
      octx.save();
      octx.fillStyle = 'rgba(11, 36, 34, 0.8)';
      octx.fillRect(12, 12, 116 * k, 30 * k);
      octx.fillStyle = '#c3f192';
      octx.font = `650 ${Math.round(13 * k)}px system-ui, sans-serif`;
      octx.fillText(`${(playing.at / fps).toFixed(1)} s \u00b7 ${playing.at + 1}/${frames.length}`, 12 + 9 * k, 12 + 20 * k);
      octx.restore();
      return;
    }
    if (rigView) { paintRigView(); return; }
    if (pathDraft) {
      const k = mathScale(canvas.getBoundingClientRect().width);
      for (const path of motionDraft?.spec.paths || []) if (path.layerId !== pathDraft.layer.id) drawTrail(octx, path.points, k, { faint: true });
      paintTargetGlow([pathDraft.layer], k, true);
      drawTrail(octx, pathDraft.points, k, { live: true });
      return;
    }
    if (motionDraft && !peeking) {
      paintMotionPreview();
      return;
    }
    if (motionDraft) return; // peeking: the untouched canvas shows through
    paintTargetGlow(layers, mathScale(canvas.getBoundingClientRect().width));
    if (tool === 'path') paintPathTargets(mathScale(canvas.getBoundingClientRect().width));
    if (tool === 'stamp' && stamp && stampHover && pointer === null) {
      octx.save();
      octx.globalAlpha = 0.35;
      stampStrokes(stampHover, false).forEach(stroke => drawStroke(octx, stroke));
      octx.restore();
    }
    if (shapeDraft) {
      const preview = shapeStroke(shapeDraft);
      if (preview) {
        octx.save();
        octx.globalAlpha = 0.85;
        drawStroke(octx, preview);
        octx.restore();
      }
    }
    octx.save();
    octx.strokeStyle = '#7c3aed';
    octx.lineWidth = 2.5;
    if (selection) {
      const region = { x: Math.min(selection.x0, selection.x1), y: Math.min(selection.y0, selection.y1), w: Math.abs(selection.x1 - selection.x0), h: Math.abs(selection.y1 - selection.y0) };
      octx.fillStyle = 'rgba(124, 58, 237, 0.07)';
      octx.fillRect(region.x * W, region.y * H, region.w * W, region.h * H);
      outline(region, [8, 6]);
    }
    if (pendingRegion) outline(pendingRegion, [8, 6]);
    const now = performance.now();
    for (const spark of sparks) {
      if (spark.status !== 'pending') continue;
      octx.globalAlpha = 0.55 + 0.35 * Math.sin(now / 260);
      if (spark.kind === 'sketch') octx.strokeStyle = '#4f8fe6';
      outline(spark.region || WHOLE, [4, 7], -now / 30);
      octx.strokeStyle = '#7c3aed';
    }
    octx.globalAlpha = 1;
    const ready = peeking ? null : activeSpark();
    if (ready?.kind === 'refine') {
      // The refined layer in place: what you'd keep, what AI adds (drawing itself in, with a glow).
      const target = layers.find(layer => layer.id === ready.layerId);
      const { next, changed, since } = target ? refinedStrokes(ready, target) : { next: [], changed: [], since: [] };
      const fresh = revealed(changed, revealProgress(ready));
      octx.fillStyle = '#ffffff';
      octx.fillRect(0, 0, W, H);
      paintStack(octx, layers.map(layer => layer === target ? { ...layer, strokes: [...next.filter(stroke => !changed.includes(stroke)), ...fresh, ...since] } : layer));
      octx.save();
      octx.globalAlpha = 0.45;
      octx.shadowColor = '#a78bfa';
      octx.shadowBlur = 12;
      fresh.forEach(stroke => drawStroke(octx, stroke));
      octx.restore();
    } else if (ready) {
      if (ready.region) outline(ready.region, []);
      octx.globalAlpha = 0.6;
      if (ready.kind === 'strokes' || ready.kind === 'sketch') {
        if (ready.kind === 'strokes') {
          octx.shadowColor = '#a78bfa';
          octx.shadowBlur = 10;
        }
        revealed(ready.result.strokes, revealProgress(ready)).forEach(stroke => drawStroke(octx, stroke));
      } else {
        octx.drawImage(ready.img, ready.region.x * W, ready.region.y * H, ready.region.w * W, ready.region.h * H);
      }
    }
    if (tool === 'move' && !shapeDraft && !selection) {
      const layer = activeLayer();
      const b = layer.visible ? inkBounds(layer.strokes) : null;
      if (b) {
        // The selected layer: a dashed box and a resize handle, like any design tool.
        octx.save();
        octx.strokeStyle = '#0f766e';
        octx.lineWidth = 2;
        octx.setLineDash([7, 5]);
        octx.strokeRect(b.x, b.y, b.w, b.h);
        octx.setLineDash([]);
        octx.fillStyle = '#ffffff';
        octx.beginPath();
        octx.arc(b.x + b.w, b.y + b.h, handleRadius() * 0.6, 0, Math.PI * 2);
        octx.fill();
        octx.stroke();
        octx.restore();
      }
    }
    if (placing) {
      const box = placeDraft ? placementBox(placeDraft) : null;
      if (box) {
        octx.save();
        octx.globalAlpha = 0.7;
        placedStrokes(placing, box).forEach(stroke => drawStroke(octx, stroke));
        octx.globalAlpha = 1;
        octx.strokeStyle = '#0f766e';
        octx.lineWidth = 2;
        octx.setLineDash([6, 5]);
        octx.strokeRect(box.x, box.y, box.w, box.h);
        octx.restore();
      }
    }
    octx.restore();
  }

  // ---------------------------------------------------------------- placing assets
  function inkBounds(strokes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const stroke of strokes) {
      if (stroke.erase) continue;
      const pad = stroke.width / 2;
      for (const p of stroke.points) {
        x0 = Math.min(x0, p.x * W - pad); y0 = Math.min(y0, p.y * H - pad);
        x1 = Math.max(x1, p.x * W + pad); y1 = Math.max(y1, p.y * H + pad);
      }
    }
    return x1 > x0 ? { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) } : null;
  }
  // The dragged box in canvas pixels; a tap places the asset at its original size, centered there.
  function placementBox({ x0, y0, x1, y1 }) {
    let box = { x: Math.min(x0, x1) * W, y: Math.min(y0, y1) * H, w: Math.abs(x1 - x0) * W, h: Math.abs(y1 - y0) * H };
    if (box.w < 24 && box.h < 24) {
      const { w, h } = placing.bbox;
      box = { x: x0 * W - w / 2, y: y0 * H - h / 2, w, h };
    }
    box.x = Math.max(0, Math.min(W - box.w, box.x));
    box.y = Math.max(0, Math.min(H - box.h, box.y));
    return box;
  }
  // Fits the asset into the box (aspect ratio kept, centered), scaling line widths with it.
  function placedStrokes(asset, box) {
    const { bbox } = asset;
    const k = Math.min(box.w / bbox.w, box.h / bbox.h);
    const ox = box.x + (box.w - bbox.w * k) / 2;
    const oy = box.y + (box.h - bbox.h * k) / 2;
    const clamp = v => Math.max(0, Math.min(1, v));
    return asset.strokes.map(stroke => ({
      ...stroke,
      width: Math.max(1, Math.min(40, stroke.width * k)),
      points: stroke.points.map(p => ({ x: clamp((ox + (p.x * W - bbox.x) * k) / W), y: clamp((oy + (p.y * H - bbox.y) * k) / H), pressure: p.pressure }))
    }));
  }
  async function startPlacing(item, at = null, record = null) {
    try {
      const asset = record || await api(`/api/assets/${encodeURIComponent(item.id)}`);
      if (asset.rig) rigCache.set(`${asset.id}@${asset.version}`, asset.rig); // rigged once, kept with the asset
      // A placed asset becomes one linked layer: its visible layers flattened bottom-up.
      const strokes = asset.layers.filter(layer => layer.visible).flatMap(layer => layer.strokes);
      const bbox = inkBounds(strokes);
      if (!bbox) throw new Error('This asset has no visible ink to place.');
      if (layers.length >= MAX_LAYERS) throw new Error('A drawing can have 12 layers. Merge or delete one first.');
      placing = { id: asset.id, version: asset.version, name: asset.name, strokes, bbox };
      if (saveKind !== 'shot' && !editing) setSaveKind('shot'); // placing assets means building a scene
      // It lands right away at a friendly size (where it was dropped, else center stage); then you drag it.
      const k = Math.min(W * 0.34 / bbox.w, H * 0.42 / bbox.h, 1.5);
      const w = bbox.w * k, h = bbox.h * k;
      const cx = at ? at.x : W / 2, cy = at ? at.y : H * 0.56;
      placeAsset({ x: Math.max(0, Math.min(W - w, cx - w / 2)), y: Math.max(0, Math.min(H - h, cy - h / 2)), w, h });
    } catch (error) {
      message('drawing-status', error.message, true);
    }
  }
  function placeAsset(box) {
    if (!placing) return;
    const placedAt = nextSeq(); // a placement is one step in the process
    const strokes = placedStrokes(placing, box).map(stroke => ({ ...stroke, seq: placedAt, ms: undefined }));
    if (layers.length >= MAX_LAYERS || allStrokes().length + strokes.length > MAX_STROKES || pointCount + countPoints(strokes) > MAX_POINTS) {
      message('drawing-status', 'Placing this asset would exceed the canvas limits.', true);
      return;
    }
    pushUndo();
    const layer = newLayer(placing.name.slice(0, 40), { strokes, asset: { asset_id: placing.id, version: placing.version } });
    layers.splice(layers.indexOf(activeLayer()) + 1, 0, layer);
    // The blank page's empty "Layer 1" has nothing to offer a scene; don't leave it lying around.
    const stray = layers.find(other => other !== layer && !other.asset && !other.strokes.length && /^Layer \d+$/.test(other.name));
    if (stray && frames.length === 1 && layers.filter(other => !other.backdrop).length === 2) layers.splice(layers.indexOf(stray), 1);
    activeId = layer.id;
    const name = placing.name;
    placing = null;
    setTool('move');
    recount();
    rebuildAll();
    renderSaveKind();
    flashTray(`\u25c6 ${name} is in. Drag it anywhere, pull the corner to resize, then \u3030 drag it along a path.`);
    logEvent('artist', 'Placed', `${name} v${layer.asset.version}${frames.length > 1 ? ` on frame ${frameIndex + 1}` : ''}`);
  }

  // ---------------------------------------------------------------- direct manipulation: grab what you made
  // Scenery from a starter (all kit strokes, or ink covering most of the canvas) isn't grabbed by a stray tap:
  // you grab what you drew or placed. Pick the scenery layer in Layers to move it on purpose.
  function isScenery(layer) {
    if (layer.backdrop) return true;
    if (layer.asset) return false;
    const b = inkBounds(layer.strokes);
    return !b || b.w * b.h > W * H * 0.6 || layer.strokes.every(stroke => stroke.kit);
  }
  function inkAt(layer, point, radius = 7) {
    const x = Math.round(point.x * W), y = Math.round(point.y * H);
    const size = radius * 2 + 1;
    const data = layerCanvas(layer.id).getContext('2d', { willReadFrequently: true })
      .getImageData(Math.max(0, x - radius), Math.max(0, y - radius), size, size).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 24) return true;
    return false;
  }
  function pickLayer(point) {
    const candidates = [...layers].reverse().filter(layer => layer.visible && layer.strokes.length);
    return candidates.find(layer => !isScenery(layer) && inkAt(layer, point))
      || candidates.find(layer => layer.id === activeId && inkAt(layer, point)) || null;
  }
  // Px radius of the resize handle, in canvas units, sized for a fingertip on screen.
  const handleRadius = () => 16 * W / canvas.getBoundingClientRect().width;
  function onHandle(layer, point) {
    const b = inkBounds(layer.strokes);
    return b && Math.hypot(point.x * W - (b.x + b.w), point.y * H - (b.y + b.h)) <= handleRadius() * 1.4;
  }
  function scaledStrokes(strokes, center, k) {
    const clamp = v => Math.max(0, Math.min(1, v));
    return strokes.map(stroke => ({
      ...stroke, width: Math.max(1, Math.min(40, stroke.width * k)),
      points: stroke.points.map(p => ({ ...p, x: clamp((center.x + (p.x * W - center.x) * k) / W), y: clamp((center.y + (p.y * H - center.y) * k) / H) }))
    }));
  }
  // Linked assets stay clean: new ink goes on a plain layer just above, never into the placed asset.
  function inkTarget() {
    const layer = activeLayer();
    if (!layer.asset) return layer;
    const at = layers.indexOf(layer);
    const above = layers[at + 1];
    if (above && !above.asset && above.visible) { activeId = above.id; }
    else if (layers.length < MAX_LAYERS) {
      const fresh = newLayer('Ink');
      layers.splice(at + 1, 0, fresh);
      activeId = fresh.id;
    } else return layer;
    renderLayersPanel();
    flashTray(`\u270e Your ink goes on "${activeLayer().name}", above ${layer.name}. Linked assets stay clean.`);
    return activeLayer();
  }
  function updateHud() {
    renderShotHint();
    const hud = $('layer-hud');
    const layer = activeLayer();
    hud.hidden = canvasIsBlank() || !!motionDraft || !!playing;
    hud.textContent = `${tool === 'move' ? '\u2725' : '\u270e'} ${layer.asset ? '\u25c6 ' : ''}${layer.name}${frames.length > 1 ? `  \u00b7  frame ${frameIndex + 1}/${frames.length} \u00b7 ${(frameIndex / fps).toFixed(1)} s` : ''}`;
    hud.classList.toggle('asset', !!layer.asset);
    renderOverlay();
  }
  $('layer-hud').addEventListener('click', () => {
    if (matchMedia('(max-width: 899px)').matches) setLayersOpen(true);
    else pulse('#layers-panel .layer.active');
  });

  // ---------------------------------------------------------------- motion: keyframes that move your own strokes
  // How animation works, and how Inkling does it: a few keyframes (the poses that matter) and in-betweens
  // computed on a smooth curve. Every frame is the artist's own strokes, posed by numbers (move, squash and
  // stretch, turn), never redrawn. Frames store "frame 1's layer, posed": a 10-second shot stays small.
  const MOTION_FPS = 8;
  const K = (t, x = 0, y = 0, sx = 1, sy = 1, r = 0, label = '') => ({ t, x, y, sx, sy, r, label });
  // Quick moves: free, instant, a few seconds. Each one starts from the pose you drew.
  const PRESETS = [
    { id: 'liftoff', icon: '\ud83d\ude80', name: 'Lift off', seconds: 2.5, hint: 'Squat, stretch, and launch up and away.',
      keys: b => { const up = -Math.min(0.95, b.y + b.h + 0.05); return [K(0, 0, 0, 1, 1, 0, 'start'), K(0.15, 0, 0.01, 1.08, 0.9, 0, 'anticipation'), K(0.3, 0, -0.01, 0.94, 1.1, 0, 'stretch'), K(0.6, 0, up * 0.3, 0.9, 1.15, 0, 'slow out'), K(1, 0, up, 0.85, 1.2, 0, 'exit')]; } },
    { id: 'hop', icon: '\ud83d\udc07', name: 'Hop across', seconds: 3, hint: 'Two hops toward the open side, squash on landing.',
      keys: b => { const right = b.x + b.w / 2 < 0.5; const d = (right ? 1 : -1) * Math.max(0.05, Math.min(0.4, right ? 0.95 - b.x - b.w : b.x - 0.05)); const hy = -Math.min(0.2, b.y);
        return [K(0, 0, 0, 1, 1, 0, 'start'), K(0.08, 0, 0.01, 1.1, 0.9, 0, 'anticipation'), K(0.25, d * 0.25, hy, 0.95, 1.08, 0, 'arc'), K(0.45, d * 0.5, 0.01, 1.15, 0.85, 0, 'squash'), K(0.55, d * 0.52, 0, 1, 1, 0, 'settle'), K(0.75, d * 0.76, hy, 0.95, 1.08, 0, 'arc'), K(0.92, d, 0.01, 1.15, 0.85, 0, 'squash'), K(1, d, 0, 1, 1, 0, 'settle')]; } },
    { id: 'float', icon: '\ud83c\udf88', name: 'Float', seconds: 3, hint: 'A gentle bob and sway. Loops nicely.',
      keys: () => [K(0, 0, 0, 1, 1, 0, 'start'), K(0.25, 0, -0.035, 1, 1, -3, 'slow in'), K(0.5, 0, 0, 1, 1, 0, 'slow out'), K(0.75, 0, -0.035, 1, 1, 3, 'slow in'), K(1, 0, 0, 1, 1, 0, 'settle')] },
    { id: 'walk', icon: '\ud83d\udeb6', name: 'Walk across', seconds: 3, hint: 'Steady steps with a little bob.',
      keys: b => { const d = (b.x + b.w / 2 < 0.5 ? 1 : -1) * 0.35; return Array.from({ length: 9 }, (_, i) => K(i / 8, d * i / 8, i % 2 ? -0.015 : 0, 1, i % 2 ? 1.02 : 0.98, i % 2 ? 2 : -2, i ? (i % 2 ? 'step' : 'contact') : 'start')); } },
    { id: 'spin', icon: '\ud83c\udf00', name: 'Spin', seconds: 2, hint: 'One full turn, easing in and out.',
      keys: () => [K(0, 0, 0, 1, 1, 0, 'start'), K(0.15, 0, 0, 1, 1, -12, 'anticipation'), K(0.5, 0, 0, 1, 1, 180, 'turn'), K(0.9, 0, 0, 1, 1, 372, 'overshoot'), K(1, 0, 0, 1, 1, 360, 'settle')] },
    { id: 'bounce', icon: '\ud83c\udfc0', name: 'Bounce', seconds: 2, hint: 'Up and down with squash and stretch.',
      keys: b => { const up = -Math.min(0.22, b.y); return [K(0, 0, 0, 1, 1, 0, 'start'), K(0.12, 0, 0.005, 1.15, 0.85, 0, 'squash'), K(0.3, 0, up * 0.8, 0.92, 1.1, 0, 'stretch'), K(0.45, 0, up, 1, 1, 0, 'apex'), K(0.62, 0, up * 0.8, 0.92, 1.1, 0, 'stretch'), K(0.78, 0, 0.005, 1.18, 0.82, 0, 'squash'), K(0.9, 0, up * 0.15, 0.98, 1.02, 0, 'rebound'), K(1, 0, 0, 1, 1, 0, 'settle')]; } },
    { id: 'zoom', icon: '\ud83d\udd0d', name: 'Push in', seconds: 2, hint: 'Grows toward the camera.',
      keys: () => [K(0, 0, 0, 1, 1, 0, 'start'), K(0.2, 0, 0, 1.04, 1.04, 0, 'slow out'), K(1, 0, 0, 1.55, 1.55, 0, 'push in')] },
    { id: 'shake', icon: '\u26a1', name: 'Shake', seconds: 1.5, hint: 'Nervous jitter: fear, cold, or an engine warming up.',
      keys: () => Array.from({ length: 11 }, (_, i) => K(i / 10, i % 10 ? (i % 2 ? 0.012 : -0.012) : 0, 0, 1, 1, i % 10 ? (i % 2 ? 3 : -3) : 0, i ? 'shake' : 'start')) }
  ];
  const PRINCIPLES = {
    anticipation: 'A small move the other way first, so the big move reads.',
    squash: 'It flattens on impact (and keeps its volume), so it feels soft and heavy.',
    stretch: 'It stretches with speed, like a smear of motion.',
    arc: 'Living things move on curves, not straight lines.',
    'slow in': 'Easing into a pose: more frames near it, so it slows down.',
    'slow out': 'Easing out of a pose: it starts slow and speeds up.',
    overshoot: 'Going a little past the target...',
    settle: '...and settling back. Nothing stops dead.',
    hold: 'A still moment so the pose reads.',
    takeoff: 'The moment it leaves the ground: maximum stretch.',
    apex: 'The top of the arc: the slowest moment of a jump.',
    turn: 'Rotation, eased in and out.',
    contact: 'The moment a foot (or a ball) meets the ground.'
  };
  // Effects: "make it snow" is a pattern, not a prompt. An effect is one extra layer of tiny strokes, computed
  // for every frame from a fixed seed: instant, free, the same every time, and no AI. Gemini only moves what you drew.
  const r4 = v => Math.round(v * 1e4) / 1e4;
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const onCanvas = p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
  const fxStroke = (points, color, width, fill = null) => ({ points: points.map(p => ({ x: r4(p.x), y: r4(p.y), pressure: 0.75 })), color, width,
    ...(fill ? { fill } : {}), kit: true, seq: 0 });
  const ASPECT = H / W; // keeps circles round on a 1000 x 650 canvas
  const CONFETTI = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
  const FX = [
    { id: 'snow', icon: '\u2744\ufe0f', name: 'Snow', hint: 'Flakes drift down and sway.', count: 46, seed: 11,
      words: /\b(snow(s|ing|y|fall|flakes?|storm)?|blizzard|flurr(y|ies))\b/i,
      particle: r => ({ x: r(), y: r(), v: 0.05 + r() * 0.07, w: 3 + r() * 5, a: 0.006 + r() * 0.018, p: r() * 6.28 }),
      draw: (q, t) => { const p = { x: q.x + q.a * Math.sin(t * 1.6 + q.p), y: (q.y + q.v * t) % 1.04 - 0.02 }; return onCanvas(p) ? [fxStroke([p], '#b7d3ec', q.w)] : []; } },
    { id: 'rain', icon: '\ud83c\udf27\ufe0f', name: 'Rain', hint: 'Slanted streaks pour down.', count: 40, seed: 23,
      words: /\b(rain(s|ing|y|fall|drops?)?|drizzl\w*|downpour|storm(s|y)?)\b/i,
      particle: r => ({ x: r() * 1.15, y: r(), v: 0.8 + r() * 0.4, l: 0.035 + r() * 0.03 }),
      draw: (q, t) => { const y = (q.y + q.v * t) % 1.12 - 0.06, head = { x: q.x - 0.12 * y, y }, tail = { x: head.x + 0.12 * q.l, y: y - q.l };
        return onCanvas(head) && onCanvas(tail) ? [fxStroke([tail, head], '#7aa7d6', 2)] : []; } },
    { id: 'sparkles', icon: '\u2728', name: 'Sparkles', hint: 'Little stars twinkle on and off.', count: 16, seed: 37,
      words: /\b(sparkl\w*|twinkl\w*|glitter\w*|shimmer\w*|glow\w*)\b/i,
      particle: r => ({ x: 0.04 + r() * 0.92, y: 0.04 + r() * 0.92, s: 0.014 + r() * 0.014, f: 1.6 + r() * 1.8, p: r() * 6.28 }),
      draw: (q, t) => { const size = q.s * Math.max(0, Math.sin(t * q.f + q.p)); if (size < 0.004) return [];
        const pts = Array.from({ length: 9 }, (_, k) => { const a = (k % 8) * Math.PI / 4 - Math.PI / 2, rad = k % 2 ? size * 0.3 : size;
          return { x: Math.max(0, Math.min(1, q.x + Math.cos(a) * rad * ASPECT)), y: Math.max(0, Math.min(1, q.y + Math.sin(a) * rad)) }; });
        return [fxStroke(pts, '#e0a526', 1, '#f8d34a')]; } },
    { id: 'confetti', icon: '\ud83c\udf89', name: 'Confetti', hint: 'Bright bits tumble down.', count: 44, seed: 41,
      words: /\b(confetti)\b/i,
      particle: r => ({ x: r(), y: r(), v: 0.12 + r() * 0.1, a: r() * 6.28, spin: 2 + r() * 4, c: CONFETTI[Math.floor(r() * CONFETTI.length)], w: 4 + r() * 3, p: r() * 6.28 }),
      draw: (q, t) => { const c = { x: q.x + 0.02 * Math.sin(t * 1.3 + q.p), y: (q.y + q.v * t) % 1.06 - 0.03 }, a = q.a + q.spin * t, len = 0.014 * (0.35 + 0.65 * Math.abs(Math.cos(t * 3 + q.p)));
        const one = { x: c.x - Math.cos(a) * len * ASPECT, y: c.y - Math.sin(a) * len }, two = { x: c.x + Math.cos(a) * len * ASPECT, y: c.y + Math.sin(a) * len };
        return onCanvas(one) && onCanvas(two) ? [fxStroke([one, two], q.c, q.w)] : []; } },
    { id: 'bubbles', icon: '\ud83e\udee7', name: 'Bubbles', hint: 'Bubbles wobble up and away.', count: 14, points: 12, seed: 53,
      words: /\b(bubbl\w*|underwater|fizz\w*)\b/i,
      particle: r => ({ x: 0.05 + r() * 0.9, y: r(), v: 0.06 + r() * 0.06, rad: 0.012 + r() * 0.02, p: r() * 6.28 }),
      draw: (q, t) => { const c = { x: q.x + 0.015 * Math.sin(t * 2 + q.p), y: 1.04 - (q.y + q.v * t) % 1.1 };
        const pts = Array.from({ length: 12 }, (_, k) => ({ x: c.x + Math.cos(k / 11 * Math.PI * 2) * q.rad * ASPECT, y: c.y + Math.sin(k / 11 * Math.PI * 2) * q.rad }));
        return pts.every(onCanvas) ? [fxStroke(pts, '#7cc4e4', 2)] : []; } }
  ];
  const MAX_FX = 2;
  const FX_NAMES = new Set(FX.map(fx => fx.name));
  function fxLayer(id, frame) {
    const fx = FX.find(item => item.id === id);
    if (!fx.parts) { const r = seeded(fx.seed); fx.parts = Array.from({ length: fx.count }, () => fx.particle(r)); }
    return newLayer(fx.name, { fx: id, strokes: fx.parts.flatMap(q => fx.draw(q, frame / MOTION_FPS)) });
  }
  // Free tweaks: the same keyframes, changed by plain arithmetic. No AI either.
  const TWEAKS = [
    { id: 'bigger', label: '\u2922 Bigger', say: 'the same keyframes, pushed 30% further',
      words: /^(bigger|more|stronger|wilder|bolder|more dramatic|more intense|more energy|more energetic|exaggerate|exaggerated)$/,
      apply: (spec, ids) => scaleTracks(spec, ids, 1.3) },
    { id: 'calmer', label: 'Calmer', say: 'the same keyframes, 30% gentler',
      words: /^(calmer|smaller|subtler|more subtle|gentler|softer|less|tone down|calm down)$/,
      apply: (spec, ids) => scaleTracks(spec, ids, 0.7) },
    { id: 'faster', label: 'Faster', say: 'the same poses in less time', clock: true,
      words: /^(faster|quicker|speed up|snappier|hurry|hurry up)$/,
      apply: spec => ({ ...spec, seconds: Math.max(2, Math.round(spec.seconds * 0.7 * MOTION_FPS) / MOTION_FPS) }) },
    { id: 'slower', label: 'Slower', say: 'the same poses with more time', clock: true,
      words: /^(slower|slow down|longer|take more time)$/,
      apply: spec => ({ ...spec, seconds: Math.min(10, Math.round(spec.seconds * 1.4 * MOTION_FPS) / MOTION_FPS) }) }
  ];
  const clampTo = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // A scale keeps its sign (negative = mirrored, facing the other way) and is never thinner than 0.03 either way.
  const signedScale = v => (v < 0 ? -1 : 1) * clampTo(Math.abs(v), 0.03, 4);
  // Strength (and Bigger/Calmer) grows the squash and stretch, never the mirror.
  const strongScale = (v, s) => (v < 0 ? -1 : 1) * clampTo(1 + (Math.abs(v) - 1) * s, 0.03, 4);
  function scaleTracks(spec, ids, f) {
    const scale = keys => keys.map(k => ({ ...k, x: r4(clampTo(k.x * f, -1.5, 1.5)), y: r4(clampTo(k.y * f, -1.5, 1.5)),
      sx: r4(strongScale(k.sx, f)), sy: r4(strongScale(k.sy, f)), r: r4(clampTo(k.r * f, -1080, 1080)) }));
    return { ...spec, tracks: spec.tracks.map(track => (!ids || ids.has(track.layerId) ? { ...track, keys: scale(track.keys) } : track)) };
  }
  const FILLER = /\b(make|makes|let|lets|let's|please|it|its|it's|the|a|an|bit|little|lot|lots|much|way|whole|just|now|again|some|can|could|you|be|go|do|and|with|plus|also|then|add|start|have|put|turn|on|in|of|to|there|too|falling|fall|everywhere|around|background|effect|effects|heavy|light|motion|movement|moves?|animation|everything|scene)\b/g;
  const NEGATION = /\b(no|not|stop|remove|without|lose|less|turn off|get rid of)\b/i;
  const NEGATED = new RegExp(`${NEGATION.source}[^,.;]*$`, 'i');
  // How the box reads your words, before anything runs: effects and tweaks happen here; the rest goes to Gemini.
  function readPrompt(text) {
    const on = [], off = [];
    let rest = ` ${text} `;
    for (const fx of FX) {
      const match = fx.words.exec(rest);
      if (!match) continue;
      const negated = NEGATED.test(rest.slice(Math.max(0, match.index - 18), match.index));
      (negated ? off : on).push(fx);
      rest = rest.replace(fx.words, ' ');
      if (negated) rest = rest.replace(NEGATION, ' ');
    }
    const core = rest.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
    const tweak = core ? TWEAKS.find(item => item.words.test(core)) || null : null;
    const ai = !!core && !tweak;
    // "add a hat" asks for a new drawing; "add confetti" was an effect (already taken out of `rest`).
    const asked = /\b(add|draw|put|insert|create|include|spawn|wearing|holding|give \w+)\s+(?:an?\s+|some\s+|the\s+|more\s+|two\s+|three\s+)?([a-z]{3,})/i.exec(rest);
    const warn = ai && !!asked && !/^(and|it|its|that|this|them|then|with|more|some|bit|little)$/i.test(asked[2]);
    return { on, off, tweak, ai, warn };
  }
  const fxList = ids => (ids || []).map(id => FX.find(fx => fx.id === id)).filter(Boolean);
  const pctOf = v => `${Math.round(v * 100)}%`;
  function trackStats(track, strength = 1) {
    const ks = track.keys;
    return { rise: Math.max(0, -Math.min(...ks.map(k => k.y))) * strength, travel: Math.max(...ks.map(k => Math.abs(k.x))) * strength,
      spin: Math.max(...ks.map(k => Math.abs(k.r))) * strength, squash: Math.max(...ks.map(k => Math.max(Math.abs(Math.abs(k.sx) - 1), Math.abs(Math.abs(k.sy) - 1)))) * strength,
      keys: ks.length };
  }
  function diffMotion(prev, next) {
    return next.tracks.filter(track => !prev.tracks.some(item => item.keys === track.keys)).map(track => {
      const old = prev.tracks.find(item => item.name === track.name);
      if (!old) return `${track.name} now moves`;
      const a = trackStats(old, prev.strength), b = trackStats(track, next.strength), bits = [];
      if (Math.abs(b.rise - a.rise) > 0.04) bits.push(`${b.rise > a.rise ? 'rises higher' : 'stays lower'} (${pctOf(a.rise)} \u2192 ${pctOf(b.rise)})`);
      if (Math.abs(b.travel - a.travel) > 0.05) bits.push(`${b.travel > a.travel ? 'goes farther' : 'stays closer'} (${pctOf(a.travel)} \u2192 ${pctOf(b.travel)})`);
      if (Math.abs(b.spin - a.spin) > 25) bits.push(`${b.spin > a.spin ? 'turns more' : 'turns less'} (${Math.round(a.spin)}\u00b0 \u2192 ${Math.round(b.spin)}\u00b0)`);
      if (Math.abs(b.squash - a.squash) > 0.05) bits.push(b.squash > a.squash ? 'more squash & stretch' : 'less squash & stretch');
      if (a.keys !== b.keys) bits.push(`${a.keys} \u2192 ${b.keys} keyframes`);
      return `${track.name} ${bits.length ? bits.join(', ') : 'is re-timed, same shape'}`;
    }).join(' \u00b7 ');
  }
  const fxWords = (on, off) => [...on.map(fx => `+ ${fx.icon} ${fx.name}`), ...off.map(fx => `\u2212 ${fx.icon} ${fx.name}`)];
  // Effects next to the drawing must still fit one frame's limits.
  function fxFits(spec, effects) {
    const strokes = spec.base.reduce((n, layer) => n + layer.strokes.length, 0) + fxList(effects).reduce((n, fx) => n + fx.count, 0);
    const points = countPoints(spec.base.flatMap(layer => layer.strokes)) + fxList(effects).reduce((n, fx) => n + fx.count * (fx.points || 2), 0);
    if (effects.length > MAX_FX) return `Two effects at a time keeps a scene light. Remove one first.`;
    if (spec.base.length + effects.length > MAX_LAYERS) return `No room for another layer (${MAX_LAYERS} max).`;
    if (strokes > MAX_STROKES || points > MAX_POINTS) return 'This drawing is too detailed to add that effect.';
    return '';
  }
  const withFx = (current, on, off) => [...new Set([...(current || []).filter(id => !off.some(fx => fx.id === id)), ...on.map(fx => fx.id)])];

  // Catmull-Rom through the keys: smooth arcs, no stop-and-go at every key.
  function sampleKeys(keys, t) {
    if (t <= keys[0].t) return keys[0];
    const last = keys[keys.length - 1];
    if (t >= last.t) return last;
    let i = 0;
    while (keys[i + 1].t < t) i++;
    const p1 = keys[i], p2 = keys[i + 1], p0 = keys[i - 1] || p1, p3 = keys[i + 2] || p2;
    const u = (t - p1.t) / ((p2.t - p1.t) || 1), u2 = u * u, u3 = u2 * u;
    const cr = c => 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * u + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * u3);
    return { t, x: cr('x'), y: cr('y'), sx: signedScale(cr('sx')), sy: signedScale(cr('sy')), r: cr('r') };
  }
  // A frame's pose: offsets and pivot in canvas fractions, r in degrees. Mirrors pose_strokes in backend/models.py.
  function xfAt(keys, t, strength, pivot) {
    const k = sampleKeys(keys, t), s = strength;
    const lim = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)) * 1e5) / 1e5;
    return { x: lim(k.x * s, -2, 2), y: lim(k.y * s, -2, 2), sx: lim(strongScale(k.sx, s), -4, 4), sy: lim(strongScale(k.sy, s), -4, 4),
      r: lim(k.r * s, -1080, 1080), px: lim(pivot.px, -1, 2), py: lim(pivot.py, -1, 2) };
  }
  function poseXf(strokes, xf) {
    const rad = xf.r * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const cx = xf.px * W, cy = xf.py * H, ox = cx + xf.x * W, oy = cy + xf.y * H;
    const out = [];
    for (const stroke of strokes) {
      const points = stroke.points.map(p => {
        const X = (p.x * W - cx) * xf.sx, Y = (p.y * H - cy) * xf.sy;
        return { ...p, x: (ox + X * cos - Y * sin) / W, y: (oy + X * sin + Y * cos) / H };
      });
      // Off-canvas strokes leave the frame; the rest are pinned to the edge (where they're out of sight anyway).
      if (points.every(p => p.x < -0.02 || p.x > 1.02 || p.y < -0.02 || p.y > 1.02)) continue;
      out.push({ ...stroke, width: Math.max(1, Math.min(40, stroke.width * Math.sqrt(Math.abs(xf.sx * xf.sy)))),
        points: points.map(p => ({ ...p, x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) })) });
    }
    return out;
  }
  // ---------------------------------------------------------------- gaits: how something moves along a path
  // Plain math layered on a path, frame by frame (no AI): steps or hops from how far it has gone, squash where it
  // lands, a lean, and a breath while it stands. Sizes are the asset's own: stride x its width, lift x its height.
  const GAITS = {
    walk: { icon: '\ud83d\udeb6', name: 'Walk', verb: 'walks', speed: 210, stride: 0.6, lift: 0.07, squash: 0.05, stretch: 0, float: 0, lean: 5, bank: 0, turn: 0, face: 1, hop: 0 },
    hop: { icon: '\ud83d\udc07', name: 'Hop', verb: 'hops', speed: 260, stride: 1.5, lift: 0.5, squash: 0.16, stretch: 0.07, float: 0, lean: 7, bank: 0, turn: 0, face: 1, hop: 1 },
    glide: { icon: '\u3030', name: 'Glide', verb: 'glides', speed: 230, stride: 0, lift: 0, squash: 0, stretch: 0.04, float: 0.02, lean: 4, bank: 0.35, turn: 0, face: 1, hop: 0 },
    fly: { icon: '\ud83d\udd4a\ufe0f', name: 'Fly', verb: 'flies', speed: 320, stride: 0, lift: 0, squash: 0, stretch: 0.06, float: 0.04, lean: 0, bank: 0, turn: 1, face: 1, hop: 0 }
  };
  // One frame of a gait. `s` carries where it was and how far it has gone; motionToSketch writes this same function
  // into the scene's code, so the Lab reproduces every frame.
  function gaitStep(s, g, w, h, x, y, f, fps) {
    const d = s.f < 0 ? 0 : Math.hypot(x - s.x, y - s.y);
    s.x = x;
    s.y = y;
    s.f = f;
    s.dist += d;
    s.m += (Math.min(1, d / Math.max(1, w * 0.03)) - s.m) * 0.4; // how much it's moving: eased, so nothing pops
    let dy = 0, sx = 1, sy = 1;
    s.phase = g.stride ? s.dist / (g.stride * w) * Math.PI : s.dist / Math.max(1, w) * Math.PI;
    if (g.stride) {
      const up = Math.abs(Math.sin(s.phase));
      dy -= (g.hop ? Math.sqrt(up) : up) * g.lift * h * s.m;
      const land = g.squash * s.m * Math.pow(1 - up, 4);
      sx += land;
      sy -= land;
      if (g.hop) { sy += g.stretch * s.m * up; sx -= g.stretch * s.m * up * 0.5; }
    } else {
      sx += g.stretch * s.m;
      sy -= g.stretch * s.m * 0.5;
    }
    const t = f / fps;
    dy += Math.sin(t * Math.PI * 1.4) * g.float * h;
    const breath = Math.sin(t * Math.PI * 1.2) * 0.015 * (1 - s.m);
    sy += breath;
    sx -= breath * 0.5;
    dy += (1 - sy) * h * 0.5; // squash from the feet, not the middle
    return { dy, sx, sy };
  }
  // A rig: which strokes are legs, arms, a tail, wings, or the head, and the joint each turns on (found once per asset
  // version by AI, kept with the asset). A gait swings them: legs in step with the stride, arms against them, a tail
  // that wags, wings that flap. Mirrors bend_strokes in backend/models.py.
  function bendStrokes(strokes, bend) {
    if (!bend?.length) return strokes;
    const out = strokes.slice();
    for (const b of bend) {
      const rad = b.r * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad), cx = b.px * W, cy = b.py * H;
      for (const i of b.s) {
        if (!out[i]) continue;
        out[i] = { ...out[i], points: out[i].points.map(p => {
          const dx = p.x * W - cx, dy = p.y * H - cy;
          return { ...p, x: (cx + dx * cos - dy * sin) / W, y: (cy + dx * sin + dy * cos) / H };
        }) };
      }
    }
    return out;
  }
  // How far each part turns this frame (degrees), from the gait's state: s.phase (the stride) and s.m (how much it moves).
  // motionToSketch writes this same function into the scene's code.
  function rigTurns(part, g, s, f, fps) {
    const t = f / fps, m = s.m, swing = Math.sin(s.phase || 0), up = Math.abs(swing);
    if (part === 'leg_front' || part === 'leg_back') {
      const side = part === 'leg_front' ? 1 : -1;
      return g.hop ? -28 * m * up : g.stride ? 24 * m * swing * side : 6 * m * side;
    }
    if (part === 'arm_front' || part === 'arm_back') {
      const side = part === 'arm_front' ? -1 : 1;
      return g.hop ? -35 * m * up : g.stride ? 18 * m * swing * side : 3 * Math.sin(t * Math.PI * 1.2) * side;
    }
    if (part === 'tail') return 12 * Math.sin(t * Math.PI * 2.2) + 14 * m * swing;
    if (part === 'wing_front' || part === 'wing_back') return (g.turn ? 34 : 10 + 20 * m) * Math.sin(t * Math.PI * 4.4) * (part === 'wing_front' ? 1 : 0.8);
    if (part === 'head') return 4 * m * swing + 2.5 * Math.sin(t * Math.PI * 0.8);
    return 0;
  }
  const rigCache = new Map(); // `${asset_id}@${version}` -> rig, for this session
  const rigKey = layer => layer?.asset ? `${layer.asset.asset_id}@${layer.asset.version}` : '';
  // A placed asset's rig, if it still fits its strokes (a placed layer keeps the asset's stroke order).
  // Refine keeps stroke order (new strokes go last), so a rig fits until strokes are removed.
  function rigFor(layer) {
    const rig = rigCache.get(rigKey(layer));
    return rig && layer.strokes.length >= rig.strokes && !layer.rigOff && rig.bones.length ? rig : null;
  }
  const rigsComing = new Map(); // key -> the request in flight, so a path drawn meanwhile doesn't ask twice
  function ensureRig(layer) {
    const key = rigKey(layer);
    if (!key || rigCache.has(key) || offline) return Promise.resolve();
    if (!rigsComing.has(key)) {
      rigsComing.set(key, api(`/api/assets/${encodeURIComponent(layer.asset.asset_id)}/rig`, { method: 'POST' })
        .then(data => { if (data.version === layer.asset.version) rigCache.set(key, data.rig); })
        .catch(() => { /* no rig: it still moves, as one piece */ })
        .finally(() => rigsComing.delete(key)));
    }
    return rigsComing.get(key);
  }
  // ---------------------------------------------------------------- 🦴 Rig: see the parts, watch them swing, redo it
  // In a shot it rigs the asset you placed (kept with that asset version); on a drawing that isn't saved yet it
  // rigs what's on the canvas and keeps the rig with the asset when you save it.
  const PART_COLORS = { head: '#ca8a04', leg_front: '#dc2626', leg_back: '#ea580c', arm_front: '#2563eb', arm_back: '#0891b2', tail: '#9333ea', wing_front: '#16a34a', wing_back: '#65a30d' };
  const PART_WORDS = { head: 'head', leg_front: 'leg', leg_back: 'leg', arm_front: 'arm', arm_back: 'arm', tail: 'tail', wing_front: 'wing', wing_back: 'wing' };
  const drawingStrokes = () => layers.filter(layer => layer.visible).flatMap(layer => layer.strokes);
  const rigSig = () => { const all = drawingStrokes(); return `${all.length}:${countPoints(all)}`; };
  const rigSummary = rig => {
    const n = {};
    for (const bone of rig.bones) { const w = PART_WORDS[bone.part] || bone.part; n[w] = (n[w] || 0) + 1; }
    return Object.entries(n).map(([w, k]) => (k > 1 ? `${k} ${w}s` : w)).join(' \u00b7 ');
  };
  function rigViewStrokes() {
    if (!rigView) return [];
    if (rigView.layerId == null) return drawingStrokes();
    return layers.find(layer => layer.id === rigView.layerId)?.strokes || [];
  }
  function paintRigView() {
    const strokes = rigViewStrokes(), b = inkBounds(strokes.filter(stroke => !stroke.erase));
    if (!b) return;
    const k = mathScale(canvas.getBoundingClientRect().width);
    const t = (performance.now() - rigView.started) / 1000;
    const g = GAITS[{ bird: 'fly', fish: 'glide' }[rigView.rig.kind] || 'walk'];
    const s = { phase: t * Math.PI * 1.4, m: 1 }; // as if it were walking, so every part shows how it swings
    const joints = rigView.rig.bones.map(bone => ({ ...bone, x: b.x + bone.px * b.w, y: b.y + bone.py * b.h, r: rigTurns(bone.part, g, s, t * MOTION_FPS, MOTION_FPS) }));
    const bent = bendStrokes(strokes, joints.map(j => ({ s: j.strokes, r: j.r, px: j.x / W, py: j.y / H })));
    const partOf = new Map(joints.flatMap(j => j.strokes.map(i => [i, j.part])));
    octx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    octx.fillRect(0, 0, W, H);
    octx.save();
    octx.globalAlpha = 0.35;
    bent.forEach((stroke, i) => { if (!partOf.has(i) && !stroke.erase) drawStroke(octx, stroke); });
    octx.restore();
    octx.save();
    octx.shadowBlur = 10;
    bent.forEach((stroke, i) => {
      const part = partOf.get(i);
      if (!part || stroke.erase) return;
      octx.shadowColor = PART_COLORS[part];
      drawStroke(octx, { ...stroke, color: PART_COLORS[part], fill: null, width: Math.max(stroke.width, 3) });
    });
    octx.restore();
    octx.font = `700 ${Math.round(12 * k)}px system-ui, sans-serif`;
    for (const j of joints) {
      const color = PART_COLORS[j.part] || '#334155', label = PART_WORDS[j.part] || j.part;
      octx.fillStyle = 'white';
      octx.beginPath(); octx.arc(j.x, j.y, 7 * k, 0, Math.PI * 2); octx.fill();
      octx.fillStyle = color;
      octx.beginPath(); octx.arc(j.x, j.y, 4.5 * k, 0, Math.PI * 2); octx.fill();
      const w = octx.measureText(label).width + 12 * k;
      octx.fillStyle = color;
      octx.beginPath(); octx.roundRect(j.x + 9 * k, j.y - 9 * k, w, 18 * k, 9 * k); octx.fill();
      octx.fillStyle = 'white';
      octx.fillText(label, j.x + 15 * k, j.y + 4 * k);
    }
  }
  function closeRig() {
    if (!rigView) return;
    rigView = null;
    $('rig-now').setAttribute('aria-pressed', 'false');
    renderOverlay();
  }
  async function rigNow(redo = false) {
    $('rig-now').blur();
    if (rigView && !redo) { closeRig(); return; }
    if (offline) { flashTray(OFFLINE_NOTE, true); return; }
    const shot = saveKind === 'shot';
    const active = activeLayer();
    const layer = shot ? (active?.asset ? active : layers.find(item => item.asset && item.visible)) : null;
    if (shot && !layer) { flashTray('\ud83e\uddb4 Rig works on an asset: place one in this shot, or open the asset itself.', true); return; }
    if (!shot && !drawingStrokes().some(stroke => !stroke.erase)) { flashTray('Draw something first, then \ud83e\uddb4 Rig finds its legs, arms, and tail.', true); return; }
    const name = layer?.name || $('title').value.trim() || 'your drawing';
    const savedAsset = !shot && editing?.kind === 'asset' && revision === savedRevision;
    message('drawing-status', `\ud83e\uddb4 ${redo ? 'Rigging again' : 'Finding'} ${name}\u2019s legs, arms, tail, and head\u2026`);
    let rig = null;
    try {
      if (layer || savedAsset) {
        const id = layer ? layer.asset.asset_id : editing.id, version = layer ? layer.asset.version : editing.version, key = `${id}@${version}`;
        if (layer && !redo) await ensureRig(layer); // shares a request already on its way (a new shot asks too)
        else if (redo || !rigCache.has(key)) {
          const data = await api(`/api/assets/${encodeURIComponent(id)}/rig${redo ? '?redo=true' : ''}`, { method: 'POST' });
          if (data.version === version) rigCache.set(key, data.rig);
        }
        rig = rigCache.get(key);
        if (layer && rig) layer.rigOff = false;
      } else {
        const sig = rigSig();
        if (redo || pendingRig?.sig !== sig) pendingRig = { sig, rig: (await postJSON('/api/sparks/rig', JSON.stringify({ layers: docLayers() }))).rig };
        rig = pendingRig.rig;
      }
    } catch (error) {
      message('drawing-status', `\ud83e\uddb4 Couldn\u2019t rig it: ${error.message}`, true);
      return;
    }
    const again = { label: '\u21bb Redo rig', tip: 'Redo rig|Ask AI again: useful if a leg got called an arm, or a joint is off.', run: () => rigNow(true) };
    if (!rig?.bones?.length) {
      closeRig();
      message('drawing-status', `\ud83e\uddb4 No moving parts found: ${name} moves as one piece (it squashes, leans, and hops). Draw legs or a tail as their own strokes, then rig again.`, false, [again]);
      return;
    }
    rigView = { layerId: layer ? layer.id : null, rig, started: performance.now() };
    $('rig-now').setAttribute('aria-pressed', 'true');
    animate();
    const walk = shot && frames.length === 1 ? [{ label: '\u3030 Walk it', tip: 'Walk it|A fresh take: it travels the stage, limbs and all.', run: () => { closeRig(); if (motionDraft) skipMotion(); autoTake(layer); } }] : [];
    message('drawing-status', `\ud83e\uddb4 ${name}: ${rigSummary(rig)} (${rig.kind}). Watch each part swing on its joint.${shot || savedAsset ? ' Kept with the asset.' : ' Kept with the asset when you save it.'}`, false, [
      { label: '\u2713 Looks right', run: closeRig }, again, ...walk]);
  }
  $('rig-now').addEventListener('click', () => rigNow());
  const frameCount = seconds => Math.max(2, Math.min(MAX_FRAMES, Math.round(seconds * MOTION_FPS)));
  function motionFrames(spec) {
    const count = frameCount(spec.seconds);
    const base = spec.base;
    const tracks = spec.tracks.map(track => {
      const layer = base.find(l => l.id === track.layerId);
      const b = layer && inkBounds(layer.strokes);
      return { ...track, layer, baseStrokes: layer ? layer.strokes.slice() : [], pivot: b ? { px: (b.x + b.w / 2) / W, py: (b.y + b.h / 2) / H } : { px: 0.5, py: 0.5 },
        size: b ? { w: b.w, h: b.h } : { w: 100, h: 100 }, walk: { x: 0, y: 0, f: -1, dist: 0, m: 0 },
        bones: GAITS[track.gait] && b ? (rigFor(layer)?.bones || []).map(bone => ({ part: bone.part, s: bone.strokes,
          px: (b.x + bone.px * b.w) / W, py: (b.y + bone.py * b.h) / H })) : [] };
    }).filter(track => track.layer);
    const fx = spec.effects || [];
    const withEffects = (stack, f) => (fx.length ? [...stack, ...fx.map(id => fxLayer(id, f))] : stack);
    const lim = v => Math.round(v * 1e5) / 1e5;
    return Array.from({ length: count }, (_, f) => {
      if (f === 0) { // every clip starts exactly as drawn
        for (const track of tracks) if (GAITS[track.gait]) gaitStep(track.walk, GAITS[track.gait], track.size.w, track.size.h, track.pivot.px * W, track.pivot.py * H, 0, MOTION_FPS);
        return withEffects(base, 0);
      }
      const t = f / (count - 1);
      return withEffects(base.map(layer => {
        const props = { visible: layer.visible, opacity: layer.opacity, asset: layer.asset, backdrop: layer.backdrop };
        const track = tracks.find(tr => tr.layer === layer);
        if (!track) return newLayer(layer.name, { ...props, strokes: layer.strokes.slice() });
        let xf = xfAt(track.keys, t, spec.strength, track.pivot);
        const g = GAITS[track.gait];
        if (g) {
          const o = gaitStep(track.walk, g, track.size.w, track.size.h, (xf.px + xf.x) * W, (xf.py + xf.y) * H, f, MOTION_FPS);
          xf = { ...xf, y: lim(clampTo(xf.y + o.dy / H, -2, 2)), sx: lim(signedScale(xf.sx * o.sx)), sy: lim(signedScale(xf.sy * o.sy)) };
        }
        const bend = track.bones.map(bone => ({ s: bone.s, r: lim(clampTo(rigTurns(bone.part, g, track.walk, f, MOTION_FPS), -180, 180)), px: lim(bone.px), py: lim(bone.py) }))
          .filter(item => item.r);
        const strokes = poseXf(bendStrokes(track.baseStrokes, bend), xf);
        return newLayer(layer.name, { ...props, strokes, xf, ...(bend.length ? { bend } : {}), xfBase: track.baseStrokes, xfStrokes: strokes.slice() });
      }), f);
    });
  }
  // Saving: a frame layer that still matches "frame 1's layer" (as is, or posed) is stored as a reference.
  const sameStrokes = (a, b) => a === b || (!!a && !!b && a.length === b.length && a.every((s, i) => s === b[i]));
  function compactStack(stack, first) {
    return stack.map(layer => {
      const meta = { name: layer.name, visible: layer.visible, opacity: layer.opacity,
        ...(layer.asset ? { asset: layer.asset } : {}), ...(layer.backdrop ? { backdrop: layer.backdrop } : {}) };
      if (layer.xf && sameStrokes(layer.strokes, layer.xfStrokes)) {
        const ref = first.findIndex(base => sameStrokes(base.strokes, layer.xfBase));
        if (ref >= 0) return { ...meta, strokes: [], ref, xf: layer.xf, ...(layer.bend?.length ? { bend: layer.bend } : {}) };
      }
      if (layer.strokes.length) {
        const ref = first.findIndex(base => sameStrokes(base.strokes, layer.strokes));
        if (ref >= 0) return { ...meta, strokes: [], ref };
      }
      return { ...meta, strokes: layer.strokes };
    });
  }
  // Loading: resolve references; frames share frame 1's stroke objects so they compact again on the next save.
  function expandRecord(record) {
    const first = record.layers;
    return [first, ...(record.frames || []).map(frame => frame.layers.map(layer => {
      if (layer.ref == null) return layer;
      const base = first[layer.ref];
      if (!base) return { ...layer, strokes: [] };
      if (!layer.xf) return { ...layer, strokes: base.strokes.slice() };
      const strokes = poseXf(bendStrokes(base.strokes, layer.bend), layer.xf);
      return { ...layer, strokes, xfBase: base.strokes, xfStrokes: strokes.slice() };
    }))];
  }
  // Each moving layer's path across the frames (its pivot, posed), and the frames that are keyframes.
  function motionPaths(stacks, tracks) {
    return tracks.map(track => {
      const count = stacks.length;
      const points = stacks.map((stack, f) => {
        const layer = stack.find(l => l.name === track.name);
        if (layer?.xf) return { x: (layer.xf.px + layer.xf.x) * W, y: (layer.xf.py + layer.xf.y) * H };
        const b = layer && inkBounds(layer.strokes);
        return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
      });
      const keys = (track.keys || []).map(k => ({ frame: Math.round(k.t * (count - 1)), label: k.label || '', t: k.t }));
      return { name: track.name, points, keys };
    });
  }
  // Canvas pixels per screen pixel: on a phone the 1000-px canvas shows ~350 px wide, so marks scale up to stay readable.
  const mathScale = shown => Math.max(1, Math.min(2.6, W / Math.max(1, shown)));
  function drawMath(c, paths, at, count, { timeline = true, scale = 1 } = {}) {
    const k = scale;
    c.save();
    c.font = `600 ${Math.round(13 * k)}px system-ui, sans-serif`;
    const labelled = [];
    for (const path of paths) {
      // Spacing: one dot per frame. Close dots = slow, far apart = fast.
      c.strokeStyle = 'rgba(109, 40, 217, 0.35)';
      c.lineWidth = 2 * k;
      c.setLineDash([3 * k, 5 * k]);
      c.beginPath();
      path.points.forEach((p, i) => { if (p) (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); });
      c.stroke();
      c.setLineDash([]);
      path.points.forEach((p, i) => {
        if (!p) return;
        c.fillStyle = i === at ? '#6d28d9' : 'rgba(109, 40, 217, 0.55)';
        c.beginPath();
        c.arc(p.x, p.y, (i === at ? 5 : 2.5) * k, 0, Math.PI * 2);
        c.fill();
      });
      for (const key of path.keys) {
        const p = path.points[key.frame];
        if (!p) continue;
        const d = 6 * k;
        c.save();
        c.translate(p.x, p.y);
        c.rotate(Math.PI / 4);
        c.fillStyle = '#c3f192';
        c.strokeStyle = '#0b2422';
        c.lineWidth = 1.5 * k;
        c.fillRect(-d, -d, 2 * d, 2 * d);
        c.strokeRect(-d, -d, 2 * d, 2 * d);
        c.restore();
        // One label per neighborhood, never on top of another (or the timeline): a crowd of labels teaches nothing.
        if (!key.label || key.label === 'start') continue;
        const w = c.measureText(key.label).width + 12 * k, h = 20 * k;
        const lx = Math.min(W - w - 4, p.x + 10 * k), ly = Math.min(H - h - 4, Math.max(timeline ? 18 + 30 * k : 4, p.y - 26 * k));
        if (labelled.some(q => lx < q.x + q.w + 6 && q.x < lx + w + 6 && ly < q.y + q.h + 4 && q.y < ly + h + 4)) continue;
        labelled.push({ x: lx, y: ly, w, h });
        c.fillStyle = 'rgba(11, 36, 34, 0.8)';
        c.fillRect(lx, ly, w, h);
        c.fillStyle = '#e9f2ec';
        c.fillText(key.label, lx + 6 * k, ly + 15 * k);
      }
    }
    if (timeline && count > 1) {
      // A timeline: every frame a tick, keyframes as diamonds, the playhead in violet.
      const x0 = 12 + 120 * k, x1 = W - 12, y = 12 + 15 * k, step = (x1 - x0) / (count - 1);
      c.fillStyle = 'rgba(11, 36, 34, 0.72)';
      c.fillRect(x0 - 10, 12, x1 - x0 + 10, 30 * k);
      c.fillStyle = 'rgba(233, 242, 236, 0.45)';
      for (let i = 0; i < count; i++) c.fillRect(x0 + i * step - 0.5, y - 4 * k, 1, 8 * k);
      for (const key of new Set(paths.flatMap(path => path.keys.map(k2 => k2.frame)))) {
        c.save();
        c.translate(x0 + key * step, y);
        c.rotate(Math.PI / 4);
        c.fillStyle = '#c3f192';
        c.fillRect(-4 * k, -4 * k, 8 * k, 8 * k);
        c.restore();
      }
      if (at >= 0) {
        c.fillStyle = '#a78bfa';
        c.fillRect(x0 + Math.min(at, count - 1) * step - 1.5 * k, 14, 3 * k, 30 * k - 4);
      }
    }
    c.restore();
  }
  function previewMotion(directed, { take = true } = {}) {
    if (take) {
      takes = [...takes, directed].slice(-12);
      takeAt = takes.length - 1;
      message('drawing-status', '');
    }
    // A take keeps the move as directed (Faster and Slower change its own length); the shot is never under MIN_SHOT.
    const spec = fillShot(directed);
    stopPlay();
    stopMotionPreview();
    const stacks = motionFrames(spec);
    motionDraft = { spec, stacks, at: 0, timer: null, paths: motionPaths(stacks, spec.tracks) };
    motionDraft.timer = setInterval(() => {
      motionDraft.at = (motionDraft.at + 1) % (motionDraft.stacks.length + 6); // a short hold on the last pose
      renderOverlay();
    }, 1000 / MOTION_FPS);
    updateHud();
    renderTray();
    renderTakes();
    renderFxChips();
    if (spec.change) message('drawing-status', spec.change, false, [{ label: '\u25c6 How it moves', tip: 'How it moves|Keyframes, in-betweens, and spacing, shown on your shot.', run: () => explainScene() }]);
    // Closing the sheet hands focus back to the Animate button; Enter must mean "keep", not "reopen".
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function paintMotionPreview() {
    const { stacks, paths } = motionDraft;
    const at = Math.min(motionDraft.at, stacks.length - 1);
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, W, H);
    const k = mathScale(canvas.getBoundingClientRect().width);
    for (const path of motionDraft.spec.paths || []) drawTrail(octx, path.points, k, { faint: true });
    paintStack(octx, stacks[at]);
    if (showMath) drawMath(octx, paths, at, stacks.length, { scale: k });
    paintTargetGlow(stacks[at], k);
    octx.save();
    octx.fillStyle = 'rgba(11, 36, 34, 0.85)';
    octx.fillRect(12, 12, 116 * k, 30 * k);
    octx.fillStyle = '#c3f192';
    octx.font = `650 ${Math.round(13 * k)}px system-ui, sans-serif`;
    octx.fillText(`${(at / MOTION_FPS).toFixed(1)} s \u00b7 ${at + 1}/${stacks.length}`, 12 + 9 * k, 12 + 20 * k);
    octx.restore();
  }
  function stopMotionPreview() {
    if (!motionDraft) return;
    clearInterval(motionDraft.timer);
    motionDraft = null;
    renderOverlay();
    updateHud();
  }
  const directedTake = () => takes[takeAt] || motionDraft?.spec;
  function restrength(delta) {
    if (!motionDraft) return;
    const from = directedTake();
    const spec = { ...from, strength: Math.round(Math.max(0.4, Math.min(1.9, from.strength + delta)) * 10) / 10 };
    takes[takeAt] = spec;
    previewMotion(spec, { take: false });
  }
  function motionRecord(spec) {
    const clean = v => Math.round(v * 1e4) / 1e4;
    return { by: spec.by, prompt: (spec.prompt || '').slice(0, 300), note: (spec.title || spec.note || spec.label || '').slice(0, 160),
      seconds: Math.round(frameCount(spec.seconds) / MOTION_FPS * 100) / 100, fps: MOTION_FPS, strength: spec.strength,
      tracks: spec.tracks.slice(0, 4).map(track => ({ name: track.name.slice(0, 40), keys: track.keys.slice(0, 24).map(k => ({
        t: clean(Math.max(0, Math.min(1, k.t))), x: clean(Math.max(-1.5, Math.min(1.5, k.x))), y: clean(Math.max(-1.5, Math.min(1.5, k.y))),
        sx: clean(signedScale(k.sx)), sy: clean(signedScale(k.sy)), r: clean(Math.max(-1080, Math.min(1080, k.r))),
        label: (k.label || '').slice(0, 24) })), ...(track.gait ? { gait: track.gait } : {}) })), ...(spec.effects?.length ? { effects: spec.effects.slice(0, MAX_FX) } : {}) };
  }
  function keepMotion() {
    if (!motionDraft) return;
    const { spec, stacks } = motionDraft;
    const replaced = frames.length;
    const kept = takeAt + 1, of = takes.length;
    const shelf = { takes, at: takeAt };
    takes = [];
    takeAt = -1;
    stopMotionPreview();
    renderTakes();
    pushUndo();
    frames = stacks;
    frameIndex = 0;
    layers = frames[0];
    activeId = (layers.find(layer => layer.name === spec.tracks[0].name) || layers[layers.length - 1]).id;
    fps = MOTION_FPS;
    $('fps').value = String(MOTION_FPS);
    sceneMotion = motionRecord(spec);
    sceneSketch = sketchRecord(spec);
    keptPaths = spec.by === 'path' ? { paths: spec.paths } : null;
    if (!editing || editing.kind !== 'shot') {
      // One tap to save: a readable scene code ("LittleFox_0413") and the direction as its notes (Voyage reads those too).
      if (!CODE.test($('title').value.trim())) $('title').value = shotName();
      if (!$('description').value.trim() && spec.by !== 'path') $('description').value = (spec.title || spec.prompt || spec.note || '').slice(0, 200);
    }
    recount();
    rebuildOnion();
    rebuildAll();
    renderFrames();
    if (saveKind !== 'shot' && !editing) setSaveKind('shot');
    renderSaveKind();
    $('save-card').open = true;
    const names = spec.tracks.map(track => track.name).join(', ');
    const keyCount = spec.tracks.reduce((n, track) => n + track.keys.length, 0);
    const detail = `${spec.by === 'ai' ? `"${spec.prompt}"` : spec.label}: ${frames.length} frames (${keyCount} keyframes) at ${MOTION_FPS} fps, moving ${names}`
      + `${spec.strength !== 1 ? ` (strength ${spec.strength}\u00d7)` : ''}${spec.effects?.length ? `, effects: ${fxList(spec.effects).map(fx => fx.name).join(', ')} (code, no AI)` : ''}`;
    logEvent(spec.by === 'ai' ? 'ai' : 'artist', spec.by === 'ai' ? 'Motion, accepted' : spec.by === 'path' ? 'Motion path' : 'Motion preset', detail);
    renderTray();
    message('drawing-status', `\ud83c\udfac Kept ${of > 1 ? `take ${kept} of ${of}` : 'it'}: ${frames.length} frames, ${(frames.length / MOTION_FPS).toFixed(1)} s${replaced > 1 ? `, replacing ${replaced}` : ''}. Every frame is yours to redraw. Space plays.`, false,
      [{ label: of > 1 ? '\u21b6 Undo, back to the takes' : '\u21b6 Undo', tip: 'Undo|Your drawing exactly as it was, with every take still here to choose from.', run: () => {
        undo();
        // Nothing was lost: the takes come back, on the one that was kept.
        takes = shelf.takes;
        takeAt = shelf.at;
        previewMotion(takes[takeAt], { take: false });
        message('drawing-status', of > 1 ? 'Undone. Your takes are back: pick another, or change one.' : 'Undone. The preview is back: keep it, change it, or discard it.');
      } },
        { label: '\u27e8/\u27e9 Edit as code', tip: 'Edit as code|This animation is a p5.js sketch: keyframes as numbers. Change one, then bake.', run: () => openTakeAsCode() },
        { label: '\u25c6 How it moves', tip: 'How it moves|Keyframes, in-betweens, and spacing, shown on your shot.', run: () => explainScene() }]);
    setTool(spec.by === 'path' ? 'path' : 'move');
    play();
  }
  function skipMotion() {
    if (!motionDraft) return;
    const { spec } = motionDraft;
    if (spec.by === 'ai') logEvent('ai', 'Motion, skipped', `${takes.length > 1 ? `${takes.length} takes, ` : ''}"${spec.prompt}"`);
    takes = [];
    takeAt = -1;
    stopMotionPreview();
    renderTray();
    renderTakes();
  }

  // ---------------------------------------------------------------- paths: drag a layer along your finger's trail
  // The finger is the animator: drag from something you drew and it travels that trail over the shot. The trail
  // becomes ordinary keyframes (offsets along it, evenly spaced or at your own pace, optionally turning with it),
  // so a path take previews, keeps, saves, and exports as p5.js code exactly like any other take. No AI.
  const MIN_SHOT = 10; // seconds: every shot is at least this long
  const PATH_KEYS = 24; // backend/models.py MAX_MOTION_KEYS
  const MAX_TRACKS = 4; // backend/models.py MotionRecord.tracks
  const pathOpts = { timing: 'steady' };
  let pathDraft = null; // { layer, points: [{ x, y, ms }] in canvas px } while a path is being drawn
  let keptPaths = null; // the trails behind the kept path take: another path adds to them instead of starting over
  // Shots are never shorter than MIN_SHOT: a shorter move plays out, then holds its last pose.
  function fillShot(spec) {
    if (spec.seconds >= MIN_SHOT) return spec;
    const f = spec.seconds / MIN_SHOT;
    return { ...spec, seconds: MIN_SHOT, tracks: spec.tracks.map(track => {
      const keys = track.keys.map(k => ({ ...k, t: r4(k.t * f) }));
      const last = keys[keys.length - 1];
      if (keys.length < PATH_KEYS) keys.push({ ...last, t: 1, label: 'hold' });
      else last.t = 1;
      return { ...track, keys };
    }) };
  }
  const trailLength = points => points.reduce((n, p, i) => n + (i ? Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) : 0), 0);
  // A trail becomes keyframes: where it is along the trail (eased in and out, or at your finger's own pace), which
  // way it faces (it turns around when it changes direction), and how it leans (forward with speed, into curves).
  // Fly turns to follow the trail instead. Returns the keys and how long the trip takes at the gait's speed.
  function pathKeys(raw, { timing, gait }) {
    const g = GAITS[gait] || GAITS.glide;
    let pts = raw;
    for (let pass = 0; pass < 2; pass++) { // a steadier hand: 1-2-1 smoothing; the ends stay where they were drawn
      pts = pts.map((p, i) => (i && i < pts.length - 1
        ? { x: (pts[i - 1].x + 2 * p.x + pts[i + 1].x) / 4, y: (pts[i - 1].y + 2 * p.y + pts[i + 1].y) / 4, ms: p.ms } : p));
    }
    const along = pts.map((p, i) => (i ? Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0));
    for (let i = 1; i < along.length; i++) along[i] += along[i - 1];
    const total = along[along.length - 1];
    const span = Math.max(1, pts[pts.length - 1].ms - pts[0].ms);
    const seconds = Math.round(clampTo(total / g.speed, 3, MIN_SHOT) * MOTION_FPS) / MOTION_FPS;
    const sample = (measure, value) => {
      let i = 0;
      while (i < pts.length - 2 && measure(i + 1) < value) i++;
      const a = measure(i), b = measure(i + 1), f = b > a ? clampTo((value - a) / (b - a), 0, 1) : 0;
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f };
    };
    // Slow out, cruise, slow in: speed ramps up over the first 15% and down over the last 15%.
    const ease = u => { const a = 0.15, v = 1 / (1 - a); return u < a ? v * u * u / (2 * a) : u > 1 - a ? 1 - v * (1 - u) ** 2 / (2 * a) : v * (u - a / 2); };
    const n = clampTo(Math.round(total / 28) + 2, 6, PATH_KEYS);
    const spots = Array.from({ length: n }, (_, k) => (timing === 'mine'
      ? sample(i => pts[i].ms - pts[0].ms, k / (n - 1) * span) : sample(i => along[i], ease(k / (n - 1)) * total)));
    const near = k => [spots[Math.max(0, k - 1)], spots[Math.min(n - 1, k + 1)]];
    const fast = Math.max(1, ...spots.map((_, k) => { const [a, b] = near(k); return Math.hypot(b.x - a.x, b.y - a.y); }));
    let first = 0, dir = 0, heading = null, previous = 0;
    const keys = spots.map((p, k) => {
      const [a, b] = near(k), dx = b.x - a.x, dy = b.y - a.y, run = Math.hypot(dx, dy);
      // Facing: set by the first clear move left or right (as drawn), flipped when it clearly heads the other way.
      if (Math.abs(dx) > 3 && Math.abs(dx) > run * 0.4) { dir = Math.sign(dx); if (!first) first = dir; }
      const facing = g.face && first && dir && dir !== first ? -1 : 1;
      let bend = 0, pitch = 0;
      if (run > 0.5) {
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        if (heading === null) heading = previous = angle;
        bend = angle - previous;
        while (bend > 180) bend -= 360;
        while (bend < -180) bend += 360;
        previous = angle;
        pitch = Math.atan2(dy, Math.abs(dx)) * 180 / Math.PI * (dir || first || 1); // nose up or down, from level flight
      }
      const speed = run / fast, level = run ? Math.abs(dx) / run : 0;
      const r = g.turn ? clampTo(pitch * 0.85, -60, 60) : (dir || 1) * g.lean * speed * level + clampTo(bend * g.bank, -14, 14);
      const label = k === 0 ? 'start' : k === n - 1 ? 'settle' : timing !== 'mine' && k === 1 ? 'slow out' : timing !== 'mine' && k === n - 2 ? 'slow in' : '';
      return { t: r4(k / (n - 1)), x: r4(clampTo((p.x - spots[0].x) / W, -1.5, 1.5)), y: r4(clampTo((p.y - spots[0].y) / H, -1.5, 1.5)),
        sx: k ? facing : 1, sy: 1, r: k && k < n - 1 ? r4(r) : 0, label };
    });
    return { keys, seconds };
  }
  // Every new shot moves on its own: a first take across the stage, in its gait, limbs and all. Keep it, pick
  // another gait, or drag your own path. `turn` alternates the direction from one shot to the next.
  function autoTake(layer, turn = 0, lead = '') {
    const b = inkBounds(layer.strokes);
    if (!b || motionDraft) return;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let dir = cx < W / 2 ? 1 : -1;
    if (turn % 2) dir = -dir;
    const room = dir > 0 ? W - b.x - b.w - 24 : b.x - 24;
    const dist = Math.max(W * 0.22, Math.min(W * 0.45, room));
    const gait = gaitFor(layer);
    const swoop = gait === 'fly' ? H * 0.12 : gait === 'glide' ? H * 0.04 : 0;
    const points = Array.from({ length: 48 }, (_, i) => {
      const u = i / 47;
      return { x: cx + dir * dist * u, y: cy - swoop * Math.sin(u * Math.PI * (gait === 'fly' ? 2 : 1)), ms: u * 2000 };
    });
    const spec = pathSpec(layers.filter(item => !item.fx), [{ layerId: layer.id, points, gait }], []);
    spec.change = `${lead}\u2726 A first take: ${layer.name} ${GAITS[gait].verb} ${dir > 0 ? 'right' : 'left'}${rigFor(layer) ? ', limbs and all' : ''}. `
      + 'Keep it (Enter), switch Walk \u00b7 Hop \u00b7 Glide \u00b7 Fly, or drag your own path.';
    previewMotion(spec);
  }
  // The flipbook: your frames as a little book bound on the left. Drag across it to riffle the pages (each one turns
  // on its spine), or press play. Works on any shot that moves, saved or not. Printing is one button inside.
  const FLIPBOOK_TIP = 'Flipbook|Your shot as a little book: drag across the pages to riffle them, or press play. Print it from there.';
  const flipbookUrl = id => `/api/shots/${encodeURIComponent(id)}/flipbook.pdf`;
  let flipbookTab = null;
  const book = { stacks: [], at: 0, fps: 12, timer: 0, id: null, turning: false };
  function drawPage(target, i) {
    const box = target.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(200, Math.round(box.width * dpr)), h = Math.round(w * H / W);
    if (target.width !== w) { target.width = w; target.height = h; }
    const g = target.getContext('2d');
    g.setTransform(w / W, 0, 0, h / H, 0, 0);
    g.fillStyle = '#fffdf8';
    g.fillRect(0, 0, W, H);
    const stack = book.stacks[i];
    if (stack) paintStack(g, stack);
    g.fillStyle = '#9a8f78';
    g.font = '600 22px ui-rounded, system-ui, sans-serif';
    g.textAlign = 'right';
    g.fillText(String(i + 1), W - 24, H - 22); // penciled page number, like a real flipbook
  }
  function showPage(i, { turn = false } = {}) {
    i = clampTo(i, 0, book.stacks.length - 1);
    const page = $('fb-page');
    $('fb-scrub').value = String(i);
    $('fb-count').textContent = `${i + 1} / ${book.stacks.length}`;
    if (!turn || book.turning || i <= book.at) { // jumping back, or mid-turn: no animation, just the page
      page.classList.remove('turn');
      book.turning = false;
      book.at = i;
      drawPage(page, i);
      drawPage($('fb-under'), Math.min(i + 1, book.stacks.length - 1));
      return;
    }
    drawPage($('fb-under'), i); // the next page is already underneath; the top one turns away
    book.turning = true;
    book.at = i;
    page.style.setProperty('--turn', `${Math.round(Math.min(220, 900 / book.fps))}ms`);
    page.classList.remove('turn');
    void page.offsetWidth;
    page.classList.add('turn');
  }
  $('fb-page').addEventListener('animationend', () => {
    book.turning = false;
    $('fb-page').classList.remove('turn');
    drawPage($('fb-page'), book.at);
  });
  function stopBook() {
    clearTimeout(book.timer);
    book.timer = 0;
    $('fb-play').textContent = '\u25b6 Play';
  }
  function playBook() {
    if (book.timer) { stopBook(); return; }
    $('fb-play').textContent = '\u23f8 Pause';
    if (book.at >= book.stacks.length - 1) showPage(0);
    const tick = () => {
      if (book.at >= book.stacks.length - 1) { book.timer = setTimeout(() => { showPage(0); book.timer = setTimeout(tick, 1000 / book.fps); }, 700); return; }
      showPage(book.at + 1, { turn: true });
      book.timer = setTimeout(tick, 1000 / book.fps);
    };
    book.timer = setTimeout(tick, 1000 / book.fps);
  }
  function openBook(stacks, { title = 'Your shot', id = null } = {}) {
    if (stacks.length < 2) { flashTray('\ud83c\udf9e Make it move first: drag a path, then keep the take.'); return; }
    stopBook();
    Object.assign(book, { stacks, id, at: 0, turning: false });
    $('fb-title').textContent = title;
    $('fb-scrub').max = String(stacks.length - 1);
    if (!$('flipbook').open) $('flipbook').showModal();
    requestAnimationFrame(() => { showPage(0); playBook(); });
  }
  // The shot on the canvas (saved or not).
  function flipbookNow() {
    if (motionDraft) keepMotion();
    openBook(frames.map(stack => stack.slice()), { title: $('title').value.trim() || (editing?.kind === 'shot' ? editing.code : 'Your shot'),
      id: editing?.kind === 'shot' && revision === savedRevision ? editing.id : null });
  }
  // A saved shot from your library (an asset's page), without opening it on the canvas.
  async function openFlipbook(id, title = '') {
    try {
      const record = await api(`/api/shots/${encodeURIComponent(id)}`);
      openBook(expandRecord(record), { title: title || record.code || record.name || 'Your shot', id });
    } catch (error) {
      flashTray(error.message, true);
    }
  }
  // Paper: every page on printable sheets (a PDF the server draws). An unsaved shot is saved first, straight into
  // the tab opened on the tap (so no popup blocker).
  function printFlipbook() {
    if (book.id) { window.open(flipbookUrl(book.id), '_blank', 'noopener'); return; }
    if (offline) { flashTray(OFFLINE_NOTE, true); return; }
    $('flipbook').close();
    flipbookTab = window.open('', '_blank');
    if (flipbookTab) {
      flipbookTab.opener = null;
      flipbookTab.document.title = 'Your flipbook';
      flipbookTab.document.body.textContent = 'Saving your shot, then drawing its printable pages\u2026';
    }
    if (saveKind !== 'shot') setSaveKind('shot');
    flashTray('\ud83d\udda8 Saving the shot first, then its printable pages open\u2026');
    $('save-form').requestSubmit();
  }
  $('fb-play').addEventListener('click', playBook);
  $('fb-print').addEventListener('click', printFlipbook);
  $('fb-close').addEventListener('click', () => $('flipbook').close());
  $('flipbook').addEventListener('close', stopBook);
  $('fb-scrub').addEventListener('input', () => { stopBook(); showPage(Number($('fb-scrub').value)); });
  document.querySelectorAll('.fb-speed [data-fps]').forEach(button => button.addEventListener('click', () => {
    book.fps = Number(button.dataset.fps);
    document.querySelectorAll('.fb-speed [data-fps]').forEach(other => other.setAttribute('aria-checked', String(other === button)));
  }));
  $('flipbook').addEventListener('keydown', event => {
    if (event.key === ' ') { event.preventDefault(); playBook(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); stopBook(); showPage(book.at + 1, { turn: true }); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); stopBook(); showPage(book.at - 1); }
  });
  { // Riffle: drag across the book, a page per few pixels, forward or back, the way a thumb flips paper.
    let from = null;
    $('fb-book').addEventListener('pointerdown', event => { stopBook(); from = { x: event.clientX, at: book.at }; $('fb-book').setPointerCapture(event.pointerId); });
    $('fb-book').addEventListener('pointermove', event => {
      if (!from) return;
      const step = Math.max(4, $('fb-book').clientWidth / Math.max(24, book.stacks.length));
      const i = clampTo(from.at + Math.round((from.x - event.clientX) / step), 0, book.stacks.length - 1);
      if (i !== book.at) showPage(i, { turn: i > book.at });
    });
    const end = () => { from = null; };
    $('fb-book').addEventListener('pointerup', end);
    $('fb-book').addEventListener('pointercancel', end);
  }
  // What a layer is likely to do: from its rig first (a bird flies, legs walk), else from its name and asset type.
  function gaitFor(layer) {
    const kind = rigFor(layer)?.kind;
    if (kind === 'bird') return 'fly';
    if (kind === 'biped' || kind === 'quadruped') return /rabbit|bunny|frog|kangaroo|grasshopper/i.test(layer.name) ? 'hop' : 'walk';
    if (kind === 'fish') return 'glide';
    return defaultGait(layer);
  }
  function defaultGait(layer) {
    const name = layer?.name || '';
    if (/bird|bat|bee|butterfly|plane|jet|rocket|ship|ufo|dragon|ghost|kite|balloon|cloud|fairy|star/i.test(name)) return 'fly';
    if (/rabbit|bunny|frog|kangaroo|ball|bounce|grasshopper|cricket|kid|jump/i.test(name)) return 'hop';
    const starType = layer?.asset && shotStar?.id === layer.asset.asset_id ? shotStar.type : '';
    if (starType === 'character' || /fox|cat|dog|man|woman|girl|boy|person|robot|bear|monster|knight|hero|horse|cow|pig|duck|chicken|figure/i.test(name)) return 'walk';
    return 'glide';
  }
  // A trail in plain words ("travels right, zig-zagging up and down"): search reads it, and so does the AI that
  // describes the shot, since a picture of frame 1 can't show what happens.
  function trailWords(points, gait) {
    const first = points[0], last = points[points.length - 1];
    const dx = (last.x - first.x) / W, dy = (last.y - first.y) / H;
    const bits = [];
    const across = Math.abs(dx) > 0.12 ? (dx > 0 ? 'right' : 'left') : '';
    const vertical = Math.abs(dy) > 0.12 ? (dy > 0 ? 'down' : 'up') : '';
    const verb = (GAITS[gait] || GAITS.glide).verb;
    bits.push(across || vertical ? `${verb} ${[across, vertical].filter(Boolean).join(' and ')}` : `${verb} around and comes back`);
    let turns = 0, swing = 0, previous = null, sign = 0;
    for (let i = 4; i < points.length; i += 4) {
      const a = Math.atan2(points[i].y - points[i - 4].y, points[i].x - points[i - 4].x);
      if (previous !== null) { let d = a - previous; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; turns += d; }
      previous = a;
      const s = Math.sign(points[i].y - points[i - 4].y);
      if (s && s !== sign) { swing += sign ? 1 : 0; sign = s; }
    }
    if (Math.abs(turns) > Math.PI * 1.7) bits.push(`looping ${turns > 0 ? 'clockwise' : 'counterclockwise'}`);
    else if (swing >= 3) bits.push('zig-zagging up and down');
    else if (swing >= 1) bits.push('in an arc');
    return bits.join(', ');
  }
  const pathHow = () => (pathOpts.timing === 'mine' ? 'at your pace' : 'easing in and out');
  function pathSpec(base, paths, effects = []) {
    const tracks = [];
    let seconds = 3;
    for (const path of paths) {
      const layer = base.find(item => item.id === path.layerId);
      if (!layer) continue;
      const made = pathKeys(path.points, { timing: pathOpts.timing, gait: path.gait });
      seconds = Math.max(seconds, made.seconds);
      tracks.push({ layerId: layer.id, name: layer.name, keys: made.keys, gait: path.gait });
    }
    const names = tracks.map(track => track.name).join(' + ');
    const words = paths.map(path => {
      const layer = base.find(item => item.id === path.layerId);
      return layer ? `${layer.name} ${trailWords(path.points, path.gait)}` : '';
    }).filter(Boolean).join('; ');
    const how = tracks.map(track => `${GAITS[track.gait].icon} ${track.name} ${GAITS[track.gait].verb}`).join(', ');
    return { by: 'path', label: `\u3030 ${names}`, take: `\u3030 ${names}`, title: (words || `${names} on a path`).slice(0, 120),
      note: `${words} (a drawn path, ${pathHow()})`.slice(0, 160), seconds, strength: 1, base, tracks, paths, effects,
      change: `${how}: ${seconds.toFixed(1)} s along your path, ${pathHow()}${seconds < MIN_SHOT ? `, then a breather until ${MIN_SHOT} s` : ''}. No AI. `
        + 'Drag another layer to move it too, then keep it.' };
  }
  function startPath(event, point) {
    if (frames.length > 1 && frameIndex && !motionDraft) showFrame(0); // paths start from frame 1, as drawn
    const can = movable();
    const hit = pickLayer(point);
    // Grabbing inside a drawing counts too (the middle of a ring has no ink): the smallest box wins.
    const pad = 12, x = point.x * W, y = point.y * H;
    const area = layer => { const b = inkBounds(layer.strokes); return b ? b.w * b.h : Infinity; };
    const boxed = can.filter(item => {
      const b = inkBounds(item.strokes);
      return b && x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
    }).sort((a, b) => area(a) - area(b))[0];
    const layer = can.includes(hit) ? hit : boxed || can.find(item => item.id === activeId) || can[can.length - 1];
    if (!layer) {
      flashTray('\u3030 Draw or place something first, then drag it along a path.', true);
      return;
    }
    activeId = layer.id;
    pointer = event.pointerId;
    canvas.setPointerCapture(pointer);
    pathDraft = { layer, points: [{ x: point.x * W, y: point.y * H, ms: performance.now() }] };
    renderOverlay();
  }
  function extendPath(event) {
    const samples = event.getCoalescedEvents?.();
    for (const sample of samples?.length ? samples : [event]) {
      const p = normPoint(sample), last = pathDraft.points[pathDraft.points.length - 1];
      const x = clampTo(p.x, 0, 1) * W, y = clampTo(p.y, 0, 1) * H;
      if (Math.hypot(x - last.x, y - last.y) >= 3 && pathDraft.points.length < 2000) pathDraft.points.push({ x, y, ms: performance.now() });
    }
    renderOverlay();
  }
  let pathsDrawn = 0;
  async function commitPath() {
    const { layer, points } = pathDraft;
    pathDraft = null;
    if (points.length < 2 || trailLength(points) < 12) {
      renderOverlay();
      flashTray('\u3030 Drag farther: the trail you draw is where it travels.');
      return;
    }
    pathsDrawn++;
    if (rigKey(layer) && !rigCache.has(rigKey(layer)) && !offline) {
      flashTray(`\u2726 Finding ${layer.name}\u2019s legs, arms, and tail (once)\u2026`);
      await ensureRig(layer);
    }
    const draft = motionDraft?.spec;
    let base = layers, prior = null;
    if (draft) {
      if (draft.base.includes(layer)) base = draft.base;
      if (draft.by === 'path' && draft.base === base) prior = draft;
    } else {
      base = layers.filter(item => !item.fx);
      const effects = sceneMotion?.effects || [];
      if (keptPaths && frameIndex === 0) {
        prior = { paths: keptPaths.paths.filter(path => base.some(item => item.id === path.layerId)), effects };
      } else prior = { paths: [], effects };
    }
    const extending = !!draft && prior === draft;
    const had = prior?.paths.find(path => path.layerId === layer.id);
    let paths = [...(prior ? prior.paths : []).filter(path => path.layerId !== layer.id), { layerId: layer.id, points, gait: had?.gait || gaitFor(layer) }];
    if (paths.length > MAX_TRACKS) {
      flashTray(`Up to ${MAX_TRACKS} paths per shot: the oldest one was let go.`);
      paths = paths.slice(-MAX_TRACKS);
    }
    const spec = pathSpec(base, paths, (prior || draft)?.effects || []);
    logEvent('artist', 'Drew a path', `${layer.name}: ${Math.round(trailLength(points))} px ${pathHow()}`);
    if (extending) {
      takes[takeAt] = spec;
      previewMotion(spec, { take: false });
      renderTakes();
    } else previewMotion(spec);
  }
  // The path the gait chips talk to: the layer you dragged last (or picked), else the newest path.
  const focusPath = spec => spec.paths.find(path => path.layerId === activeId) || spec.paths[spec.paths.length - 1];
  function setPathOption(change) {
    const spec = motionDraft?.spec;
    if (change.gait && spec?.by === 'path') {
      const focus = focusPath(spec);
      if (!focus || focus.gait === change.gait) return;
      const paths = spec.paths.map(path => (path === focus ? { ...path, gait: change.gait } : path));
      const next = pathSpec(spec.base, paths, spec.effects);
      takes[takeAt] = next;
      previewMotion(next, { take: false });
      renderTakes();
      return;
    }
    Object.assign(pathOpts, change);
    if (spec?.by !== 'path') return;
    const next = pathSpec(spec.base, spec.paths, spec.effects);
    takes[takeAt] = next;
    previewMotion(next, { take: false });
    renderTakes();
  }
  function drawTrail(c, points, k, { live = false, faint = false } = {}) {
    if (points.length < 2) return;
    const line = () => { c.beginPath(); points.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.stroke(); };
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.globalAlpha = faint ? 0.55 : 1;
    c.strokeStyle = 'rgba(124, 58, 237, 0.16)';
    c.lineWidth = 14 * k;
    line();
    c.strokeStyle = '#7c3aed';
    c.lineWidth = 3 * k;
    c.setLineDash([8 * k, 6 * k]);
    line();
    c.setLineDash([]);
    const dot = (p, color) => { c.fillStyle = color; c.strokeStyle = '#ffffff'; c.lineWidth = 2.5 * k; c.beginPath(); c.arc(p.x, p.y, 7 * k, 0, Math.PI * 2); c.fill(); c.stroke(); };
    dot(points[0], '#10b981');
    if (!live) dot(points[points.length - 1], '#f43f5e');
    c.restore();
  }
  // With the Path tool, everything that can travel wears a dashed outline: "drag me".
  function paintPathTargets(k) {
    octx.save();
    octx.strokeStyle = 'rgba(124, 58, 237, 0.55)';
    octx.lineWidth = 1.5 * k;
    octx.setLineDash([5 * k, 5 * k]);
    for (const layer of movable()) {
      const b = inkBounds(layer.strokes);
      if (b) octx.strokeRect(b.x - 6 * k, b.y - 6 * k, b.w + 12 * k, b.h + 12 * k);
    }
    octx.restore();
  }

  // ---------------------------------------------------------------- "How it moves": animation, demystified
  function explainScene() {
    if (motionDraft) return openExplain({ motion: motionRecord(motionDraft.spec), stacks: motionDraft.stacks, paths: motionDraft.paths });
    if (!sceneMotion || frames.length < 2) return;
    openExplain({ motion: sceneMotion, stacks: frames });
  }
  function openExplain({ motion, stacks, paths = null }) {
    const count = stacks.length;
    const fpsUsed = motion.fps || MOTION_FPS;
    const track = motion.tracks[0];
    const keyFrames = track.keys.map(k => ({ ...k, frame: Math.round(k.t * (count - 1)) }));
    const allKeys = new Set(motion.tracks.flatMap(tr => tr.keys.map(k => Math.round(k.t * (count - 1)))));
    const body = $('explain-body');
    const section = (num, title, text) => {
      const box = el('section', 'explain-step');
      box.append(el('h3', '', `${num} ${title}`), el('p', 'muted', text));
      body.append(box);
      return box;
    };
    body.replaceChildren();
    body.append(el('p', 'explain-direction', motion.by === 'ai' ? `\u2726 AI choreographed: "${motion.prompt}"`
      : motion.by === 'path' ? `\u3030 Your path: ${motion.note}` : `Preset: ${motion.note}`));
    if (motion.effects?.length) body.append(el('p', 'muted', `${fxList(motion.effects).map(fx => `${fx.icon} ${fx.name}`).join(' and ')}: an effect layer of tiny strokes, computed by code for every frame from a fixed seed. No AI, the same every time.`));

    const one = section('\u2460', 'Keyframes: the poses that matter',
      `${motion.by === 'ai' ? 'The AI' : motion.by === 'path' ? 'Your trail' : 'The preset'} ${motion.by === 'path' ? 'became' : 'chose'} ${track.keys.length} keyframes for ${track.name}${motion.tracks.length > 1 ? ` (and ${motion.tracks.slice(1).map(t => `${t.keys.length} for ${t.name}`).join(', ')})` : ''}. Each is a pose: where it is, how squashed, how turned.`);
    const strip = el('div', 'explain-keys');
    for (const key of keyFrames.slice(0, 10)) {
      const card = el('figure', 'explain-key');
      card.append(frameImage(stacks[key.frame], 150));
      card.append(el('figcaption', '', `${(key.frame / fpsUsed).toFixed(1)} s \u00b7 ${key.label || 'key'}`));
      strip.append(card);
    }
    one.append(strip);

    const two = section('\u2461', 'In-betweens: the frames in between',
      `This shot has ${count} frames: ${(count / fpsUsed).toFixed(1)} seconds at ${fpsUsed} frames a second. ${allKeys.size} are keyframes; the other ${count - allKeys.size} are in-betweens, computed on a smooth curve through the keys. Animators call it tweening. The computer does the tedious part; you (or your AI assistant) choose the poses.`);
    const film = el('div', 'explain-film');
    const every = Math.max(1, Math.ceil(count / 16));
    for (let f = 0; f < count; f += every) {
      const cell = el('span', `explain-frame${allKeys.has(f) ? ' key' : ''}`);
      cell.append(frameImage(stacks[f], 70), el('small', '', allKeys.has(f) ? `\u25c6 ${f + 1}` : String(f + 1)));
      film.append(cell);
    }
    two.append(film);

    const three = section('\u2462', 'Spacing is speed',
      'One dot per frame. Dots close together: slow. Far apart: fast. Bunching dots near a key is "slow in and slow out", the secret of motion that feels alive.');
    const map = document.createElement('canvas');
    map.width = W;
    map.height = H;
    map.className = 'explain-map';
    const m = map.getContext('2d');
    m.fillStyle = '#ffffff';
    m.fillRect(0, 0, W, H);
    m.globalAlpha = 0.35;
    paintStack(m, stacks[0]);
    m.globalAlpha = 1;
    drawMath(m, paths || motionPaths(stacks, motion.tracks), -1, count, { timeline: false, scale: mathScale(Math.min(window.innerWidth - 64, 860)) });
    three.append(map);

    const four = section('\u2463', 'Your drawing, moved. Never redrawn.',
      `Every frame is your own strokes, posed by numbers like these for ${track.name}. Grab any frame and change it: it's your animation.`);
    const table = el('table', 'explain-table');
    const head = el('tr');
    for (const label of ['Time', 'Beat', 'Move', 'Squash / stretch', 'Turn']) head.append(el('th', '', label));
    table.append(head);
    for (const key of keyFrames) {
      const row = el('tr');
      const pct = v => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;
      row.append(el('td', '', `${(key.frame / fpsUsed).toFixed(1)} s`), el('td', '', key.label || '\u2014'),
        el('td', '', `${pct(key.x)} \u2194  ${pct(key.y)} \u2195`), el('td', '', `${key.sx.toFixed(2)} \u00d7 ${key.sy.toFixed(2)}`), el('td', '', `${Math.round(key.r)}\u00b0`));
      table.append(row);
    }
    four.append(table);

    const used = [...new Set(motion.tracks.flatMap(tr => tr.keys.map(k => k.label)).filter(label => PRINCIPLES[label]))];
    if (used.length) {
      const five = section('\u2464', 'Principles of animation in this shot', 'The same ideas Disney animators wrote down in the 1930s.');
      const list = el('dl', 'explain-principles');
      for (const label of used) {
        const item = el('div');
        item.append(el('dt', '', label), el('dd', '', PRINCIPLES[label]));
        list.append(item);
      }
      five.append(list);
    }
    // The source of truth: frame 1 plus this code reproduce every frame above.
    const code = motionDraft ? sketchRecord(motionDraft.spec)?.code : sceneSketch?.code;
    if (code) {
      const six = section('\u27e8/\u27e9', 'The code that draws it', 'Frame 1 plus these lines reproduce every frame above. Nothing hidden: change a number, run it, bake it.');
      const pre = el('pre', 'explain-code');
      pre.textContent = code;
      const open = el('button', 'pill primary', '\u27e8/\u27e9 Edit in the Lab');
      open.type = 'button';
      open.addEventListener('click', () => { $('explain-sheet').close(); openTakeAsCode(); });
      six.append(pre, open);
    }
    $('explain-math').checked = showMath;
    $('explain-sheet').showModal();
  }
  $('explain-close').addEventListener('click', () => $('explain-sheet').close());
  $('explain-sheet').addEventListener('click', event => { if (event.target === $('explain-sheet')) $('explain-sheet').close(); });
  $('explain-math').addEventListener('change', () => { showMath = $('explain-math').checked; renderOverlay(); });
  $('explain-open').addEventListener('click', explainScene);

  // What can move: anything visible with ink that isn't scenery.
  const movable = () => layers.filter(layer => layer.visible && hasInk([layer]) && !isScenery(layer));
  function chosenTracks(keysFor, ids) {
    return layers.filter(layer => ids.has(layer.id)).map(layer => {
      const b = inkBounds(layer.strokes);
      const box = { x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H };
      return { layerId: layer.id, name: layer.name, box, keys: keysFor(box, layer) };
    });
  }

  // ---------------------------------------------------------------- shots: an asset on a fresh canvas, and a backdrop
  let savedBackdrops = [];
  const pickOption = (value, label) => {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  };
  function renderSceneBackdrops() {
    const select = $('scene-backdrop');
    const selected = select.value;
    const starters = STARTERS.filter(item => item.kind === 'shot' && item.id !== 'bounce');
    const mine = document.createElement('optgroup');
    mine.label = 'Your backdrops';
    mine.append(...savedBackdrops.map(item => pickOption(`asset:${item.id}`, item.name)));
    const kit = document.createElement('optgroup');
    kit.label = 'Starters';
    kit.append(...starters.map(item => pickOption(`starter:${item.id}`, `${item.icon} ${item.name}`)));
    select.replaceChildren(pickOption('', 'No backdrop'), ...(savedBackdrops.length ? [mine] : []), kit);
    if ([...select.options].some(item => item.value === selected)) select.value = selected;
  }
  async function loadSceneBackdrops() {
    try {
      savedBackdrops = (await api('/api/assets?type=environment')).items;
      renderSceneBackdrops();
      message('backdrop-status', '');
    } catch (error) {
      message('backdrop-status', `Couldn't load your assets and backdrops: ${error.message}`, true);
    }
  }
  // From an asset: backdrops set the scene; anything else lands on a fresh canvas, ready to be dragged along a path.
  async function castInScene(item) {
    if (motionDraft) skipMotion();
    if (item.type === 'environment') {
      if (!savedBackdrops.some(b => b.id === item.id)) savedBackdrops.unshift(item);
      renderSceneBackdrops();
      $('scene-backdrop').value = `asset:${item.id}`;
      setFocus(false);
      if (saveKind === 'shot' && shotStarLayer() && document.body.classList.contains('view-studio')) applyBackdrop();
      else flashTray(`\u25a3 ${item.name} is the backdrop for your next shot.`);
      return;
    }
    if (revision !== savedRevision && hasInk() && !confirm(`Start a new shot with ${item.name}? Your unsaved canvas is replaced (Undo brings it back).`)) return;
    try {
      const same = shotStar?.id === item.id;
      const star = { id: item.id, name: item.name, uses: item.uses ?? (same ? shotStar.uses : undefined), type: item.type ?? (same ? shotStar.type : undefined) };
      const layer = await stageAsset(item, $('scene-backdrop').value);
      if (!layer) return;
      shotStar = star;
      activeId = layer.id;
      setFocus(false);
      setTool('path');
      setView('studio');
      renderSaveKind();
      message('drawing-status', `\u25c6 ${item.name} is in a new ${MIN_SHOT}-second shot. \u2726 Getting it moving\u2026`);
      const drawn = pathsDrawn;
      await ensureRig(layer);
      if (layers.includes(layer) && pathsDrawn === drawn) autoTake(layer, star.uses || 0); // your own path wins
    } catch (error) {
      message('drawing-status', error.message, true);
    }
  }
  async function backdropLayers(choice) {
    if (!choice) return [];
    const [kind, id] = choice.split(':');
    if (kind === 'starter') {
      const starter = STARTERS.find(item => item.id === id && item.kind === 'shot' && item.id !== 'bounce');
      if (!starter) throw new Error('That backdrop is no longer available.');
      return starter.build()[0].filter(layer => layer.name !== 'Draw here').map(layer => newLayer(layer.name, {
        backdrop: id, opacity: layer.opacity ?? 1,
        strokes: layer.strokes.map(stroke => ({ ...stroke, points: stroke.points.slice(), kit: true, seq: 0 }))
      }));
    }
    if (kind !== 'asset' || !savedBackdrops.some(item => item.id === id)) throw new Error('That backdrop is no longer available.');
    const record = await api(`/api/assets/${encodeURIComponent(id)}`);
    return record.layers.map(layer => newLayer(layer.name, {
      visible: layer.visible, opacity: layer.opacity, backdrop: id, strokes: layer.strokes
    }));
  }
  // A fresh scene with just this asset in it, linked: the animation lives in a scene that knows what it uses.
  async function stageAsset(asset, choice = '') {
    const startedRevision = revision;
    const [record, background] = await Promise.all([
      api(`/api/assets/${encodeURIComponent(asset.id)}`), backdropLayers(choice)
    ]);
    if (revision !== startedRevision) throw new Error('The canvas changed while the scene was loading. Try again.');
    if (background.length + 1 > MAX_LAYERS) throw new Error('This backdrop has too many layers to add the asset.');
    const assetStrokes = record.layers.filter(layer => layer.visible).flatMap(layer => layer.strokes);
    if (!inkBounds(assetStrokes)) throw new Error('This asset has no visible ink to animate.');
    const strokes = [...background.flatMap(layer => layer.strokes), ...assetStrokes];
    if (strokes.length > MAX_STROKES || countPoints(strokes) > MAX_POINTS) {
      throw new Error('This asset and backdrop together exceed the canvas limits.');
    }
    freshCanvas([...background, newLayer('Layer 1')]);
    saveKind = 'shot';
    await startPlacing(asset, null, record);
    return layers.find(layer => layer.asset?.asset_id === asset.id) || null;
  }
  // ---------------------------------------------------------------- home and the studio: start something, then make shots
  // Home is where work starts: + New asset, + New backdrop, and your assets (each one leads to its shots). The studio
  // is one thing at a time: an asset (or a backdrop) being drawn, or a shot being made with one.
  let shotStar = null; // the asset new shots are built around: { id, name, uses }
  let autoMeta = null; // what AI wrote at the last save: { kind, signature, description, tags }
  const titleCase = text => text.replace(/(^|\s)\S/g, c => c.toUpperCase());
  // Every way in starts at the top: the canvas (or your assets) in full view.
  let stepsKey = '';
  const esc = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  function setView(next) {
    const was = document.body.classList.contains('view-studio') ? 'studio' : 'home';
    document.body.classList.toggle('view-home', next === 'home');
    document.body.classList.toggle('view-studio', next === 'studio');
    window.scrollTo({ top: 0, behavior: 'auto' });
    closeRefinePick();
    closeRig();
    stepsKey = '';
    renderSteps();
    if (next === was) return;
    if (next === 'home') {
      setFocus(false);
      stopPlay();
      if (!currentQuery && account) loadGallery(); // the latest first: no embedding
    }
    renderCrumbs();
  }
  // A clean canvas with these layers. Undo brings the previous one back.
  function freshCanvas(stack) {
    stopPlay();
    if (motionDraft) skipMotion();
    pushUndo();
    layers = stack;
    frames = [layers];
    frameIndex = 0;
    activeId = layers[layers.length - 1].id;
    sceneMotion = null;
    sceneSketch = null;
    keptPaths = null;
    pendingOrigin = null;
    editing = null;
    autoMeta = null;
    sparks.length = 0;
    guides.length = 0;
    journal = [];
    handStrokes = 0;
    savedHistory = [];
    tags = [];
    renderTagChips();
    $('title').value = '';
    $('description').value = '';
    closePopover();
    rebuildOnion();
    recount();
    rebuildAll();
    renderFrames();
    renderOverlay();
    renderTray();
  }
  function newCanvas(kind) {
    if (revision !== savedRevision && hasInk() && !confirm('Start something new? This canvas isn\u2019t saved (Undo brings it back).')) return;
    freshCanvas([newLayer(kind === 'backdrop' ? 'Backdrop' : 'Layer 1')]);
    saveKind = 'asset';
    $('asset-type').value = kind === 'backdrop' ? 'environment' : 'prop';
    shotStar = null;
    startersDismissed = false;
    savedRevision = revision; // a blank page has nothing to lose
    setTool('pen');
    setView('studio');
    renderSaveKind();
    renderStarters();
    message('drawing-status', kind === 'backdrop'
      ? '\u25a3 A new backdrop: where your shots happen. Draw it, or start from a scene below. Save it, then make shots in it.'
      : '\u25c6 A new asset, in 2D. Rough is fine: \u2726 Refine in the toolbar cleans it up. Save, and AI names, describes, and tags it.');
  }
  $('new-asset').addEventListener('click', () => newCanvas('asset'));
  $('new-backdrop').addEventListener('click', () => newCanvas('backdrop'));
  $('go-home').addEventListener('click', () => setView('home'));
  document.querySelector('.topbar .brand').addEventListener('click', event => { event.preventDefault(); setView('home'); });
  const shotStarLayer = () => frames[0].find(layer => layer.asset) || null;
  function renderCrumbs() {
    const shot = saveKind === 'shot';
    const backdrop = !shot && $('asset-type').value === 'environment';
    document.body.classList.toggle('mode-shot', shot);
    document.body.classList.toggle('making-backdrop', backdrop);
    const star = shot ? shotStarLayer() : null;
    const parts = [];
    if (star) {
      const link = el('button', 'crumb-link', `\u25c6 ${star.name}`);
      link.type = 'button';
      link.dataset.tip = `${star.name}|Its page: every shot it stars in, searchable.`;
      link.addEventListener('click', () => openWhereUsed({ id: star.asset.asset_id, name: star.name }));
      parts.push(link, el('span', 'crumb-sep', '\u203a'));
    }
    const named = $('title').value.trim();
    const here = shot ? (editing?.kind === 'shot' ? editing.code : shotStar?.uses != null && shotStar.id === star?.asset.asset_id ? `Shot ${shotStar.uses + 1}` : 'New shot')
      : editing?.kind === 'asset' ? `${backdrop ? '\u25a3' : '\u25c6'} ${named || 'Untitled'} \u00b7 v${editing.version}` : backdrop ? '\u25a3 New backdrop' : '\u25c6 New asset';
    parts.push(el('b', 'crumb-here', here));
    $('crumb-trail').replaceChildren(...parts);
    $('shot-bar').hidden = !shot;
    $('make-from').hidden = shot || frames.length > 1;
    if (shot) $('picture-form').hidden = true;
    renderShotHint();
  }
  function renderShotHint() {
    renderSteps();
    if (saveKind !== 'shot') return;
    $('shot-hint').hidden = true; // the steps above the canvas say what's next
    $('scene-backdrop').disabled = !!motionDraft;
    $('shot-flipbook').hidden = frames.length < 2 || !!motionDraft;
  }
  // The studio's three steps (asset, shot, flipbook): where you are, what's done, and the next tap. One line of
  // plain words under them says what to do right now.
  function renderSteps() {
    if (!document.body.classList.contains('view-studio')) return;
    const shot = saveKind === 'shot';
    const backdrop = !shot && $('asset-type').value === 'environment';
    const saved = revision === savedRevision;
    const savedAsset = !shot && editing?.kind === 'asset' && saved;
    const moving = shot && frames.length > 1;
    const star = shot ? shotStarLayer() : null;
    const name = shot ? star?.name || 'it' : $('title').value.trim() || (backdrop ? 'your backdrop' : 'your asset');
    const blank = canvasIsBlank();
    const hint = !shot
      ? blank ? `Draw ${backdrop ? 'a place' : 'a character or prop'}, rough is fine. Or start <b>From an image</b>, or <b>\u2726 Generate</b> one.`
        : savedAsset ? `<b>${esc(name)}</b> is saved. Tap <b>\u2461 Shot</b> to ${backdrop ? 'make a shot here' : 'watch it move'}.`
          : `Rough? Tap <b>\u2726 Refine</b> and pick what to clean up. Happy? <b>Save</b>: AI names and tags it.`
      : motionDraft ? `A take of <b>${esc(name)}</b>. <b>Enter</b> keeps it; switch Walk \u00b7 Hop \u00b7 Glide \u00b7 Fly, or drag your own path.`
        : !moving ? `Pick <b>\u3030 Path</b> and drag <b>${esc(name)}</b> where it should go. It travels your trail for ${MIN_SHOT} s.`
          : editing?.kind === 'shot' && saved ? `Saved, and on ${esc(name)}\u2019s page. Tap <b>\u2462 Flipbook</b> to print every frame.`
            : `It moves: Space plays. <b>Save</b> the shot, or tap <b>\u2462 Flipbook</b> to print it (it saves first).`;
    const steps = [
      { label: backdrop ? 'Backdrop' : 'Asset', state: shot || savedAsset ? 'done' : 'now',
        run: shot && star ? () => openWhereUsed({ id: star.asset.asset_id, name: star.name }) : null,
        tip: shot && star ? `${star.name}|Its page: every shot it stars in.` : '' },
      { label: 'Shot', state: moving ? 'done' : shot ? 'now' : savedAsset ? 'next-up' : '',
        run: savedAsset ? () => {
          const item = lastSavedAsset?.id === editing.id ? lastSavedAsset : { id: editing.id, name, type: backdrop ? 'environment' : $('asset-type').value };
          castInScene(item);
          if (backdrop) setView('home');
        } : null,
        tip: savedAsset ? (backdrop ? `Shots here|Pick who stars in a shot in ${name}.` : `Make a shot|${name} in a fresh ${MIN_SHOT}-second shot, already moving.`) : '' },
      { label: 'Flipbook', state: moving ? 'next-up' : '', run: moving && !motionDraft ? flipbookNow : null, tip: moving ? FLIPBOOK_TIP : '' }
    ];
    const key = JSON.stringify([hint, steps.map(step => [step.label, step.state, !!step.run])]);
    if (key === stepsKey) return;
    stepsKey = key;
    $('step-hint').innerHTML = hint;
    $('steps').replaceChildren(...steps.map(step => {
      const li = document.createElement('li');
      const part = document.createElement(step.run ? 'button' : 'span');
      part.className = step.state;
      part.textContent = step.label;
      if (step.run) { part.type = 'button'; part.addEventListener('click', step.run); }
      if (step.tip) part.dataset.tip = step.tip;
      if (step.state === 'now') part.setAttribute('aria-current', 'step');
      li.append(part);
      return li;
    }));
  }
  // A backdrop picked for the shot on screen slides under every frame (one set of strokes, shared).
  async function applyBackdrop() {
    if (saveKind !== 'shot' || motionDraft) return;
    const choice = $('scene-backdrop').value;
    try {
      const background = await backdropLayers(choice);
      if (frames[0].filter(layer => !layer.backdrop).length + background.length > MAX_LAYERS) throw new Error(`That backdrop has too many layers (${MAX_LAYERS} max in a shot).`);
      pushUndo();
      frames = frames.map(stack => [...background.map(layer => newLayer(layer.name, { visible: layer.visible, opacity: layer.opacity, backdrop: layer.backdrop, strokes: layer.strokes })),
        ...stack.filter(layer => !layer.backdrop)]);
      layers = frames[frameIndex];
      if (!layers.some(layer => layer.id === activeId)) activeId = layers[layers.length - 1].id;
      recount();
      rebuildOnion();
      rebuildAll();
      renderFrames();
      renderLayersPanel();
      logEvent('artist', 'Backdrop', choice ? $('scene-backdrop').selectedOptions[0].textContent : 'none');
      message('backdrop-status', '');
    } catch (error) {
      message('backdrop-status', error.message, true);
    }
  }
  $('scene-backdrop').addEventListener('change', applyBackdrop);
  $('shot-flipbook').addEventListener('click', flipbookNow);
  // A shot names itself after its star: LittleFox_03 (its number among the asset's shots), else the time.
  function shotName() {
    const star = shotStarLayer();
    const who = (star?.name || 'Shot').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
      .map(word => word[0].toUpperCase() + word.slice(1)).join('').slice(0, 24) || 'Shot';
    const two = v => String(v).padStart(2, '0');
    if (shotStar?.uses != null && star && shotStar.id === star.asset.asset_id) return `${who}_${two(shotStar.uses + 1)}`;
    const now = new Date();
    return `${who}_${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  }
  // No name? One AI call names it, describes it, and tags it; the save then sends all three (no second call).
  async function nameIt() {
    if (offline) { message('drawing-status', 'Give it a name to keep it on this device.', true); $('title').focus(); return ''; }
    message('drawing-status', '\u2726 AI is naming it, describing it, and tagging it\u2026');
    try {
      const data = await postJSON('/api/describe', JSON.stringify({ title: '', description: $('description').value.trim(), layers: docLayers() }));
      if (!$('description').value.trim() && data.description) $('description').value = data.description;
      if (!tags.length) data.tags.forEach(addTag);
      const name = (data.name || titleCase(data.tags[0] || 'Untitled')).slice(0, 80);
      $('title').value = name;
      autoMeta = { kind: saveKind, signature: 'fresh', description: $('description').value.trim(), tags: [...tags] };
      return name;
    } catch (error) {
      message('drawing-status', `${error.message} Give it a name and save again.`, true);
      $('title').focus();
      return '';
    }
  }
  // What the art is, for "did it change since AI described it?": everything saved except the words about it.
  const artSignature = body => JSON.stringify([body.layers, body.frames || null, body.motion || null, body.type || null]);
  // ---------------------------------------------------------------- pictures become strokes (raster to vector, in the browser)
  // Luminance and a threshold (dark lines; edges if the picture has none), thinned to one-pixel centerlines
  // (Zhang-Suen, so a thick line is one stroke, not two outlines), traced into chains, and simplified
  // (Ramer-Douglas-Peucker). Each chain keeps the color and thickness it had. Nothing leaves the device.
  const TRACE_SIDE = 640;
  function zhangSuen(mask, w, h) {
    const at = (x, y) => mask[y * w + x];
    for (let changed = true; changed;) {
      changed = false;
      for (const pass of [0, 1]) {
        const drop = [];
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            if (!at(x, y)) continue;
            const n = [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
            const b = n.reduce((a, v) => a + v, 0);
            if (b < 2 || b > 6) continue;
            let a = 0;
            for (let i = 0; i < 8; i++) if (!n[i] && n[(i + 1) % 8]) a++;
            if (a !== 1) continue;
            if (pass === 0 ? n[0] * n[2] * n[4] || n[2] * n[4] * n[6] : n[0] * n[2] * n[6] || n[0] * n[4] * n[6]) continue;
            drop.push(y * w + x);
          }
        }
        for (const i of drop) mask[i] = 0;
        if (drop.length) changed = true;
      }
    }
    return mask;
  }
  function simplifyChain(points, epsilon) {
    if (points.length < 3) return points;
    const [a, b] = [points[0], points[points.length - 1]];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    let far = 0, at = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const d = len > 1e-6 ? Math.abs(dy * points[i][0] - dx * points[i][1] + b[0] * a[1] - b[1] * a[0]) / len : Math.hypot(points[i][0] - a[0], points[i][1] - a[1]);
      if (d > far) { far = d; at = i; }
    }
    if (far <= epsilon) return [a, b];
    return [...simplifyChain(points.slice(0, at + 1), epsilon).slice(0, -1), ...simplifyChain(points.slice(at), epsilon)];
  }
  async function pictureStrokes(blob, flags) {
    const bitmap = await createImageBitmap(blob);
    const k = Math.min(1, TRACE_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(16, Math.round(bitmap.width * k)), h = Math.max(16, Math.round(bitmap.height * k));
    const sheet = document.createElement('canvas');
    sheet.width = w;
    sheet.height = h;
    const g = sheet.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.drawImage(bitmap, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    // Dark lines first (line art, outlines); a picture without any gets its edges instead (Sobel).
    let mask = new Uint8Array(w * h);
    let dark = 0;
    for (let i = 0; i < w * h; i++) if (lum[i] < 110) { mask[i] = 1; dark++; }
    if (dark < w * h * 0.003 || dark > w * h * 0.45) {
      mask = new Uint8Array(w * h);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const L = (dx, dy) => lum[(y + dy) * w + x + dx];
          const gx = -L(-1, -1) + L(1, -1) - 2 * L(-1, 0) + 2 * L(1, 0) - L(-1, 1) + L(1, 1);
          const gy = -L(-1, -1) - 2 * L(0, -1) - L(1, -1) + L(-1, 1) + 2 * L(0, 1) + L(1, 1);
          if (Math.hypot(gx, gy) > 120) mask[y * w + x] = 1;
        }
      }
    }
    for (let x = 0; x < w; x++) { mask[x] = 0; mask[(h - 1) * w + x] = 0; }
    for (let y = 0; y < h; y++) { mask[y * w] = 0; mask[y * w + w - 1] = 0; }
    const inkPixels = mask.reduce((a, v) => a + v, 0);
    const skeleton = zhangSuen(mask.slice(), w, h);
    const bonePixels = Math.max(1, skeleton.reduce((a, v) => a + v, 0));
    const thick = clampTo(inkPixels / bonePixels, 1, 14); // average line thickness, in picture pixels
    // Trace the centerlines into chains: from line ends, then out of every junction, then closed loops. A junction
    // is where 3+ lines meet (3+ ink runs around the pixel; a diagonal step in a thin line is not one).
    const N = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]; // clockwise ring
    const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && skeleton[y * w + x] === 1;
    const runs = i => { const x = i % w, y = (i - x) / w; let n = 0; for (let k = 0; k < 8; k++) if (!on(x + N[k][0], y + N[k][1]) && on(x + N[(k + 1) % 8][0], y + N[(k + 1) % 8][1])) n++; return n; };
    const kind = new Uint8Array(w * h); // 1 line, 2 end, 3 junction
    for (let i = 0; i < w * h; i++) if (skeleton[i]) { const r = runs(i); kind[i] = r >= 3 ? 3 : r <= 1 ? 2 : 1; }
    const seen = new Uint8Array(w * h);
    const chains = [];
    const walk = (from, first) => {
      const start = from, sx = from % w, sy = (from - sx) / w;
      const chain = [[sx, sy]];
      let i = first;
      for (;;) {
        const x = i % w, y = (i - x) / w;
        chain.push([x, y]);
        if (kind[i] === 3) break; // into a junction: this line ends here
        seen[i] = 1;
        let next = -1;
        // Touching a junction (not the one this line left from): step onto it and end there.
        for (const [dx, dy] of N) {
          const j = (y + dy) * w + x + dx;
          if (on(x + dx, y + dy) && kind[j] === 3 && j !== start && !(Math.abs(x + dx - sx) <= 1 && Math.abs(y + dy - sy) <= 1 && chain.length < 4)) { next = j; break; }
        }
        if (next >= 0) { i = next; continue; }
        for (const straight of [true, false]) { // prefer a side neighbor over a diagonal: no zig-zags
          for (const [dx, dy] of N) {
            if ((dx && dy) === straight) continue;
            const j = (y + dy) * w + x + dx;
            if (on(x + dx, y + dy) && !seen[j] && j !== from) { next = j; break; }
          }
          if (next >= 0) break;
        }
        if (next < 0) break;
        from = -1;
        i = next;
      }
      const [a, b] = [chain[0], chain[chain.length - 1]];
      if (chain.length > 8 && Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1) chain.push(a); // a loop closes
      return chain;
    };
    const firstSteps = i => { const x = i % w, y = (i - x) / w; return N.map(([dx, dy]) => (y + dy) * w + x + dx).filter((j, k) => on(x + N[k][0], y + N[k][1]) && !seen[j] && kind[j] !== 3); };
    for (let i = 0; i < w * h; i++) if (kind[i] === 2 && !seen[i]) { seen[i] = 1; const [j] = firstSteps(i); chains.push(j === undefined ? [[i % w, (i - i % w) / w]] : walk(i, j)); }
    for (let i = 0; i < w * h; i++) if (kind[i] === 3) for (const j of firstSteps(i)) if (!seen[j]) chains.push(walk(i, j));
    for (let i = 0; i < w * h; i++) if (kind[i] === 1 && !seen[i]) { seen[i] = 1; const [j] = firstSteps(i); if (j !== undefined) chains.push(walk(i, j)); }
    // At each junction, the two chains that continue each other most straight become one stroke (a body through its
    // shoulders stays one line; the arms branch off).
    const heading = (chain, atEnd) => { const c = atEnd ? chain.slice().reverse() : chain; const a = c[0], b = c[Math.min(c.length - 1, 6)]; const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };
    const parts = chains.filter(chain => chain.length);
    const tip = (c, e) => e ? parts[c][parts[c].length - 1] : parts[c][0];
    const cells = new Map();
    parts.forEach((chain, c) => { if (chain.length >= 6) for (const e of [0, 1]) { const [x, y] = tip(c, e), key = `${x >> 2},${y >> 2}`; cells.set(key, [...(cells.get(key) || []), [c, e]]); } });
    const pairs = [];
    for (const [key, here] of cells) {
      const [cx, cy] = key.split(',').map(Number);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const [c1, e1] of here) for (const [c2, e2] of cells.get(`${gx},${gy}`) || []) {
          if (c1 >= c2) continue;
          const [p, q] = [tip(c1, e1), tip(c2, e2)];
          if (Math.abs(p[0] - q[0]) > 2 || Math.abs(p[1] - q[1]) > 2) continue;
          const [ha, hb] = [heading(parts[c1], e1), heading(parts[c2], e2)];
          const straight = -(ha[0] * hb[0] + ha[1] * hb[1]); // 1 = they continue each other exactly
          if (straight > 0.8) pairs.push([straight, c1, e1, c2, e2]);
        }
      }
    }
    const partner = new Map();
    for (const [, c1, e1, c2, e2] of pairs.sort((a, b) => b[0] - a[0])) {
      if (partner.has(`${c1},${e1}`) || partner.has(`${c2},${e2}`)) continue;
      partner.set(`${c1},${e1}`, [c2, e2]); partner.set(`${c2},${e2}`, [c1, e1]);
    }
    const used = new Uint8Array(parts.length);
    const follow = (c, e) => { // enter chain c at end e, keep going through partners
      const line = [];
      while (c !== undefined && !used[c]) {
        used[c] = 1;
        line.push(...(e ? parts[c].slice().reverse() : parts[c]));
        [c, e] = partner.get(`${c},${1 - e}`) || [];
      }
      return line;
    };
    let lines = [];
    parts.forEach((_, c) => { if (!used[c]) for (const e of [0, 1]) if (!used[c] && !partner.has(`${c},${e}`)) lines.push(follow(c, e)); });
    parts.forEach((_, c) => { if (!used[c]) lines.push(follow(c, 0)); }); // rings of chains
    const loose = ([x, y]) => kind[y * w + x] === 2;
    lines = lines.filter(chain => chain.length >= 6 || (loose(chain[0]) && loose(chain[chain.length - 1]))) // dots (eyes) stay
      .map(chain => chain.length > 1 ? chain : [chain[0], chain[0]]);
    // Fit the picture onto the page (centered, 70% of its height at most), in canvas pixels.
    const fit = Math.min(W * 0.7 / w, H * 0.7 / h), ox = (W - w * fit) / 2, oy = (H - h * fit) / 2;
    const hex = v => v.toString(16).padStart(2, '0');
    let epsilon = 1.2;
    let strokes = [];
    for (let tries = 0; tries < 5; tries++, epsilon *= 1.8) {
      strokes = lines.map(chain => {
        let r = 0, gg = 0, b = 0;
        for (const [x, y] of chain) { const j = (y * w + x) * 4; r += px[j]; gg += px[j + 1]; b += px[j + 2]; }
        const n = chain.length, color = `#${hex(Math.round(r / n))}${hex(Math.round(gg / n))}${hex(Math.round(b / n))}`;
        return { color, width: clampTo(Math.round(thick * fit * 10) / 10, 1, 24), seq: 0, ...flags,
          points: simplifyChain(chain, epsilon).map(([x, y]) => ({ x: r4((ox + x * fit) / W), y: r4((oy + y * fit) / H), pressure: 0.5 })) };
      }).sort((a, b) => b.points.length - a.points.length);
      if (countPoints(strokes) <= MAX_POINTS * 0.6) break;
    }
    return strokes.slice(0, Math.min(600, MAX_STROKES - allStrokes().length));
  }
  async function addPicture(blob, { flags, name, how }) {
    const strokes = await pictureStrokes(blob, flags);
    if (!strokes.length) { flashTray('No lines found in that picture. Try one with clearer outlines.', true); return; }
    if (layers.length >= MAX_LAYERS || pointCount + countPoints(strokes) > MAX_POINTS) { flashTray('No room for that picture on this canvas.', true); return; }
    pushUndo();
    const blank = layers.find(layer => !layer.strokes.length && !layer.asset && !layer.backdrop);
    const layer = blank || newLayer(name.slice(0, 40));
    layer.strokes = strokes.map(stroke => ({ ...stroke, seq: nextSeq() }));
    if (!blank) layers.push(layer);
    activeId = layer.id;
    recount();
    rebuildAll();
    renderLayersPanel();
    logEvent(flags.ai ? 'ai' : 'artist', flags.ai ? 'Picture, traced' : 'Image, traced', `${how}: ${plural(strokes.length, 'stroke')}, ${countPoints(strokes).toLocaleString()} points`);
    message('drawing-status', `\u2713 ${how}: ${plural(strokes.length, 'stroke')} you can edit. \u2726 Refine cleans it up; Save, and it\u2019s an asset.`, false, [
      { label: '\u21b6 Undo', run: () => { undo(); message('drawing-status', 'Undone.'); } }]);
  }
  $('from-image').addEventListener('click', () => $('image-file').click());
  $('image-file').addEventListener('change', async () => {
    const file = $('image-file').files[0];
    $('image-file').value = '';
    if (!file) return;
    flashTray('\u2726 Tracing your picture into strokes\u2026');
    try { await addPicture(file, { flags: { kit: true }, name: file.name.replace(/\.\w+$/, ''), how: `Traced ${file.name}` }); }
    catch { flashTray('That file couldn\u2019t be read as a picture.', true); }
  });
  $('make-picture').addEventListener('click', () => {
    $('picture-form').hidden = !$('picture-form').hidden;
    if (!$('picture-form').hidden) $('picture-prompt').focus();
  });
  $('picture-cancel').addEventListener('click', () => { $('picture-form').hidden = true; });
  $('picture-form').addEventListener('submit', async event => {
    event.preventDefault();
    const prompt = $('picture-prompt').value.trim();
    $('picture-go').disabled = true;
    $('picture-go').textContent = '\u2726 Drawing\u2026';
    message('drawing-status', `\u2726 AI is drawing \u201c${prompt}\u201d as line art; then it becomes strokes\u2026`);
    try {
      const data = await postJSON('/api/sparks/picture', JSON.stringify({ prompt }));
      const bytes = Uint8Array.from(atob(data.image.split(',')[1]), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'image/png' });
      await addPicture(blob, { flags: { ai: true }, name: prompt, how: `\u2726 Drawn by AI and traced` });
      if (!$('title').value.trim()) $('title').value = titleCase(prompt.replace(/^(an?|the)\s+/i, '')).slice(0, 80);
      $('picture-form').hidden = true;
      $('picture-prompt').value = '';
    } catch (error) {
      message('drawing-status', error.message, true);
    } finally {
      $('picture-go').disabled = false;
      $('picture-go').textContent = '\u2726 Draw it';
    }
  });

  // ---------------------------------------------------------------- Find similar: the drawing is the query
  function showLibrary() {
    setView('home');
    document.querySelector('.library').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function findSimilar(item = null) {
    const asset = item || (editing?.kind === 'asset' && revision === savedRevision && frames.length === 1
      ? { id: editing.id, name: $('title').value.trim() } : null);
    if (!asset && !hasInk()) {
      flashTray('Draw something first: your drawing becomes the search.', true);
      return;
    }
    showLibrary();
    galleryRequest?.abort();
    const controller = new AbortController();
    galleryRequest = controller;
    resetLibrarySearch(false);
    try {
      if (asset) {
        message('library-status', `Ranking your assets against ${asset.name}\u2019s stored vector\u2026`);
        const data = await api(`/api/assets/${encodeURIComponent(asset.id)}/similar`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        renderResults(data.assets, { sketch: true });
        message('library-status', `Assets like ${data.of.name}, most similar first.${timingNote(data.timing)}`);
      } else {
        message('library-status', 'Voyage AI is embedding your drawing\u2026');
        const data = await api('/api/search/sketch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'asset', layers: docLayers() }), signal: controller.signal });
        if (controller.signal.aborted) return;
        const self = editing?.kind === 'asset' ? editing.id : null;
        renderResults(data.items.filter(hit => hit.id !== self), { sketch: true });
        message('library-status', `\u25ce Your drawing was the search: assets that look like it.${timingNote(data.timing)}`);
      }
    } catch (error) {
      if (error.name !== 'AbortError') message('library-status', error.message, true);
    }
  }

  // ---------------------------------------------------------------- Refine with AI: suggested, never imposed
  async function suggestRefinements(force = false) {
    if (!hasInk()) return;
    if (!force && refineIdeas.revision === revision && (refineIdeas.loading || refineIdeas.items.length)) return;
    const asked = revision;
    refineIdeas = { revision: asked, items: [], loading: true, error: '' };
    renderAiExamples();
    try {
      const result = await postJSON('/api/sparks/refine/ideas', JSON.stringify({ title: $('title').value.trim().slice(0, 120), layers: docLayers() }));
      if (refineIdeas.revision === asked) refineIdeas.items = result.ideas;
    } catch (error) {
      if (refineIdeas.revision === asked) refineIdeas.error = error.message;
    }
    if (refineIdeas.revision !== asked) return;
    refineIdeas.loading = false;
    if (aiMode !== 'refine') return;
    renderAiExamples();
    // A head start: the best suggestion, ready to run (Enter) or to type over.
    if (refineIdeas.items.length && !$('ai-prompt').value.trim()) {
      $('ai-prompt').value = refineIdeas.items[0];
      if (document.activeElement === $('ai-prompt')) $('ai-prompt').select();
    }
  }
  const startRefineFlow = () => openRefinePick();
  async function refineAsset(item) {
    await openAsset(item.id);
    if (editing?.kind === 'asset' && editing.id === item.id) $('refine-now').click();
  }
  // Drag an asset card's picture onto the canvas: it lands where you drop it (desktop).
  $('canvas-frame').addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('application/x-inkling-asset')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    $('canvas-frame').classList.add('drop-ok');
  });
  $('canvas-frame').addEventListener('dragleave', () => $('canvas-frame').classList.remove('drop-ok'));
  $('canvas-frame').addEventListener('drop', event => {
    $('canvas-frame').classList.remove('drop-ok');
    const raw = event.dataTransfer.getData('application/x-inkling-asset');
    if (!raw) return;
    event.preventDefault();
    const at = normPoint(event);
    startPlacing(JSON.parse(raw), { x: at.x * W, y: at.y * H });
  });

  function trayButton(label, title, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = label;
    button.dataset.tip = title;
    button.addEventListener('click', handler);
    return button;
  }
  function renderTray() {
    renderStarters();
    $('spark-tray').classList.toggle('motion', !!motionDraft);
    if (motionDraft) {
      clearTimeout(trayTimer);
      trayTimer = null;
      const tray = $('spark-tray');
      tray.hidden = false;
      tray.classList.remove('error');
      tray.classList.add('motion');
      const { spec } = motionDraft;
      const note = el('span', 'tray-note');
      note.append(el('b', '', takes.length > 1 ? `Take ${takeAt + 1} of ${takes.length}` : 'Preview'),
        ` \u00b7 ${spec.take || spec.label}`, el('span', 'long', ' \u00b7 your drawing hasn\'t changed'));
      tray.replaceChildren(note,
        trayButton('\u2713 Keep<span class="long"> this take</span> <kbd>\u23ce</kbd>', 'Keep \u00b7 Enter|Turns this take into editable frames. Undo brings your drawing back.', keepMotion));
      if (spec.by === 'path') {
        const mine = pathOpts.timing === 'mine';
        tray.append(trayButton(mine ? '\u270b Your pace' : '\u2192 Smooth', mine
          ? 'Your pace|It travels the way your finger did: slow where you slowed, quick where you rushed. Tap for smooth.'
          : 'Eased|It speeds up, cruises, and slows down to a stop. Tap to use your finger\u2019s own pace instead.', () => setPathOption({ timing: mine ? 'steady' : 'mine' })));
        const focus = focusPath(spec);
        const gaits = el('span', 'gait-chips');
        gaits.setAttribute('role', 'group');
        gaits.setAttribute('aria-label', `How ${focus?.layerId ? (spec.base.find(l => l.id === focus.layerId)?.name || 'it') : 'it'} moves`);
        for (const [id, g] of Object.entries(GAITS)) {
          const chip = trayButton(`${g.icon} ${g.name}`, `${g.name}|${{ walk: 'Steps along with a bob, faces where it goes, and leans in.', hop: 'Bounces along in arcs: squash on landing, stretch in the air.', glide: 'Smooth and steady, leaning into the curves.', fly: 'Faces where it goes, tilts nose-up to climb and down to dive, and floats.' }[id]} Free, no AI.`,
            () => setPathOption({ gait: id }));
          chip.classList.toggle('on', focus?.gait === id);
          chip.setAttribute('aria-pressed', String(focus?.gait === id));
          gaits.append(chip);
        }
        tray.append(gaits);
      }
      tray.append(compareButton(), trayButton('\u27e8/\u27e9 Code', 'Edit as code|This take is p5.js code: keyframes as numbers you can change. Opens in the Lab.', () => openTakeAsCode()),
        trayButton('Discard <kbd>Esc</kbd>', 'Discard \u00b7 Esc|Close the preview. Your drawing stays exactly as it was.', () => {
        skipMotion();
        message('drawing-status', 'Discarded. Your drawing is exactly as it was.');
      }));
      return;
    }
    const ready = activeSpark();
    if (trayTimer && !ready) return; // a hint is showing; a ready spark replaces it
    clearTimeout(trayTimer);
    trayTimer = null;
    const tray = $('spark-tray');
    tray.replaceChildren();
    tray.classList.remove('error');
    const pending = pendingCount();
    if (!ready && !pending && tool === 'place' && placing) {
      // Stays up for as long as placement mode does, however long the artist takes.
      tray.hidden = false;
      tray.textContent = `\u25c6 Drag a box where "${placing.name}" goes, or tap to drop it at full size. Esc cancels.`;
      return;
    }
    if (!ready && !pending) {
      tray.hidden = true;
      return;
    }
    tray.hidden = false;
    if (ready) {
      const note = document.createElement('span');
      note.className = 'tray-note';
      note.append(el('b', '', 'Preview'), ` \u00b7 ${ready.result.note || 'AI draft'} \u00b7 nothing changes until you keep it`);
      tray.append(
        note,
        trayButton(`${ready.kind === 'guide' ? 'Pin guide' : ready.kind === 'sketch' ? 'Use sketch' : ready.kind === 'refine' ? 'Keep it' : 'Use it'} <kbd>\u23ce</kbd>`,
          ready.kind === 'sketch' ? 'Use sketch \u00b7 Enter|Adds it as a faint layer under your ink.' : ready.kind === 'guide' ? 'Pin guide \u00b7 Enter'
            : ready.kind === 'refine' ? `Keep it \u00b7 Enter|${editSummary(ready.result)}. Code applied AI\u2019s plan to your own strokes (and to every frame). Undo brings the old one back.`
            : `Use it \u00b7 Enter|Adds these lines to "${activeLayer().name}".`, acceptSpark),
        ...(ready.kind === 'refine' || ready.kind === 'strokes' ? [compareButton()] : []),
        trayButton('\u21bb', 'Another try|Same request, a new attempt.', retrySpark),
        trayButton('Skip <kbd>Esc</kbd>', 'Skip \u00b7 Esc|Your drawing stays exactly as it was.', dismissSpark)
      );
      const queued = sparks.filter(spark => spark.status === 'ready').length - 1;
      if (queued > 0 || pending) {
        const more = document.createElement('span');
        more.className = 'tray-more';
        more.textContent = [queued > 0 ? `+${queued} ready` : '', pending ? `${pending} working` : ''].filter(Boolean).join(' \u00b7 ');
        tray.append(more);
      }
    } else {
      const note = document.createElement('span');
      note.className = 'tray-note pending';
      const sketching = sparks.find(spark => spark.status === 'pending' && spark.kind === 'sketch');
      const refining = sparks.find(spark => spark.status === 'pending' && spark.kind === 'refine');
      note.textContent = refining && pending === 1 ? (refining.prompt === QUICK_REFINE ? '\u2726 Refining your lines\u2026 keep drawing' : `\u2726 Refining: \u201c${refining.label}\u201d\u2026 keep drawing`)
        : sketching && pending === 1 ? `\u2726 Sketching "${sketching.prompt}" in blue pencil\u2026 keep drawing`
        : `\u2726 AI is on it${pending > 1 ? ` (${pending})` : ''}\u2026 keep drawing`;
      tray.append(note);
    }
  }
  // Hold to compare: while pressed, every preview steps aside and the untouched drawing shows.
  function compareButton() {
    const button = trayButton('\ud83d\udc41 <span class="long">Hold to compare</span><span class="short">Peek</span>', 'Hold to compare|Press and hold to see your drawing without this preview.', () => {});
    const peek = on => { peeking = on; button.classList.toggle('held', on); renderOverlay(); };
    button.addEventListener('pointerdown', event => { event.preventDefault(); button.setPointerCapture?.(event.pointerId); peek(true); });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => peek(false));
    button.addEventListener('keydown', event => { if (event.key === ' ' && !event.repeat) { event.preventDefault(); peek(true); } });
    button.addEventListener('keyup', event => { if (event.key === ' ') peek(false); });
    return button;
  }
  function undoable(text) {
    message('drawing-status', text, false, [{ label: '\u21b6 Undo', tip: 'Undo \u00b7 Cmd/Ctrl+Z', run: () => { undo(); message('drawing-status', 'Undone.'); } }]);
  }
  // Who the box talks to: everything that can move (the default), or the layers you pick. Words only reach those.
  function targetable() {
    const stack = motionDraft ? motionDraft.spec.base : layers;
    return stack.filter(layer => layer.visible && !layer.fx && hasInk([layer]) && !isScenery(layer));
  }
  function targetLayers() {
    if (!targets) return null;
    const picked = targetable().filter(layer => targets.has(layer.id));
    return picked.length ? picked : null;
  }
  function setTargets(next) {
    targets = next && next.size ? next : null;
    glowTargets();
  }
  function followSelection(id, add) {
    if (targetable().length < 2) return;
    setTargets(add && targets ? new Set([...targets, id].slice(-4)) : new Set([id]));
  }
  function glowTargets(ms = 1600) {
    targetGlow = performance.now() + ms;
    renderOverlay();
    clearTimeout(glowTargets.timer);
    glowTargets.timer = setTimeout(() => { if (!motionDraft) renderOverlay(); }, ms + 40);
  }
  function paintTargetGlow(stack, k, force = false) {
    if (!force && performance.now() > targetGlow) return;
    const aimed = force ? stack : targetLayers() || targetable();
    if (!aimed.length) return;
    const names = new Set(aimed.map(layer => layer.name)), ids = new Set(aimed.map(layer => layer.id));
    octx.save();
    octx.font = `650 ${Math.round(12 * k)}px system-ui, sans-serif`;
    for (const layer of stack) {
      if (!layer.visible || !(ids.has(layer.id) || (motionDraft && names.has(layer.name) && !layer.fx))) continue;
      const b = inkBounds(layer.strokes);
      if (!b) continue;
      const pad = 10 * k;
      octx.strokeStyle = '#7c3aed';
      octx.lineWidth = 2 * k;
      octx.setLineDash([7 * k, 5 * k]);
      octx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      const label = `\u2726 ${layer.name}`, w = octx.measureText(label).width + 12 * k;
      octx.setLineDash([]);
      octx.fillStyle = '#7c3aed';
      octx.fillRect(b.x - pad, Math.max(0, b.y - pad - 20 * k), w, 20 * k);
      octx.fillStyle = '#fff';
      octx.fillText(label, b.x - pad + 6 * k, Math.max(0, b.y - pad - 20 * k) + 14 * k);
    }
    octx.restore();
  }
  function renderFxChips() {
    const row = $('scene-fx');
    const spec = motionDraft ? motionDraft.spec : null;
    row.hidden = !spec;
    if (!spec) { row.replaceChildren(); return; }
    const on = new Set(spec.effects || []);
    const chip = (label, pressed, tip, run) => {
      const button = el('button', `fx-chip${pressed ? ' on' : ''}`, label);
      button.type = 'button';
      if (pressed !== null) button.setAttribute('aria-pressed', String(pressed));
      button.dataset.tip = tip;
      button.addEventListener('click', run);
      return button;
    };
    row.replaceChildren(el('small', '', 'Instant \u00b7 free \u00b7 no AI'),
      ...FX.map(fx => chip(`${fx.icon} ${fx.name}`, on.has(fx.id), `${fx.name}|${fx.hint} A layer of tiny strokes drawn by code. Tap again to remove.`,
        () => applyLocal(on.has(fx.id) ? { off: [fx] } : { on: [fx] }))),
      el('i', 'fx-sep'),
      ...TWEAKS.map(tweak => chip(tweak.label, null, `${tweak.label.replace(/^\W+/, '')}|${tweak.say[0].toUpperCase()}${tweak.say.slice(1)}.`, () => applyLocal({ tweak }))),
      ...(offline ? [el('i', 'fx-sep'), ...PRESETS.map(preset => chip(`${preset.icon} ${preset.name}`, null, `${preset.name}|${preset.hint} Plain math, works offline.`,
        () => offlineRevise(preset.name, readPrompt(''))))] : []));
  }
  // Effects and tweaks: a new take in an instant, computed right here. Gemini isn't asked.
  function applyLocal({ on = [], off = [], tweak = null }) {
    if (!motionDraft) return false;
    const from = directedTake();
    const effects = withFx(from.effects, on, off);
    const tooMuch = fxFits(from, effects);
    if (tooMuch) { flashTray(tooMuch, true); return false; }
    let spec = { ...from, effects };
    const aimed = targetLayers();
    if (tweak) {
      spec = tweak.apply(spec, aimed ? new Set(aimed.map(layer => layer.id)) : null);
      if (spec.seconds === from.seconds && JSON.stringify(spec.tracks.map(t => t.keys)) === JSON.stringify(from.tracks.map(t => t.keys))) {
        flashTray(`That's as ${tweak.label.replace(/^\W+/, '').toLowerCase()} as it goes.`, true);
        return false;
      }
    }
    const bits = [...fxWords(on, off), ...(tweak ? [`${tweak.label}${aimed && !tweak.clock ? ` ${aimed.map(layer => layer.name).join(' + ')}` : ''}`] : [])];
    if (!bits.length) return false;
    const timing = tweak && spec.seconds !== from.seconds ? ` (${from.seconds.toFixed(1)} s \u2192 ${spec.seconds.toFixed(1)} s)` : '';
    spec.take = bits.join(' ');
    spec.change = `\u26a1 Take ${takes.length + 1}: ${bits.join(' ')}, instantly, no AI. ${[
      on.length ? 'An effect is a layer of tiny strokes drawn by code, the same every time.' : '',
      tweak ? `${tweak.say[0].toUpperCase()}${tweak.say.slice(1)}${timing}.` : 'Your keyframes didn\u2019t change.'
    ].filter(Boolean).join(' ')}`;
    previewMotion(spec);
    return true;
  }
  // The takes strip under the box: every attempt, side by side. Tap one to see it; changes build on the one you see.
  function showTake(index) {
    if (!takes[index] || index === takeAt) return;
    takeAt = index;
    previewMotion(takes[index], { take: false });
    renderTakes();
  }
  function renderTakes() {
    const strip = $('takes');
    const list = motionDraft ? takes : [];
    const chips = list.map((item, i) => {
      const active = i === takeAt;
      const label = item.take || item.label;
      const chip = el('button', `take${active ? ' active' : ''}`);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(active));
      chip.append(el('b', '', String(i + 1)), el('span', '', label.length > 30 ? `${label.slice(0, 29)}\u2026` : label));
      chip.addEventListener('click', () => showTake(i));
      return chip;
    });
    strip.replaceChildren(...(chips.length ? [el('small', '', 'Takes'), ...chips] : []));
    strip.hidden = list.length < 2;
    // Scroll only when the current take is out of view, so the strip's label stays put whenever it can.
    const current = strip.querySelector('.take.active, .take.pending');
    if (current && !strip.hidden) {
      const left = current.offsetLeft - strip.offsetLeft, right = left + current.offsetWidth;
      if (left < strip.scrollLeft || right > strip.scrollLeft + strip.clientWidth - 24) strip.scrollTo({ left: Math.max(0, right - strip.clientWidth + 32), behavior: 'smooth' });
    }
  }
  function flashTray(text, error = false) {
    clearTimeout(trayTimer);
    const tray = $('spark-tray');
    tray.hidden = false;
    tray.classList.toggle('error', error);
    tray.textContent = text;
    trayTimer = setTimeout(() => { trayTimer = null; renderTray(); }, error ? 5000 : 2600);
  }

  document.addEventListener('keydown', event => {
    if (isTyping(event.target) || document.querySelector('dialog[open]')) return; // sheets handle their own keys
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    } else if (mod && !event.shiftKey && key === 'c' && !getSelection()?.toString()) {
      event.preventDefault();
      copyLayer();
    } else if (mod && key === 'v' && !busy()) {
      event.preventDefault();
      pasteClipboard();
    } else if (mod && key === 'd' && !busy()) {
      event.preventDefault();
      duplicateLayer();
    } else if (!mod && !event.altKey && /^[1-7]$/.test(event.key)) {
      event.preventDefault();
      document.querySelectorAll('.ink-dot')[Number(event.key) - 1]?.click();
    } else if (event.key === '?') {
      event.preventDefault();
      $('help').showModal();
    } else if (!mod && !event.altKey && TOOL_KEYS[key] && !busy()) {
      event.preventDefault();
      closePopover();
      setTool(TOOL_KEYS[key] === tool && tool === 'spark' ? drawTool : TOOL_KEYS[key]);
    } else if (!mod && (event.key === ',' || event.key === '.')) {
      event.preventDefault();
      goFrame(frameIndex + (event.key === '.' ? 1 : -1));
    } else if (!mod && key === 'f' && !busy()) {
      event.preventDefault();
      setFocus(!document.body.classList.contains('focus-mode'));
    } else if (!mod && key === 'l' && !busy()) {
      event.preventDefault();
      openLab();
    } else if (!mod && key === 'n' && !busy()) {
      event.preventDefault();
      addFrame();
    } else if (event.key === ' ' && frames.length > 1 && !event.target.closest?.('button, a, [role="button"]')) {
      event.preventDefault();
      playing ? stopPlay() : play();
    } else if (!mod && (event.key === '[' || event.key === ']')) {
      event.preventDefault();
      setWidth(Number($('width').value) + (event.key === ']' ? 2 : -2));
    } else if (motionDraft && takes.length > 1 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      showTake(Math.max(0, Math.min(takes.length - 1, takeAt + (event.key === 'ArrowRight' ? 1 : -1))));
    } else if (motionDraft && (event.key === 'Enter' || event.key === 'Escape') && !event.target.closest?.('button, a, [role="button"]')) {
      event.preventDefault();
      event.key === 'Enter' ? keepMotion() : skipMotion();
    } else if (event.key === 'Enter' && activeSpark() && !event.target.closest?.('button, a, [role="button"]')) {
      // Focused controls (Dismiss, Save, library cards) keep their own Enter behavior.
      event.preventDefault();
      acceptSpark();
    } else if (event.key === 'Escape') {
      if (rigView) closeRig();
      else if (playing) stopPlay();
      else if (document.body.classList.contains('focus-mode') && !activeSpark() && tool !== 'place' && tool !== 'spark') setFocus(false);
      else if ($('layers-panel').classList.contains('open')) setLayersOpen(false);
      else if (tool === 'place') { setTool(drawTool); flashTray('Placement cancelled.'); }
      else if (activeSpark()) dismissSpark();
      else if (tool === 'spark') setTool(drawTool);
    }
  });

  // ---------------------------------------------------------------- tags
  function renderTagChips() {
    $('tag-chips').replaceChildren(...tags.map(tag => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = tag;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '\u00d7';
      remove.setAttribute('aria-label', `Remove tag ${tag}`);
      remove.addEventListener('click', () => { tags = tags.filter(item => item !== tag); revision++; renderTagChips(); });
      chip.append(remove);
      return chip;
    }));
  }
  function addTag(raw) {
    const tag = raw.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
    if (!tag || tags.includes(tag)) return true;
    if (!TAG_PATTERN.test(tag)) {
      message('drawing-status', 'Tags are up to 30 letters, numbers, spaces, or hyphens.', true);
      return false;
    }
    if (tags.length >= 12) {
      message('drawing-status', 'A drawing can have up to 12 tags.', true);
      return false;
    }
    tags.push(tag);
    revision++;
    renderTagChips();
    return true;
  }
  $('tag-input').addEventListener('keydown', event => {
    const input = event.target;
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (addTag(input.value)) input.value = '';
    } else if (event.key === 'Backspace' && !input.value && tags.length) {
      tags.pop();
      revision++;
      renderTagChips();
    }
  });
  $('tag-input').addEventListener('blur', event => { if (event.target.value.trim() && addTag(event.target.value)) event.target.value = ''; });
  $('suggest-tags').addEventListener('click', async () => {
    if (!hasInk()) {
      message('drawing-status', 'Draw something on a visible layer first, then AI can describe it.', true);
      return;
    }
    const button = $('suggest-tags');
    button.disabled = true;
    button.textContent = '\u2726 Writing\u2026';
    try {
      const body = JSON.stringify({ title: $('title').value.trim().slice(0, 120), description: $('description').value.trim(), layers: docLayers() });
      const data = await postJSON('/api/describe', body);
      if (!$('description').value.trim() && data.description) { $('description').value = data.description; revision++; }
      data.tags.forEach(addTag);
      message('drawing-status', 'AI wrote a description and tags from your drawing. Change anything; it\u2019s how you\u2019ll find it.');
    } catch (error) {
      message('drawing-status', error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = '\u2726 Write them';
    }
  });

  // ---------------------------------------------------------------- save kinds: idea / asset / shot
  const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
  const TYPE_LABELS = { character: 'Character', prop: 'Prop', environment: 'Backdrop', fx: 'Effect', other: 'Other' };
  const typeLabel = type => TYPE_LABELS[type] || type;
  const KIND_TEXT = {
    asset: { label: 'Name', placeholder: 'Leave blank: AI names it', save: 'Save',
      hint: 'AI describes and tags it on save, so you can find it by words.' },
    shot: { label: 'Shot name', placeholder: 'Names itself, e.g. LittleFox_03', save: 'Save shot',
      hint: 'It shows up on the page of every asset in it, searchable by what happens.' },
    idea: { label: 'Name', placeholder: 'Chase scene thumbnail', save: 'Save idea',
      hint: 'A loose idea to find later by describing it. <i>e.g. "that moody forest".</i>' }
  };
  let saveKind = 'asset';
  let editing = null; // the saved asset or shot this canvas came from: { kind, id, version?, code? }

  function setSaveKind(kind) {
    if (editing && editing.kind !== kind) {
      // The name belongs to the asset/shot being edited; this canvas now becomes a new one of another kind.
      editing = null;
      $('title').value = '';
    }
    saveKind = kind;
    renderSaveKind();
  }
  function renderSaveKind() {
    const text = KIND_TEXT[saveKind];
    document.querySelectorAll('.kind-switch button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.kind === saveKind)));
    document.querySelectorAll('.kind-fields').forEach(f => { f.hidden = f.dataset.for !== saveKind; });
    $('title-label').textContent = text.label;
    $('title').placeholder = text.placeholder;
    $('title').maxLength = saveKind === 'asset' ? 80 : 120;
    $('kind-hint').innerHTML = text.hint; // static copy from KIND_TEXT only
    const updating = editing && editing.kind === saveKind;
    $('save-label').textContent = !updating ? text.save
      : saveKind === 'asset' ? `Save as v${editing.version + 1}` : `Update ${editing.code}`;
    $('save-new').hidden = !updating;
    $('save-heading').textContent = !updating ? 'Save to your library'
      : saveKind === 'asset' ? `Save ${$('title').value.trim() || 'it'} as v${editing.version + 1}` : `Save changes to ${editing.code}`;
    // An animated scene is one tap from a link: unsaved, the button saves first.
    const savedScene = editing && editing.kind === 'shot';
    $('share-open').hidden = !(saveKind === 'shot' && (savedScene || frames.length > 1));
    $('share-open').textContent = savedScene ? '\ud83d\udd17 Share this shot' : '\ud83d\udd17 Save & share';
    const placed = [...new Map(frames.flat().filter(layer => layer.asset).map(layer => [layer.asset.asset_id, layer])).values()];
    $('shot-links').textContent = placed.length
      ? `\u25c6 In this shot: ${placed.map(layer => `${layer.name} v${layer.asset.version}`).join(', ')}`
        + (frames.length > 1 ? ` \u00b7 \ud83c\udf9e ${frames.length} frames at ${fps} fps` : '')
      : 'Tip: open Assets below and tap \u25c6 Place to add one.';
    renderCrumbs();
  }
  document.querySelectorAll('.kind-switch button').forEach(b => b.addEventListener('click', () => setSaveKind(b.dataset.kind)));
  $('asset-type').addEventListener('change', renderCrumbs);
  // A field that needs attention can't hide inside a closed panel.
  $('save-form').addEventListener('invalid', () => { $('save-card').open = true; }, true);
  $('save-new').addEventListener('click', () => {
    editing = null;
    renderSaveKind();
    $('save-form').requestSubmit();
  });

  // Any words make a scene code: spaces and symbols become _, and it's trimmed to the 40 characters a code allows.
  function sceneCode(name) {
    if (CODE.test(name)) return name;
    const code = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9.-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40).replace(/_+$/, '');
    const stamp = new Date();
    return CODE.test(code) ? code : `Scene_${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}`;
  }
  function savePayload(name) {
    // Frames, or placed assets, make it a shot: no need to ask (and the name you typed stays).
    if (saveKind === 'asset' && (frames.length > 1 || layers.some(layer => layer.asset))) {
      if (editing?.kind === 'asset') editing = null;
      saveKind = 'shot';
      renderSaveKind();
    }
    const base = { description: $('description').value.trim(), layers: docStack(frames[0]), tags };
    if (saveKind === 'idea') return { path: '/api/drawings', method: 'POST', body: { title: name, ...base } };
    const updating = editing && editing.kind === saveKind;
    const history = pendingEvents();
    if (saveKind === 'asset') {
      return { path: updating ? `/api/assets/${editing.id}` : '/api/assets', method: updating ? 'PUT' : 'POST', history,
        body: { name, type: $('asset-type').value, ...base, history, ...(pendingOrigin && !updating ? { origin: pendingOrigin } : {}) } };
    }
    const project = $('shot-project').value.trim() || 'demo';
    // Name it in plain words; the scene's code comes from them ("Rocket takeoff" saves as Rocket_takeoff).
    name = sceneCode(name);
    // Studios name shots SEQ_SHOT (SQ070_0010), so a blank sequence comes from a code shaped like that.
    let sequence = $('shot-sequence').value.trim();
    if (!sequence && /^[A-Za-z]+\d+_\d+$/.test(name)) $('shot-sequence').value = sequence = name.split('_')[0];
    if (!sequence) $('shot-sequence').value = sequence = 'SCENE';
    for (const [label, value] of [['Project', project], ['Sequence', sequence]]) {
      if (!CODE.test(value)) throw new Error(`${label}: letters, numbers, _ . or - only (no spaces). e.g. SQ010`);
    }
    return { path: updating ? `/api/shots/${editing.id}` : '/api/shots', method: updating ? 'PUT' : 'POST', history,
      body: { code: name, project, sequence, status: $('shot-status').value, assignee: $('shot-assignee').value.trim(), ...base,
        frames: frames.slice(1).map(stack => ({ layers: compactStack(stack, frames[0]) })), fps, history,
        ...(sceneMotion && frames.length > 1 ? { motion: sceneMotion } : {}), ...(sceneSketch && frames.length > 1 ? { sketch: sceneSketch } : {}) } };
  }

  // Before a *new* asset is saved, check the library for one that already looks like it.
  let skipDuplicateCheck = false;
  async function duplicateCheck(name) {
    if (skipDuplicateCheck) { skipDuplicateCheck = false; return false; }
    message('drawing-status', 'Checking your library for look-alikes...');
    let matches;
    try {
      matches = (await postJSON('/api/assets/similar', JSON.stringify({ layers: docLayers() }))).items;
    } catch {
      return false; // the check is a courtesy; never block a save on it
    }
    if (!matches.length) return false;
    const match = matches[0];
    message('drawing-status', `This looks like "${match.name}" (v${match.version}) already in your library. Same thing?`, false, [
      { label: `Yes: save as v${match.version + 1} of ${match.name}`,
        tip: `New version|Saves this drawing as v${match.version + 1} of "${match.name}". Scenes using it get flagged to update.`,
        run: () => {
          editing = { kind: 'asset', id: match.id, version: match.version };
          $('title').value = match.name;
          $('asset-type').value = match.type;
          renderSaveKind();
          skipDuplicateCheck = true;
          $('save-form').requestSubmit();
        } },
      { label: 'No, it\'s new', run: () => { skipDuplicateCheck = true; $('save-form').requestSubmit(); } },
      { label: 'Where is it used?', run: () => openWhereUsed(match) }
    ]);
    return true;
  }

  $('save-form').addEventListener('submit', event => {
    // "Flipbook" on an unsaved shot opened its tab on the tap (so no popup blocker): fill it once saved, else close it.
    const tab = flipbookTab;
    flipbookTab = null;
    saveCanvas(event).then(id => {
      if (!tab) return;
      if (id) tab.location.href = flipbookUrl(id);
      else tab.close();
    });
  });
  async function saveCanvas(event) {
    event.preventDefault();
    const wantShare = shareAfterSave; // one-shot: any early return below drops it
    shareAfterSave = false;
    if (!hasInk(frames[0]) || busy()) {
      message('drawing-status', frames.length > 1 ? 'Frame 1 needs some ink on a visible layer before saving.'
        : 'Draw something on a visible layer before saving.', true);
      return;
    }
    if ($('tag-input').value.trim() && addTag($('tag-input').value)) $('tag-input').value = '';
    let name = $('title').value.trim();
    if (!name) {
      // No name? AI names it (with its description and tags, in the same call), or a shot names itself.
      name = saveKind === 'shot' ? shotName() : await nameIt();
      if (!name) return;
      $('title').value = name;
    }
    let request;
    try {
      request = savePayload(name);
    } catch (error) {
      message('drawing-status', error.message, true);
      return;
    }
    // AI wrote the description and tags of the last save, and the art (or motion) changed since: write them again.
    const signature = artSignature(request.body);
    if (autoMeta && autoMeta.kind === saveKind && autoMeta.signature !== 'fresh' && signature !== autoMeta.signature && request.body.description === autoMeta.description
      && request.body.tags.join('|') === autoMeta.tags.join('|')) {
      request.body.description = '';
      request.body.tags = [];
    }
    const kind = saveKind;
    const payload = JSON.stringify(request.body);
    const limit = kind === 'shot' ? 8 : 2;
    if (new Blob([payload]).size > limit * 1024 * 1024) {
      message('drawing-status', `This is over ${limit} MiB. Undo a few strokes${frames.length > 1 ? ' or delete a frame' : ''}, or download it as a PNG.`, true);
      return;
    }
    $('save').disabled = true;
    if (kind === 'asset' && request.method === 'POST' && await duplicateCheck(name)) {
      $('save').disabled = false;
      return;
    }
    skipDuplicateCheck = false;
    const savingRevision = revision;
    const auto = !request.body.tags.length || !request.body.description;
    message('drawing-status', `Saving.${auto ? ' AI describes and tags it,' : ''} Voyage embeds it into Atlas...`);
    try {
      const saved = await api(request.path, { method: request.method, headers: { 'Content-Type': 'application/json' }, body: payload });
      savedRevision = savingRevision;
      if (request.history) {
        // This save's events are now part of the stored trail.
        savedHistory = [...(request.method === 'PUT' ? savedHistory : []), ...request.history,
          { at: new Date().toISOString(), by: 'studio', action: 'Saved', detail: saved.version ? `v${saved.version}` : `${frames.length} frame${frames.length === 1 ? '' : 's'}` }];
        journal = [];
        handStrokes = 0;
        pendingOrigin = null;
      }
      $('save').classList.remove('saved');
      void $('save').offsetWidth;
      $('save').classList.add('saved');
      if (saved.tags_status === 'auto' && revision === savingRevision) {
        tags = [...saved.tags];
        renderTagChips();
        if (saved.description && (!$('description').value.trim() || $('description').value.trim() === autoMeta?.description)) $('description').value = saved.description;
      }
      // Remember what AI wrote, so a later change to the art can have it rewritten (what the artist typed is never touched).
      autoMeta = saved.tags_status === 'auto' ? { kind, signature, description: $('description').value.trim(), tags: [...tags] }
        : saved.tags_status === 'provided' && autoMeta?.kind === kind && $('description').value.trim() === autoMeta.description ? { ...autoMeta, signature } : null;
      const note = saved.tags_status === 'auto' ? ` AI described it${saved.description ? `: \u201c${saved.description}\u201d` : ''} \u00b7 #${(saved.tags || []).slice(0, 5).join(' #')}.`
        : saved.tags_status === 'unavailable' ? ' AI couldn\u2019t describe it this time; add words in Description & tags.' : '';
      if (kind === 'asset') {
        editing = { kind, id: saved.id, version: saved.version };
        if (pendingRig && pendingRig.sig === rigSig()) { // rigged before saving: keep it with this version (no AI)
          const rig = pendingRig.rig;
          api(`/api/assets/${encodeURIComponent(saved.id)}/rig`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rig }) })
            .then(() => rigCache.set(`${saved.id}@${saved.version}`, rig)).catch(() => { /* rigged again on its first shot */ });
        }
        loadSceneBackdrops();
        if (pendingVary) {
          const goal = pendingVary;
          pendingVary = null;
          openVariations({ ...saved, type: saved.type || $('asset-type').value, tags: saved.tags || tags }, goal);
        }
        const savedItem = { ...saved, type: saved.type || $('asset-type').value, ...(request.method === 'POST' ? { uses: 0 } : {}) };
        lastSavedAsset = savedItem;
        const backdrop = savedItem.type === 'environment';
        message('drawing-status', `\u2713 Saved ${backdrop ? '\u25a3' : '\u25c6'} ${saved.name} v${saved.version}.${note} Next:`, false, backdrop ? [
          { label: '\u25c6 Pick an asset for a shot here', tip: `Shots in ${saved.name}|It\u2019s now the backdrop for your next shot. Pick who stars in it.`, run: () => { castInScene(savedItem); setView('home'); } },
          { label: '+ New backdrop', run: () => newCanvas('backdrop') },
          { label: '+ New asset', run: () => newCanvas('asset') }
        ] : [
          { label: '\u3030 Make a shot with it', tip: `New shot|A fresh ${MIN_SHOT}-second shot starring it, with the Path tool ready.`, run: () => castInScene(savedItem) },
          { label: '+ New asset', run: () => newCanvas('asset') },
          { label: '\u25c6 Its page', tip: 'Its page|Description, tags, and every shot it stars in.', run: () => openWhereUsed(savedItem) }
        ]);
      } else if (kind === 'shot') {
        editing = { kind, id: saved.id, code: saved.code };
        if (wantShare) setTimeout(openShare);
        const first = saved.assets?.[0];
        // The magic moment, said plainly: saving is embedding, and a shot is found from the assets in it.
        const names = (saved.assets || []).map(a => a.name);
        if (first && shotStar?.id === first.id && request.method === 'POST') shotStar = { ...shotStar, uses: (shotStar.uses ?? 0) + 1 };
        message('drawing-status', `\u2713 Saved ${saved.code || 'your shot'}.${note}${names.length ? ` It\u2019s on ${names.join(' and ')}\u2019s page, searchable by what happens.` : ''}`, false,
          [...(first ? [{ label: '\u3030 Another shot', tip: `Another shot|${first.name} again, on a fresh ${MIN_SHOT}-second canvas, same backdrop. Drag a new path.`, run: () => castInScene({ id: first.id, name: first.name, uses: shotStar?.id === first.id ? shotStar.uses : undefined }) },
            { label: `\u25c6 ${first.name}`, tip: `${first.name}|Its page: every shot it stars in, searchable.`, run: () => openWhereUsed({ id: first.id, name: first.name }) }] : []),
            ...(frames.length > 1 ? [{ label: '\ud83c\udf9e Flipbook', tip: FLIPBOOK_TIP, run: () => flipbookNow() },
              { label: '\ud83d\udd17 Share it', tip: 'Share|A public link: your shot as a looping GIF, with how it moves explained.', run: () => openShare() }] : []),
            { label: '\u2190 Your assets', run: () => setView('home') }]);
      } else {
        message('drawing-status', `Idea saved.${note} Find it later by describing it.`, false, [
          { label: '\u25c6 Make it an asset', tip: 'Make it an asset|Assets can be placed in scenes, and always know where they\'re used.', run: () => { setSaveKind('asset'); $('save-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('title').focus({ preventScroll: true }); } }
        ]);
      }
      renderSaveKind();
      await loadGallery(currentQuery);
      return kind === 'shot' ? saved.id : null;
    } catch (error) {
      message('drawing-status', `${error.message} Your work is still on the canvas.`, true);
    } finally {
      $('save').disabled = false;
    }
    return null;
  }

  // ---------------------------------------------------------------- opening saved work
  async function openRecord(path, apply) {
    if (revision !== savedRevision && !confirm('Replace your current canvas? Unsaved changes will be lost.')) return;
    const loadingRevision = revision;
    try {
      const record = await api(path);
      if (revision !== loadingRevision) {
        message('drawing-status', 'You changed the canvas while loading. Open it again to replace it.', true);
        return;
      }
      stopPlay();
      frames = expandRecord(record).map(stack => stack.map(layer => newLayer(layer.name, {
        visible: layer.visible, opacity: layer.opacity, strokes: layer.strokes, asset: layer.asset || null, backdrop: layer.backdrop || null,
        ...(layer.xf ? { xf: layer.xf, bend: layer.bend, xfBase: layer.xfBase, xfStrokes: layer.xfStrokes } : {})
      })));
      sceneMotion = record.motion || null;
      sceneSketch = record.sketch || null;
      frameIndex = 0;
      layers = frames[0];
      resyncSeq();
      fps = record.fps || 12;
      $('fps').value = String(fps);
      journal = [];
      handStrokes = 0;
      savedHistory = record.history || [];
      pendingOrigin = null;
      activeId = layers[layers.length - 1].id;
      undoStack.length = 0;
      redoStack.length = 0;
      opacityBefore = null;
      guides.length = 0;
      sparks.length = 0;
      setTool(drawTool);
      $('description').value = record.description || '';
      tags = [...(record.tags || [])];
      renderTagChips();
      const note = apply(record);
      revision++;
      savedRevision = revision;
      closePopover();
      recount();
      rebuildOnion();
      rebuildAll();
      renderFrames();
      renderOverlay();
      renderTray();
      autoMeta = null;
      keptPaths = null;
      shotStar = null;
      setView('studio');
      renderSaveKind();
      message('drawing-status', note);
    } catch (error) {
      message('drawing-status', error.message, true);
    }
  }
  const layerCount = () => `${layers.length} layer${layers.length === 1 ? '' : 's'}`;
  const openAsset = id => openRecord(`/api/assets/${encodeURIComponent(id)}`, record => {
    editing = { kind: 'asset', id: record.id, version: record.version };
    saveKind = 'asset';
    $('title').value = record.name;
    $('asset-type').value = record.type;
    return `Editing asset "${record.name}" v${record.version}. Saving makes v${record.version + 1}; scenes using older versions get flagged.`;
  });
  const openShot = id => openRecord(`/api/shots/${encodeURIComponent(id)}`, record => {
    editing = { kind: 'shot', id: record.id, code: record.code };
    saveKind = 'shot';
    $('title').value = record.code;
    $('shot-project').value = record.project;
    $('shot-sequence').value = record.sequence;
    $('shot-status').value = record.status;
    $('shot-assignee').value = record.assignee || '';
    const animated = frames.length > 1 ? `, ${(frames.length / fps).toFixed(0)} s. Space plays; \ud83c\udf9e Flipbook riffles it` : '';
    return `Opened ${record.code}${animated}. Saving updates it in place.`;
  });

  // ---------------------------------------------------------------- library tabs
  function resetLibrarySearch(load = true) {
    $('query').value = '';
    currentQuery = '';
    if (load) loadGallery();
  }
  // Searches that show off meaning, not keywords: none of these words need to be in a name or a tag.
  const SEARCH_HINTS = ['a spaceship', 'a cute animal', 'something broken', 'something that flies'];
  function renderSearchHints() {
    $('search-hints').replaceChildren(el('small', '', 'Try'), ...SEARCH_HINTS.map(hint => {
      const chip = el('button', 'example', hint);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        $('query').value = hint;
        loadGallery(hint);
      });
      return chip;
    }));
  }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function thumbButton(item, label, onOpen) {
    const button = el('button', 'thumb-button');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    const image = el('img');
    image.src = item.image_url;
    image.alt = '';
    image.loading = 'lazy';
    button.append(image);
    button.addEventListener('click', onOpen);
    return button;
  }
  function assetCard(item) {
    const card = el('div', 'card asset-card');
    const text = el('span', 'card-text');
    const uses = item.uses ?? 0;
    text.append(el('strong', '', item.name),
      el('small', '', `${typeLabel(item.type)} \u00b7 ${uses ? `in ${plural(uses, 'shot')}` : 'no shots yet'}`));
    if (item.description) text.append(el('small', 'asset-card-about', item.description));
    if (item.tags?.length) text.append(el('small', 'asset-card-tags', item.tags.slice(0, 5).map(tag => `#${tag}`).join(' ')));
    if (item.score != null) text.append(el('small', 'score-line', `similarity ${item.score.toFixed(2)}`));
    const actions = el('div', 'card-actions');
    const backdrop = item.type === 'environment';
    actions.append(actionButton(backdrop ? '\u25a3 Use as backdrop' : '\u3030 New shot', 'primary-mini',
      backdrop ? 'Use as backdrop|Sets the scene for your next shots.' : `New shot|A fresh ${MIN_SHOT}-second shot starring it, with the Path tool ready.`,
      () => castInScene(item)),
      actionButton(uses ? `\ud83c\udf9e Shots (${uses})` : 'Open', '', 'Open|Its description, tags, and every shot it stars in, searchable.', () => openWhereUsed(item)));
    const thumb = thumbButton(item, `Open ${item.name}`, () => openWhereUsed(item));
    thumb.draggable = true;
    thumb.addEventListener('dragstart', event => {
      event.dataTransfer.setData('application/x-inkling-asset', JSON.stringify({ id: item.id, name: item.name }));
      event.dataTransfer.effectAllowed = 'copy';
    });
    card.append(thumb, text, actions);
    return card;
  }
  function renderResults(items, { query = '', filterText = '', sketch = false } = {}) {
    const cards = items.map(assetCard);
    cards.forEach((card, i) => card.style.setProperty('--i', Math.min(i, 12)));
    if (!cards.length) {
      cards.push(el('div', 'empty', query || sketch || filterText ? 'No matches. Try other words or another sketch, or give new saves a moment.'
        : 'Nothing here yet. Draw something and save it: AI describes and tags it, so you can find it by words.'));
    }
    $('results').replaceChildren(...cards);
    const matches = `${items.length} match${items.length === 1 ? '' : 'es'}`;
    message('library-status', sketch ? `${matches} for your drawing, most similar first.`
      : query ? `${matches}${filterText}, most similar first (Voyage AI).`
      : `${items.length} asset${items.length === 1 ? '' : 's'}${filterText}. Open one to see and search its shots.`);
  }
  // The receipt under results: which engine answered, and how long it took. Search, demystified.
  function timingNote(timing) {
    if (!timing) return '';
    if ('embed_ms' in timing) return timing.embeddings ? ` Voyage ${timing.embed_ms} ms \u00b7 Atlas ${timing.search_ms} ms.`
      : ` No new embeddings: Atlas ${timing.search_ms} ms.`;
    return ` ${timing.embeddings} Voyage embedding${timing.embeddings === 1 ? '' : 's'} + Atlas, ${timing.ms} ms.`;
  }
  // Search by how things were made: art math is stored on every asset in Atlas and used as vector filters.
  let handOnly = false;
  let assetColor = '';
  const COLOR_CHIPS = { red: '#dc2626', orange: '#f97316', yellow: '#eab308', green: '#16a34a', blue: '#2563eb', purple: '#7c3aed', pink: '#ec4899', brown: '#92400e' };
  function renderAssetFilters() {
    const hand = el('button', 'filter-chip', '\u270d Mostly by hand');
    hand.type = 'button';
    hand.setAttribute('aria-pressed', String(handOnly));
    hand.dataset.tip = 'Mostly by hand|At least 80% of the visible strokes were drawn by a person (not AI, not a starter kit).';
    hand.addEventListener('click', () => { handOnly = !handOnly; renderAssetFilters(); loadGallery(currentQuery); });
    const dots = Object.entries(COLOR_CHIPS).map(([name, color]) => {
      const dot = el('button', 'color-chip');
      dot.type = 'button';
      dot.style.setProperty('--c', color);
      dot.setAttribute('aria-label', `Has ${name}`);
      dot.setAttribute('aria-pressed', String(assetColor === name));
      dot.dataset.tip = `Has ${name}|Assets whose palette includes ${name}.`;
      dot.addEventListener('click', () => { assetColor = assetColor === name ? '' : name; renderAssetFilters(); loadGallery(currentQuery); });
      return dot;
    });
    $('asset-filters').replaceChildren(hand, ...dots);
  }
  // Search is for assets: by words (Voyage AI + Atlas Vector Search over picture, name, description, and tags) or
  // the latest first. Scenes are found from the asset that stars in them.
  async function loadGallery(query = '') {
    currentQuery = query;
    galleryRequest?.abort();
    const controller = new AbortController();
    galleryRequest = controller;
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (handOnly) params.set('hand_min', '0.8');
    if (assetColor) params.set('color', assetColor);
    const filterText = (handOnly ? ', mostly by hand' : '') + (assetColor ? `, with ${assetColor}` : '');
    message('library-status', query ? `Looking for assets${filterText} with Voyage AI...` : 'Opening your assets...');
    try {
      const data = await api(`/api/assets?${params}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      renderResults(data.items, { query, filterText });
    } catch (error) {
      if (error.name !== 'AbortError') {
        $('results').replaceChildren();
        message('library-status', error.message, true);
      }
    }
  }
  async function searchBySketch() {
    $('query').value = '';
    currentQuery = '';
    findSimilar();
  }
  $('search-sketch').addEventListener('click', searchBySketch);
  $('search-form').addEventListener('submit', event => {
    event.preventDefault();
    const query = $('query').value.trim();
    if (query) loadGallery(query);
  });
  $('browse').addEventListener('click', () => {
    $('query').value = '';
    loadGallery();
  });

  // ---------------------------------------------------------------- where used
  let whereAsset = null;
  let whereRequest = null;
  let whereOutdated = [];
  // The asset page: what it is (described and tagged by AI on save), what you can do with it, and every shot
  // it stars in, searchable by meaning within this asset alone.
  const closeAssetPage = run => () => { $('where-used').close(); run(whereAsset); };
  function renderAssetHead(item) {
    $('wu-title').textContent = item.name;
    $('wu-sub').textContent = item.type ? `${typeLabel(item.type)} \u00b7 v${item.version}` : '';
    $('wu-about').textContent = item.description || '';
    $('wu-about').hidden = !item.description;
    $('wu-tags').replaceChildren(...(item.tags || []).map(tag => el('span', 'asset-page-tag', `#${tag}`)));
    $('wu-tags').hidden = !item.tags?.length;
    $('wu-animate').textContent = item.type === 'environment' ? '\u25a3 Use as backdrop' : '\u3030 New shot';
    document.querySelectorAll('.wu-name').forEach(node => { node.textContent = item.name; });
  }
  function openWhereUsed(item) {
    whereAsset = item;
    renderAssetHead(item);
    $('wu-thumb').src = item.image_url || `/api/assets/${encodeURIComponent(item.id)}/image`;
    $('wu-q').value = '';
    if (!$('where-used').open) $('where-used').showModal();
    runWhereUsed();
  }
  $('wu-animate').addEventListener('click', closeAssetPage(item => castInScene(item)));
  $('wu-edit').addEventListener('click', closeAssetPage(item => openAsset(item.id)));
  $('wu-refine').addEventListener('click', closeAssetPage(item => refineAsset(item)));
  $('wu-place').addEventListener('click', closeAssetPage(item => { showTop(); startPlacing(item); }));
  $('wu-vary').addEventListener('click', closeAssetPage(item => openVariations(item)));
  $('wu-breakdown').addEventListener('click', closeAssetPage(item => breakdownOfAsset(item.id)));
  function meter(score) {
    // Scores are similarity, not probability: show a meter and a plain label, the number on hover.
    const strong = score >= 0.82;
    const wrap = el('span', `meter ${strong ? 'strong' : 'possible'}`);
    wrap.dataset.tip = `Similarity ${score.toFixed(2)}|How alike the pictures are (0 to 1). 0.82 and up usually means the same thing redrawn; lower means similar shapes. It is not a percentage chance.`;
    const bar = el('span', 'meter-bar');
    const fill = el('span', 'meter-fill');
    fill.style.width = `${Math.max(8, Math.min(100, (score - 0.6) / 0.4 * 100))}%`;
    bar.append(fill);
    wrap.append(bar, el('span', 'meter-label', strong ? 'Very similar' : 'Somewhat similar'));
    return wrap;
  }
  function actionButton(label, className, tip, run) {
    const button = el('button', `mini ${className}`, label);
    button.type = 'button';
    if (tip) button.dataset.tip = tip;
    button.addEventListener('click', run);
    return button;
  }
  function whereCard(entry) {
    const card = el('article', `wu-card ${entry.match}${entry.outdated ? ' outdated' : ''}`);
    const open = () => { $('where-used').close(); openShot(entry.shot_id); };
    const figure = el('button', 'wu-figure');
    figure.type = 'button';
    figure.setAttribute('aria-label', `Open scene ${entry.code}`);
    figure.dataset.tip = `Open ${entry.code}|Opens the scene on the canvas to edit.`;
    const image = el('img');
    image.src = `${entry.image_url}?t=${Date.now()}`;
    image.alt = '';
    figure.append(image);
    if (entry.box) {
      // Highlights where in the shot the asset (or its look-alike) sits.
      const box = el('span', 'wu-box');
      Object.assign(box.style, { left: `${entry.box.x * 100}%`, top: `${entry.box.y * 100}%`, width: `${entry.box.w * 100}%`, height: `${entry.box.h * 100}%` });
      figure.append(box);
    }
    figure.addEventListener('click', open);
    const text = el('div', 'card-text');
    text.append(el('strong', '', entry.code));
    const actions = el('div', 'wu-actions');
    if (entry.match === 'linked') {
      const why = entry.outdated
        ? el('p', 'why outdated', `\u26a0 Shows v${entry.placed_version}. The asset is now v${whereAsset.version}.`)
        : el('p', 'why current', `\u2714 Up to date (v${entry.placed_version})${entry.layer_name ? '' : ' \u00b7 its layer is hidden'}`);
      text.append(why);
      if (entry.outdated) {
        actions.append(actionButton(`Update to v${whereAsset.version}`, 'primary-mini',
          `Update to v${whereAsset.version}|Swaps the new drawing into the same spot. The old one is kept as a hidden backup layer, so nothing is lost.`,
          () => syncShots([entry])));
      }
    } else {
      text.append(el('p', 'why', `Layer "${entry.layer_name}" looks like ${whereAsset.name}.`), meter(entry.score));
      actions.append(actionButton(`Yes, it's ${whereAsset.name}`, 'confirm-mini',
        `Confirm it|Links this layer to the asset (the drawing doesn't change). It moves to Linked uses, so it shows up in future checks.`,
        () => confirmLookAlike(entry)));
    }
    actions.append(actionButton('Open', '', null, open));
    card.append(figure, text, actions);
    return card;
  }
  function similarAssetCard(item, index) {
    const card = el('article', 'wu-card asset-twin');
    card.style.setProperty('--i', index);
    const go = () => openWhereUsed(item);
    const figure = el('button', 'wu-figure');
    figure.type = 'button';
    figure.setAttribute('aria-label', `Open ${item.name}`);
    const image = el('img');
    image.src = item.image_url;
    image.alt = '';
    figure.append(image);
    figure.addEventListener('click', go);
    const text = el('div', 'card-text');
    text.append(el('strong', '', item.name), el('small', '', `${typeLabel(item.type)} \u00b7 v${item.version}`));
    if (item.score != null) text.append(meter(item.score));
    const actions = el('div', 'wu-actions');
    actions.append(
      actionButton('Open', 'where-mini', `Open ${item.name}|Its page: description, tags, and its shots.`, go),
      actionButton('Edit', '', null, () => { $('where-used').close(); openAsset(item.id); }));
    card.append(figure, text, actions);
    return card;
  }
  function familyCard(item, index) {
    const card = similarAssetCard({ ...item, score: null }, index);
    card.classList.add('kin');
    card.querySelector('.meter')?.remove();
    card.querySelector('.card-text').append(el('p', 'why', item.relation));
    return card;
  }
  // A found shot (search within this asset): its picture, what it's about, and how long it runs.
  function assetShotCard(item) {
    const placed = (item.assets || []).find(a => a.id === whereAsset?.id);
    const outdated = !!placed && !!whereAsset?.version && placed.version < whereAsset.version;
    const card = el('article', `wu-card linked${outdated ? ' outdated' : ''}`);
    const open = () => { $('where-used').close(); openShot(item.id); };
    const figure = el('button', 'wu-figure');
    figure.type = 'button';
    figure.setAttribute('aria-label', `Open shot ${item.code}`);
    const image = el('img');
    image.src = item.image_url;
    image.alt = '';
    figure.append(image);
    if (item.frames > 1) figure.append(el('span', 'frame-badge', `\ud83c\udf9e ${(item.frames / (item.fps || MOTION_FPS)).toFixed(0)} s`));
    figure.addEventListener('click', open);
    const text = el('div', 'card-text');
    text.append(el('strong', '', item.code));
    if (item.description) text.append(el('p', 'why', item.description));
    if (item.tags?.length) text.append(el('small', 'asset-card-tags', item.tags.slice(0, 5).map(tag => `#${tag}`).join(' ')));
    const actions = el('div', 'wu-actions');
    if (outdated) {
      text.append(el('p', 'why outdated', `\u26a0 Shows v${placed.version}. ${whereAsset.name} is now v${whereAsset.version}.`));
      actions.append(actionButton(`Update to v${whereAsset.version}`, 'primary-mini',
        `Update to v${whereAsset.version}|Swaps the new drawing into the same spot. The old one is kept as a hidden backup layer.`,
        () => syncShots([{ shot_id: item.id }])));
    }
    actions.append(actionButton('Open', outdated ? '' : 'primary-mini', null, open));
    if (item.frames > 1) actions.append(actionButton('\ud83c\udf9e Flipbook', '', FLIPBOOK_TIP, () => openFlipbook(item.id, item.code || item.name)));
    card.append(figure, text, actions);
    return card;
  }
  const wuEmpty = (text, hint) => { const box = el('div', 'wu-empty'); box.append(el('b', '', text), el('span', '', hint)); return box; };
  async function searchAssetShots(query) {
    if (!whereAsset) return;
    if (!query) { runWhereUsed(); return; }
    whereRequest?.abort();
    const controller = new AbortController();
    whereRequest = controller;
    message('wu-status-line', `Searching ${whereAsset.name}\u2019s shots for \u201c${query}\u201d\u2026`);
    try {
      const params = new URLSearchParams({ asset_id: whereAsset.id, q: query.slice(0, 500) });
      const data = await api(`/api/shots?${params}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      $('wu-linked').replaceChildren(...(data.items.length ? data.items.map(assetShotCard)
        : [wuEmpty('No shots match.', 'Try other words. Every shot is described and tagged on save.')]));
      [...$('wu-linked').children].forEach((card, i) => card.style.setProperty('--i', i));
      $('wu-linked-count').textContent = `(${data.items.length})`;
      message('wu-status-line', `${plural(data.items.length, 'shot')} with ${whereAsset.name}, most similar to \u201c${query}\u201d first (Voyage AI + Atlas, filtered to this asset).`);
    } catch (error) {
      if (error.name !== 'AbortError') message('wu-status-line', error.message, true);
    }
  }
  $('wu-search').addEventListener('submit', event => { event.preventDefault(); searchAssetShots($('wu-q').value.trim()); });
  $('wu-q').addEventListener('search', () => { if (!$('wu-q').value.trim()) runWhereUsed(); });
  // Opening an asset costs no embedding: its shots are a plain query on their links. Look-alikes, family, and
  // similar assets (vector searches) load only when "More like it" is opened.
  async function runWhereUsed() {
    if (!whereAsset) return;
    whereRequest?.abort();
    const controller = new AbortController();
    whereRequest = controller;
    $('wu-more').open = false;
    whereMoreFor = null;
    message('wu-status-line', 'Opening its shots\u2026');
    $('wu-linked').replaceChildren();
    try {
      const [asset, shots] = await Promise.all([
        whereAsset.version ? null : api(`/api/assets/${encodeURIComponent(whereAsset.id)}`, { signal: controller.signal }),
        api(`/api/shots?asset_id=${encodeURIComponent(whereAsset.id)}`, { signal: controller.signal })]);
      if (controller.signal.aborted) return;
      if (asset) {
        whereAsset = { ...whereAsset, ...asset, image_url: `/api/assets/${encodeURIComponent(asset.id)}/image?v=${asset.version}` };
        $('wu-thumb').src = whereAsset.image_url;
        renderAssetHead(whereAsset);
      }
      const items = shots.items;
      whereOutdated = items.filter(item => (item.assets || []).some(a => a.id === whereAsset.id && a.version < whereAsset.version))
        .map(item => ({ shot_id: item.id }));
      $('wu-linked').replaceChildren(...(items.length ? items.map(assetShotCard)
        : [wuEmpty('No shots yet.', `Tap \u3030 New shot: ${whereAsset.name} lands on a fresh canvas, ready to drag along a path.`)]));
      [...$('wu-linked').children].forEach((card, i) => card.style.setProperty('--i', i));
      $('wu-linked-count').textContent = `(${items.length})`;
      $('wu-search').hidden = items.length < 2;
      $('wu-update-all').hidden = whereOutdated.length < 2;
      $('wu-update-all').textContent = `Update all ${whereOutdated.length} to v${whereAsset.version}`;
      $('wu-update-all').dataset.tip = `Update all|Swaps v${whereAsset.version} into every outdated shot. Old drawings stay as hidden backup layers.`;
      message('wu-status-line', items.length > 1 ? 'Latest first. Search them by what happens in them.' : '');
    } catch (error) {
      if (error.name !== 'AbortError') message('wu-status-line', error.message, true);
    }
  }
  let whereMoreFor = null;
  async function loadWhereMore() {
    if (!whereAsset || whereMoreFor === whereAsset.id) return;
    whereMoreFor = whereAsset.id;
    for (const id of ['wu-similar', 'wu-family', 'wu-assets']) $(id).replaceChildren(wuEmpty('Looking\u2026', 'Voyage compares pictures across your library.'));
    try {
      const data = await api(`/api/assets/${encodeURIComponent(whereAsset.id)}/where-used`);
      if (whereMoreFor !== data.asset.id) return;
      const twins = data.similar_assets || [];
      const family = data.family || { parent: null, variants: [] };
      const kin = [...(family.parent ? [{ ...family.parent, relation: `Original \u00b7 varied from v${family.parent.from_version}` }] : []),
        ...family.variants.map(v => ({ ...v, relation: `Variant: ${v.origin?.brief || ''}` })),
        ...(family.siblings || []).map(v => ({ ...v, relation: `Sibling: ${v.origin?.brief || ''}` }))];
      $('wu-similar').replaceChildren(...(data.similar.length ? data.similar.map(whereCard)
        : [wuEmpty('No look-alikes.', 'Nothing unlinked looks like it. Nice and tidy.')]));
      $('wu-family').replaceChildren(...(kin.length ? kin.map((item, i) => familyCard(item, i))
        : [wuEmpty('No variations yet.', 'Tap \u2726 Variations to plan lookalikes from it.')]));
      $('wu-assets').replaceChildren(...(twins.length ? twins.map(similarAssetCard)
        : [wuEmpty('No similar assets.', 'It\'s one of a kind in your library.')]));
      [...$('wu-similar').children].forEach((card, i) => card.style.setProperty('--i', i));
      $('wu-similar-count').textContent = `(${data.similar.length})`;
      $('wu-family-count').textContent = `(${kin.length})`;
      $('wu-assets-count').textContent = `(${twins.length})`;
    } catch (error) {
      whereMoreFor = null;
      $('wu-similar').replaceChildren(wuEmpty('Couldn\u2019t look just now.', error.message));
    }
  }
  $('wu-more').addEventListener('toggle', () => { if ($('wu-more').open) loadWhereMore(); });
  async function syncShots(entries) {
    const asset = whereAsset;
    message('wu-status-line', `Updating ${plural(entries.length, 'shot')} to v${asset.version}...`);
    let done = 0;
    try {
      for (const entry of entries) {
        await api(`/api/shots/${encodeURIComponent(entry.shot_id)}/sync/${encodeURIComponent(asset.id)}`, { method: 'POST' });
        done++;
      }
      await runWhereUsed();
      message('wu-status-line', `Updated ${plural(done, 'shot')} to v${asset.version}. Old drawings stay as hidden backup layers.`);
      if (editing?.kind === 'shot' && entries.some(entry => entry.shot_id === editing.id)) {
        message('drawing-status', `${editing.code} was updated from the library. Reopen it to see the new version.`, false,
          [{ label: 'Reopen it', run: () => { savedRevision = revision; openShot(editing.id); } }]);
      }
    } catch (error) {
      message('wu-status-line', `${done ? `Updated ${done}, then: ` : ''}${error.message}`, true);
    }
  }
  $('wu-update-all').addEventListener('click', () => syncShots(whereOutdated));
  async function confirmLookAlike(entry) {
    message('wu-status-line', `Linking ${entry.code} to ${whereAsset.name}...`);
    try {
      await api(`/api/shots/${encodeURIComponent(entry.shot_id)}/link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_id: whereAsset.id, layer_index: entry.layer_index })
      });
      await runWhereUsed();
      $('wu-more').open = true;
      message('wu-status-line', `${entry.code} now links to ${whereAsset.name}. The drawing didn't change.`);
    } catch (error) {
      message('wu-status-line', error.message, true);
    }
  }
  $('wu-close').addEventListener('click', () => $('where-used').close());
  for (const id of ['where-used', 'help']) {
    $(id).addEventListener('click', event => { if (event.target === $(id)) $(id).close(); });
  }
  // ---------------------------------------------------------------- the finder: search from anywhere (Cmd/Ctrl+K, /)
  // One box, results by meaning as you type, and every result usable right here: place it, animate it,
  // set the scene, open it, or find more like it.
  const SEARCH_IDEAS = ['a cute animal', 'something that flies', 'a rocket', 'a sunny day', 'the moment it leaves the ground'];
  let finderRequest = null;
  let finderTimer = null;
  let finderAt = -1;
  const finderCache = new Map();
  function finderItems() { return [...$('finder-body').querySelectorAll('.finder-item')]; }
  function finderFocus(index) {
    const items = finderItems();
    if (!items.length) { finderAt = -1; return; }
    finderAt = (index + items.length) % items.length;
    items.forEach((item, i) => item.classList.toggle('active', i === finderAt));
    items[finderAt].scrollIntoView({ block: 'nearest' });
  }
  function finderAct(run) {
    return () => { $('finder').close(); run(); };
  }
  function finderCard({ image, title, meta, badge = '', actions }) {
    const card = el('div', 'finder-item');
    const thumb = el('span', 'finder-thumb');
    if (image instanceof HTMLElement) thumb.append(image);
    else if (image) { const img = el('img'); img.src = image; img.alt = ''; img.loading = 'lazy'; img.onerror = () => img.remove(); thumb.append(img); }
    if (badge) thumb.append(el('span', 'finder-badge', badge));
    const text = el('span', 'finder-text');
    text.append(el('strong', '', title), el('small', '', meta));
    const row = el('span', 'finder-actions');
    actions.forEach(([label, run, primary], i) => {
      const button = el('button', primary || i === 0 ? 'finder-go primary' : 'finder-go', label);
      button.type = 'button';
      button.addEventListener('click', event => { event.stopPropagation(); run(); });
      row.append(button);
    });
    card.append(thumb, text, row);
    card.addEventListener('click', () => actions[0][1]());
    return card;
  }
  function assetResult(item) {
    const backdrop = item.type === 'environment';
    return finderCard({ image: item.image_url, title: item.name,
      meta: item.description || `${typeLabel(item.type)}${item.uses ? ` \u00b7 in ${plural(item.uses, 'shot')}` : ''}`,
      actions: [['Open', finderAct(() => openWhereUsed(item))],
        backdrop ? ['Use as backdrop', finderAct(() => castInScene(item))] : ['\u3030 New shot', finderAct(() => castInScene(item))],
        ['\u25ce Similar', () => finderSimilar(item)]] });
  }
  function finderSection(title, cards) {
    if (!cards.length) return [];
    const head = el('h3', 'finder-head', title);
    head.append(el('span', 'results-count', String(cards.length)));
    const grid = el('div', 'finder-grid');
    grid.append(...cards);
    return [head, grid];
  }
  function renderFinderResults(items, note) {
    const parts = finderSection('Assets', items.map(assetResult));
    $('finder-body').replaceChildren(...(parts.length ? parts : [el('p', 'finder-empty', 'No assets match yet. Try other words, or search with your drawing.')]));
    $('finder-status').textContent = note;
    finderAt = -1;
  }
  function renderFinderHome() {
    const ideas = el('div', 'finder-ideas');
    ideas.append(el('small', '', 'Try'), ...SEARCH_IDEAS.map(idea => {
      const chip = el('button', 'example', idea);
      chip.type = 'button';
      chip.addEventListener('click', () => { $('finder-q').value = idea; runFinder(idea); });
      return chip;
    }));
    const blank = canvasIsBlank();
    const backdrops = STARTERS.filter(item => item.kind === 'shot' && item.id !== 'bounce').map(item => {
      if (!previewCache.has(item.id)) previewCache.set(item.id, starterPreview(item).toDataURL());
      return finderCard({ image: previewCache.get(item.id), title: `${item.icon} ${item.name}`, meta: blank ? 'Draw on it' : 'Set the scene',
        actions: blank ? [['Draw on it', finderAct(() => { showTop(); useStarter(item); })], ['Use as backdrop', finderAct(() => castStarter(item))]]
          : [['Use as backdrop', finderAct(() => castStarter(item))], ['Draw on it', finderAct(() => { showTop(); useStarter(item); })]] });
    });
    const parts = [ideas, ...finderSection('Starter backdrops', backdrops)];
    if (!account?.library?.assets) {
      const pack = el('button', 'finder-pack', '\ud83c\udf81 Add the starter pack: Little Fox, Red Rocket & friends');
      pack.type = 'button';
      pack.addEventListener('click', () => addStarterPack(pack));
      parts.push(pack);
    }
    $('finder-body').replaceChildren(...parts);
    $('finder-status').textContent = '';
    finderAt = -1;
    api('/api/assets').then(data => {
      if ($('finder-q').value.trim() || !$('finder').open) return;
      $('finder-body').append(...finderSection('Your latest', data.items.slice(0, 8).map(assetResult)));
    }).catch(() => {});
  }
  async function runFinder(query) {
    clearTimeout(finderTimer);
    finderRequest?.abort();
    if (!query) { renderFinderHome(); return; }
    const note = `Assets for \u201c${query}\u201d, by meaning: picture, name, description, and tags.`;
    if (finderCache.has(query)) { renderFinderResults(finderCache.get(query), note); return; }
    const controller = new AbortController();
    finderRequest = controller;
    $('finder-status').textContent = 'Searching by meaning\u2026';
    $('finder').classList.add('searching');
    try {
      const data = await api(`/api/assets?q=${encodeURIComponent(query.slice(0, 500))}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      finderCache.set(query, data.items);
      renderFinderResults(data.items, note);
    } catch (error) {
      if (error.name !== 'AbortError') $('finder-status').textContent = error.message;
    } finally {
      if (finderRequest === controller) $('finder').classList.remove('searching');
    }
  }
  async function finderSimilar(item) {
    finderRequest?.abort();
    const controller = new AbortController();
    finderRequest = controller;
    $('finder-q').value = '';
    $('finder-status').textContent = `Finding things like ${item.name}\u2026`;
    try {
      const data = await api(`/api/assets/${encodeURIComponent(item.id)}/similar`, { signal: controller.signal });
      if (!controller.signal.aborted) renderFinderResults(data.assets, `Like ${item.name}, by its stored vector (no new embedding).`);
    } catch (error) {
      if (error.name !== 'AbortError') $('finder-status').textContent = error.message;
    }
  }
  async function finderSketch() {
    if (!hasInk()) { $('finder-status').textContent = 'Draw something first: a quick doodle is enough. It becomes the search.'; return; }
    finderRequest?.abort();
    const controller = new AbortController();
    finderRequest = controller;
    $('finder-q').value = '';
    $('finder-status').textContent = 'Voyage AI is embedding your drawing\u2026';
    try {
      const data = await api('/api/search/sketch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'asset', layers: docLayers() }), signal: controller.signal });
      if (!controller.signal.aborted) renderFinderResults(data.items, 'Assets that look like your drawing.');
    } catch (error) {
      if (error.name !== 'AbortError') $('finder-status').textContent = error.message;
    }
  }
  function castStarter(item) {
    if (motionDraft) skipMotion();
    $('scene-backdrop').value = `starter:${item.id}`;
    showTop();
    flashTray(`${item.icon} ${item.name} is the backdrop for your next flipbook.`);
  }
  async function addStarterPack(button = null) {
    if (button) { button.disabled = true; button.textContent = 'Adding\u2026'; }
    try {
      const result = await api('/api/library/starter', { method: 'POST' });
      if (account) { account.library = result.library; renderAccount(); }
      loadGallery(currentQuery);
      loadSceneBackdrops();
      if ($('finder').open && !$('finder-q').value.trim()) renderFinderHome();
      return result.added.assets;
    } catch (error) {
      if (button) { button.disabled = false; button.textContent = error.message; }
      return 0;
    }
  }
  function openFinder(query = '') {
    if (offline) { flashTray('Search comes back with the connection. Your canvas works offline.', true); return; }
    if ($('finder').open) { $('finder-q').focus(); return; }
    closeNudge();
    closeKit();
    $('finder-q').value = query;
    $('finder').showModal();
    $('finder-q').focus();
    runFinder(query);
  }
  $('finder-open').addEventListener('click', () => openFinder());
  $('finder-close').addEventListener('click', () => $('finder').close());
  $('finder-sketch').addEventListener('click', finderSketch);
  $('finder').addEventListener('click', event => { if (event.target === $('finder')) $('finder').close(); });
  $('finder-form').addEventListener('submit', event => { event.preventDefault(); runFinder($('finder-q').value.trim()); });
  $('finder-q').addEventListener('input', () => {
    clearTimeout(finderTimer);
    const query = $('finder-q').value.trim();
    // Each search is one embedding: wait for a pause in typing.
    if (!query) renderFinderHome();
    else if (query.length >= 2) finderTimer = setTimeout(() => runFinder(query), 450);
  });
  $('finder').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); $('finder').close(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); finderFocus(finderAt + (event.key === 'ArrowDown' ? 1 : -1)); }
    else if (event.key === 'Enter' && finderAt >= 0 && event.target === $('finder-q')) {
      event.preventDefault();
      finderItems()[finderAt]?.click();
    }
  });
  // Search from anywhere: Cmd/Ctrl+K even while typing elsewhere, and / when not typing.
  document.addEventListener('keydown', event => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'k') { event.preventDefault(); openFinder(); }
    else if (event.key === '/' && !mod && !isTyping(event.target) && !document.querySelector('dialog[open]')) { event.preventDefault(); openFinder(); }
  });

  // Under the hood: every moving part in plain words, with the artist's own canvas as the example.
  function openHood() {
    const strokes = allStrokes().filter(stroke => !stroke.erase);
    const counts = madeBy([layers]);
    const total = counts.hand + counts.placed + counts.ai + counts.kit;
    const yours = total ? Math.round((counts.hand + counts.placed - counts.placedAi) / total * 100) : 100;
    const stats = [['Strokes', strokes.length], ['Points', pointCount.toLocaleString()], ['Layers', layers.length], ['Your hand', `${yours}%`]];
    $('hood-stats').replaceChildren(...stats.map(([label, value]) => {
      const row = el('div');
      row.append(el('dt', '', label), el('dd', '', String(value)));
      return row;
    }));
    const last = strokes[strokes.length - 1];
    const r = v => Math.round(v * 1000) / 1000;
    $('hood-json').textContent = last
      ? JSON.stringify({ color: last.color, width: last.width, ...(last.ai ? { ai: true } : {}),
        points: [...last.points.slice(0, 3).map(p => ({ x: r(p.x), y: r(p.y), pressure: r(p.pressure ?? 0.5) })), `\u2026 ${Math.max(0, last.points.length - 3)} more`] }, null, 1)
        .replace(/\n\s*/g, ' ')
      : 'Draw a line, then open this again: your stroke shows up here as data.';
    $('hood').showModal();
  }
  $('hood-close').addEventListener('click', () => $('hood').close());
  // The hero's three rules open the hood at the rule you tapped.
  document.querySelectorAll('.hero-rules [data-rule]').forEach(button => button.addEventListener('click', () => {
    openHood();
    const rule = $(`rule-${button.dataset.rule}`);
    document.querySelectorAll('.hood-rules li').forEach(item => item.classList.toggle('lit', item === rule));
    rule.scrollIntoView({ block: 'nearest' });
  }));
  $('hood').addEventListener('click', event => { if (event.target === $('hood')) $('hood').close(); });
  $('help-hood').addEventListener('click', () => { $('help').close(); openHood(); });
  document.querySelector('.connection').addEventListener('click', openHood);
  document.querySelector('.fine-print').addEventListener('click', openHood);

  // ---------------------------------------------------------------- variations: one asset in, lookalikes out
  // The artist plans (editable briefs), AI edits the artist's own strokes per brief, the artist keeps and finishes.
  const VAR_CONCURRENCY = 3;
  let varAsset = null;
  let varPlan = [];
  let varResults = []; // { name, brief, status: pending | ready | error | saving | kept, result, saved, error, diff }
  let varToken = null; // changes when the sheet is reset, so stale requests are ignored
  function openVariations(item, goal = '') {
    varAsset = item;
    varPlan = [];
    varResults = [];
    varToken = {};
    $('var-title').textContent = item.name;
    $('var-thumb').src = item.image_url || `/api/assets/${encodeURIComponent(item.id)}/image`;
    $('var-plan-step').hidden = true;
    $('var-results-step').hidden = true;
    message('var-status', '');
    if (!$('variations').open) $('variations').showModal();
    $('var-goal').value = goal;
    if (goal) planVariations();
    else $('var-goal').focus();
  }
  async function planVariations() {
    const goal = $('var-goal').value.trim();
    if (goal.length < 3) { $('var-goal').focus(); return; }
    const token = varToken;
    $('var-plan').disabled = true;
    message('var-status', 'Planning... you can edit every line next.');
    try {
      const data = await postJSON(`/api/assets/${encodeURIComponent(varAsset.id)}/variations/plan`,
        JSON.stringify({ goal, count: Number($('var-count').value) }));
      if (token !== varToken) return;
      varPlan = data.items;
      renderPlan();
      $('var-plan-step').hidden = false;
      message('var-status', `${varPlan.length} ideas for "${goal}". Rewrite, remove, or add any, then draw them.`);
      $('var-plan-step').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      message('var-status', error.message, true);
    } finally {
      $('var-plan').disabled = false;
    }
  }
  function renderPlan() {
    $('var-plan-list').replaceChildren(...varPlan.map((item, i) => {
      const row = el('li', 'var-plan-row');
      row.style.setProperty('--i', i);
      const name = el('input', 'var-name');
      name.value = item.name;
      name.maxLength = 40;
      name.setAttribute('aria-label', `Name of variation ${i + 1}`);
      name.addEventListener('input', () => { item.name = name.value; });
      const brief = el('textarea', 'var-brief');
      brief.rows = 2;
      brief.value = item.brief;
      brief.maxLength = 200;
      brief.placeholder = 'What changes? e.g. holds a round shield';
      brief.setAttribute('aria-label', `What changes in variation ${i + 1}`);
      brief.addEventListener('input', () => { item.brief = brief.value; });
      const remove = actionButton('\u00d7', 'var-remove', 'Remove this one', () => { varPlan.splice(i, 1); renderPlan(); });
      remove.setAttribute('aria-label', `Remove variation ${i + 1}`);
      row.append(name, brief, remove);
      return row;
    }));
    $('var-plan-add').disabled = varPlan.length >= 9;
    $('var-draw').textContent = `\u2726 Draw ${varPlan.length} variation${varPlan.length === 1 ? '' : 's'}`;
    $('var-draw').disabled = !varPlan.length;
  }
  function drawVariations() {
    const plan = varPlan.map(item => ({ name: item.name.trim() || 'Variation', brief: item.brief.trim() })).filter(item => item.brief.length >= 3);
    if (!plan.length) {
      message('var-status', 'Give each variation a few words about what changes.', true);
      return;
    }
    varToken = {};
    const token = varToken;
    varResults = plan.map(item => ({ ...item, status: 'pending' }));
    $('var-results-step').hidden = false;
    renderVarResults();
    $('var-results-step').scrollIntoView({ behavior: 'smooth', block: 'start' });
    message('var-status', `Drawing ${plan.length}, ${VAR_CONCURRENCY} at a time. Each one edits ${varAsset.name}'s strokes.`);
    let next = 0;
    const worker = async () => {
      while (token === varToken && next < varResults.length) await drawOne(varResults[next++], token);
    };
    for (let i = 0; i < Math.min(VAR_CONCURRENCY, varResults.length); i++) worker();
  }
  async function drawOne(item, token = varToken) {
    item.status = 'pending';
    item.error = null;
    renderVarResults();
    try {
      const result = await postJSON(`/api/assets/${encodeURIComponent(varAsset.id)}/variations`, JSON.stringify({ brief: item.brief }));
      if (token !== varToken) return;
      Object.assign(item, { status: 'ready', result });
    } catch (error) {
      if (token !== varToken) return;
      Object.assign(item, { status: 'error', error: error.message });
    }
    renderVarResults();
  }
  // "Changes" view: the artist's kept strokes fade back, the AI's new strokes stay bright.
  function variationImage(strokes, diff) {
    const stack = diff
      ? [{ visible: true, opacity: 0.22, strokes: strokes.filter(s => !s.ai) }, { visible: true, opacity: 1, strokes: strokes.filter(s => s.ai) }]
      : [{ visible: true, opacity: 1, strokes }];
    return frameImage(stack, 360);
  }
  function renderVarResults() {
    const ready = varResults.filter(item => item.status === 'ready').length;
    const kept = varResults.filter(item => item.status === 'kept');
    $('var-keep-all').hidden = ready < 2;
    $('var-keep-all').textContent = `Keep all ${ready} ready`;
    $('var-scene').hidden = !kept.length;
    $('var-scene').textContent = `\u25a3 Build a scene with ${kept.length + 1}`;
    $('var-scene').dataset.tip = `Build a scene|Places ${varAsset?.name} and the ${kept.length} you kept as linked layers, in a two-row formation. Then you draw the rest.`;
    $('var-results').replaceChildren(...varResults.map((item, i) => {
      const card = el('article', `var-card ${item.status}`);
      card.style.setProperty('--i', i);
      const figure = el('div', 'var-figure');
      if (item.result) figure.append(variationImage(item.result.strokes, item.diff));
      else figure.append(el('span', 'var-wait', item.status === 'error' ? '\u26a0' : '\u2726 Drawing\u2026'));
      const text = el('div', 'card-text');
      text.append(el('strong', '', item.name), el('small', '', item.brief));
      if (item.result) {
        const stats = el('p', 'var-stats');
        stats.append(el('b', 'hand', `\u270d ${item.result.kept} of your ${item.result.source_strokes} strokes kept`), el('b', 'ai', `\u2726 ${item.result.added} added`));
        stats.dataset.tip = `What AI did|${item.result.note}. Your kept strokes are exactly yours, untouched. New strokes stay marked as AI, even after you edit around them.`;
        text.append(stats);
      }
      if (item.error) text.append(el('p', 'why outdated', item.error));
      const actions = el('div', 'wu-actions');
      if (item.status === 'ready') {
        actions.append(
          actionButton('Keep', 'primary-mini', 'Keep|Saves it as a new asset, linked to the original, with its brief in the history.', () => keepVariation(item)),
          actionButton('Finish by hand', '', 'Finish by hand|Opens it on the canvas. Fix anything, then save it as an asset (it stays linked to the original).', () => editVariation(item)),
          actionButton(item.diff ? 'Show all' : '\u2726 Changes', '', 'Changes|Fades your strokes so only what AI added stands out.', () => { item.diff = !item.diff; renderVarResults(); }),
          actionButton('\u21bb', '', 'Try again|Same brief, a new attempt.', () => drawOne(item)));
      } else if (item.status === 'error') {
        actions.append(actionButton('\u21bb Try again', '', null, () => drawOne(item)));
      } else if (item.status === 'kept') {
        actions.append(el('span', 'kept-note', '\u2714 Kept'),
          actionButton('\u25c6 Place', 'primary-mini', null, () => { $('variations').close(); startPlacing(item.saved); }));
      } else if (item.status === 'saving') {
        actions.append(el('span', 'kept-note', 'Saving\u2026'));
      }
      card.append(figure, text, actions);
      return card;
    }));
  }
  function variationOrigin(item) {
    const { result } = item;
    return { asset_id: result.source.asset_id, version: result.source.version, brief: item.brief, kept: result.kept, added: result.added };
  }
  async function keepVariation(item) {
    item.status = 'saving';
    renderVarResults();
    try {
      item.saved = await postJSON('/api/assets', JSON.stringify({
        name: item.name.slice(0, 80), type: varAsset.type || 'prop', description: item.brief, tags: varAsset.tags || [],
        layers: [{ name: item.name.slice(0, 40), strokes: item.result.strokes }], origin: variationOrigin(item), history: []
      }));
      item.status = 'kept';
      loadSceneBackdrops();
      message('var-status', `Kept "${item.saved.name}". It's in your library, linked to ${varAsset.name}.`);
      loadGallery(currentQuery);
    } catch (error) {
      item.status = 'ready';
      message('var-status', error.message, true);
    }
    renderVarResults();
  }
  async function keepAllVariations() {
    for (const item of varResults.filter(entry => entry.status === 'ready')) await keepVariation(item);
  }
  // Swap the whole canvas for a new single-frame drawing (used by variations; openRecord handles saved work).
  function loadCanvas(stack, { kind, title = '', note, more = [], fps: speed = null }) {
    stopPlay();
    frames = [stack, ...more];
    sceneMotion = null;
    sceneSketch = null;
    resyncSeq();
    if (speed) { fps = speed; $('fps').value = String(fps); }
    frameIndex = 0;
    layers = stack;
    activeId = layers[layers.length - 1].id;
    undoStack.length = 0;
    redoStack.length = 0;
    guides.length = 0;
    sparks.length = 0;
    journal = [];
    handStrokes = 0;
    savedHistory = [];
    pendingOrigin = null;
    editing = null;
    saveKind = kind;
    $('title').value = title;
    setTool(drawTool);
    closePopover();
    recount();
    rebuildOnion();
    rebuildAll();
    renderFrames();
    renderOverlay();
    renderTray();
    renderSaveKind();
    revision++; // unsaved until the artist saves it
    autoMeta = null;
    setView('studio');
    message('drawing-status', note);
  }
  function editVariation(item) {
    if (revision !== savedRevision && !confirm('Replace your current canvas? Unsaved changes will be lost.')) return;
    $('variations').close();
    loadCanvas([newLayer(item.name.slice(0, 40), { strokes: item.result.strokes.slice() })], {
      kind: 'asset', title: item.name,
      note: `"${item.name}" is on the canvas: ${item.result.kept} of your strokes, ${item.result.added} new \u2726. Finish it by hand, then Save asset. It stays linked to ${varAsset.name}.`
    });
    $('asset-type').value = varAsset.type || 'prop';
    $('description').value = item.brief;
    tags = [...(varAsset.tags || [])];
    renderTagChips();
    pendingOrigin = variationOrigin(item);
  }
  // Two staggered rows, smaller at the back: a crowd or a battle line, ready to be drawn into.
  function formation(n) {
    const rows = n <= 4 ? [n] : [Math.ceil(n / 2), Math.floor(n / 2)];
    const specs = rows.length === 1 ? [{ x: 0.05, y: 0.3, w: 0.9, h: 0.6 }] : [{ x: 0.12, y: 0.08, w: 0.76, h: 0.42 }, { x: 0.03, y: 0.42, w: 0.94, h: 0.56 }];
    return rows.flatMap((count, r) => Array.from({ length: count }, (_, i) => {
      const spec = specs[r];
      const cell = spec.w / count;
      return { x: (spec.x + cell * i + cell * 0.06) * W, y: spec.y * H, w: cell * 0.88 * W, h: spec.h * H };
    }));
  }
  async function sceneFromVariations() {
    const kept = varResults.filter(item => item.status === 'kept');
    if (!kept.length) return;
    if (revision !== savedRevision && !confirm('Replace your current canvas? Unsaved changes will be lost.')) return;
    try {
      const original = await api(`/api/assets/${encodeURIComponent(varAsset.id)}`);
      const cast = [
        { id: original.id, version: original.version, name: original.name, strokes: original.layers.filter(l => l.visible).flatMap(l => l.strokes) },
        ...kept.map(item => ({ id: item.saved.id, version: item.saved.version, name: item.saved.name, strokes: item.result.strokes }))
      ].slice(0, MAX_LAYERS - 1);
      const boxes = formation(cast.length);
      const placed = cast.map((member, i) => newLayer(member.name.slice(0, 40), {
        strokes: placedStrokes({ strokes: member.strokes, bbox: inkBounds(member.strokes) }, boxes[i]).map(stroke => ({ ...stroke, seq: i + 1, ms: undefined })),
        asset: { asset_id: member.id, version: member.version }
      }));
      $('variations').close();
      loadCanvas([...placed, newLayer('Draw here')], {
        kind: 'shot', note: `${cast.length} linked assets placed. Draw the scene around them, then save it as a Scene. Every one of them now knows where it's used.`
      });
      cast.forEach((member, i) => logEvent('artist', 'Placed', `${member.name} v${member.version}${i ? ` (a variation of ${varAsset.name})` : ' (the original)'}`));
    } catch (error) {
      message('var-status', error.message, true);
    }
  }
  $('var-goal-form').addEventListener('submit', event => { event.preventDefault(); planVariations(); });
  document.querySelectorAll('#var-examples .example').forEach(button => button.addEventListener('click', () => {
    $('var-goal').value = button.textContent;
    planVariations();
  }));
  $('var-plan-add').addEventListener('click', () => {
    if (varPlan.length >= 9) return;
    varPlan.push({ name: `Variation ${varPlan.length + 1}`, brief: '' });
    renderPlan();
    $('var-plan-list').lastElementChild?.querySelector('.var-brief')?.focus();
  });
  $('var-draw').addEventListener('click', drawVariations);
  $('var-keep-all').addEventListener('click', keepAllVariations);
  $('var-scene').addEventListener('click', sceneFromVariations);
  $('var-close').addEventListener('click', () => $('variations').close());

  // ---------------------------------------------------------------- share: a public link to a scene
  async function openShare() {
    if (!editing || editing.kind !== 'shot' || revision !== savedRevision) {
      // Sharing snapshots the saved scene, so save first (one tap), then share.
      if (saveKind !== 'shot') setSaveKind('shot');
      shareAfterSave = true;
      $('save-form').requestSubmit();
      return;
    }
    const id = editing.id;
    $('share-ready').hidden = true;
    $('share-gif').hidden = true;
    $('share-status').textContent = `Rendering ${frames.length} frames into a GIF\u2026`;
    $('share-status').classList.remove('error');
    if (!$('share-sheet').open) $('share-sheet').showModal();
    try {
      const shared = await postJSON(`/api/shots/${encodeURIComponent(id)}/share`, '{}');
      $('share-url').value = shared.url;
      $('share-gif').src = `${shared.gif_url}?t=${Date.now()}`;
      $('share-gif').hidden = false;
      $('share-download').href = shared.gif_url;
      $('share-download').download = `${editing.code}.gif`;
      $('share-visit').href = shared.url;
      $('share-native').hidden = !navigator.share;
      $('share-ready').hidden = false;
      $('share-status').textContent = `Live: ${shared.frames} frames, ${(shared.bytes / 1024).toFixed(0)} KB.`;
      logEvent('artist', 'Shared', `a public link (${shared.frames} frames)`);
    } catch (error) {
      $('share-status').textContent = error.message;
      $('share-status').classList.add('error');
    }
  }
  $('share-open').addEventListener('click', openShare);
  $('share-close').addEventListener('click', () => $('share-sheet').close());
  $('share-sheet').addEventListener('click', event => { if (event.target === $('share-sheet')) $('share-sheet').close(); });
  $('share-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('share-url').value);
      $('share-copy').textContent = 'Copied!';
    } catch {
      $('share-url').select();
      $('share-copy').textContent = 'Press \u2318C';
    }
    setTimeout(() => { $('share-copy').textContent = 'Copy'; }, 1600);
  });
  $('share-native').addEventListener('click', () => {
    navigator.share?.({ title: `${editing?.code || 'My scene'} \u00b7 made in Inkling`, text: 'I drew this, then animated it. See how it moves:', url: $('share-url').value }).catch(() => {});
  });
  $('share-stop').addEventListener('click', async () => {
    if (!editing || editing.kind !== 'shot') return;
    try {
      await api(`/api/shots/${encodeURIComponent(editing.id)}/share`, { method: 'DELETE' });
      $('share-ready').hidden = true;
      $('share-gif').hidden = true;
      $('share-status').textContent = 'Stopped. The link no longer works.';
    } catch (error) {
      $('share-status').textContent = error.message;
    }
  });

  // ---------------------------------------------------------------- breakdown: frame by frame, layer by layer, asset by asset
  let bd = null; // { stacks, fps, motion, at, timer }
  const BY = { artist: ['\u270d', 'You'], ai: ['\u2726', 'AI'], studio: ['\u2699', 'Studio'] };
  function ago(iso) {
    const seconds = (Date.now() - Date.parse(iso)) / 1000;
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function madeBy(stacks) {
    const counts = { hand: 0, ai: 0, kit: 0, code: 0, placed: 0, placedAi: 0 };
    const seen = new Set();
    for (const layer of stacks.flat()) {
      // Hidden guides and backups don't count; nor do posed copies of frame 1 (moved, not drawn).
      if (!layer.visible || layer.xf) continue;
      // Weather (snow, rain...) is code, like the paper: it isn't authorship either way.
      if (FX_NAMES.has(layer.name) && layer.strokes.length && layer.strokes.every(stroke => stroke.kit || stroke.code)) continue;
      for (const stroke of layer.strokes) {
        if (stroke.erase || seen.has(stroke)) continue;
        seen.add(stroke);
        counts[layer.asset ? 'placed' : stroke.ai ? 'ai' : stroke.code ? 'code' : stroke.kit ? 'kit' : 'hand']++;
        if (layer.asset && stroke.ai) counts.placedAi++; // e.g. strokes an AI variation added to that asset
      }
    }
    return counts;
  }
  function bdShow(at) {
    if (!bd) return;
    stopReplay();
    bd.at = at;
    const c = $('bd-canvas').getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, W, H);
    paintStack(c, bd.stacks[at]);
    $('bd-scrub').value = String(at + 1);
    $('bd-frame').value = `${at + 1} / ${bd.stacks.length}`;
    // Long shots show a sample of columns; light up the one this frame falls in.
    const cols = [...document.querySelectorAll('#bd-xsheet thead [data-col]')].map(cell => Number(cell.dataset.col));
    const now = cols.filter(col => col <= at).pop();
    document.querySelectorAll('#bd-xsheet [data-col]').forEach(cell => cell.classList.toggle('now', Number(cell.dataset.col) === now));
  }
  function bdStop() {
    stopReplay();
    if (!bd?.timer) return;
    clearInterval(bd.timer);
    bd.timer = null;
    $('bd-play').textContent = '\u25b6';
  }
  // ---- art math and process replay
  const strokeLength = stroke => stroke.points.reduce((sum, p, i) => i ? sum + Math.hypot((p.x - stroke.points[i - 1].x) * W, (p.y - stroke.points[i - 1].y) * H) : 0, 0);
  function artMath(stacks) {
    const seen = new Set();
    const weight = new Map();
    let strokes = 0, erasers = 0, ink = 0, ms = 0;
    for (const layer of stacks.flat()) {
      for (const stroke of layer.strokes) {
        // A stroke copied into later frames is one stroke, drawn once.
        const key = stroke.seq != null ? `${stroke.seq}:${stroke.points.length}:${stroke.color}:${stroke.points[0]?.x}` : stroke;
        if (seen.has(key)) continue;
        seen.add(key);
        ms += stroke.ms || 0;
        if (stroke.erase) { erasers++; continue; }
        if (!layer.visible) continue;
        strokes++;
        const length = strokeLength(stroke);
        ink += length;
        weight.set(stroke.color, (weight.get(stroke.color) || 0) + length * stroke.width + stroke.width ** 2);
        if (stroke.fill) weight.set(stroke.fill, (weight.get(stroke.fill) || 0) + 2000);
      }
    }
    const palette = [...weight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([color]) => color);
    return { strokes, erasers, ink: Math.round(ink), ms, palette };
  }
  const shortNumber = n => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const duration = ms => (ms < 1000 ? (ms ? '<1s' : '\u2014') : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round(ms % 60000 / 1000)}s`);
  function renderArtMath(stacks) {
    const math = artMath(stacks);
    const tile = (value, label, tip) => {
      const box = el('div', 'math-tile');
      box.dataset.tip = tip;
      box.append(el('b', '', value), el('span', '', label));
      return box;
    };
    const swatches = el('div', 'math-palette');
    swatches.dataset.tip = 'Palette|The colors that carry the most ink, in order.';
    for (const color of math.palette) {
      const swatch = el('span', 'swatch-dot');
      swatch.style.background = color;
      swatch.title = color;
      swatches.append(swatch);
    }
    $('bd-math').replaceChildren(
      tile(String(math.strokes), 'strokes', 'Strokes|Lines and shapes you can see (erasers and hidden layers excluded).'),
      tile(`${shortNumber(math.ink)} px`, 'of line', 'Ink|Total length of every visible line, in canvas pixels.'),
      tile(duration(math.ms), 'pencil down', 'Time drawing|How long the pencil was actually on the paper, summed over strokes.'),
      tile(String(math.erasers), math.erasers === 1 ? 'eraser pass' : 'eraser passes', 'Erasing|Every correction counts. This is how drawings get good.'),
      swatches);
  }
  function stopReplay() {
    if (!bd) return;
    if (bd.replay) cancelAnimationFrame(bd.replay);
    bd.replay = null;
    if (bd.recorder) { bd.recorder.cancelled = true; bd.recorder.stop(); bd.recorder = null; }
    $('bd-replay').textContent = '\u270e Watch it being made';
    $('bd-export').disabled = false;
  }
  // One stack, stroke by stroke in drawing order (seq), each stroke onto its own layer sheet.
  function processPlayer(stack) {
    const items = [];
    let order = 0;
    stack.forEach((layer, index) => {
      if (!layer.visible) return;
      for (const stroke of layer.strokes) items.push({ stroke, index, key: stroke.seq ?? 1e9 + order, order: order++ });
    });
    items.sort((a, b) => a.key - b.key || a.order - b.order);
    const sheets = stack.map(() => {
      const sheet = document.createElement('canvas');
      sheet.width = W;
      sheet.height = H;
      return sheet;
    });
    let drawn = 0;
    let ai = 0;
    return {
      total: items.length,
      length: Math.min(9000, Math.max(2500, items.length * 70)),
      get drawn() { return drawn; },
      advance(target) {
        while (drawn < Math.min(target, items.length)) {
          const { stroke, index } = items[drawn++];
          if (stroke.ai) ai++;
          drawStroke(sheets[index].getContext('2d'), stroke);
        }
      },
      paint(ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        stack.forEach((layer, index) => {
          if (!layer.visible) return;
          ctx.globalAlpha = layer.opacity;
          ctx.drawImage(sheets[index], 0, 0);
        });
        ctx.globalAlpha = 1;
      },
      caption() {
        if (!drawn) return '';
        const { stroke, index } = items[drawn - 1];
        const who = stroke.ai ? '\u2726 AI, accepted' : stroke.kit ? '\u2728 starter kit' : stack[index].asset ? '\u25c6 placed asset' : '\u270d your hand';
        return drawn < items.length ? `Stroke ${drawn} of ${items.length} \u00b7 ${who}`
          : `${items.length} strokes, in the order they were made${ai ? ` (${ai} by AI, all accepted by you)` : ''}.`;
      },
    };
  }
  function replayProcess() {
    if (!bd) return;
    if (bd.replay || bd.recorder) { stopReplay(); bdShow(bd.at); return; }
    if (bd.timer) { clearInterval(bd.timer); bd.timer = null; $('bd-play').textContent = '\u25b6'; }
    const player = processPlayer(bd.stacks[bd.at]);
    if (!player.total) return;
    const out = $('bd-canvas').getContext('2d');
    const start = performance.now();
    $('bd-replay').textContent = '\u25a0 Stop';
    const tick = now => {
      player.advance(REVEAL_MS ? Math.ceil(player.total * (now - start) / player.length) : player.total);
      player.paint(out);
      $('bd-caption').textContent = player.caption();
      if (player.drawn < player.total) bd.replay = requestAnimationFrame(tick);
      else { bd.replay = null; $('bd-replay').textContent = '\u21bb Watch again'; }
    };
    bd.replay = requestAnimationFrame(tick);
  }
  // "Watch me draw it" as a video file: title card, the replay with captions burned in, an end card with the art math.
  const VIDEO_TYPE = (() => {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return '';
    return ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
      .find(type => MediaRecorder.isTypeSupported(type)) || '';
  })();
  function exportReplay() {
    if (!bd || !VIDEO_TYPE) return;
    stopReplay();
    if (bd.timer) { clearInterval(bd.timer); bd.timer = null; $('bd-play').textContent = '\u25b6'; }
    const stack = bd.stacks[bd.at];
    const player = processPlayer(stack);
    if (!player.total) return;
    const title = $('bd-title').textContent.trim() || 'Untitled';
    const counts = madeBy([stack]);
    const ink = counts.hand + counts.ai + counts.kit + counts.placed;
    const hand = ink ? Math.round(counts.hand / ink * 100) : 100;
    const math = artMath([stack]);
    const film = document.createElement('canvas');
    film.width = W;
    film.height = H;
    const ctx = film.getContext('2d');
    const recorder = new MediaRecorder(film.captureStream(30), { mimeType: VIDEO_TYPE, videoBitsPerSecond: 5e6 });
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      $('bd-export').disabled = false;
      $('bd-replay').textContent = '\u270e Watch it being made';
      if (recorder.cancelled || !chunks.length) { $('bd-caption').textContent = recorder.cancelled ? 'Recording stopped.' : 'Recording failed. Please try again.'; return; }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob(chunks, { type: VIDEO_TYPE.split(';')[0] }));
      link.download = `${title.replace(/[^\w-]+/g, '-').toLowerCase()}-process.${VIDEO_TYPE.includes('mp4') ? 'mp4' : 'webm'}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      $('bd-caption').textContent = `Saved ${link.download}: ${player.total} strokes, ${hand}% your hand.`;
    };
    const band = (text, sub) => {
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.fillRect(0, H - 64, W, 64);
      ctx.fillStyle = '#123b38';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = '600 24px system-ui, sans-serif';
      ctx.fillText(text, 28, H - 32);
      ctx.textAlign = 'right';
      ctx.font = '18px system-ui, sans-serif';
      ctx.fillStyle = '#5d706b';
      ctx.fillText(sub, W - 28, H - 32);
    };
    const TITLE_MS = 1400;
    const HOLD_MS = 2600;
    const start = performance.now();
    const out = $('bd-canvas').getContext('2d');
    bd.recorder = recorder;
    recorder.start(250);
    $('bd-export').disabled = true;
    $('bd-replay').textContent = '\u25a0 Stop';
    const tick = now => {
      const t = now - start;
      if (t < TITLE_MS) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#123b38';
        ctx.font = '700 64px Georgia, serif';
        ctx.fillText(title, W / 2, H / 2 - 24);
        ctx.fillStyle = '#5d706b';
        ctx.font = '24px system-ui, sans-serif';
        ctx.fillText('watch it being made, stroke by stroke', W / 2, H / 2 + 36);
        $('bd-caption').textContent = '\u25cf Recording\u2026';
      } else if (t < TITLE_MS + player.length) {
        player.advance(Math.ceil(player.total * (t - TITLE_MS) / player.length));
        player.paint(ctx);
        band(player.caption(), title);
      } else {
        player.advance(player.total);
        player.paint(ctx);
        band(`${plural(player.total, 'stroke')} \u00b7 ${hand}% your hand \u00b7 ${duration(math.ms)} pencil down`, 'made with \u2726 Inkling');
      }
      out.drawImage(film, 0, 0);
      if (t < TITLE_MS + player.length + HOLD_MS) bd.replay = requestAnimationFrame(tick);
      else { bd.replay = null; bd.recorder = null; recorder.stop(); }
    };
    bd.replay = requestAnimationFrame(tick);
  }
  // The shot's direction as a chain of beats: what an animator would pin above the desk.
  function renderBeats(motion, stacks) {
    const ok = !!motion && stacks.length > 1;
    $('bd-motion-group').hidden = !ok;
    if (!ok) return;
    const keys = motion.tracks.length;
    $('bd-motion-line').textContent = `${motion.by === 'ai' ? `\u2726 Directed with AI: "${motion.prompt}"` : `Quick move: ${motion.note}`} \u00b7 `
      + `${motion.tracks.reduce((n, t) => n + t.keys.length, 0)} keyframes, ${stacks.length} frames at ${motion.fps} fps${keys > 1 ? ` \u00b7 ${keys} actors` : ''}.`;
    const fpsUsed = motion.fps || MOTION_FPS;
    $('bd-motion').replaceChildren(...motion.tracks.flatMap(track => track.keys.map(key => {
      const frame = Math.round(key.t * (stacks.length - 1));
      const item = el('li', 'beat');
      const button = el('button', '', '');
      button.type = 'button';
      button.append(el('b', '', key.label || 'key'), el('small', '', `${keys > 1 ? `${track.name} \u00b7 ` : ''}${(frame / fpsUsed).toFixed(1)} s`));
      button.addEventListener('click', () => { bdStop(); bdShow(frame); });
      item.append(button);
      return item;
    })));
  }
  $('bd-motion-explain').addEventListener('click', () => { if (bd?.motion) openExplain({ motion: bd.motion, stacks: bd.stacks }); });
  function renderEvolution(versions) {
    $('bd-evolution-group').hidden = !versions?.length;
    if (!versions?.length) return;
    $('bd-evolution').replaceChildren(...versions.map((version, i) => {
      const card = el('button', 'evo-card');
      card.type = 'button';
      card.style.setProperty('--i', i);
      const image = el('img');
      image.src = version.image_url;
      image.alt = `Version ${version.version}`;
      image.loading = 'lazy';
      const stats = version.stats || {};
      const previous = versions[i - 1]?.stats;
      const delta = previous ? stats.strokes - previous.strokes : null;
      card.append(image, el('b', '', `v${version.version}`),
        el('small', '', `${plural(stats.strokes || 0, 'stroke')}${delta ? ` (${delta > 0 ? '+' : ''}${delta})` : ''} \u00b7 ${Math.round((stats.hand_share ?? 1) * 100)}% hand`));
      card.addEventListener('click', () => {
        stopReplay();
        const picture = new Image();
        picture.onload = () => $('bd-canvas').getContext('2d').drawImage(picture, 0, 0, W, H);
        picture.src = version.image_url;
        $('bd-caption').textContent = `v${version.version}, saved ${ago(version.saved_at)}. Press \u25b6 or scrub to return.`;
      });
      return card;
    }));
  }
  $('bd-replay').addEventListener('click', replayProcess);
  $('bd-export').hidden = !VIDEO_TYPE;
  $('bd-export').addEventListener('click', exportReplay);
  function openBreakdown(doc) {
    // doc: { title, sub, stacks, fps, history, pending, origin, assetNames }
    bdStop();
    const stacks = doc.stacks;
    bd = { stacks, fps: doc.fps || 12, motion: doc.motion || null, at: 0, timer: null };
    $('bd-title').textContent = doc.title;
    const layerTotal = Math.max(...stacks.map(stack => stack.length));
    $('bd-sub').textContent = [doc.sub, `${stacks.length} frame${stacks.length === 1 ? '' : 's'}${stacks.length > 1 ? ` at ${bd.fps} fps` : ''}`,
      `${layerTotal} layer${layerTotal === 1 ? '' : 's'}`].filter(Boolean).join(' \u00b7 ');
    $('bd-scrub').max = String(stacks.length);
    $('bd-play').disabled = stacks.length < 2;
    document.querySelector('.bd-player-bar').hidden = stacks.length < 2; // a single drawing has nothing to scrub

    const counts = madeBy(stacks);
    const total = counts.hand + counts.ai + counts.placed + counts.kit || 1;
    const parts = [['hand', 'Your hand', counts.hand], ['ai', 'AI, accepted by you', counts.ai],
      ['placed', 'Placed assets (reused)', counts.placed], ...(counts.kit ? [['kit', 'Starter kit', counts.kit]] : [])];
    $('bd-bar').replaceChildren(...parts.filter(([, , n]) => n).map(([key, , n]) => {
      const segment = el('span', `made-${key}`);
      segment.style.setProperty('--share', `${(n / total) * 100}%`);
      return segment;
    }));
    $('bd-bar').setAttribute('aria-label', parts.map(([, label, n]) => `${label}: ${Math.round((n / total) * 100)}%`).join(', '));
    $('bd-legend').replaceChildren(...parts.filter(([key, , n]) => n || key === 'hand').map(([key, label, n]) => {
      const item = el('li', `made-${key}`);
      const note = key === 'placed' && counts.placedAi ? `, ${counts.placedAi} of them AI-added in variations` : '';
      item.append(el('b', '', `${Math.round((n / total) * 100)}%`), el('span', '', `${label} \u00b7 ${n} stroke${n === 1 ? '' : 's'}${note}`));
      return item;
    }));
    renderArtMath(stacks);
    renderEvolution(doc.versions);
    renderBeats(doc.motion, stacks);
    $('bd-caption').textContent = '';
    $('bd-replay').textContent = '\u270e Watch it being made';
    $('bd-origin').hidden = !doc.origin;
    if (doc.origin) {
      const o = doc.origin;
      $('bd-origin').replaceChildren(el('span', '', `\u2726 A variation of ${o.name || 'another asset'} v${o.version}: "${(o.brief || '').replace(/[.!\s]+$/, '')}." AI kept ${o.kept} of the artist's strokes and added ${o.added}.`));
      $('bd-origin').append(actionButton('See the original', '', null, () => { $('breakdown').close(); openWhereUsed({ id: o.asset_id, name: o.name || 'Original' }); }));
    }

    // Exposure sheet: rows are layers (top of the stack first), columns are frames.
    const names = [];
    for (const stack of stacks) for (const layer of [...stack].reverse()) if (!names.includes(layer.name)) names.push(layer.name);
    // A 10-second shot has 80 frames: the sheet shows about 20 of them (every keyframe it can), the player shows all.
    const every = Math.ceil(stacks.length / 20);
    const keyCols = new Set((bd.motion?.tracks || []).flatMap(track => track.keys.map(k => Math.round(k.t * (stacks.length - 1)))));
    const cols = stacks.map((_, i) => i).filter(i => i % every === 0 || i === stacks.length - 1);
    const head = el('tr');
    head.append(el('th', 'corner', 'Layer'), ...cols.map(i => {
      const th = el('th', keyCols.has(i) ? 'key' : '', `${keyCols.has(i) ? '\u25c6' : ''}${i + 1}`);
      th.dataset.col = String(i);
      th.scope = 'col';
      return th;
    }));
    const rows = names.map(name => {
      const tr = el('tr');
      const instances = stacks.map(stack => stack.find(layer => layer.name === name));
      const shown = cols.map(i => [instances[i], i]);
      const first = instances.find(Boolean);
      const th = el('th', 'row-head');
      th.scope = 'row';
      th.append(el('b', '', name));
      const badges = el('span', 'badges');
      if (first.asset) badges.append(el('span', 'badge asset', `\u25c6 v${first.asset.version}`));
      const aiStrokes = instances.filter(Boolean).reduce((n, layer) => n + layer.strokes.filter(s => s.ai && !s.erase).length, 0);
      if (aiStrokes && !first.asset) badges.append(el('span', 'badge ai', `\u2726 ${aiStrokes}`));
      if (!first.visible) badges.append(el('span', 'badge hidden', 'hidden'));
      th.append(badges);
      tr.append(th, ...shown.map(([layer, i]) => {
        const td = el('td');
        td.dataset.col = String(i);
        if (!layer) {
          td.append(el('span', 'none', '\u2014'));
        } else {
          td.append(frameImage([{ ...layer, visible: true, opacity: layer.visible ? layer.opacity : 0.35 }], 84));
          td.title = `${name}, frame ${i + 1}${layer.visible ? '' : ' (hidden)'}`;
        }
        td.addEventListener('click', () => { bdStop(); bdShow(i); });
        return td;
      }));
      return tr;
    });
    $('bd-xsheet').replaceChildren(el('thead'), el('tbody'));
    $('bd-xsheet').tHead.append(head);
    $('bd-xsheet').tBodies[0].append(...rows);

    // Asset by asset: where each placed asset appears across the frames.
    const assets = new Map();
    stacks.forEach((stack, i) => stack.forEach(layer => {
      if (!layer.asset) return;
      const entry = assets.get(layer.asset.asset_id) || { id: layer.asset.asset_id, name: doc.assetNames?.[layer.asset.asset_id] || layer.name, versions: new Set(), frames: new Set() };
      entry.versions.add(layer.asset.version);
      entry.frames.add(i + 1);
      assets.set(layer.asset.asset_id, entry);
    }));
    $('bd-assets-group').hidden = !assets.size;
    $('bd-assets').replaceChildren(...[...assets.values()].map(entry => {
      const row = el('div', 'bd-asset');
      const frameList = [...entry.frames];
      const span = frameList.length === stacks.length ? (stacks.length > 1 ? 'every frame' : 'this frame') : `frame${frameList.length === 1 ? '' : 's'} ${frameList.join(', ')}`;
      const text = el('div', 'card-text');
      text.append(el('strong', '', `\u25c6 ${entry.name}`), el('small', '', `v${[...entry.versions].join(', v')} \u00b7 ${span}`));
      row.append(text, actionButton('Where used?', 'where-mini', null, () => { $('breakdown').close(); openWhereUsed({ id: entry.id, name: entry.name }); }));
      return row;
    }));

    const events = [...(doc.pending || []).map(e => ({ ...e, pending: true })).reverse(), ...[...(doc.history || [])].reverse()];
    $('bd-history').replaceChildren(...(events.length ? events.map((e, i) => {
      const item = el('li', `event by-${e.by}${e.pending ? ' pending' : ''}`);
      item.style.setProperty('--i', Math.min(i, 12));
      const [icon, who] = BY[e.by] || ['\u2022', e.by];
      item.append(el('span', 'event-icon', icon));
      const body = el('div', 'event-body');
      const line = el('p', '');
      line.append(el('b', '', `${who}: ${e.action}`), document.createTextNode(e.detail ? ` \u2014 ${e.detail}` : ''));
      body.append(line, el('small', '', e.pending ? 'not saved yet' : ago(e.at)));
      item.append(body);
      return item;
    }) : [el('li', 'wu-empty', 'No history yet. It starts with the next save.')]));

    if (!$('breakdown').open) $('breakdown').showModal();
    bdShow(0);
  }
  function breakdownOfCanvas() {
    const placedNames = {};
    for (const layer of frames.flat()) if (layer.asset) placedNames[layer.asset.asset_id] = layer.name;
    openBreakdown({
      title: $('title').value.trim() || 'This canvas', sub: editing ? KIND_TEXT[editing.kind].save.replace('Save ', '') : 'unsaved',
      stacks: frames, fps, motion: frames.length > 1 ? sceneMotion : null, history: savedHistory, pending: pendingEvents(), origin: pendingOrigin ? { ...pendingOrigin, name: varAsset?.name } : null,
      assetNames: placedNames
    });
  }
  async function breakdownOfAsset(id) {
    try {
      const [record, versions] = await Promise.all([api(`/api/assets/${encodeURIComponent(id)}`),
        api(`/api/assets/${encodeURIComponent(id)}/versions`).catch(() => ({ items: [] }))]);
      openBreakdown({ title: record.name, sub: `${typeLabel(record.type)} v${record.version}`, stacks: [record.layers], history: record.history,
        origin: record.origin, versions: versions.items });
    } catch (error) {
      message('wu-status-line', error.message, true);
    }
  }
  $('breakdown-open').addEventListener('click', breakdownOfCanvas);
  $('bd-close').addEventListener('click', () => $('breakdown').close());
  $('breakdown').addEventListener('close', bdStop);
  $('bd-scrub').addEventListener('input', () => { bdStop(); bdShow(Number($('bd-scrub').value) - 1); });
  $('bd-play').addEventListener('click', () => {
    if (!bd || bd.stacks.length < 2) return;
    if (bd.timer) { bdStop(); return; }
    $('bd-play').textContent = '\u23f8';
    bd.timer = setInterval(() => bdShow((bd.at + 1) % bd.stacks.length), 1000 / bd.fps);
  });
  for (const id of ['variations', 'breakdown']) {
    $(id).addEventListener('click', event => { if (event.target === $(id)) $(id).close(); });
  }

  // ---------------------------------------------------------------- starters: never face a blank page
  // Every starter is plain, editable vector layers plus an empty "Draw here" on top. No AI, no wait, no cost.
  const unit = v => Math.max(0, Math.min(1, v));
  const ink = (points, color, width = 3, fill = null) => ({
    color, width, fill, erase: false, points: points.map(([x, y]) => ({ x: unit(x), y: unit(y), pressure: 0.75 }))
  });
  const box = (x0, y0, x1, y1, color, fill = null, width = 2) => ink([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], color, width, fill);
  const oval = (cx, cy, rx, ry, color, fill = null, width = 3, n = 48) =>
    ink(Array.from({ length: n + 1 }, (_, i) => [cx + rx / W * Math.cos(i / n * 2 * Math.PI), cy + ry / H * Math.sin(i / n * 2 * Math.PI)]), color, width, fill);
  const ring = (cx, cy, r, color, fill = null, width = 3) => oval(cx, cy, r, r, color, fill, width);
  const dot = (x, y, color, width = 4) => ink([[x, y]], color, width);
  // A rolling horizon from x=0 to 1, closed down to the bottom edge so it can be filled.
  const land = (y, amp, waves, color, fill, width = 3, phase = 0) =>
    ink([...Array.from({ length: 41 }, (_, i) => [i / 40, y + amp * Math.sin(i / 40 * waves * 2 * Math.PI + phase)]), [1, 1], [0, 1], [0, y + amp * Math.sin(phase)]], color, width, fill);
  const pine = (x, base, h, color = '#166534', fill = '#22c55e') => [
    ink([[x, base], [x, base - h * 0.25]], '#78350f', Math.max(4, h * 22)),
    ink([[x, base - h], [x - h * 0.28, base - h * 0.25], [x + h * 0.28, base - h * 0.25], [x, base - h]], color, 3, fill)
  ];
  const sky = (top, bottom) => box(0, 0, 1, 1, bottom, top, 1);
  const L = (name, strokes, props = {}) => ({ name, strokes, ...props });
  const starterStars = (n, seed = 7) => Array.from({ length: n }, (_, i) => {
    const r = Math.sin((i + 1) * 12.9898 * seed) * 43758.5453;
    const r2 = Math.sin((i + 1) * 78.233 * seed) * 12345.678;
    return dot(r - Math.floor(r), (r2 - Math.floor(r2)) * 0.6, '#fef9c3', 2 + (i % 3));
  });
  const STARTERS = [
    { id: 'blank', name: 'Blank', icon: '\u2b1c', kind: null, hint: 'A clean sheet.', build: () => [[L('Layer 1', [])]] },
    { id: 'beach', name: 'Beach', icon: '\ud83c\udfd6\ufe0f', kind: 'shot', hint: 'Sky, sun, sea, sand, and a palm.',
      build: () => [[
        L('Sky', [sky('#e0f2fe', '#bae6fd'), ring(0.8, 0.2, 46, '#f59e0b', '#fde68a', 4)]),
        L('Sea', [land(0.55, 0.008, 3, '#0284c7', '#7dd3fc'), ink([[0.05, 0.62], [0.2, 0.6], [0.35, 0.62]], '#e0f2fe', 3), ink([[0.55, 0.66], [0.7, 0.64], [0.85, 0.66]], '#e0f2fe', 3)]),
        L('Sand', [land(0.76, 0.02, 1.2, '#d97706', '#fde68a', 3, 1)]),
        L('Palm', [ink([[0.16, 0.92], [0.18, 0.78], [0.21, 0.62], [0.24, 0.5]], '#78350f', 11),
          ...[-0.13, -0.08, 0.08, 0.13].map(dx => ink([[0.24, 0.5], [0.24 + dx * 0.45, 0.455], [0.24 + dx * 0.85, 0.48], [0.24 + dx, 0.545]], '#15803d', 8)),
          ink([[0.24, 0.5], [0.235, 0.43], [0.22, 0.4]], '#15803d', 7), ring(0.235, 0.515, 7, '#78350f', '#a16207', 2), ring(0.25, 0.52, 7, '#78350f', '#a16207', 2)]),
        L('Draw here', [])
      ]] },
    { id: 'mountains', name: 'Mountains', icon: '\ud83c\udfd4\ufe0f', kind: 'shot', hint: 'Peaks with snow, hills, a sky.',
      build: () => [[
        L('Sky', [sky('#eef2ff', '#c7d2fe')]),
        L('Mountains', [ink([[0, 0.72], [0.18, 0.36], [0.34, 0.6], [0.55, 0.2], [0.76, 0.58], [0.9, 0.4], [1, 0.52], [1, 0.8], [0, 0.8], [0, 0.72]], '#475569', 3, '#cbd5e1'),
          ink([[0.5, 0.29], [0.55, 0.2], [0.6, 0.29], [0.575, 0.27], [0.55, 0.31], [0.525, 0.27], [0.5, 0.29]], '#94a3b8', 2, '#ffffff'),
          ink([[0.15, 0.42], [0.18, 0.36], [0.21, 0.42], [0.18, 0.44], [0.15, 0.42]], '#94a3b8', 2, '#ffffff')]),
        L('Hills', [land(0.74, 0.03, 1.5, '#15803d', '#86efac'), ...pine(0.82, 0.86, 0.16), ...pine(0.9, 0.9, 0.12)]),
        L('Draw here', [])
      ]] },
    { id: 'forest', name: 'Forest', icon: '\ud83c\udf32', kind: 'shot', hint: 'Layers of pines to walk through.',
      build: () => [[
        L('Sky', [sky('#f0fdf4', '#dcfce7')]),
        L('Far trees', [0.05, 0.2, 0.36, 0.52, 0.68, 0.84, 0.97].flatMap((x, i) => pine(x, 0.66, 0.26 + (i % 2) * 0.05, '#4d7c0f', '#bbf7d0'))),
        L('Ground', [land(0.7, 0.015, 2, '#3f6212', '#a3e635')]),
        L('Near trees', [...pine(0.12, 0.95, 0.5), ...pine(0.88, 0.97, 0.56)]),
        L('Draw here', [])
      ]] },
    { id: 'city', name: 'City at night', icon: '\ud83c\udf03', kind: 'shot', hint: 'Skyline, lit windows, a moon.',
      build: () => {
        const towers = [[0.02, 0.45, 0.14], [0.15, 0.3, 0.26], [0.28, 0.52, 0.38], [0.4, 0.22, 0.5], [0.53, 0.4, 0.64], [0.67, 0.28, 0.78], [0.8, 0.48, 0.9], [0.91, 0.36, 0.99]];
        const windows = towers.flatMap(([x0, top, x1], t) => Array.from({ length: 6 }, (_, i) => {
          const col = i % 2, row = Math.floor(i / 2);
          const wx = x0 + (x1 - x0) * (0.22 + col * 0.38), wy = top + 0.06 + row * 0.09;
          return (t + i) % 3 ? box(wx, wy, wx + (x1 - x0) * 0.2, wy + 0.04, '#facc15', '#fde047', 1) : null;
        }).filter(Boolean));
        return [[
          L('Night sky', [sky('#1e1b4b', '#312e81'), ...starterStars(26), ring(0.86, 0.14, 34, '#fde68a', '#fef3c7', 3)]),
          L('Skyline', [...towers.map(([x0, top, x1]) => box(x0, top, x1, 0.86, '#0f172a', '#334155', 2)), box(0, 0.86, 1, 1, '#0f172a', '#1e293b', 2)]),
          L('Windows', windows),
          L('Draw here', [])
        ]];
      } },
    { id: 'space', name: 'Outer space', icon: '\ud83e\ude90', kind: 'shot', hint: 'Stars, a ringed planet, a moon.',
      build: () => [[
        L('Space', [sky('#020617', '#0f172a'), ...starterStars(40, 3)]),
        L('Planet', [ring(0.7, 0.45, 110, '#7c3aed', '#a78bfa', 4), oval(0.7, 0.45, 190, 34, '#f59e0b', null, 6), ring(0.2, 0.22, 28, '#94a3b8', '#e2e8f0', 3)]),
        L('Draw here', [])
      ]] },
    { id: 'character', name: 'Character sheet', icon: '\ud83e\uddcd', kind: 'asset', hint: 'Proportion guides: 5 heads tall. Hide them when done.',
      build: () => {
        const blue = '#4f8fe6';
        const marks = [0.06, 0.24, 0.42, 0.6, 0.78, 0.94].map(y => ink([[0.36, y], [0.64, y]], blue, 2));
        return [[
          L('Guides', [ring(0.5, 0.15, 58, blue, null, 2), ink([[0.5, 0.04], [0.5, 0.96]], blue, 2), ...marks,
            ink([[0.38, 0.3], [0.62, 0.3]], blue, 3), ink([[0.42, 0.52], [0.58, 0.52]], blue, 3), oval(0.5, 0.95, 120, 14, blue, null, 2)], { opacity: 0.55 }),
          L('Draw here', [])
        ]];
      } },
    { id: 'bounce', name: 'Bouncing ball', icon: '\ud83c\udfc0', kind: 'shot', hint: 'An 8-frame flipbook to remix. Press Space to play.',
      build: () => {
        const path = [[0.12, 0.16], [0.22, 0.26], [0.32, 0.46], [0.42, 0.72], [0.5, 0.8], [0.58, 0.72], [0.68, 0.46], [0.78, 0.26]];
        const ground = L('Ground', [box(0, 0.86, 1, 1, '#64748b', '#e2e8f0', 3)]);
        return path.map(([x, y], i) => [
          L('Ground', ground.strokes),
          // The contact frame squashes; the frames around it stretch: the first lesson of animation.
          L('Ball', [oval(x, y, i === 4 ? 62 : i === 3 || i === 5 ? 40 : 46, i === 4 ? 30 : i === 3 || i === 5 ? 54 : 46, '#c2410c', '#fb923c', 4)]),
          L('Draw here', [])
        ]);
      }, fps: 12 }
  ];
  let starterRevision = -1; // revision right after a starter loaded: switching starters needs no confirm
  const canvasIsBlank = () => frames.length === 1 && frames[0].every(layer => !layer.strokes.length);
  function starterPreview(starter) {
    const stacks = starter.build();
    return frameImage(stacks[Math.min(stacks.length - 1, 4)].map(layer => ({ visible: true, opacity: 1, ...layer })), 160);
  }
  const previewCache = new Map();
  function starterButton(starter, big = false) {
    const button = el('button', `starter${big ? ' big' : ''}`);
    button.type = 'button';
    button.dataset.tip = `${starter.name}|${starter.hint}`;
    const thumb = el('span', 'starter-thumb');
    if (!previewCache.has(starter.id)) previewCache.set(starter.id, starterPreview(starter).toDataURL());
    const image = el('img');
    image.src = previewCache.get(starter.id);
    image.alt = '';
    thumb.append(image);
    const label = el('span', 'starter-name', `${starter.icon} ${starter.name}`);
    button.append(thumb, label);
    if (big) button.append(el('span', 'starter-hint', starter.hint));
    button.addEventListener('click', () => useStarter(starter));
    return button;
  }
  function useStarter(starter) {
    const dirty = revision !== savedRevision && revision !== starterRevision && !canvasIsBlank();
    if (dirty && !confirm('Start over from this starter? Unsaved changes will be lost.')) return;
    if ($('starters-sheet').open) $('starters-sheet').close();
    const stacks = starter.build().map(stack => stack.map(layer => newLayer(layer.name, {
      strokes: layer.strokes.map(stroke => ({ ...stroke, points: stroke.points.slice(), kit: true, seq: 0 })), opacity: layer.opacity ?? 1, visible: layer.visible ?? true })));
    const [first, ...more] = stacks;
    const scenery = starter.kind === 'shot' && starter.id !== 'bounce';
    if (scenery) $('asset-type').value = 'environment'; // a scene from the starters is a backdrop to make shots in
    const kind = scenery ? 'asset' : starter.kind || 'asset';
    loadCanvas(first, {
      kind, more, fps: starter.fps,
      note: starter.id === 'blank' ? 'A clean sheet. Draw anything, or ask AI to sketch a start.'
        : `${starter.icon} ${starter.name}: ${plural(first.length, 'layer')} you can edit${more.length ? `, ${more.length + 1} frames (Space plays)` : ''}. Draw on "Draw here", or \u25c6 Place an asset.`
    });
    if (starter.id === 'blank') { savedRevision = revision; }
    else logEvent('artist', 'Started from', `the ${starter.name} starter`);
    starterRevision = revision;
    startersDismissed = false;
    renderStarters();
  }
  // On an empty canvas the starters float over the bottom of the paper. They fade on the first touch,
  // so the canvas never jumps under the pencil, and come back whenever the canvas is blank again.
  let startersDismissed = false;
  function renderStarters() {
    const show = canvasIsBlank() && !startersDismissed && !sparks.length && tool !== 'place' && !playing;
    $('starter-strip').classList.toggle('show', show);
    $('starter-strip').setAttribute('aria-hidden', String(!show));
    $('starter-strip').inert = !show;
  }
  function buildStarters() {
    $('starter-list').replaceChildren(...STARTERS.filter(s => s.kind === 'shot' && s.id !== 'bounce').map(s => starterButton(s)));
    $('starters-grid').replaceChildren(...STARTERS.map(s => starterButton(s, true)));
  }
  $('starters-open').addEventListener('click', () => { $('starters-sheet').showModal(); });
  $('starters-close').addEventListener('click', () => $('starters-sheet').close());
  $('starters-sheet').addEventListener('click', event => { if (event.target === $('starters-sheet')) $('starters-sheet').close(); });
  $('starter-skip').addEventListener('click', () => { startersDismissed = true; renderStarters(); });

  function pulse(selector) {
    // A gentle "look here" on the control a message is talking about.
    setTimeout(() => document.querySelectorAll(selector).forEach(node => {
      node.classList.remove('pulse');
      void node.offsetWidth;
      node.classList.add('pulse');
    }), 450);
  }
  $('help-open').addEventListener('click', () => $('help').showModal());
  $('help-close').addEventListener('click', () => $('help').close());
  $('help-demo').addEventListener('click', async () => {
    try {
      const data = await api('/api/assets?q=Red%20Rocket');
      const rocket = data.items.find(item => item.name === 'Red Rocket') || data.items[0];
      if (!rocket) throw new Error('No assets yet. Seed the demo (see README) or save your first asset.');
      $('help').close();
      openWhereUsed(rocket);
    } catch (error) {
      $('help-demo').dataset.tip = `Not available|${error.message}`;
      $('help-demo').textContent = 'No example yet';
    }
  });

  // ---------------------------------------------------------------- the menu: one tap to anywhere
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const buzz = () => { try { navigator.vibrate?.(8); } catch { /* not every device can */ } };
  function openMenu() {
    $('menu-account').textContent = account ? (account.user.email || 'Local studio') : '';
    $('menu-account').hidden = !account;
    $('menu-status').textContent = [$('connection').textContent,
      account ? $('account-counts').textContent : ''].filter(Boolean).join(' \u00b7 ');
    $('menu-sign-out').hidden = !account || authConfig?.mode === 'off';
    $('menu').classList.remove('closing');
    $('menu').style.transform = '';
    $('menu').showModal();
    $('menu-open').setAttribute('aria-expanded', 'true');
    buzz();
  }
  function closeMenu(then) {
    const menu = $('menu');
    if (!menu.open) { then?.(); return; }
    if (menu.classList.contains('closing')) return;
    const done = () => {
      menu.classList.remove('closing');
      menu.style.transform = '';
      menu.close();
      then?.();
    };
    if (reduceMotion()) { done(); return; }
    menu.classList.add('closing');
    menu.addEventListener('animationend', done, { once: true });
  }
  const reveal = (node, block = 'start') => node.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block });
  const MENU_ACTIONS = {
    home: () => setView('home'),
    draw: () => { if (canvasIsBlank() && !editing) newCanvas('asset'); else setView('studio'); },
    starters: () => $('starters-sheet').showModal(),
    save: () => { setView('studio'); $('save-card').open = true; reveal($('save-card'), 'center'); },
    find: () => openFinder(),
    help: () => $('help').showModal(),
    hood: () => openHood()
  };
  $('menu-open').addEventListener('click', openMenu);
  $('menu-close').addEventListener('click', () => closeMenu());
  $('menu').addEventListener('cancel', event => { event.preventDefault(); closeMenu(); });
  $('menu').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeMenu(); } });
  $('menu').addEventListener('close', () => { $('menu-open').setAttribute('aria-expanded', 'false'); $('menu-open').focus({ preventScroll: true }); });
  $('menu').addEventListener('click', event => {
    if (event.target === $('menu')) {
      // A click on the dialog itself (not its contents) is the backdrop.
      const r = $('menu').getBoundingClientRect();
      if (event.clientX < r.left) closeMenu();
      return;
    }
    const go = event.target.closest('[data-go]');
    if (go) closeMenu(MENU_ACTIONS[go.dataset.go]);
  });
  $('menu-sign-out').addEventListener('click', () => closeMenu(() => $('sign-out').click()));
  // Swipe it away: the drawer follows your finger, then springs shut or back.
  let swipe = null;
  $('menu').addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse') return;
    swipe = { x: event.clientX, y: event.clientY, dx: 0, locked: false };
  });
  $('menu').addEventListener('pointermove', event => {
    if (!swipe) return;
    const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
    if (!swipe.locked && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; } // a scroll, not a swipe
    if (Math.abs(dx) > 6) swipe.locked = true;
    swipe.dx = Math.max(0, dx);
    if (swipe.locked) $('menu').style.transform = `translateX(${swipe.dx}px)`;
  });
  const endSwipe = () => {
    if (!swipe) return;
    const far = swipe.dx > Math.min(110, $('menu').offsetWidth * 0.3);
    $('menu').style.transition = 'transform .3s cubic-bezier(.2, .8, .2, 1)';
    $('menu').style.transform = far ? 'translateX(105%)' : '';
    setTimeout(() => {
      $('menu').style.transition = '';
      if (far) { $('menu').style.transform = ''; $('menu').close(); }
    }, far ? 280 : 300);
    swipe = null;
  };
  $('menu').addEventListener('pointerup', endSwipe);
  $('menu').addEventListener('pointercancel', endSwipe);

  // Ink-drop ripples and a tiny haptic tick: every important tap answers back.
  const RIPPLES = '.scene-go, .tool, .starter, .primary-mini, .save-button, .next-action, .menu-list button';
  document.addEventListener('pointerdown', event => {
    const target = event.target.closest?.(RIPPLES);
    if (!target || target.disabled || reduceMotion()) return;
    const r = target.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    const ink = document.createElement('span');
    ink.className = 'ripple';
    ink.setAttribute('aria-hidden', 'true');
    ink.style.cssText = `width:${size}px;height:${size}px;left:${event.clientX - r.left - size / 2}px;top:${event.clientY - r.top - size / 2}px`;
    target.append(ink);
    ink.addEventListener('animationend', () => ink.remove());
  }, { passive: true });
  document.querySelectorAll('.scene-go').forEach(button => button.addEventListener('click', buzz));

  // The header lifts off the page once you scroll.
  const topbar = document.querySelector('.topbar');
  addEventListener('scroll', () => topbar.classList.toggle('scrolled', scrollY > 4), { passive: true });

  // ---------------------------------------------------------------- tooltips (hover and keyboard focus)
  const tooltip = $('tooltip');
  let tipTarget = null;
  let tipTimer = null;
  function showTip(target) {
    const [title, body] = target.dataset.tip.split('|');
    tooltip.querySelector('strong').textContent = title;
    tooltip.querySelector('span').textContent = body || '';
    tooltip.classList.toggle('single', !body);
    // Inside an open modal dialog, the tooltip must live in the top layer too.
    const host = target.closest('dialog[open]') || document.body;
    if (tooltip.parentElement !== host) host.append(tooltip);
    tooltip.hidden = false;
    const r = target.getBoundingClientRect();
    const t = tooltip.getBoundingClientRect();
    let top = r.top - t.height - 10;
    if (top < 8) top = r.bottom + 10;
    const left = Math.max(8, Math.min(innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2));
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    target.setAttribute('aria-describedby', 'tooltip');
    tipTarget = target;
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tooltip.hidden = true;
    tipTarget?.removeAttribute('aria-describedby');
    tipTarget = null;
  }
  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const target = event.target.closest?.('[data-tip]');
    if (target === tipTarget) return;
    hideTip();
    if (target) tipTimer = setTimeout(() => showTip(target), 380);
  });
  document.addEventListener('focusin', event => {
    const target = event.target.closest?.('[data-tip]');
    hideTip();
    if (target && target.matches(':focus-visible')) showTip(target);
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('scroll', hideTip, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTip(); }, true);

  // ---------------------------------------------------------------- accounts (m-stash)
  let account = null;
  let authConfig = null;
  let gateMode = 'signup';
  function setGateMode(mode) {
    gateMode = mode;
    document.querySelectorAll('[data-gate]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.gate === mode)));
    $('gate-submit').textContent = mode === 'signup' ? 'Create my studio' : 'Sign in';
    $('gate-password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    $('gate-pw-hint').textContent = mode === 'signup' ? '12+ characters' : '';
    gateStatus('');
  }
  function gateStatus(text, error = false) {
    $('gate-status').textContent = text;
    $('gate-status').classList.toggle('error', error);
    if (error) {
      $('gate-form').classList.remove('shake');
      void $('gate-form').offsetWidth;
      $('gate-form').classList.add('shake');
    }
  }
  function showGate(reason = '') {
    account = null;
    $('account-button').hidden = true;
    $('account-menu').hidden = true;
    const gate = $('gate');
    if (!gate.open) gate.showModal();
    if (reason) { setGateMode('login'); gateStatus(reason, true); }
    setTimeout(() => $('gate-email').focus(), 60);
  }
  $('gate').addEventListener('cancel', event => event.preventDefault()); // no way past the door but signing in
  document.querySelectorAll('[data-gate]').forEach(tab => tab.addEventListener('click', () => setGateMode(tab.dataset.gate)));
  $('gate-reveal').addEventListener('click', () => {
    const show = $('gate-password').type === 'password';
    $('gate-password').type = show ? 'text' : 'password';
    $('gate-reveal').textContent = show ? 'Hide' : 'Show';
    $('gate-reveal').setAttribute('aria-pressed', String(show));
  });
  $('gate-form').addEventListener('submit', async event => {
    event.preventDefault();
    const email = $('gate-email').value.trim();
    const password = $('gate-password').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) { gateStatus('Enter your email, like ada@studio.com.', true); $('gate-email').focus(); return; }
    if (gateMode === 'signup' && (password.length < 12 || password.length > 72)) { gateStatus('Use a password of 12 to 72 characters. A short phrase works well.', true); $('gate-password').focus(); return; }
    if (!password) { gateStatus('Enter your password.', true); $('gate-password').focus(); return; }
    const submit = $('gate-submit');
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    gateStatus(gateMode === 'signup' ? 'Setting up your studio\u2026' : 'Signing you in\u2026');
    const slow = setTimeout(() => gateStatus('Waking the account service (the first sign-in of the day can take ~30 s)\u2026'), 4000);
    try {
      // Through Inkling's own server: the session lands in an HttpOnly cookie, never in page scripts.
      const me = await api(`/api/auth/${gateMode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }) });
      $('gate-password').value = '';
      await signedIn(me, me.created);
    } catch (error) {
      gateStatus(error.message === 'Failed to fetch' ? 'Can\u2019t reach Inkling. Check your connection and try again.' : error.message, true);
    } finally {
      clearTimeout(slow);
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
    }
  });
  function renderAccount() {
    if (!account) return;
    const email = account.user.email;
    $('account-button').hidden = authConfig?.mode === 'off';
    $('account-initial').textContent = (email || '?').charAt(0);
    $('account-email').textContent = email || 'Local studio';
    const lib = account.library || {};
    $('account-counts').textContent = `${plural(lib.assets || 0, 'asset')} \u00b7 ${plural(lib.scenes || 0, 'scene')}${lib.ideas ? ` \u00b7 ${plural(lib.ideas, 'idea')}` : ''}`;
    // Ideas (loose sketches) are from before assets; only libraries that have some still see them.
    $('tab-idea').hidden = !lib.ideas;
    document.querySelector('.kind-switch [data-kind="idea"]').hidden = !lib.ideas;
    const ai = account.budget?.ai;
    const embeds = account.budget?.embeds;
    const lines = [];
    if (ai?.limit) lines.push(`\u2726 ${ai.left} of ${ai.limit} AI drafts left this hour`);
    if (embeds?.limit && embeds.left < embeds.limit * 0.2) lines.push(`${embeds.left} saves & searches left this hour`);
    $('account-budget').textContent = lines.join(' \u00b7 ');
    $('account-budget').hidden = !lines.length;
  }
  $('account-button').addEventListener('click', event => {
    event.stopPropagation();
    const open = $('account-menu').hidden;
    $('account-menu').hidden = !open;
    $('account-button').setAttribute('aria-expanded', String(open));
    if (open) api('/api/session').then(me => { account = me; renderAccount(); }).catch(() => {});
  });
  document.addEventListener('click', event => {
    if (!$('account-menu').hidden && !event.target.closest('#account-menu')) {
      $('account-menu').hidden = true;
      $('account-button').setAttribute('aria-expanded', 'false');
    }
  });
  $('sign-out').addEventListener('click', async () => {
    if (revision !== savedRevision && !confirm('You have unsaved changes on the canvas. Sign out anyway?')) return;
    await fetch('/api/session', { method: 'DELETE' }).catch(() => {});
    await draftStore('readwrite', store => store.delete(DRAFT_KEY)).catch(() => {});
    try { localStorage.removeItem('inkling.lastUser'); } catch { /* fine */ }
    savedRevision = revision; // the confirm above already asked
    location.reload();
  });
  async function signedIn(me, fresh = false) {
    account = me;
    try { localStorage.setItem('inkling.lastUser', me.user.id); } catch { /* fine */ }
    restoreDraft();
    if ($('gate').open) $('gate').close();
    renderAccount();
    loadGallery();
    loadSceneBackdrops();
    let remix = null;
    try { remix = sessionStorage.getItem('inkling.remix'); sessionStorage.removeItem('inkling.remix'); } catch { /* fine */ }
    if (remix) setTimeout(() => remixShared(remix), 600);
    const empty = !me.library?.assets && !me.library?.scenes;
    if (empty && me.demo && (fresh || !localStorage.getItem(`inkling.welcomed.${me.user.id}`))) $('welcome').showModal();
    else if (empty && me.demo) starterPackOnce();
  }
  // A blank library still has something to play with: the starter pack, once per member (not after a clean-out).
  async function starterPackOnce() {
    const key = `inkling.starter.${account?.user.id}`;
    try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch { /* fine */ }
    const added = await addStarterPack();
    if (added) message('library-status', `\ud83c\udf81 Your starter pack is in: ${plural(added, 'ready-made asset')}. Search them anytime (\u2318K).`);
  }
  function welcomed() {
    try { localStorage.setItem(`inkling.welcomed.${account?.user.id}`, '1'); } catch { /* fine */ }
    $('welcome').close();
  }
  $('welcome-close').addEventListener('click', welcomed);
  $('welcome-fresh').addEventListener('click', () => { welcomed(); starterPackOnce(); setView('home'); });
  $('welcome-demo').addEventListener('click', async () => {
    const button = $('welcome-demo');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    $('welcome-status').textContent = 'Copying the demo into your library\u2026';
    try {
      const result = await api('/api/library/demo', { method: 'POST' });
      account.library = result.library;
      renderAccount();
      welcomed();
      await loadGallery();
      message('library-status', `Added ${plural(result.copied.assets || 0, 'asset')} and ${plural(result.copied.shots || 0, 'shot')} to your library. Open Red Rocket to see its shots.`);
      setView('home');
    } catch (error) {
      $('welcome-status').textContent = error.message;
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });
  async function boot() {
    if (offline) {
      // No signal: no sign-in wall. The studio opens on this device's drawing; the account waits for the connection.
      setOffline(true, { quiet: true });
      await restoreDraft();
      launchShortcut();
      return;
    }
    try {
      authConfig = await api('/api/auth/config');
    } catch {
      authConfig = { mode: 'off' };
    }
    try {
      await signedIn(await api('/api/session'));
    } catch (error) {
      if (error.network) { setOffline(true, { quiet: true }); await restoreDraft(); return; }
      showGate();
    }
    launchShortcut();
  }

  // ---------------------------------------------------------------- every animation is code
  // A flipbook take, written out as the p5 sketch that draws it: keyframes as numbers, the same Catmull-Rom curve
  // and pose math as motionFrames/poseXf, and effects as the same seeded code. Frame 1 + this code = every frame,
  // so any scene can be re-derived, audited, and changed one number at a time.
  const num = v => String(Math.round(v * 1e4) / 1e4);
  function motionToSketch(spec) {
    const moving = spec.tracks.map(track => {
      const layer = spec.base.find(item => item.id === track.layerId);
      const b = layer && inkBounds(layer.strokes);
      const pivot = b ? [(b.x + b.w / 2) / W, (b.y + b.h / 2) / H] : [0.5, 0.5];
      const keys = track.keys.map(k => `      { t: ${num(k.t)}, x: ${num(k.x)}, y: ${num(k.y)}, sx: ${num(k.sx)}, sy: ${num(k.sy)}, r: ${num(k.r)}${k.label ? `, label: ${JSON.stringify(k.label)}` : ''} }`);
      const gait = GAITS[track.gait] ? `\n    gait: ${JSON.stringify(track.gait)}, size: [${num(b ? b.w : 100)}, ${num(b ? b.h : 100)}],  // how it moves along the path, and how big it is` : '';
      // The Lab's layers carry no eraser strokes, so the rig's stroke numbers are renumbered to match.
      const labIndex = [];
      if (layer) { let n = 0; for (const stroke of layer.strokes) labIndex.push(stroke.erase ? -1 : n++); }
      const bones = (GAITS[track.gait] && b && layer ? (rigFor(layer)?.bones || []) : [])
        .map(bone => ({ ...bone, strokes: bone.strokes.map(i => labIndex[i] ?? -1).filter(i => i >= 0) })).filter(bone => bone.strokes.length);
      const rig = bones.length ? `\n    rig: [  // its parts (strokes by number) and the joint each turns on\n${bones.map(bone => `      { part: ${JSON.stringify(bone.part)}, s: [${bone.strokes.join(', ')}], p: [${num((b.x + bone.px * b.w) / W)}, ${num((b.y + bone.py * b.h) / H)}] }`).join(',\n')}\n    ],` : '';
      return `  ${JSON.stringify(track.name)}: {\n    pivot: [${num(pivot[0])}, ${num(pivot[1])}],  // its center: it turns and squashes around here${gait}${rig}\n    keys: [\n${keys.join(',\n')}\n    ]\n  }`;
    });
    const rigged = spec.tracks.some(track => { const layer = spec.base.find(item => item.id === track.layerId); return GAITS[track.gait] && layer && rigFor(layer); });
    const gaits = [...new Set(spec.tracks.map(track => track.gait).filter(id => GAITS[id]))];
    const gaitCode = gaits.length ? `
// ---- Gaits: steps or hops from how far it has gone, squash where it lands, a breath while it stands. No AI.
const GAITS = {
${gaits.map(id => `  ${id}: ${JSON.stringify(Object.fromEntries(Object.entries(GAITS[id]).filter(([key]) => !['icon', 'name', 'verb'].includes(key))))}`).join(',\n')}
};
${gaitStep.toString()}
${rigged ? `${rigTurns.toString()}
` : ''}// A gait depends on the whole trip so far, so it is replayed from frame 0 to this frame.
function gait(move, f) {
  const s = { x: 0, y: 0, f: -1, dist: 0, m: 0 };
  let out = { dy: 0, sx: 1, sy: 1 };
  for (let i = 0; i <= f; i++) {
    const k = pose(move.keys, i / max(1, LOOP - 1));
    out = gaitStep(s, GAITS[move.gait], move.size[0], move.size[1], (move.pivot[0] + k.x) * W, (move.pivot[1] + k.y) * H, i, FPS);
  }${rigged ? `
  // Each part's turn, stroke by stroke: legs in step, arms against them, a wagging tail, flapping wings.
  out.bend = {};
  for (const bone of move.rig || []) {
    const r = rigTurns(bone.part, GAITS[move.gait], s, f, FPS);
    for (const i of bone.s) {
      out.bend[i] = { r, p: bone.p };
    }
  }` : ''}
  return out;
}
` : '';
    const effects = fxList(spec.effects);
    const fxCode = effects.length ? `
// ---- Effects: tiny strokes computed by code from a fixed seed (the same every time). No AI.
const ASPECT = H / W;
const CONFETTI = ${JSON.stringify(CONFETTI)};
${seeded.toString()}
const onCanvas = p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const fxStroke = (points, color, width, fill = null) => ({ points, color, width, fill });
const FX = {
${effects.map(fx => `  ${fx.id}: { name: ${JSON.stringify(fx.name)}, count: ${fx.count}, seed: ${fx.seed},\n    particle: ${fx.particle.toString()},\n    draw: ${fx.draw.toString()} }`).join(',\n')}
};
function drawEffects(f) {
  for (const id of EFFECTS) {
    const fx = FX[id];
    if (!fx.parts) {
      const r = seeded(fx.seed);
      fx.parts = Array.from({ length: fx.count }, () => fx.particle(r));
    }
    for (const q of fx.parts) {
      for (const s of fx.draw(q, f / FPS)) {
        ink(s.points.map(p => ({ x: p.x * W, y: p.y * H })), { color: s.color, width: s.width, fill: s.fill, layer: fx.name });
      }
    }
  }
}
` : '';
    const title = (spec.title || spec.label || 'Flipbook').replace(/^\W+\s*/, '');
    return `// ${title}: ${spec.by === 'ai' ? 'Gemini chose these keyframes' : spec.by === 'path' ? 'your finger drew this path; it became these keyframes (and a gait)' : 'a quick move (plain math)'}. This code draws every frame.
// Your strokes are never redrawn: each moving layer is posed (moved, squashed, turned) by the numbers below,
// and in-betweens come from a smooth curve through them. Change a number, Run, then Bake.

const FPS = ${MOTION_FPS};
const STRENGTH = ${num(spec.strength)};   // 1 = as choreographed. Try 1.4 for bigger moves.
const EFFECTS = ${JSON.stringify(effects.map(fx => fx.id))};${effects.length ? `
const EFFECT_LAYERS = ${JSON.stringify(effects.map(fx => fx.name))};` : ''}

// t: 0..1 through the clip. x, y: offset in paper fractions (y up is negative). sx, sy: squash and stretch (negative
// mirrors: it turns around). r: degrees.
const MOTION = {
${moving.join(',\n')}
};

function setup() {
  createCanvas(W, H);
}

function draw() {
  background(255);
  const f = (frameCount - 1) % LOOP;   // this frame
  const t = f / max(1, LOOP - 1);      // 0..1; the last frame lands on the last pose
  // Remixed onto another drawing? If no layer name matches, the whole drawing takes the first track.
  const remix = layers.some(layer => MOTION[layer.name]) ? null : Object.values(MOTION)[0];
  for (const layer of layers) {
    if (!layer.visible${effects.length ? ' || EFFECT_LAYERS.includes(layer.name)' : ''}) {
      continue;   // ${effects.length ? 'effects are drawn by drawEffects() below, fresh every frame' : 'hidden layers stay hidden'}
    }
    const move = MOTION[layer.name] || remix;
    push();
    const step = ${gaits.length ? 'move && move.gait ? gait(move, f) : ' : ''}{ dy: 0, sx: 1, sy: 1 };
    if (move) {
      const k = pose(move.keys, t);
      const [cx, cy] = [move.pivot[0] * W, move.pivot[1] * H];
      translate(cx + k.x * W, cy + k.y * H + step.dy);
      rotate(radians(k.r));
      scale(k.sx * step.sx, k.sy * step.sy);
      translate(-cx, -cy);
    }
    ${rigged ? `layer.strokes.forEach((s, i) => {
      const part = MOTION[layer.name] && step.bend && step.bend[i];   // a remix onto another drawing moves it whole
      if (!part) {
        inkStroke(s);
        return;
      }
      push();   // a rigged part: turned about its joint, inside the pose above
      translate(part.p[0] * W, part.p[1] * H);
      rotate(radians(part.r));
      translate(-part.p[0] * W, -part.p[1] * H);
      inkStroke(s);
      pop();
    });` : `for (const s of layer.strokes) {
      inkStroke(s);
    }`}
    pop();
  }${effects.length ? '\n  drawEffects(f);' : ''}
}

// Catmull-Rom through the keys: smooth arcs, no stop-and-go at each key (the in-betweens).
function pose(keys, t) {
  if (t <= keys[0].t) {
    return keys[0];
  }
  const last = keys[keys.length - 1];
  if (t >= last.t) {
    return strength(last);
  }
  let i = 0;
  while (keys[i + 1].t < t) {
    i++;
  }
  const p1 = keys[i], p2 = keys[i + 1], p0 = keys[i - 1] || p1, p3 = keys[i + 2] || p2;
  const u = (t - p1.t) / ((p2.t - p1.t) || 1), u2 = u * u, u3 = u2 * u;
  const cr = c => 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * u + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u2
    + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * u3);
  return strength({ x: cr('x'), y: cr('y'), sx: signed(cr('sx')), sy: signed(cr('sy')), r: cr('r') });
}
// A scale keeps its sign (negative = mirrored) and never gets thinner than 0.03.
function signed(v) {
  return (v < 0 ? -1 : 1) * constrain(abs(v), 0.03, 4);
}
// STRENGTH grows the moves and the squash and stretch, never the mirror.
function strength(k) {
  const s = STRENGTH;
  const grow = v => (v < 0 ? -1 : 1) * constrain(1 + (abs(v) - 1) * s, 0.03, 4);
  return { x: constrain(k.x * s, -2, 2), y: constrain(k.y * s, -2, 2), sx: grow(k.sx), sy: grow(k.sy), r: constrain(k.r * s, -1080, 1080) };
}
${gaitCode}${fxCode}`;
  }
  // The sketch saved with a kept flipbook: the scene's own source, small enough to read (and to save).
  function sketchRecord(spec, code = motionToSketch(spec)) {
    if (code.length > MAX_SKETCH_CODE) return null;
    return { by: spec.by === 'ai' ? 'ai' : spec.by === 'path' ? 'artist' : 'preset', title: (spec.title || spec.label || 'Flipbook').replace(/^\W+\s*/, '').slice(0, 80) || 'Flipbook',
      prompt: (spec.prompt || '').slice(0, 400), code, frames: frameCount(spec.seconds) };
  }

  // Your drawing, as code: strokes drawn in one motion but lifted mid-line are joined, and points the eye can't see
  // are dropped (Ramer-Douglas-Peucker). Color, width, and drawing order stay; the receipt says what it saved.
  function rdp(points, eps) {
    if (points.length < 3) return points;
    const [a, b] = [points[0], points[points.length - 1]];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    let far = 0, at = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + b[0] * a[1] - b[1] * a[0]) / len;
      if (d > far) { far = d; at = i; }
    }
    return far <= eps ? [a, b] : [...rdp(points.slice(0, at + 1), eps).slice(0, -1), ...rdp(points.slice(at), eps)];
  }
  function drawingAsCode() {
    const paths = [];
    let strokes = 0, points = 0, erasers = 0;
    for (const layer of frames[0]) {
      if (!layer.visible) continue;
      let chain = null;
      for (const stroke of layer.strokes) {
        if (stroke.erase) { erasers++; chain = null; continue; }
        strokes++;
        points += stroke.points.length;
        const pressure = stroke.points.reduce((n, p) => n + (p.pressure ?? 0.5), 0) / stroke.points.length;
        const width = Math.round(stroke.width * (0.25 + pressure) * 10) / 10;
        const xy = stroke.points.map(p => [p.x * W, p.y * H]);
        const end = chain && chain.xy[chain.xy.length - 1];
        if (chain && !stroke.fill && !chain.fill && chain.color === stroke.color && Math.abs(chain.width - width) < 0.8
          && Math.hypot(end[0] - xy[0][0], end[1] - xy[0][1]) < 5) {
          chain.xy.push(...xy.slice(1)); // one line, drawn in several strokes: one path
          chain.joined++;
        } else {
          chain = { layer: layer.name, color: stroke.color, width, fill: stroke.fill || '', xy, joined: 1 };
          paths.push(chain);
        }
      }
    }
    for (const eps of [0.6, 1, 1.5, 2.5, 4]) {
      const rows = paths.map(path => {
        const flat = rdp(path.xy, eps).flatMap(([x, y]) => [Math.round(x), Math.round(y)]);
        return `  [${JSON.stringify(path.layer)}, '${path.color}', ${path.width}, '${path.fill}', ${flat.join(',')}]`;
      });
      const kept = rows.reduce((n, row) => n + (row.split(',').length - 4) / 2, 0);
      const joined = strokes - paths.length;
      const code = `// Your drawing, as code: ${plural(strokes, 'stroke')} (${points.toLocaleString()} points) became ${plural(paths.length, 'path')} (${Math.round(kept).toLocaleString()} points), ${(points / Math.max(1, kept)).toFixed(1)}\u00d7 smaller.
// ${joined ? `${plural(joined, 'stroke')} that continued a line were joined. ` : ''}Points the eye can't see (within ${eps} px of the line) were dropped.
// Same colors, widths, and order. Each path: [layer, color, width, fill, x0, y0, x1, y1, ...] in paper pixels.${erasers ? `\n// Eraser passes (${erasers}) aren't paths, so they're left out.` : ''}
const ART = [
${rows.join(',\n')}
];

function setup() {
  createCanvas(W, H);
}

function draw() {
  background(255);
  for (const [layer, color, width, fill, ...xy] of ART) {
    const points = [];
    for (let i = 0; i < xy.length; i += 2) {
      points.push({ x: xy[i], y: xy[i + 1] });   // try: + noise(i, frameCount * 0.2) * 3 for a hand-drawn "boil"
    }
    ink(points, { color: color, width: width, fill: fill || null, layer: layer, own: true });   // your line, re-encoded
  }
}
`;
      if (code.length <= MAX_SKETCH_CODE) return { code, note: `\u270d Your drawing as code: ${plural(strokes, 'stroke')} \u2192 ${plural(paths.length, 'path')}, ${(points / Math.max(1, kept)).toFixed(1)}\u00d7 fewer points, same look. Plain code, no AI.` };
    }
    return null;
  }

  // ---------------------------------------------------------------- the Lab: your strokes, as numbers
  // Processing for the web (p5.js) over the artist's own strokes. Sketches run in a sandboxed iframe (opaque origin,
  // no network); presets and edits are yours, AI can write a take, and Bake turns the loop into editable frames.
  const LAB_SEED = 7;
  const LAB_PRESETS = [
    { id: 'flow', icon: '\ud83c\udf2c\ufe0f', name: 'Flow field', hint: 'An invisible wind of Perlin noise bends every line.', code: `// Flow field: an invisible wind, made of Perlin noise, bends every line you drew.
// The wind travels in a circle through the noise, so the loop is seamless.

function setup() {
  createCanvas(W, H);
}

function draw() {
  background('#f6f7f1');
  const a = loopT() * TWO_PI;
  const strength = 26;                     // try 60 for a storm
  for (const s of strokes) {
    inkStroke(s, p => {
      const angle = noise(p.x * 0.004 + cos(a) * 0.6, p.y * 0.004 + sin(a) * 0.6) * TWO_PI * 2;
      return { x: p.x + cos(angle) * strength, y: p.y + sin(angle) * strength };
    });
  }
}
` },
    { id: 'kaleido', icon: '\u2744\ufe0f', name: 'Kaleidoscope', hint: 'Six mirrored slices of your drawing, turning.', code: `// Kaleidoscope: six slices of your drawing, mirrored around the center, turning.

let cx = W / 2;
let cy = H / 2;

function setup() {
  createCanvas(W, H);
  const xs = strokes.flatMap(s => s.points.map(p => p.x));
  const ys = strokes.flatMap(s => s.points.map(p => p.y));
  if (xs.length) {
    cx = (min(xs) + max(xs)) / 2;
    cy = (min(ys) + max(ys)) / 2;
  }
}

function draw() {
  background('#f6f7f1');
  const slices = 6;
  translate(W / 2, H / 2);
  rotate(loopT() * TWO_PI / slices);       // one slice per loop: seamless
  for (let k = 0; k < slices; k++) {
    push();
    rotate(k * TWO_PI / slices);
    if (k % 2) {
      scale(1, -1);                        // every other slice is a mirror
    }
    for (const s of strokes) {
      inkStroke(s, p => ({ x: (p.x - cx) * 0.5, y: (p.y - cy) * 0.5 }));
    }
    pop();
  }
}
` },
    { id: 'dust', icon: '\u2728', name: 'Ink to dust', hint: 'Your lines dissolve into particles, then gather back.', code: `// Ink to dust: your lines dissolve into drifting particles, then gather back.

const dots = [];

function setup() {
  createCanvas(W, H);
  const all = strokes.flatMap(s => s.points.map(p => ({ x: p.x, y: p.y, color: s.color, width: s.width })));
  const step = max(1, floor(all.length / 700));   // ~700 dots is plenty
  for (let i = 0; i < all.length; i += step) {
    dots.push({ ...all[i], angle: random(TWO_PI), reach: random(40, 160), rise: random(20, 120) });
  }
}

function draw() {
  background('#f6f7f1');
  const spread = pow(sin(loopT() * PI), 2);       // 0, then 1, then 0: apart, then home
  for (const d of dots) {
    const x = d.x + cos(d.angle) * d.reach * spread;
    const y = d.y + sin(d.angle) * d.reach * spread - d.rise * spread;
    ink([{ x: x, y: y }], { color: d.color, width: max(2, d.width * 0.9) });
  }
}
` },
    { id: 'wave', icon: '\ud83c\udf0a', name: 'The wave', hint: 'Each line bobs in turn, in the order you drew it.', code: `// The wave: each line bobs in turn, in the order you drew it.

function setup() {
  createCanvas(W, H);
}

function draw() {
  background('#f6f7f1');
  const t = loopT();
  const count = max(1, strokes.length);
  for (const s of strokes) {
    const lift = sin((t - s.order / count) * TWO_PI) * 16;   // phase = when you drew it
    inkStroke(s, p => ({ x: p.x, y: p.y - lift }));
  }
}
` }
  ];
  let labTakes = [];
  let labAt = -1;
  let labReady = false;
  let labAsking = false;
  let labWatch = null;
  let labBaking = null;
  const labFrame = () => $('lab-frame');
  // The sandbox page is built here from p5 and the runner (fetched once; the service worker keeps them for airplane
  // mode, which it couldn't do for a sandboxed page's own requests). Its policy refuses every network connection.
  const LAB_POLICY = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; "
    + "font-src data:; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
  let labScripts = null;
  async function labRunnerDoc() {
    labScripts = labScripts || Promise.all(['/lab/p5.min.js', '/lab/inkling-lab.js'].map(path => fetch(path).then(response => {
      // Only real scripts go into the sandbox (never an error page or JSON that a proxy sent instead).
      if (!response.ok || !/javascript/.test(response.headers.get('content-type') || '')) throw new Error('The Lab couldn\u2019t load. Reload Inkling and try again.');
      return response.text();
    }))).catch(error => { labScripts = null; throw error; });
    const [library, runner] = await labScripts;
    const inline = text => text.replace(/<\/script/gi, '<\\/script');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${LAB_POLICY}">`
      + '<meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}'
      + 'body{display:grid;place-items:center}canvas{width:min(100vw,100vh*1000/650)!important;height:auto!important;aspect-ratio:1000/650;'
      + `border-radius:14px;box-shadow:0 30px 80px #0009;touch-action:none}</style><script>${inline(library)}</script><script>${inline(runner)}</script>`
      + '</head><body></body></html>';
  }
  // The artist's strokes as the sketch sees them: paper coordinates, drawing order, every frame.
  function labData() {
    const asLab = (stack, hidden = false) => {
      const list = stack.filter(layer => hidden || layer.visible)
        .flatMap(layer => layer.strokes.filter(stroke => !stroke.erase).map(stroke => ({ stroke, layer: layer.name })));
      list.sort((a, b) => (a.stroke.seq ?? 0) - (b.stroke.seq ?? 0));
      return list.map(({ stroke, layer }, order) => ({
        points: stroke.points.map(p => ({ x: p.x * W, y: p.y * H, pressure: p.pressure ?? 0.5 })),
        color: stroke.color, width: stroke.width, layer, order
      }));
    };
    return { frames: frames.map(stack => asLab(stack)), layers: frames[0].map(layer => ({ name: layer.name, visible: layer.visible, strokes: asLab([layer], true) })) };
  }
  function labError(text) {
    $('lab-error').hidden = !text;
    $('lab-error').textContent = text ? `\u26a0 ${text}` : '';
  }
  function labLines() {
    const code = $('lab-code').value;
    $('lab-lines').textContent = `${code.split('\n').length} lines${labTakes[labAt] && code !== labTakes[labAt].code ? ' \u00b7 edited, \u2318\u21b5 to run' : ''}`;
  }
  // Each run gets a fresh sandbox: nothing carries over, and a stuck sketch is simply thrown away.
  let labRun = 0;
  async function runLab(code = $('lab-code').value) {
    if (signing) { signing = null; $('lab-sign').hidden = true; } // a new run means a new bake to sign
    labReady = false;
    labError('');
    clearTimeout(labWatch);
    const run = ++labRun;
    $('lab-hint').textContent = 'Starting your sketch\u2026';
    let doc;
    try {
      doc = await labRunnerDoc();
    } catch (error) {
      labError(error.message);
      return;
    }
    if (run !== labRun || !$('lab').open) return; // a newer run (or closing the Lab) won
    const fresh = document.createElement('iframe');
    fresh.id = 'lab-frame';
    fresh.className = 'lab-frame';
    fresh.title = 'Your sketch, running';
    fresh.setAttribute('sandbox', 'allow-scripts');
    fresh.setAttribute('referrerpolicy', 'no-referrer');
    fresh.dataset.code = code;
    fresh.srcdoc = doc;
    // A sketch can't reach the network, open windows, or submit forms; if it tries to navigate its own frame away,
    // the frame is gone before anything else runs there.
    let loads = 0;
    fresh.addEventListener('load', () => {
      if (++loads < 2) return;
      fresh.removeAttribute('srcdoc');
      fresh.src = 'about:blank';
      labReady = false;
      labError('The sketch tried to leave the sandbox, so it was stopped.');
    });
    labFrame().replaceWith(fresh);
    labWatch = setTimeout(() => {
      if (labReady || run !== labRun) return;
      labFrame().removeAttribute('srcdoc');
      labError('The sketch didn\u2019t start within 8 s, so it was stopped. An endless loop in setup()?');
      $('lab-hint').textContent = '';
    }, 8000);
  }
  window.addEventListener('message', event => {
    const frame = labFrame();
    if (!frame || event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return;
    const message = event.data;
    if (message.type === 'loaded') {
      frame.contentWindow.postMessage({ type: 'run', code: frame.dataset.code, data: labData(), seed: LAB_SEED, loop: Number($('lab-frames').value) }, '*');
    } else if (message.type === 'ready') {
      labReady = true;
      clearTimeout(labWatch);
      $('lab-hint').textContent = message.webgl ? 'Drag to orbit \u00b7 scroll to zoom \u00b7 bake keeps your view' : 'Your strokes, moved by code';
    } else if (message.type === 'error') {
      labError(`${message.line ? `Line ${message.line}: ` : ''}${message.message}`);
      $('lab-error').dataset.line = message.line || '';
      if (labBaking) { labBaking = null; setLabBusy(false); }
    } else if (message.type === 'baked' && labBaking) {
      const take = labBaking;
      labBaking = null;
      setLabBusy(false);
      if (message.frames) askToSign(take, message.frames, message.keep === true);
    }
  });
  $('lab-error').addEventListener('click', () => {
    const line = Number($('lab-error').dataset.line);
    if (!line) return;
    const lines = $('lab-code').value.split('\n');
    const start = lines.slice(0, line - 1).reduce((n, text) => n + text.length + 1, 0);
    $('lab-code').focus();
    $('lab-code').setSelectionRange(start, start + (lines[line - 1] || '').length);
  });
  // What changed between two versions of the code, in lines: AI's edits are never a mystery.
  function lineDiff(before, after) {
    const count = new Map();
    for (const line of before.split('\n')) count.set(line, (count.get(line) || 0) + 1);
    let added = 0;
    for (const line of after.split('\n')) {
      if (count.get(line)) count.set(line, count.get(line) - 1);
      else added++;
    }
    const removed = [...count.values()].reduce((n, v) => n + v, 0);
    return `+${added} \u2212${removed} lines`;
  }
  function renderLabTakes() {
    const strip = $('lab-takes');
    const chips = labTakes.map((take, i) => {
      const chip = el('button', `take${i === labAt ? ' active' : ''}`);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(i === labAt));
      chip.append(el('b', '', String(i + 1)), el('span', '', take.title.length > 28 ? `${take.title.slice(0, 27)}\u2026` : take.title));
      chip.addEventListener('click', () => showLabTake(i));
      return chip;
    });
    if (labAsking) chips.push(Object.assign(el('span', 'take pending'), { textContent: `Take ${labTakes.length + 1}\u2026` }));
    strip.replaceChildren(...(chips.length ? [el('small', '', 'Takes'), ...chips] : []));
    strip.hidden = !chips.length;
    document.querySelectorAll('#lab-presets button').forEach(button => button.setAttribute('aria-pressed', String(labTakes[labAt]?.preset === button.dataset.preset)));
  }
  function showLabTake(index) {
    if (!labTakes[index]) return;
    labAt = index;
    const take = labTakes[index];
    $('lab-code').value = take.code;
    $('lab-note').textContent = take.note;
    if (take.frames) setLabFrames(take.frames);
    renderLabTakes();
    labLines();
    runLab(take.code);
  }
  function addLabTake(take) {
    labTakes = [...labTakes, take].slice(-12);
    showLabTake(labTakes.length - 1);
  }
  function setLabBusy(on, text = '') {
    $('lab-go').disabled = on;
    $('lab-bake').disabled = on;
    $('lab-run').disabled = on;
    $('lab-go').textContent = on && labAsking ? 'Writing\u2026' : 'Write it';
    $('lab-bake').textContent = on && labBaking ? 'Baking\u2026' : '\u2913 Bake to frames';
    if (text) $('lab-note').textContent = text;
    renderLabTakes();
  }
  // Two doors that are about *this* canvas: the animation on it, as its own code; and the drawing itself, as code.
  function sceneSeed() {
    if (motionDraft) {
      const spec = motionDraft.spec;
      const record = sketchRecord(spec);
      return record && { ...record, motion: motionRecord(spec), take: `\ud83c\udf9e ${record.title}`,
        note: `\ud83c\udf9e This take, as the code that draws it: ${plural(spec.tracks.length, 'moving layer')}, ${plural(spec.tracks.reduce((n, t) => n + t.keys.length, 0), 'keyframe')}. Change a number, run it, bake it.` };
    }
    if (sceneSketch) return { ...sceneSketch, motion: sceneMotion, take: `\ud83c\udf9e ${sceneSketch.title}`,
      note: `\ud83c\udf9e This scene\u2019s own code (${sceneSketch.by === 'ai' ? 'keyframes by Gemini' : sceneSketch.by === 'preset' ? 'a preset' : 'your code'}), saved with it. It runs over frame 1.` };
    return null;
  }
  function seedLab(seed) {
    const same = labTakes.findIndex(take => take.code === seed.code);
    setLabFrames(seed.frames || Number($('lab-frames').value));
    if (same >= 0) { showLabTake(same); return; }
    addLabTake({ title: seed.take || seed.title, by: seed.by, prompt: seed.prompt || '', code: seed.code, motion: seed.motion || null,
      frames: seed.frames, note: seed.note });
  }
  function setLabFrames(count) {
    const select = $('lab-frames');
    const value = String(Math.max(2, Math.min(MAX_FRAMES, Math.round(count))));
    if (![...select.options].some(option => option.value === value)) {
      select.append(Object.assign(document.createElement('option'), { value, textContent: `${value} frames \u00b7 ${(value / MOTION_FPS).toFixed(1)} s` }));
    }
    select.value = value;
  }
  const LAB_DOORS = [
    { id: 'scene', icon: '\ud83c\udf9e', name: 'This animation', hint: 'The take on screen (or this scene), as the code that draws it.', seed: sceneSeed },
    { id: 'ascode', icon: '\u270d\ufe0f', name: 'Drawing as code', hint: 'Your strokes as compact paths: joined, simplified, same look.', seed: () => {
      const made = drawingAsCode();
      return made && { title: 'Drawing as code', take: '\u270d Drawing as code', by: 'preset', code: made.code, note: made.note };
    } },
    ...LAB_PRESETS
  ];
  $('lab-presets').append(...LAB_DOORS.map(preset => {
    const button = el('button', `lab-preset${preset.seed ? ' lab-door' : ''}`);
    button.type = 'button';
    button.dataset.preset = preset.id;
    button.dataset.tip = `${preset.name}|${preset.hint} No AI: plain code you can read.`;
    button.append(el('span', '', preset.icon), el('b', '', preset.name));
    button.addEventListener('click', () => {
      if (preset.seed) {
        const seed = preset.seed();
        if (!seed) { labError(preset.id === 'scene' ? 'No animation here yet: make a flipbook first.' : 'This drawing is too detailed to fit in one sketch.'); return; }
        seedLab({ ...seed, preset: preset.id });
        return;
      }
      const same = labTakes.findIndex(take => take.preset === preset.id && take.code === preset.code);
      if (same >= 0) { showLabTake(same); return; }
      addLabTake({ title: preset.name, by: 'preset', preset: preset.id, prompt: '', code: preset.code,
        note: `${preset.icon} ${preset.name}: ${preset.hint} Plain code, no AI. Change any number and run it.` });
    });
    return button;
  }));
  function renderLabDoors() {
    const scene = $('lab-presets').querySelector('[data-preset="scene"]');
    scene.hidden = !motionDraft && !sceneSketch;
  }
  $('lab-code').addEventListener('input', labLines);
  $('lab-code').addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); $('lab-run').click(); return; }
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      const area = $('lab-code'), at = area.selectionStart;
      area.setRangeText('  ', at, area.selectionEnd, 'end');
      labLines();
    }
  });
  $('lab-run').addEventListener('click', () => {
    const code = $('lab-code').value;
    const current = labTakes[labAt];
    if (!code.trim()) { labError('Write a sketch (or pick one above) first.'); return; }
    if (current && code === current.code) { runLab(code); return; }
    const named = (current?.title || 'Your sketch').replace(/^[+\u270e]\s*/, '');
    addLabTake({ title: `\u270e ${named}`, by: 'artist', prompt: current?.prompt || '', code, frames: current?.frames,
      note: `\u270e Your edit${current ? `: ${lineDiff(current.code, code)}` : ''}. Every take stays a tap away.` });
  });
  $('lab-frames').addEventListener('change', () => runLab()); // the preview loops over exactly what gets baked
  $('lab-ask').addEventListener('submit', async event => {
    event.preventDefault();
    const prompt = $('lab-prompt').value.trim();
    if (prompt.length < 3) { $('lab-prompt').focus(); return; }
    const before = $('lab-code').value;
    labAsking = true;
    setLabBusy(true, '\u2726 Gemini is writing code over your strokes\u2026');
    try {
      const result = await postJSON('/api/sparks/code', JSON.stringify({ prompt, code: before.slice(0, 12000),
        title: $('title').value.trim().slice(0, 120), layers: docLayers() }));
      $('lab-prompt').value = '';
      addLabTake({ title: `+ ${prompt}`, by: 'ai', prompt, code: result.code,
        note: `\u2726 Gemini wrote it: ${result.note || 'a new sketch'} (${before.trim() ? lineDiff(before, result.code) : `${result.code.split('\n').length} lines`}). Read it, change it, run it.` });
    } catch (error) {
      labError(error.message);
      $('lab-note').textContent = labTakes[labAt]?.note || '';
    } finally {
      labAsking = false;
      setLabBusy(false);
    }
  });
  $('lab-bake').addEventListener('click', () => {
    const take = labTakes[labAt];
    if (!take) return;
    if (!labReady) { labError('Run the sketch first; Bake captures what it draws.'); return; }
    if (take.code !== $('lab-code').value) { $('lab-run').click(); labError('Your edit is running now. Bake again to capture it.'); return; }
    labBaking = take;
    setLabBusy(true, `\u2913 Drawing all ${$('lab-frames').value} frames from the same seed\u2026`);
    labFrame().contentWindow.postMessage({ type: 'bake', frames: Number($('lab-frames').value) }, '*');
    setTimeout(() => { if (labBaking === take) { labBaking = null; setLabBusy(false); labError('Baking took too long. Fewer frames, or fewer ink() calls?'); } }, 20000);
  });
  // Baked strokes, made safe for a scene: on the paper, valid colors and widths, and inside one frame's limits.
  function bakedStrokes(list, room, perStroke) {
    const out = [];
    let points = 0;
    let trimmed = false;
    for (const raw of list || []) {
      let pts = (raw.points || []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
        .map(p => ({ x: p.x / W, y: p.y / H, pressure: Number.isFinite(p.pressure) ? clampTo(p.pressure, 0, 1) : 0.75 }));
      if (!pts.length || pts.every(p => p.x < -0.02 || p.x > 1.02 || p.y < -0.02 || p.y > 1.02)) continue;
      if (pts.length > perStroke) {
        const step = Math.ceil(pts.length / perStroke);
        pts = pts.filter((p, i) => i % step === 0 || i === pts.length - 1);
      }
      if (out.length >= room.strokes || points + pts.length > room.points) { trimmed = true; break; }
      points += pts.length;
      const fill = /^#[0-9a-f]{6}$/i.test(raw.fill || '') && pts.length > 2 ? raw.fill.toLowerCase() : null;
      out.push({ layer: typeof raw.layer === 'string' ? raw.layer : null, own: raw.own === true, stroke: {
        points: pts.map(p => ({ x: r4(clampTo(p.x, 0, 1)), y: r4(clampTo(p.y, 0, 1)), pressure: r4(p.pressure) })),
        color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color.toLowerCase() : '#123b38',
        width: Math.round(clampTo(Number(raw.width) || 3, 1, 40) * 10) / 10, ...(fill ? { fill } : {}), code: true, seq: 0 } });
    }
    return { strokes: out, trimmed };
  }
  // Before code-moved lines join the scene, the artist says whose they are. Lines the code only moved (inkStroke,
  // Drawing as code) can be signed as their own hand; marks the code invented (particles, effects) stay code.
  let signing = null;
  function askToSign(take, raw, keep) {
    const counts = raw.reduce((n, frame) => {
      for (const item of frame || []) item.own ? n.own++ : n.made++;
      return n;
    }, { own: 0, made: 0 });
    if (!counts.own) { bakeLab(take, raw, keep, false); return; }
    signing = { take, raw, keep };
    $('lab-note').textContent = `\u2713 ${raw.length} frames drawn from the same seed. One question before they join your scene:`;
    const per = n => Math.round(n / raw.length);
    $('lab-sign-text').textContent = `The code moved your lines through ${raw.length} frames (about ${plural(per(counts.own), 'line')} a frame)`
      + `${counts.made ? `, and drew ${plural(per(counts.made), 'mark')} a frame of its own (particles, effects)` : ''}. `
      + 'Signed, your lines count as your hand; the code is saved with the scene as how they moved.';
    $('lab-sign').hidden = false;
    $('lab-sign').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('lab-sign-yes').focus({ preventScroll: true });
  }
  const sign = signed => {
    if (!signing) return;
    const { take, raw, keep } = signing;
    signing = null;
    $('lab-sign').hidden = true;
    if (signed !== null) bakeLab(take, raw, keep, signed);
  };
  $('lab-sign-yes').addEventListener('click', () => sign(true));
  $('lab-sign-code').addEventListener('click', () => sign(false));
  $('lab-sign-cancel').addEventListener('click', () => sign(null));

  // Similar code: Atlas Automated Embedding. Atlas embeds this sketch with a Voyage code model and ranks every saved scene's code.
  $('lab-similar').addEventListener('click', async () => {
    const code = $('lab-code').value.trim();
    const box = $('lab-found');
    if (code.length < 10) { labError('Write or pick a sketch first: the code is the search.'); return; }
    box.hidden = false;
    box.replaceChildren(el('p', 'lab-found-note', '\u25ce MongoDB Atlas is embedding your code\u2026'));
    try {
      const { items, engine } = await postJSON('/api/search/code', JSON.stringify({ code: code.slice(0, MAX_SKETCH_CODE) }));
      const how = engine?.by === 'atlas-autoembed'
        ? `Atlas Automated Embedding \u00b7 ${engine.model}: Atlas embedded your code and every saved sketch`
        : 'Voyage AI \u00b7 Atlas Vector Search';
      const cards = items.slice(0, 8).map(item => {
        const card = el('div', 'lab-found-card');
        const image = el('img');
        image.src = item.image_url;
        image.alt = '';
        image.loading = 'lazy';
        const text = el('span', 'lab-found-text');
        text.append(el('b', '', item.sketch?.title || item.code),
          el('small', '', `${item.code}${item.frames > 1 ? ` \u00b7 ${item.frames} frames` : ''}${item.sketch ? ` \u00b7 ${item.sketch.by === 'ai' ? 'AI-written' : item.sketch.by === 'artist' ? 'your code' : 'preset'}` : ' \u00b7 no code yet'}`));
        const actions = el('span', 'lab-found-actions');
        if (item.sketch) {
          const remix = el('button', 'lab-run', '\u21bb Remix');
          remix.type = 'button';
          remix.dataset.tip = 'Remix|Load this scene\u2019s code as a new take, running over your drawing.';
          remix.addEventListener('click', async () => {
            try {
              const record = await api(`/api/shots/${encodeURIComponent(item.id)}`);
              if (!record.sketch) throw new Error('That scene has no code anymore.');
              addLabTake({ title: `\u25ce ${record.sketch.title}`, by: record.sketch.by, prompt: record.sketch.prompt || '', code: record.sketch.code,
                frames: record.sketch.frames, note: `\u25ce Remixed from ${item.code}: its code, now running over your drawing. Found by meaning, not by name.` });
              box.hidden = true;
            } catch (error) { labError(error.message); }
          });
          actions.append(remix);
        }
        card.append(image, text, actions);
        return card;
      });
      box.replaceChildren(el('p', 'lab-found-note', items.length ? `\u25ce Nearest by meaning in your library (${how}${engine?.ms ? `, ${engine.ms} ms` : ''}).` : 'Nothing close yet. Save scenes with code and they\u2019ll show up here.'), ...cards);
    } catch (error) {
      box.hidden = true;
      labError(error.message);
    }
  });

  function bakeLab(take, raw, keep, signed = false) {
    const base = frames[0];
    const baseStrokes = base.flatMap(layer => layer.strokes);
    const room = { strokes: MAX_STROKES - baseStrokes.length, points: MAX_POINTS - countPoints(baseStrokes) };
    if (room.strokes < 1 || room.points < 2) { labError('This drawing already uses the canvas limits, so nothing can be baked on top.'); return; }
    // Fit the whole bake in one save (2 MiB): fewer points per stroke until it does.
    let baked = null;
    for (const perStroke of [240, 120, 60, 30]) {
      baked = raw.slice(0, MAX_FRAMES).map(list => bakedStrokes(list, room, perStroke));
      if (JSON.stringify(baked.map(frame => frame.strokes.map(item => item.stroke))).length < 1_500_000) break;
      baked = null;
    }
    if (!baked) { labError('Too much to bake into one scene. Try fewer frames, or a sketch with fewer ink() calls.'); return; }
    if (!baked.some(frame => frame.strokes.length)) { labError('Nothing was inked. Bake captures what ink() and inkStroke() draw.'); return; }
    const title = take.title.replace(/^[+\u270e]\s*/, '').slice(0, 60) || 'Sketch';
    // The scene keeps its layers: ink tagged with a layer bakes back into it (asset links and all); untagged ink
    // gets one code layer. Where the code drew a layer exactly as it was, your original strokes are reused.
    const names = new Set(base.map(layer => layer.name));
    const loose = baked.some(frame => frame.strokes.some(item => !names.has(item.layer)));
    const unchanged = (layer, items) => items.length === layer.strokes.filter(stroke => !stroke.erase).length && items.every((item, i) => {
      const a = item.stroke.points, b = layer.strokes.filter(stroke => !stroke.erase)[i]?.points;
      return b && a.length === b.length && [0, a.length >> 1, a.length - 1].every(j => Math.abs(a[j].x - b[j].x) < 5e-4 && Math.abs(a[j].y - b[j].y) < 5e-4);
    });
    if (loose && base.length + 1 > MAX_LAYERS) { labError(`This sketch needs one free layer for its own lines (${MAX_LAYERS} max). Merge or delete one first.`); return; }
    if (motionDraft) skipMotion(); // baking replaces the frames; a preview on top would be stale
    stopPlay();
    pushUndo();
    // Signed: your lines (moved by code) are yours. Marks the code made on its own keep their `code` mark.
    for (const frame of baked) for (const item of frame.strokes) if (signed && item.own) delete item.stroke.code;
    const stacks = baked.map(frame => {
      const groups = new Map();
      for (const item of frame.strokes) if (names.has(item.layer)) (groups.get(item.layer) || groups.set(item.layer, []).get(item.layer)).push(item);
      const stack = base.map(layer => {
        const props = { opacity: layer.opacity, asset: layer.asset || null, backdrop: layer.backdrop || null };
        const items = groups.get(layer.name);
        groups.delete(layer.name); // a duplicate name bakes into the first layer that has it
        if (!items) return newLayer(layer.name, { ...props, visible: (loose ? keep : true) && layer.visible, strokes: layer.strokes.slice() });
        return newLayer(layer.name, { ...props, visible: true, strokes: unchanged(layer, items) ? layer.strokes.slice() : items.map(item => item.stroke) });
      });
      if (loose) stack.push(newLayer(`\u27e8/\u27e9 ${title}`.slice(0, 40), { strokes: frame.strokes.filter(item => !names.has(item.layer)).map(item => item.stroke) }));
      return stack;
    });
    frames = stacks;
    frameIndex = 0;
    layers = frames[0];
    activeId = layers[layers.length - 1].id;
    fps = MOTION_FPS;
    $('fps').value = String(MOTION_FPS);
    sceneMotion = take.motion || null;
    sceneSketch = { by: take.by, title: title.slice(0, 80), prompt: take.prompt.slice(0, 400), code: take.code, frames: stacks.length };
    if (!editing || editing.kind !== 'shot') {
      if (!CODE.test($('title').value.trim())) {
        const stamp = new Date();
        $('title').value = `Lab_${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}`;
      }
      if (!$('description').value.trim()) $('description').value = (take.prompt || `${title}: a code sketch over my drawing`).slice(0, 200);
    }
    logEvent(take.by === 'ai' ? 'ai' : 'artist', 'Lab bake', `${title} (${take.by === 'ai' ? 'AI-written' : take.by === 'preset' ? 'preset' : 'your code'}): ${stacks.length} frames`);
    if (signed) logEvent('artist', 'Signed', `Lines moved by \u201c${title}\u201d confirmed as the artist\u2019s own`);
    recount();
    rebuildOnion();
    rebuildAll();
    renderFrames();
    renderLayersPanel();
    if (saveKind !== 'shot' && !editing) setSaveKind('shot');
    renderSaveKind();
    closeLab();
    play();
    const perFrame = Math.round(baked.reduce((n, frame) => n + frame.strokes.length, 0) / baked.length);
    const trimmed = baked.some(frame => frame.trimmed);
    message('drawing-status', `${signed ? '\u270d Signed and baked' : '\u2913 Baked'} ${stacks.length} frames from \u201c${title}\u201d: about ${plural(perFrame, 'stroke')} a frame, in your layers, all editable.${trimmed ? ' Some frames were trimmed to fit the canvas limits.' : ''} The code is saved with the scene, and Voyage can find it by its code.`, false, [
      { label: '\u21b6 Undo', tip: 'Undo|Your drawing exactly as it was.', run: () => { undo(); message('drawing-status', 'Undone. Your drawing is back; the Lab still has your takes.'); } },
      { label: '\u27e8/\u27e9 Back to the Lab', run: () => openLab() }]);
  }
  function openLab(seed = null) {
    if (busy() || $('lab').open) return;
    if (!hasInk()) { flashTray('Draw something first: the Lab works on your strokes.', true); canvas.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    stopPlay();
    renderLabDoors();
    seed = seed || (labAt < 0 ? sceneSeed() : null);
    if (document.body.classList.contains('focus-mode')) setFocus(false);
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The page tilts back and the lights go down: your drawing is about to become numbers.
    $('canvas-frame').classList.add('lab-tilt');
    setTimeout(() => {
      $('canvas-frame').classList.remove('lab-tilt');
      $('lab').showModal();
      document.body.classList.add('lab-open');
      if (seed) seedLab(seed);
      else if (labAt < 0) $('lab-presets').querySelector('[data-preset="ascode"]').click();
      else runLab(labTakes[labAt].code === $('lab-code').value ? labTakes[labAt].code : $('lab-code').value);
    }, still ? 0 : 380);
  }
  function closeLab() {
    if (!$('lab').open) return;
    clearTimeout(labWatch);
    labRun++;
    labFrame().removeAttribute('srcdoc'); // the sketch stops; nothing runs in the background
    $('lab').close();
  }
  $('lab').addEventListener('close', () => { document.body.classList.remove('lab-open'); labRun++; labFrame().removeAttribute('srcdoc'); });
  $('lab-open').addEventListener('click', () => openLab());
  $('lab-close').addEventListener('click', closeLab);
  $('lab').addEventListener('keydown', event => { if (event.key === 'Escape' && event.target !== $('lab-code')) { event.preventDefault(); closeLab(); } });
  $('lab').addEventListener('cancel', event => { event.preventDefault(); closeLab(); });
  MENU_ACTIONS.lab = () => openLab();
  const openTakeAsCode = () => { const seed = sceneSeed(); if (seed) openLab(seed); };

  // ---------------------------------------------------------------- offline: airplane mode is a studio, not an error page
  // Everything that's yours keeps working (pen, layers, frames, kit, stamps, quick moves, effects). Everything that
  // needs the internet (Gemini, Voyage search, your library, sharing, voice) is hidden here and refused by `reach`.
  const MOVE_WORDS = [[/take ?off|lift ?off|launch|blast|fly|rocket|rise/i, 'liftoff'], [/hop|jump|leap|bunny|rabbit/i, 'hop'],
    [/spin|twirl|turn around|roll/i, 'spin'], [/bounc|ball/i, 'bounce'], [/walk|stroll|march|run|across/i, 'walk'],
    [/shak|nervous|wobbl|shiver|jitter|scared|cold|vibrat/i, 'shake'], [/zoom|push in|closer|grow|bigger/i, 'zoom'],
    [/float|drift|hover|bob|sway|breez|dream/i, 'float']];
  function offlineMove(text) {
    const hit = MOVE_WORDS.find(([words]) => words.test(text));
    return PRESETS.find(preset => preset.id === (hit ? hit[1] : 'float'));
  }
  function offlineRevise(prompt, read) {
    if (!motionDraft) return;
    const from = directedTake();
    const move = offlineMove(prompt);
    const aimed = targetLayers();
    const ids = new Set(aimed ? aimed.map(layer => layer.id) : from.tracks.map(track => track.layerId));
    const fresh = chosenTracks(box => move.keys(box), ids);
    const tracks = [...from.tracks.map(track => fresh.find(item => item.layerId === track.layerId) || track),
      ...fresh.filter(item => !from.tracks.some(track => track.layerId === item.layerId))];
    if (tracks.length > 4) { flashTray('Four moving things at most. Pick fewer layers.', true); return; }
    const effects = withFx(from.effects, read.on, read.off);
    const tooMuch = fxFits(from, effects);
    if (tooMuch) { flashTray(tooMuch, true); return; }
    const spec = { ...from, tracks, effects, seconds: Math.max(from.seconds, move.seconds), take: `+ ${move.icon} ${move.name}` };
    spec.change = `\u26a1 Take ${takes.length + 1}, offline: ${move.icon} ${move.name} for ${fresh.map(track => track.name).join(', ')}. Plain math, no AI. ${diffMotion(from, spec)}.`;
    previewMotion(spec);
  }
  function setOffline(on, { quiet = false } = {}) {
    if (offline === on && !quiet) return;
    offline = on;
    document.body.classList.toggle('offline', on);
    $('connection').textContent = on ? '\u2708 Offline \u00b7 drawing only' : 'Library online';
    $('connection-dot').classList.toggle('online', !on);
    $('connection').closest('.connection').dataset.tip = on
      ? 'Offline|Your pencil works anywhere. AI, search, and your library come back with the connection. Your drawing is kept on this device.'
      : 'Your library|Saved in MongoDB Atlas. Searched by meaning with Voyage AI. AI drafts by Gemini.';
    for (const id of ['finder', 'welcome']) if ($(id)?.open) $(id).close();
    renderFxChips();
    if (quiet) return;
    if (on) {
      message('drawing-status', '\u2708 Offline. Your pencil still works: draw, layer, stamp, flip frames, quick moves, and effects. AI, search, and your library come back with the signal.');
    } else {
      const unsaved = revision !== savedRevision && hasInk();
      message('drawing-status', `Back online. \u2726 AI, search, and your library are back.${unsaved ? ' Your drawing is still here.' : ''}`, false,
        unsaved ? [{ label: '\u2193 Save to your library', run: () => MENU_ACTIONS.save() }] : []);
      if (account) { loadGallery(); loadSceneBackdrops(); } else boot();
    }
  }
  window.addEventListener('offline', () => setOffline(true));
  window.addEventListener('online', () => checkConnection());

  // ---------------------------------------------------------------- this device: drawings survive reloads, crashes, and airplane mode
  const DRAFT_KEY = 'current';
  function draftStore(mode, act) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('inkling', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('drafts');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('drafts', mode);
        const request = act(tx.objectStore('drafts'));
        tx.oncomplete = () => { open.result.close(); resolve(request.result); };
        tx.onerror = () => { open.result.close(); reject(tx.error); };
      };
    });
  }
  const lastUser = () => { try { return localStorage.getItem('inkling.lastUser'); } catch { return null; } };
  async function keepDraft() {
    // Never before the restore check, and not mid-stroke. Playback and previews don't change the canvas, so they don't block it.
    if (!draftChecked || !window.indexedDB || pointer !== null) return;
    const at = revision;
    try {
      if (at === savedRevision || (!hasInk() && frames.length === 1)) {
        await draftStore('readwrite', store => store.delete(DRAFT_KEY)); // saved to the library (or blank): nothing to keep
      } else {
        // The same compact shape a saved scene uses: frames 2..N as poses of frame 1.
        await draftStore('readwrite', store => store.put({ v: 1, at: Date.now(), owner: account?.user?.id || lastUser(),
          title: $('title').value, description: $('description').value, fps, motion: sceneMotion, sketch: sceneSketch,
          layers: docStack(frames[0]), frames: frames.slice(1).map(stack => ({ layers: compactStack(stack, frames[0]) })) }, DRAFT_KEY));
      }
      draftRevision = at;
    } catch { /* private mode or storage full: the beforeunload warning still guards the work */ }
  }
  setInterval(() => { if (revision !== draftRevision) keepDraft(); }, 1500);
  let draftChecked = false;
  async function restoreDraft() {
    if (draftChecked || !window.indexedDB) return;
    draftChecked = true;
    let draft = null;
    try { draft = await draftStore('readonly', store => store.get(DRAFT_KEY)); } catch { return; }
    const me = account?.user?.id || lastUser();
    if (!draft?.layers?.length || (draft.owner && me && draft.owner !== me) || hasInk() || frames.length > 1) return;
    frames = expandRecord(draft).map(stack => stack.map(layer => newLayer(layer.name, {
      visible: layer.visible, opacity: layer.opacity, strokes: layer.strokes, asset: layer.asset || null, backdrop: layer.backdrop || null,
      ...(layer.xf ? { xf: layer.xf, bend: layer.bend, xfBase: layer.xfBase, xfStrokes: layer.xfStrokes } : {})
    })));
    frameIndex = 0;
    layers = frames[0];
    activeId = layers[layers.length - 1].id;
    sceneMotion = draft.motion || null;
    sceneSketch = draft.sketch || null;
    fps = draft.fps || 12;
    $('fps').value = String(fps);
    $('title').value = draft.title || '';
    $('description').value = draft.description || '';
    resyncSeq();
    revision++;
    draftRevision = revision; // it's on this device already; it is not in the library yet
    recount();
    rebuildOnion();
    rebuildAll();
    renderFrames();
    renderLayersPanel();
    renderSaveKind();
    setView('studio');
    const minutes = Math.round((Date.now() - draft.at) / 60000);
    message('drawing-status', `\u21ba Picked up where you left off (${minutes < 1 ? 'moments' : minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`} ago), kept on this device.`, false,
      [{ label: '\u2190 Your assets', tip: 'Your assets|Start something new. This drawing stays on this device until you replace it.', run: () => setView('home') }]);
  }

  // ---------------------------------------------------------------- install: Inkling on the home screen, like any app
  let installPrompt = null;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const appleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function renderInstall() { $('menu-install').hidden = standalone() || !(installPrompt || appleMobile); }
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; renderInstall(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; renderInstall(); message('drawing-status', '\ud83d\udcf2 Inkling is on your home screen. It opens even in airplane mode.'); });
  MENU_ACTIONS.install = async () => {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice.catch(() => null);
      installPrompt = null;
      renderInstall();
    } else {
      message('drawing-status', '\ud83d\udcf2 In Safari, tap Share, then \u201cAdd to Home Screen\u201d. Inkling then opens like an app, even offline.');
    }
  };
  renderInstall();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { /* no offline shell; online works as before */ }));
  }
  // Home-screen shortcuts: ?focus=1 opens the paper full screen, ?find=1 the search.
  function launchShortcut() {
    const params = new URLSearchParams(location.search);
    if (![...params.keys()].length) return;
    history.replaceState(null, '', location.pathname);
    if (params.get('focus')) setFocus(true);
    else if (params.get('find') && !offline) openFinder();
    else if (/^[A-Za-z0-9_-]{12,32}$/.test(params.get('remix') || '') && !offline) remixShared(params.get('remix'));
  }
  // "Remix in Inkling" on a share page: that scene's code, as a new Lab take running over *your* drawing.
  async function remixShared(token) {
    if (!account) { try { sessionStorage.setItem('inkling.remix', token); } catch { /* fine */ } return; } // after sign-in
    try {
      const sketch = await api(`/s/${encodeURIComponent(token)}/sketch.json`);
      const seed = { title: `\u21bb ${sketch.title || 'Remix'}`, by: sketch.by === 'ai' ? 'ai' : 'artist', prompt: '', code: sketch.code,
        note: '\u21bb Remixed from a shared scene: its code, now moving your drawing. Change any number, Run, then Bake.' };
      const open = () => openLab(seed);
      if (hasInk()) { open(); return; }
      message('drawing-status', 'Remix ready. Draw something (or pick a starter), then open it: the code moves your strokes.', false,
        [{ label: '\u27e8/\u27e9 Open the remix', tip: 'Open the remix|The shared scene\u2019s code, in the Lab, running over your drawing.', run: open }]);
    } catch (error) {
      flashTray(error.message, true);
    }
  }

  let warming = false;
  async function checkConnection() {
    if (!navigator.onLine) { setOffline(true); return; }
    try {
      await api('/api/ready');
      if (offline) setOffline(false);
      $('connection').textContent = 'Library online';
      $('connection').title = '';
      $('connection-dot').classList.add('online');
      if (warming) { warming = false; message('library-status', 'Search is ready.'); loadGallery(); }
    } catch (error) {
      if (error.network) { setOffline(true); setTimeout(checkConnection, 20000); return; } // no route to Inkling: same as airplane mode
      // A fresh server builds its search indexes in the background: say so, and check again shortly.
      const building = /index|minute|demo library/i.test(error.message);
      $('connection').textContent = building ? 'Warming up\u2026' : 'Offline';
      $('connection').title = error.message;
      $('connection-dot').classList.remove('online');
      message('library-status', building ? `${error.message} You can draw meanwhile.` : error.message, !building);
      warming = true;
      setTimeout(checkConnection, building ? 8000 : 20000);
    }
  }
  buildStarters();
  renderSceneBackdrops();
  renderAssetFilters();
  renderSearchHints();
  rebuildAll();
  renderFrames();
  setAiMode('sketch');
  renderSaveKind();
  checkConnection();
  boot();
})();
