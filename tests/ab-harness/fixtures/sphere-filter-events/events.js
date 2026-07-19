'use strict';

// Tiny in-memory calendar. Events: { id, title, startTs, endTs, cancelled }.
// startTs/endTs are epoch-millisecond numbers marking when an event begins
// and ends; cancelled is a boolean.

let nextId = 1;

function createCalendar() {
  return { events: [] };
}

function addEvent(cal, title, startTs, endTs, cancelled = false) {
  const event = { id: nextId++, title, startTs, endTs, cancelled };
  cal.events.push(event);
  return event;
}

function listEvents(cal) {
  return cal.events;
}

module.exports = { createCalendar, addEvent, listEvents };
