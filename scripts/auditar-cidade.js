#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  AUDITOR DE COMPLETUDE
 * ============================================================================
 *  Prova, comparando com os arquivos ORIGINAIS da Receita Federal, que
 *  NENHUMA empresa de um municipio ficou de fora da importacao.
 *
 *  Uso:
 *    node scripts/auditar-cidade.js --uf SP --municipio Santos
 *    node scripts/auditar-cidade.js --uf SP --codigo 3548500
 *    node scripts/auditar-cidade.js --uf SP --municipio Santos --listar-faltantes
 *
 *  Opcoes:
 *    --uf UF               Estado a auditar (obrigatorio)
 *    --municipio NOME      Nome do municipio
 *    --codigo CODIGO       Codigo do municipio (alternativa ao nome)
 *    --data-dir DIR        Pasta com os arquivos da Receita (padrao: ./data)
 *    --listar-faltantes    Imprime os CNPJs que estao na fonte e nao no banco
 *    --max-faltantes N     Limite de CNPJs listados (padrao: 200)
 *    --json                Saida em JSON
 * ============================================================================
 */

require('dotenv').config();

const path = require('path');
const { connect, mongoose } = require('../src/db');
const Company = require('../src/models/Company');
const Municipio = require('../src/models/Municipio');
const { lerCsv, listarFontes } = require('../src/lib/csv');
const { normalizar, formatarCnpj, apenasDigitos, emLotes } = require('../src/lib/normalize');
const { SITUACOES } = require('../src/lib/tables');

function parseArgs(argv) {
  const args = { dataDir: process.env.RECEITA_DATA_DIR || './data', maxFaltantes: 200 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--uf': args.uf = String(argv[i + 1] || '').toUpperCase(); i += 1; break;
      case '--municipio': args.municipio = argv[i + 1]; i += 1; break;
      case '--codigo': args.codigo = apenasDigitos(argv[i + 1]); i += 1; break;
      case '--data-dir': args.dataDir = argv[i + 1]; i += 1; break;
      case '--max-faltantes': args.maxFaltantes = Number(argv[i + 1]) || 200; i += 1; break;
      case '--listar-faltantes': args.listarFaltantes = true; break;
      case '--json': args.json = true; break;
      case '--help': args.help = true; break;
      default: break;
    }
  }
  return args;
}

async function resolverMunicipio(args) {
  if (args.codigo) {
    const m = await Municipio.findOne({ codigo: args.codigo }).lean();
    return { codigo: args.codigo, nome: m?.nome || `codigo ${args.codigo}`, uf: args.uf || m?.uf };
  }
  if (args.municipio) {
    const nomeNorm = normalizar(args.municipio);
    const filtro = { nomeNormalizado: nomeNorm };
    if (args.uf) filtro.uf = args.uf;
    let m = await Municipio.findOne(filtro).lean();
    if (!m) {
      // tenta pelo nome exato nas empresas
      const cond = { 'endereco.municipio': new RegExp(`^${args.municipio}$`, 'i') };
      if (args.uf) cond['endereco.uf'] = args.uf;
      const doc = await Company.findOne(cond, { 'endereco.codigoMunicipio': 1, 'endereco.municipio': 1, 'endereco.uf': 1 }).lean();
      if (doc) m = { codigo: doc.endereco.codigoMunicipio, nome: doc.endereco.municipio, uf: doc.endereco.uf };
    }
    if (!m) return null;
    return { codigo: m.codigo, nome: m.nome, uf: args.uf || m.uf };
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.uf) {
    console.log(`
Uso: node scripts/auditar-cidade.js --uf UF (--municipio NOME | --codigo CODIGO) [opcoes]

  --uf UF               Estado (obrigatorio)
  --municipio NOME      Nome do municipio
  --codigo CODIGO       Codigo do municipio
  --data-dir DIR        Pasta dos arquivos da Receita (padrao: ./data)
  --listar-faltantes    Lista os CNPJs ausentes
  --max-faltantes N     Limite da listagem (padrao: 200)
  --json                Saida em JSON
`);
    process.exit(args.help ? 0 : 1);
  }

  const dataDir = path.resolve(args.dataDir);
  const arquivos = listarFontes(dataDir, ['estabelecimentos', 'estabelecimento', 'est']);
  if (!arquivos.length) {
    console.error(`Nenhum arquivo de Estabelecimentos encontrado em ${dataDir}`);
    process.exit(1);
  }

  await connect();

  const alvo = await resolverMunicipio(args);
  if (!alvo) {
    console.error(`Municipio nao encontrado: ${args.municipio || args.codigo}. Use --codigo ou verifique o nome.`);
    process.exit(1);
  }

  console.log('============================================================');
  console.log(' AUDITORIA DE COMPLETUDE');
  console.log('============================================================');
  console.log(` Fonte     : ${dataDir}`);
  console.log(` Municipio : ${alvo.nome} / ${alvo.uf} (codigo ${alvo.codigo || 'nao informado'})`);
  console.log('============================================================\n');

  // ---- Contagem no banco ----
  const filtroBanco = { 'endereco.uf': alvo.uf };
  if (alvo.codigo) filtroBanco['endereco.codigoMunicipio'] = alvo.codigo;
  else filtroBanco['endereco.municipio'] = new RegExp(`^${alvo.nome}$`, 'i');

  const noBanco = await Company.countDocuments(filtroBanco);
  const bancoPorSituacao = await Company.aggregate([
    { $match: filtroBanco },
    { $group: { _id: '$situacao', total: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);
  console.log(`[banco] ${noBanco} empresas em ${alvo.nome}/${alvo.uf}`);
  bancoPorSituacao.forEach((s) => console.log(`        ${s._id || 'NAO INFORMADA'}: ${s.total}`));

  // ---- Varredura na fonte ----
  console.log('\n[fonte] varrendo os arquivos originais da Receita...');

  const vistos = new Set();
  let linhasLidas = 0;
  let linhasDoMunicipio = 0;
  let duplicadosNaFonte = 0;
  let encontradosNoBanco = 0;
  let faltantes = 0;
  const listaFaltantes = [];
  let buffer = [];

  const conferirLote = async () => {
    if (!buffer.length) return;
    const existentes = new Set();
    for (const lote of emLotes([...new Set(buffer)], 5000)) {
      const docs = await Company.find({ cnpj: { $in: lote } }, { cnpj: 1 }).lean();
      docs.forEach((d) => existentes.add(d.cnpj));
    }
    for (const cnpj of buffer) {
      if (existentes.has(cnpj)) {
        encontradosNoBanco += 1;
      } else {
        faltantes += 1;
        if (args.listarFaltantes && listaFaltantes.length < args.maxFaltantes) listaFaltantes.push(cnpj);
      }
    }
    buffer = [];
    process.stdout.write(`\r        linhas lidas: ${linhasLidas} | do municipio: ${linhasDoMunicipio} | faltantes: ${faltantes}   `);
  };

  for (const arquivo of arquivos) {
    await lerCsv(arquivo, async (c) => {
      linhasLidas += 1;
      if (c.length < 21) return;
      const ufLinha = (c[19] || '').trim().toUpperCase();
      if (ufLinha !== alvo.uf) return;

      const codigo = apenasDigitos(c[20]);
      if (alvo.codigo && codigo !== alvo.codigo) return;

      const cnpj = `${apenasDigitos(c[0]).padStart(8, '0')}${apenasDigitos(c[1]).padStart(4, '0')}${apenasDigitos(c[2]).padStart(2, '0')}`;
      if (vistos.has(cnpj)) { duplicadosNaFonte += 1; return; }
      vistos.add(cnpj);

      linhasDoMunicipio += 1;
      buffer.push(cnpj);
      if (buffer.length >= 20000) await conferirLote();
      return undefined;
    });
  }
  await conferirLote();
  process.stdout.write('\n');

  const noBancoNaoNaFonte = Math.max(noBanco - encontradosNoBanco, 0);

  const resultado = {
    municipio: alvo,
    fonte: {
      arquivos: arquivos.length,
      linhasLidas,
      empresasNoMunicipio: linhasDoMunicipio,
      duplicados: duplicadosNaFonte,
    },
    banco: { total: noBanco, porSituacao: bancoPorSituacao.map((s) => ({ situacao: s._id, total: s.total })) },
    conferencia: {
      encontrados: encontradosNoBanco,
      faltantes,
      noBancoNaoNaFonte,
      completo: faltantes === 0,
    },
    faltantesAmostra: listaFaltantes.map(formatarCnpj),
  };

  if (args.json) {
    console.log(JSON.stringify(resultado, null, 2));
  } else {
    console.log('\n============================================================');
    console.log(' RESULTADO DA AUDITORIA');
    console.log('============================================================');
    console.log(` Empresas na fonte (Receita) : ${linhasDoMunicipio}`);
    console.log(` Empresas no banco (MongoDB) : ${noBanco}`);
    console.log(` Encontradas no banco        : ${encontradosNoBanco}`);
    console.log(` FALTANTES                   : ${faltantes}`);
    console.log(` No banco e nao na fonte     : ${noBancoNaoNaFonte}`);
    console.log('------------------------------------------------------------');
    if (faltantes === 0) {
      console.log(' RESULTADO: ✔ COMPLETO — nenhuma empresa do municipio ficou de fora.');
    } else {
      console.log(' RESULTADO: ✖ INCOMPLETO — rode a importacao novamente:');
      console.log(`            node scripts/import-receita.js --uf ${alvo.uf}`);
      console.log('            (a importacao e idempotente: ela complementa o que falta sem duplicar)');
      if (listaFaltantes.length) {
        console.log('\n Primeiros CNPJs ausentes:');
        resultado.faltantesAmostra.slice(0, 30).forEach((c) => console.log(`   ${c}`));
      }
    }
    console.log('============================================================\n');
  }

  await mongoose.connection.close();
  process.exit(resultado.conferencia.completo ? 0 : 2);
}

main().catch((e) => {
  console.error('\n[erro fatal]', e);
  process.exit(1);
});
