# Vérification locale du navigateur

Le serveur MCP Medium a réussi les essais ciblés sur Chromium dans le répertoire de travail isolé, lors de cette phase de test. Ces essais complètent les preuves comportementales manquantes avec des pages contrôlées. Aucun défaut produit supplémentaire n’a été reproduit ; aucune règle de production n’a été modifiée.

Le fichier `tests/browser-client.chromium.test.cjs` vérifie les destinations de connexion, le refus des liens interdits et les stratégies de recherche suivantes. Il vérifie aussi la fermeture après échec de navigation ou d’extraction, la reprise après initialisation partielle, le partage des tentatives concurrentes et la lecture anonyme après connexion impossible.

Chromium exécute les véritables extractions dans le navigateur. Toutes les requêtes des pages sont interceptées et reçoivent des données locales clairement identifiées. Les erreurs sont injectées lors de la création d’une page, pendant la navigation ou dans le document. Les attentes de production restent actives ; aucune session réelle n’est chargée.

La commande ciblée ci-dessous a réussi. Elle nécessite les dépendances du projet, sa compilation et le navigateur Chromium déjà disponible pour Playwright. Les essais créent un répertoire temporaire local puis le suppriment, ferment leurs navigateurs et ne publient aucun article. Les essais existants concernés ont également réussi avec leurs doubles.

```sh
npm run build
node --test tests/browser-client.chromium.test.cjs
```

La preuve distante antérieure reste limitée : le parcours MCP avec affichage a permis une recherche et une lecture partielle accessible sans abonnement. Cloudflare a bloqué la lecture sans affichage. Ce cas distant reste non validé ; les pages contrôlées ne remplacent pas cette vérification. Aucun nouvel accès à Medium n’a été tenté.

Les preuves antérieures restent conservées dans `/home/aurelien/.no-mistakes/evidence/01M2Z2W13DMG4ADQZ7ZSNP1GE2/`, notamment `mcp-final-results.json` et `medium-article-headless.png`, selon le compte rendu fourni à cette phase. Le présent résultat ne revendique aucune validation distante complète. La publication du correctif et les vérifications distantes relèvent des phases suivantes du processus externe.
