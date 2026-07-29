# Buscador de Processos JusBrasil por Nome + Reformulador

Microsserviço (FastAPI) que recebe um nome completo e devolve a URL canônica
do JusBrasil (`/processos/nome/{id}/{slug}`) com todos os processos encontrados
para essa pessoa.

Inclui um **sistema de reformulação de nomes** na interface web — posicionado
**abaixo do buscador** — que gera variações automáticas do nome digitado para
tentar matches adicionais quando a busca inicial falha ou é parcial.

---

## Reformulador de nomes

### Onde fica

Painel **logo abaixo do input do buscador** (dentro do mesmo card branco).
Aparece automaticamente assim que o usuário digita um nome com 3+ caracteres.

### Como funciona

Para cada termo digitado, o reformulador gera até 10 variações:

| Variação     | Transformação                                       | Por que existe |
|--------------|-----------------------------------------------------|----------------|
| MAIÚSCULAS   | Tudo em uppercase                                   | Padrão JusBrasil em URLs e slugs |
| SEM ACENTO   | Remove diacríticos (`José` → `JOSE`)                | Documentos antigos / SERPs sem UTF-8 |
| SEM PREPOSIÇÃO | Tira `de/da/do/das/dos`                           | Alguns registros não usam preposição |
| PRIM + ÚLT   | Mantém só primeiro e último nome                    | Matriarca / pessoa conhecida só pelo nome social |
| INVERTIDO    | Ordem inversa (sem vírgula)                         | Alguns índices indexam sobrenome primeiro |
| INV. VÍRGULA | Ordem inversa com vírgula                           | Formato bibliográfico |
| TÍTULO       | Preposições minúsculas, demais capitais             | Forma canônica "Nome da Silva" |
| + FILHO/JÚNIOR/NETO | Adiciona sufixo no final                    | Pessoas com sufixo de geração |
| SEM FILHO/JÚNIOR/NETO/SOBRINHO | Remove sufixo terminal             | Digitou sufixo que não precisava |

Cada item é um botão. Clicar nele:
1. Preenche o input com a variação
2. Dispara `/api/search` com ela automaticamente
3. Mostra o resultado (com link JusBrasil se achar)

Também há um botão **ℹ️ Detalhes** que mostra a descrição de cada variação
junto ao botão.

### Casos onde o reformulador ajuda mais

- **Match exato**: a busca principal já achou — reformulador fica visível mas
  é opcional.
- **Match parcial** (`slug_strip_match` ou `first_jusbrasil_match`): o badge
  amarelo aparece com a frase "tente as variações do reformulador acima".
- **Sem match** (`no_jusbrasil_url_in_results`): reformulador é o
  caminho principal pra usuário descobrir variações a tentar.

---

## Setup

### 1. Pegar uma chave SerpAPI (grátis, ~100 buscas/mês)

Cadastro em **https://serpapi.com** → copie sua API key.

### 2. Rodar localmente

```bash
pip install -r requirements.txt
export SERPAPI_KEY=sua_chave_aqui
uvicorn app:app --reload --port 8000
```

Abra http://localhost:8000.

### 3. Deploy

O `app.py` aceita qualquer host Python. Variável de ambiente obrigatória:
`SERPAPI_KEY`.

| Serviço  | Como fazer                                                              |
|----------|-------------------------------------------------------------------------|
| Render   | Push pro GitHub → New Web Service → Build `pip install -r requirements.txt` → Start `uvicorn app:app --host 0.0.0.0 --port $PORT` → env `SERPAPI_KEY` |
| Railway  | `railway up` → `railway variables set SERPAPI_KEY=…`                     |
| Fly.io   | `fly launch` → `fly secrets set SERPAPI_KEY=…`                          |
| VPS      | `uvicorn app:app --host 0.0.0.0 --port 8000` + nginx com TLS (Let's Encrypt) |

---

## Estrutura

```
files/
├── jusbrasil_search.py   # lógica pura (slugify, regex, ranking, extract)
├── app.py                # servidor FastAPI (endpoints /api/search, /, /healthz)
├── index.html            # frontend com reformulador integrado
├── requirements.txt      # fastapi, uvicorn, httpx
└── README.md             # este arquivo
```

---

## API

### `GET /api/search?nome=<nome>`

Resposta:

```json
{
  "nome": "JAMILA DRIELLY MOURA OLIVEIRA",
  "slug": "jamila-drielly-moura-oliveira",
  "google_query": "\"JAMILA DRIELLY MOURA OLIVEIRA\" site:jusbrasil.com.br processos",
  "jusbrasil_url": "https://www.jusbrasil.com.br/processos/nome/59940841/jamila-drielly-moura-oliveira",
  "match_quality": "exact_slug_match",
  "total_processos": 475
}
```

### `GET /healthz`

```json
{ "status": "ok", "serpapi_key_set": true }
```

### `GET /`

Serve `index.html` com o reformulador.

---

## Valores de `match_quality`

| Valor                              | Significado                                                                              |
|------------------------------------|------------------------------------------------------------------------------------------|
| `exact_slug_match`                 | Slug na URL JusBrasil bate exatamente.                                                   |
| `slug_strip_match`                 | Bate após remover hifens (variação de acento/separador).                                |
| `first_jusbrasil_match`            | Mais de uma pessoa; primeira do Google.                                                  |
| `no_jusbrasil_url_in_results`      | Sem página JusBrasil para esse nome — reformulador entra em ação.                       |

---

## Limitações conhecidas

- JustBrasil retorna HTTP 403 para user-agents de bot, então o serviço **não**
  valida a URL raspando o JusBrasil. A URL vem do índice do Google.
- Limite de 100 buscas/mês no tier grátis da SerpAPI. Para volume maior, plano
  pago (~USD 50/mês por 5.000 buscas).
- Buscas SerpAPI são síncronas (~1–3s). Em tráfego alto, considere cachear
  resultados por `(slug) → (url, total)` por 24h.

## Teste rápido

```bash
curl "http://localhost:8000/api/search?nome=JAMILA%20DRIELLY%20MOURA%20OLIVEIRA"
```

Deve retornar a URL `https://www.jusbrasil.com.br/processos/nome/59940841/jamila-drielly-moura-oliveira`
com `match_quality: "exact_slug_match"` e `total_processos: 475`.

Depois de subir o serviço, abra http://localhost:8000 e digite o nome no campo
— o reformulador deve aparecer logo abaixo com variações para clicar.
