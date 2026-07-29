# JusBrasil Extractor — Python 3 + Playwright

Aplicação web em Python 3 que extrai processos do JusBrasil de um advogado, com **filtro padrão de "Pessoa × Empresa"** (PF contra PJ). Ideal para encontrar ações trabalhistas, previdenciárias e cíveis em que uma **pessoa física** move contra uma **empresa, autarquia ou instituto** (ex.: `Cintia Martins Siqueira × INSS`).

**Sem necessidade de curl ou comando**: abra a página no navegador, cole a URL, escolha o filtro e clique em **Extrair**.

## Estrutura do pacote

```
jusbrasil-extractor-python/
├── app.py            # servidor HTTP em Python 3 + página HTML
├── requirements.txt  # dependência única: playwright==1.45.0
├── Dockerfile        # imagem oficial Playwright Python para Render
└── render.yaml       # Render Blueprint (deploy automático)
```

## Filtros disponíveis

- **`pessoa_vs_empresa`** (padrão) — mantém apenas processos onde o **Polo Ativo é pessoa física** e o **Polo Passivo é pessoa jurídica** (empresa, instituto, banco, autarquia, etc.).
- **`all`** — retorna todos os processos sem filtro.

A heurística usa listas de sufixos e palavras-chave de PJ (S.A., LTDA, ME, EPP, EIRELI, Banco, Instituto, Empresa, Seguradora, Prefeitura, Fazenda, …) e exige que apareçam como **tokens isolados** para não cair em falsos positivos (ex.: `ME` dentro de `ALMEIDA`, `CIA` dentro de nomes próprios). Cada processo também recebe uma coluna **`PF×PJ`** mostrando a classificação aplicada.

## Deploy no Render

```bash
tar -xzf jusbrasil-extractor-python.tar.gz
cd jusbrasil-extractor-python
git init && git add . && git commit -m "init"
# Em render.com → New + → Blueprint → conecte o repo → Apply
```

> ⚠️ Plano Free do Render tem pouca RAM e mata o Chromium. Use **plano Starter** ou maior.

## Como usar

1. Abra `https://<seu-app>.onrender.com/` no navegador.
2. Cole a URL da página de processos do advogado.
3. Defina o máximo de processos (1–500).
4. Escolha o **Filtro** (Pessoa × Empresa ou Todos).
5. Escolha o formato (ver na tela / CSV / Markdown).
6. Clique em **Extrair processos**.

A página mostra também:

- Contadores: **total listado** × **mantidos pelo filtro** × **tribunais únicos** × **polos ativos únicos** × **valor médio (R$)**.
- Botões de download rápido: **Baixar CSV / Markdown / Copiar JSON**.
- Coluna **`PF×PJ`** na tabela para inspeção.

## API programática

- `GET /`         → página web
- `GET /api`      → healthcheck JSON
- `GET /docs`     → documentação em texto
- `POST /extract` → `{ url, max_processes, output_format, filter_mode }`

```bash
curl -X POST https://<seu-app>.onrender.com/extract \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.jusbrasil.com.br/processos/.../nome/<slug>",
    "max_processes": 200,
    "output_format": "json",
    "filter_mode": "pessoa_vs_empresa"
  }'
```

## Logs do servidor

O servidor emite logs estruturados a cada processo visitado (`Abrindo detalhe...`, `[i/N] OK ou ERRO`). Útil para diagnosticar extrações que falham — habilite o painel **Logs** do Render e tente uma URL com poucos processos para validar a comunicação JusBrasil → servidor.

## Aviso legal

Ferramenta extrai dados publicamente acessíveis. Respeite o `robots.txt` do JusBrasil
e limite a 1 requisição/segundo. Use apenas para fins legítimos.
