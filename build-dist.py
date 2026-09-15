#!/usr/bin/env python3
"""
Construit dist/ : une démo autonome et anonymisée pour GitHub Pages, à partir
des fichiers de travail à la racine (jamais modifiés par ce script).

- enregistement-nox-complet.edf -> dist/enregistement-nox-complet.edf
  tronqué à TARGET_RECORDS enregistrements (~96 min, sous les 100 Mo de
  GitHub), champs patient_id/recording_id de l'en-tête vidés (non anonymisés
  à la source, cf. mémoire "tests-techniques-env").
- scoring.json / montage.json -> dist/*.json
  événements/hypnogramme tronqués à la même durée, champ meta.study
  (nom du dossier d'étude natif, potentiellement des initiales patient)
  remplacé par un texte neutre.
- lib/*.js, tests/*.html, tests/index.html -> copiés tels quels dans dist/.

Usage : python3 build-dist-edf.py
"""
import json
import os
import shutil

TARGET_RECORDS = 580  # ~96,7 min, ~94,7 Mo, sous la limite de 100 Mo de GitHub
DURATION_S = TARGET_RECORDS * 10

os.makedirs("dist/lib", exist_ok=True)
os.makedirs("dist/tests", exist_ok=True)


def build_edf():
    with open("enregistement-nox-complet.edf", "rb") as f:
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

    # Anonymisation : champs patient_id (8-88) et recording_id (88-168), texte
    # ASCII à largeur fixe -> remplacés par des espaces de même longueur.
    header[8:88] = b" " * 80
    header[88:168] = b" " * 80
    header[236:244] = f"{TARGET_RECORDS:<8d}".encode()[:8]

    dst = "dist/enregistement-nox-complet.edf"
    with open(dst, "wb") as out:
        out.write(header)
        out.write(sig_headers)
        out.write(data)
    print(f"{dst} : {os.path.getsize(dst)/1e6:.1f} Mo, {TARGET_RECORDS} enregistrements = {DURATION_S/60:.1f} min")


def clip_events(items):
    out = []
    for e in items:
        if e["t0"] >= DURATION_S:
            continue
        e = dict(e)
        if e["t1"] > DURATION_S:
            e["t1"] = float(DURATION_S)
        out.append(e)
    return out


def build_scoring():
    data = json.load(open("scoring.json"))
    data["hypnogram"] = clip_events(data["hypnogram"])
    data["events"] = clip_events(data["events"])
    data["meta"]["edf_duration_s"] = DURATION_S
    data["meta"]["study"] = "anonymise"
    with open("dist/scoring.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"dist/scoring.json : {len(data['hypnogram'])} époques, {len(data['events'])} événements")


def build_montage():
    data = json.load(open("montage.json"))
    data["study"] = "anonymise"
    with open("dist/montage.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("dist/montage.json écrit")


def copy_code():
    for name in os.listdir("lib"):
        if name.endswith(".js"):
            shutil.copy(f"lib/{name}", f"dist/lib/{name}")
    for name in os.listdir("tests"):
        if name.endswith(".html"):
            shutil.copy(f"tests/{name}", f"dist/tests/{name}")
    shutil.copy("tests/index.html", "dist/index.html")
    print("dist/lib, dist/tests, dist/index.html copiés")


if __name__ == "__main__":
    build_edf()
    build_scoring()
    build_montage()
    copy_code()
