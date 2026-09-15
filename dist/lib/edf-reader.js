// Lecture EDF/EDF+ côté navigateur, sans librairie.
// Lecture partielle via File.slice() : l'en-tête et chaque fenêtre temporelle
// sont lus à la demande, le fichier n'est jamais chargé en entier.
//
// Validé sur un export NOX de 641 Mo (recalcul de taille exact, valeurs
// identiques à une référence Python). Voir index.html / proto-vue-nox.html.

const ascii = (buf, off, len) =>
  new TextDecoder("latin1").decode(new Uint8Array(buf, off, len)).trim();

/**
 * Parse l'en-tête EDF+ (256 o fixes + 256 o par signal).
 * @param {File|Blob} file
 * @returns {Promise<object>} edf : { file, headerBytes, nDataRecords, recDuration,
 *   ns, signals[], recordBytes, sigOffsets[], totalDuration, startSecOfDay, header{} }
 */
export async function parseEdfHeader(file) {
  const fixed = await file.slice(0, 256).arrayBuffer();

  const version      = ascii(fixed, 0, 8);
  const patientId    = ascii(fixed, 8, 80);
  const recordingId  = ascii(fixed, 88, 80);
  const startDate    = ascii(fixed, 168, 8);
  const startTime    = ascii(fixed, 176, 8);
  const headerBytes  = parseInt(ascii(fixed, 184, 8), 10);
  const reserved     = ascii(fixed, 192, 44);
  const nDataRecords = parseInt(ascii(fixed, 236, 8), 10);
  const recDuration  = parseFloat(ascii(fixed, 244, 8));
  const ns           = parseInt(ascii(fixed, 252, 4), 10);

  if (!Number.isFinite(ns) || ns <= 0) throw new Error(`nombre de signaux invalide (${ns})`);
  if (!Number.isFinite(headerBytes) || headerBytes < 256 + ns * 256)
    throw new Error("taille d'en-tête incohérente");

  const hbuf = await file.slice(256, 256 + ns * 256).arrayBuffer();
  const blk = (base, size, i) => ascii(hbuf, base + i * size, size);
  const b = 16 * ns + 80 * ns + 8 * ns; // saut label + transducer + dimension physique

  const signals = [];
  const sigOffsets = [];
  let recordBytes = 0;
  for (let i = 0; i < ns; i++) {
    const pmin = parseFloat(blk(b, 8, i));
    const pmax = parseFloat(blk(b + 8 * ns, 8, i));
    const dmin = parseFloat(blk(b + 16 * ns, 8, i));
    const dmax = parseFloat(blk(b + 24 * ns, 8, i));
    const nsamp = parseInt(blk(b + 112 * ns, 8, i), 10);
    signals.push({
      index: i,
      label: blk(0, 16, i),
      unit: blk(16 * ns + 80 * ns, 8, i),
      prefiltering: blk(16 * ns + 80 * ns + 40 * ns, 80, i),
      pmin, pmax, dmin, dmax, nsamp,
      scale: (pmax - pmin) / (dmax - dmin),
      fs: nsamp / recDuration,
    });
    sigOffsets.push(recordBytes);
    recordBytes += nsamp * 2;
  }

  const [h, m, s] = startTime.split(/[.:]/).map(Number);
  const expectedSize = headerBytes + nDataRecords * recordBytes;

  return {
    file, headerBytes, nDataRecords, recDuration, ns,
    signals, recordBytes, sigOffsets,
    totalDuration: nDataRecords * recDuration,
    startSecOfDay: (h || 0) * 3600 + (m || 0) * 60 + (s || 0),
    header: {
      version, patientId, recordingId, startDate, startTime, reserved,
      expectedSize, sizeMatches: expectedSize === file.size,
    },
  };
}

/**
 * Fichier distant sliçable : expose .size et .slice(a,b).arrayBuffer() en
 * ne téléchargeant que la plage demandée (HTTP Range). Utilisable partout où
 * parseEdfHeader / readWindow attendent un File.
 */
export function remoteFile(url, size) {
  let warnedNoRange = false;
  return {
    size,
    slice(start, end) {
      return {
        arrayBuffer: async () => {
          const r = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
          if (!r.ok && r.status !== 206) throw new Error(`${url} : HTTP ${r.status}`);
          const buf = await r.arrayBuffer();
          // Serveur (ou proxy) qui ignore Range : 200 + corps complet.
          // On découpe côté client pour rester correct, au prix du transfert.
          if (r.status !== 206 && buf.byteLength > end - start) {
            if (!warnedNoRange) {
              console.warn(`${url} : le serveur ignore Range, transfert complet à chaque fenêtre. Utiliser serve.py.`);
              warnedNoRange = true;
            }
            return buf.slice(start, end);
          }
          return buf;
        },
      };
    },
  };
}

/** Ouvre un EDF servi en HTTP : récupère sa taille puis parse l'en-tête. */
export async function openRemoteEdf(url) {
  const head = await fetch(url, { method: "HEAD" });
  const size = Number(head.headers.get("content-length"));
  if (!size) throw new Error("taille du fichier inconnue (Content-Length absent)");
  return parseEdfHeader(remoteFile(url, size));
}

/**
 * Lit une fenêtre temporelle pour un ou plusieurs signaux, via un seul slice.
 * @param {object} edf
 * @param {number[]} signalIndexes
 * @param {number} t0Sec  début souhaité (s depuis le début de l'enregistrement)
 * @param {number} durSec durée souhaitée
 * @param {object} [opts] { prerollSec } : lit en plus `prerollSec` avant t0 pour
 *   laisser un filtre se stabiliser. Les tableaux renvoyés INCLUENT ces échantillons
 *   en tête ; `prerollById[index]` dit combien en sauter pour retomber sur la fenêtre.
 * @returns {Promise<{t0, dur, byId, prerollById, bytesRead}>}
 */
export async function readWindow(edf, signalIndexes, t0Sec, durSec, opts = {}) {
  const t0 = Math.max(0, Math.min(edf.totalDuration - 1, t0Sec));
  const dur = Math.max(0, Math.min(durSec, edf.totalDuration - t0));
  const preroll = Math.min(t0, Math.max(0, opts.prerollSec || 0));
  const readStart = t0 - preroll;

  const r0 = Math.floor(readStart / edf.recDuration);
  const r1 = Math.min(edf.nDataRecords, Math.ceil((t0 + dur) / edf.recDuration));
  const byteStart = edf.headerBytes + r0 * edf.recordBytes;
  const byteEnd = edf.headerBytes + r1 * edf.recordBytes;

  const buf = await edf.file.slice(byteStart, byteEnd).arrayBuffer();
  const view = new DataView(buf);
  const nRec = r1 - r0;

  const byId = {};
  const prerollById = {};
  for (const idx of signalIndexes) {
    const sig = edf.signals[idx];
    const { nsamp, dmin, scale, pmin } = sig;
    const full = new Float64Array(nsamp * nRec);
    let w = 0;
    for (let r = 0; r < nRec; r++) {
      let off = r * edf.recordBytes + edf.sigOffsets[idx];
      for (let k = 0; k < nsamp; k++, off += 2) {
        full[w++] = (view.getInt16(off, true) - dmin) * scale + pmin;
      }
    }
    const from = Math.round((readStart - r0 * edf.recDuration) * sig.fs);
    const preSamp = Math.round(preroll * sig.fs);
    const count = Math.round(dur * sig.fs);
    byId[idx] = full.subarray(from, from + preSamp + count);
    prerollById[idx] = preSamp;
  }

  return { t0, dur, byId, prerollById, bytesRead: buf.byteLength };
}

/** Passe-haut une passe (IIR premier ordre). Supprime la dérive lente. */
export function highpass(x, fs, fc) {
  const dt = 1 / fs, rc = 1 / (2 * Math.PI * fc), a = rc / (rc + dt);
  const y = new Float64Array(x.length);
  let yp = 0, xp = x.length ? x[0] : 0;
  for (let i = 0; i < x.length; i++) {
    yp = a * (yp + x[i] - xp);
    xp = x[i];
    y[i] = yp;
  }
  return y;
}

/** Passe-bas une passe (IIR premier ordre). Lisse le bruit et l'ondulation cardiaque. */
export function lowpass(x, fs, fc) {
  const dt = 1 / fs, rc = 1 / (2 * Math.PI * fc), a = dt / (rc + dt);
  const y = new Float64Array(x.length);
  let yp = x.length ? x[0] : 0;
  for (let i = 0; i < x.length; i++) {
    yp += a * (x[i] - yp);
    y[i] = yp;
  }
  return y;
}

/** Linéarisation racine carrée (pression canule -> débit) : sign(v)·sqrt(|v|). */
export function sqrtLinearize(x) {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = Math.sign(x[i]) * Math.sqrt(Math.abs(x[i]));
  return y;
}

/** Secondes -> "HH:MM:SS" (avec passage minuit). */
export function fmtClock(sec) {
  const t = ((sec % 86400) + 86400) % 86400;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Secondes -> "Nh MM". */
export function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return `${h} h ${String(m).padStart(2, "0")}`;
}
