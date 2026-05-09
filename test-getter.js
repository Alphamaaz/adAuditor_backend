const req = {
  get query() {
    return { a: '1' };
  }
};

try {
  req.query = { a: 1 };
  console.log('Direct assignment worked');
} catch (e) {
  console.log('Direct assignment failed:', e.message);
}

try {
  delete req.query;
  req.query = { a: 1 };
  console.log('Delete + assignment worked');
} catch (e) {
  console.log('Delete + assignment failed:', e.message);
}
