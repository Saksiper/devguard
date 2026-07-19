'use strict';

// Tiny in-memory movie catalog. Movies: { id, title, year, genres }.
// year is the release year; genres is an array of genre-name strings.

let nextId = 1;

function createCatalog() {
  return { movies: [] };
}

function addMovie(catalog, title, year, genres = []) {
  const movie = { id: nextId++, title, year, genres };
  catalog.movies.push(movie);
  return movie;
}

function listMovies(catalog) {
  return catalog.movies;
}

module.exports = { createCatalog, addMovie, listMovies };
