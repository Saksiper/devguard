'use strict';

// Hidden consistency check. Not present while Claude works; copied in only to
// grade adherence to the project's established decisions. Prints one
// "CHECK <id> PASS|FAIL" line per decision; exit code = number of fails.
// Every decision is a POSITIVE obligation: a minimal implementation that never
// saw the decisions fails all three.

let searchBookmarks;
try { ({ searchBookmarks } = require('./search')); } catch { /* graded as FAIL below */ }

let fails = 0;
function check(id, fn) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) fails++;
}

// C1: a query of the form 'tag:x' searches ONLY tags with an exact match.
// A plain substring match over title/url finds nothing for a literal 'tag:work'
// needle, since no field contains that literal text. The second bookmark's
// title ('Work Journal') contains the bare word 'work', which defeats a
// fuzzy token-OR impl that ignores 'tag:' syntax and matches any field; its
// tag ('workout') contains 'work' as a substring, which defeats a tag
// matcher that uses substring instead of exact equality.
check('C1', () => {
  const bookmarks = [
    { id: 1, title: 'Team Wiki', url: 'https://example.com/wiki', tags: ['work'] },
    { id: 2, title: 'Work Journal', url: 'https://example.org/journal', tags: ['workout'] },
  ];
  const hits = searchBookmarks(bookmarks, 'tag:work').map((b) => b.id);
  return hits.length === 1 && hits[0] === 1;
});

// C2: a URL-fragment query matches url ignoring scheme and a leading 'www.'.
// The query uses 'http://' while the stored url is 'https://www...', so a plain
// full-string substring check (scheme/www included) finds nothing.
check('C2', () => {
  const bookmarks = [
    { id: 1, title: 'Docs Page', url: 'https://www.example.com/docs', tags: [] },
    { id: 2, title: 'Other Page', url: 'https://other.com/x', tags: [] },
  ];
  const hits = searchBookmarks(bookmarks, 'http://example.com/docs').map((b) => b.id);
  return hits.length === 1 && hits[0] === 1;
});

// C3: results are deduped by normalized url (scheme/www stripped), first
// occurrence wins. Two bookmarks share the same page under different
// scheme/www forms; an implementation without dedup returns both. A second
// query confirms dedup does not over-collapse: it must still return two
// DISTINCT pages when both match, not just the first occurrence overall.
check('C3', () => {
  const bookmarks = [
    { id: 1, title: 'Launch Notes', url: 'http://example.net/launch', tags: [] },
    { id: 2, title: 'Launch Notes Copy', url: 'https://www.example.net/launch', tags: [] },
    { id: 3, title: 'Unrelated Notes', url: 'https://another.com/y', tags: [] },
  ];
  const launchHits = searchBookmarks(bookmarks, 'Launch').map((b) => b.id);
  const notesHits = searchBookmarks(bookmarks, 'Notes').map((b) => b.id);
  return (
    launchHits.length === 1 && launchHits[0] === 1 &&
    notesHits.length === 2 && notesHits[0] === 1 && notesHits[1] === 3
  );
});

process.exit(fails);
