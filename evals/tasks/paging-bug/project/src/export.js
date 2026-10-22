const { customers } = require("./customers");
const { pageCount, pageOf } = require("./paging");

const PAGE_SIZE = 4;

/** Every page of the export, in order. */
function exportPages(all = customers, size = PAGE_SIZE) {
  const pages = [];
  for (let n = 1; n <= pageCount(all.length, size); n++) pages.push(pageOf(all, n, size));
  return pages;
}

if (require.main === module) {
  exportPages().forEach((page, i) => console.log(`Page ${i + 1}: ${page.map(c => c.name).join(", ")}`));
}

module.exports = { exportPages };
