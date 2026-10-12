'use strict';

const { mongoose } = require('../db');

const MunicipioSchema = new mongoose.Schema(
  {
    codigo: { type: String }, // codigo IBGE/RFB (7 digitos)
    nome: { type: String, index: true },
    nomeNormalizado: String,
    uf: { type: String, index: true },
  },
  { collection: 'municipios' }
);

MunicipioSchema.index({ uf: 1, nomeNormalizado: 1 });
MunicipioSchema.index({ codigo: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.Municipio || mongoose.model('Municipio', MunicipioSchema);
