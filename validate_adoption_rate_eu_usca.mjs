const url = 'http://localhost:5001/api/fact_adoption_rate_eu_usca_combined?limit=5';
(async () => {
  try {
    const res = await fetch(url);
    console.log('status', res.status);
    console.log(await res.text());
  } catch (err) {
    console.error('ERR', err.message);
    process.exit(1);
  }
})();