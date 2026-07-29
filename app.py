"""
Extrator de Processos do JusBrasil — serviço HTTP em Python 3 (single-file).

Rotas:
  GET  /                       página web
  GET  /api                    healthcheck JSON
  GET  /docs                   documentação em texto
  POST /extract                { url, max_processes?, output_format?, filter_mode? }
  POST /debug (ou GET /debug?url=...)   diagnóstico: screenshot + HTML excerpt + links
  GET  /screenshot/&lt;file&gt;          serve screenshots de /tmp
"""

import os
import re
import json
import csv
import io
import time
import logging
import threading
import glob
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("jusbrasil")

PORT = int(os.environ.get("PORT", "10000"))

FIELDS = [
    ("Processo n.",        "processo_numero"),
    ("Assunto",            "assunto"),
    ("Tribunal de origem", "tribunal_origem"),
    ("Juiz",               "juiz"),
    ("Início do processo", "inicio_processo"),
    ("Valor da causa",     "valor_causa"),
    ("Polo Passivo",       "polo_passivo_nome"),
    ("Parte passiva",      "polo_passivo_papel"),
    ("Polo Ativo",         "polo_ativo_nome"),
    ("Autor",              "polo_ativo_papel"),
]

# ============== EXTRAÇÃO JS ROBUSTA (4 estratégias) ==============
EXTRACT_JS = r"""
([fields]) => {
  const out = { _url: location.href };

  function setBest(key, value) {
    if (value == null) return;
    const v = String(value).trim();
    if (!v) return;
    if (!out[key] || out[key].length < v.length) out[key] = v;
  }

  function labelMatches(labelNode, label) {
    const t = (labelNode.textContent || '').trim().toLowerCase();
    const ll = label.toLowerCase();
    return t === ll || t.startsWith(ll + ':') || t.startsWith(ll + ' ') ||
           t.startsWith(ll + '.') || (t.length >= ll.length && t.startsWith(ll));
  }

  // A. <dt><dd>
  document.querySelectorAll('dt').forEach(dt => {
    const dd = dt.nextElementSibling;
    if (dd && dd.tagName === 'DD') {
      for (const [label, key] of fields) {
        if (labelMatches(dt, label)) setBest(key, dd.textContent);
      }
    }
  });

  // B. Pares de filhos (label, valor) em containers
  document.querySelectorAll('div, li, ul, section, article, tr, p').forEach(parent => {
    const kids = Array.from(parent.children);
    for (let i = 0; i < kids.length - 1; i++) {
      for (const [label, key] of fields) {
        if (labelMatches(kids[i], label)) {
          setBest(key, kids[i + 1].textContent);
        }
      }
    }
  });

  // C. Texto puro em um nó (span/strong/b/p/...) + próximo irmão
  document.querySelectorAll('span, strong, b, p, h1, h2, h3, h4, h5, label, dt').forEach(el => {
    if (el.childElementCount === 0) {
      const sib = el.nextElementSibling;
      if (sib) {
        for (const [label, key] of fields) {
          if (labelMatches(el, label)) setBest(key, sib.textContent);
        }
      }
      // D. ou próximo parente
      const parent = el.parentElement;
      if (parent && parent.nextElementSibling) {
        for (const [label, key] of fields) {
          if (labelMatches(el, label)) setBest(key, parent.nextElementSibling.textContent);
        }
      }
    }
  });

  // D. Fallback: regex sobre body text para campos ainda vazios
  const filled = Object.values(out).filter(v => v && v !== location.href).length;
  if (filled < 7) {
    const text = (document.body.innerText || '').slice(0, 80000);
    for (const [label, key] of fields) {
      if (out[key]) continue;
      const escaped = label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const m = text.match(new RegExp(escaped + '[\\s:\\-]*([^\\n\\r]+)'));
      if (m && m[1]) setBest(key, m[1]);
    }
  }

  return out;
}
"""

# ============== DETECÇÃO DE LISTAGEM ROBUSTA ==============
LISTING_JS = r"""
() => {
  const CNJ = /\d{4,}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;
  const PATHS = /\/(processos|jurisprudencia|diarios)\//;
  const seen = new Set();
  const out = [];
  document.querySelectorAll('a').forEach(e => {
    const href = e.href;
    if (!href || seen.has(href)) return;
    if (PATHS.test(href) || CNJ.test(href)) {
      seen.add(href);
      out.push(href);
    }
  });
  return out;
}
"""

# ============== DETECÇÃO PF/PJ ==============
PJ_SUFFIXES = [
    "S.A.", "S/A", "SA", "LTDA", "LTDA.", "LTDA -", "EIRELI", "ME", "EPP", "LIMITADA",
    "SOCIEDADE", "COMPANHIA", "CIA", "INC.", "INCORPORATED", "LLC", "LLP", "PLC", "GMBH",
    "AS", "AG",
]
PJ_KEYWORDS = [
    "INSTITUTO", "BANCO", "EMPRESA", "SEGURADORA", "OPERADORA", "COOPERATIVA",
    "FUNDACAO", "FUNDAÇÃO", "ASSOCIACAO", "ASSOCIAÇÃO", "MINISTERIO", "MINISTÉRIO",
    "RECEITA", "UNIAO", "UNIÃO", "FEDERAL", "ESTADUAL", "MUNICIPAL", "MUNICIPIO",
    "MUNICÍPIO", "TRIBUNAL", "JUSTIÇA", "JUSTICA", "CAMARA", "CÂMARA",
    "PREFEITURA", "POLICIA", "POLÍCIA", "FORÇA", "FORCA", "EXERCITO", "EXÉRCITO",
    "MARINHA", "AERONAUTICA", "AERONÁUTICA", "INSS", "INPS", "CVM", "CGU", "SUS",
    "PETROBRAS", "ELETROBRAS", "ELETROBRÁS", "CORREIOS", "DETRAN",
    "FAZENDA", "PROCURADORIA", "DEPARTAMENTO", "SECRETARIA", "AGENCIA", "AGÊNCIA",
    "AUTARQUIA", "FUNDOS", "FUNDO", "CARTORIO", "CARTÓRIO", "CONDOMINIO", "CONDOMÍNIO",
    "HOSPITAL", "CLINICA", "CLÍNICA", "ESCOLA", "FACULDADE", "UNIVERSIDADE", "IGREJA",
    "PARTIDO", "SINDICATO", "CONFEDERAÇÃO", "CONFEDERACAO", "FEDERAÇÃO", "FEDERACAO",
    "CONSELHO", "ORDEM", "CAIXA", "BRADESCO", "ITAU", "ITAÚ", "SANTANDER",
    "TELEFONICA", "TELEFÔNICA", "VIVO", "CLARO", "TIM", "OI",
    "INDUSTRIA", "INDÚSTRIA", "COMERCIO", "COMÉRCIO", "TRANSPORTES", "IMOVEIS", "IMÓVEIS",
    "SERVICOS", "SERVIÇOS", "CONSTRUCOES", "CONSTRUÇÕES", "INCORPORADORA",
    "DISTRIBUIDORA", "IMPORTACAO", "IMPORTAÇÃO", "EXPORTACAO", "EXPORTAÇÃO",
    "ENGENHARIA", "ARQUITETURA", "ADVOCACIA", "MEDICINA", "ODONTOLOGIA",
    "FISIOTERAPIA", "CONTABILIDADE", "AUDITORIA",
]


def _norm(s):
    if not s:
        return ""
    return re.sub(r"\s+", " ", s).strip().upper()


# Lookbehind/lookahead alfanumérico para evitar falso-positivo (ex.: "ME" em "ALMEIDA").
def is_pessoa_juridica(name):
    if not name:
        return False
    n = _norm(name)
    if not n:
        return False
    before = r"(?<![A-Z0-9])"
    after = r"(?![A-Z0-9])"
    for groups in (PJ_SUFFIXES, PJ_KEYWORDS):
        for tok in groups:
            if re.search(before + re.escape(tok) + after, n):
                return True
    return False


def is_pessoa_fisica(name):
    if not name:
        return False
    if is_pessoa_juridica(name):
        return False
    n = _norm(name)
    words = [w for w in re.split(r"[\s\-\.]+", n) if w]
    if len(words) < 2:
        return False
    if len(words) >= 2 and all(w[0].isalpha() and w[0].isupper() for w in words):
        return True
    return False


def classify_pair(p):
    autor = p.get("polo_ativo_nome") or ""
    reu = p.get("polo_passivo_nome") or ""
    p["_autor_tipo"] = "PJ" if is_pessoa_juridica(autor) else ("PF" if is_pessoa_fisica(autor) else "?")
    p["_reu_tipo"] = "PJ" if is_pessoa_juridica(reu) else ("PF" if is_pessoa_fisica(reu) else "?")
    p["_classificacao"] = p["_autor_tipo"] + "×" + p["_reu_tipo"]
    return p


def apply_filter(processes, mode):
    if not mode or mode == "all":
        return processes, "none"
    if mode == "pessoa_vs_empresa":
        kept = []
        for p in processes:
            autor = p.get("polo_ativo_nome") or ""
            reu = p.get("polo_passivo_nome") or ""
            if is_pessoa_fisica(autor) and is_pessoa_juridica(reu):
                kept.append(p)
        return kept, "pessoa_vs_empresa"
    return processes, f"unknown:{mode}"


# ============== MULTI-PATTERN click em 'Mostrar mais' ==============
def try_click_mostrar_mais(page):
    patterns = [
        "mostrar mais", "ver mais", "mostrar detalhes", "ver detalhes",
        "ver completo", "expandir", "carregar mais", "ver tudo",
    ]
    for pat in patterns:
        try:
            page.get_by_text(re.compile(pat, re.I)).first.click(timeout=2500)
            page.wait_for_timeout(700)
            log.info("Click em 'Mostrar mais' via texto '%s' OK", pat)
            return True
        except Exception:
            pass
    for sel in ["button:has-text('Mais')", "button:has-text('detalhes')",
                "button:has-text('Mostrar')", "[class*='Expand']",
                "[class*='ShowMore']", "[class*='more']"]:
        try:
            elem = page.query_selector(sel)
            if elem:
                elem.click(timeout=2000)
                page.wait_for_timeout(700)
                log.info("Click em seletor '%s' OK", sel)
                return True
        except Exception:
            pass
    log.info("Botão 'Mostrar mais' não encontrado (dados podem estar visíveis).")
    return False


# ============== EXTRAÇÃO DE UM PROCESSO ==============
def extract_one(page, link):
    log.info("Abrindo detalhe: %s", link)
    page.goto(link, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(1200)
    try_click_mostrar_mais(page)
    page.wait_for_timeout(400)
    return page.evaluate(EXTRACT_JS, FIELDS)


# ============== EXTRAÇÃO TOTAL ==============
def extract_all(url, max_processes):
    log.info("Iniciando extração: url=%s max=%s", url, max_processes)
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        )
        ctx = browser.new_context(
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/124.0.0.0 Safari/537.36"),
            locale="pt-BR",
            viewport={"width": 1366, "height": 768},
            extra_http_headers={"Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"},
        )
        page = ctx.new_page()
        page.set_default_timeout(30000)
        try:
            log.info("Navegando até a página do advogado...")
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(2500)

            try:
                page.get_by_text(re.compile("processos por nome", re.I)).first.click(timeout=4000)
                page.wait_for_load_state("networkidle", timeout=15000)
                page.wait_for_timeout(1200)
                log.info("Sessão 'Processos por nome' clicada.")
            except Exception as e:
                log.info("'Processos por nome' não clicado (seguindo): %s", e)

            log.info("Coletando links de processos...")
            links = page.evaluate(LISTING_JS)
            seen, unique = set(), []
            for href in links:
                if href in seen or href == url:
                    continue
                seen.add(href)
                unique.append(href)
            log.info("Encontrados %d links únicos. Processando até %d.", len(unique), max_processes)

            results = []
            total = min(len(unique), max_processes)
            for i, link in enumerate(unique[:max_processes]):
                try:
                    p_data = extract_one(page, link)
                    p_data = classify_pair(p_data)
                    results.append(p_data)
                    log.info("  [%d/%d] OK", i + 1, total)
                except Exception as e:
                    log.error("  [%d/%d] ERRO: %s", i + 1, total, e)
                    results.append({"_url": link, "_error": str(e), "_classificacao": "?×?"})
            return {"total_listados": len(results), "processes": results}
        finally:
            log.info("Fechando navegador.")
            browser.close()


# ============== /DEBUG: diagnóstico com screenshot ==============
SCREENSHOT_DIR = "/tmp/jusbrasil-screenshots"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)
SCREENSHOT_FILES = {}  # name -> path


def run_debug(url, max_processes=5):
    """Abre a URL + 1 sublink, tira screenshot, retorna diagnóstico JSON."""
    log.info("DEBUG: %s", url)
    ts = int(time.time() * 1000)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        )
        ctx = browser.new_context(
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
            locale="pt-BR",
            viewport={"width": 1366, "height": 768},
        )
        page = ctx.new_page()
        page.set_default_timeout(30000)
        diag = {"url_requested": url, "steps": []}
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(2500)
            diag["page_title"] = page.title()
            diag["steps"].append({"step": "loaded_listing", "title": page.title()})

            shot_name = f"listing-{ts}.png"
            shot_path = os.path.join(SCREENSHOT_DIR, shot_name)
            page.screenshot(path=shot_path, full_page=False)
            SCREENSHOT_FILES[shot_name] = shot_path
            diag["screenshot_listing"] = f"/screenshot/{shot_name}"

            try:
                page.get_by_text(re.compile("processos por nome", re.I)).first.click(timeout=4000)
                page.wait_for_load_state("networkidle", timeout=15000)
                page.wait_for_timeout(1500)
                diag["steps"].append({"step": "clicked_processos_por_nome", "ok": True})
                page.screenshot(path=os.path.join(SCREENSHOT_DIR, f"listing-after-click-{ts}.png"))
                SCREENSHOT_FILES[f"listing-after-click-{ts}.png"] = os.path.join(SCREENSHOT_DIR, f"listing-after-click-{ts}.png")
                diag["screenshot_after_click"] = f"/screenshot/listing-after-click-{ts}.png"
            except Exception as e:
                diag["steps"].append({"step": "clicked_processos_por_nome", "ok": False, "error": str(e)})

            content = page.content()
            diag["html_length"] = len(content)
            diag["html_excerpt"] = content[:5000]

            links = page.evaluate(LISTING_JS)
            diag["links_found"] = len(links)
            diag["links_sample"] = links[:20]

            if links:
                sample = links[0]
                try:
                    diag["steps"].append({"step": "open_first_link", "url": sample})
                    page.goto(sample, wait_until="domcontentloaded", timeout=30000)
                    page.wait_for_timeout(1500)
                    clicked = try_click_mostrar_mais(page)
                    diag["steps"].append({"step": "click_mostrar_mais", "ok": clicked})
                    page.wait_for_timeout(600)

                    shot2 = f"process-{ts}.png"
                    page.screenshot(path=os.path.join(SCREENSHOT_DIR, shot2), full_page=False)
                    SCREENSHOT_FILES[shot2] = os.path.join(SCREENSHOT_DIR, shot2)
                    diag["screenshot_process"] = f"/screenshot/{shot2}"

                    fields = page.evaluate(EXTRACT_JS, FIELDS)
                    diag["sample_extraction"] = fields
                    diag["sample_extraction_counts"] = {
                        k: 1 if v else 0
                        for k, v in fields.items()
                    }
                except Exception as e:
                    log.exception("Erro no link de amostra")
                    diag["steps"].append({"step": "open_first_link", "error": str(e)})

            diag["ok"] = True
            return diag
        except Exception as e:
            log.exception("Erro no /debug")
            diag["ok"] = False
            diag["error"] = str(e)
            return diag
        finally:
            browser.close()


# ============== FORMATADORES ==============
def format_response(data, fmt):
    rows = data["processes"]
    cols = [
        "processo_numero", "assunto", "tribunal_origem", "juiz",
        "inicio_processo", "valor_causa",
        "polo_passivo_nome", "polo_passivo_papel",
        "polo_ativo_nome", "polo_ativo_papel", "_classificacao", "_url",
    ]
    if fmt == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(cols)
        for row in rows:
            writer.writerow([row.get(c, "") for c in cols])
        return buf.getvalue(), "text/csv"

    if fmt in ("markdown", "md"):
        headers = ["Processo n.", "Assunto", "Tribunal", "Juiz",
                   "Início", "Valor",
                   "Polo Passivo", "Parte passiva",
                   "Polo Ativo", "Autor", "Tipo", "URL"]
        lines = [
            "| " + " | ".join(headers) + " |",
            "| " + " | ".join(["---"] * len(headers)) + " |",
        ]
        for row in rows:
            cells = [str(row.get(c, "")).replace("|", "\\|") for c in cols]
            lines.append("| " + " | ".join(cells) + " |")
        return "\n".join(lines), "text/markdown"

    return json.dumps(data, ensure_ascii=False, indent=2), "application/json"


# ============== HTTP HANDLER ==============
def with_cors(handler):
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")


INDEX_HTML = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Extrator de Processos do JusBrasil</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:1280px;margin:32px auto;padding:0 20px;color:#1a1a1a;background:#f5f7fa}
  h1{color:#1a4480;margin:0 0 8px}
  .sub{color:#5a6470;margin-bottom:20px}
  .example{background:#fff8e1;border:1px solid #f59f00;color:#5a3d00;padding:10px 14px;border-radius:6px;font-size:13px;margin:12px 0}
  .card{background:white;border:1px solid #d0d7de;border-radius:8px;padding:24px;margin-bottom:20px}
  label{display:block;font-weight:600;margin-top:14px;color:#1a4480;font-size:13px}
  input,select{width:100%;padding:10px 12px;border:1px solid #d0d7de;border-radius:6px;font-size:14px;background:white}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  button{background:#1a4480;color:white;border:0;padding:12px 24px;border-radius:6px;cursor:pointer;font-size:15px;font-weight:600;margin-top:20px}
  button:hover:not(:disabled){background:#2a5490}
  button.secondary{background:#5a6470;margin-left:8px}
  button:disabled{background:#8896a6;cursor:not-allowed}
  .status{padding:12px 16px;margin:16px 0;border-radius:6px;font-size:14px;display:none}
  .status.show{display:block}
  .status.info{background:#e6f0ff;color:#1a4480;border-left:4px solid #1a4480}
  .status.error{background:#fde8e8;color:#b91c1c;border-left:4px solid #b91c1c}
  .status.success{background:#e7f7ee;color:#156a3a;border-left:4px solid #156a3a}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid #1a4480;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:8px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .summary{display:none;gap:12px;margin:16px 0}
  .summary.show{display:grid;grid-template-columns:repeat(5,1fr)}
  .stat{background:white;border:1px solid #d0d7de;padding:14px;border-radius:6px}
  .stat strong{display:block;font-size:24px;color:#1a4480;line-height:1.1;word-break:break-word}
  .stat span{color:#5a6470;font-size:12px}
  .actions{margin:16px 0;display:flex;gap:8px;flex-wrap:wrap}
  .actions button{background:#5a6470;margin:0;padding:8px 16px;font-size:13px}
  .table-wrap{max-height:70vh;overflow:auto;background:white;border:1px solid #d0d7de;border-radius:6px;margin-top:16px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f2;vertical-align:top}
  th{background:#f5f7fa;font-weight:600;position:sticky;top:0;color:#1a4480}
  tbody tr:hover{background:#fafbfc}
  td.null{color:#b8c0c8;font-style:italic}
  details{margin-top:12px}
  details summary{cursor:pointer;font-weight:600;color:#1a4480}
  pre{background:#f0f2f5;padding:12px;border-radius:6px;overflow:auto;font-size:12px}
</style>
</head>
<body>

<h1>Extrator de Processos do JusBrasil</h1>
<p class="sub">Cole o link da página de processos do advogado e clique em <strong>Extrair</strong>.</p>

<div class="example">
  <strong>Filtro padrão:</strong> mantém apenas processos <strong>Pessoa Física × Pessoa Jurídica</strong>
  (ex.: <em>Cintia Martins Siqueira × Instituto Nacional do Seguro Social - Inss</em>).
</div>

<div class="card">
  <label for="url">URL da página de processos do advogado</label>
  <input id="url" type="url" placeholder="https://www.jusbrasil.com.br/processos/nome/..." required>

  <div class="row">
    <div>
      <label for="max">Máximo de processos</label>
      <input id="max" type="number" min="1" max="500" value="200">
    </div>
    <div>
      <label for="filter_mode">Filtro</label>
      <select id="filter_mode">
        <option value="pessoa_vs_empresa">Pessoa × Empresa (recomendado)</option>
        <option value="all">Todos os processos</option>
      </select>
    </div>
  </div>

  <div class="row">
    <div>
      <label for="format">Formato de saída</label>
      <select id="format">
        <option value="json">Ver na tela (tabela)</option>
        <option value="csv">Baixar CSV</option>
        <option value="markdown">Baixar Markdown</option>
      </select>
    </div>
    <div style="display:flex;align-items:flex-end;gap:8px">
      <button id="btn">Extrair processos</button>
      <button id="btnDebug" class="secondary" title="Abre a URL, tira 3 screenshots e mostra o que o bot está vendo">Diagnóstico</button>
    </div>
  </div>

  <div id="status" class="status"></div>
</div>

<div id="debugArea"></div>

<div id="summary" class="summary">
  <div class="stat"><strong id="cnt">0</strong><span>Listados</span></div>
  <div class="stat"><strong id="kept">0</strong><span>Mantidos</span></div>
  <div class="stat"><strong id="courts">0</strong><span>Tribunais únicos</span></div>
  <div class="stat"><strong id="authors">0</strong><span>Polos ativos únicos</span></div>
  <div class="stat"><strong id="avg">—</strong><span>Valor médio (R$)</span></div>
</div>

<div id="actions" class="actions" style="display:none">
  <button onclick="downloadCsv()">Baixar CSV</button>
  <button onclick="downloadMd()">Baixar Markdown</button>
  <button onclick="copyJson()">Copiar JSON</button>
</div>
<div id="output"></div>

<script>
let lastData = null;
const $ = (id) => document.getElementById(id);
const btn = $('btn'), btnDebug = $('btnDebug'), status = $('status'),
      output = $('output'), summary = $('summary'), actions = $('actions'),
      debugArea = $('debugArea');

function setStatus(kind, msg, spinner) {
  status.className = 'status show ' + kind;
  status.innerHTML = (spinner ? '<span class="spinner"></span>' : '') + msg;
}

function escapeHtml(s) {
  if (s == null) return null;
  return String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
}

function renderTable(data) {
  const cols = [
    ['processo_numero','Processo n.'],
    ['assunto','Assunto'],
    ['tribunal_origem','Tribunal'],
    ['juiz','Juiz'],
    ['inicio_processo','Início'],
    ['valor_causa','Valor'],
    ['polo_passivo_nome','Polo Passivo'],
    ['polo_passivo_papel','(papel)'],
    ['polo_ativo_nome','Polo Ativo'],
    ['polo_ativo_papel','(papel)'],
    ['_classificacao','PF×PJ'],
    ['_url','URL'],
  ];
  let html = '<div class="table-wrap"><table><thead><tr>';
  cols.forEach(([_, title]) => { html += '<th>' + title + '</th>'; });
  html += '</tr></thead><tbody>';
  if (!data.processes.length) {
    html += '<tr><td colspan="' + cols.length + '" class="null" style="text-align:center;padding:32px">'
         + 'Nenhum processo retornou. Use o botão <strong>Diagnóstico</strong> para investigar a página.'
         + '</td></tr>';
  } else {
    data.processes.forEach(p => {
      html += '<tr>';
      cols.forEach(([k, _]) => {
        const v = p[k];
        if (v == null || v === '') html += '<td class="null">—</td>';
        else if (k === '_url') html += '<td><a href="' + escapeHtml(v) + '" target="_blank" rel="noopener">abrir</a></td>';
        else html += '<td>' + escapeHtml(v) + '</td>';
      });
      html += '</tr>';
    });
  }
  html += '</tbody></table></div>';
  output.innerHTML = html;
}

function computeSummary(data) {
  const courts = new Set(), authors = new Set();
  const values = [];
  data.processes.forEach(p => {
    if (p.tribunal_origem) courts.add(p.tribunal_origem);
    if (p.polo_ativo_nome) authors.add(p.polo_ativo_nome);
    if (p.valor_causa) {
      const n = parseFloat(String(p.valor_causa).replace(/[^0-9,]/g, '').replace(',', '.'));
      if (!isNaN(n) && n > 0) values.push(n);
    }
  });
  $('cnt').textContent = data.total_listados ?? data.count;
  $('kept').textContent = data.count;
  $('courts').textContent = courts.size;
  $('authors').textContent = authors.size;
  $('avg').textContent = values.length
    ? (values.reduce((a,b)=>a+b,0)/values.length).toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 })
    : '—';
  summary.classList.add('show');
}

async function callExtract(fmt) {
  const url = $('url').value.trim();
  const max = parseInt($('max').value || '200', 10);
  const filterMode = $('filter_mode').value;
  if (!url || !url.startsWith('http')) {
    setStatus('error', 'Cole uma URL válida (http/https).');
    return;
  }
  btn.disabled = true; btnDebug.disabled = true;
  output.innerHTML = ''; actions.style.display = 'none';
  summary.classList.remove('show'); debugArea.innerHTML = '';
  setStatus('info', 'Abrindo navegador headless, listando processos e clicando em cada um. Aguarde...', true);

  try {
    const res = await fetch('/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, max_processes: max, output_format: fmt, filter_mode: filterMode })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error('HTTP ' + res.status + ' — ' + errText);
    }
    if (fmt === 'csv' || fmt === 'markdown') {
      const blob = await res.blob();
      const ext = fmt === 'csv' ? 'csv' : 'md';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'jusbrasil_processos.' + ext;
      a.click(); URL.revokeObjectURL(a.href);
      setStatus('success', 'Download iniciado: jusbrasil_processos.' + ext);
      return;
    }
    const data = await res.json();
    lastData = data;
    computeSummary(data);
    renderTable(data);
    actions.style.display = 'flex';
    setStatus('success', 'Concluído. Listados: ' + data.total_listados + ' · Mantidos: ' + data.count + ' · ' + (data.filtro_aplicado || ''));
  } catch (e) {
    setStatus('error', 'Erro: ' + e.message);
  } finally {
    btn.disabled = false; btnDebug.disabled = false;
  }
}

async function callDebug() {
  const url = $('url').value.trim();
  if (!url || !url.startsWith('http')) {
    setStatus('error', 'Cole uma URL válida primeiro.');
    return;
  }
  btn.disabled = true; btnDebug.disabled = true;
  output.innerHTML = ''; actions.style.display = 'none';
  summary.classList.remove('show'); debugArea.innerHTML = '';
  setStatus('info', 'Rodando diagnóstico: abre a URL, tira screenshots, abre 1 processo de amostra e mostra o que extraiu. Aguarde...', true);

  try {
    const res = await fetch('/debug?url=' + encodeURIComponent(url));
    if (!res.ok) {
      const errText = await res.text();
      throw new Error('HTTP ' + res.status + ' — ' + errText);
    }
    const d = await res.json();
    let html = '<div class="card"><h3 style="margin-top:0">Diagnóstico</h3>';
    html += '<p><strong>URL visitada:</strong> ' + escapeHtml(d.url_requested) + '</p>';
    if (d.error) html += '<p style="color:#b91c1c"><strong>Erro:</strong> ' + escapeHtml(d.error) + '</p>';
    if (d.page_title) html += '<p><strong>Título da página:</strong> ' + escapeHtml(d.page_title) + '</p>';
    if (typeof d.html_length === 'number') html += '<p><strong>Tamanho do HTML:</strong> ' + d.html_length + ' caracteres</p>';
    html += '<p><strong>Links de processos encontrados:</strong> ' + (d.links_found || 0) + '</p>';
    if (d.screenshot_listing) html += '<p><a href="' + d.screenshot_listing + '" target="_blank">📷 Screenshot da listagem</a></p>';
    if (d.screenshot_after_click) html += '<p><a href="' + d.screenshot_after_click + '" target="_blank">📷 Listagem após clicar "Processos por nome"</a></p>';
    if (d.screenshot_process) html += '<p><a href="' + d.screenshot_process + '" target="_blank">📷 Screenshot do 1º processo (após "Mostrar mais")</a></p>';
    if (d.links_sample && d.links_sample.length) {
      html += '<details><summary>Primeiros links encontrados (' + d.links_sample.length + ')</summary><pre>'
            + escapeHtml(d.links_sample.join('\\n')) + '</pre></details>';
    }
    if (d.sample_extraction) {
      const filled = Object.entries(d.sample_extraction_counts || {})
        .filter(([k,v]) => k !== '_url' && v === 1).map(([k]) => k);
      html += '<p><strong>Campos extraídos do 1º processo:</strong> '
            + (filled.length ? filled.join(', ') : '<em>nenhum</em>')
            + ' (' + filled.length + ' de 10)</p>';
      html += '<details><summary>Dados completos do 1º processo</summary><pre>'
            + escapeHtml(JSON.stringify(d.sample_extraction, null, 2)) + '</pre></details>';
    }
    html += '<details><summary>Primeiros 5000 caracteres do HTML</summary><pre>'
          + escapeHtml((d.html_excerpt || '').slice(0, 5000)) + '</pre></details>';
    html += '</div>';
    debugArea.innerHTML = html;
    setStatus('success', 'Diagnóstico pronto — veja abaixo. Use os screenshots para entender por que a extração falha.');
  } catch (e) {
    setStatus('error', 'Erro no diagnóstico: ' + e.message);
  } finally {
    btn.disabled = false; btnDebug.disabled = false;
  }
}

btn.addEventListener('click', () => callExtract($('format').value));
btnDebug.addEventListener('click', () => callDebug());

async function downloadCsv() {
  if (!lastData) return;
  const res = await fetch('/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: $('url').value.trim(),
      max_processes: parseInt($('max').value, 10),
      output_format: 'csv', filter_mode: $('filter_mode').value })
  });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'jusbrasil_processos.csv'; a.click();
  URL.revokeObjectURL(a.href);
}

async function downloadMd() {
  if (!lastData) return;
  const res = await fetch('/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: $('url').value.trim(),
      max_processes: parseInt($('max').value, 10),
      output_format: 'markdown', filter_mode: $('filter_mode').value })
  });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'jusbrasil_processos.md'; a.click();
  URL.revokeObjectURL(a.href);
}

async function copyJson() {
  if (!lastData) return;
  try { await navigator.clipboard.writeText(JSON.stringify(lastData, null, 2));
    setStatus('success', 'JSON copiado.');
  } catch (e) { setStatus('error', 'Não foi possível copiar: ' + e.message); }
}
</script>

</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "JusBrasilExtractor/1.6"

    def log_message(self, fmt, *args):
        log.info("%s - " + fmt, self.address_string(), *args)

    def _send(self, status_code, ctype, body):
        if isinstance(body, str):
            body_bytes = body.encode("utf-8")
        elif isinstance(body, bytes):
            body_bytes = body
        else:
            body_bytes = bytes(body)
        self.send_response(status_code)
        if ctype:
            suffix = "; charset=utf-8" if ctype.startswith("text") else ""
            self.send_header("Content-Type", ctype + suffix)
        with_cors(self)
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    def do_OPTIONS(self):
        self._send(204, "", b"")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            return self._send(200, "text/html", INDEX_HTML)
        if path == "/api":
            return self._send(200, "application/json", json.dumps({
                "status": "ok",
                "servico": "Extrator de Processos do JusBrasil",
                "endpoints": ["GET /", "GET /api", "GET /docs", "POST /extract", "GET|POST /debug"],
            }))
        if path == "/docs":
            return self._send(200, "text/plain", (
                "POST /extract\n"
                "  { url, max_processes, output_format, filter_mode }\n"
                "GET|POST /debug?url=...\n"
                "  Diagnostico: screenshot + HTML excerpt + sample de extracao\n"
                "GET /screenshot/<file>\n"
                "  Serve screenshots gerados pelo /debug\n"
            ))

        if path.startswith("/screenshot/"):
            fname = path[len("/screenshot/"):]
            if "/" in fname or ".." in fname:
                return self._send(400, "application/json", json.dumps({"error": "nome invalido"}))
            fpath = os.path.join(SCREENSHOT_DIR, fname)
            if not os.path.exists(fpath):
                return self._send(404, "application/json", json.dumps({"error": "screenshot nao encontrado"}))
            try:
                with open(fpath, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                with_cors(self)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                self._send(500, "application/json", json.dumps({"error": str(e)}))
            return

        if path == "/debug":
            qs = parse_qs(parsed.query)
            url = (qs.get("url") or [""])[0]
            if not url or not re.match(r"^https?://", url):
                return self._send(400, "application/json", json.dumps({"error": "parametro url obrigatorio"}))
            try:
                diag = run_debug(url)
                return self._send(200, "application/json", json.dumps(diag, ensure_ascii=False, indent=2))
            except Exception as e:
                log.exception("Erro no /debug")
                return self._send(500, "application/json", json.dumps({"error": str(e)}))

        return self._send(404, "application/json", json.dumps({"error": "Nao encontrado"}))

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"

        if path == "/extract":
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                return self._send(400, "application/json", json.dumps({"error": "JSON invalido"}))
            url = body.get("url", "")
            if not url or not re.match(r"^https?://", url):
                return self._send(400, "application/json", json.dumps({"error": "Campo url obrigatorio (http/https)"}))
            try:
                max_n = max(1, min(int(body.get("max_processes") or 200), 500))
                data = extract_all(url, max_n)
                mode = body.get("filter_mode") or "pessoa_vs_empresa"
                kept, desc = apply_filter(data["processes"], mode)
                data["processes"] = kept
                data["count"] = len(kept)
                data["filtro_aplicado"] = desc
                data["total_listados"] = data.get("total_listados", len(kept))
                fmt = str(body.get("output_format") or "json").lower()
                if fmt == "csv":
                    text, ctype = format_response(data, "csv")
                    body_bytes = text.encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv; charset=utf-8")
                    self.send_header("Content-Disposition", 'attachment; filename="jusbrasil.csv"')
                    with_cors(self)
                    self.send_header("Content-Length", str(len(body_bytes)))
                    self.end_headers()
                    self.wfile.write(body_bytes)
                    return
                text, ctype = format_response(data, fmt)
                return self._send(200, ctype, text)
            except Exception as e:
                log.exception("Erro no /extract")
                return self._send(500, "application/json", json.dumps({"error": str(e)}))

        if path == "/debug":
            try:
                body = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                body = {}
            url = body.get("url", "")
            if not url or not re.match(r"^https?://", url):
                return self._send(400, "application/json", json.dumps({"error": "Campo url obrigatorio (http/https)"}))
            try:
                diag = run_debug(url)
                return self._send(200, "application/json", json.dumps(diag, ensure_ascii=False, indent=2))
            except Exception as e:
                log.exception("Erro no /debug")
                return self._send(500, "application/json", json.dumps({"error": str(e)}))

        return self._send(404, "application/json", json.dumps({"error": "Nao encontrado"}))


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log.info("Extrator JusBrasil ouvindo na porta %s", PORT)
    server.serve_forever()
