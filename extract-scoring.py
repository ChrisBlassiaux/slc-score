#!/usr/bin/env python3
"""
Extrait le codage de RÉFÉRENCE (corrigé expert) de l'étude Noxturnal
(Data.ndb, SQLite) vers scoring.json, aligné sur le début de l'EDF.

Data.ndb : tables scoring_revision / scoring_key / scoring_marker.
- starts_at / ends_at : ticks .NET (100 ns depuis l'an 1), heure locale naïve.
- Aligné sur le début du EDF (30/01/2023 21:30:09) -> secondes depuis le début.

Le scoring manuel de l'expert est éclaté sur plusieurs clés (26 pour le début de
nuit, 27 et 28 pour la suite) et a des trous (l'expert n'a pas tout relu). Pour
respiratoire et micro-éveils, on comble ces trous avec le détecteur automatique
correspondant (clé 15 / clé 12), en écartant les détections auto qui font double
emploi avec un événement déjà scoré à la main (chevauchement > 30 % du plus court
des deux). Chaque événement garde `src` = "manuel" ou "auto". Les événements que
l'expert ne score jamais à la main (désaturations, position, ronflement, jambes)
viennent directement des détecteurs automatiques.

Usage : python3 extract-scoring.py
"""
import os, sqlite3, datetime, json

BASE = os.path.dirname(os.path.abspath(__file__))
STUDY_DIR = next(x for x in os.listdir(BASE) if x.startswith("ZAM"))
NDB = os.path.join(BASE, STUDY_DIR, "Data.ndb")

EDF_START = datetime.datetime(2023, 1, 30, 21, 30, 9)
EDF_DURATION_S = 39290
DOTNET_EPOCH = datetime.datetime(1, 1, 1)
START_TICK = int((EDF_START - DOTNET_EPOCH).total_seconds() * 1e7)

REVISION_ID = 2  # "EPNOS" v1

# groupe d'affichage -> clés de scoring qui l'alimentent, DANS L'ORDRE DE PRIORITÉ.
# Le manuel passe toujours en premier ; l'auto qui suit ne comble que les trous
# (voir OVERLAP_DEDUP_GROUPS plus bas).
GROUP_KEYS = {
    "hypnogram": [26],               # stades manuels (nuit complète)
    "arousal":   [26, 12],           # micro-éveils : manuel, auto en comblement des trous
    "resp":      [26, 27, 28, 15],   # apnées/hypopnées/RERA : manuel (éclaté sur 3 clés), auto en comblement
    "desat":     [22],               # auto uniquement (jamais scoré à la main)
    "snore":     [17],               # auto
    "position":  [13],               # auto
    "limb":      [21, 25],           # auto
    "activity":  [14],               # auto
}

# groupes où un événement qui chevauche un événement déjà retenu est écarté
# (sert à ne pas dupliquer un événement auto déjà repris/corrigé à la main)
OVERLAP_DEDUP_GROUPS = {"resp", "arousal"}
OVERLAP_THRESHOLD = 0.3  # fraction de la durée du plus court des deux

# types de marqueurs gardés par groupe (on écarte le per-breath : breath-normal, snorebreath...)
KEEP = {
    "hypnogram": {"sleep-wake", "sleep-n1", "sleep-n2", "sleep-n3", "sleep-rem"},
    "resp": {"hypopnea", "apnea-obstructive", "apnea-central", "apnea-mixed", "rera"},
    "desat": {"oxygensaturation-drop"},
    "arousal": {"arousal"},
    "snore": {"snore-train"},
    "position": {"position-supine", "position-left", "position-right", "position-prone", "position-upright"},
    "limb": {"plm", "limbmovement-periodictwitch", "limbmovement-twitch"},
    "activity": {"activity-movement"},
}


def sec(tick):
    return round((tick - START_TICK) / 1e7, 3)


def overlaps(a, b, threshold=OVERLAP_THRESHOLD):
    """a, b : (t0, t1). Vrai si le recouvrement dépasse `threshold` de la plus courte durée."""
    lo, hi = max(a[0], b[0]), min(a[1], b[1])
    ov = max(0.0, hi - lo)
    shortest = min(a[1] - a[0], b[1] - b[0])
    return shortest > 0 and ov > threshold * shortest


def main():
    con = sqlite3.connect(f"file:{NDB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row

    rev = con.execute("SELECT * FROM scoring_revision WHERE id=?", (REVISION_ID,)).fetchone()
    key_type = {r["id"]: r["type"] for r in con.execute("SELECT id, type FROM scoring_key")}

    hypnogram = []
    events = []
    dropped_dupes = {}

    for group, kids in GROUP_KEYS.items():
        keep_types = KEEP[group]
        dedup_overlap = group in OVERLAP_DEDUP_GROUPS
        kept_spans = []   # (t0, t1) déjà retenus dans ce groupe, pour la dédup par chevauchement
        n_dropped = 0

        for kid in kids:
            src = "manuel" if key_type.get(kid) == "Manual" else "auto"
            rows = con.execute(
                "SELECT starts_at, ends_at, type FROM scoring_marker "
                "WHERE key_id=? AND is_deleted=0 ORDER BY starts_at", (kid,))
            for r in rows:
                if r["type"] not in keep_types:
                    continue
                t0, t1 = sec(r["starts_at"]), sec(r["ends_at"])
                if t1 <= 0 or t0 >= EDF_DURATION_S:
                    continue
                t0 = max(0.0, t0)
                t1 = min(float(EDF_DURATION_S), t1)

                if dedup_overlap and any(overlaps((t0, t1), s) for s in kept_spans):
                    n_dropped += 1
                    continue
                kept_spans.append((t0, t1))

                if group == "hypnogram":
                    hypnogram.append({"t0": t0, "t1": t1, "stage": r["type"].split("-", 1)[1]})
                else:
                    events.append({"t0": t0, "t1": round(t1, 3),
                                    "type": r["type"], "group": group, "src": src})

        if n_dropped:
            dropped_dupes[group] = n_dropped

    hypnogram.sort(key=lambda e: e["t0"])
    events.sort(key=lambda e: e["t0"])

    out = {
        "meta": {
            "study": STUDY_DIR,
            "revision": rev["name"],
            "scoring": "manuel (expert) + auto en comblement des trous pour resp/arousal ; "
                       "auto seul pour désat/position/ronflement/jambes/activité",
            "start_clock": EDF_START.strftime("%H:%M:%S"),
            "start_date": EDF_START.strftime("%Y-%m-%d"),
            "edf_duration_s": EDF_DURATION_S,
        },
        "hypnogram": hypnogram,
        "events": events,
    }

    dst = os.path.join(BASE, "scoring.json")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    by_group = {}
    by_group_src = {}
    for e in events:
        by_group[e["group"]] = by_group.get(e["group"], 0) + 1
        by_group_src[(e["group"], e["src"])] = by_group_src.get((e["group"], e["src"]), 0) + 1
    n5 = sum(1 for e in events if e["group"] == "resp" and e["t0"] < 300)

    print(f"scoring.json écrit : {os.path.getsize(dst)/1024:.0f} Ko")
    print(f"  hypnogramme : {len(hypnogram)} époques")
    print(f"  événements  : {len(events)}  {by_group}")
    print(f"  détail manuel/auto : {by_group_src}")
    print(f"  doublons auto écartés (chevauchement avec du manuel) : {dropped_dupes}")
    print(f"  contrôle : {n5} événements respiratoires dans les 5 premières minutes")


if __name__ == "__main__":
    main()
