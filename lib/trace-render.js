// Primitives de rendu canvas : formes d'onde, hypnogramme, superposition d'événements.
// Aucune dépendance au DOM autre que le <canvas> passé en argument.

export const TRACE_COLORS = ["#3a86ff", "#e8590c"];

export const STAGE_ROW = { wake: 0, rem: 1, n1: 2, n2: 3, n3: 4 };
// palette lisible sur fond blanc (comme NOX)
export const STAGE_COLOR = { wake: "#e8590c", rem: "#0ca678", n1: "#4dabf7", n2: "#1c7ed6", n3: "#0b3d91" };

export const EVENT_STYLE = {
  hypopnea:                       { fill: "rgba(77,171,247,.30)",  line: "#4dabf7" },
  "hypopnea-obstructive":         { fill: "rgba(77,171,247,.30)",  line: "#4dabf7" },
  "hypopnea-central":             { fill: "rgba(116,192,252,.30)", line: "#74c0fc" },
  "apnea-obstructive":            { fill: "rgba(250,82,82,.32)",   line: "#fa5252" },
  "apnea-central":                { fill: "rgba(230,73,128,.32)",  line: "#e64980" },
  "apnea-mixed":                  { fill: "rgba(190,75,220,.32)",  line: "#be4bdc" },
  rera:                           { fill: "rgba(255,212,59,.28)",  line: "#f0b400" },
  "oxygensaturation-drop":        { fill: "rgba(45,163,72,.20)",   line: "#2b9348" },
  "snore-train":                  { fill: "rgba(151,117,250,.26)", line: "#9775fa" },
  arousal:                        { fill: "rgba(255,120,60,.30)",  line: "#ff783c" },
  "activity-movement":            { fill: "rgba(150,150,150,.30)", line: "#aaa" },
  plm:                            { fill: "rgba(130,201,30,.32)",  line: "#82c91e" },
  "limbmovement-periodictwitch":  { fill: "rgba(130,201,30,.22)",  line: "#82c91e" },
  "limbmovement-twitch":          { fill: "rgba(130,201,30,.14)",  line: "rgba(130,201,30,.5)" },
};
const DEFAULT_STYLE = { fill: "rgba(120,120,120,.25)", line: "#888" };

export function eventStyle(type) {
  return EVENT_STYLE[type] || DEFAULT_STYLE;
}

// Position : NOX affiche l'état catégorisé (détecteur auto), pas l'angle brut.
export const POSITION_LABEL = {
  "position-supine": "Dos",
  "position-prone": "Ventre",
  "position-left": "Gauche",
  "position-right": "Droite",
  "position-upright": "Debout",
};
export const POSITION_COLOR = {
  "position-supine": "#495057",
  "position-prone": "#862e9c",
  "position-left": "#1c7ed6",
  "position-right": "#e8590c",
  "position-upright": "#2f9e44",
};

/**
 * Cale la résolution interne du canvas sur sa taille CSS × densité de pixels,
 * pour un rendu net (pas de ré-échantillonnage par le navigateur).
 * Appeler après mise en page et à chaque redimensionnement, avant de dessiner.
 * cv._scale porte le facteur d'échelle (épaisseur des traits, polices).
 */
export function fitCanvas(cv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(cv.clientWidth * dpr));
  const h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  cv._scale = dpr;
}

/**
 * Bornes robustes (percentiles) d'une série.
 * Au-delà de ~4000 points on échantillonne pour le tri (le percentile reste stable).
 */
export function robustRange(values, [pLo, pHi] = [0.02, 0.98]) {
  const n = values.length;
  if (!n) return [-1, 1];
  const stride = n > 4000 ? Math.ceil(n / 4000) : 1;
  const s = [];
  for (let i = 0; i < n; i += stride) {
    const v = values[i];
    if (Number.isFinite(v)) s.push(v);
  }
  if (!s.length) return [-1, 1];
  s.sort((a, b) => a - b);
  const q = p => s[Math.max(0, Math.min(s.length - 1, Math.round(p * (s.length - 1))))];
  let lo = q(pLo), hi = q(pHi);
  if (lo === hi) { lo -= 1; hi += 1; }
  return [lo, hi];
}

export function clearCanvas(cv) {
  const ctx = cv.getContext("2d");
  const S = cv._scale || 1;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = "#8886";
  ctx.font = `${11 * S}px system-ui`;
  ctx.fillText("-", 6 * S, cv.height / 2);
}

/**
 * Trace une ou plusieurs formes d'onde dans un canvas.
 * 1 courbe : échelle vraie + ligne du zéro.
 * n courbes : chaque courbe normalisée dans sa bande (comparaison de formes).
 */
export function drawWaves(cv, traces, { colors = TRACE_COLORS, range = null } = {}) {
  const ctx = cv.getContext("2d");
  const S = cv._scale || 1;
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  traces = traces.filter(t => t && t.length);
  if (!traces.length) return;

  const top = H * 0.10, band = H * 0.80;

  if (traces.length === 1) {
    let lo, hi;
    if (range && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[0] !== range[1]) {
      [lo, hi] = range;                 // échelle verrouillée (montage NOX), pas de marge
    } else {
      [lo, hi] = robustRange(traces[0]);
      const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
    }
    const y = v => top + band * (1 - (v - lo) / (hi - lo));
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = "#e2e2e2"; ctx.lineWidth = S;
      ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(W, y(0)); ctx.stroke();
    }
    strokeSeries(ctx, traces[0], W, y, colors[0], S);
    return;
  }

  traces.forEach((values, ti) => {
    let [lo, hi] = robustRange(values);
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    const y = v => top + band * (1 - (v - lo) / (hi - lo));
    strokeSeries(ctx, values, W, y, colors[ti % colors.length], S);
  });
}

/**
 * Trace une série façon NOX : un seul trait net.
 * Peu de points par pixel : polyligne directe.
 * Beaucoup de points : min→max par colonne de pixels, relié (rendu "waveform"
 * vectoriel), sans bande atténuée ni halo.
 */
export function strokeSeries(ctx, values, W, y, color, lineWidth) {
  const n = values.length;
  const H = ctx.canvas.height;
  // Une échelle verrouillée peut être plus étroite que l'excursion réelle du
  // signal (cf. Activité/Volume) : sans ce clamp, les valeurs hors bornes
  // sont mappées hors canvas et le trait disparaît au lieu de s'aplatir
  // contre le bord, comme sur NOX.
  const clampY = yy => Math.max(0, Math.min(H, yy));
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, Math.round(lineWidth));
  ctx.lineJoin = "bevel";
  ctx.lineCap = "butt";
  ctx.beginPath();

  if (n <= W * 1.5) {
    for (let i = 0; i < n; i++) {
      const px = (i / (n - 1)) * W, py = Math.round(clampY(y(values[i]))) + 0.5;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
    return;
  }

  const cols = Math.floor(W);
  let started = false;
  for (let col = 0; col < cols; col++) {
    const i0 = Math.floor((col / cols) * n);
    const i1 = Math.max(i0 + 1, Math.floor(((col + 1) / cols) * n));
    let mn = Infinity, mx = -Infinity;
    for (let i = i0; i < i1; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mn === Infinity) { started = false; continue; }
    const x = col + 0.5;
    const yMax = clampY(y(mx)), yMin = clampY(y(mn));
    if (!started) { ctx.moveTo(x, yMax); started = true; }
    else ctx.lineTo(x, yMax);
    ctx.lineTo(x, yMin);
  }
  ctx.stroke();
}

/**
 * Bande catégorielle pleine hauteur : un intervalle = un rectangle coloré avec
 * son libellé centré. Sert aux canaux où NOX affiche un état déjà catégorisé
 * (ex. Position) plutôt qu'une forme d'onde brute.
 * @param {object[]} events  [{t0, t1, type}]
 * @param {object} [opts] { labelFor, colorFor } : (type) => string
 */
export function drawCategoryBand(cv, events, t0, dur, opts = {}) {
  const { labelFor = t => t, colorFor = () => "#888" } = opts;
  const ctx = cv.getContext("2d");
  const S = cv._scale || 1;
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const x = t => ((t - t0) / dur) * W;

  ctx.font = `${11 * S}px system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const ev of events) {
    if (ev.t1 < t0 || ev.t0 > t0 + dur) continue;
    const a = Math.max(0, x(ev.t0)), b = Math.min(W, x(ev.t1));
    if (b <= a) continue;
    ctx.fillStyle = colorFor(ev.type);
    ctx.fillRect(a, 0, b - a, H);
    if (b - a > 30 * S) {
      ctx.fillStyle = "#fff";
      ctx.fillText(labelFor(ev.type), (a + b) / 2, H / 2);
    }
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/**
 * Escalier de l'hypnogramme sur toute la largeur du canvas pour la fenêtre [t0, t0+dur].
 * @param {object} [opts] { arousals:[{t0,t1}], color, lineWidth }
 */
export function drawHypnogram(cv, hypnogram, t0, dur, opts = {}) {
  const ctx = cv.getContext("2d");
  const S = cv._scale || 1;
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const rows = 5, rh = H / rows;
  // Coordonnées calées sur la grille de pixels : un trait large (pair) doit être
  // centré sur un entier, un trait fin (impair, 1px) sur un mi-pixel (+0.5) -
  // sinon un des deux bords tombe au milieu d'un pixel et s'anticrénèle (flou).
  const snap = (v, lw) => lw % 2 === 0 ? Math.round(v) : Math.round(v) + 0.5;
  const gridLW = Math.max(1, Math.round(S));
  const stageLW = Math.max(1, Math.round((opts.lineWidth || 2) * S));
  const arousalLW = Math.max(1, Math.round(2 * S));
  const x = t => snap(((t - t0) / dur) * W, stageLW);
  const yRow = r => snap(r * rh + rh / 2, stageLW);

  ctx.strokeStyle = "#8882"; ctx.lineWidth = gridLW;
  for (let r = 1; r < rows; r++) {
    const yg = snap(r * rh, gridLW);
    ctx.beginPath(); ctx.moveTo(0, yg); ctx.lineTo(W, yg); ctx.stroke();
  }

  ctx.lineWidth = stageLW;
  ctx.lineJoin = "round";
  let prev = null;
  for (const ep of hypnogram) {
    if (ep.t1 < t0 || ep.t0 > t0 + dur) { prev = null; continue; }
    const row = STAGE_ROW[ep.stage];
    if (row == null) { prev = null; continue; }
    const a = x(ep.t0), b = x(ep.t1), yv = yRow(row);
    ctx.strokeStyle = opts.color || STAGE_COLOR[ep.stage];
    ctx.beginPath(); ctx.moveTo(a, yv); ctx.lineTo(b, yv); ctx.stroke();
    if (prev && Math.abs(prev.t1 - ep.t0) < 0.01 && prev.row !== row) {
      ctx.strokeStyle = "#888";
      ctx.beginPath(); ctx.moveTo(a, yRow(prev.row)); ctx.lineTo(a, yv); ctx.stroke();
    }
    prev = { t1: ep.t1, row };
  }

  ctx.lineWidth = arousalLW;
  for (const ev of (opts.arousals || [])) {
    if (ev.t1 < t0 || ev.t0 > t0 + dur) continue;
    ctx.strokeStyle = EVENT_STYLE.arousal.line;
    const a = snap(((ev.t0 - t0) / dur) * W, arousalLW);
    ctx.beginPath(); ctx.moveTo(a, 0); ctx.lineTo(a, snap(rh * 0.5, arousalLW)); ctx.stroke();
  }
}

/**
 * Superpose des événements en bandes verticales sur un canvas de tracé.
 * @param {object[]} events  [{t0, t1, type, group}]
 * @param {object} [opts]
 *   groups   : n'afficher que ces groupes (défaut : tous)
 *   band     : "full" | "top" | "bottom"  (moitié de canvas, pour comparer 2 codages)
 *   outline  : true = contour seul, pas de remplissage
 *   label    : true = nom de l'événement en haut de la bande (si assez large)
 *   styleFor : (event) => {fill,line}  pour surcharger EVENT_STYLE
 */
export function drawEventOverlay(cv, events, t0, dur, opts = {}) {
  const { groups, band = "full", outline = false, label = true, styleFor } = opts;
  const ctx = cv.getContext("2d");
  const S = cv._scale || 1;
  const W = cv.width, H = cv.height;
  const yTop = band === "bottom" ? H / 2 : 0;
  const hBand = band === "full" ? H : H / 2;
  const x = t => ((t - t0) / dur) * W;

  ctx.save();
  ctx.font = `${10 * S}px system-ui`;
  ctx.textBaseline = "top";
  for (const ev of events) {
    if (groups && !groups.includes(ev.group)) continue;
    if (ev.t1 < t0 || ev.t0 > t0 + dur) continue;
    const st = (styleFor && styleFor(ev)) || eventStyle(ev.type);
    let a = x(ev.t0), b = x(ev.t1);
    if (b - a < 1) b = a + 1;
    if (!outline) {
      ctx.fillStyle = st.fill;
      ctx.fillRect(a, yTop, b - a, hBand);
    }
    ctx.strokeStyle = st.line;
    ctx.lineWidth = (outline ? 1.5 : 1) * S;
    ctx.strokeRect(a + 0.5, yTop + 0.5, b - a - 1, hBand - 1);
    if (label && b - a > 34 * S) {
      ctx.fillStyle = st.line;
      ctx.fillText(ev.type.replace(/^apnea-|^hypopnea-|^oxygensaturation-|^limbmovement-/, ""), a + 3 * S, yTop + 2 * S);
    }
  }
  ctx.restore();
}
