(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('drawing');
  const ctx = canvas.getContext('2d');
  const overlay = $('overlay');
  const octx = overlay.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const MAX_STROKES = 1000;
  const MAX_POINTS = 20000;
  const MAX_LAYERS = 12;
  const MAX_HISTORY = 100;
  const MAX_PENDING_SPARKS = 3;
  const TAG_PATTERN = /^[a-z0-9][a-z0-9 -]{0,29}$/;
  const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
  const SHAPES = new Set(['line', 'rect', 'ellipse']);
  const TOOL_KEYS = { b: 'pen', p: 'pen', e: 'eraser', l: 'line', r: 'rect', o: 'ellipse', m: 'move', v: 'move', s: 'spark' };
  const MAX_FRAMES = 80;

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
  let motionSeconds = 10;
  let sceneMotion = null; // the accepted direction behind this scene's frames, saved with the scene
  let showMath = true;
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
  let activeTag = null;
  let currentQuery = '';
  let trayTimer = null;
  let animating = false;
  let compositeQueued = false;
  let opacityBefore = null; // snapshot taken when an opacity drag starts
  let placing = null; // asset being placed: { id, version, name, strokes, bbox }
  let placeDraft = null; // the box being dragged for it

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
  const docStack = stack => stack.map(({ name, visible, opacity, strokes, asset }) => ({ name, visible, opacity, strokes, ...(asset ? { asset } : {}) }));
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
    }
    return pointer !== null;
  }

  // ---------------------------------------------------------------- history
  const snapshot = () => ({ active: activeId, frame: frameIndex, frames: frames.map(copyStack) });
  function pushUndo(state = snapshot()) {
    undoStack.push(state);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
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
      sheet.width = W;
      sheet.height = H;
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
  scratch.width = W;
  scratch.height = H;
  const sctx = scratch.getContext('2d');
  function paintStack(c, stack) {
    for (const layer of stack) {
      if (!layer.visible) continue;
      sctx.clearRect(0, 0, W, H);
      layer.strokes.forEach(stroke => drawStroke(sctx, stroke));
      c.globalAlpha = layer.opacity;
      c.drawImage(scratch, 0, 0);
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
      c.drawImage(layerCanvas(layer.id), 0, 0);
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
      ...(layer.xf ? { xf: layer.xf, xfBase: layer.xfBase, xfStrokes: layer.xfStrokes } : {}), ...(layer.backdrop ? { backdrop: layer.backdrop } : {}) })));
    showFrame(frameIndex + 1);
    logEvent('artist', 'Added frame', `frame ${frameIndex + 1}, a copy of frame ${frameIndex}`);
    markGuide('animate');
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
        layer.visible = !layer.visible;
        composite();
        renderLayersPanel();
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
      name.addEventListener('click', () => { activeId = layer.id; renderLayersPanel(); });
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
    $('layers-count').textContent = String(layers.length);
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
        layer.name = value;
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
    const layer = newLayer(`Layer ${n}`);
    layers.splice(layers.indexOf(activeLayer()) + 1, 0, layer);
    activeId = layer.id;
    rebuildAll();
  });
  $('layer-delete').addEventListener('click', () => {
    if (layers.length === 1) return;
    pushUndo();
    const index = layers.indexOf(activeLayer());
    const [removed] = layers.splice(index, 1);
    activeId = layers[Math.max(0, index - 1)].id;
    recount();
    rebuildAll();
    message('drawing-status', `Deleted "${removed.name}". Undo brings it back.`);
  });
  function moveLayer(step) {
    const index = layers.indexOf(activeLayer());
    const target = index + step;
    if (target < 0 || target >= layers.length) return;
    pushUndo();
    [layers[index], layers[target]] = [layers[target], layers[index]];
    composite();
    renderLayersPanel();
  }
  $('layer-up').addEventListener('click', () => moveLayer(1));
  $('layer-down').addEventListener('click', () => moveLayer(-1));
  $('layer-opacity').addEventListener('input', event => {
    opacityBefore ??= snapshot();
    activeLayer().opacity = Number(event.target.value) / 100;
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
  function appendPoint(event) {
    if (pointCount >= MAX_POINTS) {
      message('drawing-status', 'This canvas has reached 20,000 points. Save it or undo a stroke to continue.', true);
      return;
    }
    const previous = active.points[active.points.length - 1];
    const at = normPoint(event);
    let pressure = event.pointerType === 'pen' ? event.pressure : 0.5;
    if (event.pointerType !== 'pen' && previous) {
      // Fingers and mice have no pressure: quick flicks thin out and slow lines swell, like a brush pen.
      const speed = Math.hypot((at.x - previous.x) * W, (at.y - previous.y) * H);
      pressure = previous.pressure * 0.75 + Math.max(0.3, 0.62 - speed / 70) * 0.25;
    }
    const point = { ...at, pressure };
    active.points.push(point);
    pointCount++;
    const c = layerCanvas(activeStrokeLayer.id).getContext('2d');
    withMode(c, active, () => paintPoint(c, active, point, previous));
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
    if (motionDraft) { flashTray('\ud83c\udfac Keep (Enter) or skip (Esc) the motion first.'); return; }
    if (event.pointerType === 'pen' && !penSeen) {
      penSeen = true;
      flashTray('\u270f\ufe0f Pencil detected: your palm and fingers won\'t draw. Pressure works.');
    }
    if (penSeen && event.pointerType === 'touch') return; // palm rejection once a pencil is in play
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
      renderLayersPanel();
      const b = inkBounds(target.strokes);
      pointer = event.pointerId;
      canvas.setPointerCapture(pointer);
      moving = { layer: target, start: point, original: target.strokes, bounds: pointBounds(target.strokes), mode: scaling ? 'scale' : 'move',
        center: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, before: snapshot(), changed: false };
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
    appendPoint(event);
  });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerId !== pointer) return;
    if (moving) {
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
      } else {
        // Slide the whole layer; the offset is clamped so no point is squashed against the canvas edge.
        const { bounds } = moving;
        const dx = Math.max(-bounds.x0, Math.min(1 - bounds.x1, point.x - moving.start.x));
        const dy = Math.max(-bounds.y0, Math.min(1 - bounds.y1, point.y - moving.start.y));
        moving.layer.strokes = moving.original.map(stroke => ({
          ...stroke, points: stroke.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }))
        }));
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
    } else if (active) {
      const samples = event.getCoalescedEvents?.();
      for (const sample of samples?.length ? samples : [event]) appendPoint(sample);
    }
  });
  function finish(event) {
    if (event.pointerId !== pointer) return;
    pointer = null;
    if (moving) {
      const { layer, mode, changed } = moving;
      moving = null;
      if (changed) {
        recount();
        logEvent('artist', mode === 'scale' ? 'Resized' : 'Moved', `${layer.name}${frames.length > 1 ? ` on frame ${frameIndex + 1}` : ''}`);
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
    } else if (active) {
      active.ms = Math.min(3_600_000, Math.round(performance.now() - activeStart));
      active = null;
      activeStrokeLayer = null;
      renderLayersPanel();
      markGuide('draw');
    }
  }
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', event => {
    if (event.pointerId === pointer && (selection || shapeDraft || placeDraft)) {
      placeDraft = null;
      selection = null;
      shapeDraft = null;
      renderOverlay();
    }
    finish(event);
  });
  canvas.addEventListener('lostpointercapture', finish);

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
    markGuide('draw');
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

  // ---------------------------------------------------------------- tools
  function setTool(next) {
    const wasPlacing = tool === 'place';
    if (next !== 'place') placing = null;
    tool = next;
    if (next !== 'spark' && next !== 'place') drawTool = next;
    canvas.classList.toggle('place-mode', tool === 'place');
    document.querySelectorAll('.tool').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === tool)));
    canvas.classList.toggle('spark-mode', tool === 'spark');
    canvas.classList.toggle('eraser-mode', tool === 'eraser');
    canvas.classList.toggle('move-mode', tool === 'move');
    updateHud();
    if (tool !== 'spark') pendingFix = null;
    else if (pendingFix === null) flashTray('Drag a box around the stuck spot, or tap it.');
    else if (wasPlacing && next !== 'place') renderTray();
  }
  document.querySelectorAll('.tool').forEach(button => button.addEventListener('click', () => {
    closePopover();
    setTool(button.dataset.tool === tool && tool === 'spark' ? drawTool : button.dataset.tool);
  }));
  const setWidth = value => {
    $('width').value = String(Math.max(1, Math.min(40, value)));
    $('width-value').value = $('width').value;
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
    if (revision !== savedRevision) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  async function api(path, options = {}) {
    const response = await fetch(path, options);
    // A session that ends mid-flow (expired, signed out elsewhere) brings back the sign-in, not a dead end.
    if (response.status === 401 && !path.startsWith('/api/session') && !path.startsWith('/api/auth/')) showGate('Your session ended. Sign in again to keep going; your drawing is still here.');
    if (!response.ok) {
      const contentType = response.headers.get('content-type') || '';
      const body = contentType.includes('application/json') ? await response.json() : null;
      const detail = typeof body?.detail === 'string' ? body.detail
        : Array.isArray(body?.detail) && body.detail[0]?.msg ? `${body.detail[0].msg.replace(/^Value error, /, '')}` : null;
      throw new Error(detail || `Request failed (${response.status}). Check the API and try again.`);
    }
    return response.status === 204 ? null : response.json();
  }
  const postJSON = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

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

  // ---------------------------------------------------------------- Ask AI: one text box, three methodical modes
  // Every mode previews first and changes nothing until the artist says so; every step lands in the audit trail.
  const AI_MODES = {
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
  let pendingFix = null; // a "Fix a spot" prompt waiting for the artist to pick the spot
  let pendingVary = null; // a variations goal waiting for the asset to be saved first
  function setAiMode(mode) {
    aiMode = mode;
    const text = AI_MODES[mode];
    document.querySelectorAll('.ai-modes [data-mode]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    $('ai-prompt').placeholder = text.placeholder;
    $('ai-go').setAttribute('aria-label', text.go);
    $('ai-hint').textContent = text.hint;
    $('ai-examples').replaceChildren(...text.examples.map(example => {
      const button = el('button', 'example', example);
      button.type = 'button';
      button.addEventListener('click', () => { $('ai-prompt').value = example; askAI(); });
      return button;
    }));
    $('ai-bar').dataset.mode = mode;
  }
  function currentAsset() {
    if (editing?.kind !== 'asset') return null;
    return { id: editing.id, version: editing.version, name: $('title').value.trim(), type: $('asset-type').value, tags,
      image_url: `/api/assets/${encodeURIComponent(editing.id)}/image?v=${editing.version}` };
  }
  function askAI() {
    const prompt = $('ai-prompt').value.trim().replace(/\s+/g, ' ');
    if (aiMode === 'sketch') {
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
  document.querySelectorAll('.ai-modes [data-mode]').forEach(b => b.addEventListener('click', () => { setAiMode(b.dataset.mode); $('ai-prompt').focus(); }));
  $('ai-bar').addEventListener('submit', event => { event.preventDefault(); askAI(); });

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
    requestAnimationFrame(fitFocus);
  }
  $('focus-toggle').addEventListener('click', () => setFocus(!document.body.classList.contains('focus-mode')));
  addEventListener('resize', () => requestAnimationFrame(fitFocus));

  // ---------------------------------------------------------------- ink swatches (big, finger-friendly)
  function setInk(color) {
    $('ink').value = color;
    document.querySelectorAll('#swatches .ink-dot').forEach(dot => dot.setAttribute('aria-pressed', String(dot.dataset.color === color)));
  }
  document.querySelectorAll('#swatches .ink-dot').forEach(dot => dot.addEventListener('click', () => {
    setInk(dot.dataset.color);
    if (tool !== 'pen' && SHAPES.has(tool) === false) setTool('pen');
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

  async function startSpark(kind, region, prompt) {
    if (pendingCount() >= MAX_PENDING_SPARKS) {
      flashTray('Three AI requests are already running. Keep drawing; they\'ll land soon.', true);
      return;
    }
    const title = $('title').value.trim().slice(0, 120);
    const body = JSON.stringify(kind === 'sketch' ? { prompt, title, layers: docLayers() } : { region, prompt, title, layers: docLayers() });
    if (new Blob([body]).size > 2 * 1024 * 1024) {
      flashTray('This drawing is too big to send to AI (2 MiB limit).', true);
      return;
    }
    const spark = { kind, region, prompt, status: 'pending' };
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
    markGuide('draw');
    message('drawing-status', `Added a blue-pencil sketch under "${activeLayer().name}". Draw over it, then hide or delete it.`, false, [
      { label: 'Hide the sketch', run: () => { pushUndo(); layer.visible = false; rebuildAll(); message('drawing-status', 'Sketch hidden. Show it again from Layers.'); } }
    ]);
    return true;
  }

  function acceptSpark() {
    const spark = activeSpark();
    if (!spark) return;
    if (spark.kind === 'sketch') {
      if (!addSketchLayer(spark)) return;
      logEvent('ai', 'AI sketch', `"${spark.prompt}": ${plural(spark.result.strokes.length, 'blue-pencil stroke')} as their own layer`);
    } else if (spark.kind === 'strokes') {
      if (!commitStrokes(spark.result.strokes)) {
        flashTray(`Can't add to "${activeLayer().name}" right now. See the note under the canvas.`, true);
        return;
      }
      logEvent('ai', 'Fix a spot', `${spark.prompt ? `"${spark.prompt}"` : 'no prompt'}: ${plural(spark.result.strokes.length, 'stroke')} on "${activeLayer().name}" (${spark.result.note})`);
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
    const what = { sketch: 'AI sketch', strokes: 'AI fix', guide: 'trace guide' }[spark.kind];
    logEvent('artist', 'Skipped AI', `${what}${spark.prompt ? ` "${spark.prompt}"` : ''}`);
    sparks.splice(sparks.indexOf(spark), 1);
    renderOverlay();
    renderTray();
  }
  function retrySpark() {
    const spark = activeSpark();
    if (!spark) return;
    sparks.splice(sparks.indexOf(spark), 1);
    startSpark(spark.kind, spark.region, spark.prompt);
  }

  function animate() {
    if (animating) return;
    animating = true;
    const tick = () => {
      renderOverlay();
      if (pendingCount() || revealing()) requestAnimationFrame(tick);
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
    if (motionDraft) {
      paintMotionPreview();
      return;
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
    const ready = activeSpark();
    if (ready) {
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
  async function startPlacing(item, at = null) {
    try {
      const asset = await api(`/api/assets/${encodeURIComponent(item.id)}`);
      // A placed asset becomes one linked layer: its visible layers flattened bottom-up.
      const strokes = asset.layers.filter(layer => layer.visible).flatMap(layer => layer.strokes);
      const bbox = inkBounds(strokes);
      if (!bbox) throw new Error('This asset has no visible ink to place.');
      if (layers.length >= MAX_LAYERS) throw new Error('A drawing can have 12 layers. Merge or delete one first.');
      placing = { id: asset.id, version: asset.version, name: asset.name, strokes, bbox };
      if (saveKind !== 'shot' && !editing) setSaveKind('shot'); // placing assets means building a scene
      if (!$('animate-sheet').open) canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // It lands right away at a friendly size (where it was dropped, else center stage); then you drag it.
      const k = Math.min(W * 0.34 / bbox.w, H * 0.42 / bbox.h, 1.5);
      const w = bbox.w * k, h = bbox.h * k;
      const cx = at ? at.x : W / 2, cy = at ? at.y : H * 0.56;
      placeAsset({ x: Math.max(0, Math.min(W - w, cx - w / 2)), y: Math.max(0, Math.min(H - h, cy - h / 2)), w, h });
    } catch (error) {
      message('library-status', error.message, true);
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
    flashTray(`\u25c6 ${name} is in. Drag it anywhere, pull the corner to resize, then \ud83c\udfac Animate.`);
    message('drawing-status', `Placed "${name}" as a linked layer (it always knows where it's used). Drag to position it, or \ud83c\udfac Animate it.`);
    logEvent('artist', 'Placed', `${name} v${layer.asset.version}${frames.length > 1 ? ` on frame ${frameIndex + 1}` : ''}`);
  }

  // ---------------------------------------------------------------- direct manipulation: grab what you made
  // Scenery from a starter (all kit strokes, or ink covering most of the canvas) isn't grabbed by a stray tap:
  // you grab what you drew or placed. Pick the scenery layer in Layers to move it on purpose.
  const isScenery = layer => {
    if (layer.asset) return false;
    const b = inkBounds(layer.strokes);
    return !b || b.w * b.h > W * H * 0.6 || layer.strokes.every(stroke => stroke.kit);
  };
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
    return { t, x: cr('x'), y: cr('y'), sx: Math.max(0.03, cr('sx')), sy: Math.max(0.03, cr('sy')), r: cr('r') };
  }
  // A frame's pose: offsets and pivot in canvas fractions, r in degrees. Mirrors pose_strokes in backend/models.py.
  function xfAt(keys, t, strength, pivot) {
    const k = sampleKeys(keys, t), s = strength;
    const lim = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)) * 1e5) / 1e5;
    return { x: lim(k.x * s, -2, 2), y: lim(k.y * s, -2, 2), sx: lim(1 + (k.sx - 1) * s, 0.03, 4), sy: lim(1 + (k.sy - 1) * s, 0.03, 4),
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
      out.push({ ...stroke, width: Math.max(1, Math.min(40, stroke.width * Math.sqrt(xf.sx * xf.sy))),
        points: points.map(p => ({ ...p, x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) })) });
    }
    return out;
  }
  const frameCount = seconds => Math.max(2, Math.min(MAX_FRAMES, Math.round(seconds * MOTION_FPS)));
  function motionFrames(spec) {
    const count = frameCount(spec.seconds);
    const base = spec.base;
    const tracks = spec.tracks.map(track => {
      const layer = base.find(l => l.id === track.layerId);
      const b = layer && inkBounds(layer.strokes);
      return { ...track, layer, baseStrokes: layer ? layer.strokes.slice() : [], pivot: b ? { px: (b.x + b.w / 2) / W, py: (b.y + b.h / 2) / H } : { px: 0.5, py: 0.5 } };
    }).filter(track => track.layer);
    return Array.from({ length: count }, (_, f) => {
      if (f === 0) return base; // every clip starts exactly as drawn
      const t = f / (count - 1);
      return base.map(layer => {
        const props = { visible: layer.visible, opacity: layer.opacity, asset: layer.asset, backdrop: layer.backdrop };
        const track = tracks.find(tr => tr.layer === layer);
        if (!track) return newLayer(layer.name, { ...props, strokes: layer.strokes.slice() });
        const xf = xfAt(track.keys, t, spec.strength, track.pivot);
        const strokes = poseXf(track.baseStrokes, xf);
        return newLayer(layer.name, { ...props, strokes, xf, xfBase: track.baseStrokes, xfStrokes: strokes.slice() });
      });
    });
  }
  // Saving: a frame layer that still matches "frame 1's layer" (as is, or posed) is stored as a reference.
  const sameStrokes = (a, b) => a === b || (!!a && !!b && a.length === b.length && a.every((s, i) => s === b[i]));
  function compactStack(stack, first) {
    return stack.map(layer => {
      const meta = { name: layer.name, visible: layer.visible, opacity: layer.opacity, ...(layer.asset ? { asset: layer.asset } : {}) };
      if (layer.xf && sameStrokes(layer.strokes, layer.xfStrokes)) {
        const ref = first.findIndex(base => sameStrokes(base.strokes, layer.xfBase));
        if (ref >= 0) return { ...meta, strokes: [], ref, xf: layer.xf };
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
      const strokes = poseXf(base.strokes, layer.xf);
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
  function previewMotion(spec) {
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
    // Closing the sheet hands focus back to the Animate button; Enter must mean "keep", not "reopen".
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function paintMotionPreview() {
    const { stacks, paths } = motionDraft;
    const at = Math.min(motionDraft.at, stacks.length - 1);
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, W, H);
    paintStack(octx, stacks[at]);
    const k = mathScale(canvas.getBoundingClientRect().width);
    if (showMath) drawMath(octx, paths, at, stacks.length, { scale: k });
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
  function restrength(delta) {
    if (!motionDraft) return;
    const spec = { ...motionDraft.spec, strength: Math.round(Math.max(0.4, Math.min(1.9, motionDraft.spec.strength + delta)) * 10) / 10 };
    previewMotion(spec);
  }
  function motionRecord(spec) {
    const clean = v => Math.round(v * 1e4) / 1e4;
    return { by: spec.by, prompt: (spec.prompt || '').slice(0, 300), note: (spec.title || spec.note || spec.label || '').slice(0, 160),
      seconds: Math.round(frameCount(spec.seconds) / MOTION_FPS * 100) / 100, fps: MOTION_FPS, strength: spec.strength,
      tracks: spec.tracks.slice(0, 4).map(track => ({ name: track.name.slice(0, 40), keys: track.keys.slice(0, 24).map(k => ({
        t: clean(Math.max(0, Math.min(1, k.t))), x: clean(Math.max(-1.5, Math.min(1.5, k.x))), y: clean(Math.max(-1.5, Math.min(1.5, k.y))),
        sx: clean(Math.max(0.03, Math.min(4, k.sx))), sy: clean(Math.max(0.03, Math.min(4, k.sy))), r: clean(Math.max(-1080, Math.min(1080, k.r))),
        label: (k.label || '').slice(0, 24) })) })) };
  }
  function keepMotion() {
    if (!motionDraft) return;
    const { spec, stacks } = motionDraft;
    const replaced = frames.length;
    stopMotionPreview();
    pushUndo();
    frames = stacks;
    frameIndex = 0;
    layers = frames[0];
    activeId = (layers.find(layer => layer.name === spec.tracks[0].name) || layers[layers.length - 1]).id;
    fps = MOTION_FPS;
    $('fps').value = String(MOTION_FPS);
    sceneMotion = motionRecord(spec);
    if (!editing || editing.kind !== 'shot') {
      // One tap to save: a readable scene code ("LittleFox_0413") and the direction as its notes (Voyage reads those too).
      if (!CODE.test($('title').value.trim())) {
        const who = spec.tracks.map(track => track.name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join('')).filter(Boolean)[0] || 'Scene';
        const stamp = new Date();
        $('title').value = `${who.slice(0, 24)}_${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}`;
      }
      if (!$('description').value.trim()) $('description').value = (spec.title || spec.prompt || spec.note || '').slice(0, 200);
    }
    recount();
    rebuildOnion();
    rebuildAll();
    renderFrames();
    if (saveKind !== 'shot' && !editing) setSaveKind('shot');
    renderSaveKind();
    const names = spec.tracks.map(track => track.name).join(', ');
    const keyCount = spec.tracks.reduce((n, track) => n + track.keys.length, 0);
    const detail = `${spec.by === 'ai' ? `"${spec.prompt}"` : spec.label}: ${frames.length} frames (${keyCount} keyframes) at ${MOTION_FPS} fps, moving ${names}`
      + `${spec.strength !== 1 ? ` (strength ${spec.strength}\u00d7)` : ''}`;
    logEvent(spec.by === 'ai' ? 'ai' : 'artist', spec.by === 'ai' ? 'Motion, accepted' : 'Motion preset', detail);
    markGuide('animate');
    renderTray();
    message('drawing-status', `\ud83c\udfac ${frames.length} frames, ${(frames.length / MOTION_FPS).toFixed(1)} s${replaced > 1 ? ` (replacing ${replaced}; Undo brings them back)` : ''}. Each one is yours: scrub, grab with \u2725, redraw. Space plays.`, false,
      [{ label: '\u25c6 How it moves', tip: 'How it moves|Keyframes, in-betweens, and spacing, shown on your shot.', run: () => explainScene() }]);
    setTool('move');
    play();
  }
  function skipMotion() {
    if (!motionDraft) return;
    const { spec } = motionDraft;
    if (spec.by === 'ai') logEvent('ai', 'Motion, skipped', `"${spec.prompt}"`);
    stopMotionPreview();
    renderTray();
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
    body.append(el('p', 'explain-direction', motion.by === 'ai' ? `\u2726 AI choreographed: "${motion.prompt}"` : `Preset: ${motion.note}`));

    const one = section('\u2460', 'Keyframes: the poses that matter',
      `${motion.by === 'ai' ? 'The AI' : 'The preset'} chose ${track.keys.length} keyframes for ${track.name}${motion.tracks.length > 1 ? ` (and ${motion.tracks.slice(1).map(t => `${t.keys.length} for ${t.name}`).join(', ')})` : ''}. Each is a pose: where it is, how squashed, how turned.`);
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
    $('explain-math').checked = showMath;
    $('explain-sheet').showModal();
  }
  $('explain-close').addEventListener('click', () => $('explain-sheet').close());
  $('explain-sheet').addEventListener('click', event => { if (event.target === $('explain-sheet')) $('explain-sheet').close(); });
  $('explain-math').addEventListener('change', () => { showMath = $('explain-math').checked; renderOverlay(); });
  $('explain-open').addEventListener('click', explainScene);

  // ---------------------------------------------------------------- the Animate sheet: what moves, and the director
  // What can move: anything visible with ink that isn't scenery. Defaults to what's selected, else the assets.
  const movable = () => layers.filter(layer => layer.visible && hasInk([layer]) && !isScenery(layer));
  let animSubjects = new Set();
  function defaultSubjects() {
    // What you grabbed (or an asset you're on); otherwise the placed assets; otherwise your latest drawing.
    const can = movable();
    const active = can.find(layer => layer.id === activeId && (layer.asset || tool === 'move'));
    const picks = active ? [active] : can.filter(layer => layer.asset).slice(0, 3);
    return new Set((picks.length ? picks : can.slice(-1)).map(layer => layer.id));
  }
  function renderAnimSubjects() {
    const can = movable();
    animSubjects = new Set([...animSubjects].filter(id => can.some(layer => layer.id === id)));
    if (!animSubjects.size) animSubjects = defaultSubjects();
    $('anim-subjects').replaceChildren(...(can.length ? can.map(layer => {
      const chip = el('button', 'anim-chip', `${layer.asset ? '\u25c6 ' : ''}${layer.name}`);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(animSubjects.has(layer.id)));
      chip.addEventListener('click', () => {
        if (animSubjects.has(layer.id)) animSubjects.delete(layer.id);
        else if (animSubjects.size < 4) animSubjects.add(layer.id);
        renderAnimSubjects();
      });
      return chip;
    }) : [el('span', 'anim-empty', 'Nothing to move yet. Drop in an asset below, or draw something first.')]));
    if (!can.length) $('anim-add').open = true;
    const ready = animSubjects.size > 0;
    document.querySelectorAll('#anim-presets button').forEach(button => { button.disabled = !ready; });
    $('anim-go').disabled = !ready;
  }
  function chosenTracks(keysFor, ids = animSubjects) {
    return layers.filter(layer => ids.has(layer.id)).map(layer => {
      const b = inkBounds(layer.strokes);
      const box = { x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H };
      return { layerId: layer.id, name: layer.name, box, keys: keysFor(box, layer) };
    });
  }
  const subjectFor = (layer, box) => ({ id: layers.indexOf(layer), name: layer.name.slice(0, 40),
    box: { x: Math.max(0, Math.min(1, box.x)), y: Math.max(0, Math.min(1, box.y)), w: Math.max(0.02, Math.min(1, box.w)), h: Math.max(0.02, Math.min(1, box.h)) } });
  function runPreset(preset) {
    const tracks = chosenTracks(box => preset.keys(box));
    if (!tracks.length) return;
    $('animate-sheet').close();
    previewMotion({ by: 'preset', label: `${preset.icon} ${preset.name}`, note: `${preset.icon} ${preset.name}`, seconds: preset.seconds, strength: 1, base: layers, tracks });
  }
  async function runAIMotion(prompt, ids = animSubjects, title = '') {
    const tracks = chosenTracks(() => [], ids);
    if (!tracks.length || !prompt) return;
    const status = $('anim-status');
    status.textContent = `\u2726 Choreographing ${(frameCount(motionSeconds) / MOTION_FPS).toFixed(0)} seconds for ${tracks.map(t => t.name).join(' and ')}\u2026 (one AI call)`;
    status.classList.remove('error');
    $('anim-go').disabled = true;
    try {
      const subjects = tracks.map(track => subjectFor(layers.find(layer => layer.id === track.layerId), track.box));
      const result = await postJSON('/api/sparks/motion', JSON.stringify({ prompt, seconds: motionSeconds, subjects, layers: docLayers() }));
      const byIndex = new Map(result.tracks.map(track => [track.subject, track.keys]));
      const aiTracks = tracks.map((track, i) => ({ ...track, keys: byIndex.get(subjects[i].id) })).filter(track => track.keys?.length);
      if (!aiTracks.length) throw new Error('AI returned no motion for those layers. Try other words.');
      status.textContent = '';
      $('animate-sheet').close();
      previewMotion({ by: 'ai', label: `\u2726 ${title || result.note || prompt}`, note: result.note || '', title, prompt, seconds: motionSeconds, strength: 1, base: layers, tracks: aiTracks });
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
    } finally {
      $('anim-go').disabled = !animSubjects.size;
    }
  }
  // Director's ideas: instant ones from the names on the canvas, then (one AI call per new composition) a
  // director's pitch that actually looks at the picture: who moves, where they go, what they do.
  const IDEA_KINDS = [
    [/rocket|ship|plane|jet|ufo|dragon|bird|bee|butterfly|bat/i, n => ({ title: 'Takeoff', logline: `${n} gets nervous, then launches into the sky.`,
      prompt: `${n} wobbles nervously for 2 seconds, crouches in anticipation, blasts off in a big arc toward the top right, loops once across the sky, and exits off the top by the end.` })],
    [/fox|cat|dog|rabbit|bunny|hero|kid|man|woman|girl|boy|robot|monster|creature|character|frog|bear|mouse/i, n => ({ title: 'Big Entrance', logline: `${n} hops in, looks around, and takes a bow.`,
      prompt: `${n} hops in from the left in three bouncy hops, stops at center with a squash, looks left and right, takes a little bow, then hops off to the right.` })],
    [/ball|balloon|badge|sun|coin|star|blob|slime/i, n => ({ title: 'Bounce Show', logline: `${n} bounces across the scene, squashing on every landing.`,
      prompt: `${n} drops in from the top left and bounces three times across the scene, squashing on each landing and stretching on the way up, each bounce lower, then rolls to a stop on the right.` })],
    [/tree|pine|palm|flower|plant|grass|flag/i, n => ({ title: 'Breezy Day', logline: `${n} sways in a gusting wind.`,
      prompt: `${n} sways gently left and right for 4 seconds, bends hard in a sudden gust, springs back past upright, and settles.` })]
  ];
  let ideas = { key: '', items: null };
  const backdropName = () => STARTERS.find(s => s.id === layers.find(layer => layer.backdrop)?.backdrop)?.name || '';
  const sceneKey = () => `${movable().map(layer => `${layer.name}:${layer.asset?.asset_id || ''}`).join('|')}#${backdropName()}#${motionSeconds}`;
  function quickIdeas() {
    const can = movable();
    const named = can.filter(layer => layer.asset).concat(can.filter(layer => !layer.asset));
    const out = [];
    for (const layer of named) {
      const kind = IDEA_KINDS.find(([re]) => re.test(layer.name));
      if (kind && out.length < 2) out.push({ ...kind[1](layer.name), movers: [layer.id] });
    }
    if (named[0] && out.length < 2) out.push({ title: 'Float & Spin', logline: `${named[0].name} drifts in, spins once, and floats away.`, movers: [named[0].id],
      prompt: `${named[0].name} drifts in from the left, slows to a stop at center with a little overshoot, does one full spin, grows a bit, then floats up and away.` });
    if (named.length > 1) out.push({ title: 'The Chase', logline: `${named[0].name} chases ${named[1].name} across the scene.`, movers: [named[0].id, named[1].id],
      prompt: `${named[1].name} dashes from left to right with ${named[0].name} close behind; halfway, ${named[1].name} jumps over a gap while ${named[0].name} skids to a stop with a squash, then both exit right.` });
    return out.slice(0, 3);
  }
  function renderIdeas(items, { loading = false, note = '' } = {}) {
    const box = $('anim-ideas');
    if (!movable().length) {
      box.replaceChildren(el('span', 'anim-empty', 'Add an asset (or draw something) and the director will pitch shots for it.'));
      return;
    }
    box.replaceChildren(...items.map(idea => {
      const card = el('article', `idea-card${idea.ai ? ' ai' : ''}`);
      const head = el('div', 'idea-head');
      head.append(el('b', '', idea.title), el('span', 'idea-by', idea.ai ? '\u2726 Director' : 'instant idea'));
      const movers = el('div', 'idea-movers');
      for (const id of idea.movers) {
        const layer = layers.find(l => l.id === id);
        if (layer) movers.append(el('span', '', `${layer.asset ? '\u25c6 ' : ''}${layer.name}`));
      }
      const go = el('button', 'pill primary idea-go', `\u2726 Animate this \u00b7 ${(frameCount(motionSeconds) / MOTION_FPS).toFixed(0)} s`);
      go.type = 'button';
      go.dataset.tip = `Animate this|One AI call choreographs it: keyframes for ${idea.movers.length === 1 ? 'that drawing' : 'those drawings'}, previewed before anything changes.`;
      go.addEventListener('click', () => {
        animSubjects = new Set(idea.movers);
        renderAnimSubjects();
        $('anim-prompt').value = idea.prompt;
        runAIMotion(idea.prompt, new Set(idea.movers), idea.title);
      });
      const edit = el('button', 'link-button', 'Edit first');
      edit.type = 'button';
      edit.addEventListener('click', () => { animSubjects = new Set(idea.movers); renderAnimSubjects(); $('anim-prompt').value = idea.prompt; $('anim-prompt').focus(); });
      const actions = el('div', 'idea-actions');
      actions.append(go, edit);
      card.append(head, el('p', 'idea-logline', idea.logline), movers, el('p', 'idea-prompt', idea.prompt), actions);
      return card;
    }));
    if (loading) box.append(el('div', 'idea-loading', '\u2726 The director is looking at your scene\u2026'));
    if (note) box.append(el('p', 'anim-empty', note));
  }
  async function loadIdeas(force = false) {
    const can = movable();
    if (!can.length) { renderIdeas([]); return; }
    const key = sceneKey();
    if (!force && ideas.items && ideas.key === key) { renderIdeas(ideas.items); return; }
    const quick = quickIdeas();
    renderIdeas(quick, { loading: true });
    try {
      const subjects = can.slice(0, 8).map(layer => {
        const b = inkBounds(layer.strokes);
        return subjectFor(layer, { x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H });
      });
      const result = await postJSON('/api/sparks/direct', JSON.stringify({ seconds: frameCount(motionSeconds) / MOTION_FPS, backdrop: backdropName(), subjects, layers: docLayers() }));
      if (sceneKey() !== key) return; // the scene changed while the director was thinking
      const items = result.ideas.map(idea => ({ ...idea, ai: true, movers: idea.movers.map(index => layers[index]?.id).filter(Boolean) }))
        .filter(idea => idea.movers.length);
      ideas = { key, items: items.length ? items : quick };
      renderIdeas(ideas.items);
    } catch (error) {
      renderIdeas(quick, { note: `${error.message} These instant ideas work too.` });
    }
  }
  // A backdrop from the starters, slid under everything in every frame (one set of strokes, shared).
  function setBackdrop(starterId) {
    const starter = STARTERS.find(s => s.id === starterId);
    const scenery = (starter ? starter.build()[0].filter(layer => layer.name !== 'Draw here') : []).map(layer => ({ ...layer,
      strokes: layer.strokes.map(stroke => ({ ...stroke, points: stroke.points.slice(), kit: true, seq: 0 })) }));
    const kept = layers.filter(layer => !layer.backdrop);
    if (kept.length + scenery.length > MAX_LAYERS) {
      $('anim-status').textContent = `That backdrop needs ${scenery.length} layers; a drawing can have ${MAX_LAYERS}.`;
      return;
    }
    pushUndo();
    frames = frames.map(stack => [
      ...scenery.map(layer => newLayer(layer.name, { backdrop: starterId, opacity: layer.opacity ?? 1, strokes: layer.strokes.slice() })),
      ...stack.filter(layer => !layer.backdrop)]);
    layers = frames[frameIndex];
    if (!layers.some(layer => layer.id === activeId)) activeId = layers[layers.length - 1].id;
    recount();
    rebuildOnion();
    rebuildAll();
    renderFrames();
    if (starter) logEvent('artist', 'Backdrop', `the ${starter.name} starter`);
    renderBackdrops();
    renderAnimSubjects();
    renderAnimAssets();
    loadIdeas();
  }
  function renderBackdrops() {
    const current = layers.find(layer => layer.backdrop)?.backdrop || '';
    const choices = [['', 'None'], ...STARTERS.filter(s => s.kind === 'shot' && s.id !== 'bounce').map(s => [s.id, `${s.icon} ${s.name}`])];
    $('anim-backdrops').replaceChildren(...choices.map(([id, label]) => {
      const chip = el('button', 'anim-chip', label);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(id === current));
      chip.addEventListener('click', () => { if (id !== current) setBackdrop(id); });
      return chip;
    }));
  }
  // Casting: with a backdrop, Voyage's multimodal embeddings rank your assets' pictures against words
  // about the place ("things you'd find at the Beach"). Same vector space for text and images: no tags needed.
  const castCache = new Map();
  async function castFor(place) {
    if (!castCache.has(place)) {
      castCache.set(place, api(`/api/assets?q=${encodeURIComponent(`characters and props that belong in a ${place} scene`)}`)
        .then(result => result.items).catch(() => { castCache.delete(place); return []; }));
    }
    return castCache.get(place);
  }
  async function renderAnimAssets() {
    const box = $('anim-assets');
    const place = backdropName();
    $('anim-cast-note').textContent = place ? `\u2726 Voyage AI picked these for the ${place}: it compares your words with your drawings.` : '';
    try {
      const [{ items: latest }, picks] = await Promise.all([api('/api/assets'), place ? castFor(place) : []]);
      const fits = new Set(picks.slice(0, 4).map(item => item.id));
      const items = [...picks.slice(0, 4), ...latest.filter(item => !fits.has(item.id))];
      box.replaceChildren(...(items.length ? items.slice(0, 16).map(item => {
        const button = el('button', `anim-asset${fits.has(item.id) ? ' fits' : ''}`);
        button.type = 'button';
        button.dataset.tip = `${item.name}|${fits.has(item.id) ? `Voyage AI says it fits the ${place}. ` : ''}Drop it into the scene, ready to move.`;
        const image = el('img');
        image.src = item.image_url;
        image.alt = '';
        image.loading = 'lazy';
        button.append(image, el('span', '', item.name));
        button.addEventListener('click', async () => {
          await startPlacing(item);
          animSubjects = new Set([activeId]);
          renderAnimSubjects();
          $('anim-status').textContent = `\u25c6 ${item.name} is in.`;
          $('anim-add').open = false; // the cast is set: the director's pitches are what's next
          loadIdeas();
          $('anim-ideas').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        return button;
      }) : [el('span', 'anim-empty', 'No assets yet. Save a drawing as \u25c6 Asset first.')]));
    } catch (error) {
      box.replaceChildren(el('span', 'anim-empty', error.message));
    }
  }
  function openAnimate() {
    if (busy()) return;
    stopPlay();
    stopMotionPreview();
    animSubjects = defaultSubjects();
    $('anim-status').textContent = '';
    $('anim-add').open = !movable().length;
    renderAnimSubjects();
    renderBackdrops();
    renderAnimAssets();
    $('animate-sheet').showModal();
    loadIdeas();
  }
  function buildAnimate() {
    $('anim-presets').replaceChildren(...PRESETS.map(preset => {
      const button = el('button', 'anim-preset');
      button.type = 'button';
      button.dataset.tip = `${preset.name}|${preset.hint} Free: no AI. ${preset.seconds} s.`;
      button.append(el('span', 'anim-icon', preset.icon), el('span', '', preset.name));
      button.addEventListener('click', () => runPreset(preset));
      return button;
    }));
    document.querySelectorAll('.anim-length [data-seconds]').forEach(button => button.addEventListener('click', () => {
      motionSeconds = Number(button.dataset.seconds);
      document.querySelectorAll('.anim-length [data-seconds]').forEach(b => b.setAttribute('aria-checked', String(b === button)));
      if (ideas.items) renderIdeas(ideas.items);
    }));
  }
  $('animate-open').addEventListener('click', openAnimate);
  $('animate-close').addEventListener('click', () => $('animate-sheet').close());
  $('animate-sheet').addEventListener('click', event => { if (event.target === $('animate-sheet')) $('animate-sheet').close(); });
  $('anim-ai').addEventListener('submit', event => { event.preventDefault(); runAIMotion($('anim-prompt').value.trim()); });
  $('anim-more').addEventListener('click', () => loadIdeas(true));

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
      const { spec, stacks } = motionDraft;
      const note = el('span', 'tray-note', `\ud83c\udfac ${spec.label} \u00b7 ${(stacks.length / MOTION_FPS).toFixed(1)} s, ${stacks.length} frames${spec.strength !== 1 ? ` \u00b7 ${spec.strength}\u00d7` : ''}`);
      tray.replaceChildren(note,
        trayButton('Keep <kbd>\u23ce</kbd>', 'Keep \u00b7 Enter|Becomes real frames: scrub, drag, and redraw any of them.', keepMotion),
        trayButton('Skip <kbd>Esc</kbd>', 'Skip \u00b7 Esc', skipMotion),
        trayButton('\u25c6 How it works', 'How it works|Keyframes, in-betweens, and spacing: the animation, explained on your drawing.', explainScene),
        trayButton('Softer', 'Softer|Same motion, smaller moves. No AI call.', () => restrength(-0.3)),
        trayButton('Bigger', 'Bigger|Same motion, larger moves. No AI call.', () => restrength(0.3)));
      if (spec.by === 'ai') tray.append(trayButton('\u21bb', 'Another take|Asks AI again (one more call).', () => { skipMotion(); openAnimate(); }));
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
      note.textContent = `\u2726 ${ready.result.note || 'Spark ready'}`;
      tray.append(
        note,
        trayButton(`${ready.kind === 'guide' ? 'Pin guide' : ready.kind === 'sketch' ? 'Use sketch' : 'Use it'} <kbd>\u23ce</kbd>`,
          ready.kind === 'sketch' ? 'Use sketch \u00b7 Enter|Adds it as a faint layer under your ink.' : ready.kind === 'guide' ? 'Pin guide \u00b7 Enter' : `Use it \u00b7 Enter|Adds these lines to "${activeLayer().name}".`, acceptSpark),
        trayButton('Skip <kbd>Esc</kbd>', 'Skip \u00b7 Esc', dismissSpark),
        trayButton('\u21bb', 'Try again', retrySpark)
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
      note.textContent = sketching && pending === 1 ? `\u2726 Sketching "${sketching.prompt}" in blue pencil\u2026 keep drawing`
        : `\u2726 AI is on it${pending > 1 ? ` (${pending})` : ''}\u2026 keep drawing`;
      tray.append(note);
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
    } else if (!mod && key === 'n' && !busy()) {
      event.preventDefault();
      addFrame();
    } else if (event.key === ' ' && frames.length > 1 && !event.target.closest?.('button, a, [role="button"]')) {
      event.preventDefault();
      playing ? stopPlay() : play();
    } else if (!mod && (event.key === '[' || event.key === ']')) {
      event.preventDefault();
      setWidth(Number($('width').value) + (event.key === ']' ? 2 : -2));
    } else if (motionDraft && (event.key === 'Enter' || event.key === 'Escape') && !event.target.closest?.('button, a, [role="button"]')) {
      event.preventDefault();
      event.key === 'Enter' ? keepMotion() : skipMotion();
    } else if (!mod && key === 'a' && !busy()) {
      event.preventDefault();
      openAnimate();
    } else if (event.key === 'Enter' && activeSpark() && !event.target.closest?.('button, a, [role="button"]')) {
      // Focused controls (Dismiss, Save, library cards) keep their own Enter behavior.
      event.preventDefault();
      acceptSpark();
    } else if (event.key === 'Escape') {
      if (playing) stopPlay();
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
      message('drawing-status', 'Draw something on a visible layer first, then ask for tags.', true);
      return;
    }
    const button = $('suggest-tags');
    button.disabled = true;
    button.textContent = '\u2726 Suggesting\u2026';
    try {
      const body = JSON.stringify({ title: $('title').value.trim(), description: $('description').value.trim(), layers: docLayers() });
      const data = await postJSON('/api/tags/suggest', body);
      data.tags.forEach(addTag);
      message('drawing-status', 'Suggested tags added. Remove any that do not fit.');
    } catch (error) {
      message('drawing-status', error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = '\u2726 Suggest';
    }
  });

  // ---------------------------------------------------------------- save kinds: idea / asset / shot
  const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
  const TYPE_LABELS = { character: 'Character', prop: 'Prop', environment: 'Background', fx: 'Effect', other: 'Other' };
  const typeLabel = type => TYPE_LABELS[type] || type;
  const STATUS_LABELS = { todo: 'To do', in_progress: 'In progress', review: 'In review', approved: 'Approved' };
  const KIND_TEXT = {
    asset: { label: 'Name', placeholder: 'Red Rocket', save: 'Save asset',
      hint: 'Draw once, reuse anywhere. <i>e.g. a character, a prop, a background.</i>' },
    shot: { label: 'Scene code', placeholder: 'SQ010_0040', save: 'Save scene',
      hint: 'Place assets, draw the rest. <i>e.g. SQ010_0040, the launch.</i>' },
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
    $('title').maxLength = saveKind === 'shot' ? 40 : saveKind === 'asset' ? 80 : 120;
    $('kind-hint').innerHTML = text.hint; // static copy from KIND_TEXT only
    const updating = editing && editing.kind === saveKind;
    $('save-label').textContent = !updating ? text.save
      : saveKind === 'asset' ? `Save as v${editing.version + 1}` : `Update ${editing.code}`;
    $('save-new').hidden = !updating;
    // An animated scene is one tap from a link: unsaved, the button saves first.
    const savedScene = editing && editing.kind === 'shot';
    $('share-open').hidden = !(saveKind === 'shot' && (savedScene || frames.length > 1));
    $('share-open').textContent = savedScene ? '\ud83d\udd17 Share this scene' : '\ud83d\udd17 Save & share';
    const placed = [...new Map(frames.flat().filter(layer => layer.asset).map(layer => [layer.asset.asset_id, layer])).values()];
    $('shot-links').textContent = placed.length
      ? `\u25c6 In this scene: ${placed.map(layer => `${layer.name} v${layer.asset.version}`).join(', ')}`
        + (frames.length > 1 ? ` \u00b7 \ud83c\udf9e ${frames.length} frames at ${fps} fps` : '')
      : 'Tip: open Assets below and tap \u25c6 Place to add one.';
  }
  document.querySelectorAll('.kind-switch button').forEach(b => b.addEventListener('click', () => setSaveKind(b.dataset.kind)));
  $('save-new').addEventListener('click', () => {
    editing = null;
    renderSaveKind();
    $('save-form').requestSubmit();
  });

  function savePayload(name) {
    if (frames.length > 1 && saveKind !== 'shot') throw new Error('Frames are saved with scenes. Choose \u25a3 Scene, or delete the extra frames.');
    const base = { description: $('description').value.trim(), layers: docStack(frames[0]), tags };
    if (saveKind === 'idea') return { path: '/api/drawings', method: 'POST', body: { title: name, ...base } };
    const updating = editing && editing.kind === saveKind;
    const history = pendingEvents();
    if (saveKind === 'asset') {
      if (layers.some(layer => layer.asset)) throw new Error('This has placed assets in it, so save it as a Scene.');
      return { path: updating ? `/api/assets/${editing.id}` : '/api/assets', method: updating ? 'PUT' : 'POST', history,
        body: { name, type: $('asset-type').value, ...base, history, ...(pendingOrigin && !updating ? { origin: pendingOrigin } : {}) } };
    }
    const project = $('shot-project').value.trim() || 'demo';
    // Studios name shots SEQ_SHOT (SQ070_0010), so a blank sequence comes from the code.
    let sequence = $('shot-sequence').value.trim();
    if (!sequence && /^[A-Za-z0-9.-]+_/.test(name)) $('shot-sequence').value = sequence = name.split('_')[0];
    for (const [label, value] of [['Scene code', name], ['Project', project], ['Sequence', sequence]]) {
      if (!CODE.test(value)) throw new Error(`${label}: letters, numbers, _ . or - only (no spaces). e.g. SQ010_0040`);
    }
    return { path: updating ? `/api/shots/${editing.id}` : '/api/shots', method: updating ? 'PUT' : 'POST', history,
      body: { code: name, project, sequence, status: $('shot-status').value, assignee: $('shot-assignee').value.trim(), ...base,
        frames: frames.slice(1).map(stack => ({ layers: compactStack(stack, frames[0]) })), fps, history,
        ...(sceneMotion && frames.length > 1 ? { motion: sceneMotion } : {}) } };
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

  $('save-form').addEventListener('submit', async event => {
    event.preventDefault();
    const wantShare = shareAfterSave; // one-shot: any early return below drops it
    shareAfterSave = false;
    const name = $('title').value.trim();
    if (!name) {
      message('drawing-status', `Add a ${KIND_TEXT[saveKind].label.toLowerCase()} before saving.`, true);
      $('title').focus();
      return;
    }
    if (!hasInk(frames[0]) || busy()) {
      message('drawing-status', frames.length > 1 ? 'Frame 1 needs some ink on a visible layer before saving.'
        : 'Draw something on a visible layer before saving.', true);
      return;
    }
    if ($('tag-input').value.trim() && addTag($('tag-input').value)) $('tag-input').value = '';
    let request;
    try {
      request = savePayload(name);
    } catch (error) {
      message('drawing-status', error.message, true);
      return;
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
    message('drawing-status', kind === 'shot' ? 'Saving the scene. Voyage indexes each layer...'
      : tags.length ? 'Saving. Voyage embeds it into Atlas...' : 'Saving. AI tags it, Voyage embeds it into Atlas...');
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
      }
      const note = saved.tags_status === 'auto' ? ` Auto-tagged: ${saved.tags.join(', ')}.`
        : saved.tags_status === 'unavailable' ? ' Auto-tags were unavailable this time.' : '';
      if (kind === 'asset') {
        editing = { kind, id: saved.id, version: saved.version };
        markGuide('asset');
        if (pendingVary) {
          const goal = pendingVary;
          pendingVary = null;
          openVariations({ ...saved, type: saved.type || $('asset-type').value, tags: saved.tags || tags }, goal);
        }
        message('drawing-status', `Saved "${saved.name}" v${saved.version}.${note} Next:`, false, [
          { label: '\ud83c\udf9e Animate it', tip: 'Animate it|Opens a fresh scene with this asset placed. Then add frames and move what moves.', run: () => startShotWith(saved) },
          { label: '\u2726 Make variations', tip: 'Variations|Lookalikes for a crowd or a battle, made by editing your strokes.', run: () => openVariations(saved) },
          { label: 'Where is it used?', run: () => openWhereUsed(saved) }
        ]);
      } else if (kind === 'shot') {
        editing = { kind, id: saved.id, code: saved.code };
        if (saved.assets?.length) markGuide('shot');
        if (wantShare) setTimeout(openShare);
        const first = saved.assets?.[0];
        message('drawing-status', `Saved ${saved.code}.${note} ${saved.assets?.length ? `Now findable from ${saved.assets.map(a => `"${a.name}"`).join(', ')}.` : 'Tip: place an asset in it, so the asset can find this scene.'}`, false,
          frames.length > 1 ? [{ label: '\ud83d\udd17 Share it', tip: 'Share|A public link: your scene as a looping GIF, with how it moves explained.', run: () => openShare() }]
            : first ? [{ label: `Where else is "${first.name}" used?`, run: () => openWhereUsed({ id: first.id, name: first.name }) }]
            : [{ label: '\u25c6 Place an asset', tip: 'Place an asset|Opens Assets. Tap Place, then drag a box on the canvas.', run: () => goPlace() }]);
      } else {
        message('drawing-status', `Idea saved.${note} Find it later by describing it.`, false, [
          { label: '\u25c6 Make it an asset', tip: 'Make it an asset|Assets can be placed in scenes, and always know where they\'re used.', run: () => { setSaveKind('asset'); $('save-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('title').focus({ preventScroll: true }); } }
        ]);
      }
      renderSaveKind();
      await Promise.all([loadGallery(currentQuery), loadTags()]);
    } catch (error) {
      message('drawing-status', `${error.message} Your work is still on the canvas.`, true);
    } finally {
      $('save').disabled = false;
    }
  });

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
        visible: layer.visible, opacity: layer.opacity, strokes: layer.strokes, asset: layer.asset || null,
        ...(layer.xf ? { xf: layer.xf, xfBase: layer.xfBase, xfStrokes: layer.xfStrokes } : {})
      })));
      sceneMotion = record.motion || null;
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
      renderSaveKind();
      message('drawing-status', note);
      canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
      message('drawing-status', error.message, true);
    }
  }
  const layerCount = () => `${layers.length} layer${layers.length === 1 ? '' : 's'}`;
  const openDrawing = id => openRecord(`/api/drawings/${encodeURIComponent(id)}`, record => {
    editing = null;
    saveKind = 'idea';
    $('title').value = record.title;
    return `Opened with ${layerCount()}. Edit freely; saving creates a new copy.`;
  });
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
    const animated = frames.length > 1 ? ` and ${frames.length} frames (press Space to play)` : '';
    return `Editing scene ${record.code} with ${layerCount()}${animated}. Saving updates it in place.`;
  });

  // ---------------------------------------------------------------- library tabs
  const TAB_TEXT = {
    asset: { placeholder: 'Describe it, e.g. "the red rocket"', noun: 'assets' },
    frame: { placeholder: 'Describe a moment, e.g. "the rocket high above the trees"', noun: 'frames' },
    shot: { placeholder: 'Describe it, e.g. "a rocket over the city"', noun: 'scenes' },
    idea: { placeholder: 'Describe it, e.g. "a friendly green character"', noun: 'ideas' }
  };
  let libraryTab = 'asset';
  let shotStatus = '';
  function setLibraryTab(tab) {
    libraryTab = tab;
    document.querySelectorAll('.library-tabs [role="tab"]').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
    $('tag-filters').hidden = tab !== 'idea';
    $('status-filters').hidden = tab !== 'shot' && tab !== 'frame';
    $('frame-filters').hidden = tab !== 'frame';
    $('asset-filters').hidden = tab !== 'asset';
    if (tab === 'frame') loadFrameAssets();
    $('query').placeholder = TAB_TEXT[tab].placeholder;
    $('query').value = '';
    loadGallery();
  }
  document.querySelectorAll('.library-tabs [role="tab"]').forEach(t => t.addEventListener('click', () => setLibraryTab(t.dataset.tab)));

  function renderStatusFilters() {
    const options = [['', 'All'], ['open', 'Not approved'], ...Object.entries(STATUS_LABELS)];
    $('status-filters').replaceChildren(...options.map(([value, label]) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'filter-chip';
      chip.textContent = label;
      chip.setAttribute('aria-pressed', String(value === shotStatus));
      chip.addEventListener('click', () => { shotStatus = value; renderStatusFilters(); loadGallery(currentQuery); });
      return chip;
    }));
  }

  async function loadTags() {
    try {
      const data = await api('/api/tags');
      if (activeTag && !data.items.some(item => item.tag === activeTag)) data.items.unshift({ tag: activeTag, count: 0 });
      $('tag-filters').replaceChildren(...data.items.map(({ tag, count }) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'filter-chip';
        chip.setAttribute('aria-pressed', String(tag === activeTag));
        chip.textContent = `#${tag}`;
        const badge = document.createElement('span');
        badge.textContent = count;
        chip.append(badge);
        chip.addEventListener('click', () => {
          activeTag = activeTag === tag ? null : tag;
          loadTags();
          loadGallery(currentQuery);
        });
        return chip;
      }));
    } catch {
      $('tag-filters').replaceChildren();
    }
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
  function ideaCard(item, query) {
    const card = el('button', 'card');
    card.type = 'button';
    card.setAttribute('aria-label', `Open ${item.title}`);
    const image = el('img');
    image.src = item.image_url;
    image.alt = item.title;
    image.loading = 'lazy';
    const text = el('span', 'card-text');
    text.append(el('strong', '', item.title),
      el('small', '', (item.tags || []).slice(0, 4).map(tag => `#${tag}`).join(' ') || (query ? 'Semantic match' : 'Saved idea')));
    card.append(image, text);
    card.addEventListener('click', () => openDrawing(item.id));
    return card;
  }
  function assetCard(item) {
    const card = el('div', 'card asset-card');
    const text = el('span', 'card-text');
    text.append(el('strong', '', item.name),
      el('small', '', `${typeLabel(item.type)} \u00b7 v${item.version} \u00b7 in ${item.uses ?? 0} scene${item.uses === 1 ? '' : 's'}`));
    const actions = el('div', 'card-actions');
    const place = el('button', 'mini primary-mini', '\u25c6 Place');
    place.type = 'button';
    place.dataset.tip = 'Place in a scene|Drops it onto the canvas, ready to drag (or drag its picture onto the canvas). It stays linked, so it always knows where it\'s used.';
    place.addEventListener('click', () => startPlacing(item));
    const where = el('button', 'mini where-mini', 'Where used?');
    where.type = 'button';
    where.dataset.tip = 'Where is it used?|Every scene using it, which are outdated, and look-alikes.';
    where.addEventListener('click', () => openWhereUsed(item));
    const edit = el('button', 'mini', 'Edit');
    edit.type = 'button';
    edit.dataset.tip = 'Edit|Opens it on the canvas. Saving makes a new version; scenes using older ones get flagged.';
    edit.addEventListener('click', () => openAsset(item.id));
    const vary = el('button', 'mini ai-mini', '\u2726 Variations');
    vary.type = 'button';
    vary.dataset.tip = 'Variations|Need 9 of these for a battle? Plan lookalikes, AI edits your strokes, you keep and finish them.';
    vary.addEventListener('click', () => openVariations(item));
    if (item.origin) text.append(el('small', 'lineage', `\u2726 variant of ${item.origin.name}`));
    if (item.stats) {
      const made = el('small', 'made-line');
      made.dataset.tip = `Art math|${plural(item.stats.strokes, 'stroke')}, ${shortNumber(item.stats.ink_px || 0)} px of line, ${duration(item.stats.draw_ms || 0)} with the pencil down.`;
      made.append(`\u270d ${Math.round(item.stats.hand_share * 100)}% hand`);
      for (const color of (item.stats.palette || []).slice(0, 5)) {
        const dot = el('span', 'mini-dot');
        dot.style.background = color;
        made.append(dot);
      }
      text.append(made);
    }
    actions.append(place, where, vary, edit);
    const thumb = thumbButton(item, `Edit asset ${item.name}`, () => openAsset(item.id));
    thumb.draggable = true;
    thumb.addEventListener('dragstart', event => {
      event.dataTransfer.setData('application/x-inkling-asset', JSON.stringify({ id: item.id, name: item.name }));
      event.dataTransfer.effectAllowed = 'copy';
    });
    card.append(thumb, text, actions);
    return card;
  }
  function statusSelect(item, onChanged) {
    const select = el('select', `status-select status-${item.status}`);
    select.setAttribute('aria-label', `Status of ${item.code}`);
    select.dataset.tip = 'Status|Change it right here. Only the label changes; nothing is re-processed.';
    for (const [value, label] of Object.entries(STATUS_LABELS)) {
      const option = el('option', '', label);
      option.value = value;
      select.append(option);
    }
    select.value = item.status;
    select.addEventListener('change', async () => {
      const previous = item.status;
      select.disabled = true;
      try {
        const updated = await api(`/api/shots/${encodeURIComponent(item.id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: select.value })
        });
        item.status = updated.status;
        select.className = `status-select status-${updated.status}`;
        message('library-status', `${updated.code} is now ${STATUS_LABELS[updated.status]}. Metadata only: nothing was re-embedded.`);
        onChanged?.(updated);
      } catch (error) {
        select.value = previous;
        message('library-status', error.message, true);
      } finally {
        select.disabled = false;
      }
    });
    return select;
  }
  function shotCard(item) {
    const card = el('div', 'card shot-card');
    const text = el('span', 'card-text');
    text.append(el('strong', '', item.code), el('small', '', `${item.project} / ${item.sequence} \u00b7 ${item.assignee || 'unassigned'}`));
    if (item.assets?.length) text.append(el('small', 'placed-assets', item.assets.map(a => `\u25c6 ${a.name} v${a.version}`).join('  ')));
    if (item.frames > 1) text.append(el('small', 'frames-note', `\ud83c\udf9e ${item.frames} frames \u00b7 ${item.fps} fps`));
    const actions = el('div', 'card-actions');
    const breakdown = el('button', 'mini', '\ud83d\udd0d Breakdown');
    breakdown.type = 'button';
    breakdown.dataset.tip = 'Breakdown|Frame by frame, layer by layer, asset by asset, and the history of how it got here.';
    breakdown.addEventListener('click', () => breakdownOfShot(item.id));
    actions.append(statusSelect(item, updated => {
      // Keep an open editor in sync, or its next Update would put the old status back.
      if (editing?.kind === 'shot' && editing.id === updated.id) {
        $('shot-status').value = updated.status;
        $('shot-assignee').value = updated.assignee || '';
      }
    }), breakdown);
    card.append(thumbButton(item, `Open scene ${item.code}`, () => openShot(item.id)), text, actions);
    return card;
  }

  // Frame hits come grouped by scene: neighbouring frames of one flipbook look alike, so the best frame
  // leads and the other matching frames are one tap away.
  function groupFrames(items) {
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.shot_id)) groups.set(item.shot_id, []);
      groups.get(item.shot_id).push(item);
    }
    return [...groups.values()];
  }
  function frameGroupCard(group) {
    const best = group[0];
    const card = el('div', 'card frame-card');
    const thumb = thumbButton(best, `Open ${best.code} at frame ${best.frame}`, () => openShotAt(best.shot_id, best.frame));
    thumb.append(el('span', 'frame-badge', best.frames > 1 ? `\ud83c\udf9e ${best.frame} / ${best.frames}` : 'still'));
    const text = el('span', 'card-text');
    text.append(el('strong', '', best.code), el('small', '', `${best.project} / ${best.sequence} \u00b7 ${STATUS_LABELS[best.status] || best.status}`));
    if (best.assets?.length) text.append(el('small', 'placed-assets', best.assets.map(a => `\u25c6 ${a.name}`).join('  ')));
    if (group.length > 1) {
      const chips = el('span', 'frame-chips');
      chips.append(el('small', '', 'Frames'));
      for (const item of [...group].sort((a, b) => a.frame - b.frame)) {
        const chip = actionButton(String(item.frame), item === best ? 'frame-chip best' : 'frame-chip',
          `Frame ${item.frame}${item.score != null ? `|Similarity ${item.score.toFixed(3)}` : ''}`, () => openShotAt(item.shot_id, item.frame));
        chip.setAttribute('aria-label', `Open frame ${item.frame}`);
        chips.append(chip);
      }
      text.append(chips);
    }
    const actions = el('div', 'card-actions');
    actions.append(actionButton(`Open frame ${best.frame}`, 'primary-mini', 'Open it|Opens the scene on the canvas at this frame, ready to tweak.', () => openShotAt(best.shot_id, best.frame)),
      actionButton('\ud83d\udd0d Breakdown', '', null, () => breakdownOfShot(best.shot_id)));
    card.append(thumb, text, actions);
    return card;
  }
  function renderResults(tab, items, { query = '', filterText = '', sketch = false } = {}) {
    // Browsing (no query): each scene leads with frame 1; searching: with its best match.
    const ranked = query || sketch;
    const cards = tab === 'frame' ? groupFrames(items).map(group => frameGroupCard(ranked ? group : group.sort((x, y) => x.frame - y.frame)))
      : items.map(item => tab === 'idea' ? ideaCard(item, query) : tab === 'asset' ? assetCard(item) : shotCard(item));
    cards.forEach((card, i) => card.style.setProperty('--i', Math.min(i, 12)));
    if (!cards.length) {
      cards.push(el('div', 'empty', query || sketch || filterText ? 'No matches. Try other words or another sketch, or give new saves a moment.'
        : tab === 'asset' ? 'No assets yet. Draw something (or ask AI to sketch a start) and save it as an Asset.'
        : tab === 'shot' ? 'No scenes yet. \u25c6 Place an asset, draw the rest, save as Scene.'
        : tab === 'frame' ? 'No frames yet. Save a scene; add frames with \ud83c\udf9e to animate it.'
        : 'No ideas yet. Save loose sketches here and find them by describing them.'));
    }
    $('results').replaceChildren(...cards);
    if ((query || sketch) && items.length) markGuide('where');
    const what = tab === 'frame' ? `${items.length} frame${items.length === 1 ? '' : 's'} in ${cards.length} scene${cards.length === 1 ? '' : 's'}` : null;
    const matches = what || `${items.length} match${items.length === 1 ? '' : 'es'}`;
    message('library-status', sketch ? `${matches} for your drawing, most similar first.`
      : query ? `${matches}${filterText}, most similar first (Voyage AI).`
      : `${what || `${items.length} ${TAB_TEXT[tab].noun}`}${filterText}.`);
  }
  let frameAsset = '';
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
  async function loadGallery(query = '') {
    currentQuery = query;
    galleryRequest?.abort();
    const controller = new AbortController();
    galleryRequest = controller;
    const tab = libraryTab;
    const params = new URLSearchParams();
    let url;
    if (tab === 'idea') {
      if (activeTag) params.set('tag', activeTag);
      if (query) params.set('q', query);
      url = query ? `/api/search?${params}` : `/api/drawings?${params}`;
    } else {
      if (query) params.set('q', query);
      if ((tab === 'shot' || tab === 'frame') && shotStatus) params.set('status', shotStatus);
      if (tab === 'frame' && frameAsset) params.set('asset_id', frameAsset);
      if (tab === 'asset' && handOnly) params.set('hand_min', '0.8');
      if (tab === 'asset' && assetColor) params.set('color', assetColor);
      url = `/api/${tab}s?${params}`;
    }
    const assetName = tab === 'frame' && frameAsset ? $('frame-asset').selectedOptions[0]?.textContent : '';
    const filterText = (tab === 'idea' && activeTag ? ` tagged #${activeTag}` : '')
      + ((tab === 'shot' || tab === 'frame') && shotStatus ? ` (${shotStatus === 'open' ? 'not approved' : STATUS_LABELS[shotStatus]})` : '')
      + (assetName ? ` with ${assetName}` : '')
      + (tab === 'asset' && handOnly ? ', mostly by hand' : '') + (tab === 'asset' && assetColor ? `, with ${assetColor}` : '');
    message('library-status', query ? `Looking for ${TAB_TEXT[tab].noun}${filterText} with Voyage AI...` : `Opening your ${TAB_TEXT[tab].noun}...`);
    try {
      const data = await api(url, { signal: controller.signal });
      if (controller.signal.aborted) return;
      renderResults(tab, data.items, { query, filterText });
    } catch (error) {
      if (error.name !== 'AbortError') {
        $('results').replaceChildren();
        message('library-status', error.message, true);
      }
    }
  }
  async function searchBySketch() {
    if (!hasInk()) {
      message('library-status', 'Draw something on the canvas first: a quick doodle is enough. It becomes the search.', true);
      canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    galleryRequest?.abort();
    const controller = new AbortController();
    galleryRequest = controller;
    const tab = libraryTab;
    $('query').value = '';
    currentQuery = '';
    message('library-status', `Looking for ${TAB_TEXT[tab].noun} that look like your drawing...`);
    try {
      const data = await api('/api/search/sketch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: tab, layers: docLayers() }), signal: controller.signal });
      if (controller.signal.aborted) return;
      renderResults(tab, data.items, { sketch: true });
    } catch (error) {
      if (error.name !== 'AbortError') message('library-status', error.message, true);
    }
  }
  $('search-sketch').addEventListener('click', searchBySketch);
  async function loadFrameAssets() {
    try {
      const data = await api('/api/assets');
      const keep = frameAsset;
      $('frame-asset').replaceChildren(el('option', '', 'any asset'), ...data.items.map(item => {
        const option = el('option', '', `\u25c6 ${item.name}`);
        option.value = item.id;
        return option;
      }));
      $('frame-asset').firstElementChild.value = '';
      $('frame-asset').value = keep;
    } catch { /* the filter is optional */ }
  }
  $('frame-asset').addEventListener('change', () => { frameAsset = $('frame-asset').value; loadGallery(currentQuery); });
  async function openShotAt(id, frame) {
    await openShot(id);
    if (editing?.kind === 'shot' && editing.id === id && frame > 1) {
      goFrame(frame - 1);
      message('drawing-status', `Frame ${frame} of ${frames.length} in ${editing.code}. Tweak it, then Update. Space plays it.`);
    }
  }
  $('search-form').addEventListener('submit', event => {
    event.preventDefault();
    const query = $('query').value.trim();
    if (query) loadGallery(query);
  });
  $('browse').addEventListener('click', () => {
    $('query').value = '';
    activeTag = null;
    shotStatus = '';
    renderStatusFilters();
    loadTags();
    loadGallery();
  });

  // ---------------------------------------------------------------- where used
  let whereAsset = null;
  let whereRequest = null;
  let whereOutdated = [];
  function openWhereUsed(item) {
    whereAsset = item;
    $('wu-title').textContent = item.name;
    $('wu-sub').textContent = item.type ? `${typeLabel(item.type)} \u00b7 latest v${item.version}` : '';
    $('wu-thumb').src = item.image_url || `/api/assets/${encodeURIComponent(item.id)}/image`;
    document.querySelectorAll('.wu-name').forEach(node => { node.textContent = item.name; });
    $('wu-vary').onclick = () => { $('where-used').close(); openVariations(whereAsset); };
    $('wu-breakdown').onclick = () => { $('where-used').close(); breakdownOfAsset(whereAsset.id); };
    if (!$('where-used').open) $('where-used').showModal();
    markGuide('where');
    runWhereUsed();
  }
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
    const title = el('strong', '', `${entry.code} `);
    title.append(el('span', `status-pill status-${entry.status}`, STATUS_LABELS[entry.status] || entry.status));
    text.append(title, el('small', '', `${entry.project} / ${entry.sequence} \u00b7 ${entry.assignee || 'unassigned'}`));
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
    figure.setAttribute('aria-label', `Where is ${item.name} used?`);
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
      actionButton('Where used?', 'where-mini', `Switch to ${item.name}|Shows where this one is used instead.`, go),
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
  function summaryChip(icon, count, label, tone, tip) {
    const chip = el('span', `summary-chip ${tone}`);
    chip.dataset.tip = tip;
    chip.append(el('b', '', `${icon} ${count}`), el('span', '', label));
    return chip;
  }
  async function runWhereUsed() {
    if (!whereAsset) return;
    for (const id of ['wu-project', 'wu-sequence']) {
      if (!$(id).checkValidity()) {
        message('wu-status-line', 'Project and sequence use letters, numbers, _ . or - only.', true);
        return;
      }
    }
    const params = new URLSearchParams();
    if ($('wu-status').value) params.set('status', $('wu-status').value);
    if ($('wu-project').value.trim()) params.set('project', $('wu-project').value.trim());
    if ($('wu-sequence').value.trim()) params.set('sequence', $('wu-sequence').value.trim());
    whereRequest?.abort();
    const controller = new AbortController();
    whereRequest = controller;
    message('wu-status-line', 'Checking links. Voyage compares pictures across your scenes...');
    $('wu-summary').replaceChildren();
    $('wu-linked').replaceChildren();
    $('wu-similar').replaceChildren();
    $('wu-assets').replaceChildren();
    $('wu-family').replaceChildren();
    try {
      const data = await api(`/api/assets/${encodeURIComponent(whereAsset.id)}/where-used?${params}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      whereAsset = { ...whereAsset, ...data.asset };
      $('wu-thumb').src = data.asset.image_url;
      $('wu-sub').textContent = `${typeLabel(data.asset.type)} \u00b7 latest v${data.asset.version}`;
      whereOutdated = data.linked.filter(entry => entry.outdated);
      const scope = $('wu-status').value === 'open' ? 'Scenes not approved yet.' : $('wu-status').value ? `Scenes marked ${STATUS_LABELS[$('wu-status').value]}.` : 'All scenes.';
      const empty = (text, hint) => { const box = el('div', 'wu-empty'); box.append(el('b', '', text), el('span', '', hint)); return box; };
      const twins = data.similar_assets || [];
      const family = data.family || { parent: null, variants: [] };
      const kin = [...(family.parent ? [{ ...family.parent, relation: `Original \u00b7 varied from v${family.parent.from_version}` }] : []),
        ...family.variants.map(v => ({ ...v, relation: `Variant: ${v.origin?.brief || ''}` })),
        ...(family.siblings || []).map(v => ({ ...v, relation: `Sibling: ${v.origin?.brief || ''}` }))];
      $('wu-family').replaceChildren(...(kin.length ? kin.map((item, i) => familyCard(item, i))
        : [empty('No variations yet.', 'Tap \u2726 Make variations to plan lookalikes from it.')]));
      $('wu-family-count').textContent = `(${kin.length})`;
      $('wu-linked').replaceChildren(...(data.linked.length ? data.linked.map(whereCard)
        : [empty('Not placed in a scene yet.', `Tap \u25c6 Place on ${data.asset.name} in Assets.`)]));
      $('wu-similar').replaceChildren(...(data.similar.length ? data.similar.map(whereCard)
        : [empty('No look-alikes.', 'Nothing unlinked looks like it. Nice and tidy.')]));
      $('wu-assets').replaceChildren(...(twins.length ? twins.map(similarAssetCard)
        : [empty('No similar assets.', 'It\'s one of a kind in your library.')]));
      [...$('wu-linked').children, ...$('wu-similar').children].forEach((card, i) => card.style.setProperty('--i', i));
      $('wu-linked-count').textContent = `(${data.linked.length})`;
      $('wu-similar-count').textContent = `(${data.similar.length})`;
      $('wu-assets-count').textContent = `(${twins.length})`;
      $('wu-summary').replaceChildren(
        summaryChip('\ud83d\udd17', data.linked.length, data.linked.length === 1 ? 'scene' : 'scenes', 'linked', 'Used in|Scenes where you placed this asset.'),
        summaryChip('\u26a0', whereOutdated.length, 'outdated', whereOutdated.length ? 'warn' : 'ok', 'Outdated|Scenes still showing an older version.'),
        summaryChip('\ud83d\udc40', data.similar.length, data.similar.length === 1 ? 'look-alike' : 'look-alikes', 'similar', 'Look-alikes|Scenes with something that looks like it, but not linked.'),
        summaryChip('\ud83e\uddec', twins.length, twins.length === 1 ? 'similar asset' : 'similar assets', 'assets', 'Similar assets|Other assets in your library that look like it.'),
        summaryChip('\ud83c\udf31', kin.length, kin.length === 1 ? 'relative' : 'relatives', 'family', 'Family|Its original and its variations: exact lineage, not a guess.'));
      [...$('wu-summary').children].forEach((chip, i) => chip.style.setProperty('--i', i));
      $('wu-update-all').hidden = whereOutdated.length < 2;
      $('wu-update-all').textContent = `Update all ${whereOutdated.length} to v${data.asset.version}`;
      $('wu-update-all').dataset.tip = `Update all|Swaps v${data.asset.version} into every outdated scene. Old drawings stay as hidden backup layers.`;
      message('wu-status-line', `${scope} Brand-new saves take a moment to show up.`);
    } catch (error) {
      if (error.name !== 'AbortError') message('wu-status-line', error.message, true);
    }
  }
  async function syncShots(entries) {
    const asset = whereAsset;
    message('wu-status-line', `Updating ${entries.length} scene${entries.length === 1 ? '' : 's'} to v${asset.version}...`);
    let done = 0;
    try {
      for (const entry of entries) {
        await api(`/api/shots/${encodeURIComponent(entry.shot_id)}/sync/${encodeURIComponent(asset.id)}`, { method: 'POST' });
        done++;
      }
      await runWhereUsed();
      message('wu-status-line', `Updated ${done} scene${done === 1 ? '' : 's'} to v${asset.version}. Old drawings stay as hidden backup layers.`);
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
      message('wu-status-line', `${entry.code} now links to ${whereAsset.name}. The drawing didn't change.`);
    } catch (error) {
      message('wu-status-line', error.message, true);
    }
  }
  $('wu-filters').addEventListener('submit', event => { event.preventDefault(); runWhereUsed(); });
  $('wu-status').addEventListener('change', runWhereUsed);
  $('wu-close').addEventListener('click', () => $('where-used').close());
  for (const id of ['where-used', 'help']) {
    $(id).addEventListener('click', event => { if (event.target === $(id)) $(id).close(); });
  }

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
      markGuide('vary');
      message('var-status', `Kept "${item.saved.name}". It's in your library, linked to ${varAsset.name}.`);
      if (libraryTab === 'asset') loadGallery(currentQuery);
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
  function loadCanvas(stack, { kind, title = '', note, more = [], fps: speed = null, scroll = true }) {
    stopPlay();
    frames = [stack, ...more];
    sceneMotion = null;
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
    message('drawing-status', note);
    if (scroll) canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      markGuide('share');
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
    const counts = { hand: 0, ai: 0, kit: 0, placed: 0, placedAi: 0 };
    const seen = new Set();
    for (const layer of stacks.flat()) {
      // Hidden guides and backups don't count; nor do posed copies of frame 1 (moved, not drawn).
      if (!layer.visible || layer.xf) continue;
      for (const stroke of layer.strokes) {
        if (stroke.erase || seen.has(stroke)) continue;
        seen.add(stroke);
        counts[layer.asset ? 'placed' : stroke.ai ? 'ai' : stroke.kit ? 'kit' : 'hand']++;
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
  async function breakdownOfShot(id) {
    try {
      const record = await api(`/api/shots/${encodeURIComponent(id)}`);
      openBreakdown({
        title: record.code, sub: `${record.project} / ${record.sequence} \u00b7 ${STATUS_LABELS[record.status]}`,
        stacks: expandRecord(record), fps: record.fps, history: record.history, motion: record.motion,
        assetNames: Object.fromEntries((record.assets || []).map(a => [a.id, a.name]))
      });
    } catch (error) {
      message('library-status', error.message, true);
    }
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
    const kind = starter.kind || (saveKind === 'idea' ? 'idea' : 'asset');
    loadCanvas(first, {
      kind, more, fps: starter.fps, scroll: false,
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
    $('starter-list').replaceChildren(...STARTERS.filter(s => s.id !== 'blank').map(s => starterButton(s)));
    $('starters-grid').replaceChildren(...STARTERS.map(s => starterButton(s, true)));
  }
  $('starters-open').addEventListener('click', () => { $('starters-sheet').showModal(); });
  $('starters-close').addEventListener('click', () => $('starters-sheet').close());
  $('starters-sheet').addEventListener('click', event => { if (event.target === $('starters-sheet')) $('starters-sheet').close(); });
  $('starter-skip').addEventListener('click', () => { startersDismissed = true; renderStarters(); });

  // ---------------------------------------------------------------- the natural flow: next steps, guide, help
  function startShotWith(asset) {
    clearCanvas();
    setSaveKind('shot');
    $('title').value = '';
    startPlacing(asset);
  }
  function goPlace() {
    setLibraryTab('asset');
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    pulse('.asset-card .primary-mini');
  }
  function pulse(selector) {
    // A gentle "look here" on the control the guide is talking about.
    setTimeout(() => document.querySelectorAll(selector).forEach(node => {
      node.classList.remove('pulse');
      void node.offsetWidth;
      node.classList.add('pulse');
    }), 450);
  }
  const GUIDE_KEY = 'inkling.guide.v1';
  const guide = (() => {
    try { return { done: {}, hidden: false, ...JSON.parse(localStorage.getItem(GUIDE_KEY) || '{}') }; } catch { return { done: {}, hidden: false }; }
  })();
  const GUIDE_STEPS = [
    { id: 'draw', title: 'Draw it', detail: 'A character, a prop, or a backdrop, in layers. Stuck? Ask AI for a blue-pencil start.',
      show: () => { canvas.scrollIntoView({ behavior: 'smooth', block: 'center' }); setAiMode('sketch'); pulse('#ai-bar .ai-input'); flashTray('Draw here, or type in Ask AI below for a blue-pencil start.'); } },
    { id: 'asset', title: 'Save it as an asset', detail: 'Draw once, reuse it in every scene. e.g. "Red Rocket".',
      show: () => { setSaveKind('asset'); $('save-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('title').focus({ preventScroll: true }); pulse('.kind-switch [data-kind="asset"]'); } },
    { id: 'where', title: 'Find it', detail: 'Describe it or sketch it: Voyage AI matches words and drawings.',
      show: () => { setLibraryTab('asset'); $('results').scrollIntoView({ behavior: 'smooth', block: 'start' }); pulse('#query'); } },
    { id: 'animate', title: 'Animate it', detail: 'Tap \ud83c\udfac Animate: the AI director pitches a 10-second scene. Every frame stays yours.',
      show: () => openAnimate() },
    { id: 'share', title: 'Share it', detail: 'Save the scene, then send a link: a looping GIF with how it moves, explained.',
      show: () => { setSaveKind('shot'); $('save-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); pulse('#share-open:not([hidden]), .kind-switch [data-kind="shot"]'); } }
  ];
  let prefsTimer = null;
  function saveGuide() {
    try { localStorage.setItem(GUIDE_KEY, JSON.stringify(guide)); } catch { /* private mode: the guide just won't persist */ }
    // Progress follows the member across devices: a private m-stash record of theirs.
    if (!account) return;
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => api('/api/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guide: Object.keys(guide.done).filter(id => guide.done[id]).slice(0, 12) }) }).catch(() => {}), 800);
  }
  function markGuide(id) {
    if (guide.done[id]) return;
    guide.done[id] = true;
    saveGuide();
    renderGuide();
  }
  function renderGuide() {
    const next = GUIDE_STEPS.find(step => !guide.done[step.id]);
    const count = GUIDE_STEPS.filter(step => guide.done[step.id]).length;
    // Once every step is done the guide steps aside, so the canvas sits higher (Help brings it back).
    $('guide').hidden = guide.hidden || (count === GUIDE_STEPS.length && !guide.reopened);
    if ($('guide').hidden) return;
    $('guide-count').textContent = count === GUIDE_STEPS.length ? 'You\'ve got it \u2728' : `${count} of ${GUIDE_STEPS.length}`;
    $('guide-steps').replaceChildren(...GUIDE_STEPS.map((step, index) => {
      const done = !!guide.done[step.id];
      const item = el('li', `guide-step${done ? ' done' : ''}${step === next ? ' next' : ''}`);
      item.append(el('span', 'guide-num', done ? '\u2714' : String(index + 1)));
      const body = el('div', 'guide-body');
      body.append(el('b', '', step.title), el('span', '', step.detail));
      item.append(body);
      if (!done) {
        const show = el('button', step === next ? 'mini primary-mini' : 'mini', 'Show me');
        show.type = 'button';
        show.addEventListener('click', step.show);
        item.append(show);
      }
      return item;
    }));
  }
  $('guide-hide').addEventListener('click', () => { guide.hidden = true; saveGuide(); renderGuide(); });
  $('help-open').addEventListener('click', () => $('help').showModal());
  $('help-close').addEventListener('click', () => $('help').close());
  $('help-guide').addEventListener('click', () => {
    guide.hidden = false;
    guide.reopened = true;
    saveGuide();
    renderGuide();
    $('help').close();
    $('guide').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
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
  async function syncGuideWithLibrary() {
    // Returning artists shouldn't be told to do what they've already done.
    try {
      const assets = await api('/api/assets');
      if (assets.items.length) { guide.done.draw = true; guide.done.asset = true; }
      const frames = await api('/api/frames');
      if (frames.items.some(frame => frame.frames > 1)) guide.done.animate = true;
      saveGuide();
    } catch { /* the guide still works from local progress */ }
    renderGuide();
  }

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
    $('account-counts').textContent = `${plural(lib.assets || 0, 'asset')} \u00b7 ${plural(lib.scenes || 0, 'scene')} \u00b7 ${plural(lib.ideas || 0, 'idea')}`;
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
    // Progress lives in the member's m-stash record; don't hand it to whoever signs in next on this device.
    try { localStorage.removeItem(GUIDE_KEY); } catch { /* fine */ }
    savedRevision = revision; // the confirm above already asked
    location.reload();
  });
  async function signedIn(me, fresh = false) {
    account = me;
    if ($('gate').open) $('gate').close();
    renderAccount();
    loadGallery();
    loadTags();
    syncGuideWithLibrary();
    api('/api/prefs').then(prefs => {
      if (!Array.isArray(prefs.guide)) return;
      let changed = false;
      for (const id of prefs.guide) if (!guide.done[id]) { guide.done[id] = true; changed = true; }
      if (changed) renderGuide();
    }).catch(() => {});
    const empty = !me.library?.assets && !me.library?.scenes;
    if (empty && me.demo && (fresh || !localStorage.getItem(`inkling.welcomed.${me.user.id}`))) $('welcome').showModal();
  }
  function welcomed() {
    try { localStorage.setItem(`inkling.welcomed.${account?.user.id}`, '1'); } catch { /* fine */ }
    $('welcome').close();
  }
  $('welcome-close').addEventListener('click', welcomed);
  $('welcome-fresh').addEventListener('click', () => { welcomed(); canvas.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
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
      loadTags();
      await loadGallery();
      message('library-status', `Added ${plural(result.copied.assets || 0, 'asset')} and ${plural(result.copied.shots || 0, 'scene')} to your library. Try Little Fox > Where used? > Breakdown.`);
      $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      $('welcome-status').textContent = error.message;
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });
  async function boot() {
    try {
      authConfig = await api('/api/auth/config');
    } catch {
      authConfig = { mode: 'off' };
    }
    try {
      await signedIn(await api('/api/session'));
    } catch {
      showGate();
    }
  }

  let warming = false;
  async function checkConnection() {
    try {
      await api('/api/ready');
      $('connection').textContent = 'Library online';
      $('connection').title = '';
      $('connection-dot').classList.add('online');
      if (warming) { warming = false; message('library-status', 'Search is ready.'); loadGallery(); }
    } catch (error) {
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
  buildAnimate();
  renderAssetFilters();
  rebuildAll();
  renderFrames();
  setAiMode('sketch');
  renderSaveKind();
  renderStatusFilters();
  renderGuide();
  checkConnection();
  boot();
})();
