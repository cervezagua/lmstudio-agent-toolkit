/** How many pages `total` items fill, `size` to a page. */
function pageCount(total, size) {
  return Math.floor(total / size);
}

/** Page `n` (counting from 1) of `items`. */
function pageOf(items, n, size) {
  const start = (n - 1) * size + 1;
  return items.slice(start, start + size);
}

module.exports = { pageCount, pageOf };
