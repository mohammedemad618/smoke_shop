// Barcode scanning with the device camera, decoded by zxing-wasm (ZXing C++).
// The decoder is served from node_modules by server.js and loaded on first use.

const LIBRARY_URL = '/vendor/zxing-wasm/iife/reader/index.js';
const WASM_DIR = '/vendor/zxing-wasm/reader/';
const READER_OPTIONS = { formats: ['AllLinear'], maxNumberOfSymbols: 1 };
const SCAN_INTERVAL_MS = 100;
// Holding the same barcode in view counts once; it can be read again after
// it has been out of view this long.
const REPEAT_GAP_MS = 1500;
// Product barcodes need pixels: ask for HD instead of the browser's default 640x480
const VIDEO_CONSTRAINTS = { width: { ideal: 1920 }, height: { ideal: 1080 } };

const CAMERA_ERRORS = {
  InsecureContext: 'الكاميرا تعمل فقط عند فتح التطبيق على نفس الجهاز (localhost) أو عبر رابط https.',
  NotAllowedError: 'لم يُسمح بالوصول إلى الكاميرا. اسمح به من رمز القفل بجانب عنوان الصفحة ثم حاول مرة أخرى.',
  NotFoundError: 'لا توجد كاميرا متصلة بهذا الجهاز.',
  OverconstrainedError: 'لا توجد كاميرا متصلة بهذا الجهاز.',
  NotReadableError: 'الكاميرا مستخدمة من برنامج آخر. أغلقه ثم حاول مرة أخرى.',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let libraryPromise;
function loadLibrary() {
  libraryPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = LIBRARY_URL;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  })
    .then(async () => {
      const zxing = window.ZXingWASM;
      await zxing.prepareZXingModule({
        overrides: { locateFile: (file, prefix) => (file.endsWith('.wasm') ? WASM_DIR + file : prefix + file) },
        fireImmediately: true,
      });
      return zxing;
    })
    .catch(() => {
      libraryPromise = null;
      throw new Error('تعذر تحميل قارئ الباركود. أعد تحميل الصفحة وحاول مرة أخرى.');
    });
  return libraryPromise;
}

let audio;
function beep(ok) {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = ok ? 1250 : 330;
    gain.gain.value = 0.06;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (ok ? 0.08 : 0.25));
  } catch {
    // Sound is a nicety; scanning works without it
  }
  if (ok) navigator.vibrate?.(60);
}

let dialog;
function buildDialog() {
  const el = document.createElement('dialog');
  el.className = 'dialog scanner-dialog';
  el.setAttribute('aria-labelledby', 'scannerTitle');
  el.innerHTML = `<div class="scanner">
    <h2 id="scannerTitle"></h2>
    <div class="scanner-view">
      <video muted playsinline></video>
      <div class="scanner-frame" aria-hidden="true"></div>
    </div>
    <p class="scanner-status" aria-live="polite"></p>
    <div class="dialog-actions">
      <select class="input scanner-camera" aria-label="اختيار الكاميرا" hidden></select>
      <span class="scanner-meta num"></span>
      <button class="btn btn-ghost" type="button" data-close></button>
    </div>
  </div>`;
  document.body.append(el);
  return el;
}

/** Opens the camera and resolves with the first barcode read, or null if cancelled. */
export function scanBarcode() {
  return openScanner({
    title: 'مسح الباركود بالكاميرا',
    ready: 'ضع الباركود داخل الإطار. إن ظهر مشوشًا فأبعده قليلًا عن الكاميرا حتى يتضح.',
    closeLabel: 'إلغاء',
  });
}

/**
 * Keeps the camera open and calls onScan(code) for every barcode read, until the
 * user closes it. onScan returns { ok, message } to show under the camera view.
 */
export function scanBarcodes(onScan) {
  return openScanner({
    title: 'المسح بالكاميرا',
    ready: 'امسح المنتجات واحدًا تلو الآخر. إن ظهر الباركود مشوشًا فأبعده قليلًا حتى يتضح.',
    closeLabel: 'إنهاء المسح',
    onScan,
  });
}

function openScanner({ title, ready, closeLabel, onScan }) {
  dialog ??= buildDialog();
  const video = dialog.querySelector('video');
  const view = dialog.querySelector('.scanner-view');
  const status = dialog.querySelector('.scanner-status');
  const meta = dialog.querySelector('.scanner-meta');
  const cameraSelect = dialog.querySelector('.scanner-camera');
  const close = dialog.querySelector('[data-close]');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  dialog.querySelector('h2').textContent = title;
  close.textContent = closeLabel;
  meta.textContent = '';

  return new Promise((resolve) => {
    const listeners = new AbortController();
    let stream = null;
    let session = 0;
    let code = null;
    let lastCode = null;
    let lastSeen = 0;

    const setStatus = (text, tone) => {
      status.textContent = text;
      status.classList.toggle('is-error', tone === 'error');
      status.classList.toggle('is-ok', tone === 'ok');
    };

    function stopCamera() {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
    }

    async function handleRead(text) {
      const now = Date.now();
      if (text === lastCode && now - lastSeen < REPEAT_GAP_MS) {
        lastSeen = now;
        return;
      }
      lastCode = text;
      lastSeen = now;
      if (!onScan) {
        code = text;
        beep(true);
        dialog.close();
        return;
      }
      const outcome = await onScan(text);
      beep(outcome.ok);
      setStatus(outcome.message, outcome.ok ? 'ok' : 'error');
    }

    async function decodeLoop(zxing, current) {
      while (current === session) {
        const { videoWidth: w, videoHeight: h } = video;
        if (w && h) {
          if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
          ctx.drawImage(video, 0, 0, w, h);
          const results = await zxing.readBarcodes(ctx.getImageData(0, 0, w, h), READER_OPTIONS);
          if (current !== session) return;
          const hit = results.find((r) => r.isValid && r.text);
          if (hit) await handleRead(hit.text);
        }
        await sleep(SCAN_INTERVAL_MS);
      }
    }

    async function listCameras() {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      cameraSelect.hidden = devices.length < 2;
      if (cameraSelect.hidden) return;
      const activeId = stream?.getVideoTracks()[0]?.getSettings().deviceId;
      cameraSelect.innerHTML = devices
        .map((d, i) => `<option value="${d.deviceId}">${d.label || `كاميرا ${i + 1}`}</option>`)
        .join('');
      if (activeId) cameraSelect.value = activeId;
    }

    async function start(deviceId) {
      const current = ++session;
      stopCamera();
      view.hidden = false;
      setStatus('جارٍ تشغيل الكاميرا…');
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw Object.assign(new Error(), { name: 'InsecureContext' });
        }
        const [zxing, newStream] = await Promise.all([
          loadLibrary(),
          navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              ...VIDEO_CONSTRAINTS,
              ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
            },
          }),
        ]);
        // The dialog was closed or the camera switched while it was starting
        if (current !== session) {
          newStream.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = newStream;
        const track = stream.getVideoTracks()[0];
        // Continuous autofocus where the camera supports it (most phones)
        if (track.getCapabilities?.().focusMode?.includes('continuous')) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        }
        video.srcObject = stream;
        await video.play();

        const settings = track.getSettings();
        // Laptop webcams face the user: mirror the preview so moving the product feels natural
        view.classList.toggle('is-mirrored', settings.facingMode !== 'environment');
        meta.textContent = settings.width ? `${settings.width}×${settings.height}` : '';
        meta.title = 'دقة الكاميرا';
        setStatus(ready);
        listCameras().catch(() => {});
        decodeLoop(zxing, current).catch((err) => {
          if (current === session) setStatus(err.message || 'تعذرت قراءة الكاميرا.', 'error');
        });
      } catch (err) {
        if (current !== session) return;
        stopCamera();
        view.hidden = true;
        setStatus(CAMERA_ERRORS[err.name] ?? (err.message || 'تعذر تشغيل الكاميرا.'), 'error');
      }
    }

    close.addEventListener('click', () => dialog.close(), { signal: listeners.signal });
    cameraSelect.addEventListener('change', () => start(cameraSelect.value), { signal: listeners.signal });
    dialog.addEventListener(
      'close',
      () => {
        session++;
        stopCamera();
        listeners.abort();
        resolve(code);
      },
      { once: true },
    );

    dialog.showModal();
    start();
  });
}
