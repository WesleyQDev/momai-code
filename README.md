# MomAI Code

Ferramentas completas de programação para o seu assistente MomAI: terminal seguro, inspeção e edição de arquivos, projetos de trabalho isolados e regras do terminal com aprovação humana no chat.

## O que a extensão faz

* **Execução Segura no Terminal:** Permite que o assistente execute comandos shell (PowerShell ou Prompt de Comando no Windows, Bash no Linux/macOS) diretamente na pasta do seu projeto.
* **Projetos Isolados de Trabalho:** Por padrão, a MomAI opera na sua pasta pessoal (Home). Quando você quiser trabalhar em um projeto específico, adicione a pasta pelo painel ou autorize diretamente pelo chat através de um card de confirmação.
* **Regras de Segurança do Terminal:** Comandos perigosos (como apagar pastas recursivamente, formatação de discos ou resets drásticos de git) são interceptados antes da execução. Se o comando for realmente necessário, a MomAI solicita sua autorização com um clique em "Executar uma vez" ou "Permitir sempre".
* **Edição e Inspeção Precisa de Arquivos:** Ferramentas para ler arquivos por trechos numerados, fazer substituições cirúrgicas de texto, criar novos arquivos e buscar código por padrão ou texto em todo o projeto, com suporte a checkpoints e reversão automática ao desfazer mensagens no chat.
* **Anexos da Conversa no Projeto:** Imagens e documentos anexados no chat ganham uma cópia de trabalho e podem ser colocados dentro do projeto pelo próprio assistente, sem você mover arquivos manualmente.

## Exemplos do dia a dia

* *"Liste os arquivos do projeto MomAI e veja o que mudou no package.json"*
* *"Corrija o erro de importação no arquivo src/index.ts trocando o caminho antigo pelo novo"*
* *"Execute os testes unitários do projeto e me mostre se algum teste falhou"*
* *"Adicione a imagem que anexei em src/assets"*
* *"Vamos começar a trabalhar na pasta D:\MeuSite"* (exibe o card de autorização caso o projeto ainda não tenha sido adicionado)

## Permissões Solicitadas

* **Terminal (Shell):** Necessária para rodar comandos de compilação, testes, git e automações de código no seu computador.
* **Sistema de Arquivos (Leitura e Escrita):** Necessária para ler código, registrar alterações e criar arquivos nos seus projetos autorizados.
