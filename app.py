"""
Extrator de Processos do JusBrasil — serviço HTTP em Python 3 (single-file).

Rotas:
  GET  /         página web (cola o link e extrai)
  GET  /api      healthcheck JSON
  GET  /docs     documentação em texto
  POST /extract  body: { url, max_processes?, output_format? }
                 output_format: "json" | "csv" | "markdown"
"""

import os
import re
import json
import csv
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

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

# JS executado dentro da página do JusBrasil para extrair os 10 campos.
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
  label { display: block; font-weight: 600; margin-top: 14px; color: #1a4480; }
  label:first-of-type { margin-top: 0; }
  input, select { width: 100%; padding: 10px 12px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; background: white; }
  input:focus, select:focus { outline: 2px solid #1a4480; outline-offset: -1px; border-color: #1a4480; }
  .row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
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
  .summary.show { display: grid; grid-template-columns: repeat(4, 1fr); }
  .stat { background: white; border: 1px solid #d0d7de; padding: 16px; border-radius: 6px; }
  .stat strong { display: block; font-size: 28px; color: #1a4480; line-height: 1; }
  .stat span { color: #5a6470; font-size: 13px; }
  .actions { margin: 16px 0; display: flex; gap: 8px; flex-wrap: wrap; }
  .actions button { background: #5a6470; margin: 0; padding: 8px 16px; font-size: 13px; }
  .table-wrap { max-height: 70vh; overflow: auto; background: white;
                border: 1px solid #d0d7de; border-radius: 6px; margin-top: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eef0f2; vertical-align: top; }
  th { background: #f5f7fa; font-weight: 600; position: sticky; top: 0; color: #1a4480; }
  tbody tr:hover { background: #fafbfc; }
  td.null { color: #b8c0c8; font-style: italic; }
  .small { font-size: 12px; color: #5a6470; }
</style>
</head>
<body>

<h1>Extrator de Processos do JusBrasil</h1>
<p class="sub">Cole o link da página de processos do advogado, escolha o limite e clique em <strong>Extrair</strong>.</p>

<div class="card">
  <label for="url">URL da página de processos do advogado</label>
  <input id="url" type="url" placeholder="https://www.jusbrasil.com.br/processos/nome/..." required>

  <div class="row">
    <div>
      <label for="max">Máximo de processos</label>
      <input id="max" type="number" min="1" max="500" value="100">
    </div>
    <div>
      <label for="format">Formato</label>
      <select id="format">
        <option value="json">Ver na tela (tabela)</option>
        <option value="csv">Baixar CSV</option>
        <option value="markdown">Baixar Markdown</option>
      </select>
    </div>
    <div>
      <label>&nbsp;</label>
      <button id="btn">Extrair processos</button>
    </div>
  </div>

  <div id="status" class="status"></div>
</div>

<div id="summary" class="summary">
  <div class="stat"><strong id="cnt">0</strong><span>Processos extraídos</span></div>
  <div class="stat"><strong id="courts">0</strong><span>Tribunais distintos</span></div>
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
const btn = $('btn'), status = $('status'), output = $('output'), summary = $('summary'), actions = $('actions');

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
  $('cnt').textContent = data.count;
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
  const max = parseInt($('max').value || '100', 10);
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
      body: JSON.stringify({ url, max_processes: max, output_format: fmt })
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
    setStatus('success', 'Extração concluída: ' + data.count + ' processo(s).');
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
    body: JSON.stringify({ url: $('url').value.trim(), max_processes: parseInt($('max').value, 10), output_format: 'csv' })
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
    body: JSON.stringify({ url: $('url').value.trim(), max_processes: parseInt($('max').value, 10), output_format: 'markdown' })
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
    page.goto(link, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(800)
    try:
        page.get_by_text(re.compile("mostrar mais", re.I)).first.click(timeout=3000)
        page.wait_for_timeout(600)
    except Exception:
        pass
    return page.evaluate(EXTRACT_JS, FIELDS)


def extract_all(url, max_processes):
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
        )
        page = ctx.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1500)
            try:
                page.get_by_text(re.compile("processos por nome", re.I)).first.click(timeout=5000)
                page.wait_for_load_state("networkidle")
                page.wait_for_timeout(800)
            except Exception:
                pass

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

            results = []
            for link in unique[: max_processes]:
                try:
                    results.append(extract_one(page, link))
                except Exception as e:
                    results.append({"_url": link, "_error": str(e)})
            return {"count": len(results), "processes": results}
        finally:
            browser.close()


def format_response(data, fmt):
    rows = data["processes"]
    cols = [
        "processo_numero", "assunto", "tribunal_origem", "juiz",
        "inicio_processo", "valor_causa",
        "polo_passivo_nome", "polo_passivo_papel",
        "polo_ativo_nome", "polo_ativo_papel", "_url",
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
                   "Polo Ativo", "Autor", "URL"]
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
        print(fmt % args, flush=True)

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
            }))
        if self.path == "/docs":
            return self._send(200, "text/plain", (
                "POST /extract\n"
                "Body JSON:\n"
                "  { url: '<jusbrasil>', max_processes: 100, output_format: 'json' }\n"
                "\n"
                "Resposta (json): { count, processes: [ { 10 campos..., _url } ] }\n"
                "Resposta (csv):  texto CSV com cabecalho\n"
                "Resposta (md):   tabela Markdown\n"
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
            max_n = max(1, min(int(body.get("max_processes") or 100), 500))
            data = extract_all(url, max_n)
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
            return self._send(500, "application/json", json.dumps({"error": str(e)}))


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Extrator JusBrasil ouvindo na porta {PORT}", flush=True)
    server.serve_forever()
