# ◈ CNPJ SCANNER — Buscador de Empresas Brasileiras

Dashboard futurista (tema **dourado e preto**) para buscar empresas do Brasil por **estado**, **município** e **tipo** (MEI, ME, EPP, LTDA, S.A., EI, SLU, EIRELI, Cooperativa...), retornando:

- ✅ **Nome completo do sócio** (quadro societário completo, qualificação e data de entrada)
- ✅ **CNPJ** (formatado)
- ✅ **Razão social**
- ✅ **Nome fantasia**
- ✅ **Situação cadastral** — Ativa, Baixada, Suspensa, Inapta, Nula
- ➕ Extras: CNAE principal e secundários, capital social, natureza jurídica, porte, Simples Nacional/MEI, endereço completo, telefone, e-mail, matriz/filial

Stack: **Node.js + Express + MongoDB (Mongoose) + dashboard HTML/CSS/JS puro + Chart.js**. Pronto para o **Render**.

---

## 📁 Estrutura

```
buscador-empresas/
├── server.js                     # servidor Express (API + dashboard)
├── render.yaml                   # blueprint de deploy no Render
├── .env.example                  # modelo de variaveis de ambiente
├── src/
│   ├── db.js                     # conexao MongoDB
│   ├── models/
│   │   ├── Company.js            # schema da empresa + socios embutidos
│   │   └── Municipio.js          # municipios (autocomplete)
│   ├── routes/api.js             # endpoints REST
│   ├── lib/
│   │   ├── tables.js             # tabelas oficiais da Receita (naturezas, situacoes...)
│   │   ├── query.js              # construcao dos filtros do MongoDB
│   │   ├── csv.js                # leitura de CSV/ZIP da Receita
│   │   └── normalize.js          # normalizacao de texto/CNPJ/datas
│   └── middleware/auth.js        # protecao opcional por API key
├── scripts/
│   ├── import-receita.js         # importador dos Dados Abertos do CNPJ
│   └── seed-demo.js              # dados de demonstracao
└── public/                       # dashboard (index.html, styles.css, app.js)
```

---

## 🚀 Rodando localmente

```bash
# 1. dependencias
npm install

# 2. configure o banco
cp .env.example .env
# edite .env e informe MONGODB_URI

# 3. (opcional) popule com dados de demonstracao
npm run seed:demo

# 4. suba o servidor
npm start
# abra http://localhost:3000
```

---

## ☁️ Deploy no Render (passo a passo)

### 1. MongoDB
Crie um cluster gratuito no **MongoDB Atlas** e copie a string de conexão (`mongodb+srv://...`).
> Libere o acesso de rede em `0.0.0.0/0` (Network Access) para o Render conseguir conectar.

### 2. Suba o projeto para o GitHub
```bash
git init
git add .
git commit -m "CNPJ Scanner"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/buscador-empresas.git
git push -u origin main
```

### 3. Crie o Web Service no Render
- **New** → **Web Service** → conecte o repositório
- **Runtime:** Node
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Health Check Path:** `/health`
- Em **Environment Variables**, adicione:

| Key | Value |
|---|---|
| `MONGODB_URI` | sua string do Atlas |
| `NODE_ENV` | `production` |
| `API_KEY` | *(opcional)* chave para proteger a API |
| `CORS_ORIGIN` | `*` |

> Alternativamente use o arquivo `render.yaml` (Blueprint) já incluído: **New → Blueprint** e aponte para o repositório.

### 4. Importe os dados
O Render não roda scripts de importação automaticamente. Rode a importação **na sua máquina**, apontando o `.env` para o **mesmo MongoDB do Render**:

```bash
npm run import -- --uf SP
```

Como os dados ficam no Atlas (e não no disco do Render), o dashboard em produção já enxerga tudo.

---

## 📥 Importando os dados reais da Receita Federal

Fonte oficial: **https://dadosabertos.rfb.gov.br/CNPJ/**

Baixe (ou deixe o script baixar com `--download`) e coloque em `./data`:

| Arquivo | Conteúdo usado |
|---|---|
| `Estabelecimentos0..9.zip` | endereço, UF, município, situação cadastral, CNAE |
| `Empresas0..9.zip` | razão social, natureza jurídica, porte, capital social |
| `Socios0..9.zip` | **nome completo do sócio**, qualificação, data de entrada |
| `Simples.zip` | MEI / Simples Nacional |
| `Municipios.zip`, `Naturezas.zip`, `Qualificacoes.zip`, `Motivos.zip`, `Cnaes.zip` | tabelas de descrição |

```bash
# Importar apenas São Paulo (recomendado — bem mais rápido)
node scripts/import-receita.js --uf SP

# Se a importação for interrompida, rode de novo: ela completa o que falta
node scripts/import-receita.js --uf SP

# Baixar automaticamente e depois importar
node scripts/import-receita.js --download --uf RJ

# Teste rápido com 5.000 registros
node scripts/import-receita.js --uf MG --limit 5000

# Sem sócios (mais rápido) e limpando a base antes
node scripts/import-receita.js --uf PR --skip-socios --drop

# Base nacional completa (MUITO pesado: dezenas de GB e muitas horas)
node scripts/import-receita.js
```

**Opções:** `--uf`, `--data-dir`, `--batch`, `--limit`, `--drop`, `--download`, `--skip-socios`, `--skip-simples`, `--help`

---

## 🔌 API REST

Base: `https://SEU-APP.onrender.com/api`

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Status do servidor e do banco |
| GET | `/meta` | Listas de UF, tipos, situações e portes |
| GET | `/municipios?uf=SP&q=camp` | Autocomplete de municípios **com a contagem de empresas** |
| GET | `/count` | **Contagem exata** do filtro (confirma a varredura) |
| GET | `/companies` | Busca paginada (até 1.000 por página) |
| GET | `/companies/stream` | **TODAS as empresas** em NDJSON (streaming) |
| GET | `/companies/:cnpj` | Detalhe completo (com todos os sócios) |
| GET | `/stats` | KPIs e agregações para os gráficos |
| GET | `/socios?q=MARIA` | Busca direta por nome de sócio |
| GET | `/export` | **Exportação completa**, streaming, sem limite de linhas |

### `/export` — extração total

| Parâmetro | Valores | Padrão |
|---|---|---|
| `formato` | `csv` \| `json` \| `ndjson` \| `csv.gz` \| `json.gz` \| `ndjson.gz` | `csv` |
| `layout` | `empresa` (1 linha por CNPJ) \| `socio` (1 linha por sócio) | `empresa` |
| `max` | `0` = **todas** (sem limite) | `0` |
| demais | mesmos filtros de `/companies` | — |

A resposta traz o cabeçalho **`X-Total-Rows`** com o total exato, permitindo conferir se o arquivo veio completo.

### Parâmetros de `/companies` e `/stats`

| Parâmetro | Exemplo | Descrição |
|---|---|---|
| `uf` | `SP` | Estado |
| `municipio` | `Campinas` | Município (nome exato ou código) |
| `tipo` | `MEI,LTDA` | Um ou mais tipos |
| `situacao` | `ATIVA,BAIXADA` | Situação cadastral |
| `porte` | `ME,EPP` | Porte |
| `q` | `padaria central` | Busca livre (razão, fantasia, sócio, CNPJ, CNAE) |
| `cnae` | `6201500` | Prefixo do CNAE principal |
| `natureza` | `Limitada` | Natureza jurídica (texto) |
| `aberturaDe` / `aberturaAte` | `2010-01-01` | Período de abertura |
| `capitalMin` / `capitalMax` | `10000` | Faixa de capital social |
| `matrizFilial` | `MATRIZ` | Matriz ou filial |
| `somenteComSocios` | `true` | Só empresas com sócios |
| `somenteMei` | `true` | Só MEI |
| `somenteSimples` | `true` | Só optantes do Simples |
| `ordenar` | `capitalMaior` | `relevancia`, `aberturaRecente`, `aberturaAntiga`, `capitalMaior`, `capitalMenor`, `socios`, `municipio` |
| `page` / `limit` | `1` / `25` | Paginação (limite máx. 200) |

Exemplo:

```bash
curl "https://SEU-APP.onrender.com/api/companies?uf=SP&municipio=Santos&tipo=LTDA&situacao=ATIVA&limit=5" \
  -H "x-api-key: SUA_CHAVE"
```

---

## 🎯 Garantia de completude ("sem faltar nenhuma")

Três camadas garantem que nenhuma empresa fique de fora:

**1. Importação completa** — o importador grava **todos** os estabelecimentos do estado (matriz + filiais), sem amostragem. É *idempotente*: se cair no meio, rode de novo e ele complementa sem duplicar (índice `unique` no CNPJ).

**2. Dashboard com varredura total** — o painel *Varredura completa* mostra a **contagem exata** do município e permite:
- `BAIXAR TODAS (CSV)` — streaming direto do MongoDB, sem limite de linhas
- `1 LINHA POR SÓCIO` — uma linha por sócio (nome completo, documento, qualificação)
- `JSON COMPLETO` e `CSV .GZ` (compactado, ~20x menor)
- `CARREGAR TODAS NA TABELA` — carrega o resultado inteiro com barra de progresso

Ao final de cada download o sistema **compara o número de linhas geradas com o total do banco** e avisa se houver divergência.

**3. Auditoria contra a fonte original** — o comando abaixo relê os arquivos da Receita Federal e prova, CNPJ por CNPJ, que nada ficou de fora:

```bash
npm run auditar -- --uf SP --municipio Santos
npm run auditar -- --uf SP --codigo 3548500 --listar-faltantes
```

Saída: total na fonte, total no banco, quantos faltam e a lista de CNPJs ausentes.
Retorna **exit code 0** se estiver completo e **2** se faltar algo — dá para usar em CI/automação.

> A importação por estado é a única forma de ter a base completa: não existe API pública gratuita que liste todas as empresas de um município. O download oficial é feito uma vez, e depois as consultas são instantâneas no MongoDB.

---

## 🎛️ Funcionalidades do dashboard

- Busca rápida por razão social, nome fantasia, CNPJ ou **nome do sócio**
- Filtros avançados: UF, município (com autocomplete), situação, tipo (chips), porte, CNAE, natureza jurídica, período de abertura, faixa de capital, matriz/filial
- Atalhos: **somente MEI**, **somente com sócios**, **somente Simples Nacional**
- 8 KPIs em tempo real (total, ativas, baixadas, MEI, LTDA, sócios mapeados, capital somado e médio)
- 6 gráficos: situação (rosca), tipos, top municípios, abertura por ano, porte (polar) e principais CNAEs
- Tabela de resultados com paginação, ordenação por coluna e **modal de detalhes** com o quadro societário completo
- Exportação **CSV** (Excel-friendly, com BOM) e **JSON**
- Configurações para apontar para outra API e informar a `API_KEY`
- Layout responsivo, tema dourado/preto com efeitos de vidro, glow e grid animado

---

## 🔐 Segurança

Defina `API_KEY` no `.env` / Render para exigir o cabeçalho `x-api-key` em todas as rotas `/api/*`. O dashboard possui um campo em **Configurações** para guardar essa chave no navegador.

---

## ⚠️ Observações legais e de performance

- Os dados são **públicos**, publicados pela Receita Federal sob a Lei de Acesso à Informação (dados abertos do CNPJ).
- Dados de CPF de sócios aparecem **mascarados** nos termos públicos — trate-os conforme a **LGPD**.
- A base nacional completa passa de 60 milhões de estabelecimentos. **Importe por estado** (`--uf`) e use um cluster MongoDB com disco/IOPS adequados.
- Índices compostos já são criados automaticamente (`uf + municipio + situacao`, `tipos`, `cnpj`, etc.), o que mantém as buscas rápidas mesmo em bases grandes.
- O plano gratuito do Render hiberna por inatividade — o primeiro acesso após hibernar demora alguns segundos.
