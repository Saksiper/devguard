'use strict';

// Tiny in-memory todo list. Todos: { id, title, done, priority, due }.
// done is a boolean; priority is 1 (highest) to 3 (lowest); due is an
// epoch-milliseconds number or null when no due date is set.

let nextId = 1;

function createList() {
  return { todos: [] };
}

function addTodo(list, title, priority = 2, due = null) {
  const todo = { id: nextId++, title, done: false, priority, due };
  list.todos.push(todo);
  return todo;
}

function listTodos(list) {
  return list.todos;
}

module.exports = { createList, addTodo, listTodos };
