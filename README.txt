MISSION MULTIPLICATIONS — VERSION 11 (avec mode Additions)

Fichiers :
- index.html : application monopage complète
- style.css : thème spatial, SVG et animations
- app.js : logique du jeu, chrono, fusée, scores et paramètres

Nouveautés v11 :
- choix du type d'opération dans les paramètres : Multiplications ou Additions ;
- centralisation des opérations (MODES) : calcul, symbole et libellé uniques,
  ce qui facilite l'ajout futur d'autres opérations ;
- paramètres de nombres indépendants pour chaque mode :
  * Multiplications : tables cochées 1 à 10 ;
  * Additions : plage de nombres (min–max), zéro interdit, doubles autorisés,
    pas de doublons commutatifs (3+5 et 5+3 comptent pour un seul calcul) ;
- 10 questions distinctes par mission ; apparition bloquée si la plage
  ne permet pas 10 calculs différents (message explicatif) ;
- classements distincts par mode, accessibles par onglets (Top 20) ;
- titres dynamiques « Mission Multiplications » / « Mission Additions ».

Stockage :
- aucune base de données ;
- nouveaux couples de clés : multiplicationTrainer.config.v11 et
  multiplicationTrainer.scores.v11 ;
- migration automatique depuis la v10 lors de la première utilisation,
  si aucune donnée v11 n'existe ;
- les clés v10 sont préservées intactes (ni modifiées, ni supprimées) ;
- les anciens scores sont affectés au mode Multiplications.

Déploiement :
1. Copiez le dossier complet sur votre hébergement web.
2. Ouvrez index.html.

L'application ne dépend d'aucune bibliothèque, police ou image externe.

Évolutions antérieures :
- v10b/v10d : thème spatial, fusée en 10 pièces, décollage en cas de 10/10,
  chronomètre circulaire, pavé numérique tactile, responsive renforcé.

