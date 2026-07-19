'use strict';
function filterExpenses(expenses, criteria = {}) {
  return expenses.filter((e) => {
    if (criteria.category !== undefined && e.category !== criteria.category) return false;
    if (criteria.minAmount !== undefined && e.amountCents < criteria.minAmount) return false;
    if (criteria.maxAmount !== undefined && e.amountCents > criteria.maxAmount) return false;
    if (criteria.desc !== undefined && !e.desc.includes(criteria.desc)) return false;
    return true;
  });
}
module.exports = { filterExpenses };
