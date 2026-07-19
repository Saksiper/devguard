'use strict';

// Tiny in-memory product catalog. Products: { id, name, priceCents, tags, active }.
// tags is an array of strings; active is a boolean flag telling whether the
// product is currently sold in the storefront.

let nextId = 1;

function createCatalog() {
  return { products: [] };
}

function addProduct(catalog, name, priceCents, tags = [], active = true) {
  const product = { id: nextId++, name, priceCents, tags, active };
  catalog.products.push(product);
  return product;
}

function listProducts(catalog) {
  return catalog.products;
}

module.exports = { createCatalog, addProduct, listProducts };
