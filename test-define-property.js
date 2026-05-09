import express from 'express';
const app = express();

app.get('/test', (req, res) => {
  console.log('Original query:', req.query);
  
  try {
    Object.defineProperty(req, 'query', {
      value: { coerced: 123 },
      writable: true,
      configurable: true,
      enumerable: true
    });
    console.log('DefineProperty worked:', req.query);
  } catch (e) {
    console.log('DefineProperty failed:', e.message);
  }
  res.end();
});

const server = app.listen(5002, () => {
  import('http').then(http => {
    http.get('http://localhost:5002/test', () => {
      server.close();
    });
  });
});
