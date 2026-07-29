/* Photo BG Studio — by M Ijaz, GHS 124/NB
   Vanilla JS, no build step. IndexedDB gallery. MediaPipe Selfie Segmentation for AI background removal. */

(() => {
  'use strict';

  /* ================= IndexedDB helper ================= */
  const DB_NAME = 'photoBgStudioDB';
  const STORE = 'photos';
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function dbPut(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.createdAt - a.createdAt));
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /* ================= State ================= */
  const MAX_DIM = 1600;
  const GRADIENTS = {
    gradient1: ['#f093fb', '#f5576c'],
    gradient2: ['#4facfe', '#00f2fe'],
    gradient3: ['#43e97b', '#38f9d7']
  };

  const state = {
    editingExistingId: null,
    bgRemoved: false,
    selectedBg: 'transparent',
    customBgImg: null,
    adjust: { brightness: 100, contrast: 100, saturation: 100 },
    filterPreset: 'none',
    rotation: 0,
    watermark: { text: 'M Ijaz', pos: 'br', opacity: 70, enabled: true },
    cropMode: false,
    viewingId: null
  };

  let workingCanvas = document.createElement('canvas'); // current pixel state (post bg-removal/bg-composite/crop/rotate)
  let cutoutCanvas = null; // transparent foreground-only canvas after bg removal

  /* ================= DOM refs ================= */
  const $ = (id) => document.getElementById(id);
  const homeScreen = $('homeScreen');
  const editorScreen = $('editorScreen');
  const viewScreen = $('viewScreen');
  const mainCanvas = $('mainCanvas');
  const loadingOverlay = $('loadingOverlay');
  const loadingText = $('loadingText');
  const photoGrid = $('photoGrid');
  const emptyState = $('emptyState');
  const photoCount = $('photoCount');
  const toastEl = $('toast');
  const confirmDialog = $('confirmDialog');
  const confirmText = $('confirmText');
  const cropBox = $('cropBox');
  const canvasWrap = document.querySelector('.canvas-wrap');

  /* ================= Screen navigation ================= */
  function showScreen(el) {
    [homeScreen, editorScreen, viewScreen].forEach(s => s.classList.remove('active'));
    el.classList.add('active');
  }

  /* ================= Toast / Confirm ================= */
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  function confirmAction(message) {
    return new Promise((resolve) => {
      confirmText.textContent = message;
      confirmDialog.classList.remove('hidden');
      const yes = $('confirmYes'), no = $('confirmNo');
      const cleanup = (result) => {
        confirmDialog.classList.add('hidden');
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
        resolve(result);
      };
      const onYes = () => cleanup(true);
      const onNo = () => cleanup(false);
      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
    });
  }

  /* ================= Image loading ================= */
  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function drawImageToWorking(img) {
    let w = img.naturalWidth, h = img.naturalHeight;
    if (w > MAX_DIM || h > MAX_DIM) {
      const scale = MAX_DIM / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    workingCanvas.width = w;
    workingCanvas.height = h;
    const ctx = workingCanvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    cutoutCanvas = null;
    state.bgRemoved = false;
    state.selectedBg = 'transparent';
    state.rotation = 0;
    resetAdjustUI();
    render();
  }

  function resetAdjustUI() {
    state.adjust = { brightness: 100, contrast: 100, saturation: 100 };
    state.filterPreset = 'none';
    $('brightness').value = 100;
    $('contrast').value = 100;
    $('saturation').value = 100;
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === 'none'));
    document.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
  }

  /* ================= Render (bake filters + watermark for preview & export) ================= */
  function filterString() {
    const { brightness, contrast, saturation } = state.adjust;
    let f = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
    if (state.filterPreset === 'grayscale') f += ' grayscale(100%)';
    if (state.filterPreset === 'sepia') f += ' sepia(80%)';
    if (state.filterPreset === 'vivid') f += ' saturate(180%) contrast(115%)';
    return f;
  }

  function drawWatermark(ctx, w, h) {
    const { text, pos, opacity } = state.watermark;
    if (!text.trim()) return;
    const fontSize = Math.max(14, Math.round(w * 0.035));
    const subSize = Math.round(fontSize * 0.45);
    const pad = Math.round(fontSize * 0.6);
    ctx.save();
    ctx.globalAlpha = opacity / 100;
    ctx.font = `700 ${fontSize}px -apple-system, sans-serif`;
    ctx.textBaseline = 'alphabetic';
    const mainW = ctx.measureText(text).width;
    ctx.font = `500 ${subSize}px -apple-system, sans-serif`;
    const subText = 'GHS 124/NB';
    const subW = ctx.measureText(subText).width;
    const blockW = Math.max(mainW, subW);
    const blockH = fontSize + subSize + 6;

    let x, y;
    if (pos === 'tl') { x = pad; y = pad + fontSize; }
    else if (pos === 'tr') { x = w - pad - blockW; y = pad + fontSize; }
    else if (pos === 'bl') { x = pad; y = h - pad - subSize - 6; }
    else if (pos === 'center') { x = (w - blockW) / 2; y = (h - blockH) / 2 + fontSize; }
    else { x = w - pad - blockW; y = h - pad - subSize - 6; } // br default

    // subtle shadow for legibility on any background
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${fontSize}px -apple-system, sans-serif`;
    ctx.fillText(text, x, y);
    ctx.font = `500 ${subSize}px -apple-system, sans-serif`;
    ctx.fillText(subText, x, y + subSize + 4);
    ctx.restore();
  }

  function render() {
    const w = workingCanvas.width, h = workingCanvas.height;
    mainCanvas.width = w;
    mainCanvas.height = h;
    const ctx = mainCanvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (state.selectedBg === 'transparent') {
      ctx.save();
      drawChecker(ctx, w, h);
      ctx.restore();
    }
    ctx.filter = filterString();
    ctx.drawImage(workingCanvas, 0, 0);
    ctx.filter = 'none';
    if (state.watermark.enabled) drawWatermark(ctx, w, h);
  }

  function drawChecker(ctx, w, h) {
    const size = Math.max(8, Math.round(w / 40));
    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        const even = ((x / size) + (y / size)) % 2 === 0;
        ctx.fillStyle = even ? '#334155' : '#1e293b';
        ctx.fillRect(x, y, size, size);
      }
    }
  }

  /* ================= Background removal (MediaPipe Selfie Segmentation) ================= */
  let segmenter = null;
  function getSegmenter() {
    if (segmenter) return segmenter;
    // eslint-disable-next-line no-undef
    segmenter = new SelfieSegmentation({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
    });
    segmenter.setOptions({ modelSelection: 1 });
    return segmenter;
  }

  function setLoading(show, text) {
    loadingText.textContent = text || 'Kaam ho raha hai...';
    loadingOverlay.classList.toggle('hidden', !show);
  }

  async function removeBackground() {
    if (state.bgRemoved) { toast('Background pehle se remove ho chuka hai'); return; }
    setLoading(true, 'Background hata rahe hain...');
    try {
      const seg = getSegmenter();
      const maskCanvas = await new Promise((resolve, reject) => {
        seg.onResults((results) => resolve(results.segmentationMask));
        seg.send({ image: workingCanvas }).catch(reject);
      });
      applyMaskToWorking(maskCanvas);
      state.bgRemoved = true;
      state.selectedBg = 'transparent';
      render();
      toast('Background successfully remove ho gaya ✅');
    } catch (err) {
      console.error(err);
      toast('Background remove nahi ho saka. Dobara koshish karein.');
    } finally {
      setLoading(false);
    }
  }

  function applyMaskToWorking(maskSource) {
    const w = workingCanvas.width, h = workingCanvas.height;
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = w; maskCanvas.height = h;
    const mctx = maskCanvas.getContext('2d');
    mctx.drawImage(maskSource, 0, 0, w, h);
    const maskData = mctx.getImageData(0, 0, w, h).data;

    const ctx = workingCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < imgData.data.length; i += 4) {
      imgData.data[i + 3] = maskData[i]; // grayscale mask R channel -> alpha
    }
    ctx.putImageData(imgData, 0, 0);

    cutoutCanvas = document.createElement('canvas');
    cutoutCanvas.width = w; cutoutCanvas.height = h;
    cutoutCanvas.getContext('2d').drawImage(workingCanvas, 0, 0);
  }

  function drawImageCover(ctx, img, w, h) {
    const ir = img.naturalWidth / img.naturalHeight;
    const cr = w / h;
    let sx, sy, sw, sh;
    if (ir > cr) {
      sh = img.naturalHeight;
      sw = sh * cr;
      sx = (img.naturalWidth - sw) / 2;
      sy = 0;
    } else {
      sw = img.naturalWidth;
      sh = sw / cr;
      sx = 0;
      sy = (img.naturalHeight - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  }

  function applyBackground(bgValue) {
    if (!state.bgRemoved) { toast('Pehle "Background Remove" button dabayein'); return; }
    const w = workingCanvas.width, h = workingCanvas.height;
    const ctx = workingCanvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    if (bgValue === 'transparent') {
      // leave empty (transparent)
    } else if (typeof bgValue === 'string' && bgValue.startsWith('#')) {
      ctx.fillStyle = bgValue;
      ctx.fillRect(0, 0, w, h);
    } else if (GRADIENTS[bgValue]) {
      const [c1, c2] = GRADIENTS[bgValue];
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, c1);
      grad.addColorStop(1, c2);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    } else if (bgValue instanceof HTMLImageElement) {
      drawImageCover(ctx, bgValue, w, h);
    }
    if (cutoutCanvas) ctx.drawImage(cutoutCanvas, 0, 0);
    state.selectedBg = bgValue;
    render();
  }

  /* ================= Rotate / Flip ================= */
  function rotateWorking(deg) {
    [workingCanvas, cutoutCanvas].forEach((canvas, idx) => {
      if (!canvas) return;
      const w = canvas.width, h = canvas.height;
      const out = document.createElement('canvas');
      out.width = h; out.height = w;
      const ctx = out.getContext('2d');
      ctx.translate(out.width / 2, out.height / 2);
      ctx.rotate((deg * Math.PI) / 180);
      ctx.drawImage(canvas, -w / 2, -h / 2);
      if (idx === 0) { workingCanvas = out; }
      else { cutoutCanvas = out; }
    });
    render();
  }

  function flipWorking() {
    [workingCanvas, cutoutCanvas].forEach((canvas, idx) => {
      if (!canvas) return;
      const w = canvas.width, h = canvas.height;
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      const ctx = out.getContext('2d');
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(canvas, 0, 0);
      if (idx === 0) { workingCanvas = out; }
      else { cutoutCanvas = out; }
    });
    render();
  }

  /* ================= Crop ================= */
  let cropRect = null; // {x,y,w,h} in CSS px relative to canvasWrap
  let cropDrag = null;

  function enterCropMode() {
    state.cropMode = true;
    const rect = mainCanvas.getBoundingClientRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    const margin = 0.12;
    cropRect = {
      x: rect.left - wrapRect.left + rect.width * margin,
      y: rect.top - wrapRect.top + rect.height * margin,
      w: rect.width * (1 - margin * 2),
      h: rect.height * (1 - margin * 2)
    };
    cropBox.classList.remove('hidden');
    $('cropApplyRow').classList.remove('hidden');
    updateCropBoxUI();
  }

  function exitCropMode() {
    state.cropMode = false;
    cropBox.classList.add('hidden');
    $('cropApplyRow').classList.add('hidden');
  }

  function updateCropBoxUI() {
    cropBox.style.left = cropRect.x + 'px';
    cropBox.style.top = cropRect.y + 'px';
    cropBox.style.width = cropRect.w + 'px';
    cropBox.style.height = cropRect.h + 'px';
  }

  function applyCrop() {
    const canvasRect = mainCanvas.getBoundingClientRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    const canvasX = canvasRect.left - wrapRect.left;
    const canvasY = canvasRect.top - wrapRect.top;
    const scaleX = mainCanvas.width / canvasRect.width;
    const scaleY = mainCanvas.height / canvasRect.height;

    const sx = Math.max(0, (cropRect.x - canvasX) * scaleX);
    const sy = Math.max(0, (cropRect.y - canvasY) * scaleY);
    const sw = Math.min(mainCanvas.width - sx, cropRect.w * scaleX);
    const sh = Math.min(mainCanvas.height - sy, cropRect.h * scaleY);

    if (sw < 10 || sh < 10) { toast('Crop area bohat chota hai'); return; }

    [workingCanvas, cutoutCanvas].forEach((canvas, idx) => {
      if (!canvas) return;
      const out = document.createElement('canvas');
      out.width = sw; out.height = sh;
      out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      if (idx === 0) workingCanvas = out;
      else cutoutCanvas = out;
    });
    exitCropMode();
    render();
    toast('Crop apply ho gaya ✅');
  }

  function setupCropHandles() {
    let mode = null, startRect = null, startPt = null;
    function pointerDown(e, handleType) {
      e.preventDefault();
      mode = handleType;
      startRect = { ...cropRect };
      startPt = getPoint(e);
      window.addEventListener('pointermove', pointerMove);
      window.addEventListener('pointerup', pointerUp);
    }
    function getPoint(e) {
      return { x: e.clientX, y: e.clientY };
    }
    function pointerMove(e) {
      if (!mode) return;
      const pt = getPoint(e);
      const dx = pt.x - startPt.x, dy = pt.y - startPt.y;
      let r = { ...startRect };
      const min = 40;
      if (mode === 'move') {
        r.x = startRect.x + dx;
        r.y = startRect.y + dy;
      } else if (mode === 'tl') {
        r.x = startRect.x + dx; r.y = startRect.y + dy;
        r.w = startRect.w - dx; r.h = startRect.h - dy;
      } else if (mode === 'tr') {
        r.y = startRect.y + dy;
        r.w = startRect.w + dx; r.h = startRect.h - dy;
      } else if (mode === 'bl') {
        r.x = startRect.x + dx;
        r.w = startRect.w - dx; r.h = startRect.h + dy;
      } else if (mode === 'br') {
        r.w = startRect.w + dx; r.h = startRect.h + dy;
      }
      if (r.w < min) r.w = min;
      if (r.h < min) r.h = min;
      cropRect = r;
      updateCropBoxUI();
    }
    function pointerUp() {
      mode = null;
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
    }
    cropBox.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('crop-handle')) return;
      pointerDown(e, 'move');
    });
    cropBox.querySelector('.tl').addEventListener('pointerdown', (e) => pointerDown(e, 'tl'));
    cropBox.querySelector('.tr').addEventListener('pointerdown', (e) => pointerDown(e, 'tr'));
    cropBox.querySelector('.bl').addEventListener('pointerdown', (e) => pointerDown(e, 'bl'));
    cropBox.querySelector('.br').addEventListener('pointerdown', (e) => pointerDown(e, 'br'));
  }

  /* ================= Gallery (grid on home screen) ================= */
  async function refreshGallery() {
    const photos = await dbGetAll();
    photoGrid.innerHTML = '';
    photoCount.textContent = photos.length;
    emptyState.classList.toggle('show', photos.length === 0);
    photos.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'grid-item';
      div.innerHTML = `<img src="${p.dataUrl}" alt="photo">`;
      div.addEventListener('click', () => openViewScreen(p.id));
      photoGrid.appendChild(div);
    });
  }

  async function openViewScreen(id) {
    const photos = await dbGetAll();
    const p = photos.find(x => x.id === id);
    if (!p) return;
    state.viewingId = id;
    $('viewImage').src = p.dataUrl;
    showScreen(viewScreen);
  }

  /* ================= Save / Download / Share ================= */
  function currentDataUrl() {
    render();
    return mainCanvas.toDataURL('image/png');
  }

  async function saveCurrentPhoto() {
    render();
    const dataUrl = mainCanvas.toDataURL('image/png');
    const id = state.editingExistingId || ('photo_' + Date.now());
    await dbPut({ id, dataUrl, createdAt: Date.now() });
    state.editingExistingId = id;
    toast('Photo save ho gayi ✅');
    await refreshGallery();
  }

  function downloadCanvasImage() {
    render();
    mainCanvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `M-Ijaz-Photo-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('Download shuru ho gayi ⬇️');
    }, 'image/png');
  }

  async function shareCanvasImage() {
    render();
    mainCanvas.toBlob(async (blob) => {
      const file = new File([blob], `M-Ijaz-Photo-${Date.now()}.png`, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'Photo BG Studio - M Ijaz' });
        } catch (err) {
          if (err.name !== 'AbortError') toast('Share cancel ho gaya');
        }
      } else {
        toast('Is device par share support nahi. Download kar rahe hain.');
        downloadCanvasImage();
      }
    }, 'image/png');
  }

  async function downloadDataUrl(dataUrl) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `M-Ijaz-Photo-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('Download shuru ho gayi ⬇️');
  }

  async function shareDataUrl(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], `M-Ijaz-Photo-${Date.now()}.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Photo BG Studio - M Ijaz' });
      } catch (err) {
        if (err.name !== 'AbortError') toast('Share cancel ho gaya');
      }
    } else {
      toast('Is device par share support nahi. Download kar rahe hain.');
      downloadDataUrl(dataUrl);
    }
  }

  /* ================= Editor open / reset ================= */
  function openEditorWithImage(img, existingId) {
    state.editingExistingId = existingId || null;
    drawImageToWorking(img);
    document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    document.querySelectorAll('.tool-panel').forEach((p, i) => p.classList.toggle('active', i === 0));
    exitCropMode();
    showScreen(editorScreen);
  }

  /* ================= Event wiring ================= */
  function wireEvents() {
    $('fileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const img = await loadImageFromFile(file);
      openEditorWithImage(img, null);
      e.target.value = '';
    });
    $('cameraInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const img = await loadImageFromFile(file);
      openEditorWithImage(img, null);
      e.target.value = '';
    });

    $('galleryBtn').addEventListener('click', () => {
      document.querySelector('.grid-section').scrollIntoView({ behavior: 'smooth' });
    });

    $('backFromEditor').addEventListener('click', () => { showScreen(homeScreen); refreshGallery(); });
    $('resetEditor').addEventListener('click', async () => {
      const ok = await confirmAction('Saari changes reset karein?');
      if (!ok) return;
      if (state.editingExistingId) toast('Reset ke liye photo dobara upload karein');
    });

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tool-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        $('panel-' + btn.dataset.tool).classList.add('active');
        if (btn.dataset.tool !== 'crop') exitCropMode();
      });
    });

    // Background
    $('removeBgBtn').addEventListener('click', removeBackground);
    document.querySelectorAll('.swatch[data-bg]').forEach(sw => {
      sw.addEventListener('click', () => {
        document.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
        sw.classList.add('selected');
        applyBackground(sw.dataset.bg);
      });
    });
    $('customBgInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const img = await loadImageFromFile(file);
      state.customBgImg = img;
      applyBackground(img);
      e.target.value = '';
    });

    // Adjust
    ['brightness', 'contrast', 'saturation'].forEach(key => {
      $(key).addEventListener('input', (e) => {
        state.adjust[key] = Number(e.target.value);
        render();
      });
    });
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.filterPreset = chip.dataset.filter;
        render();
      });
    });

    // Crop/rotate
    $('rotateLeftBtn').addEventListener('click', () => rotateWorking(-90));
    $('rotateRightBtn').addEventListener('click', () => rotateWorking(90));
    $('flipBtn').addEventListener('click', flipWorking);
    $('cropToggleBtn').addEventListener('click', () => {
      if (state.cropMode) exitCropMode(); else enterCropMode();
    });
    $('cropApplyBtn').addEventListener('click', applyCrop);
    $('cropCancelBtn').addEventListener('click', exitCropMode);
    setupCropHandles();

    // Watermark
    $('watermarkToggle').addEventListener('change', (e) => {
      state.watermark.enabled = e.target.checked;
      render();
    });
    $('watermarkText').addEventListener('input', (e) => {
      state.watermark.text = e.target.value;
      render();
    });
    document.querySelectorAll('.pos-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.watermark.pos = btn.dataset.pos;
        render();
      });
    });
    $('watermarkOpacity').addEventListener('input', (e) => {
      state.watermark.opacity = Number(e.target.value);
      render();
    });

    // Editor action bar
    $('saveBtn').addEventListener('click', saveCurrentPhoto);
    $('downloadBtn').addEventListener('click', downloadCanvasImage);
    $('shareBtn').addEventListener('click', shareCanvasImage);

    // View screen
    $('backFromView').addEventListener('click', () => { showScreen(homeScreen); refreshGallery(); });
    $('deleteFromView').addEventListener('click', async () => {
      const ok = await confirmAction('Yeh photo delete kar dein?');
      if (!ok) return;
      await dbDelete(state.viewingId);
      toast('Photo delete ho gayi 🗑️');
      showScreen(homeScreen);
      refreshGallery();
    });
    $('editFromView').addEventListener('click', async () => {
      const photos = await dbGetAll();
      const p = photos.find(x => x.id === state.viewingId);
      if (!p) return;
      const img = new Image();
      img.onload = () => openEditorWithImage(img, p.id);
      img.src = p.dataUrl;
    });
    $('downloadFromView').addEventListener('click', async () => {
      const photos = await dbGetAll();
      const p = photos.find(x => x.id === state.viewingId);
      if (p) downloadDataUrl(p.dataUrl);
    });
    $('shareFromView').addEventListener('click', async () => {
      const photos = await dbGetAll();
      const p = photos.find(x => x.id === state.viewingId);
      if (p) shareDataUrl(p.dataUrl);
    });

    window.addEventListener('resize', () => {
      if (state.cropMode) { exitCropMode(); }
    });
  }

  /* ================= Init ================= */
  async function init() {
    wireEvents();
    await refreshGallery();
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
