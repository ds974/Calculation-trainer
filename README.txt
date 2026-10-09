MISSION MULTIPLICATIONS — VERSION 10b

Fichiers :
- index.html : application monopage complète
- style.css : thème spatial, SVG et animations
- app.js : logique du jeu, chrono, fusée, scores et paramètres

Nouveautés v10d :
- identité visuelle spatiale douce et sans son ;
- fusée SVG en 10 pièces, une pièce gagnée par bonne réponse ;
- décollage avec compte à rebours uniquement en cas de 10/10 ;
- barre Question X/10 ;
- chronomètre circulaire SVG ;
- feedback visuel animé et léger ;
- modernisation des écrans de paramètres, résultats et leaderboard.

Stockage :
- aucune base de données ;
- paramètres et scores dans localStorage ;
- les clés de stockage de la v10 sont conservées afin de garder les scores existants.

Déploiement :
1. Copiez le dossier complet sur votre hébergement web.
2. Ouvrez index.html.

L'application ne dépend d'aucune bibliothèque, police ou image externe.


Correctif v10d : une table décochée est désormais exclue des deux facteurs du calcul, sans empêcher ce nombre d'apparaître comme résultat.


Évolutions v10d :
- accueil : surtitre « Calcul mental », copyright 2026 et numéro de version ;
- pavé numérique tactile intégré (0-9, C pour effacer toute la saisie, ⌫ pour le dernier chiffre) ;
- clavier physique conservé ;
- inputmode="none" pour éviter l'ouverture du clavier virtuel natif sur mobile ;
- responsive renforcé pour smartphone, tablette et écrans en paysage.
