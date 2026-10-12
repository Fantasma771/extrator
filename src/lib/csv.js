'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const iconv = require('iconv-lite');
const unzipper = require('unzipper');

/**
 * Divide uma linha CSV delimitada por ';' respeitando aspas.
 */
function splitLinha(linha, delimitador = ';') {
  const campos = [];
  let atual = '';
  let dentroAspas = false;
  for (let i = 0; i < linha.length; i += 1) {
    const c = linha[i];
    if (c === '"') {
      if (dentroAspas && linha[i + 1] === '"') {
        atual += '"';
        i += 1;
      } else {
        dentroAspas = !dentroAspas;
      }
    } else if (c === delimitador && !dentroAspas) {
      campos.push(atual);
      atual = '';
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos.map((v) => v.trim());
}

/**
 * Localiza arquivos .zip ou .csv que comecam com um dos prefixos informados.
 * Ex: listarFontes(dir, ['empresas','emp']) -> [Empresas0.zip, Empresas1.zip, ...]
 */
function listarFontes(dir, prefixos) {
  if (!fs.existsSync(dir)) return [];
  const arquivos = fs.readdirSync(dir);
  const regex = new RegExp(`^(${prefixos.join('|')})\\d*\\.(zip|csv)$`, 'i');
  return arquivos
    .filter((a) => regex.test(a))
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }))
    .map((a) => path.join(dir, a));
}

/**
 * Abre um arquivo (csv direto ou zip contendo csv) como stream de texto latin1.
 */
function abrirTexto(caminho) {
  if (/\.csv$/i.test(caminho)) {
    return fs.createReadStream(caminho).pipe(iconv.decodeStream('latin1'));
  }
  // ZIP: pega a primeira entrada de arquivo
  return unzipper.Open.file(caminho).then((zip) => {
    const entrada = zip.files.find((f) => f.type === 'File');
    if (!entrada) throw new Error(`ZIP sem arquivo interno: ${caminho}`);
    return entrada.stream().pipe(iconv.decodeStream('latin1'));
  });
}

/**
 * Percorre cada linha nao vazia de um arquivo, com callback.
 * @param {string} caminho
 * @param {(campos:string[], linhaBruta:string)=>void|Promise<void>} onLinha
 */
async function lerCsv(caminho, onLinha) {
  const stream = await abrirTexto(caminho);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let numero = 0;
  for await (const linha of rl) {
    numero += 1;
    if (!linha || !linha.trim()) continue;
    const campos = splitLinha(linha);
    await onLinha(campos, linha, numero);
  }
  return numero;
}

/** Le um arquivo de referencia simples (codigo;descricao) e devolve um Map */
async function lerTabela(caminho) {
  const mapa = new Map();
  await lerCsv(caminho, (campos) => {
    if (campos.length < 2) return;
    const codigo = campos[0].trim();
    const descricao = campos.slice(1).join(' ').trim();
    if (codigo) mapa.set(codigo, descricao);
  });
  return mapa;
}

module.exports = { lerCsv, lerTabela, listarFontes, splitLinha, abrirTexto };
