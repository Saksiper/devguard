'use strict';

// Tiny in-memory recipes module. Recipes: { id, title, ingredients } where
// ingredients is an array of ingredient-name strings.

let nextId = 1;

function createStore() {
  return { recipes: [] };
}

function addRecipe(store, title, ingredients) {
  const recipe = { id: nextId++, title, ingredients };
  store.recipes.push(recipe);
  return recipe;
}

function listRecipes(store) {
  return store.recipes;
}

module.exports = { createStore, addRecipe, listRecipes };
