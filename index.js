// Extrator de Processos do JusBrasil - Serviço HTTP para Render
// Rotas:
//   GET  /            -> healthcheck
//   POST /extract     -> { url, max_processes?, output_format? }  -> JSON / CSV / Markdown
//   GET  /docs        -> documentação em texto
//
// Uso:
//   POST /extract
//   { "url": "https://www.jusbrasil.com.br/jurisprudencia/...",
//     "max_processes": 50,
//     "output_format": "json" | "csv" | "markdown" }

const http = require('http');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3000;

// Rótulo na página -> chave estruturada
const FIELDS = [
  ['Processo n.',          'processo_numero'],
  ['Assunto',              'assunto'],
  ['Tribunal de origem',   'tribunal_origem'],
  ['Juiz',                 'juiz'],
  ['Início do processo',   'inicio_processo'],
  ['Valor da causa',       'valor_causa'],
  ['Polo Passivo',         'polo_passivo_nome'],
  ['Parte passiva',        'polo_passivo_papel'],
  ['Polo Ativo',           'polo_ativo_nome'],
  ['Autor',                'polo_ativo_papel'],
];

// Lê valor adjacente ao rótulo no DOM
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

async function extractOne(page, link) {
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(800);

  // Expande "Mostrar mais"
  try {
    await page.getByText(/mostrar mais/i).first().click({ timeout: 3000 });
    await page.waitForTimeout(600);
  } catch (_) { /* botão pode não existir; prossegue */ }

  return await page.evaluate((fields) => {
    const near = (label) => {
      const lower = label.toLowerCase();
      const candidates = [...document.querySelectorAll('dt, strong, b, span, div, p, li, h1, h2, h3, h4, h5')];
      for (const el of candidates) {
        const t = (el.textContent || '').trim();
        const tl = t.toLowerCase();
        if (tl === lower || tl.startsWith(lower + ':') || tl.startsWith(lower + ' ')) {
          const sib = el.nextElementSibling;
          if (sib && (sib.textContent || '').trim()) {
            return (sib.textContent || '').trim();
          }
          return t.replace(new RegExp('^' + label + '\\s*[:\\-]?\\s*', 'i'), '').trim();
        }
      }
      const m = (document.body.innerText || '').match(new RegExp(label + '\\s*[:\\-]?\\s*([^\\n\\r]+)'));
      return m ? m[1].trim() : null;
    };
    const out = { _url: location.href };
    for (const [label, key] of fields) out[key] = near(label);
    return out;
  }, FIELDS);
}

async function extractAll({ url, max_processes }) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-BR',
  });
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Abre "Processos por nome"
    try {
      await page.getByText(/processos por nome/i).first().click({ timeout: 5000 });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(800);
    } catch (_) { /* pode já estar aberto */ }

    // Coleta links de processos
    const links = await page.$$eval('a', (els) =>
      els
        .map((e) => ({ text: (e.textContent || '').trim(), href: e.href }))
        .filter((x) => x.href && /\/processos\//.test(x.href))
        .map((x) => x.href)
    );
    const seen = new Set();
    const unique = links.filter((l) => {
      if (seen.has(l) || l === url) return false;
      seen.add(l);
      return true;
    });

    const results = [];
    for (const link of unique.slice(0, max_processes)) {
      try {
        results.push(await extractOne(page, link));
      } catch (e) {
        results.push({ _url: link, _error: String(e.message || e) });
      }
    }
    return { count: results.length, processes: results };
  } finally {
    await browser.close();
  }
}

function format(data, format) {
  const rows = data.processes;
  if (format === 'csv') {
    const cols = [
      'processo_numero','assunto','tribunal_origem','juiz','inicio_processo',
      'valor_causa','polo_passivo_nome','polo_passivo_papel','polo_ativo_nome','polo_ativo_papel','_url',
    ];
    const esc = (v) => `"${(v == null ? '' : String(v)).replace(/"/g, '""')}"`;
    return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  }
  if (format === 'markdown') {
    const cols = ['Processo n.','Assunto','Tribunal','Juiz','Início','Valor','Polo Passivo','Parte passiva','Polo Ativo','Autor','URL'];
    const keys = ['processo_numero','assunto','tribunal_origem','juiz','inicio_processo','valor_causa','polo_passivo_nome','polo_passivo_papel','polo_ativo_nome','polo_ativo_papel','_url'];
    const head = '| ' + cols.join(' | ') + ' |';
    const sep  = '| ' + cols.map(() => '---').join(' | ') + ' |';
    const body = rows.map((r) =>
      '| ' + keys.map((k) => (r[k] == null ? '' : String(r[k]).replace(/\|/g, '\\|'))).join(' | ') + ' |'
    );
    return [head, sep, ...body].join('\n');
  }
  return data;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      servico: 'Extrator de Processos do JusBrasil',
      endpoints: ['GET /', 'POST /extract', 'GET /docs'],
    }));
  }

  if (req.method === 'GET' && req.url === '/docs') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`POST /extract

Body JSON:
  {
    "url": "https://www.jusbrasil.com.br/processos/.../nome/...-advogado",
    "max_processes": 100,            // opcional, padrao 100
    "output_format": "json"           // ou "csv" | "markdown"
  }

Resposta (json): { count, processes: [ { ...10 campos..., _url } ] }
Resposta (csv):  texto CSV com cabecalho
Resposta (md):   tabela Markdown
`);
  }

  if (req.method === 'POST' && req.url === '/extract') {
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); }
    catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'JSON inválido' })); }

    if (!body.url || !/^https?:\/\//.test(body.url)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Campo "url" é obrigatório e deve começar com http(s)://' }));
    }

    try {
      const data = await extractAll({
        url: body.url,
        max_processes: Math.min(Math.max(Number(body.max_processes) || 100, 1), 500),
      });
      const fmt = String(body.output_format || 'json').toLowerCase();

      if (fmt === 'csv') {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="jusbrasil_processos.csv"',
        });
        return res.end(format(data, 'csv'));
      }
      if (fmt === 'markdown' || fmt === 'md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return res.end(format(data, 'markdown'));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(format(data, 'json'), null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Rota não encontrada' }));
});

server.listen(PORT, () => console.log(`Extrator JusBrasil ouvindo na porta ${PORT}`));
