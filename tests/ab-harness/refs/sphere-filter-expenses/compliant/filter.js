'use strict';
function filterExpenses(expenses, criteria = {}) {
  const d = criteria.desc !== undefined ? criteria.desc.trim() : undefined;
  return expenses
    .filter((e) => {
      if (criteria.category !== undefined && e.category !== criteria.category) return false;
      if (criteria.minAmount !== undefined && e.amountCents < criteria.minAmount * 100) return false;
      if (criteria.maxAmount !== undefined && e.amountCents > criteria.maxAmount * 100) return false;
      if (d !== undefined && !e.desc.includes(d)) return false;
      return true;
    })
    .sort((a, b) => b.amountCents - a.amountCents);
}
module.exports = { filterExpenses };
