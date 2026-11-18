# MomAI Code

MomAI Code gives your assistant room to work on code. It runs terminal commands, reads and edits files, and stays inside the project folder you allowed.

## What you can do

- Run commands inside the project folder on Windows (PowerShell or Command Prompt) and on Linux or macOS (Bash).
- Work only in projects you approved. Without an approved project, MomAI stays in your home folder. If a folder is not allowed yet, it asks in chat.
- Stop dangerous commands such as recursive deletes, disk formatting, and hard Git resets. When you need one, you can allow it once or always.
- Read files by numbered sections, make targeted replacements, create files, and search the whole project.
- Undo edits together with the chat message that made them.
- Move images and documents from chat into the project without moving files by hand.

## Examples

- "List the files in the MomAI project and check what changed in package.json."
- "Fix the broken import in src/index.ts."
- "Run the tests and tell me which ones failed."
- "Put the image I attached into src/assets."
- "Let's work in D:\MySite."

## Permissions

- **Terminal:** to build, run tests, use Git, and run scripts on your computer.
- **Files (read and write):** to read code, save edits, and create files in approved projects.
