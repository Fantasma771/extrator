#!/usr/bin/env node
'use strict';

/**
 * Popula o MongoDB com dados de demonstracao para testar o dashboard
 * antes de importar a base real da Receita Federal.
 *
 *   node scripts/seed-demo.js            -> 800 empresas
 *   node scripts/seed-demo.js --total 5000
 *   node scripts/seed-demo.js --drop     -> limpa antes
 */

require('dotenv').config();

const { connect, mongoose } = require('../src/db');
const Company = require('../src/models/Company');
const Municipio = require('../src/models/Municipio');
const { normalizar, formatarCnpj } = require('../src/lib/normalize');
const { SITUACOES, NATUREZAS } = require('../src/lib/tables');

function arg(nome, padrao) {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : padrao;
}

const ESTADOS = {
  SP: ['Sao Paulo', 'Campinas', 'Santos', 'Ribeirao Preto', 'Sorocaba', 'Sao Jose dos Campos', 'Osasco', 'Guarulhos'],
  RJ: ['Rio de Janeiro', 'Niteroi', 'Nova Iguacu', 'Campos dos Goytacazes', 'Petropolis', 'Duque de Caxias'],
  MG: ['Belo Horizonte', 'Uberlandia', 'Contagem', 'Juiz de Fora', 'Betim', 'Montes Claros'],
  PR: ['Curitiba', 'Londrina', 'Maringa', 'Ponta Grossa', 'Cascavel'],
  SC: ['Florianopolis', 'Joinville', 'Blumenau', 'Chapeco', 'Criciuma'],
  RS: ['Porto Alegre', 'Caxias do Sul', 'Canoas', 'Pelotas', 'Santa Maria'],
  BA: ['Salvador', 'Feira de Santana', 'Vitoria da Conquista', 'Camacari'],
  PE: ['Recife', 'Olinda', 'Jaboatao dos Guararapes', 'Caruaru'],
  CE: ['Fortaleza', 'Caucaia', 'Sobral', 'Juazeiro do Norte'],
  DF: ['Brasilia', 'Ceilandia', 'Taguatinga'],
  GO: ['Goiania', 'Aparecida de Goiania', 'Anapolis'],
  PA: ['Belem', 'Ananindeua', 'Santarem'],
  AM: ['Manaus', 'Parintins'],
  ES: ['Vitoria', 'Vila Velha', 'Serra', 'Cariacica'],
  MT: ['Cuiaba', 'Varzea Grande', 'Rondonopolis'],
  MS: ['Campo Grande', 'Dourados', 'Tres Lagoas'],
};

const RAMOS = [
  { nome: 'Comercio de Alimentos', cnae: '4721000', desc: 'Comercio varejista de mercadorias em geral - minimercados, mercearias' },
  { nome: 'Construcao Civil', cnae: '4120400', desc: 'Construcao de edificios' },
  { nome: 'Tecnologia da Informacao', cnae: '6201501', desc: 'Desenvolvimento de programas de computador sob encomenda' },
  { nome: 'Consultoria Empresarial', cnae: '7020400', desc: 'Atividades de consultoria em gestao empresarial' },
  { nome: 'Transporte de Cargas', cnae: '4930202', desc: 'Transporte rodoviario de carga intermunicipal' },
  { nome: 'Restaurantes', cnae: '5611201', desc: 'Restaurantes e similares' },
  { nome: 'Clinicas Medicas', cnae: '8630503', desc: 'Atividades de fisioterapia e medicina' },
  { nome: 'Educacao', cnae: '8599604', desc: 'Treinamento em desenvolvimento profissional' },
  { nome: 'Beleza e Estetica', cnae: '9602501', desc: 'Atividades de saloes de cabeleireiro e estetica' },
  { nome: 'Industria Metalurgica', cnae: '2539001', desc: 'Servicos de usinagem, solda e metalurgia' },
  { nome: 'Imobiliaria', cnae: '6820400', desc: 'Corretagem na compra e venda de imoveis' },
  { nome: 'Agropecuaria', cnae: '0159801', desc: 'Criacao de bovinos para corte' },
  { nome: 'Marketing Digital', cnae: '7319002', desc: 'Promocao de vendas e marketing digital' },
  { nome: 'Advocacia', cnae: '6910200', desc: 'Atividades de advocacia' },
  { nome: 'Contabilidade', cnae: '6920601', desc: 'Atividades de contabilidade' },
  { nome: 'Farmacia', cnae: '4771701', desc: 'Comercio varejista de produtos farmaceuticos' },
  { nome: 'Auto Pecas', cnae: '4530703', desc: 'Comercio a varejo de pecas e acessorios para veiculos' },
  { nome: 'Energia Solar', cnae: '4321500', desc: 'Instalacao e manutencao eletrica - energia solar' },
];

const NOMES = [
  'Ana', 'Bruno', 'Carla', 'Daniel', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'Joao',
  'Karina', 'Lucas', 'Mariana', 'Nathan', 'Olivia', 'Paulo', 'Rafaela', 'Sergio', 'Tatiana', 'Vinicius',
  'Amanda', 'Beatriz', 'Caio', 'Debora', 'Eduardo', 'Fernanda', 'Gustavo', 'Helena', 'Igor', 'Julia',
  'Leandro', 'Marcelo', 'Natalia', 'Otavio', 'Patricia', 'Renato', 'Sofia', 'Thiago', 'Vanessa', 'William',
];
const SOBRENOMES = [
  'Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira', 'Lima', 'Gomes',
  'Costa', 'Ribeiro', 'Martins', 'Carvalho', 'Almeida', 'Lopes', 'Soares', 'Fernandes', 'Vieira', 'Barbosa',
  'Rocha', 'Dias', 'Nascimento', 'Andrade', 'Moreira', 'Nunes', 'Marques', 'Machado', 'Mendes', 'Freitas',
];
const QUALIFICACOES_DEMO = ['Socio-Administrador', 'Socio', 'Administrador', 'Diretor', 'Presidente', 'Socio com participacao majoritaria'];
const TIPOS_EMPRESA = [
  { tipos: ['LTDA'], nat: '206-2', peso: 40 },
  { tipos: ['MEI', 'EI'], nat: '213-5', peso: 25, mei: true },
  { tipos: ['ME', 'LTDA'], nat: '206-2', peso: 15, porte: 'ME' },
  { tipos: ['EPP', 'LTDA'], nat: '206-2', peso: 8, porte: 'EPP' },
  { tipos: ['SA'], nat: '205-4', peso: 5 },
  { tipos: ['SLU'], nat: '232-1', peso: 4 },
  { tipos: ['COOPERATIVA'], nat: '214-3', peso: 2 },
  { tipos: ['SEM FINS LUCRATIVOS'], nat: '399-9', peso: 1 },
];

function sorteia(lista) {
  return lista[Math.floor(Math.random() * lista.length)];
}
function sorteiaPonderado(lista) {
  const total = lista.reduce((s, i) => s + i.peso, 0);
  let r = Math.random() * total;
  for (const item of lista) {
    r -= item.peso;
    if (r <= 0) return item;
  }
  return lista[0];
}
function cpf() {
  return String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
}
function cnpjAleatorio() {
  return String(Math.floor(Math.random() * 1e14)).padStart(14, '0');
}
function dataAleatoria(anoMin = 1995, anoMax = 2025) {
  const ano = anoMin + Math.floor(Math.random() * (anoMax - anoMin + 1));
  const mes = 1 + Math.floor(Math.random() * 12);
  const dia = 1 + Math.floor(Math.random() * 28);
  return new Date(Date.UTC(ano, mes - 1, dia));
}

const SUFIXOS = ['LTDA', 'LTDA ME', 'ME', 'EIRELI', 'S/A', '& CIA LTDA', 'COMERCIO LTDA'];

function gerarEmpresa() {
  const uf = sorteia(Object.keys(ESTADOS));
  const municipio = sorteia(ESTADOS[uf]);
  const ramo = sorteia(RAMOS);
  const padrao = sorteiaPonderado(TIPOS_EMPRESA);

  const nomeBase = `${sorteia(SOBRENOMES)} ${sorteia(['Comercio', 'Servicos', 'Industria', 'Solucoes', 'Grupo', 'Distribuidora', 'Empreendimentos'])} ${sorteia(['Nacional', 'Brasil', 'Prime', 'Master', 'Real', 'Central', 'Norte', 'Sul', 'Global', 'Premium'])}`;
  const razaoSocial = padrao.tipos.includes('MEI')
    ? `${sorteia(NOMES)} ${sorteia(SOBRENOMES)} ${cnpjAleatorio().slice(0, 6)}`
    : `${nomeBase} ${sorteia(SUFIXOS)}`;
  const nomeFantasia = padrao.tipos.includes('SA') || padrao.tipos.includes('LTDA')
    ? `${sorteia(['Grupo', 'Rede', 'Center', 'Point', 'Express', 'Top', 'Mais'])} ${ramo.nome.split(' ')[0]}`
    : razaoSocial.split(' ')[0] + ' ' + ramo.nome.split(' ')[0];

  const porte = padrao.mei ? 'MEI' : padrao.porte || (padrao.tipos.includes('SA') ? 'DEMAIS' : 'ME');
  const natureza = NATUREZAS[padrao.nat];
  const situacao = Math.random() < 0.68 ? 'ATIVA' : Math.random() < 0.6 ? 'BAIXADA' : sorteia(['SUSPENSA', 'INAPTA', 'NULA']);
  const cnpj = cnpjAleatorio();
  const cnpjBasico = cnpj.slice(0, 8);
  const dataAbertura = dataAleatoria();
  const qtdSocios = padrao.tipos.includes('MEI') ? (Math.random() < 0.5 ? 0 : 1) : 1 + Math.floor(Math.random() * 3);

  const socios = [];
  for (let i = 0; i < qtdSocios; i += 1) {
    const nome = `${sorteia(NOMES)} ${sorteia(SOBRENOMES)} ${sorteia(SOBRENOMES)}`;
    socios.push({
      nome,
      nomeNormalizado: normalizar(nome),
      documento: cpf(),
      tipoDocumento: 'CPF',
      qualificacaoCodigo: '49',
      qualificacao: i === 0 ? 'Socio-Administrador' : sorteia(QUALIFICACOES_DEMO),
      dataEntrada: dataAbertura,
      faixaEtaria: String(3 + Math.floor(Math.random() * 6)),
    });
  }

  const tipos = [...new Set([...padrao.tipos, ...(porte === 'ME' || porte === 'EPP' ? [porte] : []), ...(padrao.mei ? [] : [])])];
  if (!padrao.mei && Math.random() < 0.55) tipos.push('SIMPLES NACIONAL');

  const rua = `Rua ${sorteia(SOBRENOMES)} ${sorteia(['das Flores', 'dos Ipês', 'Sete de Setembro', 'XV de Novembro', 'Getulio Vargas', 'Brasil'])}, ${100 + Math.floor(Math.random() * 2000)}`;

  return {
    cnpj,
    cnpjFormatado: formatarCnpj(cnpj),
    cnpjBasico,
    cnpjOrdem: cnpj.slice(8, 12),
    cnpjDv: cnpj.slice(12),
    razaoSocial,
    razaoSocialNormalizada: normalizar(razaoSocial),
    nomeFantasia,
    nomeFantasiaNormalizado: normalizar(nomeFantasia),
    matrizFilial: Math.random() < 0.8 ? 'MATRIZ' : 'FILIAL',
    situacao,
    situacaoCodigo: Object.keys(SITUACOES).find((k) => SITUACOES[k] === situacao),
    motivoSituacao: situacao === 'BAIXADA' ? 'Extincao por encerramento de liquidacao voluntaria' : '',
    dataSituacao: situacao === 'ATIVA' ? dataAbertura : dataAleatoria(2015, 2025),
    dataAbertura,
    cnaePrincipalCodigo: ramo.cnae,
    cnaePrincipal: ramo.desc,
    cnaesSecundarios: [],
    naturezaJuridicaCodigo: padrao.nat,
    naturezaJuridica: natureza?.descricao || '',
    qualificacaoResponsavel: 'Socio-Administrador',
    capitalSocial: padrao.tipos.includes('MEI') ? 1 : Math.floor(Math.random() * 5000000) / 100,
    porteCodigo: porte === 'ME' ? '01' : porte === 'EPP' ? '03' : porte === 'MEI' ? '07' : '05',
    porte,
    tipos: [...new Set(tipos)],
    simples: {
      opcaoSimples: !padrao.tipos.includes('SA'),
      dataOpcaoSimples: dataAbertura,
      opcaoMei: !!padrao.mei,
      dataOpcaoMei: padrao.mei ? dataAbertura : null,
    },
    endereco: {
      tipoLogradouro: 'RUA',
      logradouro: rua,
      numero: String(100 + Math.floor(Math.random() * 2000)),
      complemento: Math.random() < 0.4 ? `Sala ${1 + Math.floor(Math.random() * 20)}` : '',
      bairro: sorteia(['Centro', 'Jardim America', 'Vila Nova', 'Boa Vista', 'Sao Jose', 'Industrial', 'Alphaville']),
      cep: String(10000000 + Math.floor(Math.random() * 89999999)),
      uf,
      municipio,
      codigoMunicipio: String(1000000 + Math.floor(Math.random() * 999999)),
      pais: 'BRASIL',
      nomeCidadeExterior: '',
    },
    contato: {
      ddd1: String(11 + Math.floor(Math.random() * 78)),
      telefone1: String(30000000 + Math.floor(Math.random() * 69999999)),
      email: `${normalizar(nomeFantasia).replace(/\s+/g, '.').slice(0, 25)}@exemplo.com.br`,
    },
    socios,
    sociosCount: socios.length,
    sociosNomes: socios.map((s) => s.nomeNormalizado),
    origem: 'demo',
    atualizadoEm: new Date(),
  };
}

async function main() {
  const total = Number(arg('--total', 800));
  const drop = process.argv.includes('--drop');

  await connect();
  if (drop) {
    console.log('[seed] apagando colecoes...');
    await Company.deleteMany({});
    await Municipio.deleteMany({});
  }

  console.log(`[seed] gerando ${total} empresas de demonstracao...`);

  const lote = [];
  for (let i = 0; i < total; i += 1) {
    lote.push(gerarEmpresa());
    if (lote.length >= 500) {
      await Company.insertMany(lote, { ordered: false });
      process.stdout.write(`\r    inseridas: ${i + 1}`);
      lote.length = 0;
    }
  }
  if (lote.length) await Company.insertMany(lote, { ordered: false });

  // Municipios para o autocomplete
  const municipios = [];
  for (const [uf, cidades] of Object.entries(ESTADOS)) {
    for (const cidade of cidades) {
      municipios.push({
        codigo: String(Math.floor(Math.random() * 9000000) + 1000000),
        nome: cidade,
        nomeNormalizado: normalizar(cidade),
        uf,
      });
    }
  }
  await Municipio.insertMany(municipios, { ordered: false });

  await Company.syncIndexes();
  await Municipio.syncIndexes();

  console.log(`\n[seed] concluido. Empresas na base: ${await Company.countDocuments()}`);
  console.log('[seed] abra o dashboard e clique em BUSCAR.\n');
  await mongoose.connection.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
