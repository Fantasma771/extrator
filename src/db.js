'use strict';

const mongoose = require('mongoose');

let connected = false;

async function connect(uri) {
  const url = uri || process.env.MONGODB_URI;
  if (!url) {
    throw new Error(
      'MONGODB_URI nao definida. Crie um arquivo .env (veja .env.example) ou cadastre a variavel no Render.'
    );
  }
  if (connected) return mongoose.connection;

  mongoose.set('strictQuery', true);
  await mongoose.connect(url, {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 120000,
  });

  connected = true;
  console.log('[db] conectado ao MongoDB');
  return mongoose.connection;
}

function isConnected() {
  return mongoose.connection.readyState === 1;
}

module.exports = { connect, isConnected, mongoose };
