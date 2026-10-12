'use strict';

const { mongoose } = require('../db');

const ImportJobSchema = new mongoose.Schema(
  {
    uf: { type: String, index: true },
    opcoes: {
      drop: Boolean,
      skipSocios: Boolean,
      skipSimples: Boolean,
      limit: Number,
      dataDir: String,
      remoto: Boolean,
    },
    status: { type: String, index: true, default: 'executando' }, // executando | concluido | erro | cancelado | interrompido
    fase: { type: String, default: 'aguardando' },
    faseNumero: { type: Number, default: 0 },
    totalFases: { type: Number, default: 5 },
    progresso: {
      arquivo: String,
      arquivoNumero: Number,
      totalArquivos: Number,
      linhasLidas: { type: Number, default: 0 },
      gravados: { type: Number, default: 0 },
      ignorados: { type: Number, default: 0 },
      bytes: { type: Number, default: 0 },
    },
    mensagem: String,
    log: [String],
    resultado: {
      empresas: Number,
      socios: Number,
      municipios: Number,
      duracaoMs: Number,
      porUf: [{ uf: String, municipios: Number, total: Number, _id: false }],
    },
    erro: String,
    iniciadoEm: { type: Date, default: Date.now },
    atualizadoEm: { type: Date, default: Date.now },
    finalizadoEm: Date,
  },
  { collection: 'import_jobs', timestamps: true }
);

ImportJobSchema.index({ iniciadoEm: -1 });

ImportJobSchema.set('toJSON', {
  versionKey: false,
  transform: (_d, ret) => { delete ret._id; return ret; },
});

module.exports = mongoose.models.ImportJob || mongoose.model('ImportJob', ImportJobSchema);
