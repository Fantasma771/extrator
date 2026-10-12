'use strict';

/**
 * Serializadores de exportacao.
 *
 * layout = "empresa"  -> 1 linha por CNPJ (todos os socios na mesma linha)
 * layout = "socio"    -> 1 linha por socio (uma empresa com 3 socios gera 3 linhas)
 *
 * Formatos: csv | json | ndjson | csv.gz | json.gz | ndjson.gz
 */

const { formatarCnpj } = require('./normalize');

const SEP = ';';

function escapar(valor) {
  if (valor === null || valor === undefined) return '""';
  const s = String(valor).replace(/\r?\n/g, ' ').replace(/"/g, '""');
  return `"${s}"`;
}

function data(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function numero(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace('.', ',');
}

const COLUNAS_EMPRESA = [
  'cnpj',
  'razao_social',
  'nome_fantasia',
  'situacao_cadastral',
  'data_situacao',
  'motivo_situacao',
  'matriz_filial',
  'tipo_principal',
  'tipos',
  'porte',
  'natureza_juridica',
  'qualificacao_responsavel',
  'data_abertura',
  'capital_social',
  'cnae_principal_codigo',
  'cnae_principal',
  'cnaes_secundarios',
  'tipo_logradouro',
  'logradouro',
  'numero',
  'complemento',
  'bairro',
  'cep',
  'municipio',
  'codigo_municipio',
  'uf',
  'pais',
  'ddd1',
  'telefone1',
  'email',
  'simples_nacional',
  'mei',
  'data_opcao_simples',
  'data_opcao_mei',
  'qtd_socios',
  'socios',
  'documentos_socios',
  'qualificacoes_socios',
];

const COLUNAS_SOCIO = [
  'cnpj',
  'razao_social',
  'nome_fantasia',
  'situacao_cadastral',
  'municipio',
  'uf',
  'data_abertura',
  'capital_social',
  'tipo_principal',
  'porte',
  'nome_socio',
  'tipo_documento_socio',
  'documento_socio',
  'qualificacao_socio',
  'data_entrada_sociedade',
  'faixa_etaria',
  'representante_legal',
  'nome_representante',
  'qualificacao_representante',
];

function cabecalho(layout) {
  return (layout === 'socio' ? COLUNAS_SOCIO : COLUNAS_EMPRESA).join(SEP) + '\n';
}

function linhaEmpresa(d) {
  const e = d.endereco || {};
  const c = d.contato || {};
  const s = d.socios || [];
  return [
    escapar(d.cnpjFormatado || formatarCnpj(d.cnpj)),
    escapar(d.razaoSocial),
    escapar(d.nomeFantasia),
    escapar(d.situacao),
    escapar(data(d.dataSituacao)),
    escapar(d.motivoSituacao),
    escapar(d.matrizFilial),
    escapar((d.tipos || [])[0]),
    escapar((d.tipos || []).join(' | ')),
    escapar(d.porte),
    escapar(d.naturezaJuridica),
    escapar(d.qualificacaoResponsavel),
    escapar(data(d.dataAbertura)),
    escapar(numero(d.capitalSocial)),
    escapar(d.cnaePrincipalCodigo),
    escapar(d.cnaePrincipal),
    escapar((d.cnaesSecundarios || []).map((x) => x.codigo).join(' | ')),
    escapar(e.tipoLogradouro),
    escapar(e.logradouro),
    escapar(e.numero),
    escapar(e.complemento),
    escapar(e.bairro),
    escapar(e.cep),
    escapar(e.municipio),
    escapar(e.codigoMunicipio),
    escapar(e.uf),
    escapar(e.pais),
    escapar(c.ddd1),
    escapar(c.telefone1),
    escapar(c.email),
    escapar(d.simples?.opcaoSimples ? 'SIM' : 'NAO'),
    escapar(d.simples?.opcaoMei ? 'SIM' : 'NAO'),
    escapar(data(d.simples?.dataOpcaoSimples)),
    escapar(data(d.simples?.dataOpcaoMei)),
    escapar(s.length),
    escapar(s.map((x) => x.nome).join(' | ')),
    escapar(s.map((x) => x.documento).join(' | ')),
    escapar(s.map((x) => x.qualificacao).join(' | ')),
  ].join(SEP) + '\n';
}

function linhaSocio(d, socio) {
  return [
    escapar(d.cnpjFormatado || formatarCnpj(d.cnpj)),
    escapar(d.razaoSocial),
    escapar(d.nomeFantasia),
    escapar(d.situacao),
    escapar(d.endereco?.municipio),
    escapar(d.endereco?.uf),
    escapar(data(d.dataAbertura)),
    escapar(numero(d.capitalSocial)),
    escapar((d.tipos || [])[0]),
    escapar(d.porte),
    escapar(socio.nome),
    escapar(socio.tipoDocumento),
    escapar(socio.documento),
    escapar(socio.qualificacao),
    escapar(data(socio.dataEntrada)),
    escapar(socio.faixaEtaria),
    escapar(socio.representanteLegal),
    escapar(socio.nomeRepresentante),
    escapar(socio.qualificacaoRepresentante),
  ].join(SEP) + '\n';
}

/** Linhas de uma empresa conforme o layout escolhido */
function linhasDe(doc, layout) {
  if (layout === 'socio') {
    const socios = doc.socios || [];
    if (!socios.length) return [linhaSocio(doc, {})];
    return socios.map((s) => linhaSocio(doc, s));
  }
  return [linhaEmpresa(doc)];
}

/** Conta quantas linhas um documento vai gerar (para o progresso) */
function contarLinhas(doc, layout) {
  if (layout === 'socio') return Math.max((doc.socios || []).length, 1);
  return 1;
}

module.exports = {
  cabecalho,
  linhasDe,
  contarLinhas,
  linhaEmpresa,
  linhaSocio,
  COLUNAS_EMPRESA,
  COLUNAS_SOCIO,
  escapar,
};
