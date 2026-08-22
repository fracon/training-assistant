'use strict';

const { buildServer } = require('./server');

const port = Number(process.env.PORT) || 3000;

buildServer()
  .then((app) => app.listen({ port, host: process.env.HOST || '127.0.0.1' }))
  .then((address) => console.log(`Training Assistant ready at ${address}`))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
