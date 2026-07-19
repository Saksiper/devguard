'use strict';
function searchRecipes(recipes, query) {
  if (typeof query !== 'string') return [];
  const q = query.trim();
  if (q.length < 3) return [];
  return recipes
    .map((r) => ({
      recipe: r,
      titleHit: r.title.includes(q),
      ingredientHits: r.ingredients.filter((i) => i === q).length,
    }))
    .filter((x) => x.titleHit || x.ingredientHits > 0)
    .sort((a, b) => b.ingredientHits - a.ingredientHits)
    .map((x) => x.recipe);
}
module.exports = { searchRecipes };
