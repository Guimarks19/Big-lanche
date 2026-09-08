function centsToDecimal(cents) {
  return (Number(cents) / 100).toFixed(2);
}

function decimalToCents(value) {
  if (typeof value === 'number') return Math.round(value * 100);
  if (typeof value !== 'string') return 0;
  const normalized = value.replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function formatBRL(cents) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number(cents) / 100);
}

module.exports = { centsToDecimal, decimalToCents, formatBRL };
