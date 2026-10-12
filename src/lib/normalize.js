'use strict';

/**
 * Remove acentos, coloca em minusculas e limpa espacos.
 * Usado para buscas tolerantes (ex: "sao paulo" encontra "São Paulo").
 */
function normalizar(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Escapa texto para uso seguro dentro de uma RegExp */
function escapeRegex(texto) {
  return String(texto).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Formata 14 digitos em 00.000.000/0000-00 */
function formatarCnpj(cnpj) {
  const d = String(cnpj || '').replace(/\D/g, '').padStart(14, '0');
  if (d.length !== 14) return String(cnpj || '');
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/** Mascara CPF/CNPJ de socio */
function mascararDocumento(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (d.length === 14) return `${d.slice(0, 2)}.***.***/****-${d.slice(12)}`;
  return doc || '';
}

/** "YYYYMMDD" -> Date | null */
function parseData(valor) {
  if (!valor) return null;
  const s = String(valor).replace(/\D/g, '');
  if (s.length !== 8 || s === '00000000') return null;
  const ano = Number(s.slice(0, 4));
  const mes = Number(s.slice(4, 6));
  const dia = Number(s.slice(6, 8));
  if (!ano || !mes || !dia) return null;
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "1.234.567,89" ou "1234567,89" -> Number */
function parseNumero(valor) {
  if (valor === null || valor === undefined || valor === '') return 0;
  const s = String(valor).trim().replace(/\s/g, '');
  const normalizado = s.replace(/\./g, '').replace(',', '.');
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : 0;
}

/** Mantem apenas digitos */
function apenasDigitos(valor) {
  return String(valor || '').replace(/\D/g, '');
}

/** Agrupa um array em lotes */
function emLotes(array, tamanho) {
  const lotes = [];
  for (let i = 0; i < array.length; i += tamanho) {
    lotes.push(array.slice(i, i + tamanho));
  }
  return lotes;
}

module.exports = {
  normalizar,
  escapeRegex,
  formatarCnpj,
  mascararDocumento,
  parseData,
  parseNumero,
  apenasDigitos,
  emLotes,
};
