'use strict';

/**
 * Protecao opcional dos endpoints /api/*.
 * Se a variavel API_KEY estiver definida, todas as chamadas precisam enviar
 * o cabecalho "x-api-key" (ou "?apiKey="). Caso contrario, tudo fica aberto.
 */
function apiKeyAuth(req, res, next) {
  const esperada = process.env.API_KEY;
  if (!esperada) return next();

  // Deixa passar o healthcheck e os arquivos estaticos do dashboard
  if (!req.path.startsWith('/api')) return next();

  const enviada =
    req.get('x-api-key') ||
    req.get('X-Api-Key') ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    req.query.apiKey;

  if (enviada && String(enviada) === String(esperada)) return next();

  return res.status(401).json({
    ok: false,
    error: 'NAO_AUTORIZADO',
    message: 'Chave de API invalida ou ausente. Informe o cabecalho x-api-key.',
  });
}

module.exports = { apiKeyAuth };
