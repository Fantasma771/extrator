# Buscador JusBrasil + Reformulador de Processos Jurídicos

Aplicação FastAPI com **duas ferramentas em uma única página**:

1. **Buscador de Processos JusBrasil** (topo): recebe um nome completo e devolve
   a URL canônica do JusBrasil com todos os processos encontrados.

2. **Reformulador de Processos Jurídicos – Equipe Fantasma** (abaixo do
   buscador): recebe o texto bruto de um processo, extrai CPF / telefones /
   tribunal, formata e gera botões de WhatsApp + link direto da consulta
   pública PJE do tribunal detectado.

---

## Como ficou a página

```
┌──────────────────────────────────────────────────┐
│  🔎 Buscador de Processos JusBrasil              │
│  [ input do nome      ] [ Buscar ]              │
│                                                  │
│  → resultado da busca JusBrasil                  │
└──────────────────────────────────────────────────┘

──────────────────  ⬇ ABAIXO DO BUSCADOR ⬇  ──────────────────

  ⚖️ Equipe Fantasma — Reformulador de Processos Jurídicos

  ┌─ 📋 Cole o texto ─┐  ┌─ ➕ Dados complementares ─┐
  │ [textarea raw   ]  │  | CPF: ___                 │
  │                    │  | Telefones: [textarea]    │
  │                    │  | [✨ Reformular] [🗑 Limpar]
  └────────────────────┘  └──────────────────────────┘

         ┌─ 📄 Resultado + Whatsapp + PJE ──────────┐
         │ texto formatado extraído do processo     │
         │ 📋 Copiar                                │
         │ Wh­atsapp: escolha a saudação + contato  │
         │ Consulta Pública PJE: URL do tribunal    │
         └──────────────────────────────────────────┘
```

---

## O que mudou no `index.html`

| Antes | Agora |
|-------|-------|
| Tinha só o buscador JusBrasil | Tem o buscador **+** o Reformulador **abaixo** |
| Página única | Os dois coexistem na mesma página, em seções separadas |
| CSS sem conflitos | CSS do Reformulador foi escopado a `#rf-tool` para não conflitar com o buscador |

### Como foi feita a integração

1. O Reformulador foi envolvido em `<section id="rf-tool">`.
2. Toda a CSS do Reformulador foi prefixada com `#rf-tool` (ex.: `body { ... }` virou `#rf-tool { ... }`, `.card` virou `#rf-tool .rf-card`, etc.).
3. A `.card` do Reformulador foi renomeada para `.rf-card` para não colidir com a `.card` do buscador.
4. Os `onclick="..."` do HTML foram preservados e as funções correspondentes
   foram expostas em `window.*` (porque o `onclick` inline não enxerga variáveis de IIFE).

O resultado é: o buscador continua funcionando 100% como antes, e o Reformulador funciona 100% como antes, ambos na mesma página, sem estilos se atropelando.

---

## Setup (igual à v1 — nenhuma mudança no backend)

```bash
pip install -r requirements.txt
export SERPAPI_KEY=sua_chave_aqui
uvicorn app:app --reload --port 8000
```

Abra http://localhost:8000.

O arquivo `app.py` e `jusbrasil_search.py` ficaram **idênticos** à v1. Apenas o `index.html` foi substituído.

---

## Uso combinado (workflow real)

1. **Topo**: digita o nome da pessoa no buscador JusBrasil → recebe a URL do JusBrasil.
2. **Abaixo**: cola o texto bruto do processo (copiado da página de detalhes do
   JusBrasil ou de qualquer outro lugar) → clica **✨ Reformular**.
3. O texto vira um bloco formatado com Processo / Valor / Assunto / Tribunal /
   Juiz / Polo Ativo / Polo Passivo / CPF / Telefones. **📋 Copiar** manda pra
   área de transferência.
4. A seção **Chamar no WhatsApp** mostra todos os telefones extraídos com botões
   `Abrir WhatsApp` prontos, já com a saudação selecionada (Bom dia / Boa tarde
   / Boa noite) embutida na mensagem.
5. A seção **Consulta Pública PJE** detecta automaticamente o tribunal e mostra
   o link direto do PJE daquele tribunal, com instrução de uso.

---

## Estrutura

```
files/
├── jusbrasil_search.py   # lógica pura do buscador JusBrasil (slugify, regex, ranking)
├── app.py                # FastAPI — endpoints /api/search, /, /healthz
├── index.html            # FRONTEND com buscador + reformulador integrados
├── requirements.txt      # fastapi, uvicorn, httpx
└── README.md             # este arquivo
```
