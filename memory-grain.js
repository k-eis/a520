// ── Memory Grain a520 エフェクトエンジン
// Polaroid a520（2002年発売想定・CCD/初期デジカメ）の「不完全さ」を再現する5パラメータ:
// 01 MEMORY COLOR  → CCDの暖色系シフト。青緑は鮮やかに、赤は柔らかく深く
// 02 BLOOM         → ハイライトが白飛びせず、じわっと光に溶ける
// 03 SOFT EDGE     → 解像感はあるが強調しない、MTF的な柔らかい境界遷移
// 04 GRAIN         → CCD特有のノイズ。欠点ではなく記憶の質感
// 05 COMPRESS      → ダイナミックレンジ圧縮。ハイライト/シャドウを持ち上げて印象派的なトーンに
// (2段階プレビュー処理・ノイズ関数・iOS保存はClair de Lune / Structural Driftの既存資産を移植)

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const outputCanvas = document.getElementById('outputCanvas');
const canvasBadge = document.getElementById('canvasBadge');
const ctx = outputCanvas.getContext('2d');

const memoryColorSlider = document.getElementById('memoryColor');
const bloomSlider = document.getElementById('bloom');
const softEdgeSlider = document.getElementById('softEdge');
const grainSlider = document.getElementById('grain');
const compressSlider = document.getElementById('compress');
const monochromeCheckbox = document.getElementById('monochrome');
const unstableCheckbox = document.getElementById('unstable');
const isoBtns = document.querySelectorAll('.iso-btn');

const memoryColorVal = document.getElementById('memoryColorVal');
const bloomVal = document.getElementById('bloomVal');
const softEdgeVal = document.getElementById('softEdgeVal');
const grainVal = document.getElementById('grainVal');
const compressVal = document.getElementById('compressVal');

const downloadBtn = document.getElementById('downloadBtn');
const resetBtn = document.getElementById('resetBtn');
const presetBtns = document.querySelectorAll('.profile-btn');
const themeBtns = document.querySelectorAll('.theme-btn');

let originalImage = null;
let originalImageData = null;

// ── ISO：GRAINの粒状感とUNSTABLEの暴れ幅（Predictability Meter）を両方動かす
const ISO_LEVELS = {
  100: { grainBoost: 1.0, variance: 0.15 }, // Stable
  200: { grainBoost: 1.4, variance: 0.35 }, // Sensitive
  400: { grainBoost: 1.9, variance: 0.65 }, // Unpredictable
  800: { grainBoost: 2.6, variance: 1.0  }, // Experimental
};
let currentISO = 100;
let applyGeneration = 0; // UNSTABLE用の「今回の当たり外れ」シード

// ── ファイル読み込み
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadFile(file);
});
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadFile(file);
});

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      originalImage = img;
      setupCanvas(img);
      applyMemoryGrain();
      dropZone.style.display = 'none';
      canvasBadge.style.display = 'block';
      outputCanvas.style.display = 'block';
      downloadBtn.disabled = false;
      resetBtn.disabled = false;
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

let previewImageData = null; // ドラッグ中の軽量プレビュー用（縮小版）
let isDragging = false;

function setupCanvas(img) {
  const MAX_W = 1200;
  let w = img.width, h = img.height;
  if (w > MAX_W) { h = h * (MAX_W / w); w = MAX_W; }
  outputCanvas.width = w;
  outputCanvas.height = h;
  ctx.drawImage(img, 0, 0, w, h);
  originalImageData = ctx.getImageData(0, 0, w, h);

  // プレビュー用に縮小したImageDataも作っておく（ドラッグ中の高速処理用）
  const PREVIEW_MAX_W = 320;
  const pScale = Math.min(1, PREVIEW_MAX_W / w);
  const pw = Math.max(1, Math.round(w * pScale));
  const ph = Math.max(1, Math.round(h * pScale));
  const pCanvas = document.createElement('canvas');
  pCanvas.width = pw; pCanvas.height = ph;
  const pCtx = pCanvas.getContext('2d');
  pCtx.drawImage(img, 0, 0, pw, ph);
  previewImageData = pCtx.getImageData(0, 0, pw, ph);
}

// スロットリング（重い処理の連続実行を防ぐ）
let driftRAF = null;
function requestApply() {
  if (driftRAF) cancelAnimationFrame(driftRAF);
  driftRAF = requestAnimationFrame(() => {
    applyMemoryGrain(isDragging);
    driftRAF = null;
  });
}

// ── 決定論的な擬似ランダム（Clair de Luneより移植：GRAINのノイズ生成に使用）
function pseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
function pseudoRandom2D(x, y) {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return v - Math.floor(v);
}
function smoothNoise2D(x, y, scale) {
  const sx = x / scale, sy = y / scale;
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  const fx = sx - x0, fy = sy - y0;
  const v00 = pseudoRandom2D(x0, y0);
  const v10 = pseudoRandom2D(x0+1, y0);
  const v01 = pseudoRandom2D(x0, y0+1);
  const v11 = pseudoRandom2D(x0+1, y0+1);
  const sfx = fx*fx*(3-2*fx);
  const sfy = fy*fy*(3-2*fy);
  const top = v00 + (v10 - v00) * sfx;
  const bottom = v01 + (v11 - v01) * sfx;
  return top + (bottom - top) * sfy;
}
function cloudNoise(x, y) {
  return smoothNoise2D(x, y, 180) * 0.5
       + smoothNoise2D(x + 1000, y + 1000, 80) * 0.3
       + smoothNoise2D(x + 2000, y + 2000, 35) * 0.2;
}

// ── 簡易ボックスブラー（SOFT EDGE / BLOOMのベース処理）
function boxBlur(data, w, h, radius) {
  if (radius < 1) return data;
  const out = new Uint8ClampedArray(data.length);
  const r = Math.max(1, Math.round(radius));

  const temp = new Float32Array(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr=0, sg=0, sb=0, sa=0, count=0;
      for (let dx = -r; dx <= r; dx++) {
        const sx = x + dx;
        if (sx < 0 || sx >= w) continue;
        const i = (y*w+sx)*4;
        sr += data[i]; sg += data[i+1]; sb += data[i+2]; sa += data[i+3];
        count++;
      }
      const oi = (y*w+x)*4;
      temp[oi] = sr/count; temp[oi+1] = sg/count; temp[oi+2] = sb/count; temp[oi+3] = sa/count;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sr=0, sg=0, sb=0, sa=0, count=0;
      for (let dy = -r; dy <= r; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= h) continue;
        const i = (sy*w+x)*4;
        sr += temp[i]; sg += temp[i+1]; sb += temp[i+2]; sa += temp[i+3];
        count++;
      }
      const oi = (y*w+x)*4;
      out[oi] = sr/count; out[oi+1] = sg/count; out[oi+2] = sb/count; out[oi+3] = sa/count;
    }
  }
  return out;
}

function applyMemoryGrain(preview) {
  if (!originalImageData) return;

  const useData = (preview && previewImageData) ? previewImageData : originalImageData;
  const w = useData.width;
  const h = useData.height;
  const radiusScale = preview ? (w / outputCanvas.width) : 1;

  // フル解像度の本番描画のたびに「今回のロール」を更新する（UNSTABLE用）
  if (!preview) applyGeneration++;

  let memoryColor = parseInt(memoryColorSlider.value) / 100;
  let bloom = parseInt(bloomSlider.value) / 100;
  let softEdge = parseInt(softEdgeSlider.value) / 100;
  let grain = parseInt(grainSlider.value) / 100;
  let compress = parseInt(compressSlider.value) / 100;
  const mono = monochromeCheckbox.checked;
  const unstable = unstableCheckbox.checked;
  const isoInfo = ISO_LEVELS[currentISO] || ISO_LEVELS[100];

  // ── UNSTABLE：ISOが高いほど「今日は当たりか外れか分からない」揺らぎが大きくなる
  let exposureShift = 0;
  if (unstable) {
    const v = isoInfo.variance;
    const seed = applyGeneration * 13.7;
    memoryColor = Math.max(0, Math.min(1, memoryColor + (pseudoRandom(seed + 1) - 0.5) * v * 0.7));
    compress    = Math.max(0, Math.min(1, compress    + (pseudoRandom(seed + 2) - 0.5) * v * 0.7));
    // ブルームは裏技の「白飛び」を再現するため、プラス側に偏らせる（たまに大暴れする）
    bloom = Math.max(0, Math.min(1, bloom + Math.max(0, pseudoRandom(seed + 3) - 0.35) * v * 1.4));
    exposureShift = (pseudoRandom(seed + 4) - 0.5) * v * 90;
  }

  const src = useData.data;
  let out = new Uint8ClampedArray(src.length);

  // ── STEP 1: MEMORY COLOR + COMPRESS + EXPOSURE（1パスの per-pixel 処理）
  // 過激化版：CCD色科学の効きを強め、ダイナミックレンジ圧縮も大胆に
  const blackPoint = compress * 70;
  const whitePoint = 255 - compress * 70;
  const range = Math.max(1, whitePoint - blackPoint);

  for (let i = 0; i < src.length; i += 4) {
    let r = src[i], g = src[i+1], b = src[i+2];
    const avg = (r + g + b) / 3;

    // CCD Color Science: 青緑を鮮やかに、赤を柔らかく深く（強化版）
    g = avg + (g - avg) * (1 + 1.2 * memoryColor);
    b = avg + (b - avg) * (1 + 0.9 * memoryColor);
    r = avg + (r - avg) * (1 - 0.6 * memoryColor);
    r = r * (1 - 0.35 * memoryColor);
    // 全体の暖色シフト（強化版）
    r += 30 * memoryColor;
    b -= 18 * memoryColor;

    // 露出のブレ（UNSTABLE時のみ）
    if (exposureShift !== 0) { r += exposureShift; g += exposureShift; b += exposureShift; }

    // ダイナミックレンジ圧縮（トーンカーブ・強化版）
    r = blackPoint + (Math.max(0, Math.min(255, r)) / 255) * range;
    g = blackPoint + (Math.max(0, Math.min(255, g)) / 255) * range;
    b = blackPoint + (Math.max(0, Math.min(255, b)) / 255) * range;

    out[i] = r; out[i+1] = g; out[i+2] = b; out[i+3] = src[i+3];
  }

  // ── STEP 2: SOFT EDGE（強化版：最大までかけると輪郭がかなり溶ける）
  if (softEdge > 0.01) {
    const blurRadius = softEdge * 8 * Math.max(radiusScale, 0.35);
    const blurred = boxBlur(out, w, h, blurRadius);
    const mixed = new Uint8ClampedArray(out.length);
    const keepSharp = 1 - softEdge * 0.9;
    for (let i = 0; i < out.length; i += 4) {
      mixed[i]   = out[i]   * keepSharp + blurred[i]   * (1 - keepSharp);
      mixed[i+1] = out[i+1] * keepSharp + blurred[i+1] * (1 - keepSharp);
      mixed[i+2] = out[i+2] * keepSharp + blurred[i+2] * (1 - keepSharp);
      mixed[i+3] = out[i+3];
    }
    out = mixed;
  }

  // ── STEP 3: BLOOM（強化版：threshold自体が下がり、最大では画面全体が白飛びに向かう）
  if (bloom > 0.01) {
    const threshold = 210 - bloom * 160;
    const highlights = new Uint8ClampedArray(out.length);
    for (let i = 0; i < out.length; i += 4) {
      const lum = out[i]*0.299 + out[i+1]*0.587 + out[i+2]*0.114;
      const amt = Math.max(0, lum - threshold) / Math.max(1, 255 - threshold);
      highlights[i]   = out[i]   * amt;
      highlights[i+1] = out[i+1] * amt;
      highlights[i+2] = out[i+2] * amt;
      highlights[i+3] = 255;
    }
    const bloomRadius = 4 + bloom * 34 * Math.max(radiusScale, 0.35);
    const bloomed = boxBlur(highlights, w, h, bloomRadius);
    const bloomStrength = Math.min(1, bloom * 1.15);
    for (let i = 0; i < out.length; i += 4) {
      out[i]   = 255 - (255 - out[i])   * (1 - (bloomed[i]/255)   * bloomStrength);
      out[i+1] = 255 - (255 - out[i+1]) * (1 - (bloomed[i+1]/255) * bloomStrength);
      out[i+2] = 255 - (255 - out[i+2]) * (1 - (bloomed[i+2]/255) * bloomStrength);
    }
  }

  // ── STEP 4: GRAIN（強化版：ISOに応じてノイズ量が増幅する）
  if (grain > 0.01) {
    const grainSeedOffset = 5000;
    const g2 = grain * isoInfo.grainBoost;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y*w+x)*4;
        const n = (pseudoRandom2D(x + grainSeedOffset, y + grainSeedOffset) - 0.5) * 2;
        const lumNoise = n * g2 * 70;
        const cn = (pseudoRandom2D(x - grainSeedOffset, y + grainSeedOffset) - 0.5) * 2;
        const chromaNoise = cn * g2 * 30;

        out[i]   = out[i]   + lumNoise + chromaNoise;
        out[i+1] = out[i+1] + lumNoise;
        out[i+2] = out[i+2] + lumNoise - chromaNoise;
      }
    }
  }

  if (mono) {
    for (let i = 0; i < out.length; i += 4) {
      const gray = out[i]*0.299 + out[i+1]*0.587 + out[i+2]*0.114;
      out[i] = out[i+1] = out[i+2] = gray;
    }
  }

  const resultData = new ImageData(out, w, h);

  if (preview && previewImageData) {
    let tempCanvas = applyMemoryGrain._tempCanvas;
    if (!tempCanvas) {
      tempCanvas = document.createElement('canvas');
      applyMemoryGrain._tempCanvas = tempCanvas;
    }
    tempCanvas.width = w; tempCanvas.height = h;
    tempCanvas.getContext('2d').putImageData(resultData, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tempCanvas, 0, 0, w, h, 0, 0, outputCanvas.width, outputCanvas.height);
  } else {
    ctx.putImageData(resultData, 0, 0);
  }
}

// ── UIイベント
const allSliders = [memoryColorSlider, bloomSlider, softEdgeSlider, grainSlider, compressSlider];

allSliders.forEach(slider => {
  slider.addEventListener('pointerdown', () => { isDragging = true; });
  slider.addEventListener('touchstart', () => { isDragging = true; }, { passive: true });
});
function endDrag() {
  if (!isDragging) return;
  isDragging = false;
  requestApply();
}
allSliders.forEach(slider => {
  slider.addEventListener('pointerup', endDrag);
  slider.addEventListener('touchend', endDrag);
  slider.addEventListener('change', endDrag);
});
window.addEventListener('pointerup', () => { if (isDragging) endDrag(); });
window.addEventListener('touchend', () => { if (isDragging) endDrag(); });

memoryColorSlider.addEventListener('input', () => {
  memoryColorVal.textContent = memoryColorSlider.value + '%';
  clearPresetActive();
  requestApply();
});
bloomSlider.addEventListener('input', () => {
  bloomVal.textContent = bloomSlider.value + '%';
  clearPresetActive();
  requestApply();
});
softEdgeSlider.addEventListener('input', () => {
  softEdgeVal.textContent = softEdgeSlider.value + '%';
  clearPresetActive();
  requestApply();
});
grainSlider.addEventListener('input', () => {
  grainVal.textContent = grainSlider.value + '%';
  clearPresetActive();
  requestApply();
});
compressSlider.addEventListener('input', () => {
  compressVal.textContent = compressSlider.value + '%';
  clearPresetActive();
  requestApply();
});
monochromeCheckbox.addEventListener('change', () => applyMemoryGrain());

// ── ISO：粒状感とUNSTABLEの暴れ幅を決める
isoBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    currentISO = parseInt(btn.dataset.iso, 10);
    isoBtns.forEach(b => b.classList.toggle('active', b === btn));
    requestApply();
  });
});

// ── UNSTABLE：撮るたびに色味・露出・ブルームが揺らぐ気まぐれモード
unstableCheckbox.addEventListener('change', () => applyMemoryGrain());

// ── Camera Mood プリセット（過激化版）
const CAMERA_MOOD_PROFILES = {
  a520:      { memoryColor: 45, bloom: 30, softEdge: 25, grain: 35, compress: 30 }, // 標準
  faded:     { memoryColor: 55, bloom: 40, softEdge: 35, grain: 45, compress: 50 }, // 色褪せた記憶
  nostalgia: { memoryColor: 75, bloom: 60, softEdge: 50, grain: 65, compress: 70 }, // 強くノスタルジック
  blowout:   { memoryColor: 20, bloom: 95, softEdge: 30, grain: 30, compress: 15 }, // 白飛び・裏技風
};

presetBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const profile = CAMERA_MOOD_PROFILES[btn.dataset.profile];
    if (!profile) return;
    memoryColorSlider.value = profile.memoryColor;
    memoryColorVal.textContent = profile.memoryColor + '%';
    bloomSlider.value = profile.bloom;
    bloomVal.textContent = profile.bloom + '%';
    softEdgeSlider.value = profile.softEdge;
    softEdgeVal.textContent = profile.softEdge + '%';
    grainSlider.value = profile.grain;
    grainVal.textContent = profile.grain + '%';
    compressSlider.value = profile.compress;
    compressVal.textContent = profile.compress + '%';
    presetBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    requestApply();
  });
});

function clearPresetActive() { presetBtns.forEach(b => b.classList.remove('active')); }

// ── テーマ切り替え（Memory / Silver / Silicone）
const THEME_CLASS_MAP = { memory: null, silver: 'theme-silver', silicone: 'theme-silicone' };

function applyTheme(themeKey) {
  if (!(themeKey in THEME_CLASS_MAP)) return;
  Object.values(THEME_CLASS_MAP).forEach(cls => { if (cls) document.body.classList.remove(cls); });
  const cls = THEME_CLASS_MAP[themeKey];
  if (cls) document.body.classList.add(cls);
  themeBtns.forEach(b => b.classList.toggle('active', b.dataset.theme === themeKey));
  try { localStorage.setItem('memorygrain-theme', themeKey); } catch(e) {}
}

themeBtns.forEach(btn => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
});

try {
  const savedTheme = localStorage.getItem('memorygrain-theme');
  if (savedTheme && (savedTheme in THEME_CLASS_MAP)) {
    applyTheme(savedTheme);
  } else if (savedTheme) {
    localStorage.removeItem('memorygrain-theme');
  }
} catch(e) {}

// ── 保存（iOS対応：オーバーレイ方式。Clair de Luneより移植）
downloadBtn.addEventListener('click', () => {
  try {
    const dataUrl = outputCanvas.toDataURL('image/png');
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (isIOS) {
      showSaveOverlay(dataUrl);
    } else {
      const link = document.createElement('a');
      link.download = 'memory-grain-a520.png';
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  } catch (err) {
    console.error('PNG保存に失敗しました:', err);
    alert('画像の保存に失敗しました。ブラウザを再読み込みしてもう一度お試しください。');
  }
});

function showSaveOverlay(dataUrl) {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(10,10,10,0.96);
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 20px; box-sizing: border-box;
  `;
  const img = document.createElement('img');
  img.src = dataUrl;
  img.style.cssText = 'max-width: 100%; max-height: 75vh; border-radius: 2px;';

  const hint = document.createElement('p');
  hint.innerHTML = '画像を長押しして「写真に保存」を選んでください<br><span style="color:#888; font-size:11px;">Press and hold the image, then tap "Save to Photos"</span>';
  hint.style.cssText = 'color: #ccc; font-family: sans-serif; font-size: 13px; margin-top: 16px; text-align: center; line-height: 1.6;';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '閉じる / Close';
  closeBtn.style.cssText = `
    margin-top: 20px; padding: 10px 24px;
    background: transparent; color: white;
    border: 1px solid #666; border-radius: 2px;
    font-family: sans-serif; font-size: 13px; cursor: pointer;
  `;
  closeBtn.addEventListener('click', () => overlay.remove());

  overlay.appendChild(img);
  overlay.appendChild(hint);
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);
}

resetBtn.addEventListener('click', () => {
  originalImage = null;
  originalImageData = null;
  outputCanvas.style.display = 'none';
  canvasBadge.style.display = 'none';
  dropZone.style.display = 'flex';
  downloadBtn.disabled = true;
  resetBtn.disabled = true;
  fileInput.value = '';
});
