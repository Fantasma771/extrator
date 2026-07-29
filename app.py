"""
Extrator de Processos do JusBrasil — serviço HTTP em Python 3 (single-file).

Rotas:
  GET  /         página web (cola o link e extrai)
  GET  /api      healthcheck JSON
  GET  /docs     documentação em texto
  POST /extract  body: { url, max_processes?, output_format?, filter_mode? }
                 output_format: "json" | "csv" | "markdown"
                 filter_mode:   "pessoa_vs_empresa" (default) | "all"
"""

import os
import re
import json
import csv
import io
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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

EXTRACT_JS = """
([fields]) => {
  const near = (label) => {
    const lower = label.toLowerCase();
    const candidates = document.querySelectorAll('dt, strong, b, span, div, p, li, h1, h2, h3, h4, h5');
    for (const el of candidates) {
      const t = (el.textContent || '').trim();
      const tl = t.toLowerCase();
      if (tl === lower || tl.startsWith(lower + ':') || tl.startsWith(lower + ' ')) {
        const sib = el.nextElementSibling;
        if (sib && (sib.textContent || '').trim()) return (sib.textContent || '').trim();
        return t.replace(new RegExp('^' + label + '\\\\s*[:\\\\-]?\\\\s*', 'i'), '').trim();
      }
    }
    const m = (document.body.innerText || '').match(new RegExp(label + '\\\\s*[:\\\\-]?\\\\s*([^\\\\n\\\\r]+)'));
    return m ? m[1].trim() : null;
  };
  const out = { _url: location.href };
  for (const [label, key] of fields) out[key] = near(label);
  return out;
}
"""

# Marcadores que indicam PESSOA JURÍDICA (empresa, autarquia, instituto, etc.)
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
    "PETROBRAS", "ELETROBRAS", "ELETROBRÁS", "CORREIOS", "DETRAN", "IBILCE",
    "FAZENDA", "PROCURADORIA", "DEPARTAMENTO", "SECRETARIA", "AGENCIA", "AGÊNCIA",
    "AUTARQUIA", "FUNDOS", "FUNDO", "CARTORIO", "CARTÓRIO", "CONDOMINIO", "CONDOMÍNIO",
    "PADARIA", "FARMACIA", "FARMÁCIA", "LANCHONETE", "RESTAURANTE", "HOSPITAL",
    "CLINICA", "CLÍNICA", "ESCOLA", "FACULDADE", "UNIVERSIDADE", "IGREJA",
    "PARTIDO", "SINDICATO", "CONFEDERAÇÃO", "CONFEDERACAO", "FEDERAÇÃO", "FEDERACAO",
    "CONSELHO", "ORDEM", "CAIXA", "BRADESCO", "ITAU", "ITAÚ", "SANTANDER",
    "TELEFONICA", "TELEFÔNICA", "VIVO", "CLARO", "TIM", "OI", "AMBEP",
    "INDUSTRIA", "INDÚSTRIA", "COMERCIO", "COMÉRCIO", "TRANSPORTES", "IMOVEIS", "IMÓVEIS",
    "SERVICOS", "SERVIÇOS", "CONSTRUCOES", "CONSTRUÇÕES", "INCORPORADORA",
    "DISTRIBUIDORA", "IMPORTACAO", "IMPORTAÇÃO", "EXPORTACAO", "EXPORTAÇÃO",
    "REPRESENTACOES", "REPRESENTAÇÕES", "ENGENHARIA", "ARQUITETURA", "ADVOCACIA",
    "MEDICINA", "ODONTOLOGIA", "FISIOTERAPIA", "CONTABILIDADE", "AUDITORIA",
]


def _norm(s):
    if not s:
        return ""
    return re.sub(r"\s+", " ", s).strip().upper()


# Marcadores que precisam ser tokens isolados (com bordas nao-alfanuméricas)
# para não casar dentro de nomes próprios (ex.: "ME" em "ALMEIDA").
_PATTERN_ALPHA_BEFORE = r"(?<![A-Z0-9])"
_PATTERN_ALPHA_AFTER = r"(?![A-Z0-9])"


def _looks_like_pj_token(n):
    """Verifica sufixos e palavras-chave como tokens isolados (sem falso-positivo em nomes)."""
    for groups in (PJ_SUFFIXES, PJ_KEYWORDS):
        for tok in groups:
            if re.search(_PATTERN_ALPHA_BEFORE + re.escape(tok) + _PATTERN_ALPHA_AFTER, n):
                return True
    return False


def is_pessoa_juridica(name):
    """Heurística: retorna True se o nome parece de uma PJ (empresa, instituto, autarquia...)."""
    if not name:
        return False
    n = _norm(name)
    if not n:
        return False
    return _looks_like_pj_token(n)


def is_pessoa_fisica(name):
    """Pessoa física: nome próprio sem marcadores de PJ."""
    if not name:
        return False
    if is_pessoa_juridica(name):
        return False
    n = _norm(name)
    words = [w for w in re.split(r"[\s\-\.]+", n) if w]
    if len(words) < 2:
        return False
    # Exige que pareça um nome próprio: ≥2 palavras, todas começando com maiúscula
    if len(words) >= 2 and all(w[0].isalpha() and w[0].isupper() for w in words):
        return True
    return False


def apply_filter(processes, mode):
    """Filtra processos conforme o modo solicitado."""
    if not mode or mode == "all":
        return processes, "none"
    if mode == "pessoa_vs_empresa":
        kept = []
        dropped = 0
        for p in processes:
            autor = p.get("polo_ativo_nome") or ""
            reu = p.get("polo_passivo_nome") or ""
            if is_pessoa_fisica(autor) and is_pessoa_juridica(reu):
                kept.append(p)
            else:
                dropped += 1
        return kept, f"pessoa_vs_empresa (descartados {dropped})"
    return processes, f"unknown:{mode}"


INDEX_HTML = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Extrator de Processos do JusBrasil</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 1280px; margin: 32px auto; padding: 0 20px; color: #1a1a1a; background: #f5f7fa; }
  h1 { color: #1a4480; margin: 0 0 8px 0; }
  .sub { color: #5a6470; margin-bottom: 24px; }
  .card { background: white; border: 1px solid #d0d7de; border-radius: 8px; padding: 24px; margin-bottom: 20px; }
  label { display: block; font-weight: 600; margin-top: 14px; color: #1a4480; font-size: 13px; }
  input, select { width: 100%; padding: 10px 12px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; background: white; }
  input:focus, select:focus { outline: 2px solid #1a4480; outline-offset: -1px; border-color: #1a4480; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  button { background: #1a4480; color: white; border: 0; padding: 12px 24px; border-radius: 6px;
           cursor: pointer; font-size: 15px; font-weight: 600; margin-top: 20px; }
  button:hover:not(:disabled) { background: #2a5490; }
  button:disabled { background: #8896a6; cursor: not-allowed; }
  .status { padding: 12px 16px; margin: 16px 0; border-radius: 6px; font-size: 14px; display: none; }
  .status.show { display: block; }
  .status.info { background: #e6f0ff; color: #1a4480; border-left: 4px solid #1a4480; }
  .status.error { background: #fde8e8; color: #b91c1c; border-left: 4px solid #b91c1c; }
  .status.success { background: #e7f7ee; color: #156a3a; border-left: 4px solid #156a3a; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #1a4480;
             border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite;
             vertical-align: middle; margin-right: 8px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .summary { display: none; gap: 12px; margin: 16px 0; }
  .summary.show { display: grid; grid-template-columns: repeat(5, 1fr); }
  .stat { background: white; border: 1px solid #d0d7de; padding: 14px; border-radius: 6px; }
  .stat strong { display: block; font-size: 24px; color: #1a4480; line-height: 1.1; word-break: break-word; }
  .stat span { color: #5a6470; font-size: 12px; }
  .actions { margin: 16px 0; display: flex; gap: 8px; flex-wrap: wrap; }
  .actions button { background: #5a6470; margin: 0; padding: 8px 16px; font-size: 13px; }
  .table-wrap { max-height: 70vh; overflow: auto; background: white;
                border: 1px solid #d0d7de; border-radius: 6px; margin-top: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eef0f2; vertical-align: top; }
  th { background: #f5f7fa; font-weight: 600; position: sticky; top: 0; color: #1a4480; }
  tbody tr:hover { background: #fafbfc; }
  td.null { color: #b8c0c8; font-style: italic; }
  .example { background: #fff8e1; border: 1px solid #f59f00; color: #5a3d00;
             padding: 10px 14px; border-radius: 6px; font-size: 13px; margin: 12px 0; }
</style>
</head>
<body>

<h1>Extrator de Processos do JusBrasil</h1>
<p class="sub">Cole o link da página de processos do advogado, escolha o filtro e clique em <strong>Extrair</strong>.</p>

<div class="example">
  <strong>Filtro padrão:</strong> mantém apenas processos <strong>Pessoa Física × Pessoa Jurídica</strong> (ex.: <em>Cintia Martins Siqueira × Instituto Nacional do Seguro Social - Inss</em>). Processos onde ambos os polos são empresas são descartados.
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
    <div style="display:flex;align-items:flex-end">
      <button id="btn">Extrair processos</button>
    </div>
  </div>

  <div id="status" class="status"></div>
</div>

<div id="summary" class="summary">
  <div class="stat"><strong id="cnt">0</strong><span>Processos extraídos</span></div>
  <div class="stat"><strong id="kept">0</strong><span>Mantidos pelo filtro</span></div>
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
const btn = $('btn'), status = $('status'), output = $('output'),
      summary = $('summary'), actions = $('actions');

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
    ['processo_numero',     'Processo n.'],
    ['assunto',             'Assunto'],
    ['tribunal_origem',     'Tribunal'],
    ['juiz',                'Juiz'],
    ['inicio_processo',     'Início'],
    ['valor_causa',         'Valor'],
    ['polo_passivo_nome',   'Polo Passivo'],
    ['polo_passivo_papel',  '(papel)'],
    ['polo_ativo_nome',     'Polo Ativo'],
    ['polo_ativo_papel',    '(papel)'],
    ['_classificacao',      'PF×PJ'],
    ['_url',                'URL'],
  ];
  let html = '<div class="table-wrap"><table><thead><tr>';
  cols.forEach(([_, title]) => { html += '<th>' + title + '</th>'; });
  html += '</tr></thead><tbody>';
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
  if (!data.processes.length) {
    html += '<tr><td colspan="' + cols.length + '" class="null" style="text-align:center;padding:32px">'
         + 'Nenhum processo retornou com esse filtro. Tente "Todos os processos" para diagnóstico.'
         + '</td></tr>';
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
  if (values.length) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    $('avg').textContent = avg.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else {
    $('avg').textContent = '—';
  }
  summary.classList.add('show');
}

async function callExtract(fmt) {
  const url = $('url').value.trim();
  const max = parseInt($('max').value || '200', 10);
  const filterMode = $('filter_mode').value;
  if (!url || !url.startsWith('http')) {
    setStatus('error', 'Cole uma URL válida começando com http:// ou https://.');
    return;
  }
  btn.disabled = true;
  output.innerHTML = '';
  actions.style.display = 'none';
  summary.classList.remove('show');
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
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus('success', 'Download iniciado: jusbrasil_processos.' + ext);
      return;
    }

    const data = await res.json();
    lastData = data;
    computeSummary(data);
    renderTable(data);
    actions.style.display = 'flex';
    const desc = data.filtro_aplicado || 'sem filtro';
    setStatus('success', 'Extração concluída. Listados: ' + data.total_listados
      + ' · Mantidos: ' + data.count + ' · ' + desc);
  } catch (e) {
    setStatus('error', 'Erro: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

btn.addEventListener('click', () => callExtract($('format').value));

async function downloadCsv() {
  if (!lastData) return;
  const res = await fetch('/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: $('url').value.trim(),
      max_processes: parseInt($('max').value, 10),
      output_format: 'csv',
      filter_mode: $('filter_mode').value })
  });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'jusbrasil_processos.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function downloadMd() {
  if (!lastData) return;
  const res = await fetch('/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: $('url').value.trim(),
      max_processes: parseInt($('max').value, 10),
      output_format: 'markdown',
      filter_mode: $('filter_mode').value })
  });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'jusbrasil_processos.md';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function copyJson() {
  if (!lastData) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastData, null, 2));
    setStatus('success', 'JSON copiado para a área de transferência.');
  } catch (e) {
    setStatus('error', 'Não foi possível copiar: ' + e.message);
  }
}
</script>

</body>
</html>
"""


def extract_one(page, link):
    log.info("Abrindo detalhe: %s", link)
    page.goto(link, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(1200)
    try:
        page.get_by_text(re.compile("mostrar mais", re.I)).first.click(timeout=4000)
        page.wait_for_timeout(800)
    except Exception as e:
        log.info("'Mostrar mais' não encontrado em %s: %s", link, e)
    return page.evaluate(EXTRACT_JS, FIELDS)


def classify_pair(p):
    """Anota no dicionário do processo a classificação PF/PJ dos polos."""
    autor = p.get("polo_ativo_nome") or ""
    reu = p.get("polo_passivo_nome") or ""
    p["_autor_tipo"] = "PJ" if is_pessoa_juridica(autor) else ("PF" if is_pessoa_fisica(autor) else "?")
    p["_reu_tipo"] = "PJ" if is_pessoa_juridica(reu) else ("PF" if is_pessoa_fisica(reu) else "?")
    p["_classificacao"] = p["_autor_tipo"] + "×" + p["_reu_tipo"]
    return p


def extract_all(url, max_processes):
    log.info("Iniciando extração: url=%s max=%s", url, max_processes)
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
            ],
        )
        ctx = browser.new_context(
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/124.0.0.0 Safari/537.36"),
            locale="pt-BR",
            viewport={"width": 1366, "height": 768},
            extra_http_headers={
                "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
            },
        )
        page = ctx.new_page()
        page.set_default_timeout(30000)

        try:
            log.info("Navegando até a página do advogado...")
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(2000)

            log.info("Procurando 'Processos por nome'...")
            try:
                page.get_by_text(re.compile("processos por nome", re.I)).first.click(timeout=5000)
                page.wait_for_load_state("networkidle", timeout=15000)
                page.wait_for_timeout(1500)
            except Exception as e:
                log.warning("'Processos por nome' não clicado: %s (seguindo em frente)", e)

            log.info("Coletando links de processos...")
            links = page.eval_on_selector_all(
                "a",
                "(els) => els.map(e => e.href).filter(h => h && /\\/processos\\//.test(h))",
            )
            seen, unique = set(), []
            for href in links:
                if href in seen or href == url:
                    continue
                seen.add(href)
                unique.append(href)
            log.info("Encontrados %d links únicos. Processando até %d.", len(unique), max_processes)

            results = []
            for i, link in enumerate(unique[: max_processes]):
                try:
                    p_data = extract_one(page, link)
                    p_data = classify_pair(p_data)
                    results.append(p_data)
                    log.info("  [%d/%d] OK %s", i + 1, min(len(unique), max_processes), link)
                except Exception as e:
                    log.error("  [%d/%d] ERRO %s: %s", i + 1, len(unique), link, e)
                    results.append({"_url": link, "_error": str(e), "_classificacao": "?×?"})
            return {"total_listados": len(results), "processes": results}
        finally:
            log.info("Fechando navegador.")
            browser.close()


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


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log.info("%s - " + fmt, self.address_string(), *args)

    def _send(self, status_code, ctype, body):
        if isinstance(body, str):
            body_bytes = body.encode("utf-8")
        else:
            body_bytes = body
        self.send_response(status_code)
        if ctype:
            suffix = "; charset=utf-8" if ctype.startswith("text") else ""
            self.send_header("Content-Type", ctype + suffix)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    def do_OPTIONS(self):
        self._send(204, "", b"")

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            return self._send(200, "text/html", INDEX_HTML)
        if self.path == "/api":
            return self._send(200, "application/json", json.dumps({
                "status": "ok",
                "servico": "Extrator de Processos do JusBrasil",
                "endpoints": ["GET /", "GET /api", "GET /docs", "POST /extract"],
                "filtros": ["pessoa_vs_empresa", "all"],
            }))
        if self.path == "/docs":
            return self._send(200, "text/plain", (
                "POST /extract\n"
                "Body JSON:\n"
                "  { url, max_processes, output_format, filter_mode }\n"
                "\n"
                "  filter_mode:\n"
                "    pessoa_vs_empresa  (default) - só processos PF contra PJ\n"
                "    all                - retorna todos\n"
                "\n"
                "  output_format: json | csv | markdown\n"
            ))
        return self._send(404, "application/json", json.dumps({"error": "Nao encontrado"}))

    def do_POST(self):
        if self.path != "/extract":
            return self._send(404, "application/json", json.dumps({"error": "Nao encontrado"}))

        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
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
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(body_bytes)))
                self.end_headers()
                self.wfile.write(body_bytes)
                return

            text, ctype = format_response(data, fmt)
            self._send(200, ctype, text)
        except Exception as e:
            log.exception("Erro no /extract")
            return self._send(500, "application/json", json.dumps({"error": str(e)}))


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log.info("Extrator JusBrasil ouvindo na porta %s", PORT)
    server.serve_forever()
