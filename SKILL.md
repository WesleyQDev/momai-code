---
name: MomAI Code
description: Inspeção, diagnóstico, busca, leitura e edição de código em projetos locais autorizados, além de comandos de terminal seguros. Use quando o usuário pedir para inspecionar, otimizar, depurar ou explorar um projeto, arquivos ou scripts.
metadata:
  audience: llm
  category: developer
---

# MomAI Code — Instruções de Operação

Terminal, leitura, listagem, gravação, edição e busca de arquivos no ambiente do usuário.

## 1. Perímetro e Projetos

1. **Sem projeto ativo** a base é a Home; pastas comuns (Downloads, Documentos, Desktop) resolvem a partir dela: `code_list { path: "Downloads" }`.
2. **Projeto ativo**: para trabalhar em um projeto, chame `code_project_use { project: "X" }`; o `AGENTS.md` do repositório vem no resultado — siga essas convenções.
3. **Nunca caia em silêncio para a Home**: projeto inexistente ⇒ pare, avise e liste com `code_projects`.
4. **Pasta não autorizada**: `code_project_request { path: "..." }` (na Home registra direto; fora exige confirmação do usuário) e depois `code_project_use`.
5. **Com projeto ativo as ferramentas ficam limitadas à pasta do projeto**; para o acesso geral, `code_project_use { project: "home" }`.
6. **Caminhos relativos** resolvem da raiz ativa; cada resultado traz a base e o `canonicalPath`.
7. **Diagnóstico real**: ative o projeto, localize com `code_glob`/`code_grep` e leia com `code_read` antes de responder.

## 2. Terminal (`code_bash`): shell e aprovação

1. **cwd** = raiz do projeto. **No Windows o shell é PowerShell**: `grep`, `sed`, `head`, `ls`, `cat` não existem — use `code_grep`, `code_glob`, `code_read`, `code_list`; confira `platform`/`shell` no retorno.
2. **Sempre pausam** (card no chat: "Permitir desta vez / Permitir sempre / Negar"):
   - excluir arquivo ou pasta (`rm`, `del`, `erase`, `rmdir`, `Remove-Item`, em qualquer forma);
   - mutações de git (`commit`, `push`, `reset`, `rebase`, `clean`, `checkout --`, `checkout .`, `restore`, `branch -D`, `stash drop/clear`, `filter-branch`/`filter-repo`);
   - publicar pacote (`npm`/`pnpm`/`yarn`/`bun publish`);
   - ações privilegiadas/de sistema (`sudo`, `runas`, `shutdown`, `Stop-Computer`, `Restart-Computer`, `reg delete`, `sc delete`);
   - derrubar infraestrutura (`docker system prune`, `docker volume rm`, `kubectl delete`, `terraform destroy`);
   - ler `.env` (segredos; `.env.example` é liberado);
   - baixar e executar código remoto (`curl ... | sh`, `iwr ... | iex`).
3. **Bloqueados sempre** (sem card): apagar tudo (raiz do disco, Home, raiz de trabalho, `*`, a pasta acima) e ferramentas de disco/boot (`format`, `mkfs`, `diskpart`, `dd of=/dev/`, `fdisk`, `parted`, `bcdedit`, `bootrec`, `vssadmin delete`) — inclusive via `cmd /c` ou `powershell -Command`.
4. **Aguarde a decisão**; em caso de recusa, explique o que pretendia e proponha alternativa segura. As regras (Permitir/Perguntar/Bloquear) são configuráveis na extensão; não burle com codificações ou truques de shell.

## 3. Leitura, edição e busca

1. **`code_read`**: para arquivos use `offset`/`limit` com fatias amplas (padrão 800 linhas, máx 2000); evite blocos minúsculos (10–20 linhas) que omitem contexto; se `hasMore`, siga de `nextOffset`.
2. **`code_edit`**: prefira substituição exata a reescrever; `target` com contexto suficiente para ser único; `replaceAll: true` para todas as ocorrências.
3. **`code_write`**: arquivos novos ou reescrita completa; diretórios intermediários são criados sozinhos.
4. **`code_list`** = pastas imediatas; **`code_glob`** por padrão (`*` = segmento, `**` = profundidade); **`code_grep`** = símbolos/erros (`path` aceita arquivo ou pasta, `include` filtra, `context` = linhas ao redor). `node_modules`, `.git`, `dist` etc. são ignorados nas varreduras.
5. **Viés para ação e progresso**: quando o usuário solicitar alteração pontual de código ou UI, localize o componente alvo, aplique a modificação com `code_edit`/`code_write` e valide. Não entre em loops de leitura sem aplicar mudanças nem hesite para pedir confirmações triviais de arquitetura quando o pedido for direto.

## 4. Anexos (`code_attach`)

1. O host grava uma cópia de trabalho de cada anexo e informa o caminho no prompt (`[Cópia em disco: ...]`), mesmo com projeto ativo.
2. Para adicionar: `code_attach { attachment: "<nome>", destination: "src/assets" }` (sem `destination` vai para a raiz; sem projeto, informe o destino). Conflito: confirme antes de `overwrite: true`; renomeie com `fileName`.
3. A cópia é temporária e somente leitura (`code_write`/`code_edit` não gravam nela); se expirou, peça reenvio.
