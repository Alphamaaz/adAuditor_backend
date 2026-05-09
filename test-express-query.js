import express from 'express';
const app = express();

app.get('/test', (req, res) => {
  const desc = Object.getOwnPropertyDescriptor(req, 'query') || 
               Object.getOwnPropertyDescriptor(Object.getPrototypeOf(req), 'query') ||
               Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(req)), 'query');
  
  console.log('Query descriptor:', desc);
  
  try {
    delete req.query;
    console.log('Delete worked');
    req.query = { foo: 'bar' };
    console.log('Assignment worked');
  } catch (e) {
    console.log('Failed:', e.message);
  }
  res.end();
});

const server = app.listen(5001, () => {
  console.log('Server running on 5001');
  // Trigger request
  import('http').then(http => {
    http.get('http://localhost:5001/test', () => {
      server.close();
    });
  });
});
