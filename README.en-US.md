# MomAI Code

Complete coding tools for your MomAI assistant: safe terminal execution, file inspection and surgical editing, isolated project workspaces, and terminal rules with human-in-the-loop approval.

## What this extension does

* **Safe Terminal Execution:** Enables the assistant to run shell commands (PowerShell or Command Prompt on Windows, Bash on Linux/macOS) directly in your project root.
* **Isolated Work Projects:** By default, MomAI operates strictly in your user home folder. When you want to work on a specific codebase, register the folder in settings or approve it directly in chat via an interactive confirmation card.
* **Terminal Safety Rules:** Dangerous commands (such as recursive folder deletion, disk formatting, or hard git resets) are caught before execution. If a command is genuinely required, MomAI asks for your consent with a single click: "Run once" or "Always allow".
* **Precise File Reading and Editing:** Tools to inspect files with paginated line numbers, perform surgical string replacements, create new files, and search across files using patterns, with automatic checkpointing and rollback when undoing chat turns.
* **Chat Attachments Into Your Project:** Images and documents attached in chat get a working copy, and the assistant can place them inside your project for you — no manual file moving.

## Everyday Examples

* *"List the files in project MomAI and check what changed in package.json"*
* *"Fix the import error in src/index.ts by replacing the legacy path with the new one"*
* *"Run the project unit tests and report which ones failed"*
* *"Add the image I attached into src/assets"*
* *"Let's work on folder D:\MySite"* (displays an authorization card if the project hasn't been added yet)

## Requested Permissions

* **Terminal (Shell):** Required to run build commands, tests, git operations, and code scripts on your machine.
* **File System (Read & Write):** Required to inspect code, write edits, and create files in your authorized project folders.
