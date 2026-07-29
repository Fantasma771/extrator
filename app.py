"""
Servidor FastAPI para o Buscador de Processos JusBrasil.

Endpoints:
    GET /                  -> serve index.html (frontend)
    GET /api/search?nome=  -> busca via SerpAPI e devolve URL JusBrasil canônica
    GET /healthz           -> healthcheck

Variáveis de ambiente:
    SERPAPI_KEY            -> obrigatória (cadastro grátis em serpapi.com)

Execução local:
    pip install -r requirements.txt
    export SERPAPI_KEY=sua_chave
    uvicorn app:app --reload --port 8000
"""
import os
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from jusbrasil_search import (
    build_query,
    extract_total_processos,
    find_jusbrasil_url,
    slugify,
)

SERPAPI_KEY = os.environ.get("SERPAPI_KEY")
SERPAPI_ENDPOINT = "https://serpapi.com/search.json"
STATIC_DIR = Path(__file__).parent

app = FastAPI(
    title="Buscador de Processos JusBrasil",
    description="Dado um nome, retorna a URL canônica do JusBrasil com todos os processos.",
    version="1.0.0",
)

# CORS permissivo — esse serviço é público, então qualquer origem pode chamar /api/search.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _require_key():
    if not SERPAPI_KEY:
        raise HTTPException(
            status_code=500,
            detail=(
                "SERPAPI_KEY não configurada. Defina a variável de ambiente "
                "SERPAPI_KEY no host (ex: Render → Environment → Add env var)."
            ),
        )


async def serpapi_search(query: str, num: int = 10):
    """Wrapper SerpAPI. Devolve lista [{title, url, description}, ...]."""
    _require_key()
    params = {
        "q": query,
        "api_key": SERPAPI_KEY,
        "num": num,
        "gl": "br",
        "hl": "pt-BR",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(SERPAPI_ENDPOINT, params=params)
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"SerpAPI respondeu {resp.status_code}: {resp.text[:300]}",
        )
    data = resp.json()
    organic = data.get("organic_results") or []
    flat = []
    for r in organic:
        flat.append({
            "title": r.get("title", ""),
            # SerpAPI usa 'link'; mas algumas integrações usam 'url' — aceitamos ambos.
            "url": r.get("link") or r.get("url") or "",
            "description": r.get("snippet") or r.get("snippet_highlighted_words_text") or "",
        })
    return flat


@app.get("/api/search")
async def search(nome: str):
    nome = (nome or "").strip()
    if len(nome) < 3:
        raise HTTPException(
            status_code=400,
            detail="Nome deve ter ao menos 3 caracteres.",
        )

    slug = slugify(nome)
    query = build_query(nome)
    results = await serpapi_search(query)
    url, match_quality = find_jusbrasil_url(results, slug)
    total = extract_total_processos(results)

    return JSONResponse({
        "nome": nome,
        "slug": slug,
        "google_query": query,
        "jusbrasil_url": url,
        "match_quality": match_quality,
        "total_processos": total,
    })


@app.get("/healthz")
async def healthz():
    _require_key()
    return {"status": "ok", "serpapi_key_set": bool(SERPAPI_KEY)}


@app.get("/")
async def root():
    return FileResponse(STATIC_DIR / "index.html")
