// Ordre et correspondances des canaux, calqués sur la config NOX "Respi PSG"
// du fichier de test (voir capture NOX de référence).
//
// match : labels de canaux EDF candidats, par ordre de préférence.
// Pour Thorax/Abdomen, NOX superpose la sangle brute + une RIP calibrée qu'il
// calcule ; cette 2e courbe n'est pas dans l'EDF (Chest ≡ Thorax rapide,
// corrélation 0,999), d'où une seule courbe ici.

export const RESPI_LAYOUT = [
  { name: "Activité",             unit: "g/s",   match: ["Activity"] },
  { name: "Position",             unit: "°",     match: ["PosAngle", "Elevation"] },
  { name: "Volume (Ronflement)",  unit: "dB",    match: ["Audio Volume dB"] },
  { name: "Ronflements",          unit: "cmH2O", match: ["Snore"] },
  { name: "Flux nasal (Lunette)", unit: "cmH2O", match: ["Nasal Pressure", "Flow"] },
  { name: "cRIP Flow",            unit: "V/s",   match: ["cRIP Flow", "RIP Flow"] },
  { name: "Resp Rate",            unit: "rpm",   match: ["Resp Rate"] },
  { name: "SpO2",                 unit: "%",     match: ["Saturation", "SpO2 B-B"] },
  { name: "Thorax",               unit: "V",     match: ["Thorax rapide", "Chest"] },
  { name: "Abdomen",              unit: "V",     match: ["Abdomen rapide", "Abdomen"] },
  { name: "Pouls",                unit: "bpm",   match: ["Pulse", "Heart Rate"] },
  { name: "Pléth",                unit: "",      match: ["Pulse Waveform"] },
  { name: "Jambe gauche",         unit: "V",     match: ["Left Leg"] },
  { name: "Jambe droite",         unit: "V",     match: ["Right Leg"] },
];

// Quel groupe d'événements du codage se superpose à quel(s) panneau(x).
export const GROUP_TO_PANEL = {
  resp:     ["Flux nasal (Lunette)"],
  desat:    ["SpO2"],
  snore:    ["Ronflements"],
  position: ["Position"],
  activity: ["Activité"],
  limb:     ["Jambe gauche", "Jambe droite"],
};

/**
 * Résout la layout NOX contre les canaux réellement présents dans l'EDF.
 * @param {object} edf  résultat de parseEdfHeader
 * @param {object[]} [layout=RESPI_LAYOUT]
 * @returns {{def:object, sigs:object[]}[]}  sigs vide = canal absent
 */
export function resolvePanels(edf, layout = RESPI_LAYOUT) {
  const pick = list => {
    for (const label of (list || [])) {
      const s = edf.signals.find(x => x.label === label);
      if (s) return s;
    }
    return null;
  };
  return layout.map(def => ({
    def,
    sigs: [pick(def.match), pick(def.match2)].filter(Boolean),
  }));
}

// --- montage NOX réel (extract-montage.py -> montage.json) -------------------

// type interne NOX -> label(s) de canal EDF, par ordre de préférence
export const NOX_TYPE_TO_EDF = {
  "Activity-Gravity":               ["Activity"],
  "Pos.Angle-Gravity":              ["PosAngle"],
  "Snore.Envelope-Audio.dB":        ["Audio Volume dB"],
  "Resp.Snore-Cannula.Nasal":       ["Snore"],
  "Resp.Flow-Cannula.Nasal":        ["Flow", "Nasal Pressure"],
  "Resp.FlowCal-RIP":               ["cRIP Flow", "RIP Flow"],
  "EMG.Submental-1":                ["1"],
  "EMG.Submental-2":                ["2"],
  "SpO2.Averaged-Probe":            ["Saturation", "SpO2 B-B"],
  "Resp.Movement-Inductive.Thorax": ["Thorax rapide", "Chest"],
  "Resp.Movement-Inductive.Abdomen":["Abdomen rapide", "Abdomen"],
  "Pulse.Averaged-Probe":           ["Pulse", "Heart Rate"],
  "HeartRate-ECG":                  ["Heart Rate"],
  "Pleth":                          ["Pulse Waveform"],
  "EMG.Tibialis-Leg.Left":          ["Left Leg"],
  "EMG.Tibialis-Leg.Right":         ["Right Leg"],
};

const NAMED_COLOR = { Blue: "#3a86ff", Red: "#e8590c", Green: "#2f9e44", Black: "#1e1e1e" };

/** "4,94m" -> 296.4 s ; "30s" -> 30 s */
export function parseNoxDuration(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().replace(",", ".").match(/^([\d.]+)\s*([ms])$/i);
  if (!m) return null;
  return m[2].toLowerCase() === "m" ? parseFloat(m[1]) * 60 : parseFloat(m[1]);
}

/**
 * Construit les panneaux d'une feuille à partir du montage NOX extrait.
 * @param {object} edf
 * @param {object} montage  contenu de montage.json
 * @param {string} [sheetName="Respi PSG"]
 * @returns {{sheet, windowSec, halfStepSec, panels:[{label,sig,hp,lp,range,color,inverted,fill}]}}
 */
export function buildMontage(edf, montage, sheetName = "Respi PSG") {
  const sheet = (montage.sheets || []).find(s => s.name === sheetName) || null;
  const panels = sheet ? sheet.channels.map(c => {
    // NOX exporte déjà les dérivations bipolaires comme des canaux EDF à part
    // entière (ex. "F4-M1", "1-F") : le nom NOX correspond donc souvent tel
    // quel à un label EDF. On ne retombe sur la table de correspondance que
    // si aucun canal ne porte exactement ce nom (ex. "Menton 1" -> "1").
    // Exception : "Abdomen" existe aussi comme canal EDF lent (25 Hz) distinct
    // de la version rapide "Abdomen rapide" (200 Hz, pairée avec Thorax) -
    // la correspondance directe attraperait la mauvaise piste.
    let sig = c.label === "Abdomen" ? null : edf.signals.find(x => x.label === c.label);
    if (!sig) {
      for (const L of (NOX_TYPE_TO_EDF[c.signal_type] || [])) {
        sig = edf.signals.find(x => x.label === L);
        if (sig) break;
      }
    }
    return {
      label: c.label,
      signalType: c.signal_type,
      sig,
      hp: c.highpass_hz || 0,
      lp: c.lowpass_hz || 0,
      range: c.axis_locked ? [c.axis_low, c.axis_high] : null,
      color: NAMED_COLOR[c.color] || c.color || "#3a86ff",
      inverted: !!c.inverted,
      fill: !!c.fill,
    };
  }) : [];
  return {
    sheet,
    windowSec: (sheet && parseNoxDuration(sheet.window)) || 300,
    halfStepSec: (sheet && parseNoxDuration(sheet.half_step)) || 150,
    panels,
  };
}
