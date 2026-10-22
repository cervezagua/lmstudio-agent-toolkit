// node bin/cli.js add <name>... : adds users, then prints how many there are and their names.
const { createUser } = require("../lib/users");
const { userCount, namesSorted } = require("../lib/report");

const names = process.argv.slice(3);

function addAll(index, done) {
  if (index >= names.length) return done();
  createUser(names[index], error => {
    if (error) {
      console.error(error.message);
      process.exit(1);
    }
    addAll(index + 1, done);
  });
}

addAll(0, () => {
  userCount((error, count) => {
    if (error) throw error;
    namesSorted((error2, sorted) => {
      if (error2) throw error2;
      console.log(`${count} users: ${sorted.join(", ")}`);
    });
  });
});
