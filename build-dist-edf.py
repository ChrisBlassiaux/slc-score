#!/usr/bin/env python3
"""
Construit un extrait anonymise de l'EDF pour la demo GitHub Pages (dist/) :
- tronque a TARGET_RECORDS enregistrements (~96 min, sous les 100 Mo de GitHub)
- vide les champs patient_id / recording_id de l'en-tete (donnees non anonymisees
  a la source, cf. memoire "tests-techniques-env")
- ne touche a rien d'autre (en-tetes de signaux, calibration, donnees) : le
  fichier reste un EDF+ valide, lisible par lib/edf-reader.js sans changement

Usage : python3 build-dist-edf.py
"""
import os

SRC = "enregistement-nox-complet.edf"
DST = "dist/enregistement-nox-complet.edf"
TARGET_RECORDS = 580  # ~96,7 min, ~94,7 Mo, sous la limite de 100 Mo de GitHub

with open(SRC, "rb") as f:
    header = bytearray(f.read(256))
    ns = int(header[252:256].decode().strip())
    sig_headers = f.read(ns * 256)

    # nsamp par signal : dernier bloc de 8 octets x ns avant le "reserved" final
    # (label 16*ns, transducer 80*ns, phys_dim 8*ns, phys_min 8*ns, phys_max 8*ns,
    #  dig_min 8*ns, dig_max 8*ns, prefiltering 80*ns, nsamp 8*ns, reserved 32*ns)
    off = (16 + 80 + 8 + 8 + 8 + 8 + 8 + 80) * ns
    nsamp = [int(sig_headers[off + i * 8: off + i * 8 + 8].decode().strip()) for i in range(ns)]
    record_bytes = sum(n * 2 for n in nsamp)

    header_bytes = 256 + ns * 256
    f.seek(header_bytes)
    data = f.read(TARGET_RECORDS * record_bytes)

assert len(data) == TARGET_RECORDS * record_bytes, "fichier source trop court pour cette troncature"

# Anonymisation : champs patient_id (8-88) et recording_id (88-168), texte ASCII
# a largeur fixe -> on les remplace par des espaces de meme longueur.
header[8:88] = b" " * 80
header[88:168] = b" " * 80
# nombre d'enregistrements (236-244), a jour avec la troncature.
header[236:244] = f"{TARGET_RECORDS:<8d}".encode()[:8]

os.makedirs("dist", exist_ok=True)
with open(DST, "wb") as out:
    out.write(header)
    out.write(sig_headers)
    out.write(data)

size = os.path.getsize(DST)
print(f"{DST} ecrit : {size/1e6:.1f} Mo, {TARGET_RECORDS} enregistrements = {TARGET_RECORDS*10/60:.1f} min")
