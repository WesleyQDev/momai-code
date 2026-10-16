# MomAI Code

Herramientas completas de programación para su asistente MomAI: terminal seguro, inspección y edición de archivos, proyectos de trabajo aislados y reglas de terminal con aprobación interactiva del usuario.

## Qué hace esta extensión

* **Terminal Seguro:** Permite al asistente ejecutar comandos shell (PowerShell o CMD en Windows, Bash en Linux/macOS) en la raíz de su proyecto.
* **Proyectos de Trabajo Aislados:** Por defecto, MomAI opera en su carpeta personal (Home). Añada carpetas específicas desde los ajustes o autorícelas directamente en el chat con una tarjeta de confirmación.
* **Reglas de Seguridad del Terminal:** Los comandos destructivos (borrado recursivo, formateo de discos o reinicios drásticos de git) se interceptan antes de ejecutarse. Si un comando es necesario, MomAI le pedirá autorización ("Ejecutar una vez" o "Permitir siempre").
* **Edición e Inspección Precisa:** Herramientas para leer archivos numerados, sustituir texto con exactitud quirúrgica, crear archivos y buscar código, con puntos de restauración y reversión automática al deshacer mensajes en el chat.
* **Adjuntos del Chat en el Proyecto:** Las imágenes y documentos adjuntos en el chat obtienen una copia de trabajo y el asistente puede colocarlos dentro del proyecto, sin mover archivos manualmente.

## Ejemplos de uso

* *"Revisa qué cambió en package.json dentro del proyecto MomAI"*
* *"Corrige el error en src/index.ts reemplazando la función antigua por la nueva"*
* *"Ejecuta las pruebas unitarias y muéstrame los resultados"*
* *"Añade la imagen que adjunté en src/assets"*
* *"Trabajemos en la carpeta D:\MiSitio"*

## Permisos solicitados

* **Terminal (Shell):** Para ejecutar comandos de compilación, pruebas y scripts en su equipo.
* **Sistema de Archivos (Lectura y Escritura):** Para leer y guardar código en los proyectos autorizados.
