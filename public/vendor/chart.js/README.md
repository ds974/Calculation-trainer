# Chart.js — dépendance front locale (Mission Calcul Mental v12)

Ce répertoire contient la bibliothèque de graphiques **Chart.js**, intégrée
**localement** dans `public/` conformément aux contraintes du projet
(aucun CDN, npm ou Node.js à l'exécution ; compatible `Content-Security-Policy`).

## Version

- **Chart.js v4.6.1** (build **UMD** : `chart.umd.min.js` / `chart.umd.js`).
- Site officiel : https://www.chartjs.org
- Dépôt : https://github.com/chartjs/Chart.js

## Provenance

Les fichiers sont les **binaires de distribution officiels** publiés par
l'équipe Chart.js pour la version `4.6.1`, récupérés tels quels depuis le
registre npm officiel (miroir public jsDelivr, chemin
`npm/chart.js@4.6.1/dist/chart.umd.js` et `.../chart.umd.min.js`) et depuis la
licence officielle (`npm/chart.js@4.6.1/LICENSE.md`). Aucune modification du
contenu n'a été apportée.

- `chart.umd.min.js` — build UMD minifié (~205 Ko), celui chargé par la page.
- `chart.umd.js` — build UMD non minifié, conservé pour référence/débogage.
- `LICENSE.md` — texte de licence officiel (MIT).

## Licence

Chart.js est distribué sous la **licence MIT** (voir `LICENSE.md`).
Copyright (c) 2014-2024 Chart.js Contributors.

## Compatibilité Content-Security-Policy

Le build UMD est **auto-contenu** (aucune dépendance ni requête réseau) et
s'exécute sous la CSP de l'étape 5 :
`default-src 'self'; script-src 'self'; style-src 'self'; ...`

- Le script est chargé en **same-origin** depuis `/vendor/chart.js/chart.umd.min.js`
  → couvert par `script-src 'self'`.
- Chart.js rend sur un élément `<canvas>` et manipule le style via la **CSSOM**
  (non soumis à `style-src`) ; il **n'injecte aucun `<style>` inline ni attribut
  `style=""`**, donc compatible `style-src 'self'`.
- Aucun `connect-src` externe, aucun `img-src` distant (les graphiques ne
  téléchargent rien ; le fond décoratif éventuel reste local).

## Notes d'intégration

- Chargé **avant** `stats.js` dans `index.html` (expose le constructeur global
  `Chart`).
- Les instances sont créées et **détruites** (`chart.destroy()`) à chaque
  rechargement de données, changement de mode et départ de l'écran.
