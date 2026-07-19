'use strict';
function searchRecipes(recipes, query) {
  return recipes.filter((r) => r.title.includes(query));
}
module.exports = { searchRecipes };
