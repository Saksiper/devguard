'use strict';

// Hidden acceptance test. Not present while Claude works; copied in only to grade
// the final code. Arm-neutral: verifies only what the task prompt pins (a title
// substring query returns the matching bookmarks). Query terms below appear in
// one or more bookmarks' titles and nowhere else (no other title/url/tags
// contains them), so the expected result set holds regardless of which extra
// fields an implementation also searches. 'Handbook' appears in TWO titles with
// distinct normalized urls, asserting the plural contract ('the bookmarks that
// match') so a wrong impl that returns only the first match fails here. It
// deliberately does NOT test 'tag:' syntax, url matching, dedup, or case rules —
// those belong to the consistency check.
const assert = require('assert');
const { searchBookmarks } = require('./search');

const bookmarks = [
  { id: 1, title: 'React Handbook', url: 'https://reactjs.org/docs', tags: ['frontend', 'js'] },
  { id: 2, title: 'Vue Style Guide', url: 'https://vuejs.org/guide', tags: ['frontend', 'js'] },
  { id: 3, title: 'Postgres Internals', url: 'https://postgresql.org/internals', tags: ['database'] },
  { id: 4, title: 'GraphQL Handbook', url: 'https://graphql.org/learn', tags: ['api'] },
];

const ids = (result) => result.map((b) => b.id).sort((a, b) => a - b);

// title substring (same case as the data, so any case rule passes)
// matches two distinct bookmarks -> both must be returned
assert.deepStrictEqual(ids(searchBookmarks(bookmarks, 'Handbook')), [1, 4]);
assert.deepStrictEqual(ids(searchBookmarks(bookmarks, 'Guide')), [2]);
assert.deepStrictEqual(ids(searchBookmarks(bookmarks, 'Internals')), [3]);
// no match anywhere -> empty
assert.deepStrictEqual(searchBookmarks(bookmarks, 'zzz-no-such-token'), []);

console.log('PASS');
