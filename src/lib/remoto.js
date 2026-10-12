'use strict';

/**
 * Leitura de arquivos remotos (espelho CDN / Receita Federal) em STREAMING.
 * Nada e gravado em disco: o ZIP e descompactado e lido linha a linha
 * direto da resposta HTTP. Isso permite rodar a importacao dentro do
 * Render, que tem disco efemero e pequeno.
 *
 * Recursos importantes:
 *   - timeout de inatividade (nao deixa a importacao "pendurada" para sempre)
 *   - retentativas automaticas com backoff
 *   - cancelamento real via AbortSignal (botao PARAR)
 *   - parada antecipada quando a quantidade pedida ja foi alcancada
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const readline = require('readline');
const iconv = require('iconv-lite');
const unzipper = require('unzipper');
const { splitLinha } = require('./csv');

const USER_AGENT =
  'Mozilla/5.0 (compatible; CNPJScanner/2.0; +https://dados-abertos-rf-cnpj.casadosdados.com.br)';

const ERRO_CANCELADO = 'CANCELADO';

/**
 * Abre um fluxo HTTP com redirecionamento, descompressao de transporte
 * (gzip/deflate/br) e retentativas automaticas.
 *
 * @param {string} url
 * @param {{tentativas?:number, timeout?:number, aoProgredir?:Function, signal?:AbortSignal}} opcoes
 * @returns {Promise<import('stream').Readable>}
 */
function abrirFluxo(url, opcoes = {}) {
  const { tentativas = 4, timeout = 120000, aoProgredir, signal } = opcoes;

  return new Promise((resolve, reject) => {
    let tentativa = 0;

    const tentar = () => {
      if (signal && signal.aborted) return reject(new Error(ERRO_CANCELADO));
      tentativa += 1;
      const lib = url.startsWith('https') ? https : http;
      let req;

      try {
        req = lib.get(
          url,
          {
            timeout,
            signal,
            headers: { 'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'gzip, deflate' },
          },
          (res) => {
            // Redirecionamentos (ex.: http -> https, /arquivos -> /arquivos/)
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
              res.resume();
              const novo = new URL(res.headers.location, url).href;
              return abrirFluxo(novo, opcoes).then(resolve, reject);
            }

            if (res.statusCode !== 200 && res.statusCode !== 206) {
              res.resume();
              if (tentativa < tentativas && res.statusCode >= 500) {
                return setTimeout(tentar, 2500 * tentativa);
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

            const enc = String(res.headers['content-encoding'] || '').toLowerCase();
            if (enc === 'gzip') return resolve(res.pipe(zlib.createGunzip()));
            if (enc === 'deflate') return resolve(res.pipe(zlib.createInflate()));
            if (enc === 'br') return resolve(res.pipe(zlib.createBrotliDecompress()));
            return resolve(res);
          }
        );
      } catch (e) {
        return reject(e);
      }

      req.on('timeout', () => req.destroy(new Error(`timeout de ${Math.round(timeout / 1000)}s em ${url}`)));
      req.on('error', (e) => {
        if ((signal && signal.aborted) || e.name === 'AbortError') return reject(new Error(ERRO_CANCELADO));
        if (tentativa < tentativas) return setTimeout(tentar, 2500 * tentativa);
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
    const req = lib.request(
      url,
      { method: 'HEAD', timeout: 60000, headers: { 'User-Agent': USER_AGENT } },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Baixa um texto pequeno (ex.: indice HTML de uma pasta) para a memoria.
 * @param {string} url
 * @param {{maxBytes?:number}} opcoes
 * @returns {Promise<string>}
 */
async function baixarTexto(url, opcoes = {}) {
  const stream = await abrirFluxo(url, { tentativas: 3, timeout: 30000, ...opcoes });
  const limite = opcoes.maxBytes || 2 * 1024 * 1024;
  const partes = [];
  let total = 0;

  await new Promise((resolve, reject) => {
    stream.on('data', (c) => {
      partes.push(c);
      total += c.length;
      if (total >= limite) {
        try { stream.destroy(); } catch (_) { /* ignore */ }
        resolve();
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return Buffer.concat(partes).toString('utf8');
}

/**
 * Le um ZIP remoto e chama onLinha(campos, linhaBruta, numero) para cada linha.
 *
 * Opcoes:
 *   - cancelado() : retorna true para CANCELAR (aborta o download e lanca CANCELADO)
 *   - deveParar() : retorna true para PARAR de ler (para quando a quantidade pedida
 *                   ja foi alcancada) — encerra sem erro
 *   - signal      : AbortSignal para derrubar a conexao na hora
 */
async function lerCsvRemoto(url, onLinha, opcoes = {}) {
  const stream = await abrirFluxo(url, opcoes);
  const parser = unzipper.Parse();
  stream.pipe(parser);

  const ehCancelado = () => !!(opcoes.cancelado && opcoes.cancelado());
  const ehParada = () => !!(opcoes.deveParar && opcoes.deveParar());

  let totalLinhas = 0;
  let erro = null;
  let parou = false;
  let finalizado = false;
  let cadeia = Promise.resolve();

  const encerrarConexao = () => {
    try { parser.unpipe?.(); } catch (_) { /* ignore */ }
    try { stream.destroy(); } catch (_) { /* ignore */ }
  };

  await new Promise((resolve) => {
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
          if (erro || parou) { entry.autodrain(); return; }

          const rl = readline.createInterface({
            input: entry.pipe(iconv.decodeStream('latin1')),
            crlfDelay: Infinity,
          });

          try {
            for await (const linha of rl) {
              if (!linha || !linha.trim()) continue;
              totalLinhas += 1;
              await onLinha(splitLinha(linha), linha, totalLinhas);

              if (ehCancelado()) { erro = new Error(ERRO_CANCELADO); break; }
              if (ehParada()) { parou = true; break; }
            }
          } finally {
            try { rl.close(); } catch (_) { /* ignore */ }
          }

          if (erro || parou) {
            entry.autodrain();
            encerrarConexao();
          }
        })
        .catch((e) => { erro = erro || e; encerrarConexao(); });
    });

    parser.on('close', concluir);
    parser.on('finish', concluir);
    parser.on('error', (e) => {
      if (!parou && !ehCancelado() && !erro) erro = e;
      concluir();
    });
    stream.on('end', () => setTimeout(concluir, 50));
    stream.on('error', (e) => {
      if (ehCancelado()) erro = erro || new Error(ERRO_CANCELADO);
      else if (!parou && !erro) erro = e;
      concluir();
    });
    stream.on('aborted', () => {
      if (ehCancelado()) erro = erro || new Error(ERRO_CANCELADO);
      concluir();
    });
  });

  await cadeia;

  if (erro) throw erro;
  return totalLinhas;
}

module.exports = { abrirFluxo, existeRemoto, lerCsvRemoto, baixarTexto, USER_AGENT, ERRO_CANCELADO };
