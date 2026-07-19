'use strict';

function stripScheme(u) {
  return String(u).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
}

function looksLikeUrl(q) {
  return /\./.test(q) && !/\s/.test(q);
}

function searchBookmarks(bookmarks, query) {
  const q = String(query).trim();
  const qLower = q.toLowerCase();
  let matches;

  if (qLower.startsWith('tag:')) {
    const wanted = qLower.slice(4);
    matches = bookmarks.filter((b) => b.tags.some((t) => t.toLowerCase() === wanted));
  } else if (looksLikeUrl(qLower)) {
    const normQ = stripScheme(qLower);
    matches = bookmarks.filter((b) => stripScheme(b.url).includes(normQ));
  } else {
    matches = bookmarks.filter((b) => b.title.toLowerCase().includes(qLower));
  }

  const seen = new Set();
  const result = [];
  for (const b of matches) {
    const key = stripScheme(b.url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(b);
  }
  return result;
}

module.exports = { searchBookmarks };
