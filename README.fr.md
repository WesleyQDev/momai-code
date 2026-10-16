# MomAI Code

Outils de développement complets pour votre assistant MomAI : terminal sécurisé, inspection et modification chirurgicale de fichiers, projets isolés et règles de terminal avec approbation interactive de l'utilisateur.

## Ce que fait cette extension

* **Exécution Sécurisée dans le Terminal :** Permet à l'assistant d'exécuter des commandes shell (PowerShell/CMD sous Windows, Bash sous Linux/macOS) dans le dossier de votre projet.
* **Projets de Travail Isolés :** Par défaut, MomAI fonctionne strictement dans votre dossier utilisateur (Home). Débloquez des projets supplémentaires dans les paramètres ou confirmez directement dans le chat.
* **Règles de Sécurité du Terminal :** Les commandes à risque (suppression récursive, formatage de disques, réinitialisations git) sont bloquées en amont. En cas de besoin réel, MomAI sollicite votre consentement en un clic ("Exécuter une fois" ou "Toujours autoriser").
* **Lecture et Édition Précises de Fichiers :** Outils pour paginer la lecture de code, remplacer des blocs de texte exacts, créer de nouveaux fichiers et rechercher des motifs de code, avec points de restauration et annulation automatique lors du retour arrière dans le chat.
* **Pièces Jointes du Chat dans le Projet :** Les images et documents joints dans le chat disposent d'une copie de travail et l'assistant peut les placer dans votre projet, sans déplacement manuel.

## Exemples du quotidien

* *"Liste les fichiers du projet MomAI et vérifie les changements dans package.json"*
* *"Corrige l'erreur d'import dans src/index.ts"*
* *"Lance les tests unitaires et résume les échecs"*
* *"Ajoute l'image que j'ai jointe dans src/assets"*
* *"Travaillons sur le dossier D:\MonSite"*

## Permissions requises

* **Terminal (Shell) :** Nécessaire pour exécuter les builds, tests et opérations git.
* **Système de fichiers (Lecture et Écriture) :** Nécessaire pour analyser et mettre à jour le code de vos projets.
