'use strict';

/**
 * Resolve as fontes de dados da Receita Federal.
 * Prefere arquivos locais (pasta ./data); se nao houver, usa a origem remota
 * em streaming — que e o modo usado quando a importacao roda no Render.
 */

const path = require('path');
const { lerCsv, listarFontes } = require('./csv');
const { lerCsvRemoto } = require('./remoto');

const BASE_PADRAO = 'https://dadosabertos.rfb.gov.br/CNPJ/';

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

function baseUrl() {
  const b = process.env.RECEITA_BASE_URL || BASE_PADRAO;
  return b.endsWith('/') ? b : `${b}/`;
}

/**
 * @param {string} chave  estabelecimentos | empresas | socios | simples | municipios | ...
 * @param {{dataDir?:string, remoto?:boolean}} opcoes
 * @returns {Array<{nome:string, local:string|null, url:string|null}>}
 */
function resolverFontes(chave, opcoes = {}) {
  const { dataDir, remoto = true } = opcoes;

  if (dataDir) {
    const locais = listarFontes(path.resolve(dataDir), PREFIXOS[chave] || [chave]);
    if (locais.length) {
      return locais.map((p) => ({ nome: path.basename(p), local: p, url: null }));
    }
  }

  if (!remoto) return [];

  const base = baseUrl();
  return (NOMES_REMOTOS[chave] || []).map((nome) => ({ nome, local: null, url: base + nome }));
}

/**
 * Le uma fonte (local ou remota) chamando onLinha para cada linha.
 */
async function lerFonte(fonte, onLinha, opcoes = {}) {
  if (fonte.local) return lerCsv(fonte.local, onLinha);
  return lerCsvRemoto(fonte.url, onLinha, opcoes);
}

module.exports = { resolverFontes, lerFonte, baseUrl, NOMES_REMOTOS, PREFIXOS };
