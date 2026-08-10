"""
Lógica pura (sem dependências externas) do Buscador de Processos JusBrasil.

Funções públicas:
    slugify(name)            -> str
    build_query(name)        -> str
    find_jusbrasil_url(...)  -> (url | None, reason)
    extract_total_processos(results) -> int | None
"""
import re
import unicodedata

# URL canônica JusBrasil: https://www.jusbrasil.com.br/processos/nome/{numeric_id}/{slug}
JUSBRASIL_PATTERN = re.compile(
    r"^https?://(?:www\.)?jusbrasil\.com\.br/processos/nome/(\d+)/([\w\-]+)/?$"
)

# Snippet típico do Google para páginas JusBrasil:
#   "O Jusbrasil encontrou 475 processos que mencionam o nome Jamila ..."
TOTAL_RE = re.compile(r"encontrou\s+(\d+)\s+processos?", re.IGNORECASE)


def slugify(name: str) -> str:
    """Lowercase + sem acento + hífens. Ex: 'João da Silva' -> 'joao-da-silva'."""
    nfkd = unicodedata.normalize("NFKD", name)
    only_ascii = "".join(c for c in nfkd if not unicodedata.combining(c))
    only_ascii = only_ascii.encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", only_ascii).strip("-").lower()
    return cleaned


def build_query(name: str) -> str:
    """Query Google otimizada: nome entre aspas + filtro de site + 'processos'."""
    quoted = f'"{name.strip()}"'
    return f"{quoted} site:jusbrasil.com.br processos"


def find_jusbrasil_url(results, expected_slug):
    """
    Filtra e ranqueia URLs JusBrasil de /processos/nome/.

    Prioridade:
      1) exact_slug_match       - slug bate exatamente
      2) slug_strip_match       - bate após remover hifens (cobre acentos)
      3) first_jusbrasil_match  - primeiro JusBrasil dos resultados
      4) no_jusbrasil_url_in_results - nada encontrado

    `results` é uma lista de dicts com pelo menos a chave "url".
    """
    matches = []
    for r in results:
        url = r.get("url") or r.get("link") or ""
        m = JUSBRASIL_PATTERN.match(url)
        if not m:
            continue
        _id, slug = m.group(1), m.group(2)
        matches.append((url, slug, _id))

    if not matches:
        return None, "no_jusbrasil_url_in_results"

    for url, slug, _id in matches:
        if slug == expected_slug:
            return url, "exact_slug_match"

    for url, slug, _id in matches:
        if slug.replace("-", "") == expected_slug.replace("-", ""):
            return url, "slug_strip_match"

    return matches[0][0], "first_jusbrasil_match"


def extract_total_processos(results):
    """Procura nos snippets o número de processos que o JusBrasil encontrou."""
    snippets = " ".join(
        (r.get("description") or r.get("snippet") or "") for r in results
    )
    m = TOTAL_RE.search(snippets)
    return int(m.group(1)) if m else None
