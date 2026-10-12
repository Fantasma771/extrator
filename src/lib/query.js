'use strict';

const { normalizar, escapeRegex, apenasDigitos } = require('./normalize');

const SITUACOES_VALIDAS = ['ATIVA', 'BAIXADA', 'SUSPENSA', 'INAPTA', 'NULA'];

function paraArray(valor) {
  if (valor === undefined || valor === null || valor === '') return [];
  if (Array.isArray(valor)) return valor.map((v) => String(v).trim()).filter(Boolean);
  return String(valor)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function inteiro(valor, padrao) {
  const n = parseInt(valor, 10);
  return Number.isFinite(n) ? n : padrao;
}

function numero(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(String(valor).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Converte os query params da URL em um filtro do MongoDB.
 */
function construirFiltro(q = {}) {
  const filtro = {};

  const uf = String(q.uf || '').trim().toUpperCase();
  if (uf && uf !== 'TODOS' && uf !== 'ALL') filtro['endereco.uf'] = uf;

  const municipio = String(q.municipio || '').trim();
  if (municipio && municipio !== 'TODOS') {
    if (/^\d{6,7}$/.test(municipio)) {
      filtro['endereco.codigoMunicipio'] = municipio;
    } else {
      filtro['endereco.municipio'] = new RegExp(`^${escapeRegex(municipio)}$`, 'i');
    }
  }

  const municipioContem = String(q.municipioContem || '').trim();
  if (municipioContem) {
    filtro['endereco.municipio'] = new RegExp(escapeRegex(municipioContem), 'i');
  }

  const situacoes = paraArray(q.situacao).map((s) => s.toUpperCase()).filter((s) => SITUACOES_VALIDAS.includes(s));
  if (situacoes.length) filtro.situacao = { $in: situacoes };

  const tipos = paraArray(q.tipo).map((t) => t.toUpperCase());
  if (tipos.length) filtro.tipos = { $in: tipos };

  const porte = paraArray(q.porte).map((p) => p.toUpperCase());
  if (porte.length) filtro.porte = { $in: porte };

  if (q.matrizFilial) filtro.matrizFilial = String(q.matrizFilial).toUpperCase();

  const cnae = apenasDigitos(q.cnae);
  if (cnae) filtro.cnaePrincipalCodigo = new RegExp(`^${escapeRegex(cnae)}`);

  const natureza = String(q.natureza || '').trim();
  if (natureza) filtro.naturezaJuridica = new RegExp(escapeRegex(natureza), 'i');

  const dataDe = q.aberturaDe ? new Date(q.aberturaDe) : null;
  const dataAte = q.aberturaAte ? new Date(q.aberturaAte) : null;
  if (dataDe || dataAte) {
    filtro.dataAbertura = {};
    if (dataDe && !Number.isNaN(dataDe.getTime())) filtro.dataAbertura.$gte = dataDe;
    if (dataAte && !Number.isNaN(dataAte.getTime())) filtro.dataAbertura.$lte = dataAte;
    if (!Object.keys(filtro.dataAbertura).length) delete filtro.dataAbertura;
  }

  const capMin = numero(q.capitalMin);
  const capMax = numero(q.capitalMax);
  if (capMin !== null || capMax !== null) {
    filtro.capitalSocial = {};
    if (capMin !== null) filtro.capitalSocial.$gte = capMin;
    if (capMax !== null) filtro.capitalSocial.$lte = capMax;
  }

  if (String(q.somenteComSocios || '') === 'true') filtro.sociosCount = { $gte: 1 };
  if (String(q.somenteMei || '') === 'true') filtro.tipos = { ...(filtro.tipos || {}), $in: ['MEI'] };
  if (String(q.somenteSimples || '') === 'true') filtro['simples.opcaoSimples'] = true;

  const busca = String(q.q || q.busca || '').trim();
  if (busca) {
    const termo = normalizar(busca);
    const somenteDigitos = apenasDigitos(busca);
    const or = [];
    if (termo) {
      const rx = new RegExp(escapeRegex(termo), 'i');
      or.push({ razaoSocialNormalizada: rx });
      or.push({ nomeFantasiaNormalizado: rx });
      or.push({ sociosNomes: rx });
      or.push({ cnaePrincipal: rx });
    }
    if (somenteDigitos.length >= 3) {
      or.push({ cnpj: new RegExp(`^${escapeRegex(somenteDigitos)}`) });
      or.push({ cnpjBasico: new RegExp(`^${escapeRegex(somenteDigitos)}`) });
    }
    if (or.length) filtro.$or = or;
  }

  return filtro;
}

const ORDENACOES = {
  relevancia: { razaoSocialNormalizada: 1 },
  razaoSocial: { razaoSocialNormalizada: 1 },
  aberturaRecente: { dataAbertura: -1 },
  aberturaAntiga: { dataAbertura: 1 },
  capitalMaior: { capitalSocial: -1 },
  capitalMenor: { capitalSocial: 1 },
  socios: { sociosCount: -1 },
  municipio: { 'endereco.municipio': 1, razaoSocialNormalizada: 1 },
};

function construirOrdenacao(valor) {
  return ORDENACOES[String(valor || 'relevancia')] || ORDENACOES.relevancia;
}

/** Selecao de campos para a listagem (leve, sem socios completos) */
const PROJECAO_LISTA = {
  cnpj: 1,
  cnpjFormatado: 1,
  razaoSocial: 1,
  nomeFantasia: 1,
  matrizFilial: 1,
  situacao: 1,
  dataSituacao: 1,
  motivoSituacao: 1,
  dataAbertura: 1,
  capitalSocial: 1,
  porte: 1,
  tipos: 1,
  naturezaJuridica: 1,
  cnaePrincipalCodigo: 1,
  cnaePrincipal: 1,
  'endereco.uf': 1,
  'endereco.municipio': 1,
  'endereco.bairro': 1,
  'endereco.codigoMunicipio': 1,
  'contato.email': 1,
  'contato.telefone1': 1,
  'contato.ddd1': 1,
  sociosCount: 1,
  socios: { $slice: 3 },
  'simples.opcaoMei': 1,
  'simples.opcaoSimples': 1,
};

module.exports = {
  construirFiltro,
  construirOrdenacao,
  PROJECAO_LISTA,
  ORDENACOES,
  SITUACOES_VALIDAS,
  paraArray,
  inteiro,
};
