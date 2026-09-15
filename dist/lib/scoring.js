// Chargement du codage de référence (scoring.json produit par extract-scoring.py)
// et fabrication d'un "codage candidat" en injectant quelques erreurs.

/** Charge un codage depuis une URL (servi en HTTP à côté des pages). */
export async function loadScoring(url = "../scoring.json") {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
  return normalize(await r.json());
}

/** Charge un codage depuis un fichier choisi par l'utilisateur. */
export async function loadScoringFromFile(file) {
  return normalize(JSON.parse(await file.text()));
}

function normalize(data) {
  data.hypnogram ||= [];
  data.events ||= [];
  return data;
}

// Groupes d'événements qu'un candidat code réellement (respiratoire + micro-éveils).
// Le reste (désaturations, position, ronflements, jambes, activité) est calculé
// ou détecté automatiquement, pas saisi par le candidat.
const CANDIDATE_GROUPS = ["resp", "arousal"];

/**
 * Dérive un codage candidat à partir d'un codage de référence :
 * on restreint au périmètre candidat, puis on injecte 3-4 erreurs déterministes.
 * @returns {{meta, hypnogram, events, injectedErrors:object[]}}
 */
export function makeCandidate(ref) {
  const hypnogram = ref.hypnogram.map(e => ({ ...e }));
  let events = ref.events
    .filter(e => CANDIDATE_GROUPS.includes(e.group))
    .map(e => ({ ...e, src: "candidat" }));

  const resp = events
    .map((e, i) => ({ e, i }))
    .filter(x => x.e.group === "resp")
    .sort((a, b) => a.e.t0 - b.e.t0);

  const injectedErrors = [];

  // 0. faux positif précoce, visible dès la fenêtre par défaut (0-5 min) : calculé
  //    avant toute autre mutation pour repérer le plus grand trou entre deux
  //    hypopnées sur des positions d'origine, non affectées par les étapes suivantes.
  {
    let bestGapEarly = 0, bestAtEarly = null;
    for (let i = 1; i < resp.length && resp[i].e.t1 <= 290; i++) {
      const g0 = resp[i - 1].e.t1, g1 = resp[i].e.t0;
      if (g1 - g0 > bestGapEarly) { bestGapEarly = g1 - g0; bestAtEarly = (g0 + g1) / 2; }
    }
    if (bestAtEarly != null && bestGapEarly > 15) {
      const fp2 = { t0: +(bestAtEarly - 5).toFixed(3), t1: +(bestAtEarly + 5).toFixed(3),
        type: "hypopnea", group: "resp", src: "candidat" };
      events.push(fp2);
      injectedErrors.push({
        kind: "faux-positif-precoce", type: fp2.type, ev: fp2,
        note: `hypopnée codée sans événement de référence, fenêtre par défaut : ${fmt(fp2.t0)}–${fmt(fp2.t1)}`,
        t0: fp2.t0, t1: fp2.t1,
      });
    }
  }

  // 1. décalage temporel : un événement placé trop tard et trop court
  //    (décalage sévère, hors tolérance : doit ressortir manqué + ajouté à tort)
  if (resp.length > 4) {
    const { e } = resp[3];
    const oldT0 = e.t0, oldT1 = e.t1;
    e.t0 = +(e.t0 + 12).toFixed(3);
    e.t1 = +(Math.max(e.t0 + 4, e.t1 - 5)).toFixed(3);
    injectedErrors.push({
      kind: "decalage", type: e.type, ev: e,
      note: `événement décalé (hors tolérance) : ${fmt(oldT0)}–${fmt(oldT1)} → ${fmt(e.t0)}–${fmt(e.t1)}`,
      t0: e.t0, t1: e.t1, oldT0, oldT1,
    });
  }

  // 1bis. petits décalages, dans la tolérance : quelques événements légèrement
  //       déplacés (+2s, durée conservée) mais qui doivent rester appariés, pour
  //       vérifier que le seuil IoU (MATCH_IOU_THRESHOLD) tolère bien un placement
  //       raisonnable et ne signale pas tout écart comme une erreur.
  const TOLERATED_SHIFT_S = 2;
  for (const idx of [1, 10, 20, 30]) {
    if (resp.length <= idx) continue;
    const { e } = resp[idx];
    const oldT0 = e.t0, oldT1 = e.t1;
    e.t0 = +(e.t0 + TOLERATED_SHIFT_S).toFixed(3);
    e.t1 = +(e.t1 + TOLERATED_SHIFT_S).toFixed(3);
    injectedErrors.push({
      kind: "decalage-tolere", type: e.type, ev: e,
      note: `léger décalage (+${TOLERATED_SHIFT_S}s, dans la tolérance) : ${fmt(oldT0)}–${fmt(oldT1)} → ${fmt(e.t0)}–${fmt(e.t1)}`,
      t0: e.t0, t1: e.t1, oldT0, oldT1,
    });
  }

  // 2. omission : un événement respiratoire non codé
  if (resp.length > 7) {
    const missed = resp[6].e;
    events = events.filter(x => x !== missed);
    injectedErrors.push({
      kind: "omission", type: missed.type, ev: missed,
      note: `événement de référence non codé : ${missed.type} ${fmt(missed.t0)}–${fmt(missed.t1)}`,
      t0: missed.t0, t1: missed.t1,
    });
  }

  // 3. faux positif : une hypopnée là où la référence n'en a pas
  //    (plus grand trou entre deux événements resp, dans le tiers central de la nuit)
  const total = ref.meta.edf_duration_s || (hypnogram.at(-1)?.t1 ?? 0);
  const midLo = total / 3, midHi = (2 * total) / 3;
  let bestGap = 0, bestAt = null;
  for (let i = 1; i < resp.length; i++) {
    const g0 = resp[i - 1].e.t1, g1 = resp[i].e.t0;
    if (g0 < midLo || g1 > midHi) continue;
    if (g1 - g0 > bestGap) { bestGap = g1 - g0; bestAt = (g0 + g1) / 2; }
  }
  if (bestAt != null && bestGap > 60) {
    const fp = { t0: +(bestAt - 10).toFixed(3), t1: +(bestAt + 10).toFixed(3),
      type: "hypopnea", group: "resp", src: "candidat" };
    events.push(fp);
    injectedErrors.push({
      kind: "faux-positif", type: fp.type, ev: fp,
      note: `hypopnée codée sans événement de référence : ${fmt(fp.t0)}–${fmt(fp.t1)}`,
      t0: fp.t0, t1: fp.t1,
    });
  }

  // 4. erreur de stade : une époque N2 du milieu de nuit passée en N1
  const n2mid = hypnogram.filter(e => e.stage === "n2" && e.t0 > midLo && e.t0 < midHi);
  if (n2mid.length) {
    const ep = n2mid[Math.floor(n2mid.length / 2)];
    ep.stage = "n1";
    injectedErrors.push({
      kind: "stade", type: "n2 → n1",
      note: `stade modifié à ${fmt(ep.t0)} : N2 → N1`,
      t0: ep.t0, t1: ep.t1,
    });
  }

  events.sort((a, b) => a.t0 - b.t0);
  return {
    meta: { ...ref.meta, revision: (ref.meta.revision || "?") + " (candidat simulé)" },
    hypnogram, events, injectedErrors,
  };
}

export function fmt(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// Seuil de recouvrement fixe pour l'appariement référence/candidat (test 3, §11
// du CDC). Non réglable en V1 : la tolérance fine reste appréciée à l'œil par
// le correcteur (cf. CDC §10, "en V1 cette tolérance reste appréciée à l'œil").
// Ce seuil sert uniquement à trier automatiquement apparié / manqué / ajouté à
// tort avant l'examen visuel, pas à noter la correction.
export const MATCH_IOU_THRESHOLD = 0.3;

/** Intersection sur union de deux intervalles {t0,t1}. */
function iou(a, b) {
  const lo = Math.max(a.t0, b.t0), hi = Math.min(a.t1, b.t1);
  const overlap = Math.max(0, hi - lo);
  if (overlap <= 0) return 0;
  const union = Math.max(a.t1, b.t1) - Math.min(a.t0, b.t0);
  return union > 0 ? overlap / union : 0;
}

/**
 * Apparie les événements candidat aux événements de référence (même groupe,
 * recouvrement IoU > seuil), un-à-un, glouton par meilleur score.
 * @returns {{matched:object[], missed:object[], falsePositive:object[], threshold:number}}
 *   matched[i] = { ref, cand, iou, sameType }
 */
export function compareEvents(refEvents, candEvents, threshold = MATCH_IOU_THRESHOLD) {
  const usedCand = new Set();
  const matched = [];
  const missed = [];
  for (const ref of refEvents) {
    let best = null, bestScore = 0;
    for (const cand of candEvents) {
      if (usedCand.has(cand) || cand.group !== ref.group) continue;
      const score = iou(ref, cand);
      if (score > threshold && score > bestScore) { best = cand; bestScore = score; }
    }
    if (best) { usedCand.add(best); matched.push({ ref, cand: best, iou: bestScore, sameType: best.type === ref.type }); }
    else missed.push(ref);
  }
  const falsePositive = candEvents.filter(c => !usedCand.has(c));
  return { matched, missed, falsePositive, threshold };
}

/**
 * Compare époque par époque le stade candidat au stade de référence (alignement
 * par t0, l'hypnogramme candidat suit toujours le même découpage temporel).
 * @returns {{t0,t1,refStage,candStage,match}[]}
 */
export function compareHypnogram(refHyp, candHyp) {
  const byT0 = new Map(candHyp.map(e => [e.t0, e]));
  return refHyp.map(ep => {
    const cand = byT0.get(ep.t0);
    return { t0: ep.t0, t1: ep.t1, refStage: ep.stage, candStage: cand ? cand.stage : null, match: !!cand && cand.stage === ep.stage };
  });
}
