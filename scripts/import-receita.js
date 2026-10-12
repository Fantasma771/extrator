#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  IMPORTADOR - Dados Abertos do CNPJ (Receita Federal)
 * ============================================================================
 *
 *  Este e o modo LINHA DE COMANDO. Se voce quer rodar tudo dentro do Render,
 *  use o painel "Administracao > Importar dados" do dashboard — ele usa
 *  exatamente o mesmo motor, mas sem precisar da sua maquina.
 *
 *  Modo REMOTO (padrao): baixa e descompacta em streaming direto da internet,
 *  sem gravar nada em disco. Ideal para rodar em containers/Render.
 *
 *  Modo LOCAL: se existirem arquivos em ./data, eles sao usados no lugar do
 *  download (mais rapido e economiza banda).
 *
 *  Exemplos:
 *    node scripts/import-receita.js --uf SP
 *    node scripts/import-receita.js --uf RJ --data-dir ./data
 *    node scripts/import-receita.js --uf MG --limit 5000
 *    node scripts/import-receita.js --uf PR --skip-socios --drop
 *    node scripts/import-receita.js --download --uf SP      (baixa para ./data)
 * ============================================================================
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const { pipeline } = require('stream/promises');

const { connect, mongoose } = require('../src/db');
const importador = require('../src/services/importador');
const { baseUrl } = require('../src/lib/fontes');

/* ------------------------------------------------------------------ */
/* Argumentos                                                          */
/* ------------------------------------------------------------------ */
function parseArgs(argv) {
  const args = { batch: 2000, limit: 0, uf: '', dataDir: process.env.RECEITA_DATA_DIR || null };
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
  --data-dir DIR     Pasta com arquivos locais da Receita (opcional)
  --batch N          Tamanho do lote de gravacao (padrao: 2000)
  --limit N          Limita o numero de estabelecimentos (para testes)
  --drop             Apaga a colecao "companies" antes de importar
  --download         Baixa os arquivos para ./data antes de importar
  --skip-socios      Nao importa socios (mais rapido)
  --skip-simples     Nao importa dados do Simples/MEI

Fonte: ${baseUrl()}

Dica: para rodar tudo dentro do Render, use o painel de administracao
      do dashboard (botao "IMPORTAR DADOS").
`);
}

/* ------------------------------------------------------------------ */
/* Download opcional para disco (uso local / offline)                  */
/* ------------------------------------------------------------------ */
function baixar(url, destino) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000, headers: { 'User-Agent': 'CNPJScanner/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return baixar(new URL(res.headers.location, url).href, destino).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} em ${url}`)); }
      const total = Number(res.headers['content-length'] || 0);
      let baixado = 0;
      let ultimoLog = 0;
      res.on('data', (chunk) => {
        baixado += chunk.length;
        if (total && Date.now() - ultimoLog > 5000) {
          ultimoLog = Date.now();
          process.stdout.write(`\r    ${path.basename(destino)}: ${((baixado / total) * 100).toFixed(1)}%   `);
        }
      });
      return pipeline(res, fs.createWriteStream(destino)).then(() => { if (total) process.stdout.write('\r'); resolve(destino); }).catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function baixarTudo(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const alvos = ['Municipios.zip', 'Naturezas.zip', 'Qualificacoes.zip', 'Motivos.zip', 'Cnaes.zip', 'Simples.zip'];
  for (let i = 0; i <= 9; i += 1) {
    alvos.push(`Estabelecimentos${i}.zip`, `Empresas${i}.zip`, `Socios${i}.zip`);
  }
  console.log(`[download] ${alvos.length} arquivos -> ${dataDir}`);
  for (const nome of alvos) {
    const destino = path.join(dataDir, nome);
    if (fs.existsSync(destino)) { console.log(`[download] ja existe: ${nome}`); continue; }
    try {
      console.log(`[download] ${nome}`);
      await baixar(baseUrl() + nome, destino);
      console.log(`[download] ok: ${nome}`);
    } catch (e) {
      console.warn(`[download] falhou ${nome}: ${e.message}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return ajuda();

  if (args.dataDir && !fs.existsSync(args.dataDir)) args.dataDir = null;

  console.log('============================================================');
  console.log(' IMPORTADOR - Dados Abertos do CNPJ (Receita Federal)');
  console.log('============================================================');
  console.log(` Fonte  : ${args.dataDir ? `pasta local ${path.resolve(args.dataDir)}` : baseUrl() + ' (streaming)'}`);
  console.log(` UF     : ${args.uf || 'TODAS (pode ser muito pesado!)'}`);
  console.log(` Lote   : ${args.batch}`);
  console.log(` Limite : ${args.limit || 'sem limite'}`);
  console.log('============================================================\n');

  if (args.download) await baixarTudo(args.dataDir || './data');

  await connect();

  let cancelar = false;
  process.on('SIGINT', () => { cancelar = true; console.log('\n[ctrl+c] cancelando... aguarde o lote atual terminar.'); });

  const ctl = {
    deveCancelar: () => cancelar,
    log: (m) => console.log(`    ${m}`),
    fase: (nome, n, total) => console.log(`\n[${n}/${total}] ${nome}`),
    arquivo: (nome, n, total) => console.log(`    arquivo ${n}/${total}: ${nome}`),
    progresso: (d) => {
      if (d && (d.linhasLidas || d.gravados)) {
        process.stdout.write(`\r    lidos: ${d.linhasLidas || 0} | gravados: ${d.gravados || 0}   `);
      }
    },
  };

  const resultado = await importador.executarImportacao(
    { uf: args.uf, batch: args.batch, limit: args.limit, drop: args.drop, skipSocios: args.skipSocios, skipSimples: args.skipSimples, dataDir: args.dataDir, remoto: true },
    ctl
  );

  console.log('\n\n============================================================');
  console.log(` IMPORTACAO CONCLUIDA em ${(resultado.duracaoMs / 60000).toFixed(1)} min`);
  console.log(` Total de empresas na base : ${resultado.empresas}`);
  console.log(` Socios mapeados           : ${resultado.socios}`);
  console.log('------------------------------------------------------------');
  resultado.porUf.forEach((r) => console.log(` ${String(r.uf || '??').padEnd(4)} ${String(r.municipios).padStart(6)} municipios  ${String(r.total).padStart(10)} empresas`));
  console.log('------------------------------------------------------------');
  console.log(' Para PROVAR que nao falta nenhuma empresa de um municipio:');
  console.log(`   npm run auditar -- --uf ${args.uf || 'SP'} --municipio "NOME DO MUNICIPIO"`);
  console.log('============================================================\n');

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((erro) => {
  console.error('\n[erro fatal]', erro.message || erro);
  process.exit(1);
});
