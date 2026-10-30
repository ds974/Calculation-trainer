// adaptive-generator.js — Moteur de génération adaptative des missions (v12.5).
//
// Étape 2B : cet algorithme reste volontairement PURE et testable de manière
// indépendante. Il ne lit ni n'écrit aucun état global : il reçoit
//   - le POOL ORDINAIRE complet (toutes les paires {a, b, mode} valides selon
//     les paramètres courants — additions, multiplications, tables, plages) ;
//   - les DIFFICULTÉS récupérées (forme de l'API `difficulty/operations`) ;
//   - la CONFIGURATION (mode, type de questions).
// et renvoie la mission complète de 10 questions, avec les bons types et sans
// doublon de paire d'opérandes.
//
// Règles implémentées :
//   - jusqu'à 4 questions ciblant les difficultés personnelles, le reste
//     sélectionné normalement dans le pool ordinaire (non maîtrisées comprises) ;
//   - une opération de difficulté 0 n'est jamais prioritaire ;
//   - si les difficultés compatibles sont insuffisantes, on complète normalement ;
//   - en mode Mélange, on conserve EXACTEMENT 5 questions classiques et 5 à trou ;
//   - une difficulté `classic` ne produit qu'une classique, `hole` qu'à trou ;
//   - favorise les coefficients les plus élevés, départage aléatoirement à
//     coefficient égal ;
//   - unicité : jamais deux fois la même paire d'opérandes dans une mission ;
//   - position aléatoire du trou conservée ;
//   - si l'entraînement adaptatif est désactivé ou qu'aucune difficulté n'est
//     disponible, renvoie `null` : l'appelant conserve alors le comportement
//     actuel (pas de modification du générateur ordinaire existant).
//
// La connexion réelle de ce moteur à l'API et au bouton de lancement de mission
// sera réalisée à l'étape 2C.

(function (global) {
  "use strict";

  var QUESTION_COUNT = 10;      // cohérent avec app.js (constante v12.3)
  var MAX_TARGETED = 4;         // nombre maximal de questions ciblées par mission
  var TYPE_QUOTA = 5;           // dans un Mélange de 10 : 5 classiques / 5 à trou

  // Conversion des libellés d'opération de l'API vers le mode interne JS.
  var API_MODE_TO_JS = { multiplication: "mult", addition: "add" };

  /**
   * Construit le pool ORDINAIRE complet (toutes les paires {a, b, mode} uniques)
   * à partir de la configuration, en respectant strictement les paramètres
   * existants (tables cochées pour la multiplication, plage min/max pour
   * l'addition). Les opérandes sont normalisés (a <= b) pour éviter les paires
   * commutatives dupliquées (6x7 et 7x6), comme le fait le générateur existant.
   *
   * @param {object} config { mode, mult: {tables}, add: {min, max} }
   * @return {Array<{a:number,b:number,mode:string}>}
   */
  function buildNormalPool(config) {
    var mode = config.mode;
    var pool = [];
    if (mode === "add") {
      var min = config.add.min;
      var max = config.add.max;
      for (var a = min; a <= max; a++) {
        for (var b = a; b <= max; b++) {
          pool.push({ a: a, b: b, mode: mode });
        }
      }
    } else {
      // Multiplication : produit cartésien des tables cochées, sans doublon
      // commutatif (seuls les couples a <= b sont retenus).
      var tables = config.mult.tables;
      for (var i = 0; i < tables.length; i++) {
        for (var j = 0; j < tables.length; j++) {
          var ta = tables[i];
          var tb = tables[j];
          if (ta <= tb) {
            pool.push({ a: ta, b: tb, mode: mode });
          }
        }
      }
    }
    return pool;
  }

  /** Clé d'unicité d'une question/pair d'opérandes pour un mode donné. */
  function poolKey(q) {
    return q.mode + "|" + q.a + "|" + q.b;
  }

  /** Mélange Fisher-Yates in place, guidé par le générateur aléatoire fourni. */
  function shuffle(array, rng) {
    for (var i = array.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = array[i];
      array[i] = array[j];
      array[j] = tmp;
    }
    return array;
  }

  /**
   * Algorithme de sélection adaptative (cœur de l'étape 2B).
   *
   * @param {Array<{a:number,b:number,mode:string}>} normalPool pool ORDINAIRE
   *        complet (non maîtrisées comprises), déjà cohérent avec la config.
   * @param {Array<object>} difficulties opérations non maîtrisées récupérées
   *        (forme API : {mode, question_type, operand_a, operand_b, difficulty}).
   * @param {object} config { mode, questionType, mult, add }
   * @param {function():number} [rng] générateur aléatoire injectable (défaut
   *        Math.random), pour des tests déterministes.
   * @return {Array<{a:number,b:number,mode:string,hole:string|null}>|null}
   *         les 10 questions (avec `hole` positionné) OU `null` si l'algorithme
   *         ne doit pas s'appliquer (adaptation désactivée / aucune difficulté
   *         compatible disponible), auquel cas l'appelant conserve le
   *         comportement actuel.
   */
  function adaptiveGenerateQuestions(normalPool, difficulties, config, rng) {
    rng = rng || Math.random;

    // Adaptatif explicitement désactivé => comportement actuel conservé.
    if (config.adaptive === false) {
      return null;
    }

    var questionType = config.questionType; // 'classic' | 'hole' | 'mixed'
    var allowedTypes = questionType === "mixed" ? ["classic", "hole"] : [questionType];

    // Index du pool ordinaire (pour ne retenir que des difficultés compatibles
    // avec les paramètres : tables/plages respectées, mode identique).
    var poolKeys = new Set();
    for (var p = 0; p < normalPool.length; p++) {
      poolKeys.add(poolKey(normalPool[p]));
    }

    // On ne conserve que les difficultés compatibles et strictement > 0.
    var difficultiesList = Array.isArray(difficulties) ? difficulties : [];
    var compatible = [];
    for (var d = 0; d < difficultiesList.length; d++) {
      var entry = difficultiesList[d];
      var dMode = API_MODE_TO_JS[entry.mode] || entry.mode;
      if (dMode !== config.mode) continue;
      var qt = entry.question_type;
      if (allowedTypes.indexOf(qt) === -1) continue;
      var diff = Number(entry.difficulty);
      if (!(diff > 0)) continue; // une difficulté 0 n'est jamais prioritaire
      var a = Number(entry.operand_a);
      var b = Number(entry.operand_b);
      // Normalisation des opérandes (a <= b) : l'API garantit déjà cet ordre,
      // mais on s'aligne sur le moteur existant (le pool est construit en
      // a <= b) pour rester robuste même si les opérandes arrivent inversés.
      if (a > b) { var sw = a; a = b; b = sw; }
      if (!poolKeys.has(dMode + "|" + a + "|" + b)) continue; // hors pool => hors paramètres
      compatible.push({ a: a, b: b, mode: dMode, question_type: qt, difficulty: diff });
    }


    // Aucune difficulté compatible disponible => comportement actuel conservé.
    if (compatible.length === 0) {
      return null;
    }

    // Classement : difficulté la plus élevée d'abord ; à coefficient égal, on
    // mélange d'abord puis on trie stable, ce qui départage aléatoirement les
    // difficultés de même coefficient.
    shuffle(compatible, rng);
    compatible.sort(function (x, y) { return y.difficulty - x.difficulty; });

    // Répartition des questions ciblées par type, en respectant les quotas de
    // types (5/5 en Mélange) et le plafond global de 4.
    var classicTargeted = []; // difficultés -> questions classiques ciblées
    var holeTargeted = [];    // difficultés -> questions à trou ciblées
    for (var c = 0; c < compatible.length && (classicTargeted.length + holeTargeted.length) < MAX_TARGETED; c++) {
      var cand = compatible[c];
      if (cand.question_type === "classic") {
        if (questionType === "hole") continue;        // une classique ne convient pas en mode à trou
        if (classicTargeted.length >= TYPE_QUOTA) continue;
        classicTargeted.push(cand);
      } else { // "hole"
        if (questionType === "classic") continue;     // une à trou ne convient pas en mode classique
        if (holeTargeted.length >= TYPE_QUOTA) continue;
        holeTargeted.push(cand);
      }
    }


    // Assemblage des questions ciblées (position du trou aléatoire pour le à trou).
    var questions = [];
    var used = new Set();
    var i, q;
    for (i = 0; i < classicTargeted.length; i++) {
      q = { a: classicTargeted[i].a, b: classicTargeted[i].b, mode: classicTargeted[i].mode, hole: null };
      questions.push(q);
      used.add(poolKey(q));
    }
    for (i = 0; i < holeTargeted.length; i++) {
      q = { a: holeTargeted[i].a, b: holeTargeted[i].b, mode: holeTargeted[i].mode, hole: rng() < 0.5 ? "a" : "b" };
      questions.push(q);
      used.add(poolKey(q));
    }

    // Quotas restants pour le complément ORDINAIRE (garde les non-maîtrisées).
    var remaining = QUESTION_COUNT - questions.length;
    var needClassic, needHole;
    if (questionType === "classic") {
      needClassic = remaining;
      needHole = 0;
    } else if (questionType === "hole") {
      needClassic = 0;
      needHole = remaining;
    } else { // mixed : exactement 5 classiques / 5 à trou
      needClassic = TYPE_QUOTA - classicTargeted.length;
      needHole = TYPE_QUOTA - holeTargeted.length;
    }


    // Pool ordinaire restant, sans les opérandes déjà ciblés (unicité), puis
    // sélection aléatoire du complément.
    var ordinary = [];
    for (var o = 0; o < normalPool.length; o++) {
      var candidate = normalPool[o];
      if (!used.has(poolKey(candidate))) {
        ordinary.push(candidate);
      }
    }
    shuffle(ordinary, rng);
    var pickedOrdinary = ordinary.slice(0, remaining);

    if (questionType === "classic") {
      for (i = 0; i < pickedOrdinary.length; i++) {
        questions.push({ a: pickedOrdinary[i].a, b: pickedOrdinary[i].b, mode: pickedOrdinary[i].mode, hole: null });
      }
    } else if (questionType === "hole") {
      for (i = 0; i < pickedOrdinary.length; i++) {
        questions.push({ a: pickedOrdinary[i].a, b: pickedOrdinary[i].b, mode: pickedOrdinary[i].mode, hole: rng() < 0.5 ? "a" : "b" });
      }
    } else if (needHole >= 0) {
      // mixed : on répartit le complément pour aboutir exactement aux quotas.
      // On transforme les `needHole` premiers en questions à trou (position
      // aléatoire), les autres restent classiques. Le pool ayant été mélangé,
      // la répartition des trous est aléatoire.
      for (i = 0; i < pickedOrdinary.length; i++) {
        var isHole = i < needHole;
        questions.push({
          a: pickedOrdinary[i].a,
          b: pickedOrdinary[i].b,
          mode: pickedOrdinary[i].mode,
          hole: isHole ? (rng() < 0.5 ? "a" : "b") : null
        });
      }
    }

    // Mélange final du déroulé de la mission.
    return shuffle(questions, rng);
  }


  var AdaptiveGenerator = {
    buildNormalPool: buildNormalPool,
    adaptiveGenerateQuestions: adaptiveGenerateQuestions,
    shuffle: shuffle,
    poolKey: poolKey
  };

  global.AdaptiveGenerator = AdaptiveGenerator;

})(typeof window !== "undefined" ? window : globalThis);

