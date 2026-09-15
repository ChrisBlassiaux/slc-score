# Tests techniques SLC-SCORE

Tests de faisabilité de la section 11 du cahier des charges. Chaque test est isolé
dans sa propre page sous `tests/`, la plomberie commune est dans `lib/`.

## Lancer

```bash
python3 serve.py          # port 8000, depuis la racine du projet
```

Puis ouvrir http://localhost:8000/tests/

`serve.py` gère les requêtes HTTP Range : les pages ne téléchargent que les octets
de la fenêtre affichée (206 Partial Content), comme l'architecture cible (§7.6).
Ne pas utiliser `python3 -m http.server` : le stdlib ignore Range et renverrait
les 641 Mo de l'EDF à chaque fenêtre.

## Arborescence

```
enregistement-nox-complet.edf   EDF+ de test (641 Mo, export NOX)
scoring.json                    codage de référence extrait de Data.ndb
extract-scoring.py              extracteur Data.ndb (SQLite) -> scoring.json
extract-montage.py              extracteur Data.ndb (.NET/MS-NRBF) -> montage.json
                                (feuilles, canaux, ordre, couleurs, filtres HP/LP, échelles)
montage.json                    montage d'affichage NOX (utilisé par test 1)
serve.py                        serveur statique local avec support HTTP Range
ZAM PEH PSG intéressante/       étude Noxturnal native (signaux .ndf + Data.ndb)

lib/
  edf-reader.js      parseEdfHeader, readWindow, highpass, fmtClock, fmtDur
  nox-layout.js      RESPI_LAYOUT, resolvePanels, GROUP_TO_PANEL
  trace-render.js    drawWaves, drawHypnogram, drawEventOverlay, styles
  scoring.js         loadScoring, loadScoringFromFile, makeCandidate

tests/
  index.html                    page d'accueil des tests
  test-1-affichage-nox.html     (à créer)
  test-2-ecran-correction.html  (à créer)
  test-3-comparaison.html       (à créer)
  test-4-import-parsing.html    (à créer)

index.html, proto-edfdecoder.html, proto-vue-nox.html   protos figés, ne pas modifier
```

## Régénérer le codage de référence

```bash
python3 extract-scoring.py
```

Lit `ZAM PEH PSG intéressante/Data.ndb`, révision « EPNOS v1 » (scoring manuel expert),
aligne les timestamps sur le début du EDF (21:30:09), écrit `scoring.json`.

## Codage candidat

Pas de vrai codage candidat disponible. `lib/scoring.js → makeCandidate(ref)` en dérive
un à la volée : périmètre restreint (respiratoire + micro-éveils), puis 3-4 erreurs
déterministes injectées (décalage, omission, faux positif, erreur de stade), listées
dans `injectedErrors` pour vérifier que l'écran de correction les fait ressortir.
