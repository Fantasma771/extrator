'use strict';

/**
 * Resolve as fontes de dados da Receita Federal.
 *
 * Por padrao usa o ESPELHO com CDN Cloudflare:
 *   https://dados-abertos-rf-cnpj.casadosdados.com.br/arquivos/<AAAA-MM-DD>/
 * que e MUITO mais rapido que o servidor oficial (dadosabertos.rfb.gov.br).
 * A pasta do mes mais recente e descoberta automaticamente.
 *
 * Ordem de resolucao:
 *   1. arquivos locais (pasta ./data), se existirem
 *   2. RECEITA_BASE_URL (variavel de ambiente) — sobrepoe tudo
 *   3. espelho CDN + pasta do mes mais recente (automatico)
 *   4. (fallback) servidor oficial da Receita
 */

const path = require('path');
const { lerCsv, listarFontes } = require('./csv');
const { lerCsvRemoto, baixarTexto } = require('./remoto');

const BASE_MIRROR = 'https://dados-abertos-rf-cnpj.casadosdados.com.br/arquivos/';
const BASE_OFICIAL = 'https://dadosabertos.rfb.gov.br/CNPJ/';

const PREFIXOS = {
  estabelecimentos: ['estabelecimentos', 'estabelecimento', 'est'],
  empresas: ['empresas', 'empresa', 'emp'],
  socios: ['socios', 'socio', 'soc'],
  simples: ['simples'],
  municipios: ['municipios', 'municipio', 'mun'],
  naturezas: ['naturezas', 'natureza', 'nat'],
  qualificacoes: ['qualificacoes', 'qualificacao', 'qual'],
  motivos: ['motivos', 'motivo', 'mot'],
  cnaes: ['cnaes', 'cnae'],
};

const NOMES_REMOTOS = {
  estabelecimentos: Array.from({ length: 10 }, (_, i) => `Estabelecimentos${i}.zip`),
  empresas: Array.from({ length: 10 }, (_, i) => `Empresas${i}.zip`),
  socios: Array.from({ length: 10 }, (_, i) => `Socios${i}.zip`),
  simples: ['Simples.zip'],
  municipios: ['Municipios.zip'],
  naturezas: ['Naturezas.zip'],
  qualificacoes: ['Qualificacoes.zip'],
  motivos: ['Motivos.zip'],
  cnaes: ['Cnaes.zip'],
};

/* ------------------------------------------------------------------ */
/* Descoberta automatica da pasta mais recente no espelho              */
/* ------------------------------------------------------------------ */
const CACHE_MS = 6 * 60 * 60 * 1000; // 6 horas
let cache = { url: null, expira: 0, pasta: null };
let baseAtual = null; // usada por baseUrl() (sincrona)

function normalizarBase(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  return u.endsWith('/') ? u : `${u}/`;
}

/** Extrai as pastas AAAA-MM-DD do indice HTML de uma pasta */
function extrairPastas(html) {
  const datas = [];
  const re = /href="\.?\/?(\d{4}-\d{2}-\d{2})\/?"/g;
  let m;
  while ((m = re.exec(html)) !== null) datas.push(m[1]);
  const unicas = [...new Set(datas)].sort();
  return unicas;
}

/** Monta uma lista de pastas candidatas (mes atual e anteriores) como fallback */
function pastasCandidatas(qtd = 4) {
  const agora = new Date();
  const lista = [];
  for (let i = 0; i < qtd; i += 1) {
    const d = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - i, 1));
    lista.push(`${d.toISOString().slice(0, 7)}-01`);
  }
  return lista;
}

/**
 * Descobre a URL base (com a pasta do mes mais recente) do espelho.
 * @param {{forcar?:boolean, log?:Function}} opcoes
 * @returns {Promise<string>}
 */
async function resolverBase(opcoes = {}) {
  // 1) Variavel de ambiente sobrepoe tudo (permite voltar ao oficial se quiser)
  const env = normalizarBase(process.env.RECEITA_BASE_URL);
  if (env) {
    baseAtual = env;
    return env;
  }

  const agora = Date.now();
  if (!opcoes.forcar && cache.url && cache.expira > agora) {
    baseAtual = cache.url;
    return cache.url;
  }

  const log = opcoes.log || (() => {});

  // 2) Espelho CDN: descobre a pasta mais recente pelo indice
  try {
    const html = await baixarTexto(BASE_MIRROR, { tentativas: 3, timeout: 30000 });
    const pastas = extrairPastas(html);
    if (pastas.length) {
      const pasta = pastas[pastas.length - 1];
      const url = `${BASE_MIRROR}${pasta}/`;
      cache = { url, expira: agora + CACHE_MS, pasta };
      baseAtual = url;
      log(`Espelho CDN: pasta mais recente detectada -> ${pasta}`);
      return url;
    }
    log('[aviso] indice do espelho nao trouxe pastas; tentando fallback');
  } catch (e) {
    log(`[aviso] nao consegui ler o indice do espelho (${e.message}); tentando fallback`);
  }

  // 3) Fallback: tenta as pastas candidatas (mes atual e anteriores)
  for (const pasta of pastasCandidatas()) {
    const url = `${BASE_MIRROR}${pasta}/`;
    try {
      const ok = await baixarTexto(`${url}Municipios.zip`, { tentativas: 1, timeout: 15000, maxBytes: 2048 });
      if (ok && ok.length) {
        cache = { url, expira: agora + CACHE_MS, pasta };
        baseAtual = url;
        log(`Espelho CDN (fallback): usando pasta ${pasta}`);
        return url;
      }
    } catch (_) { /* tenta a proxima */ }
  }

  // 4) Ultimo recurso: servidor oficial da Receita
  baseAtual = BASE_OFICIAL;
  log(`[aviso] usando o servidor OFICIAL da Receita (${BASE_OFICIAL}) — pode ser lento.`);
  return BASE_OFICIAL;
}

/** URL base em cache (sincrona) — usada apenas para exibicao/diagnostico */
function baseUrl() {
  return baseAtual || normalizarBase(process.env.RECEITA_BASE_URL) || BASE_MIRROR;
}

/**
 * Lista os arquivos existentes numa pasta do espelho (para diagnostico).
 * @returns {Promise<string[]>}
 */
async function listarArquivosRemotos(base) {
  const html = await baixarTexto(base || (await resolverBase()));
  const nomes = [];
  const re = /href="\.?\/?([^"/?]+\.zip)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) nomes.push(m[1]);
  return [...new Set(nomes)];
}

/**
 * @param {string} chave  estabelecimentos | empresas | socios | simples | municipios | ...
 * @param {{dataDir?:string, remoto?:boolean, base?:string}} opcoes
 * @returns {Promise<Array<{nome:string, local:string|null, url:string|null}>>}
 */
async function resolverFontes(chave, opcoes = {}) {
  const { dataDir, remoto = true } = opcoes;

  if (dataDir) {
    const locais = listarFontes(path.resolve(dataDir), PREFIXOS[chave] || [chave]);
    if (locais.length) {
      return locais.map((p) => ({ nome: path.basename(p), local: p, url: null }));
    }
  }

  if (!remoto) return [];

  const base = opcoes.base || (await resolverBase(opcoes));
  return (NOMES_REMOTOS[chave] || []).map((nome) => ({ nome, local: null, url: base + nome }));
}

/**
 * Le uma fonte (local ou remota) chamando onLinha para cada linha.
 */
async function lerFonte(fonte, onLinha, opcoes = {}) {
  if (fonte.local) return lerCsv(fonte.local, onLinha);
  return lerCsvRemoto(fonte.url, onLinha, opcoes);
}

module.exports = {
  resolverFontes,
  lerFonte,
  resolverBase,
  baseUrl,
  listarArquivosRemotos,
  baseUrlSincrona: baseUrl,
  NOMES_REMOTOS,
  PREFIXOS,
  BASE_MIRROR,
  BASE_OFICIAL,
};
