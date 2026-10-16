# MomAI Code

Umfassende Entwickler-Werkzeuge für Ihren MomAI-Assistenten: sichere Terminal-Ausführung, Datei-Inspektion und -Bearbeitung, isolierte Arbeitsprojekte und Terminal-Regeln mit interaktiver Nutzerbestätigung.

## Funktionen der Erweiterung

* **Sichere Terminal-Ausführung:** Ermöglicht die Ausführung von Shell-Befehlen (PowerShell oder Eingabeaufforderung unter Windows, Bash unter Linux/macOS) direkt im Projektverzeichnis.
* **Isolierte Arbeitsprojekte:** Standardmäßig agiert MomAI im Benutzer-Stammverzeichnis (Home). Zusätzliche Ordner können über die Einstellungen oder per Bestätigungskarte im Chat freigegeben werden.
* **Sicherheitsregeln für das Terminal:** Destruktive Befehle (rekursives Löschen, Datenträgerformatierung, Git-Hard-Resets) werden vor der Ausführung abgefangen. Bei Bedarf fragt MomAI nach Erlaubnis ("Einmalig ausführen" oder "Immer erlauben").
* **Präzises Lesen und Bearbeiten:** Werkzeuge zur paginierten Einsicht in Code-Dateien, zum punktgenauen Ersetzen von Zeichenfolgen und zur Code-Suche, mit Checkpoints und automatischer Wiederherstellung beim Rückgängigmachen im Chat.
* **Chat-Anhänge direkt ins Projekt:** Bilder und Dokumente aus dem Chat erhalten eine Arbeitskopie und der Assistent kann sie in Ihr Projekt legen – ganz ohne manuelles Verschieben.

## Anwendungsbeispiele

* *"Zeige die Dateien im Projekt MomAI und prüfe die package.json"*
* *"Korrigiere den Import-Fehler in src/index.ts"*
* *"Führe die Modultests aus und berichte über Fehler"*
* *"Lege das angehängte Bild in src/assets ab"*
* *"Lass uns im Verzeichnis D:\MeineWebseite arbeiten"*

## Erforderliche Berechtigungen

* **Terminal (Shell):** Zur Ausführung von Entwicklungsbefehlen und Skripten auf Ihrem Computer.
* **Dateisystem (Lesen und Schreiben):** Zum Lesen und Bearbeiten von Projektdateien.
