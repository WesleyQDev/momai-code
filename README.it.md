# MomAI Code

Strumenti di programmazione completi per il tuo assistente MomAI: terminale sicuro, ispezione e modifica puntuale dei file, progetti di lavoro isolati e regole del terminale con approvazione interattiva dell'utente.

## Cosa fa questa estensione

* **Esecuzione Sicura nel Terminale:** Permette all'assistente di eseguire comandi di shell (PowerShell o Prompt dei comandi su Windows, Bash su Linux/macOS) direttamente nella cartella del tuo progetto.
* **Progetti di Lavoro Isolati:** Di base MomAI opera nella cartella personale dell'utente (Home). Puoi autorizzare cartelle extra tramite la pagina delle impostazioni o confermando la richiesta in chat.
* **Regole di Sicurezza del Terminale:** I comandi rischiosi (cancellazione ricorsiva, formattazione dischi o reset drastici di git) vengono bloccati prima dell'esecuzione. Se un comando è davvero necessario, MomAI chiede la tua conferma con un clic ("Esegui una volta" o "Consenti sempre").
* **Lettura e Modifica Precisa dei File:** Strumenti per consultare file con righe numerate, sostituire porzioni di codice con precisione chirurgica, creare novos file e cercare nel progetto, con punti di ripristino e annullamento automatico al rollback dei messaggi nella chat.
* **Allegati della Chat nel Progetto:** Immagini e documenti allegati nella chat ricevono una copia di lavoro e l'assistente può inserirli nel progetto, senza spostare file a mano.

## Esempi d'uso

* *"Elenca i file nel progetto MomAI e controlla le novità in package.json"*
* *"Correggi l'errore di importazione in src/index.ts"*
* *"Esegui i test unitari e mostrami se ci sono errori"*
* *"Aggiungi l'immagine che ho allegato in src/assets"*
* *"Iniziamo a lavorare sulla cartella D:\MioSito"*

## Permessi richiesti

* **Terminale (Shell):** Necessario per eseguire comandi di compilazione, test e git.
* **File System (Lettura e Scrittura):** Necessario per leggere e modificare i file nei progetti autorizzati.
