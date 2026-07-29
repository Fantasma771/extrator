"""
Extrator de Processos do JusBrasil — serviço HTTP em Python 3 (single-file).

Rotas:
  GET  /            healthcheck
  GET  /docs        documentação em texto
  POST /extract     body: { url, max_processes?, output_format? }
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

# (rótulo na página, chave estruturada)
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

    def _send(self, status, ctype, body):
        if isinstance(body, str):
            body_bytes = body.encode("utf-8")
        else:
            body_bytes = body
        self.send_response(status)
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
        if self.path == "/":
            return self._send(200, "application/json", json.dumps({
                "status": "ok",
                "servico": "Extrator de Processos do JusBrasil",
                "endpoints": ["GET /", "POST /extract", "GET /docs"],
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
