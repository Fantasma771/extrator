#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  IMPORTADOR - Dados Abertos do CNPJ (Receita Federal)
 * ============================================================================
 *
 *  Baixe os arquivos em: https://dadosabertos.rfb.gov.br/CNPJ/
 *  e coloque-os (zipados ou descompactados) em ./data
 *
 *  Arquivos usados:
 *    Estabelecimentos0.zip .. Estabelecimentos9.zip   (endereco, situacao, cnae)
 *    Empresas0.zip         .. Empresas9.zip           (razao social, natureza, porte)
 *    Socios0.zip           .. Socios9.zip             (nome completo do socio)
 *    Simples.zip                                      (MEI / Simples Nacional)
 *    Municipios.zip, Naturezas.zip, Qualificacoes.zip, Motivos.zip, Cnaes.zip
 *
 *  Exemplos:
 *    node scripts/import-receita.js --uf SP
 *    node scripts/import-receita.js --uf SP --data-dir ./data --batch 2000
 *    node scripts/import-receita.js --uf RJ --drop        (limpa a colecao antes)
 *    node scripts/import-receita.js --uf SP --limit 5000  (teste rapido)
 *    node scripts/import-receita.js --download --uf SP    (baixa os arquivos antes)
 * ============================================================================
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const { pipeline } = require('stream/promises');

const { connect, mongoose } = require('../src/db');
const Company = require('../src/models/Company');
const Municipio = require('../src/models/Municipio');
const { lerCsv, lerTabela, listarFontes } = require('../src/lib/csv');
const {
  normalizar,
  formatarCnpj,
  parseData,
  parseNumero,
  apenasDigitos,
} = require('../src/lib/normalize');
const { SITUACOES, PORTES, NATUREZAS, QUALIFICACOES, UF_CODES } = require('../src/lib/tables');

const BASE_URL = 'https://dadosabertos.rfb.gov.br/CNPJ/';

/* ------------------------------------------------------------------ */
/* Argumentos                                                          */
/* ------------------------------------------------------------------ */
function parseArgs(argv) {
  const args = { batch: 2000, limit: 0, uf: '', dataDir: process.env.RECEITA_DATA_DIR || './data' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const prox = argv[i + 1];
    switch (a) {
      case '--uf': args.uf = String(prox || '').toUpperCase(); i += 1; break;
      case '--data-dir': args.dataDir = prox; i += 1; break;
      case '--batch': args.batch = Math.max(Number(prox) || 2000, 100); i += 1; break;
      case '--limit': args.limit = Number(prox) || 0; i += 1; break;
      case '--drop': args.drop = true; break;
      case '--download': args.download = true; break;
      case '--skip-socios': args.skipSocios = true; break;
      case '--skip-simples': args.skipSimples = true; break;
      case '--help': args.help = true; break;
      default: break;
    }
  }
  return args;
}

function ajuda() {
  console.log(`
Uso: node scripts/import-receita.js [opcoes]

  --uf UF            Importa apenas um estado (ex: SP). Recomendado!
  --data-dir DIR     Pasta com os arquivos da Receita (padrao: ./data)
  --batch N          Tamanho do lote de gravacao (padrao: 2000)
  --limit N          Limita o numero de estabelecimentos (para testes)
  --drop             Apaga a colecao "companies" antes de importar
  --download         Baixa os arquivos necessarios antes de importar
  --skip-socios      Nao importa socios (mais rapido)
  --skip-simples     Nao importa dados do Simples/MEI

Fonte: ${BASE_URL}
`);
}

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */
function baixar(url, destino) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return baixar(res.headers.location, destino).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} em ${url}`));
      }
      const total = Number(res.headers['content-length'] || 0);
      let baixado = 0;
      let ultimoLog = 0;
      res.on('data', (chunk) => {
        baixado += chunk.length;
        if (total && Date.now() - ultimoLog > 5000) {
          ultimoLog = Date.now();
          process.stdout.write(`\r    ${path.basename(destino)}: ${((baixado / total) * 100).toFixed(1)}%`);
        }
      });
      const saida = fs.createWriteStream(destino);
      pipeline(res, saida)
        .then(() => {
          if (total) process.stdout.write('\r');
          resolve(destino);
        })
        .catch(reject);
      return undefined;
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function baixarNecessarios(dataDir, uf) {
  fs.mkdirSync(dataDir, { recursive: true });
  const alvos = [
    'Municipios.zip',
    'Naturezas.zip',
    'Qualificacoes.zip',
    'Motivos.zip',
    'Cnaes.zip',
  ];
  for (let i = 0; i <= 9; i += 1) {
    alvos.push(`Estabelecimentos${i}.zip`);
    alvos.push(`Empresas${i}.zip`);
    alvos.push(`Socios${i}.zip`);
  }
  alvos.push('Simples.zip');

  console.log(`[download] baixando ${alvos.length} arquivos para ${dataDir} (pode demorar bastante)...`);
  for (const nome of alvos) {
    const destino = path.join(dataDir, nome);
    if (fs.existsSync(destino)) {
      console.log(`[download] ja existe: ${nome}`);
      continue;
    }
    try {
      console.log(`[download] ${nome}`);
      await baixar(BASE_URL + nome, destino);
      console.log(`[download] ok: ${nome}`);
    } catch (e) {
      console.warn(`[download] falhou ${nome}: ${e.message}`);
    }
  }
  if (uf) console.log(`[download] concluido. Filtro de UF sera aplicado na importacao: ${uf}`);
}

/* ------------------------------------------------------------------ */
/* Helpers de transformacao                                            */
/* ------------------------------------------------------------------ */
function tipoPorNatureza(codigo) {
  const n = NATUREZAS[String(codigo || '').trim()];
  return n ? n.tipo : 'OUTROS';
}

function descNatureza(codigo, mapa) {
  const c = String(codigo || '').trim();
  return mapa.get(c) || NATUREZAS[c]?.descricao || (c ? `Natureza ${c}` : '');
}

function tipoDocumentoSocio(identificador) {
  if (identificador === '1') return 'CNPJ';
  if (identificador === '2') return 'CPF';
  if (identificador === '3') return 'ESTRANGEIRO';
  return 'OUTRO';
}

/* ------------------------------------------------------------------ */
/* Passo 1 - Estabelecimentos                                          */
/* ------------------------------------------------------------------ */
async function importarEstabelecimentos({ dataDir, uf, batch, limit, cnaes, motivos }) {
  const arquivos = listarFontes(dataDir, ['estabelecimentos', 'estabelecimento', 'est']);
  if (!arquivos.length) throw new Error(`Nenhum arquivo de Estabelecimentos encontrado em ${dataDir}`);

  console.log(`\n[1/5] Estabelecimentos (${arquivos.length} arquivo(s))${uf ? ` - filtrando UF ${uf}` : ''}`);

  let buffer = [];
  let processados = 0;
  let importados = 0;
  let ignorados = 0;

  const gravar = async (force = false) => {
    if (!buffer.length) return;
    if (!force && buffer.length < batch) return;
    const ops = buffer.map((doc) => ({
      updateOne: {
        filter: { cnpj: doc.cnpj },
        update: { $set: doc },
        upsert: true,
      },
    }));
    await Company.bulkWrite(ops, { ordered: false });
    importados += ops.length;
    buffer = [];
    process.stdout.write(`\r    lidos: ${processados} | gravados: ${importados} | ignorados: ${ignorados}   `);
  };

  for (const arquivo of arquivos) {
    await lerCsv(arquivo, async (c) => {
      processados += 1;
      if (c.length < 21) return;

      const ufLinha = (c[19] || '').trim().toUpperCase();
      if (uf && ufLinha !== uf) {
        ignorados += 1;
        return;
      }
      if (limit && importados + buffer.length >= limit) return;

      const cnpjBasico = apenasDigitos(c[0]).padStart(8, '0');
      const cnpj = `${cnpjBasico}${apenasDigitos(c[1]).padStart(4, '0')}${apenasDigitos(c[2]).padStart(2, '0')}`;

      const situacaoCodigo = apenasDigitos(c[5]).padStart(2, '0');
      const situacao = SITUACOES[situacaoCodigo] || 'NAO INFORMADA';
      const nomeFantasia = (c[4] || '').trim();
      const razaoParcial = '';

      const cnaePrincipalCodigo = apenasDigitos(c[11]);
      const cnaesSecundarios = (c[12] || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 30)
        .map((codigo) => ({ codigo, descricao: cnaes.get(codigo) || '' }));

      const doc = {
        cnpj,
        cnpjFormatado: formatarCnpj(cnpj),
        cnpjBasico,
        cnpjOrdem: c[1],
        cnpjDv: c[2],
        razaoSocial: razaoParcial,
        razaoSocialNormalizada: '',
        nomeFantasia,
        nomeFantasiaNormalizado: normalizar(nomeFantasia),
        matrizFilial: c[3] === '1' ? 'MATRIZ' : 'FILIAL',
        situacao,
        situacaoCodigo,
        motivoSituacao: motivos.get(apenasDigitos(c[7]).padStart(2, '0')) || '',
        dataSituacao: parseData(c[6]),
        dataAbertura: parseData(c[10]),
        cnaePrincipalCodigo,
        cnaePrincipal: cnaes.get(cnaePrincipalCodigo) || '',
        cnaesSecundarios,
        endereco: {
          tipoLogradouro: c[13],
          logradouro: c[14],
          numero: c[15],
          complemento: c[16],
          bairro: c[17],
          cep: apenasDigitos(c[18]),
          uf: ufLinha,
          municipio: '',
          codigoMunicipio: apenasDigitos(c[20]),
          pais: c[9] || 'BRASIL',
          nomeCidadeExterior: c[8],
        },
        contato: {
          ddd1: c[21],
          telefone1: c[22],
          ddd2: c[23],
          telefone2: c[24],
          fax: c[26],
          email: c[27],
        },
        situacaoEspecial: c[28],
        dataSituacaoEspecial: parseData(c[29]),
        tipos: [],
        socios: [],
        sociosCount: 0,
        atualizadoEm: new Date(),
      };

      buffer.push(doc);
      if (buffer.length >= batch) {
        await gravar(true);
      }
      return undefined;
    });
  }
  await gravar(true);
  process.stdout.write('\n');
  console.log(`    Estabelecimentos gravados: ${importados} (linhas lidas: ${processados}, ignoradas por UF: ${ignorados})`);
  return importados;
}

/* ------------------------------------------------------------------ */
/* Passo 2 - Empresas (razao social, natureza, capital, porte)          */
/* ------------------------------------------------------------------ */
async function importarEmpresas({ dataDir, uf, batch, naturezas }) {
  const arquivos = listarFontes(dataDir, ['empresas', 'empresa', 'emp']);
  if (!arquivos.length) {
    console.warn('[2/5] Nenhum arquivo de Empresas encontrado. Razao social ficara vazia.');
    return 0;
  }

  console.log(`\n[2/5] Empresas (${arquivos.length} arquivo(s))`);

  let processados = 0;
  let atualizados = 0;
  let buffer = [];

  const gravar = async (force = false) => {
    if (!buffer.length) return;
    if (!force && buffer.length < batch) return;

    // Descobre quais cnpj_basico existem na base (filtro de UF ja aplicado)
    const chaves = [...new Set(buffer.map((b) => b.cnpjBasico))];
    const existentes = new Set();
    for (let i = 0; i < chaves.length; i += 5000) {
      const fatia = chaves.slice(i, i + 5000);
      const achados = await Company.distinct('cnpjBasico', { cnpjBasico: { $in: fatia } });
      achados.forEach((k) => existentes.add(k));
    }

    const ops = [];
    for (const item of buffer) {
      if (!existentes.has(item.cnpjBasico)) continue;
      ops.push({
        updateMany: {
          filter: { cnpjBasico: item.cnpjBasico },
          update: {
            $set: item.$set,
            $addToSet: { tipos: { $each: item.tipos } },
          },
        },
      });
    }
    if (ops.length) {
      await Company.bulkWrite(ops, { ordered: false });
      atualizados += ops.length;
    }
    buffer = [];
    process.stdout.write(`\r    lidas: ${processados} | empresas atualizadas: ${atualizados}   `);
  };

  for (const arquivo of arquivos) {
    await lerCsv(arquivo, async (c) => {
      processados += 1;
      if (c.length < 6) return;

      const cnpjBasico = apenasDigitos(c[0]).padStart(8, '0');
      const razaoSocial = (c[1] || '').trim();
      const naturezaCodigo = String(c[2] || '').trim();
      const porteCodigo = apenasDigitos(c[5]).padStart(2, '0');

      const porte = PORTES[porteCodigo] || 'NAO INFORMADO';
      const tipoNatureza = tipoPorNatureza(naturezaCodigo);
      const tipos = new Set([tipoNatureza]);
      if (porte === 'ME' || porte === 'EPP') tipos.add(porte);

      buffer.push({
        cnpjBasico,
        tipos: [...tipos],
        $set: {
          razaoSocial,
          razaoSocialNormalizada: normalizar(razaoSocial),
          naturezaJuridicaCodigo: naturezaCodigo,
          naturezaJuridica: descNatureza(naturezaCodigo, naturezas),
          qualificacaoResponsavel: QUALIFICACOES[apenasDigitos(c[3])] || '',
          capitalSocial: parseNumero(c[4]),
          porteCodigo,
          porte,
          atualizadoEm: new Date(),
        },
      });

      if (buffer.length >= batch) await gravar(true);
      return undefined;
    });
  }
  await gravar(true);
  process.stdout.write('\n');
  console.log(`    Empresas processadas: ${processados} | atualizadas: ${atualizados}`);
  return atualizados;
}

/* ------------------------------------------------------------------ */
/* Passo 3 - Simples / MEI                                             */
/* ------------------------------------------------------------------ */
async function importarSimples({ dataDir, batch }) {
  const arquivos = listarFontes(dataDir, ['simples']);
  if (!arquivos.length) {
    console.warn('[3/5] Simples.zip nao encontrado. MEI/Simples nao serao marcados.');
    return 0;
  }

  console.log('\n[3/5] Simples Nacional / MEI');

  let processados = 0;
  let atualizados = 0;
  let buffer = [];

  const gravar = async (force = false) => {
    if (!buffer.length) return;
    if (!force && buffer.length < batch) return;

    const chaves = [...new Set(buffer.map((b) => b.cnpjBasico))];
    const existentes = new Set();
    for (let i = 0; i < chaves.length; i += 5000) {
      const fatia = chaves.slice(i, i + 5000);
      const achados = await Company.distinct('cnpjBasico', { cnpjBasico: { $in: fatia } });
      achados.forEach((k) => existentes.add(k));
    }

    const ops = [];
    for (const item of buffer) {
      if (!existentes.has(item.cnpjBasico)) continue;
      const tipos = new Set(item.tipos);
      if (item.$set['simples.opcaoMei']) tipos.add('MEI');
      if (item.$set['simples.opcaoSimples']) tipos.add('SIMPLES NACIONAL');
      ops.push({
        updateMany: {
          filter: { cnpjBasico: item.cnpjBasico },
          update: {
            $set: item.$set,
            $addToSet: { tipos: { $each: [...tipos] } },
          },
        },
      });
    }
    if (ops.length) {
      await Company.bulkWrite(ops, { ordered: false });
      atualizados += ops.length;
    }
    buffer = [];
    process.stdout.write(`\r    lidas: ${processados} | empresas atualizadas: ${atualizados}   `);
  };

  for (const arquivo of arquivos) {
    await lerCsv(arquivo, async (c) => {
      processados += 1;
      if (c.length < 5) return;

      const cnpjBasico = apenasDigitos(c[0]).padStart(8, '0');
      const opcaoSimples = String(c[1] || '').trim().toUpperCase() === 'S';
      const opcaoMei = String(c[4] || '').trim().toUpperCase() === 'S';

      buffer.push({
        cnpjBasico,
        tipos: [opcaoMei ? 'MEI' : '', opcaoSimples ? 'SIMPLES NACIONAL' : ''].filter(Boolean),
        $set: {
          'simples.opcaoSimples': opcaoSimples,
          'simples.dataOpcaoSimples': parseData(c[2]),
          'simples.dataExclusaoSimples': parseData(c[3]),
          'simples.opcaoMei': opcaoMei,
          'simples.dataOpcaoMei': parseData(c[5]),
          'simples.dataExclusaoMei': parseData(c[6]),
        },
      });

      if (buffer.length >= batch) await gravar(true);
      return undefined;
    });
  }
  await gravar(true);
  process.stdout.write('\n');
  console.log(`    Registros Simples processados: ${processados} | atualizados: ${atualizados}`);
  return atualizados;
}

/* ------------------------------------------------------------------ */
/* Passo 4 - Socios (nome completo)                                    */
/* ------------------------------------------------------------------ */
async function importarSocios({ dataDir, batch, qualificacoes }) {
  const arquivos = listarFontes(dataDir, ['socios', 'socio', 'soc']);
  if (!arquivos.length) {
    console.warn('[4/5] Nenhum arquivo de Socios encontrado.');
    return 0;
  }

  console.log(`\n[4/5] Socios (${arquivos.length} arquivo(s))`);

  let processados = 0;
  let atualizados = 0;
  let buffer = [];
  let chaveAtual = null;
  let sociosAtuais = [];

  const descQual = (codigo) => {
    const c = apenasDigitos(codigo).padStart(2, '0');
    return qualificacoes.get(c) || QUALIFICACOES[c] || QUALIFICACOES[String(Number(c))] || '';
  };

  const gravar = async (force = false) => {
    if (!buffer.length) return;
    if (!force && buffer.length < batch) return;

    const chaves = buffer.map((b) => b.cnpjBasico);
    const existentes = new Set();
    for (let i = 0; i < chaves.length; i += 5000) {
      const fatia = chaves.slice(i, i + 5000);
      const achados = await Company.distinct('cnpjBasico', { cnpjBasico: { $in: fatia } });
      achados.forEach((k) => existentes.add(k));
    }

    const ops = [];
    for (const item of buffer) {
      if (!existentes.has(item.cnpjBasico)) continue;
      ops.push({
        updateMany: {
          filter: { cnpjBasico: item.cnpjBasico },
          update: {
            $set: {
              socios: item.socios,
              sociosCount: item.socios.length,
              sociosNomes: item.socios.map((s) => s.nomeNormalizado),
            },
          },
        },
      });
    }
    if (ops.length) {
      await Company.bulkWrite(ops, { ordered: false });
      atualizados += ops.length;
    }
    buffer = [];
    process.stdout.write(`\r    lidas: ${processados} | empresas com socios: ${atualizados}   `);
  };

  const fecharGrupo = async () => {
    if (!chaveAtual || !sociosAtuais.length) return;
    buffer.push({ cnpjBasico: chaveAtual, socios: sociosAtuais });
    if (buffer.length >= batch) await gravar(true);
  };

  for (const arquivo of arquivos) {
    await lerCsv(arquivo, async (c) => {
      processados += 1;
      if (c.length < 5) return;

      const cnpjBasico = apenasDigitos(c[0]).padStart(8, '0');
      if (cnpjBasico !== chaveAtual) {
        await fecharGrupo();
        chaveAtual = cnpjBasico;
        sociosAtuais = [];
      }

      const nome = (c[2] || '').trim();
      if (!nome) return;

      sociosAtuais.push({
        nome,
        nomeNormalizado: normalizar(nome),
        documento: (c[3] || '').trim(),
        tipoDocumento: tipoDocumentoSocio(c[1]),
        qualificacaoCodigo: apenasDigitos(c[4]).padStart(2, '0'),
        qualificacao: descQual(c[4]),
        dataEntrada: parseData(c[5]),
        pais: c[6] || '',
        representanteLegal: c[7] || '',
        nomeRepresentante: c[8] || '',
        qualificacaoRepresentante: descQual(c[9]),
        faixaEtaria: c[10] || '',
      });
      return undefined;
    });
  }

  await fecharGrupo();
  await gravar(true);
  process.stdout.write('\n');
  console.log(`    Linhas de socios processadas: ${processados} | empresas atualizadas: ${atualizados}`);
  return atualizados;
}

/* ------------------------------------------------------------------ */
/* Passo 5 - Municipios                                                */
/* ------------------------------------------------------------------ */
async function importarMunicipios(dataDir) {
  const arquivos = listarFontes(dataDir, ['municipios', 'municipio', 'mun']);
  if (!arquivos.length) {
    console.warn('[5/5] Municipios.zip nao encontrado. O autocomplete usara distinct da base.');
    return 0;
  }
  console.log('\n[5/5] Municipios');

  const ops = [];
  for (const arquivo of arquivos) {
    await lerCsv(arquivo, (c) => {
      const codigo = apenasDigitos(c[0]);
      const nome = (c[1] || '').trim();
      if (!codigo || !nome) return;
      const uf = UF_CODES[codigo.slice(0, 2)] || '';
      ops.push({
        updateOne: {
          filter: { codigo },
          update: { $set: { codigo, nome, nomeNormalizado: normalizar(nome), uf } },
          upsert: true,
        },
      });
    });
  }

  for (let i = 0; i < ops.length; i += 2000) {
    await Municipio.bulkWrite(ops.slice(i, i + 2000), { ordered: false });
  }
  console.log(`    Municipios gravados: ${ops.length}`);

  // Atualiza o nome do municipio nas empresas a partir do codigo
  console.log('    Preenchendo nome do municipio nas empresas...');
  const municipios = await Municipio.find({}, { codigo: 1, nome: 1 }).lean();
  let atualizados = 0;
  for (let i = 0; i < municipios.length; i += 500) {
    const lote = municipios.slice(i, i + 500);
    const opsMun = lote.map((m) => ({
      updateMany: {
        filter: { 'endereco.codigoMunicipio': m.codigo },
        update: { $set: { 'endereco.municipio': m.nome } },
      },
    }));
    try {
      const r = await Company.bulkWrite(opsMun, { ordered: false });
      atualizados += r.modifiedCount || 0;
    } catch (e) {
      /* ignora lotes vazios */
    }
    process.stdout.write(`\r    municipios processados: ${Math.min(i + 500, municipios.length)}/${municipios.length}   `);
  }
  process.stdout.write('\n');
  console.log(`    Empresas com municipio preenchido: ${atualizados}`);

  const semMunicipio = await Company.countDocuments({
    $or: [{ 'endereco.municipio': '' }, { 'endereco.municipio': null }, { 'endereco.municipio': { $exists: false } }],
  });
  if (semMunicipio > 0) {
    console.warn(`    ATENCAO: ${semMunicipio} empresas ficaram sem o NOME do municipio (codigo nao encontrado em Municipios.zip).`);
    console.warn('    Baixe o Municipios.zip oficial e rode novamente a importacao para completar.');
  }
  return ops.length;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return ajuda();

  const dataDir = path.resolve(args.dataDir);
  console.log('============================================================');
  console.log(' IMPORTADOR - Dados Abertos do CNPJ (Receita Federal)');
  console.log('============================================================');
  console.log(` Pasta de dados : ${dataDir}`);
  console.log(` UF             : ${args.uf || 'TODAS (pode ser muito pesado!)'}`);
  console.log(` Lote           : ${args.batch}`);
  console.log(` Limite         : ${args.limit || 'sem limite'}`);
  console.log('============================================================\n');

  if (args.download) {
    await baixarNecessarios(dataDir, args.uf);
  }

  if (!fs.existsSync(dataDir)) {
    console.error(`\nPasta nao encontrada: ${dataDir}`);
    console.error('Baixe os arquivos em ' + BASE_URL + ' ou rode com --download\n');
    process.exit(1);
  }

  await connect();

  // Tabelas de referencia
  const naturezas = new Map();
  const qualificacoes = new Map();
  const motivos = new Map();
  const cnaes = new Map();

  const carregar = async (prefixos, mapa, rotulo) => {
    const arquivos = listarFontes(dataDir, prefixos);
    if (!arquivos.length) return;
    for (const a of arquivos) {
      const parcial = await lerTabela(a);
      parcial.forEach((v, k) => mapa.set(k, v));
    }
    console.log(`[ref] ${rotulo}: ${mapa.size} registros`);
  };

  await carregar(['naturezas', 'natureza', 'nat'], naturezas, 'Naturezas');
  await carregar(['qualificacoes', 'qualificacao', 'qual'], qualificacoes, 'Qualificacoes');
  await carregar(['motivos', 'motivo', 'mot'], motivos, 'Motivos');
  await carregar(['cnaes', 'cnae'], cnaes, 'CNAEs');

  if (args.drop) {
    console.log('\n[drop] apagando colecao companies...');
    await Company.deleteMany({});
  }

  const inicio = Date.now();

  await importarEstabelecimentos({ ...args, dataDir, cnaes, motivos });
  await importarEmpresas({ ...args, dataDir, naturezas });
  if (!args.skipSimples) await importarSimples({ ...args, dataDir });
  if (!args.skipSocios) await importarSocios({ ...args, dataDir, qualificacoes });
  await importarMunicipios(dataDir);

  console.log('\n[criando indices...]');
  await Company.syncIndexes();
  await Municipio.syncIndexes();

  const total = await Company.countDocuments();
  const comSocios = await Company.countDocuments({ sociosCount: { $gte: 1 } });
  const minutos = ((Date.now() - inicio) / 60000).toFixed(1);

  const resumo = await Company.aggregate([
    { $group: { _id: { uf: '$endereco.uf', m: '$endereco.municipio' }, total: { $sum: 1 } } },
    { $group: { _id: '$_id.uf', municipios: { $sum: 1 }, total: { $sum: '$total' } } },
    { $sort: { total: -1 } },
  ]);

  console.log('\n============================================================');
  console.log(` IMPORTACAO CONCLUIDA em ${minutos} min`);
  console.log(` Total de empresas na base : ${total}`);
  console.log(` Empresas com socios       : ${comSocios}`);
  console.log('------------------------------------------------------------');
  resumo.forEach((r) => console.log(` ${String(r._id || '??').padEnd(4)} ${String(r.municipios).padStart(6)} municipios  ${String(r.total).padStart(10)} empresas`));
  console.log('------------------------------------------------------------');
  console.log(' Para PROVAR que nao falta nenhuma empresa de um municipio:');
  console.log(`   npm run auditar -- --uf ${args.uf || 'SP'} --municipio "NOME DO MUNICIPIO"`);
  console.log('============================================================\n');

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((erro) => {
  console.error('\n[erro fatal]', erro);
  process.exit(1);
});
