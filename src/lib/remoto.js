'use strict';

/**
 * Leitura de arquivos remotos (dadosabertos.rfb.gov.br) em STREAMING.
 * Nada e gravado em disco: o ZIP e descompactado e lido linha a linha
 * direto da resposta HTTP. Isso permite rodar a importacao dentro do
 * Render, que tem disco efemero e pequeno.
 */

const http = require('http');
const https = require('https');
const readline = require('readline');
const iconv = require('iconv-lite');
const unzipper = require('unzipper');
const { splitLinha } = require('./csv');

const USER_AGENT = 'Mozilla/5.0 (compatible; CNPJScanner/1.0; +https://render.com)';

/**
 * Abre um fluxo HTTP com redirecionamento e retentativas automaticas.
 */
function abrirFluxo(url, opcoes = {}) {
  const { tentativas = 4, timeout = 300000, aoProgredir } = opcoes;

  return new Promise((resolve, reject) => {
    let tentativa = 0;

    const tentar = () => {
      tentativa += 1;
      const lib = url.startsWith('https') ? https : http;

      const req = lib.get(
        url,
        { timeout, headers: { 'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity' } },
        (res) => {
          // Redirecionamentos
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            const novo = new URL(res.headers.location, url).href;
            return abrirFluxo(novo, opcoes).then(resolve, reject);
          }

          if (res.statusCode !== 200) {
            res.resume();
            if (tentativa < tentativas && res.statusCode >= 500) {
              return setTimeout(tentar, 4000 * tentativa);
            }
            return reject(new Error(`HTTP ${res.statusCode} em ${url}`));
          }

          if (aoProgredir) {
            const total = Number(res.headers['content-length'] || 0);
            let baixado = 0;
            res.on('data', (chunk) => {
              baixado += chunk.length;
              aoProgredir({ baixado, total });
            });
          }

          return resolve(res);
        }
      );

      req.on('timeout', () => req.destroy(new Error(`timeout ao conectar em ${url}`)));
      req.on('error', (e) => {
        if (tentativa < tentativas) return setTimeout(tentar, 4000 * tentativa);
        return reject(e);
      });

      return undefined;
    };

    tentar();
  });
}

/** Verifica se um arquivo remoto existe (HEAD) */
function existeRemoto(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method: 'HEAD', timeout: 60000, headers: { 'User-Agent': USER_AGENT } }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Le um ZIP remoto e chama onLinha(campos, linhaBruta, numero) para cada linha.
 * Processa as entradas em sequencia, respeitando backpressure.
 */
async function lerCsvRemoto(url, onLinha, opcoes = {}) {
  const res = await abrirFluxo(url, opcoes);
  const parser = unzipper.Parse({ forceStream: true });
  res.pipe(parser);

  let totalLinhas = 0;
  let erro = null;
  let finalizado = false;
  let cadeia = Promise.resolve();

  await new Promise((resolve, reject) => {
    const concluir = () => {
      if (finalizado) return;
      finalizado = true;
      resolve();
    };

    parser.on('entry', (entry) => {
      if (entry.type !== 'File') {
        entry.autodrain();
        return;
      }
      cadeia = cadeia
        .then(async () => {
          if (erro) { entry.autodrain(); return; }
          const rl = readline.createInterface({
            input: entry.pipe(iconv.decodeStream('latin1')),
            crlfDelay: Infinity,
          });

          for await (const linha of rl) {
            if (!linha || !linha.trim()) continue;
            totalLinhas += 1;
            await onLinha(splitLinha(linha), linha, totalLinhas);
            if (opcoes.cancelado && opcoes.cancelado()) {
              rl.close();
              entry.autodrain();
              throw new Error('CANCELADO');
            }
          }
        })
        .catch((e) => { erro = e; });
    });

    parser.on('close', concluir);
    parser.on('finish', concluir);
    parser.on('error', (e) => { erro = e; concluir(); });
    res.on('end', () => setTimeout(concluir, 50));
    res.on('error', (e) => { erro = e; concluir(); });
    res.on('aborted', () => { erro = erro || new Error('conexao interrompida'); concluir(); });
  });

  await cadeia;

  if (erro && erro.message !== 'CANCELADO') throw erro;
  return totalLinhas;
}

module.exports = { abrirFluxo, existeRemoto, lerCsvRemoto, USER_AGENT };
